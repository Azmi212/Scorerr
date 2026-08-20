import { fingerprintEvent, normalizeJson } from './fingerprint.js';

export type ReleaseProtocol = 'torrent' | 'usenet' | 'unknown';

export const releaseProbeDiagnosticScope = {
  mode: 'phase_3b_diagnostic',
  producesFinalRanking: false,
  scoringPolicy: 'not_implemented',
} as const;

export const torrentAvailabilitySignalScope = {
  mode: 'experimental_diagnostic_observation',
  contributesToFinalScore: false,
} as const;

export interface NormalizedRelease {
  identity: {
    fingerprint: string;
    title: string | null;
    releaseGroup: string | null;
    indexer: string | null;
    indexerId: string | number | null;
  };
  media: {
    qualityName: string | null;
    source: string | null;
    resolution: number | null;
    revision: Record<string, unknown> | null;
    sizeBytes: number | null;
  };
  availability: {
    protocol: ReleaseProtocol;
    seeders: number | null;
    leechers: number | null;
    peers: number | null;
    grabs: number | null;
    availabilitySignalRaw: number | null;
  };
  language: { languages: unknown[] | null };
  formats: { customFormats: unknown[] | null; customFormatScore: number | null };
  radarr: {
    approved: boolean | null;
    rejected: boolean | null;
    temporarilyRejected: boolean | null;
    downloadAllowed: boolean | null;
    rejections: unknown[] | null;
    qualityWeight: number | null;
    releaseWeight: number | null;
  };
  eligibility: { eligible: boolean; source: 'radarr'; reasons: string[] };
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const array = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

/**
 * Experimental Phase 3B diagnostic observation for Torrent availability only.
 *
 * This is not a scorerr score and must not select or rank a final release.
 */
export function torrentAvailabilitySignal(seeders: number | null): number | null {
  if (seeders === null) return null;
  if (seeders <= 0) return seeders === 0 ? 0 : null;
  return Math.log1p(seeders);
}

export function normalizeRelease(raw: Record<string, unknown>): NormalizedRelease {
  const qualityContainer = object(raw.quality);
  const quality = object(qualityContainer?.quality);
  const protocolValue = string(raw.protocol)?.toLowerCase();
  const protocol: ReleaseProtocol =
    protocolValue === 'torrent' || protocolValue === 'usenet' ? protocolValue : 'unknown';
  const seeders = number(raw.seeders);
  const approved = boolean(raw.approved);
  const rejected = boolean(raw.rejected);
  const reasons: string[] = [];
  if (approved !== true) reasons.push('radarr_not_approved');
  if (rejected === true) reasons.push('radarr_rejected');

  return {
    identity: {
      fingerprint: fingerprintEvent(normalizeJson(raw)),
      title: string(raw.title),
      releaseGroup: string(raw.releaseGroup),
      indexer: string(raw.indexer),
      indexerId:
        typeof raw.indexerId === 'string' || typeof raw.indexerId === 'number'
          ? raw.indexerId
          : null,
    },
    media: {
      qualityName: string(quality?.name),
      source: string(quality?.source),
      resolution: number(quality?.resolution),
      revision: object(qualityContainer?.revision),
      sizeBytes: number(raw.size),
    },
    availability: {
      protocol,
      seeders,
      leechers: number(raw.leechers),
      peers: number(raw.peers),
      grabs: number(raw.grabs),
      availabilitySignalRaw: protocol === 'torrent' ? torrentAvailabilitySignal(seeders) : null,
    },
    language: { languages: array(raw.languages) },
    formats: {
      customFormats: array(raw.customFormats),
      customFormatScore: number(raw.customFormatScore),
    },
    radarr: {
      approved,
      rejected,
      temporarilyRejected: boolean(raw.temporarilyRejected),
      downloadAllowed: boolean(raw.downloadAllowed),
      rejections: array(raw.rejections),
      qualityWeight: number(raw.qualityWeight),
      releaseWeight: number(raw.releaseWeight),
    },
    eligibility: {
      eligible: rejected !== true && approved === true,
      source: 'radarr',
      reasons,
    },
  };
}

function seedersStats(releases: NormalizedRelease[]) {
  const values = releases
    .filter((release) => release.availability.protocol === 'torrent')
    .map((release) => release.availability.seeders)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (values.length === 0)
    return { observed: 0, min: null, max: null, average: null, median: null };
  const middle = Math.floor(values.length / 2);
  const middleValue = values.at(middle);
  const lowerValue = values.at(middle - 1);
  if (middleValue === undefined) throw new Error('Seeders statistics invariant violated');
  const median =
    values.length % 2 === 0 ? ((lowerValue ?? middleValue) + middleValue) / 2 : middleValue;
  return {
    observed: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median,
  };
}

export function summarizeNormalizedReleases(releases: NormalizedRelease[]) {
  const eligible = releases.filter((release) => release.eligibility.eligible);
  return {
    totalReleases: releases.length,
    eligibleReleases: eligible.length,
    rejectedReleases: releases.filter((release) => release.radarr.rejected === true).length,
    eligibleAvailabilityStatistics: {
      torrent: {
        releaseCount: eligible.filter((release) => release.availability.protocol === 'torrent')
          .length,
        seeders: seedersStats(eligible),
      },
      usenet: {
        releaseCount: eligible.filter((release) => release.availability.protocol === 'usenet')
          .length,
      },
      unknown: {
        releaseCount: eligible.filter((release) => release.availability.protocol === 'unknown')
          .length,
      },
    },
  };
}

/**
 * Phase 3B diagnostic ordering by observed Torrent seeders only.
 *
 * This is not the scorerr product ranking and must not select a final release.
 */
export function releaseComparison(releases: NormalizedRelease[]) {
  return releases
    .filter((release) => release.eligibility.eligible)
    .sort((left, right) => {
      const a = left.availability.seeders;
      const b = right.availability.seeders;
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return b - a;
    })
    .map((release) => ({
      title: release.identity.title,
      quality: release.media.qualityName,
      resolution: release.media.resolution,
      source: release.media.source,
      size: release.media.sizeBytes,
      indexer: release.identity.indexer,
      languages: release.language.languages,
      customFormatScore: release.formats.customFormatScore,
      seeders: release.availability.seeders,
      leechers: release.availability.leechers,
      availabilitySignalRaw: release.availability.availabilitySignalRaw,
    }));
}
