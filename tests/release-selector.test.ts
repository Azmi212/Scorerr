import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareEligibleReleases } from '../src/evaluation/release-comparator.js';
import type {
  EvaluationProfile,
  EvaluationState,
  ReleaseEvaluation,
  RuleEvaluation,
  RuleEvaluations,
  RuleImportance,
} from '../src/evaluation/release-evaluator.js';
import {
  selectCandidates,
  type CandidateReference,
  type CandidateSelectionResult,
} from '../src/evaluation/release-selector.js';
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
              fallback: 'original',
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

function select(
  profile: EvaluationProfile,
  candidates: readonly ReleaseEvaluation[],
): CandidateSelectionResult {
  return selectCandidates({ profile, radarrConnectionId: 101, candidates });
}

function successful(
  result: CandidateSelectionResult,
): Extract<CandidateSelectionResult, { ok: true }> {
  if (!result.ok) throw new Error(`Selection failed: ${result.error.code}`);
  return result;
}

function fingerprints(references: readonly CandidateReference[]): string[] {
  return references.map((reference) => reference.fingerprint);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  const result: T[][] = [];
  for (const [index, value] of values.entries()) {
    const remaining = values.filter((_, candidateIndex) => candidateIndex !== index);
    for (const suffix of permutations(remaining)) result.push([value, ...suffix]);
  }
  return result;
}

