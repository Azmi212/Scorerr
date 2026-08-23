import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as releaseComparator from '../src/evaluation/release-comparator.js';
import {
  compareEligibleReleases,
  type PairwiseReleaseComparison,
  type PairwiseReleaseComparisonInput,
  type PairwiseReleaseComparisonResult,
} from '../src/evaluation/release-comparator.js';
import type {
  EvaluationProfile,
  EvaluationState,
  ReleaseEvaluation,
  RuleEvaluation,
  RuleEvaluations,
  RuleImportance,
} from '../src/evaluation/release-evaluator.js';
import type { ReleaseProtocol } from '../src/services/release-normalizer.js';
import type {
  ProfileRuleInput,
  ProfileRuleType,
  StoredProfileRuleInput,
} from '../src/services/profile-service.js';

const gibibyte = 1024 * 1024 * 1024;

const ruleTypes = [
  'language',
  'seeders',
  'resolution',
  'source',
  'size',
  'codec',
  'custom_formats',
  'indexer',
] as const satisfies readonly ProfileRuleType[];

interface RuleOverride {
  state?: EvaluationState;
  observed?: Record<string, unknown>;
  applicable?: boolean;
  hardConstraintViolation?: boolean;
}

interface EvaluationFixture {
  fingerprint: string;
  protocol?: ReleaseProtocol;
  title?: string | null;
  eligible?: boolean;
  rules?: Partial<Record<ProfileRuleType, RuleOverride>>;
}

