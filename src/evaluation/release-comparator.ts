import type {
  EvaluationProfile,
  EvaluationState,
  ReleaseEvaluation,
  RuleEvaluation,
  RuleImportance,
} from './release-evaluator.js';
import type { ProfileRuleType, StoredProfileRuleInput } from '../services/profile-service.js';

export type ComparisonSide = 'A' | 'B';

export type PairwiseReleaseComparisonBasis =
  'user_preference' | 'technical_tiebreak' | 'equivalent';

export interface PairwiseReleaseComparisonExplanation {
  code:
    | 'rule_state_preference'
    | 'rule_secondary_tiebreak'
    | 'technical_fingerprint_tiebreak'
    | 'functionally_equivalent';
  details?: Record<string, unknown>;
}

export interface PairwiseReleaseComparison {
  winner: ComparisonSide | null;
  basis: PairwiseReleaseComparisonBasis;
  decidingRule: ProfileRuleType | null;
  decidingTier: RuleImportance | null;
  decidingReason: 'state' | 'secondary_tiebreak' | null;
  explanation: PairwiseReleaseComparisonExplanation;
}

export type PairwiseReleaseComparisonErrorCode =
  | 'profile_upgrade_required'
  | 'profile_rule_set_invalid'
  | 'unsupported_rule_configuration'
  | 'evaluation_profile_mismatch'
  | 'evaluation_context_mismatch'
  | 'release_not_eligible'
  | 'release_evaluation_invalid';

export interface PairwiseReleaseComparisonError {
  code: PairwiseReleaseComparisonErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type PairwiseReleaseComparisonResult =
  | { ok: true; comparison: PairwiseReleaseComparison }
  | { ok: false; error: PairwiseReleaseComparisonError };

type PairwiseReleaseComparisonFailure = Extract<PairwiseReleaseComparisonResult, { ok: false }>;

export interface PairwiseReleaseComparisonInput {
  profile: EvaluationProfile;
  radarrConnectionId: number;
  a: ReleaseEvaluation;
  b: ReleaseEvaluation;
}

const comparableRuleTypes = [
  'language',
  'seeders',
  'resolution',
  'source',
  'size',
  'codec',
  'custom_formats',
  'indexer',
] as const satisfies readonly ProfileRuleType[];

const importanceTiers: readonly RuleImportance[] = ['priority', 'high', 'medium', 'low'];

const semanticStates: readonly Exclude<EvaluationState, 'hard_fail' | 'not_applicable'>[] = [
  'preferred',
  'fallback',
  'acceptable',
  'soft_miss',
  'unknown',
];

type CurrentLanguageRule = Extract<StoredProfileRuleInput, { type: 'language'; configVersion: 2 }>;

type ComparableProfileRule =
  CurrentLanguageRule | Exclude<StoredProfileRuleInput, { type: 'language' }>;

interface PreparedProfile {
  rules: readonly ComparableProfileRule[];
}

interface SecondaryDecision {
  winner: ComparisonSide;
  details: Record<string, unknown>;
}

type ComparableRuleEvaluation = RuleEvaluation & {
  state: Exclude<EvaluationState, 'hard_fail'>;
};

function comparisonExplanation(
  code: PairwiseReleaseComparisonExplanation['code'],
  details?: Record<string, unknown>,
): PairwiseReleaseComparisonExplanation {
  return details === undefined ? { code } : { code, details };
}

function failure(
  code: PairwiseReleaseComparisonErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PairwiseReleaseComparisonFailure {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

function isRuleImportance(value: unknown): value is RuleImportance {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'priority';
}

type UnknownRecord = Record<string, unknown>;

interface RuleRecord {
  type: ProfileRuleType;
  position: number;
  configVersion: number;
  config: unknown;
}

const languageCodePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function objectRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): UnknownRecord | null {
  const record = objectRecord(value);
  if (record === null) return null;
  const foundKeys = Object.keys(record);
  if (
    foundKeys.length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    return null;
  }
  return record;
}

function isProfileRuleType(value: unknown): value is ProfileRuleType {
  return comparableRuleTypes.includes(value as ProfileRuleType);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLanguageCodeArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && languageCodePattern.test(entry))
  );
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isIndexerReference(value: unknown): boolean {
  const reference = hasExactKeys(value, ['radarrConnectionId', 'indexerId']);
  return (
    reference !== null &&
    isPositiveInteger(reference.radarrConnectionId) &&
    (isNonnegativeInteger(reference.indexerId) || isNonEmptyString(reference.indexerId))
  );
}

function isRuleRecord(value: unknown): value is RuleRecord {
  const rule = hasExactKeys(value, ['type', 'position', 'configVersion', 'config']);
  return (
    rule !== null &&
    isProfileRuleType(rule.type) &&
    isNonnegativeInteger(rule.position) &&
    isNonnegativeInteger(rule.configVersion)
  );
}

function isCurrentLanguageRule(rule: RuleRecord): rule is CurrentLanguageRule {
  const config = hasExactKeys(rule.config, ['importance', 'preferredLanguages', 'fallback']);
  return (
    rule.type === 'language' &&
    rule.configVersion === 2 &&
    config !== null &&
    isRuleImportance(config.importance) &&
    isLanguageCodeArray(config.preferredLanguages) &&
    config.fallback === 'original'
  );
}

function isSupportedNonLanguageRule(rule: RuleRecord): boolean {
  if (rule.type === 'language' || rule.configVersion !== 1) return false;

  switch (rule.type) {
    case 'seeders': {
      const config = hasExactKeys(rule.config, ['importance', 'desiredMinimum', 'requireMinimum']);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        isNonnegativeInteger(config.desiredMinimum) &&
        typeof config.requireMinimum === 'boolean'
      );
    }
    case 'resolution': {
      const config = hasExactKeys(rule.config, [
        'importance',
        'preferredHeight',
        'desiredMinimumHeight',
        'requireMinimum',
      ]);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        isPositiveInteger(config.preferredHeight) &&
        isPositiveInteger(config.desiredMinimumHeight) &&
        typeof config.requireMinimum === 'boolean'
      );
    }
    case 'source': {
      const config = hasExactKeys(rule.config, ['importance', 'preferredSources']);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        isNonEmptyStringArray(config.preferredSources)
      );
    }
    case 'size': {
      const config = hasExactKeys(rule.config, [
        'importance',
        'desiredMaximumBytes',
        'requireMaximum',
      ]);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        isNonnegativeInteger(config.desiredMaximumBytes) &&
        typeof config.requireMaximum === 'boolean'
      );
    }
    case 'codec': {
      const config = hasExactKeys(rule.config, ['importance', 'preferredCodecs']);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        isNonEmptyStringArray(config.preferredCodecs)
      );
    }
    case 'custom_formats': {
      const config = hasExactKeys(rule.config, ['importance', 'useRadarrPreferences']);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        typeof config.useRadarrPreferences === 'boolean'
      );
    }
    case 'indexer': {
      const config = hasExactKeys(rule.config, ['importance', 'preferredIndexers', 'allowOthers']);
      return (
        config !== null &&
        isRuleImportance(config.importance) &&
        Array.isArray(config.preferredIndexers) &&
        config.preferredIndexers.every(isIndexerReference) &&
        typeof config.allowOthers === 'boolean'
      );
    }
  }
}

