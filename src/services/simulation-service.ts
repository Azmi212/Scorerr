import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { RadarrReleaseProbeClient } from '../clients/radarr-release-probe-client.js';
import type { HttpClientOptions } from '../clients/http-client.js';
import type { AppConfig } from '../config/env.js';
import type { DatabaseContext } from '../database/client.js';
import { simulationReleases, simulations, serviceConnections } from '../database/schema.js';
import {
  evaluateRelease,
  type EvaluationProfile,
  type ReleaseEvaluation,
} from '../evaluation/release-evaluator.js';
import {
  prepareOrdinalProfile,
  type OrdinalPolicyErrorCode,
} from '../evaluation/release-ordinal-policy.js';
import { selectCandidates, type CandidateSelectionResult } from '../evaluation/release-selector.js';
import { redactProbeData } from '../security/probe-redaction.js';
import { safeError, ServiceClientError } from '../security/redaction.js';
import type { SecretStore } from '../security/secret-store.js';
import { normalizeRelease, type NormalizedRelease } from './release-normalizer.js';
import { ProfileService, ProfileServiceError, type ProfileView } from './profile-service.js';
import {
  initialSimulationProgress,
  type SimulationProgressCode,
  type SimulationProgressStep,
} from './simulation-task-service.js';

const movieSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string(),
    year: z.number().int().optional(),
    originalLanguage: z.string().nullable().optional(),
  })
  .loose();
const moviesSchema = z.array(movieSchema);
const releasesSchema = z.array(z.record(z.string(), z.unknown()));

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

export const startSimulationRequestSchema = z
  .object({
    movieId: z.number().int().positive(),
    profileId: z.number().int().positive().optional(),
    radarrConnectionId: z.number().int().positive().optional(),
  })
  .strict();

export type StartSimulationInput = z.infer<typeof startSimulationRequestSchema>;

export interface SimulationClient {
  movies(): Promise<unknown>;
  movie(movieId: number): Promise<unknown>;
  releases(movieId: number): Promise<unknown>;
}

export type SimulationClientFactory = (baseUrl: string, apiKey: string) => SimulationClient;

type SimulationReleaseCategory =
  'radarr_rejected' | 'scorerr_refused' | 'selection_eliminated' | 'finalist' | 'selected';

interface LegacyProgressStep {
  code: 'film_found' | 'releases_retrieved' | 'preferences_analyzed' | 'selection_calculated';
  label: 'Film trouvé' | 'Releases récupérées' | 'Analyse des préférences' | 'Calcul du classement';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  error: { code: string; message: string } | null;
}

interface PreparedRelease {
  ordinal: number;
  observed: Record<string, unknown>;
  normalized: NormalizedRelease;
  evaluation: ReleaseEvaluation;
  category: SimulationReleaseCategory;
  reasons: unknown[];
  eliminatedAtStep: number | null;
}

interface ConnectionSnapshot {
  id: number;
  alias: string;
  baseUrl: string;
  version: string | null;
  instanceName: string | null;
}

export class SimulationServiceError extends Error {
  constructor(
    public readonly code:
      | 'simulation_not_found'
      | 'radarr_connection_not_found'
      | 'default_radarr_not_configured'
      | 'radarr_connection_unavailable'
      | OrdinalPolicyErrorCode,
    public readonly statusCode: 404 | 409 | 422,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SimulationServiceError';
  }
}

