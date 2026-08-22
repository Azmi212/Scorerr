import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateRelease,
  type EvaluationProfile,
  type MovieEvaluationContext,
  type ReleaseEvaluationInput,
} from '../src/evaluation/release-evaluator.js';
import { normalizeRelease, type NormalizedRelease } from '../src/services/release-normalizer.js';
import type { ProfileRuleInput, ProfileRuleType } from '../src/services/profile-service.js';

const gibibyte = 1024 * 1024 * 1024;

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/amelie-releases.redacted.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

const fixtureReleases = fixture.map(normalizeRelease);

interface EvaluationOptions {
  movieContext?: MovieEvaluationContext;
  radarrConnectionId?: number;
  knownRadarrConnectionIds?: readonly number[];
}

function baseProfile(): EvaluationProfile {
  const rules: ProfileRuleInput[] = [
    {
      type: 'language',
      position: 0,
      configVersion: 1,
      config: { preferredLanguages: ['fr', 'en'], fallback: 'original' },
    },
    {
      type: 'seeders',
      position: 1,
      configVersion: 1,
      config: { importance: 'high', desiredMinimum: 3, requireMinimum: false },
    },
    {
      type: 'resolution',
      position: 2,
      configVersion: 1,
      config: {
        importance: 'medium',
        preferredHeight: 1080,
        desiredMinimumHeight: 720,
        requireMinimum: false,
      },
    },
    {
      type: 'source',
      position: 3,
      configVersion: 1,
      config: { importance: 'priority', preferredSources: ['bluray', 'webdl'] },
    },
    {
      type: 'size',
      position: 4,
      configVersion: 1,
      config: {
        importance: 'medium',
        desiredMaximumBytes: 10 * gibibyte,
        requireMaximum: false,
      },
    },
    {
      type: 'codec',
      position: 5,
      configVersion: 1,
      config: { importance: 'low', preferredCodecs: ['hevc', 'avc'] },
    },
    {
      type: 'custom_formats',
      position: 6,
      configVersion: 1,
      config: { importance: 'priority', useRadarrPreferences: true },
    },
    {
      type: 'indexer',
      position: 7,
      configVersion: 1,
      config: {
        importance: 'low',
        preferredIndexers: [{ radarrConnectionId: 101, indexerId: 1 }],
        allowOthers: true,
      },
    },
  ];
  return { id: 42, schemaVersion: 1, revision: 7, rules };
}

function ruleOf<T extends ProfileRuleType>(
  profile: EvaluationProfile,
  type: T,
): Extract<ProfileRuleInput, { type: T }> {
  const rule = profile.rules.find((candidate) => candidate.type === type);
  if (!rule) throw new Error(`Test profile is missing ${type}.`);
  return rule as Extract<ProfileRuleInput, { type: T }>;
}

function releaseFromFixture(releaseGroup: string): NormalizedRelease {
  const release = fixtureReleases.find(
    (candidate) => candidate.identity.releaseGroup === releaseGroup,
  );
  if (!release) throw new Error(`Fixture release group ${releaseGroup} is missing.`);
  return release;
}

function syntheticRelease(overrides: Record<string, unknown> = {}): NormalizedRelease {
  return normalizeRelease({
    title: 'Synthetic.Movie.2026.1080p.BluRay',
    releaseGroup: 'SYNTHETIC',
    indexer: 'synthetic-indexer',
    indexerId: 1,
    protocol: 'torrent',
    size: 5 * gibibyte,
    seeders: 10,
    approved: true,
    rejected: false,
    downloadAllowed: true,
    quality: {
      quality: { name: 'Bluray-1080p', source: 'bluray', resolution: 1080 },
    },
    languages: [{ code: 'fr' }],
    customFormats: [{ name: 'Desired' }],
    customFormatScore: 12,
    rejections: [],
    ...overrides,
  });
}

