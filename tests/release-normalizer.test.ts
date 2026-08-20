import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  normalizeRelease,
  releaseProbeDiagnosticScope,
  releaseComparison,
  summarizeNormalizedReleases,
  torrentAvailabilitySignal,
  torrentAvailabilitySignalScope,
} from '../src/services/release-normalizer.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/amelie-releases.redacted.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

describe('Release Normalizer and Radarr eligibility', () => {
  it('keeps Phase 3B observations explicitly diagnostic and outside final scoring', () => {
    expect(releaseProbeDiagnosticScope).toEqual({
      mode: 'phase_3b_diagnostic',
      producesFinalRanking: false,
      scoringPolicy: 'not_implemented',
    });
    expect(torrentAvailabilitySignalScope).toEqual({
      mode: 'experimental_diagnostic_observation',
      contributesToFinalScore: false,
    });
  });

  it('accepts only approved and non-rejected releases', () => {
    expect(normalizeRelease({ approved: true, rejected: false }).eligibility.eligible).toBe(true);
    expect(
      normalizeRelease({ approved: true, rejected: true, seeders: 500 }).eligibility.eligible,
    ).toBe(false);
    expect(
      normalizeRelease({ approved: true, rejected: true, downloadAllowed: true }).eligibility
        .eligible,
    ).toBe(false);
  });

  it('keeps the wrong high-seeder film outside the eligible collection', () => {
    const normalized = fixture.map(normalizeRelease);
    expect(
      releaseComparison(normalized).some(
        (release) => release.title === 'Wrong.Movie.2001.1080p.BluRay-GROUP',
      ),
    ).toBe(false);
  });

  it('preserves missing availability as null for the experimental logarithmic observation', () => {
    expect(normalizeRelease({ protocol: 'torrent' }).availability.seeders).toBeNull();
    expect(torrentAvailabilitySignal(null)).toBeNull();
    expect(torrentAvailabilitySignal(0)).toBe(0);
    for (const seeders of [1, 2, 10, 100, 1000])
      expect(torrentAvailabilitySignal(seeders)).toBeCloseTo(Math.log(1 + seeders));
  });

  it('calculates torrent seeders statistics only from eligible releases', () => {
    const summary = summarizeNormalizedReleases(fixture.map(normalizeRelease));
    expect(summary).toMatchObject({ totalReleases: 6, eligibleReleases: 4, rejectedReleases: 2 });
    expect(summary.eligibleAvailabilityStatistics.torrent.seeders).toMatchObject({
      observed: 4,
      min: 0,
      max: 285,
      average: 123.75,
      median: 105,
    });
  });

  it('separates torrent, Usenet and unknown availability', () => {
    const releases = [
      normalizeRelease({ approved: true, rejected: false, protocol: 'torrent', seeders: 2 }),
      normalizeRelease({ approved: true, rejected: false, protocol: 'usenet', grabs: 4 }),
      normalizeRelease({ approved: true, rejected: false }),
    ];
    const stats = summarizeNormalizedReleases(releases).eligibleAvailabilityStatistics;
    expect(stats.torrent.releaseCount).toBe(1);
    expect(stats.usenet.releaseCount).toBe(1);
    expect(stats.unknown.releaseCount).toBe(1);
    expect(releases[1]?.availability.availabilitySignalRaw).toBeNull();
  });

  it('retains rejection messages only as opaque diagnostic data', () => {
    const message = '500 seeders means nothing; arbitrary localized text';
    const release = normalizeRelease({ approved: true, rejected: true, rejections: [message] });
    expect(release.radarr.rejections).toEqual([message]);
    expect(release.eligibility.reasons).toEqual(['radarr_rejected']);
  });
});