function prepareProfile(profile: unknown): PreparedProfile | PairwiseReleaseComparisonFailure {
  const profileRecord = objectRecord(profile);
  if (profileRecord === null) {
    return failure(
      'profile_rule_set_invalid',
      'Profile must be an object with a rule configuration.',
    );
  }
  if (profileRecord.schemaVersion !== 1) {
    return failure('unsupported_rule_configuration', 'Profile schema version is not supported.', {
      foundSchemaVersion: profileRecord.schemaVersion,
      requiredSchemaVersion: 1,
    });
  }
  if (!Array.isArray(profileRecord.rules)) {
    return failure('profile_rule_set_invalid', 'Profile rules must be an array.');
  }
  const rules: RuleRecord[] = [];
  for (const rawRule of profileRecord.rules) {
    if (!isRuleRecord(rawRule)) {
      return failure('profile_rule_set_invalid', 'Profile contains an invalid rule record.');
    }
    rules.push(rawRule);
  }
  const types = new Set<ProfileRuleType>();
  const positions = new Set<number>();
  for (const rule of rules) {
    if (types.has(rule.type)) {
      return failure(
        'profile_rule_set_invalid',
        'Profile rules must have unique valid types and positions.',
      );
    }
    if (positions.has(rule.position)) {
      return failure(
        'profile_rule_set_invalid',
        'Profile rules must have unique valid types and positions.',
      );
    }
    types.add(rule.type);
    positions.add(rule.position);
  }
  if (
    rules.length !== comparableRuleTypes.length ||
    comparableRuleTypes.some((type) => !types.has(type))
  ) {
    return failure(
      'profile_rule_set_invalid',
      'Profile must contain exactly one configuration per rule.',
    );
  }

  const language = rules.find((rule) => rule.type === 'language');
  if (!language) {
    return failure('profile_rule_set_invalid', 'Profile is missing its Language rule.');
  }
  if (language.configVersion === 1) {
    return failure(
      'profile_upgrade_required',
      'Language V2 with an explicit importance is required before this profile can be compared.',
      {
        rule: 'language',
        foundConfigVersion: language.configVersion,
        requiredConfigVersion: 2,
      },
    );
  }
  if (language.configVersion !== 2 || !isCurrentLanguageRule(language)) {
    return failure(
      'unsupported_rule_configuration',
      'The language rule configuration is not supported.',
      { rule: 'language', foundConfigVersion: language.configVersion, requiredConfigVersion: 2 },
    );
  }

  for (const rule of rules) {
    if (rule.type === 'language') continue;
    if (!isSupportedNonLanguageRule(rule)) {
      return failure(
        'unsupported_rule_configuration',
        `The ${rule.type} rule configuration is not supported.`,
        { rule: rule.type, foundConfigVersion: rule.configVersion, requiredConfigVersion: 1 },
      );
    }
  }
  return { rules: rules as unknown as readonly ComparableProfileRule[] };
}