function evaluate(
  release: NormalizedRelease,
  profile = baseProfile(),
  options: EvaluationOptions = {},
) {
  const input: ReleaseEvaluationInput = {
    release,
    profile,
    radarrConnectionId: options.radarrConnectionId ?? 101,
  };
  if (options.movieContext !== undefined) input.movieContext = options.movieContext;
  if (options.knownRadarrConnectionIds !== undefined)
    input.knownRadarrConnectionIds = options.knownRadarrConnectionIds;
  return evaluateRelease(input);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function outputKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(outputKeys);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...outputKeys(child),
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pure Phase 3 release evaluation', () => {
  it('evaluates the eligible Amélie release with eight explainable rule states', () => {
    const profile = baseProfile();
    ruleOf(profile, 'size').config.desiredMaximumBytes = 13 * gibibyte;

    const result = evaluate(releaseFromFixture('QTZ'), profile, {
      knownRadarrConnectionIds: [101],
    });

    expect(result).toMatchObject({
      profileId: 42,
      profileSchemaVersion: 1,
      profileRevision: 7,
      radarrEligibility: { eligible: true, approved: true, rejected: false },
      profileEligible: true,
      eligible: true,
    });
    expect(result.rules.language).toMatchObject({ state: 'preferred', configVersion: 1 });
    expect(result.rules.seeders).toMatchObject({ state: 'preferred', importance: 'high' });
    expect(result.rules.resolution).toMatchObject({ state: 'preferred', importance: 'medium' });
    expect(result.rules.source).toMatchObject({ state: 'preferred', importance: 'priority' });
    expect(result.rules.size).toMatchObject({ state: 'preferred', importance: 'medium' });
    expect(result.rules.codec).toMatchObject({ state: 'unknown', importance: 'low' });
    expect(result.rules.custom_formats).toMatchObject({
      state: 'acceptable',
      importance: 'priority',
    });
    expect(result.rules.indexer).toMatchObject({ state: 'preferred', importance: 'low' });
    expect(result.rules.language.observed).toMatchObject({ languageCodes: ['fr'] });
    expect(result.rules.custom_formats.observed).toEqual({
      customFormats: [],
      radarrReportedValue: 10,
    });
    expect(result.rules.codec.warnings).toContainEqual({
      rule: 'codec',
      code: 'structured_codec_unavailable',
    });
  });

  it('treats the Radarr barrier as final, including an explicitly rejected release', () => {
    const rejectedFixture = evaluate(releaseFromFixture('GROUP'));
    const approvedButRejected = evaluate(
      syntheticRelease({ approved: true, rejected: true, seeders: 50_000 }),
    );

    expect(rejectedFixture).toMatchObject({
      radarrEligibility: {
        eligible: false,
        reasons: ['radarr_not_approved', 'radarr_rejected'],
        rejections: ['Title does not match the requested movie'],
      },
      profileEligible: null,
      eligible: false,
    });
    expect(
      Object.values(rejectedFixture.rules).every((rule) => rule.state === 'not_applicable'),
    ).toBe(true);
    expect(approvedButRejected).toMatchObject({
      radarrEligibility: { eligible: false, approved: true, rejected: true },
      profileEligible: null,
      eligible: false,
    });
  });

  it('uses structured MULTi language data, supports the original-language fallback, and never parses titles', () => {
    const multi = evaluate(
      syntheticRelease({
        title: 'No language token is required here',
        languages: [{ code: 'en' }, { code: 'fr' }],
      }),
    );
    expect(multi.rules.language).toMatchObject({
      state: 'preferred',
      observed: { languageCodes: ['en', 'fr'], matchedPreferenceIndex: 0 },
    });

    const fallbackProfile = baseProfile();
    ruleOf(fallbackProfile, 'language').config.preferredLanguages = ['fr'];
    const fallback = evaluate(syntheticRelease({ languages: [{ code: 'en' }] }), fallbackProfile, {
      movieContext: { originalLanguage: 'en' },
    });
    expect(fallback.rules.language.state).toBe('fallback');

    const withoutOriginalLanguage = evaluate(
      syntheticRelease({ languages: [{ code: 'en' }] }),
      fallbackProfile,
    );
    expect(withoutOriginalLanguage.rules.language).toMatchObject({ state: 'unknown' });
    expect(withoutOriginalLanguage.rules.language.warnings).toContainEqual({
      rule: 'language',
      code: 'original_language_unavailable',
    });

    const titleOnlyHints = evaluate(
      syntheticRelease({
        title: 'Synthetic.MULTi.VF.VFF.x265',
        languages: null,
      }),
    );
    expect(titleOnlyHints.rules.language.state).toBe('unknown');
    expect(titleOnlyHints.rules.codec.state).toBe('unknown');
  });

  it('keeps torrent availability separate from Usenet and enforces it only when required', () => {
    const softProfile = baseProfile();
    const softMiss = evaluate(releaseFromFixture('ZERO'), softProfile);
    expect(softMiss).toMatchObject({ profileEligible: true, eligible: true });
    expect(softMiss.rules.seeders.state).toBe('soft_miss');

    const requiredProfile = baseProfile();
    ruleOf(requiredProfile, 'seeders').config.requireMinimum = true;
    const hardFailure = evaluate(releaseFromFixture('ZERO'), requiredProfile);
    expect(hardFailure).toMatchObject({ profileEligible: false, eligible: false });
    expect(hardFailure.rules.seeders).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });

    const unknownSeeders = evaluate(syntheticRelease({ seeders: null }), requiredProfile);
    expect(unknownSeeders.rules.seeders).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });
    expect(unknownSeeders.rules.seeders.warnings).toContainEqual({
      rule: 'seeders',
      code: 'seeders_unavailable',
    });

    const usenet = evaluate(syntheticRelease({ protocol: 'usenet', seeders: 0 }), requiredProfile);
    expect(usenet).toMatchObject({ profileEligible: true, eligible: true });
    expect(usenet.rules.seeders).toMatchObject({ state: 'not_applicable', applicable: false });
  });

  it('distinguishes exact resolution preference from an acceptable higher resolution', () => {
    const exact = evaluate(releaseFromFixture('LESS'));
    expect(exact.rules.resolution.state).toBe('preferred');

    const higher = evaluate(
      syntheticRelease({
        quality: {
          quality: { name: 'Bluray-2160p', source: 'bluray', resolution: 2160 },
        },
      }),
    );
    expect(higher.rules.resolution).toMatchObject({ state: 'acceptable' });

    const requiredProfile = baseProfile();
    ruleOf(requiredProfile, 'resolution').config.requireMinimum = true;
    const belowMinimum = evaluate(
      syntheticRelease({
        quality: {
          quality: { name: 'Bluray-480p', source: 'bluray', resolution: 480 },
        },
      }),
      requiredProfile,
    );
    expect(belowMinimum.rules.resolution).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });

    const unknownResolution = evaluate(syntheticRelease({ quality: null }), requiredProfile);
    expect(unknownResolution).toMatchObject({ profileEligible: false, eligible: false });
    expect(unknownResolution.rules.resolution).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });
    expect(unknownResolution.rules.resolution.warnings).toContainEqual({
      rule: 'resolution',
      code: 'resolution_unavailable',
    });
  });

  it('evaluates source and byte-size preferences without turning them into a ranking', () => {
    expect(evaluate(releaseFromFixture('QTZ')).rules.source.state).toBe('preferred');
    expect(evaluate(releaseFromFixture('YTS')).rules.source.state).toBe('fallback');
    expect(
      evaluate(syntheticRelease({ quality: { quality: { source: 'dvd' } } })).rules.source.state,
    ).toBe('soft_miss');
    expect(evaluate(syntheticRelease({ quality: null })).rules.source).toMatchObject({
      state: 'unknown',
    });

    const softSize = evaluate(releaseFromFixture('QTZ'));
    expect(softSize.rules.size.state).toBe('soft_miss');

    const requiredProfile = baseProfile();
    ruleOf(requiredProfile, 'size').config.requireMaximum = true;
    const hardSize = evaluate(releaseFromFixture('QTZ'), requiredProfile);
    expect(hardSize).toMatchObject({ profileEligible: false, eligible: false });
    expect(hardSize.rules.size).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });

    const unknownSize = evaluate(syntheticRelease({ size: null }), requiredProfile);
    expect(unknownSize).toMatchObject({ profileEligible: false, eligible: false });
    expect(unknownSize.rules.size).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });
    expect(unknownSize.rules.size.warnings).toContainEqual({
      rule: 'size',
      code: 'size_unavailable',
    });
  });

  it('preserves Radarr Custom Format observations without deriving a scorerr score', () => {
    const enabled = evaluate(releaseFromFixture('QTZ'));
    expect(enabled.rules.custom_formats).toMatchObject({ state: 'acceptable' });
    expect(enabled.rules.custom_formats.observed).toEqual({
      customFormats: [],
      radarrReportedValue: 10,
    });

    const disabledProfile = baseProfile();
    ruleOf(disabledProfile, 'custom_formats').config.useRadarrPreferences = false;
    const disabled = evaluate(releaseFromFixture('QTZ'), disabledProfile);
    expect(disabled.rules.custom_formats).toMatchObject({
      state: 'not_applicable',
      observed: { customFormats: [], radarrReportedValue: 10 },
    });
  });

  it('limits indexer preferences to the active Radarr connection and isolates stale references', () => {
    const preferred = evaluate(releaseFromFixture('QTZ'), baseProfile(), {
      radarrConnectionId: 101,
      knownRadarrConnectionIds: [101],
    });
    expect(preferred.rules.indexer.state).toBe('preferred');

    const otherAllowed = evaluate(releaseFromFixture('YTS'));
    expect(otherAllowed).toMatchObject({ profileEligible: true, eligible: true });
    expect(otherAllowed.rules.indexer.state).toBe('soft_miss');

    const otherDeniedProfile = baseProfile();
    ruleOf(otherDeniedProfile, 'indexer').config.allowOthers = false;
    const otherDenied = evaluate(releaseFromFixture('YTS'), otherDeniedProfile);
    expect(otherDenied).toMatchObject({ profileEligible: false, eligible: false });
    expect(otherDenied.rules.indexer).toMatchObject({
      state: 'hard_fail',
      hardConstraintViolation: true,
    });

    const otherConnectionProfile = baseProfile();
    ruleOf(otherConnectionProfile, 'indexer').config.preferredIndexers = [
      { radarrConnectionId: 202, indexerId: 2 },
    ];
    ruleOf(otherConnectionProfile, 'indexer').config.allowOthers = false;
    const notApplicable = evaluate(releaseFromFixture('YTS'), otherConnectionProfile, {
      radarrConnectionId: 101,
      knownRadarrConnectionIds: [101, 202],
    });
    expect(notApplicable).toMatchObject({ profileEligible: true, eligible: true });
    expect(notApplicable.rules.indexer).toMatchObject({ state: 'not_applicable' });

    const staleReferenceProfile = baseProfile();
    ruleOf(staleReferenceProfile, 'indexer').config.preferredIndexers.push({
      radarrConnectionId: 303,
      indexerId: 9,
    });
    const staleReference = evaluate(releaseFromFixture('QTZ'), staleReferenceProfile, {
      radarrConnectionId: 101,
      knownRadarrConnectionIds: [101],
    });
    expect(staleReference.rules.indexer.state).toBe('preferred');
    expect(staleReference.rules.indexer.warnings).toContainEqual({
      rule: 'indexer',
      code: 'stale_radarr_connection_reference',
      details: { radarrConnectionId: 303, indexerId: 9 },
    });

    const staleOnlyProfile = baseProfile();
    ruleOf(staleOnlyProfile, 'indexer').config.preferredIndexers = [
      { radarrConnectionId: 303, indexerId: 9 },
    ];
    ruleOf(staleOnlyProfile, 'indexer').config.allowOthers = false;
    const staleOnly = evaluate(releaseFromFixture('YTS'), staleOnlyProfile, {
      radarrConnectionId: 101,
      knownRadarrConnectionIds: [101],
    });
    expect(staleOnly).toMatchObject({ profileEligible: true, eligible: true });
    expect(staleOnly.rules.indexer).toMatchObject({ state: 'not_applicable' });
    expect(staleOnly.rules.indexer.warnings).toContainEqual({
      rule: 'indexer',
      code: 'stale_radarr_connection_reference',
      details: { radarrConnectionId: 303, indexerId: 9 },
    });
  });

  it('keeps importance semantic only: it changes no eligibility or rule state', () => {
    const lowProfile = baseProfile();
    ruleOf(lowProfile, 'seeders').config.importance = 'low';
    const priorityProfile = baseProfile();
    ruleOf(priorityProfile, 'seeders').config.importance = 'priority';

    const low = evaluate(releaseFromFixture('ZERO'), lowProfile);
    const priority = evaluate(releaseFromFixture('ZERO'), priorityProfile);

    expect(low.rules.seeders).toMatchObject({ importance: 'low', state: 'soft_miss' });
    expect(priority.rules.seeders).toMatchObject({ importance: 'priority', state: 'soft_miss' });
    expect(low.profileEligible).toBe(priority.profileEligible);
    expect(low.eligible).toBe(priority.eligible);
  });

  it('rejects an incomplete profile rather than inventing a missing configuration', () => {
    const profile = baseProfile();
    const incompleteProfile: EvaluationProfile = {
      ...profile,
      rules: profile.rules.slice(0, -1),
    };

    expect(() => evaluate(syntheticRelease(), incompleteProfile)).toThrow(
      'exactly one configuration for every rule',
    );
  });

  it('is deterministic, does not mutate inputs, and makes no external call', () => {
    const input = deepFreeze({
      release: syntheticRelease(),
      profile: baseProfile(),
      movieContext: { originalLanguage: 'fr' },
      radarrConnectionId: 101,
      knownRadarrConnectionIds: [101],
    }) satisfies ReleaseEvaluationInput;
    const before = structuredClone(input);
    const fetch = vi.fn(() => {
      throw new Error('Evaluation must not call fetch.');
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Evaluation must not access time.');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Evaluation must not use randomness.');
    });

    const first = evaluateRelease(input);
    const second = evaluateRelease(input);

    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('has no ranking-like output and does not depend on Phase 3B diagnostic helpers', () => {
    const result = evaluate(syntheticRelease());
    const forbiddenKeys = new Set([
      'score',
      'scorerrScore',
      'finalScore',
      'totalScore',
      'rank',
      'ranking',
      'winner',
      'selected',
      'best',
      'points',
      'coefficient',
    ]);
    const evaluatorSource = readFileSync(
      new URL('../src/evaluation/release-evaluator.ts', import.meta.url),
      'utf8',
    );

    expect(outputKeys(result).some((key) => forbiddenKeys.has(key))).toBe(false);
    expect(evaluatorSource).not.toContain('releaseComparison');
    expect(evaluatorSource).not.toContain('torrentAvailabilitySignal');
    expect(evaluatorSource).not.toMatch(/from ['"][^'"]*(?:database|clients|api|worker|http)/);
  });
});