function selectedFingerprintForPair(
  a: ReleaseEvaluation,
  b: ReleaseEvaluation,
  result: ReturnType<typeof compareEligibleReleases>,
): string | null {
  if (!result.ok) throw new Error(`Comparison failed: ${result.error.code}`);
  return result.comparison.winner === 'A'
    ? a.release.fingerprint
    : result.comparison.winner === 'B'
      ? b.release.fingerprint
      : null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Phase 4B collection survivor selection', () => {
  it('rejects an empty collection with no_candidates', () => {
    expect(select(baseProfile(), [])).toMatchObject({
      ok: false,
      error: { code: 'no_candidates' },
    });
  });

  it('selects one valid input as sole_candidate without an invented rule', () => {
    const profile = baseProfile();
    const result = successful(select(profile, [evaluation(profile, { fingerprint: 'only' })]));

    expect(result.selection).toMatchObject({
      winner: { fingerprint: 'only' },
      basis: 'sole_candidate',
      decidingRule: null,
      decidingTier: null,
      decidingReason: null,
    });
    expect(result.steps).toEqual([]);
  });

  it('refuses the complete collection before reduction when any precondition is incompatible', () => {
    const profile = baseProfile();
    const valid = evaluation(profile, { fingerprint: 'valid' });
    const ineligible = evaluation(profile, { fingerprint: 'ineligible', eligible: false });
    const wrongId = structuredClone(valid);
    wrongId.release.fingerprint = 'wrong-id';
    wrongId.profileId += 1;
    const wrongRevision = structuredClone(valid);
    wrongRevision.release.fingerprint = 'wrong-revision';
    wrongRevision.profileRevision += 1;
    const wrongSchema = structuredClone(valid);
    wrongSchema.release.fingerprint = 'wrong-schema';
    wrongSchema.profileSchemaVersion += 1;
    const wrongContext = structuredClone(valid);
    wrongContext.release.fingerprint = 'wrong-context';
    wrongContext.rules.indexer.observed.radarrConnectionId = 202;

    expect(select(profile, [valid, ineligible])).toMatchObject({
      ok: false,
      error: { code: 'release_not_eligible' },
    });
    for (const mismatch of [wrongId, wrongRevision, wrongSchema]) {
      expect(select(profile, [valid, mismatch])).toMatchObject({
        ok: false,
        error: { code: 'evaluation_profile_mismatch' },
      });
    }
    expect(select(profile, [valid, wrongContext])).toMatchObject({
      ok: false,
      error: { code: 'evaluation_context_mismatch' },
    });
    expect(select(legacyLanguageProfile(), [valid])).toMatchObject({
      ok: false,
      error: { code: 'profile_upgrade_required' },
    });
  });

  it('applies priority before high and profile position within a tier', () => {
    const tierProfile = baseProfile();
    setImportance(tierProfile, 'resolution', 'priority');
    setImportance(tierProfile, 'source', 'high');
    const a = evaluation(tierProfile, {
      fingerprint: 'a',
      rules: {
        resolution: { state: 'acceptable', observed: { height: 720 } },
        source: { state: 'preferred', observed: { source: 'bluray' } },
      },
    });
    const b = evaluation(tierProfile, {
      fingerprint: 'b',
      rules: {
        resolution: { state: 'preferred', observed: { height: 1080 } },
        source: { state: 'soft_miss', observed: { source: 'other' } },
      },
    });
    expect(successful(select(tierProfile, [a, b])).selection).toMatchObject({
      winner: { fingerprint: 'b' },
      decidingRule: 'resolution',
      decidingTier: 'priority',
    });

    const positionProfile = baseProfile();
    setImportance(positionProfile, 'source', 'priority');
    setImportance(positionProfile, 'size', 'priority');
    setPosition(positionProfile, 'source', 4);
    setPosition(positionProfile, 'size', 3);
    const first = evaluation(positionProfile, {
      fingerprint: 'a',
      rules: {
        source: { state: 'preferred', observed: { source: 'bluray' } },
        size: { state: 'soft_miss', observed: { sizeBytes: 11 * gibibyte } },
      },
    });
    const second = evaluation(positionProfile, {
      fingerprint: 'b',
      rules: {
        source: { state: 'soft_miss', observed: { source: 'other' } },
        size: { state: 'preferred', observed: { sizeBytes: 5 * gibibyte } },
      },
    });
    expect(successful(select(positionProfile, [first, second])).selection).toMatchObject({
      winner: { fingerprint: 'b' },
      decidingRule: 'size',
      decidingTier: 'priority',
    });
  });

  it('implements the central Torrent and Usenet survivor example with an explanatory trace', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    setImportance(profile, 'resolution', 'priority');
    setImportance(profile, 'source', 'high');
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        seeders: { state: 'preferred', observed: { seeders: 150 } },
        resolution: { state: 'acceptable', observed: { height: 1080 } },
        source: { state: 'preferred', observed: { source: 'webdl' } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        seeders: { state: 'preferred', observed: { seeders: 20 } },
        resolution: { state: 'preferred', observed: { height: 2160 } },
        source: { state: 'preferred', observed: { source: 'bluray' } },
      },
    });
    const c = evaluation(profile, {
      fingerprint: 'c',
      rules: {
        seeders: { state: 'soft_miss', observed: { seeders: 2 } },
        resolution: { state: 'preferred', observed: { height: 2160 } },
        source: { state: 'preferred', observed: { source: 'bluray' } },
      },
    });
    const d = evaluation(profile, {
      fingerprint: 'd',
      protocol: 'usenet',
      rules: {
        seeders: { state: 'not_applicable', applicable: false, observed: { seeders: null } },
        resolution: { state: 'preferred', observed: { height: 2160 } },
        source: { state: 'preferred', observed: { source: 'webdl' } },
      },
    });

    const result = successful(select(profile, [d, b, a, c]));

    expect(result.selection).toMatchObject({
      winner: { fingerprint: 'd' },
      basis: 'user_preference',
      decidingRule: 'resolution',
      decidingTier: 'priority',
      decidingReason: 'state',
    });
    expect(result.steps.map((step) => step.rule)).toEqual(['seeders', 'resolution']);
    expect(result.steps[0]).toMatchObject({
      rule: 'seeders',
      bestState: 'preferred',
      secondaryTiebreak: { type: 'seeders', direction: 'higher', preferredValue: 150 },
    });
    const seedersStep = result.steps[0];
    const resolutionStep = result.steps[1];
    if (!seedersStep || !resolutionStep) throw new Error('Central trace is incomplete.');
    expect(seedersStep.eliminated).toMatchObject([
      { candidate: { fingerprint: 'b' }, reason: 'secondary_tiebreak' },
      { candidate: { fingerprint: 'c' }, reason: 'lower_state' },
    ]);
    expect(fingerprints(seedersStep.survivors)).toEqual(['a', 'd']);
    expect(resolutionStep.eliminated).toMatchObject([
      { candidate: { fingerprint: 'a' }, reason: 'lower_state' },
    ]);
  });

  it('uses exact raw Seeders secondary comparisons without nonlinear thresholds', () => {
    for (const [higher, lower] of [
      [101, 100],
      [150, 10],
    ] as const) {
      const profile = baseProfile();
      setImportance(profile, 'seeders', 'priority');
      const result = successful(
        select(profile, [
          evaluation(profile, {
            fingerprint: 'higher',
            rules: { seeders: { state: 'preferred', observed: { seeders: higher } } },
          }),
          evaluation(profile, {
            fingerprint: 'lower',
            rules: { seeders: { state: 'preferred', observed: { seeders: lower } } },
          }),
        ]),
      );
      expect(result.selection).toMatchObject({
        winner: { fingerprint: 'higher' },
        decidingRule: 'seeders',
        decidingReason: 'secondary_tiebreak',
      });
    }
  });

  it('keeps not_applicable candidates and does not eliminate a sole applicable soft_miss', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    const torrent = evaluation(profile, {
      fingerprint: 'torrent',
      rules: { seeders: { state: 'soft_miss', observed: { seeders: 1 } } },
    });
    const usenetA = evaluation(profile, {
      fingerprint: 'usenet-a',
      protocol: 'usenet',
      rules: { seeders: { state: 'not_applicable', applicable: false } },
    });
    const usenetB = evaluation(profile, {
      fingerprint: 'usenet-b',
      protocol: 'usenet',
      rules: { seeders: { state: 'not_applicable', applicable: false } },
    });

    const result = successful(select(profile, [usenetB, torrent, usenetA]));
    const seeders = result.steps.find((step) => step.rule === 'seeders');

    expect(seeders).toMatchObject({
      bestState: 'soft_miss',
      secondaryTiebreak: null,
      eliminated: [],
    });
    if (!seeders) throw new Error('Seeders trace is missing.');
    expect(fingerprints(seeders.survivors)).toEqual(['torrent', 'usenet-a', 'usenet-b']);
    expect(result.selection.basis).toBe('technical_tiebreak');
  });

  it('uses ordered Language preferences including the best structured MULTi index', () => {
    const profile = baseProfile();
    setImportance(profile, 'language', 'priority');
    const regular = successful(
      select(profile, [
        evaluation(profile, {
          fingerprint: 'en',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['en'] } } },
        }),
        evaluation(profile, {
          fingerprint: 'fr',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['fr'] } } },
        }),
      ]),
    );
    const multi = successful(
      select(profile, [
        evaluation(profile, {
          fingerprint: 'multi',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['en', 'fr'] } } },
        }),
        evaluation(profile, {
          fingerprint: 'en',
          rules: { language: { state: 'preferred', observed: { languageCodes: ['en'] } } },
        }),
      ]),
    );

    expect(regular.selection.winner?.fingerprint).toBe('fr');
    expect(multi.selection.winner?.fingerprint).toBe('multi');
  });

  it('applies shared Source, Codec, Size, and active-Radarr Indexer secondaries', () => {
    const cases: {
      rule: 'source' | 'codec' | 'size' | 'indexer';
      aObserved: Record<string, unknown>;
      bObserved: Record<string, unknown>;
    }[] = [
      { rule: 'source', aObserved: { source: 'bluray' }, bObserved: { source: 'webdl' } },
      { rule: 'codec', aObserved: { codec: 'hevc' }, bObserved: { codec: 'avc' } },
      {
        rule: 'size',
        aObserved: { sizeBytes: 4 * gibibyte },
        bObserved: { sizeBytes: 5 * gibibyte },
      },
      {
        rule: 'indexer',
        aObserved: { radarrConnectionId: 101, indexerId: 'first' },
        bObserved: { radarrConnectionId: 101, indexerId: 'second' },
      },
    ];

    for (const testCase of cases) {
      const profile = baseProfile();
      setImportance(profile, testCase.rule, 'priority');
      const result = successful(
        select(profile, [
          evaluation(profile, {
            fingerprint: 'a',
            rules: {
              [testCase.rule]: { state: 'preferred', observed: testCase.aObserved },
            },
          }),
          evaluation(profile, {
            fingerprint: 'b',
            rules: {
              [testCase.rule]: { state: 'preferred', observed: testCase.bObserved },
            },
          }),
        ]),
      );
      expect(result.selection).toMatchObject({
        winner: { fingerprint: 'a' },
        decidingRule: testCase.rule,
        decidingReason: 'secondary_tiebreak',
      });
    }
  });

  it('has no Resolution or Custom Formats secondary reduction', () => {
    for (const testCase of [
      {
        rule: 'resolution' as const,
        aObserved: { height: 2160 },
        bObserved: { height: 720 },
      },
      {
        rule: 'custom_formats' as const,
        aObserved: { radarrReportedValue: 999 },
        bObserved: { radarrReportedValue: 1 },
      },
    ]) {
      const profile = baseProfile();
      setImportance(profile, testCase.rule, 'priority');
      const result = successful(
        select(profile, [
          evaluation(profile, {
            fingerprint: 'a',
            rules: {
              [testCase.rule]: { state: 'acceptable', observed: testCase.aObserved },
            },
          }),
          evaluation(profile, {
            fingerprint: 'b',
            rules: {
              [testCase.rule]: { state: 'acceptable', observed: testCase.bObserved },
            },
          }),
        ]),
      );
      const step = result.steps.find((candidate) => candidate.rule === testCase.rule);
      expect(step).toMatchObject({ secondaryTiebreak: null, eliminated: [] });
      expect(result.selection).toMatchObject({
        winner: { fingerprint: 'a' },
        basis: 'technical_tiebreak',
      });
    }
  });

  it('lets soft_miss eliminate unknown only when candidates are comparable', () => {
    const profile = baseProfile();
    setImportance(profile, 'size', 'priority');
    const result = successful(
      select(profile, [
        evaluation(profile, {
          fingerprint: 'soft',
          rules: { size: { state: 'soft_miss', observed: { sizeBytes: 11 * gibibyte } } },
        }),
        evaluation(profile, {
          fingerprint: 'unknown',
          rules: { size: { state: 'unknown', observed: { sizeBytes: null } } },
        }),
      ]),
    );
    expect(result.selection).toMatchObject({
      winner: { fingerprint: 'soft' },
      basis: 'user_preference',
      decidingRule: 'size',
    });

    const allUnknown = successful(
      select(profile, [
        evaluation(profile, {
          fingerprint: 'b',
          rules: { size: { state: 'unknown', observed: { sizeBytes: null } } },
        }),
        evaluation(profile, {
          fingerprint: 'a',
          rules: { size: { state: 'unknown', observed: { sizeBytes: null } } },
        }),
      ]),
    );
    expect(allUnknown.steps.find((step) => step.rule === 'size')).toMatchObject({
      bestState: 'unknown',
      eliminated: [],
      secondaryTiebreak: null,
    });
    expect(allUnknown.selection.basis).toBe('technical_tiebreak');
  });

  it('uses the minimal fingerprint only after all rules and preserves duplicate minima', () => {
    const profile = baseProfile();
    const technical = successful(
      select(profile, [
        evaluation(profile, { fingerprint: 'ccc' }),
        evaluation(profile, { fingerprint: 'aaa' }),
        evaluation(profile, { fingerprint: 'bbb' }),
      ]),
    );
    expect(technical.selection).toMatchObject({
      winner: { fingerprint: 'aaa' },
      basis: 'technical_tiebreak',
      decidingRule: null,
    });

    const equivalent = successful(
      select(profile, [
        evaluation(profile, { fingerprint: 'aaa', title: 'same' }),
        evaluation(profile, { fingerprint: 'bbb' }),
        evaluation(profile, { fingerprint: 'aaa', title: 'same' }),
      ]),
    );
    expect(equivalent.selection).toMatchObject({
      winner: null,
      basis: 'equivalent',
      decidingRule: null,
    });
    expect(fingerprints(equivalent.selection.finalists)).toEqual(['aaa', 'aaa']);
  });

  it('never claims a rule winner when no candidate was eliminated', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    const result = successful(
      select(profile, [
        evaluation(profile, {
          fingerprint: 'a',
          rules: { seeders: { state: 'preferred', observed: { seeders: 100 } } },
        }),
        evaluation(profile, {
          fingerprint: 'b',
          protocol: 'usenet',
          rules: { seeders: { state: 'not_applicable', applicable: false } },
        }),
      ]),
    );
    expect(result.steps[0]).toMatchObject({
      rule: 'seeders',
      eliminated: [],
      secondaryTiebreak: null,
    });
    expect(result.selection.basis).toBe('technical_tiebreak');
  });

  it('keeps a missing secondary observation incomparable and lets the next rule decide', () => {
    const profile = baseProfile();
    setImportance(profile, 'source', 'priority');
    setImportance(profile, 'codec', 'high');
    const a = evaluation(profile, {
      fingerprint: 'a',
      rules: {
        source: { state: 'preferred', observed: { source: 'bluray' } },
        codec: { state: 'fallback', observed: { codec: 'avc' } },
      },
    });
    const b = evaluation(profile, {
      fingerprint: 'b',
      rules: {
        source: { state: 'preferred', observed: { source: null } },
        codec: { state: 'preferred', observed: { codec: 'hevc' } },
      },
    });

    const collection = successful(select(profile, [a, b]));
    const pairwise = compareEligibleReleases({ profile, radarrConnectionId: 101, a, b });
    const sourceStep = collection.steps.find((step) => step.rule === 'source');

    expect(sourceStep).toMatchObject({
      bestState: 'preferred',
      secondaryTiebreak: null,
      eliminated: [],
    });
    if (!sourceStep) throw new Error('Source trace is missing.');
    expect(fingerprints(sourceStep.survivors)).toEqual(['a', 'b']);
    expect(collection.selection).toMatchObject({
      winner: { fingerprint: 'b' },
      basis: 'user_preference',
      decidingRule: 'codec',
      decidingReason: 'state',
    });
    expect(pairwise).toMatchObject({
      ok: true,
      comparison: {
        winner: 'B',
        basis: 'user_preference',
        decidingRule: 'codec',
        decidingReason: 'state',
      },
    });
    expect(a.rules.source.state).toBe('preferred');
    expect(b.rules.source.state).toBe('preferred');
  });

  it('stays functionally coherent with the Phase 4 pairwise comparator for two candidates', () => {
    const scenarios: {
      profile: EvaluationProfile;
      a: ReleaseEvaluation;
      b: ReleaseEvaluation;
    }[] = [];

    const stateProfile = baseProfile();
    setImportance(stateProfile, 'source', 'priority');
    scenarios.push({
      profile: stateProfile,
      a: evaluation(stateProfile, {
        fingerprint: 'a',
        rules: { source: { state: 'preferred', observed: { source: 'bluray' } } },
      }),
      b: evaluation(stateProfile, {
        fingerprint: 'b',
        rules: { source: { state: 'soft_miss', observed: { source: 'other' } } },
      }),
    });

    const seedersProfile = baseProfile();
    setImportance(seedersProfile, 'seeders', 'priority');
    scenarios.push({
      profile: seedersProfile,
      a: evaluation(seedersProfile, {
        fingerprint: 'a',
        rules: { seeders: { state: 'preferred', observed: { seeders: 100 } } },
      }),
      b: evaluation(seedersProfile, {
        fingerprint: 'b',
        rules: { seeders: { state: 'preferred', observed: { seeders: 10 } } },
      }),
    });

    const notApplicableProfile = baseProfile();
    setImportance(notApplicableProfile, 'seeders', 'priority');
    scenarios.push({
      profile: notApplicableProfile,
      a: evaluation(notApplicableProfile, {
        fingerprint: 'a',
        rules: { seeders: { state: 'preferred', observed: { seeders: 100 } } },
      }),
      b: evaluation(notApplicableProfile, {
        fingerprint: 'b',
        protocol: 'usenet',
        rules: { seeders: { state: 'not_applicable', applicable: false } },
      }),
    });

    const technicalProfile = baseProfile();
    scenarios.push({
      profile: technicalProfile,
      a: evaluation(technicalProfile, { fingerprint: 'a' }),
      b: evaluation(technicalProfile, { fingerprint: 'b' }),
    });
    scenarios.push({
      profile: technicalProfile,
      a: evaluation(technicalProfile, { fingerprint: 'same' }),
      b: evaluation(technicalProfile, { fingerprint: 'same' }),
    });

    for (const { profile, a, b } of scenarios) {
      const pairwise = compareEligibleReleases({ profile, radarrConnectionId: 101, a, b });
      const collection = successful(select(profile, [a, b]));
      expect(collection.selection.winner?.fingerprint ?? null).toBe(
        selectedFingerprintForPair(a, b, pairwise),
      );
      if (!pairwise.ok) throw new Error(`Comparison failed: ${pairwise.error.code}`);
      expect(collection.selection.basis).toBe(pairwise.comparison.basis);
      expect(collection.selection.decidingRule).toBe(pairwise.comparison.decidingRule);
      expect(collection.selection.decidingReason).toBe(pairwise.comparison.decidingReason);
    }
  });

  it('is invariant across every permutation of a small collection', () => {
    const profile = baseProfile();
    setImportance(profile, 'seeders', 'priority');
    setImportance(profile, 'source', 'high');
    const candidates = [
      evaluation(profile, {
        fingerprint: 'a',
        rules: {
          seeders: { state: 'preferred', observed: { seeders: 100 } },
          source: { state: 'fallback', observed: { source: 'webdl' } },
        },
      }),
      evaluation(profile, {
        fingerprint: 'b',
        rules: {
          seeders: { state: 'preferred', observed: { seeders: 20 } },
          source: { state: 'preferred', observed: { source: 'bluray' } },
        },
      }),
      evaluation(profile, {
        fingerprint: 'c',
        protocol: 'usenet',
        rules: {
          seeders: { state: 'not_applicable', applicable: false },
          source: { state: 'soft_miss', observed: { source: 'other' } },
        },
      }),
    ];
    const results = permutations(candidates).map((candidateOrder) =>
      successful(select(profile, candidateOrder)),
    );

    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  });

  it('is deterministic, immutable, pure, and exposes no collection-ordering API', () => {
    const profile = baseProfile();
    const input = deepFreeze({
      profile,
      radarrConnectionId: 101,
      candidates: [
        evaluation(profile, { fingerprint: 'b' }),
        evaluation(profile, { fingerprint: 'a' }),
      ],
    });
    const before = structuredClone(input);
    const fetch = vi.fn(() => {
      throw new Error('Selection must not call fetch.');
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Selection must not access time.');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Selection must not use randomness.');
    });

    expect(selectCandidates(input)).toEqual(selectCandidates(input));
    expect(input).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();

    const selectorSource = readFileSync(
      new URL('../src/evaluation/release-selector.ts', import.meta.url),
      'utf8',
    );
    const policySource = readFileSync(
      new URL('../src/evaluation/release-ordinal-policy.ts', import.meta.url),
      'utf8',
    );
    expect(selectorSource).not.toContain('compareEligibleReleases');
    expect(selectorSource).not.toContain('.sort(');
    expect(selectorSource).not.toMatch(/from ['"][^'"]*(?:database|clients|api|worker|http)/);
    for (const source of [selectorSource, policySource]) {
      expect(source).not.toMatch(/from ['"][^'"]*(?:database|clients|api|worker|http)/);
      for (const forbidden of [
        'score',
        'points',
        'weight',
        'rank',
        'percentage',
        'totalScore',
        'positionInRanking',
      ]) {
        expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });
});