function isFailure(
  value: PreparedProfile | PairwiseReleaseComparisonFailure,
): value is PairwiseReleaseComparisonFailure {
  return 'error' in value;
}

function importanceOf(rule: ComparableProfileRule): RuleImportance {
  return rule.config.importance;
}

function rulesInPositionOrder(
  rules: readonly ComparableProfileRule[],
  tier: RuleImportance,
): ComparableProfileRule[] {
  const remaining = rules.filter((rule) => importanceOf(rule) === tier);
  const ordered: ComparableProfileRule[] = [];
  while (remaining.length > 0) {
    let next: ComparableProfileRule | undefined;
    for (const candidate of remaining) {
      if (next === undefined || candidate.position < next.position) next = candidate;
    }
    if (next === undefined) throw new Error('Rule position ordering invariant violated.');
    ordered.push(next);
    const nextIndex = remaining.indexOf(next);
    remaining.splice(nextIndex, 1);
  }
  return ordered;
}

function isSemanticState(value: EvaluationState): value is (typeof semanticStates)[number] {
  return semanticStates.includes(value as (typeof semanticStates)[number]);
}

function semanticStateDecision(
  a: Exclude<EvaluationState, 'hard_fail' | 'not_applicable'>,
  b: Exclude<EvaluationState, 'hard_fail' | 'not_applicable'>,
): ComparisonSide | null {
  for (const state of semanticStates) {
    if (a === state && b !== state) return 'A';
    if (b === state && a !== state) return 'B';
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function lowerText(value: string): string {
  return value.trim().toLowerCase();
}

function lowerLanguageCode(value: string): string {
  return value.trim().replaceAll('_', '-').toLowerCase();
}

function decisionForHigher(a: number | null, b: number | null): ComparisonSide | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? 'A' : 'B';
}

function decisionForLower(a: number | null, b: number | null): ComparisonSide | null {
  if (a === null || b === null || a === b) return null;
  return a < b ? 'A' : 'B';
}

function preferredLanguageIndex(
  rule: CurrentLanguageRule,
  evaluation: RuleEvaluation,
): number | null {
  const languageCodes = evaluation.observed.languageCodes;
  if (!Array.isArray(languageCodes)) return null;
  const normalizedCodes = languageCodes
    .filter((value): value is string => typeof value === 'string')
    .map(lowerLanguageCode);
  for (const [index, language] of rule.config.preferredLanguages.entries()) {
    if (normalizedCodes.includes(lowerLanguageCode(language))) return index;
  }
  return null;
}

function preferenceIndex(values: readonly string[], observed: unknown): number | null {
  const observedValue = stringValue(observed);
  if (observedValue === null) return null;
  const normalizedObserved = lowerText(observedValue);
  const index = values.findIndex((value) => lowerText(value) === normalizedObserved);
  return index >= 0 ? index : null;
}

function indexerPreferenceIndex(
  rule: Extract<ComparableProfileRule, { type: 'indexer' }>,
  evaluation: RuleEvaluation,
  radarrConnectionId: number,
): number | null {
  const indexerId = evaluation.observed.indexerId;
  if (typeof indexerId !== 'string' && typeof indexerId !== 'number') return null;
  const activePreferences = rule.config.preferredIndexers.filter(
    (preference) => preference.radarrConnectionId === radarrConnectionId,
  );
  const index = activePreferences.findIndex((preference) => preference.indexerId === indexerId);
  return index >= 0 ? index : null;
}

function secondaryDecision(
  rule: ComparableProfileRule,
  a: RuleEvaluation,
  b: RuleEvaluation,
  aRelease: ReleaseEvaluation,
  bRelease: ReleaseEvaluation,
  radarrConnectionId: number,
): SecondaryDecision | null {
  if (rule.type === 'seeders') {
    if (aRelease.release.protocol !== 'torrent' || bRelease.release.protocol !== 'torrent')
      return null;
    const aSeeders = finiteNumber(a.observed.seeders);
    const bSeeders = finiteNumber(b.observed.seeders);
    const winner = decisionForHigher(aSeeders, bSeeders);
    return winner === null ? null : { winner, details: { aSeeders, bSeeders } };
  }
  if (rule.type === 'language') {
    const aPreferenceIndex = preferredLanguageIndex(rule, a);
    const bPreferenceIndex = preferredLanguageIndex(rule, b);
    const winner = decisionForLower(aPreferenceIndex, bPreferenceIndex);
    return winner === null ? null : { winner, details: { aPreferenceIndex, bPreferenceIndex } };
  }
  if (rule.type === 'source') {
    const aPreferenceIndex = preferenceIndex(rule.config.preferredSources, a.observed.source);
    const bPreferenceIndex = preferenceIndex(rule.config.preferredSources, b.observed.source);
    const winner = decisionForLower(aPreferenceIndex, bPreferenceIndex);
    return winner === null ? null : { winner, details: { aPreferenceIndex, bPreferenceIndex } };
  }
  if (rule.type === 'codec') {
    const aPreferenceIndex = preferenceIndex(rule.config.preferredCodecs, a.observed.codec);
    const bPreferenceIndex = preferenceIndex(rule.config.preferredCodecs, b.observed.codec);
    const winner = decisionForLower(aPreferenceIndex, bPreferenceIndex);
    return winner === null ? null : { winner, details: { aPreferenceIndex, bPreferenceIndex } };
  }
  if (rule.type === 'size') {
    const aSizeBytes = finiteNumber(a.observed.sizeBytes);
    const bSizeBytes = finiteNumber(b.observed.sizeBytes);
    const winner = decisionForLower(aSizeBytes, bSizeBytes);
    return winner === null ? null : { winner, details: { aSizeBytes, bSizeBytes } };
  }
  if (rule.type === 'indexer') {
    const aPreferenceIndex = indexerPreferenceIndex(rule, a, radarrConnectionId);
    const bPreferenceIndex = indexerPreferenceIndex(rule, b, radarrConnectionId);
    const winner = decisionForLower(aPreferenceIndex, bPreferenceIndex);
    return winner === null ? null : { winner, details: { aPreferenceIndex, bPreferenceIndex } };
  }
  return null;
}

function evaluationMatchesProfile(
  evaluation: ReleaseEvaluation,
  profile: EvaluationProfile,
): boolean {
  return (
    evaluation.profileId === profile.id &&
    evaluation.profileSchemaVersion === profile.schemaVersion &&
    evaluation.profileRevision === profile.revision
  );
}

function indexerContextMatches(evaluation: ReleaseEvaluation, radarrConnectionId: number): boolean {
  const observedConnectionId = evaluation.rules.indexer.observed.radarrConnectionId;
  return observedConnectionId === radarrConnectionId;
}

function validEvaluationRule(
  evaluation: ReleaseEvaluation,
  rule: ComparableProfileRule,
): ComparableRuleEvaluation | PairwiseReleaseComparisonFailure {
  const ruleEvaluation = evaluation.rules[rule.type];
  if (ruleEvaluation.rule !== rule.type) {
    return failure('release_evaluation_invalid', 'Release evaluation is missing a rule result.', {
      rule: rule.type,
    });
  }
  if (ruleEvaluation.state === 'hard_fail') {
    return failure(
      'release_not_eligible',
      'Eligible releases cannot contain a hard constraint failure.',
      {
        rule: rule.type,
      },
    );
  }
  if (ruleEvaluation.state !== 'not_applicable' && !isSemanticState(ruleEvaluation.state)) {
    return failure(
      'release_evaluation_invalid',
      'Release evaluation contains an unsupported rule state.',
      {
        rule: rule.type,
        state: ruleEvaluation.state,
      },
    );
  }
  return ruleEvaluation as ComparableRuleEvaluation;
}

function isComparisonFailure(
  value: ComparableRuleEvaluation | PairwiseReleaseComparisonFailure,
): value is PairwiseReleaseComparisonFailure {
  return 'error' in value;
}

function userPreferenceResult(
  winner: ComparisonSide,
  rule: ComparableProfileRule,
  reason: 'state' | 'secondary_tiebreak',
  details: Record<string, unknown>,
): PairwiseReleaseComparisonResult {
  return {
    ok: true,
    comparison: {
      winner,
      basis: 'user_preference',
      decidingRule: rule.type,
      decidingTier: importanceOf(rule),
      decidingReason: reason,
      explanation: comparisonExplanation(
        reason === 'state' ? 'rule_state_preference' : 'rule_secondary_tiebreak',
        details,
      ),
    },
  };
}

/**
 * Pure Phase 4 pairwise ordinal comparison for two Phase 3 eligible releases.
 *
 * This deliberately does not provide an ordering for a collection: a rule can
 * be not applicable for one release of a pair, which makes pairwise results
 * unsuitable for a general list ordering.
 */
export function compareEligibleReleases(
  input: PairwiseReleaseComparisonInput,
): PairwiseReleaseComparisonResult {
  const preparedProfile = prepareProfile(input.profile);
  if (isFailure(preparedProfile)) return preparedProfile;
  if (!input.a.eligible || !input.b.eligible) {
    return failure('release_not_eligible', 'Only Phase 3 eligible releases can be compared.', {
      aEligible: input.a.eligible,
      bEligible: input.b.eligible,
    });
  }
  if (
    !evaluationMatchesProfile(input.a, input.profile) ||
    !evaluationMatchesProfile(input.b, input.profile)
  ) {
    return failure(
      'evaluation_profile_mismatch',
      'Release evaluations must belong to the supplied profile revision.',
      {
        expected: {
          profileId: input.profile.id,
          profileSchemaVersion: input.profile.schemaVersion,
          profileRevision: input.profile.revision,
        },
        a: {
          profileId: input.a.profileId,
          profileSchemaVersion: input.a.profileSchemaVersion,
          profileRevision: input.a.profileRevision,
        },
        b: {
          profileId: input.b.profileId,
          profileSchemaVersion: input.b.profileSchemaVersion,
          profileRevision: input.b.profileRevision,
        },
      },
    );
  }
  if (
    !indexerContextMatches(input.a, input.radarrConnectionId) ||
    !indexerContextMatches(input.b, input.radarrConnectionId)
  ) {
    return failure(
      'evaluation_context_mismatch',
      'Release evaluations must use the supplied active Radarr connection.',
      {
        expectedRadarrConnectionId: input.radarrConnectionId,
        aRadarrConnectionId: input.a.rules.indexer.observed.radarrConnectionId,
        bRadarrConnectionId: input.b.rules.indexer.observed.radarrConnectionId,
      },
    );
  }

  for (const tier of importanceTiers) {
    for (const rule of rulesInPositionOrder(preparedProfile.rules, tier)) {
      const a = validEvaluationRule(input.a, rule);
      if (isComparisonFailure(a)) return a;
      const b = validEvaluationRule(input.b, rule);
      if (isComparisonFailure(b)) return b;
      if (a.state === 'not_applicable' || b.state === 'not_applicable') continue;

      const stateWinner = semanticStateDecision(a.state, b.state);
      if (stateWinner !== null) {
        return userPreferenceResult(stateWinner, rule, 'state', {
          aState: a.state,
          bState: b.state,
        });
      }
      const secondary = secondaryDecision(rule, a, b, input.a, input.b, input.radarrConnectionId);
      if (secondary !== null)
        return userPreferenceResult(
          secondary.winner,
          rule,
          'secondary_tiebreak',
          secondary.details,
        );
    }
  }

  if (input.a.release.fingerprint < input.b.release.fingerprint) {
    return {
      ok: true,
      comparison: {
        winner: 'A',
        basis: 'technical_tiebreak',
        decidingRule: null,
        decidingTier: null,
        decidingReason: null,
        explanation: comparisonExplanation('technical_fingerprint_tiebreak', {
          aFingerprint: input.a.release.fingerprint,
          bFingerprint: input.b.release.fingerprint,
        }),
      },
    };
  }
  if (input.b.release.fingerprint < input.a.release.fingerprint) {
    return {
      ok: true,
      comparison: {
        winner: 'B',
        basis: 'technical_tiebreak',
        decidingRule: null,
        decidingTier: null,
        decidingReason: null,
        explanation: comparisonExplanation('technical_fingerprint_tiebreak', {
          aFingerprint: input.a.release.fingerprint,
          bFingerprint: input.b.release.fingerprint,
        }),
      },
    };
  }
  return {
    ok: true,
    comparison: {
      winner: null,
      basis: 'equivalent',
      decidingRule: null,
      decidingTier: null,
      decidingReason: null,
      explanation: comparisonExplanation('functionally_equivalent'),
    },
  };
}