export class SimulationService {
  private readonly clientFactory: SimulationClientFactory;
  private readonly profiles: ProfileService;

  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly secrets: SecretStore,
    clientFactory?: SimulationClientFactory,
    profileService?: ProfileService,
  ) {
    const options: HttpClientOptions = {
      timeoutMs: config.RELEASE_PROBE_TIMEOUT_MS,
      maxResponseBytes: config.HTTP_MAX_RESPONSE_BYTES,
    };
    this.clientFactory =
      clientFactory ?? ((url, key) => new RadarrReleaseProbeClient(url, key, options));
    this.profiles = profileService ?? new ProfileService(database);
  }

  async movies(radarrConnectionId?: number): Promise<Record<string, unknown>> {
    const connection = this.connection(radarrConnectionId);
    const client = this.clientFactory(connection.baseUrl, this.secrets.get(connection.secretRef));
    const parsed = moviesSchema.safeParse(await client.movies());
    if (!parsed.success)
      throw new ServiceClientError(
        'incompatible_response',
        'Radarr returned an invalid movie list',
      );
    return {
      radarr: this.connectionSnapshot(connection),
      movies: parsed.data.map((movie) => redactProbeData(movie).value),
    };
  }

  create(input: StartSimulationInput): Record<string, unknown> {
    const connection = this.connection(input.radarrConnectionId);
    const profile = this.profile(input.profileId);
    const evaluationProfile = this.evaluationProfile(profile);
    const preparedProfile = prepareOrdinalProfile(evaluationProfile);
    if (!preparedProfile.ok) {
      throw new SimulationServiceError(
        preparedProfile.error.code,
        422,
        preparedProfile.error.message,
        preparedProfile.error.details,
      );
    }
    const progress = initialSimulationProgress();
    const startedAt = new Date();
    const inserted = this.database.db
      .insert(simulations)
      .values({
        status: 'queued',
        movieId: input.movieId,
        radarrConnectionId: connection.id,
        radarrSnapshotJson: JSON.stringify(this.connectionSnapshot(connection)),
        profileId: profile.id,
        profileRevision: profile.revision,
        profileSchemaVersion: profile.schemaVersion,
        profileSnapshotJson: JSON.stringify(profile),
        progressJson: JSON.stringify(progress),
        attempts: 0,
        availableAt: startedAt,
        startedAt,
      })
      .run();
    const simulationId = Number(inserted.lastInsertRowid);
    return { id: simulationId, status: 'queued' };
  }

  async executeClaimed(simulationId: number, workerId: string): Promise<void> {
    const claimed = this.claimed(simulationId, workerId);
    if (!claimed) throw new Error('Simulation claim is no longer owned by this worker');
    const profile = parseJson(claimed.profileSnapshotJson) as ProfileView;
    const evaluationProfile = this.evaluationProfile(profile);
    const connectionSnapshot = parseJson(claimed.radarrSnapshotJson) as ConnectionSnapshot;
    const connection = this.database.db
      .select()
      .from(serviceConnections)
      .where(
        and(
          eq(serviceConnections.id, connectionSnapshot.id),
          eq(serviceConnections.service, 'radarr'),
        ),
      )
      .get();
    if (connection?.connectionStatus !== 'connected') {
      this.failClaimed(simulationId, workerId, {
        code: 'radarr_connection_unavailable',
        message: 'The Radarr instance frozen for this simulation is no longer available',
      });
      return;
    }
    const client = this.clientFactory(
      connectionSnapshot.baseUrl,
      this.secrets.get(connection.secretRef),
    );
    const progress = initialSimulationProgress();
    this.database.sqlite.transaction(() => {
      this.assertClaim(simulationId, workerId);
      this.database.sqlite
        .prepare('DELETE FROM simulation_releases WHERE simulation_id = ?')
        .run(simulationId);
      this.database.db
        .update(simulations)
        .set({
          outcome: null,
          movieJson: null,
          progressJson: JSON.stringify(progress),
          summaryJson: null,
          selectionJson: null,
          resultJson: null,
          completedAt: null,
        })
        .where(eq(simulations.id, simulationId))
        .run();
    })();

    try {
      this.startProgress(simulationId, workerId, progress, 'film_found');
      const movieResult = movieSchema.safeParse(await client.movie(claimed.movieId));
      if (!movieResult.success || movieResult.data.id !== claimed.movieId)
        throw new ServiceClientError(
          'not_found',
          'The movie is not present in this Radarr instance',
        );
      const movie = redactProbeData(movieResult.data).value;
      this.completeProgress(simulationId, workerId, progress, 'film_found', movie);

      this.startProgress(simulationId, workerId, progress, 'releases_retrieved');
      const releaseResult = releasesSchema.safeParse(await client.releases(claimed.movieId));
      if (!releaseResult.success)
        throw new ServiceClientError('incompatible_response', 'Radarr returned invalid releases');
      this.completeProgress(simulationId, workerId, progress, 'releases_retrieved');

      this.startProgress(simulationId, workerId, progress, 'preferences_analyzed');
      const knownRadarrConnectionIds = this.database.db
        .select({ id: serviceConnections.id })
        .from(serviceConnections)
        .where(eq(serviceConnections.service, 'radarr'))
        .all()
        .map(({ id }) => id);
      const observed = releaseResult.data.map(
        (release) => redactProbeData(release).value as Record<string, unknown>,
      );
      const normalized = observed.map((release) => normalizeRelease(release));
      const evaluations = normalized.map((release) =>
        evaluateRelease({
          release,
          profile: evaluationProfile,
          movieContext: { originalLanguage: movieResult.data.originalLanguage ?? null },
          radarrConnectionId: connectionSnapshot.id,
          knownRadarrConnectionIds,
        }),
      );
      this.completeProgress(simulationId, workerId, progress, 'preferences_analyzed');

      this.startProgress(simulationId, workerId, progress, 'selection_calculated');
      const eligible = evaluations.filter((evaluation) => evaluation.eligible);
      let selection: CandidateSelectionResult | null = null;
      if (eligible.length > 0) {
        selection = selectCandidates({
          profile: evaluationProfile,
          radarrConnectionId: connectionSnapshot.id,
          candidates: eligible,
        });
        if (!selection.ok) throw new Error(`Selection invariant violated: ${selection.error.code}`);
      }
      this.completeProgress(simulationId, workerId, progress, 'selection_calculated');
      const prepared = this.prepareReleases(observed, normalized, evaluations, selection);
      const ordered = this.informativeOrder(prepared);
      const summary = this.summary(prepared);
      const outcome =
        eligible.length === 0
          ? 'no_suitable_release'
          : selection?.ok && selection.selection.winner === null
            ? 'equivalent'
            : 'selected';
      const result =
        eligible.length === 0
          ? {
              code: 'no_suitable_release',
              message: 'Aucune release adaptée',
              summary,
              selectedRelease: null,
            }
          : {
              code: selection?.ok ? selection.selection.basis : 'selection_unavailable',
              summary,
              selectedRelease: selection?.ok ? selection.selection.winner : null,
              finalists: selection?.ok ? selection.selection.finalists : [],
            };
      this.database.sqlite.transaction(() => {
        this.assertClaim(simulationId, workerId);
        if (ordered.length > 0)
          this.database.db
            .insert(simulationReleases)
            .values(
              ordered.map(({ release, presentationOrdinal }) => ({
                simulationId,
                ordinal: release.ordinal,
                presentationOrdinal,
                fingerprint: release.normalized.identity.fingerprint,
                category: release.category,
                eliminatedAtStep: release.eliminatedAtStep,
                observedJson: JSON.stringify(release.observed),
                normalizedJson: JSON.stringify(release.normalized),
                evaluationJson: JSON.stringify(release.evaluation),
                reasonsJson: JSON.stringify(release.reasons),
              })),
            )
            .run();
        this.database.db
          .update(simulations)
          .set({
            status: 'completed',
            outcome,
            movieJson: JSON.stringify(movie),
            progressJson: JSON.stringify(progress),
            summaryJson: JSON.stringify(summary),
            selectionJson: selection === null ? null : JSON.stringify(selection),
            resultJson: JSON.stringify(result),
            completedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          })
          .where(eq(simulations.id, simulationId))
          .run();
      })();
    } catch (error) {
      const safe = safeError(error);
      this.failClaimed(simulationId, workerId, safe, progress);
    }
  }

  list(): Record<string, unknown> {
    return {
      simulations: this.database.db
        .select()
        .from(simulations)
        .orderBy(desc(simulations.startedAt), desc(simulations.id))
        .all()
        .map((simulation) => ({
          id: simulation.id,
          status: simulation.status,
          outcome: simulation.outcome,
          film: simulation.movieJson ? parseJson(simulation.movieJson) : { id: simulation.movieId },
          radarr: parseJson(simulation.radarrSnapshotJson),
          profile: {
            id: simulation.profileId,
            revision: simulation.profileRevision,
            schemaVersion: simulation.profileSchemaVersion,
          },
          summary: simulation.summaryJson ? parseJson(simulation.summaryJson) : null,
          startedAt: simulation.startedAt.toISOString(),
          completedAt: simulation.completedAt?.toISOString() ?? null,
        })),
    };
  }

  get(simulationId: number): Record<string, unknown> {
    const simulation = this.database.db
      .select()
      .from(simulations)
      .where(eq(simulations.id, simulationId))
      .get();
    if (!simulation)
      throw new SimulationServiceError('simulation_not_found', 404, 'Simulation was not found');
    const releases = this.database.db
      .select()
      .from(simulationReleases)
      .where(eq(simulationReleases.simulationId, simulationId))
      .orderBy(asc(simulationReleases.presentationOrdinal))
      .all()
      .map((release) => ({
        ordinal: release.ordinal,
        presentationOrdinal: release.presentationOrdinal,
        category: release.category,
        eliminatedAtStep: release.eliminatedAtStep,
        observed: parseJson(release.observedJson),
        normalized: parseJson(release.normalizedJson),
        evaluation: parseJson(release.evaluationJson),
        reasons: parseJson(release.reasonsJson),
      }));
    return {
      id: simulation.id,
      status: simulation.status,
      outcome: simulation.outcome,
      film: simulation.movieJson ? parseJson(simulation.movieJson) : { id: simulation.movieId },
      radarr: parseJson(simulation.radarrSnapshotJson),
      profile: parseJson(simulation.profileSnapshotJson),
      progress: parseJson(simulation.progressJson),
      summary: simulation.summaryJson ? parseJson(simulation.summaryJson) : null,
      selection: simulation.selectionJson ? parseJson(simulation.selectionJson) : null,
      result: simulation.resultJson ? parseJson(simulation.resultJson) : null,
      error: simulation.errorCode
        ? { code: simulation.errorCode, message: simulation.errorMessage }
        : null,
      releases,
      startedAt: simulation.startedAt.toISOString(),
      completedAt: simulation.completedAt?.toISOString() ?? null,
      informationalOrdering: true,
    };
  }

  private connection(radarrConnectionId?: number): typeof serviceConnections.$inferSelect {
    const matches =
      radarrConnectionId === undefined
        ? this.database.db
            .select()
            .from(serviceConnections)
            .where(
              and(eq(serviceConnections.service, 'radarr'), eq(serviceConnections.isDefault, true)),
            )
            .all()
        : this.database.db
            .select()
            .from(serviceConnections)
            .where(
              and(
                eq(serviceConnections.id, radarrConnectionId),
                eq(serviceConnections.service, 'radarr'),
              ),
            )
            .all();
    const connection = matches.length === 1 ? matches[0] : undefined;
    if (!connection)
      throw new SimulationServiceError(
        radarrConnectionId === undefined
          ? 'default_radarr_not_configured'
          : 'radarr_connection_not_found',
        404,
        radarrConnectionId === undefined
          ? 'A default Radarr instance is required'
          : 'Radarr connection was not found',
      );
    if (connection.connectionStatus !== 'connected')
      throw new SimulationServiceError(
        'radarr_connection_unavailable',
        409,
        'The selected Radarr connection is not connected',
      );
    return connection;
  }

  private profile(profileId?: number): ProfileView {
    try {
      return profileId === undefined ? this.profiles.getDefault() : this.profiles.get(profileId);
    } catch (error) {
      if (error instanceof ProfileServiceError) throw error;
      throw error;
    }
  }

  private evaluationProfile(profile: ProfileView): EvaluationProfile {
    return {
      id: profile.id,
      schemaVersion: profile.schemaVersion,
      revision: profile.revision,
      rules: structuredClone(profile.rules),
    };
  }

  private connectionSnapshot(
    connection: typeof serviceConnections.$inferSelect,
  ): ConnectionSnapshot {
    return {
      id: connection.id,
      alias: connection.alias,
      baseUrl: connection.baseUrl,
      version: connection.version,
      instanceName: connection.instanceName,
    };
  }

  private claimed(simulationId: number, workerId: string) {
    return this.database.db
      .select()
      .from(simulations)
      .where(
        and(
          eq(simulations.id, simulationId),
          eq(simulations.status, 'running'),
          eq(simulations.lockedBy, workerId),
        ),
      )
      .get();
  }

  private assertClaim(simulationId: number, workerId: string): void {
    if (!this.claimed(simulationId, workerId))
      throw new Error('Simulation claim is no longer owned by this worker');
  }

  private startProgress(
    simulationId: number,
    workerId: string,
    progress: SimulationProgressStep[],
    code: SimulationProgressCode,
  ): void {
    this.assertClaim(simulationId, workerId);
    const step = progress.find((item) => item.code === code);
    if (!step) throw new Error(`Unknown simulation progress step: ${code}`);
    step.status = 'in_progress';
    step.startedAt = new Date().toISOString();
    step.completedAt = null;
    step.error = null;
    this.updateProgress(simulationId, workerId, progress);
  }

  private completeProgress(
    simulationId: number,
    workerId: string,
    progress: SimulationProgressStep[],
    code: SimulationProgressCode,
    movie?: unknown,
  ): void {
    this.assertClaim(simulationId, workerId);
    const step = progress.find((item) => item.code === code);
    if (!step) throw new Error(`Unknown simulation progress step: ${code}`);
    step.status = 'completed';
    step.completedAt = new Date().toISOString();
    this.updateProgress(simulationId, workerId, progress, movie);
  }

  private failClaimed(
    simulationId: number,
    workerId: string,
    error: { code: string; message: string },
    progress?: SimulationProgressStep[],
  ): void {
    const current =
      progress ??
      (parseJson(
        this.claimed(simulationId, workerId)?.progressJson ?? '[]',
      ) as SimulationProgressStep[]);
    const active =
      current.find((step) => step.status === 'in_progress') ??
      current.find((step) => step.status === 'pending');
    if (active) {
      active.status = 'failed';
      active.completedAt = new Date().toISOString();
      active.error = { code: error.code, message: error.message };
    }
    this.database.db
      .update(simulations)
      .set({
        status: 'failed',
        outcome: null,
        progressJson: JSON.stringify(current),
        errorCode: error.code,
        errorMessage: error.message,
        lastError: error.code,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      })
      .where(
        and(
          eq(simulations.id, simulationId),
          eq(simulations.status, 'running'),
          eq(simulations.lockedBy, workerId),
        ),
      )
      .run();
  }

  private progress(code: LegacyProgressStep['code']): LegacyProgressStep {
    const labels: Record<LegacyProgressStep['code'], LegacyProgressStep['label']> = {
      film_found: 'Film trouvé',
      releases_retrieved: 'Releases récupérées',
      preferences_analyzed: 'Analyse des préférences',
      selection_calculated: 'Calcul du classement',
    };
    const now = new Date().toISOString();
    return {
      code,
      label: labels[code],
      status: 'completed',
      startedAt: now,
      completedAt: now,
      error: null,
    };
  }

  private updateProgress(
    simulationId: number,
    workerId: string,
    progress: SimulationProgressStep[] | LegacyProgressStep[],
    movie?: unknown,
  ): void {
    const updated = this.database.db
      .update(simulations)
      .set({
        progressJson: JSON.stringify(progress),
        lockedAt: new Date(),
        ...(movie === undefined ? {} : { movieJson: JSON.stringify(movie) }),
      })
      .where(
        and(
          eq(simulations.id, simulationId),
          eq(simulations.status, 'running'),
          eq(simulations.lockedBy, workerId),
        ),
      )
      .run();
    if (updated.changes !== 1) throw new Error('Simulation claim was lost while updating progress');
  }

  private prepareReleases(
    observed: Record<string, unknown>[],
    normalized: NormalizedRelease[],
    evaluations: ReleaseEvaluation[],
    selection: CandidateSelectionResult | null,
  ): PreparedRelease[] {
    const eliminated = new Map<string, { step: number; reason: unknown }>();
    if (selection?.ok) {
      selection.steps.forEach((step, stepIndex) => {
        for (const item of step.eliminated) {
          eliminated.set(item.candidate.fingerprint, {
            step: stepIndex,
            reason: {
              code: 'eliminated_by_rule',
              rule: step.rule,
              tier: step.tier,
              method: item.reason,
              state: item.state,
              ...(item.observedValue === undefined ? {} : { observedValue: item.observedValue }),
            },
          });
        }
      });
    }
    const selectedFingerprint = selection?.ok ? selection.selection.winner?.fingerprint : undefined;
    return normalized.map((release, ordinal) => {
      const evaluation = evaluations[ordinal];
      if (!evaluation) throw new Error('Simulation evaluation invariant violated');
      const observedRelease = observed[ordinal];
      if (!observedRelease) throw new Error('Simulation observation invariant violated');
      if (!evaluation.radarrEligibility.eligible) {
        return {
          ordinal,
          observed: observedRelease,
          normalized: release,
          evaluation,
          category: 'radarr_rejected',
          reasons: [
            {
              code: 'radarr_rejected',
              reasons: evaluation.radarrEligibility.reasons,
              rejections: evaluation.radarrEligibility.rejections,
            },
          ],
          eliminatedAtStep: null,
        };
      }
      if (!evaluation.profileEligible) {
        return {
          ordinal,
          observed: observedRelease,
          normalized: release,
          evaluation,
          category: 'scorerr_refused',
          reasons: Object.values(evaluation.rules)
            .filter((rule) => rule.hardConstraintViolation)
            .map((rule) => ({
              code: 'profile_constraint_failed',
              rule: rule.rule,
              importance: rule.importance,
              explanation: rule.explanation,
            })),
          eliminatedAtStep: null,
        };
      }
      const elimination = eliminated.get(release.identity.fingerprint);
      if (elimination) {
        return {
          ordinal,
          observed: observedRelease,
          normalized: release,
          evaluation,
          category: 'selection_eliminated',
          reasons: [elimination.reason],
          eliminatedAtStep: elimination.step,
        };
      }
      const selected = selectedFingerprint === release.identity.fingerprint;
      return {
        ordinal,
        observed: observedRelease,
        normalized: release,
        evaluation,
        category: selected ? 'selected' : 'finalist',
        reasons: selected ? [{ code: 'selected_by_phase_4b' }] : [{ code: 'phase_4b_finalist' }],
        eliminatedAtStep: null,
      };
    });
  }

  private informativeOrder(
    releases: PreparedRelease[],
  ): { release: PreparedRelease; presentationOrdinal: number }[] {
    const categoryOrder: Record<SimulationReleaseCategory, number> = {
      selected: 0,
      finalist: 1,
      selection_eliminated: 2,
      scorerr_refused: 3,
      radarr_rejected: 4,
    };
    const ordered: PreparedRelease[] = [];
    for (const release of releases) {
      let index = 0;
      while (index < ordered.length) {
        const existing = ordered[index];
        if (!existing) break;
        const categoryDifference =
          categoryOrder[release.category] - categoryOrder[existing.category];
        const eliminationDifference =
          release.category === 'selection_eliminated' &&
          existing.category === 'selection_eliminated'
            ? (existing.eliminatedAtStep ?? -1) - (release.eliminatedAtStep ?? -1)
            : 0;
        const releaseFingerprint = release.normalized.identity.fingerprint;
        const existingFingerprint = existing.normalized.identity.fingerprint;
        const technicalDifference =
          releaseFingerprint < existingFingerprint
            ? -1
            : releaseFingerprint > existingFingerprint
              ? 1
              : release.ordinal - existing.ordinal;
        if (
          categoryDifference < 0 ||
          (categoryDifference === 0 && eliminationDifference < 0) ||
          (categoryDifference === 0 && eliminationDifference === 0 && technicalDifference < 0)
        )
          break;
        index += 1;
      }
      ordered.splice(index, 0, release);
    }
    return ordered.map((release, presentationOrdinal) => ({ release, presentationOrdinal }));
  }

  private summary(releases: PreparedRelease[]): Record<string, number> {
    const count = (category: SimulationReleaseCategory) =>
      releases.filter((release) => release.category === category).length;
    return {
      total: releases.length,
      radarrRejected: count('radarr_rejected'),
      scorerrRefused: count('scorerr_refused'),
      selectionEliminated: count('selection_eliminated'),
      finalists: count('finalist'),
      selected: count('selected'),
    };
  }
}
