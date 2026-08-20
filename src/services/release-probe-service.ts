import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { RadarrReleaseProbeClient } from '../clients/radarr-release-probe-client.js';
import type { HttpClientOptions } from '../clients/http-client.js';
import type { AppConfig } from '../config/env.js';
import type { DatabaseContext } from '../database/client.js';
import { releaseProbeItems, releaseProbes, serviceConnections } from '../database/schema.js';
import { redactProbeData } from '../security/probe-redaction.js';
import { safeError, ServiceClientError } from '../security/redaction.js';
import type { SecretStore } from '../security/secret-store.js';
import {
  normalizeRelease,
  releaseProbeDiagnosticScope,
  releaseComparison,
  summarizeNormalizedReleases,
  type NormalizedRelease,
} from './release-normalizer.js';

const movieSchema = z.object({ id: z.number().int(), title: z.string() }).loose();
const releasesSchema = z.array(z.record(z.string(), z.unknown()));

const observedFieldCandidates = [
  'title',
  'guid',
  'downloadUrl',
  'protocol',
  'indexer',
  'indexerId',
  'size',
  'age',
  'ageHours',
  'publishDate',
  'seeders',
  'leechers',
  'peers',
  'grabs',
  'quality',
  'languages',
  'customFormats',
  'customFormatScore',
  'releaseGroup',
  'edition',
  'rejected',
  'rejections',
  'downloadAllowed',
  'mappedMovieId',
  'infoUrl',
  'magnetUrl',
  'torrentInfoHash',
] as const;

export interface ReleaseProbeClient {
  movie(movieId: number): Promise<unknown>;
  releases(movieId: number): Promise<unknown>;
}