function baseProfile(): EvaluationProfile {
  const rules: ProfileRuleInput[] = [
    {
      type: 'language',
      position: 0,
      configVersion: 2,
      config: { importance: 'low', preferredLanguages: ['fr', 'en'], fallback: 'original' },
    },
    {
      type: 'seeders',
      position: 1,
      configVersion: 1,
      config: { importance: 'low', desiredMinimum: 3, requireMinimum: false },
    },
    {
      type: 'resolution',
      position: 2,
      configVersion: 1,
      config: {
        importance: 'low',
        preferredHeight: 1080,
        desiredMinimumHeight: 720,
        requireMinimum: false,
      },
    },
    {
      type: 'source',
      position: 3,
      configVersion: 1,
      config: { importance: 'low', preferredSources: ['bluray', 'webdl', 'dvd'] },
    },
    {
      type: 'size',
      position: 4,
      configVersion: 1,
      config: {
        importance: 'low',
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
      config: { importance: 'low', useRadarrPreferences: true },
    },
    {
      type: 'indexer',
      position: 7,
      configVersion: 1,
      config: {
        importance: 'low',
        preferredIndexers: [
          { radarrConnectionId: 101, indexerId: 'first' },
          { radarrConnectionId: 101, indexerId: 'second' },
        ],
        allowOthers: true,
      },
    },
  ];
  return { id: 42, schemaVersion: 1, revision: 7, rules };
}

function legacyLanguageProfile(): EvaluationProfile {
  const profile = baseProfile();
  return {
    ...profile,
    rules: profile.rules.map((rule): StoredProfileRuleInput =>
      rule.type === 'language'
        ? {
            type: 'language',
            position: rule.position,
            configVersion: 1,
            config: {
              preferredLanguages: [...rule.config.preferredLanguages],
              fallback: rule.config.fallback,
            },
          }
        : rule,
    ),
  };
}

function ruleOf<T extends ProfileRuleType>(
  profile: EvaluationProfile,
  type: T,
): Extract<ProfileRuleInput, { type: T }> {
  const rule = profile.rules.find((candidate) => candidate.type === type);
  if (!rule) throw new Error(`Test profile is missing ${type}.`);
  return rule as Extract<ProfileRuleInput, { type: T }>;
}

function setImportance(
  profile: EvaluationProfile,
  type: ProfileRuleType,
  importance: RuleImportance,
): void {
  ruleOf(profile, type).config.importance = importance;
}

function setPosition(profile: EvaluationProfile, type: ProfileRuleType, position: number): void {
  ruleOf(profile, type).position = position;
}

function defaultObserved(type: ProfileRuleType): Record<string, unknown> {
  switch (type) {
    case 'language':
      return { languageCodes: null };
    case 'seeders':
      return { protocol: 'torrent', seeders: null };
    case 'resolution':
      return { height: null };
    case 'source':
      return { source: null };
    case 'size':
      return { sizeBytes: null };
    case 'codec':
      return { codec: null };
    case 'custom_formats':
      return { radarrReportedValue: null };
    case 'indexer':
      return { radarrConnectionId: 101, indexerId: null };
  }
}

function ruleEvaluation(rule: ProfileRuleInput): RuleEvaluation {
  return {
    rule: rule.type,
    configVersion: rule.configVersion,
    applicable: true,
    importance: rule.config.importance,
    observed: defaultObserved(rule.type),
    expected: rule.config,
    state: 'unknown',
    hardConstraintViolation: false,
    explanation: { code: 'test_fixture' },
    warnings: [],
  };
}

function initialRuleEvaluations(profile: EvaluationProfile): RuleEvaluations {
  return {
    language: ruleEvaluation(ruleOf(profile, 'language')),
    seeders: ruleEvaluation(ruleOf(profile, 'seeders')),
    resolution: ruleEvaluation(ruleOf(profile, 'resolution')),
    source: ruleEvaluation(ruleOf(profile, 'source')),
    size: ruleEvaluation(ruleOf(profile, 'size')),
    codec: ruleEvaluation(ruleOf(profile, 'codec')),
    custom_formats: ruleEvaluation(ruleOf(profile, 'custom_formats')),
    indexer: ruleEvaluation(ruleOf(profile, 'indexer')),
  };
}

function evaluation(profile: EvaluationProfile, fixture: EvaluationFixture): ReleaseEvaluation {
  const rules = initialRuleEvaluations(profile);
  for (const type of ruleTypes) {
    const override = fixture.rules?.[type];
    if (!override) continue;
    const current = rules[type];
    if (override.state !== undefined) current.state = override.state;
    if (override.observed !== undefined) current.observed = override.observed;
    if (override.applicable !== undefined) current.applicable = override.applicable;
    if (override.hardConstraintViolation !== undefined)
      current.hardConstraintViolation = override.hardConstraintViolation;
  }
  const eligible = fixture.eligible ?? true;
  return {
    profileId: profile.id,
    profileSchemaVersion: profile.schemaVersion,
    profileRevision: profile.revision,
    release: {
      fingerprint: fixture.fingerprint,
      title: fixture.title ?? null,
      protocol: fixture.protocol ?? 'torrent',
    },
    radarrEligibility: {
      eligible,
      approved: eligible,
      rejected: false,
      reasons: [],
      rejections: null,
    },
    profileEligible: eligible,
    eligible,
    rules,
    warnings: [],
  };
}

function compare(
  profile: EvaluationProfile,
  a: ReleaseEvaluation,
  b: ReleaseEvaluation,
): PairwiseReleaseComparisonResult {
  return compareEligibleReleases({ profile, radarrConnectionId: 101, a, b });
}

function comparison(result: PairwiseReleaseComparisonResult): PairwiseReleaseComparison {
  if (!result.ok) throw new Error(`Comparison failed: ${result.error.code}`);
  return result.comparison;
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

describe('Phase 4 pairwise ordinal release comparison', () => {
  it('requires an explicit Language V2 upgrade without mutating a legacy profile', () => {
    const currentProfile = baseProfile();
    const input = deepFreeze({
      profile: legacyLanguageProfile(),
      radarrConnectionId: 101,
      a: evaluation(currentProfile, { fingerprint: 'a' }),
      b: evaluation(currentProfile, { fingerprint: 'b' }),
    }) satisfies PairwiseReleaseComparisonInput;
    const before = structuredClone(input);

    const result = compareEligibleReleases(input);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'profile_upgrade_required',
        details: { rule: 'language', foundConfigVersion: 1, requiredConfigVersion: 2 },
      },
    });
    expect(input).toEqual(before);
  });

  it('returns a structured error for a malformed in-memory rule configuration', () => {
    const profile = baseProfile();
    const a = evaluation(profile, { fingerprint: 'a' });
    const b = evaluation(profile, { fingerprint: 'b' });
    const malformed = structuredClone(profile);
    const language = malformed.rules.find((rule) => rule.type === 'language');
    if (!language) throw new Error('Test profile is missing Language.');
    (language.config as unknown as { preferredLanguages: unknown }).preferredLanguages = null;
    const before = structuredClone(malformed);

    expect(() => compare(malformed, a, b)).not.toThrow();
    expect(compare(malformed, a, b)).toMatchObject({
      ok: false,
      error: { code: 'unsupported_rule_configuration', details: { rule: 'language' } },
    });
    expect(malformed).toEqual(before);
  });

  it('stops on Seeders before Resolution when they share the first tier', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    setImportance(profile, 'resolution', 'priority');
    setPosition(profile, 'seeders', 1);
    setPosition(profile, 'resolution', 2);
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        seeders: { state: 'soft_miss', observed: { seeders: 10 } },
        resolution: { state: 'preferred', observed: { height: 2160 } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        seeders: { state: 'preferred', observed: { seeders: 150 } },
        resolution: { state: 'acceptable', observed: { height: 1080 } },
      },
    });

    const forward = comparison(compare(profile, a, b));
    const reverse = comparison(compare(profile, b, a));

    expect(forward).toMatchObject({
      winner: 'B',
      basis: 'user_preference',
      decidingRule: 'seeders',
      decidingTier: 'priority',
      decidingReason: 'state',
    });
    expect(reverse).toMatchObject({
      winner: 'A',
      basis: 'user_preference',
      decidingRule: 'seeders',
      decidingTier: 'priority',
      decidingReason: 'state',
    });
  });

  it('uses the user position to inspect Resolution before Seeders in the same tier', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    setImportance(profile, 'resolution', 'priority');
    setPosition(profile, 'resolution', 1);
    setPosition(profile, 'seeders', 2);
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        seeders: { state: 'soft_miss', observed: { seeders: 10 } },
        resolution: { state: 'preferred', observed: { height: 2160 } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        seeders: { state: 'preferred', observed: { seeders: 150 } },
        resolution: { state: 'acceptable', observed: { height: 1080 } },
      },
    });

    expect(comparison(compare(profile, a, b))).toMatchObject({
      winner: 'A',
      decidingRule: 'resolution',
      decidingTier: 'priority',
      decidingReason: 'state',
    });
  });

  it('uses raw Torrent seeders as the only secondary Seeders tiebreak', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    const compareSeeders = (aSeeders: number, bSeeders: number) =>
      comparison(
        compare(
          profile,
          evaluation(profile, {
            fingerprint: 'a',
            rules: { seeders: { state: 'preferred', observed: { seeders: aSeeders } } },
          }),
          evaluation(profile, {
            fingerprint: 'b',
            rules: { seeders: { state: 'preferred', observed: { seeders: bSeeders } } },
          }),
        ),
      );

    expect(compareSeeders(101, 100)).toMatchObject({
      winner: 'A',
      decidingRule: 'seeders',
      decidingReason: 'secondary_tiebreak',
      explanation: { details: { aSeeders: 101, bSeeders: 100 } },
    });
    expect(compareSeeders(150, 10)).toMatchObject({
      winner: 'A',
      decidingRule: 'seeders',
      decidingReason: 'secondary_tiebreak',
      explanation: { details: { aSeeders: 150, bSeeders: 10 } },
    });
  });

  it('continues after an equal state with no secondary tiebreak', () => {
    const profile = baseProfile();
    setImportance(profile, 'resolution', 'priority');
    setImportance(profile, 'source', 'priority');
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        resolution: { state: 'preferred', observed: { height: 1080 } },
        source: { state: 'fallback', observed: { source: 'webdl' } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        resolution: { state: 'preferred', observed: { height: 1080 } },
        source: { state: 'preferred', observed: { source: 'bluray' } },
      },
    });

    expect(comparison(compare(profile, a, b))).toMatchObject({
      winner: 'B',
      decidingRule: 'source',
      decidingReason: 'state',
    });
  });

  it('skips Seeders when one release is Usenet instead of penalizing it', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    setImportance(profile, 'source', 'priority');
    setPosition(profile, 'seeders', 1);
    const a = evaluation(profile, {
      fingerprint: 'a',
      protocol: 'torrent',
      rules: {
        seeders: { state: 'preferred', observed: { seeders: 100 } },
        source: { state: 'preferred', observed: { source: 'bluray' } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      protocol: 'usenet',
      rules: {
        seeders: { state: 'not_applicable', applicable: false, observed: { seeders: null } },
        source: { state: 'soft_miss', observed: { source: 'other' } },
      },
    });

    expect(comparison(compare(profile, a, b))).toMatchObject({
      winner: 'A',
      decidingRule: 'source',
      decidingReason: 'state',
    });
  });

  it('uses language preference order, including the most favorable structured MULTi language', () => {
    const profile = baseProfile();
    setImportance(profile, 'language', 'priority');
    const regular = comparison(
      compare(
        profile,
        evaluation(profile, {
          fingerprint: 'a',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['en'] } } },
        }),
        evaluation(profile, {
          fingerprint: 'b',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['fr'] } } },
        }),
      ),
    );
    const multi = comparison(
      compare(
        profile,
        evaluation(profile, {
          fingerprint: 'a',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['en', 'fr'] } } },
        }),
        evaluation(profile, {
          fingerprint: 'b',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['en'] } } },
        }),
      ),
    );

    expect(regular).toMatchObject({ winner: 'B', decidingRule: 'language' });
    expect(regular.explanation.details).toMatchObject({ aPreferenceIndex: 1, bPreferenceIndex: 0 });
    expect(multi).toMatchObject({ winner: 'A', decidingRule: 'language' });
    expect(multi.explanation.details).toMatchObject({ aPreferenceIndex: 0, bPreferenceIndex: 1 });
  });

  it('uses ordered structured Source, Codec, Size, and active-Radarr Indexer data', () => {
    const sourceProfile = baseProfile();
    setImportance(sourceProfile, 'source', 'priority');
    const source = comparison(
      compare(
        sourceProfile,
        evaluation(sourceProfile, {
          fingerprint: 'a',
          rules: { source: { state: 'fallback', observed: { source: 'webdl' } } },
        }),
        evaluation(sourceProfile, {
          fingerprint: 'b',
          rules: { source: { state: 'fallback', observed: { source: 'dvd' } } },
        }),
      ),
    );

    const codecProfile = baseProfile();
    setImportance(codecProfile, 'codec', 'priority');
    const codec = comparison(
      compare(
        codecProfile,
        evaluation(codecProfile, {
          fingerprint: 'a',
          title: 'Title says AVC but structured codec is HEVC',
          rules: { codec: { state: 'preferred', observed: { codec: 'hevc' } } },
        }),
        evaluation(codecProfile, {
          fingerprint: 'b',
          title: 'Title says HEVC but structured codec is AVC',
          rules: { codec: { state: 'preferred', observed: { codec: 'avc' } } },
        }),
      ),
    );

    const sizeProfile = baseProfile();
    setImportance(sizeProfile, 'size', 'priority');
    const size = comparison(
      compare(
        sizeProfile,
        evaluation(sizeProfile, {
          fingerprint: 'a',
          rules: { size: { state: 'preferred', observed: { sizeBytes: 4 * gibibyte } } },
        }),
        evaluation(sizeProfile, {
          fingerprint: 'b',
          rules: { size: { state: 'preferred', observed: { sizeBytes: 5 * gibibyte } } },
        }),
      ),
    );

    const indexerProfile = baseProfile();
    setImportance(indexerProfile, 'indexer', 'priority');
    ruleOf(indexerProfile, 'indexer').config.preferredIndexers = [
      { radarrConnectionId: 202, indexerId: 'other-instance' },
      { radarrConnectionId: 101, indexerId: 'second' },
      { radarrConnectionId: 101, indexerId: 'first' },
    ];
    const indexer = comparison(
      compare(
        indexerProfile,
        evaluation(indexerProfile, {
          fingerprint: 'a',
          rules: {
            indexer: {
              state: 'preferred',
              observed: { radarrConnectionId: 101, indexerId: 'first' },
            },
          },
        }),
        evaluation(indexerProfile, {
          fingerprint: 'b',
          rules: {
            indexer: {
              state: 'preferred',
              observed: { radarrConnectionId: 101, indexerId: 'second' },
            },
          },
        }),
      ),
    );

    expect(source).toMatchObject({ winner: 'A', decidingRule: 'source' });
    expect(codec).toMatchObject({ winner: 'A', decidingRule: 'codec' });
    expect(size).toMatchObject({ winner: 'A', decidingRule: 'size' });
    expect(indexer).toMatchObject({ winner: 'B', decidingRule: 'indexer' });
  });

  it('does not create secondary preferences for Resolution or Custom Formats', () => {
    const resolutionProfile = baseProfile();
    setImportance(resolutionProfile, 'resolution', 'priority');
    const preferredResolutionBeatsHigherAcceptable = comparison(
      compare(
        resolutionProfile,
        evaluation(resolutionProfile, {
          fingerprint: 'a',
          rules: { resolution: { state: 'preferred', observed: { height: 1080 } } },
        }),
        evaluation(resolutionProfile, {
          fingerprint: 'b',
          rules: { resolution: { state: 'acceptable', observed: { height: 2160 } } },
        }),
      ),
    );
    const equalPreferredResolution = comparison(
      compare(
        resolutionProfile,
        evaluation(resolutionProfile, {
          fingerprint: 'a',
          rules: { resolution: { state: 'preferred', observed: { height: 1080 } } },
        }),
        evaluation(resolutionProfile, {
          fingerprint: 'b',
          rules: { resolution: { state: 'preferred', observed: { height: 1080 } } },
        }),
      ),
    );
    const equalAcceptableResolution = comparison(
      compare(
        resolutionProfile,
        evaluation(resolutionProfile, {
          fingerprint: 'a',
          rules: { resolution: { state: 'acceptable', observed: { height: 2160 } } },
        }),
        evaluation(resolutionProfile, {
          fingerprint: 'b',
          rules: { resolution: { state: 'acceptable', observed: { height: 720 } } },
        }),
      ),
    );

    const customFormatsProfile = baseProfile();
    setImportance(customFormatsProfile, 'custom_formats', 'priority');
    const equalCustomFormats = comparison(
      compare(
        customFormatsProfile,
        evaluation(customFormatsProfile, {
          fingerprint: 'a',
          rules: {
            custom_formats: {
              state: 'acceptable',
              observed: { radarrReportedValue: 1 },
            },
          },
        }),
        evaluation(customFormatsProfile, {
          fingerprint: 'b',
          rules: {
            custom_formats: {
              state: 'acceptable',
              observed: { radarrReportedValue: 999 },
            },
          },
        }),
      ),
    );

    expect(preferredResolutionBeatsHigherAcceptable).toMatchObject({
      winner: 'A',
      decidingRule: 'resolution',
      decidingReason: 'state',
    });
    for (const result of [
      equalPreferredResolution,
      equalAcceptableResolution,
      equalCustomFormats,
    ]) {
      expect(result).toMatchObject({
        winner: 'A',
        basis: 'technical_tiebreak',
        decidingRule: null,
        decidingReason: null,
      });
    }
  });

  it('keeps unknown equal and lets soft_miss beat unknown', () => {
    const profile = baseProfile();
    setImportance(profile, 'source', 'priority');
    setImportance(profile, 'size', 'priority');
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        source: { state: 'unknown', observed: { source: null } },
        size: { state: 'soft_miss', observed: { sizeBytes: 11 * gibibyte } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        source: { state: 'unknown', observed: { source: null } },
        size: { state: 'unknown', observed: { sizeBytes: null } },
      },
    });

    expect(comparison(compare(profile, a, b))).toMatchObject({
      winner: 'A',
      decidingRule: 'size',
      decidingReason: 'state',
    });
  });

  it('always lets a higher importance tier decide before lower-tier rules', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'low');
    setImportance(profile, 'source', 'priority');
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        seeders: { state: 'preferred', observed: { seeders: 100 } },
        source: { state: 'soft_miss', observed: { source: 'other' } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        seeders: { state: 'soft_miss', observed: { seeders: 1 } },
        source: { state: 'preferred', observed: { source: 'bluray' } },
      },
    });

    expect(comparison(compare(profile, a, b))).toMatchObject({
      winner: 'B',
      decidingRule: 'source',
      decidingTier: 'priority',
    });
  });

  it('uses fingerprints only as a deterministic technical tiebreak and preserves true equivalence', () => {
    const profile = baseProfile();
    const input = deepFreeze({
      profile,
      radarrConnectionId: 101,
      a: evaluation(profile, { fingerprint: 'a' }),
      b: evaluation(profile, { fingerprint: 'b' }),
    }) satisfies PairwiseReleaseComparisonInput;
    const before = structuredClone(input);
    const fetch = vi.fn(() => {
      throw new Error('Comparison must not call fetch.');
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Comparison must not access time.');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Comparison must not use randomness.');
    });

    const first = compareEligibleReleases(input);
    const second = compareEligibleReleases(input);
    const reverse = compareEligibleReleases({ ...input, a: input.b, b: input.a });
    const equivalent = compareEligibleReleases({
      ...input,
      b: evaluation(profile, { fingerprint: 'a' }),
    });

    expect(first).toEqual(second);
    expect(comparison(first)).toMatchObject({
      winner: 'A',
      basis: 'technical_tiebreak',
      decidingRule: null,
      decidingTier: null,
      decidingReason: null,
    });
    expect(comparison(reverse)).toMatchObject({ winner: 'B', basis: 'technical_tiebreak' });
    expect(comparison(equivalent)).toMatchObject({
      winner: null,
      basis: 'equivalent',
      decidingRule: null,
    });
    expect(input).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses incompatible eligibility, profile provenance, revision, and Radarr context', () => {
    const profile = baseProfile();
    const a = evaluation(profile, { fingerprint: 'a' });
    const b = evaluation(profile, { fingerprint: 'b' });
    const ineligibleB = structuredClone(b);
    ineligibleB.eligible = false;
    const wrongProfileA = structuredClone(a);
    wrongProfileA.profileId += 1;
    const wrongRevisionB = structuredClone(b);
    wrongRevisionB.profileRevision += 1;
    const wrongRadarrB = structuredClone(b);
    wrongRadarrB.rules.indexer.observed.radarrConnectionId = 202;
    const missingRadarrA = structuredClone(a);
    delete missingRadarrA.rules.indexer.observed.radarrConnectionId;

    expect(compare(profile, a, ineligibleB)).toMatchObject({
      ok: false,
      error: {
        code: 'release_not_eligible',
        details: { aEligible: true, bEligible: false },
      },
    });
    expect(compare(profile, wrongProfileA, b)).toMatchObject({
      ok: false,
      error: { code: 'evaluation_profile_mismatch' },
    });
    expect(compare(profile, a, wrongRevisionB)).toMatchObject({
      ok: false,
      error: { code: 'evaluation_profile_mismatch' },
    });
    expect(compare(profile, a, wrongRadarrB)).toMatchObject({
      ok: false,
      error: {
        code: 'evaluation_context_mismatch',
        details: {
          expectedRadarrConnectionId: 101,
          aRadarrConnectionId: 101,
          bRadarrConnectionId: 202,
        },
      },
    });
    expect(compare(profile, missingRadarrA, b)).toMatchObject({
      ok: false,
      error: { code: 'evaluation_context_mismatch' },
    });
  });

  it('refuses non-eligible releases and never imports Phase 3B diagnostics', () => {
    const profile = baseProfile();
    const invalid = compare(
      profile,
      evaluation(profile, { fingerprint: 'a', eligible: false }),
      evaluation(profile, { fingerprint: 'b' }),
    );
    const comparatorSource = readFileSync(
      new URL('../src/evaluation/release-comparator.ts', import.meta.url),
      'utf8',
    );

    expect(invalid).toMatchObject({ ok: false, error: { code: 'release_not_eligible' } });
    const validOutput = comparison(
      compare(
        profile,
        evaluation(profile, { fingerprint: 'a' }),
        evaluation(profile, { fingerprint: 'b' }),
      ),
    );
    const forbiddenOutputKeys = new Set([
      'score',
      'finalScore',
      'totalScore',
      'rank',
      'ranking',
      'points',
      'weight',
      'total',
      'percentage',
      'coefficient',
    ]);
    expect(outputKeys(validOutput).some((key) => forbiddenOutputKeys.has(key))).toBe(false);
    expect(comparatorSource).not.toContain('releaseComparison');
    expect(comparatorSource).not.toContain('torrentAvailabilitySignal');
    expect(comparatorSource).not.toContain('availabilitySignalRaw');
    expect(comparatorSource).not.toMatch(/score/i);
    expect(comparatorSource).not.toMatch(/prowlarr/i);
    expect(comparatorSource).not.toContain('.sort(');
    expect(comparatorSource).not.toMatch(/from ['"][^'"]*(?:database|clients|api|worker|http)/);
    expect(Object.keys(releaseComparator)).toEqual(['compareEligibleReleases']);
  });
});