export type ReleaseProbeClientFactory = (baseUrl: string, apiKey: string) => ReleaseProbeClient;

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function numericStats(items: Record<string, unknown>[], field: string) {
  const values = items
    .map((item) => item[field])
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return { observed: 0, min: null, max: null, average: null };
  return {
    observed: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

export class ReleaseProbeService {
  private readonly clientFactory: ReleaseProbeClientFactory;

  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly secrets: SecretStore,
    clientFactory?: ReleaseProbeClientFactory,
  ) {
    const options: HttpClientOptions = {
      timeoutMs: config.RELEASE_PROBE_TIMEOUT_MS,
      maxResponseBytes: config.HTTP_MAX_RESPONSE_BYTES,
    };
    this.clientFactory =
      clientFactory ?? ((url, key) => new RadarrReleaseProbeClient(url, key, options));
  }

  async run(movieId: number): Promise<Record<string, unknown>> {
    if (!this.config.RELEASE_PROBE_ENABLED)
      throw new ServiceClientError('release_probe_disabled', 'Release Probe is disabled');
    const connection = this.database.db
      .select()
      .from(serviceConnections)
      .where(sql`${serviceConnections.service} = 'radarr' AND ${serviceConnections.isActive} = 1`)
      .orderBy(desc(serviceConnections.id))
      .get();
    if (connection?.connectionStatus !== 'connected')
      throw new ServiceClientError(
        'incompatible_response',
        'An active connected Radarr is required',
      );
    const now = Date.now();
    this.database.sqlite
      .prepare(
        "UPDATE release_probes SET status = 'failed', completed_at = ?, duration_ms = ? - started_at, error_code = 'abandoned', error_message = 'Previous probe exceeded its execution window' WHERE status = 'searching' AND started_at < ?",
      )
      .run(now, now, now - this.config.RELEASE_PROBE_TIMEOUT_MS - 5_000);
    const active = this.database.db
      .select({ id: releaseProbes.id })
      .from(releaseProbes)
      .where(sql`${releaseProbes.movieId} = ${movieId} AND ${releaseProbes.status} = 'searching'`)
      .get();
    if (active)
      throw new ServiceClientError(
        'release_probe_conflict',
        'A release probe is already running for this movie',
      );
    const latest = this.database.db
      .select({ startedAt: releaseProbes.startedAt })
      .from(releaseProbes)
      .where(eq(releaseProbes.movieId, movieId))
      .orderBy(desc(releaseProbes.startedAt), desc(releaseProbes.id))
      .get();
    if (latest && now - latest.startedAt.getTime() < this.config.RELEASE_PROBE_COOLDOWN_MS)
      throw new ServiceClientError('release_probe_cooldown', 'Release Probe cooldown is active');

    let inserted;
    try {
      inserted = this.database.db
        .insert(releaseProbes)
        .values({
          movieId,
          radarrVersion: connection.version,
          startedAt: new Date(now),
          status: 'searching',
        })
        .run();
    } catch {
      throw new ServiceClientError(
        'release_probe_conflict',
        'A release probe is already running for this movie',
      );
    }
    const probeId = Number(inserted.lastInsertRowid);
    const client = this.clientFactory(connection.baseUrl, this.secrets.get(connection.secretRef));
    try {
      const movieParsed = movieSchema.safeParse(await client.movie(movieId));
      if (!movieParsed.success || movieParsed.data.id !== movieId)
        throw new ServiceClientError('not_found', 'Radarr movie was not found');
      const searchStartedAt = Date.now();
      const releasesParsed = releasesSchema.safeParse(await client.releases(movieId));
      const durationMs = Date.now() - searchStartedAt;
      if (!releasesParsed.success)
        throw new ServiceClientError(
          'incompatible_response',
          'Radarr release response is incompatible',
        );
      const redactedItems = releasesParsed.data.map(
        (release) => redactProbeData(release).value as Record<string, unknown>,
      );
      const normalizedItems = redactedItems.map(normalizeRelease);
      const summary = {
        ...this.summarize(redactedItems),
        ...summarizeNormalizedReleases(normalizedItems),
      };
      const completedAt = new Date();
      this.database.sqlite.transaction(() => {
        for (const [ordinal, normalized] of normalizedItems.entries()) {
          const item = redactedItems[ordinal] ?? {};
          this.database.db
            .insert(releaseProbeItems)
            .values({
              probeId,
              ordinal,
              fingerprint: normalized.identity.fingerprint,
              normalizedJson: JSON.stringify(normalized),
              rawRedactedJson: JSON.stringify(item),
            })
            .run();
        }
        this.database.db
          .update(releaseProbes)
          .set({
            movieTitle: movieParsed.data.title,
            completedAt,
            durationMs,
            status: 'completed',
            releaseCount: redactedItems.length,
            summaryJson: JSON.stringify(summary),
          })
          .where(eq(releaseProbes.id, probeId))
          .run();
      })();
      return this.get(probeId);
    } catch (error) {
      const safe = safeError(error);
      const status = safe.code === 'timeout' ? 'timeout' : 'failed';
      this.database.db
        .update(releaseProbes)
        .set({
          completedAt: new Date(),
          durationMs: Date.now() - now,
          status,
          errorCode: safe.code,
          errorMessage: safe.message,
        })
        .where(eq(releaseProbes.id, probeId))
        .run();
      return this.get(probeId);
    }
  }

  get(probeId: number): Record<string, unknown> {
    const probe = this.database.db
      .select()
      .from(releaseProbes)
      .where(eq(releaseProbes.id, probeId))
      .get();
    if (!probe) throw new ServiceClientError('not_found', 'Release probe was not found');
    const items = this.database.db
      .select({
        ordinal: releaseProbeItems.ordinal,
        raw: releaseProbeItems.rawRedactedJson,
        normalized: releaseProbeItems.normalizedJson,
      })
      .from(releaseProbeItems)
      .where(eq(releaseProbeItems.probeId, probeId))
      .orderBy(releaseProbeItems.ordinal)
      .all();
    const releases = items.map((item) => JSON.parse(item.raw) as Record<string, unknown>);
    const normalizedReleases = items.map((item) => {
      const parsed = JSON.parse(item.normalized) as unknown;
      const raw = JSON.parse(item.raw) as Record<string, unknown>;
      return isNormalizedRelease(parsed) ? parsed : normalizeRelease(raw);
    });
    return {
      id: probe.id,
      status: probe.status,
      film: { id: probe.movieId, title: probe.movieTitle },
      radarrVersion: probe.radarrVersion,
      startedAt: probe.startedAt.toISOString(),
      completedAt: probe.completedAt?.toISOString() ?? null,
      durationMs: probe.durationMs,
      releaseCount: probe.releaseCount,
      error: probe.errorCode ? { code: probe.errorCode, message: probe.errorMessage } : null,
      ...(probe.summaryJson ? (JSON.parse(probe.summaryJson) as Record<string, unknown>) : {}),
      ...summarizeNormalizedReleases(normalizedReleases),
      normalizedReleases,
      releases,
    };
  }

  comparison(probeId: number): Record<string, unknown> {
    const report = this.get(probeId) as { normalizedReleases: NormalizedRelease[] };
    const releases = releaseComparison(report.normalizedReleases);
    return {
      probeId,
      diagnostic: releaseProbeDiagnosticScope,
      diagnosticSort: 'seeders_desc',
      releaseCount: releases.length,
      releases,
    };
  }

  private summarize(items: Record<string, unknown>[]): Record<string, unknown> {
    const fieldCounts = new Map<string, number>();
    const fieldTypes = new Map<string, Set<string>>();
    for (const item of items) {
      for (const [field, value] of Object.entries(item)) {
        fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
        const types = fieldTypes.get(field) ?? new Set<string>();
        types.add(valueType(value));
        fieldTypes.set(field, types);
      }
    }
    const observed = [...fieldCounts.keys()].sort();
    const fieldsAlwaysPresent = observed.filter((field) => fieldCounts.get(field) === items.length);
    const fieldsSometimesPresent = observed.filter(
      (field) => fieldCounts.get(field) !== items.length,
    );
    const fieldsNeverObserved = observedFieldCandidates.filter((field) => !fieldCounts.has(field));
    const protocols = [
      ...new Set(
        items
          .map((item) => item.protocol)
          .filter((value): value is string => typeof value === 'string'),
      ),
    ].sort();
    const byProtocol = Object.fromEntries(
      protocols.map((protocol) => {
        const matching = items.filter((item) => item.protocol === protocol);
        return [
          protocol,
          {
            releaseCount: matching.length,
            seeders: numericStats(matching, 'seeders'),
            leechers: numericStats(matching, 'leechers'),
            peers: numericStats(matching, 'peers'),
            grabs: numericStats(matching, 'grabs'),
          },
        ];
      }),
    );
    return {
      protocolsObserved: protocols,
      protocolStatistics: byProtocol,
      fieldInventory: {
        fieldsAlwaysPresent,
        fieldsSometimesPresent,
        fieldsNeverObserved,
        observedTypes: Object.fromEntries(
          [...fieldTypes.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([field, types]) => [field, [...types].sort()]),
        ),
      },
    };
  }
}

function isNormalizedRelease(value: unknown): value is NormalizedRelease {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<NormalizedRelease>;
  return candidate.identity !== undefined && candidate.eligibility !== undefined;
}
