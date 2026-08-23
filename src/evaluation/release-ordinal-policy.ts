import type {
  EvaluationProfile,
  EvaluationState,
  ReleaseEvaluation,
  RuleEvaluation,
  RuleImportance,
} from './release-evaluator.js';
import type { ProfileRuleType, StoredProfileRuleInput } from '../services/profile-service.js';

export type OrdinalPolicyErrorCode =
  | 'profile_upgrade_required'
  | 'profile_rule_set_invalid'
  | 'unsupported_rule_configuration'
  | 'evaluation_profile_mismatch'
  | 'evaluation_context_mismatch'
  | 'release_not_eligible'
  | 'release_evaluation_invalid';

export interface OrdinalPolicyError {
  code: OrdinalPolicyErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface OrdinalPolicyFailure {
  ok: false;
  error: OrdinalPolicyError;
}

export type CurrentLanguageRule = Extract<
  StoredProfileRuleInput,
  { type: 'language'; configVersion: 2 }
>;

export type ComparableProfileRule =
  CurrentLanguageRule | Exclude<StoredProfileRuleInput, { type: 'language' }>;

export interface PreparedOrdinalProfile {
  rules: readonly ComparableProfileRule[];
}

export type ComparableEvaluationState = Exclude<EvaluationState, 'hard_fail' | 'not_applicable'>;

export type ComparableRuleEvaluation = RuleEvaluation & {
  state: Exclude<EvaluationState, 'hard_fail'>;
};

export interface RuleSecondaryObservation {
  type: 'seeders' | 'language' | 'source' | 'codec' | 'size' | 'indexer';
  direction: 'higher' | 'lower';
  value: number;
  detailKey: 'Seeders' | 'PreferenceIndex' | 'SizeBytes';
}

export type OrdinalRulePairDecision =
  | { kind: 'incomparable' | 'equal' }
  | {
      kind: 'winner';
      winner: 'A' | 'B';
      reason: 'state' | 'secondary_tiebreak';
      details: Record<string, unknown>;
    };

export const ordinalImportanceTiers: readonly RuleImportance[] = [
  'priority',
  'high',
  'medium',
  'low',
];

export const ordinalSemanticStates: readonly ComparableEvaluationState[] = [
  'preferred',
  'fallback',
  'acceptable',
  'soft_miss',
  'unknown',
];

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

type UnknownRecord = Record<string, unknown>;

interface RuleRecord {
  type: ProfileRuleType;
  position: number;
  configVersion: number;
  config: unknown;
}

const languageCodePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function failure(
  code: OrdinalPolicyErrorCode,
  message: string,
  details?: Record<string, unknown>,
): OrdinalPolicyFailure {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

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

function isRuleImportance(value: unknown): value is RuleImportance {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'priority';
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

export function prepareOrdinalProfile(
  profile: unknown,
): { ok: true; profile: PreparedOrdinalProfile } | OrdinalPolicyFailure {
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
    if (types.has(rule.type) || positions.has(rule.position)) {
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
      { rule: 'language', foundConfigVersion: 1, requiredConfigVersion: 2 },
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
  return {
    ok: true,
    profile: { rules: rules as unknown as readonly ComparableProfileRule[] },
  };
}

export function importanceOf(rule: ComparableProfileRule): RuleImportance {
  return rule.config.importance;
}

export function rulesInPositionOrder(
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

export function isSemanticState(value: EvaluationState): value is ComparableEvaluationState {
  return ordinalSemanticStates.includes(value as ComparableEvaluationState);
}

export function bestSemanticState(
  evaluations: readonly ComparableRuleEvaluation[],
): ComparableEvaluationState | null {
  for (const state of ordinalSemanticStates) {
    if (evaluations.some((evaluation) => evaluation.state === state)) return state;
  }
  return null;
}

function semanticStateDecision(
  a: ComparableEvaluationState,
  b: ComparableEvaluationState,
): 'A' | 'B' | null {
  for (const state of ordinalSemanticStates) {
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

export function secondaryObservation(
  rule: ComparableProfileRule,
  evaluation: RuleEvaluation,
  releaseEvaluation: ReleaseEvaluation,
  radarrConnectionId: number,
): RuleSecondaryObservation | null {
  if (rule.type === 'seeders') {
    if (releaseEvaluation.release.protocol !== 'torrent') return null;
    const value = finiteNumber(evaluation.observed.seeders);
    return value === null
      ? null
      : { type: 'seeders', direction: 'higher', value, detailKey: 'Seeders' };
  }
  if (rule.type === 'language') {
    const value = preferredLanguageIndex(rule, evaluation);
    return value === null
      ? null
      : { type: 'language', direction: 'lower', value, detailKey: 'PreferenceIndex' };
  }
  if (rule.type === 'source') {
    const value = preferenceIndex(rule.config.preferredSources, evaluation.observed.source);
    return value === null
      ? null
      : { type: 'source', direction: 'lower', value, detailKey: 'PreferenceIndex' };
  }
  if (rule.type === 'codec') {
    const value = preferenceIndex(rule.config.preferredCodecs, evaluation.observed.codec);
    return value === null
      ? null
      : { type: 'codec', direction: 'lower', value, detailKey: 'PreferenceIndex' };
  }
  if (rule.type === 'size') {
    const value = finiteNumber(evaluation.observed.sizeBytes);
    return value === null
      ? null
      : { type: 'size', direction: 'lower', value, detailKey: 'SizeBytes' };
  }
  if (rule.type === 'indexer') {
    const value = indexerPreferenceIndex(rule, evaluation, radarrConnectionId);
    return value === null
      ? null
      : { type: 'indexer', direction: 'lower', value, detailKey: 'PreferenceIndex' };
  }
  return null;
}

export function compareOrdinalRule(
  rule: ComparableProfileRule,
  a: ComparableRuleEvaluation,
  b: ComparableRuleEvaluation,
  aRelease: ReleaseEvaluation,
  bRelease: ReleaseEvaluation,
  radarrConnectionId: number,
): OrdinalRulePairDecision {
  if (a.state === 'not_applicable' || b.state === 'not_applicable') {
    return { kind: 'incomparable' };
  }
  const stateWinner = semanticStateDecision(a.state, b.state);
  if (stateWinner !== null) {
    return {
      kind: 'winner',
      winner: stateWinner,
      reason: 'state',
      details: { aState: a.state, bState: b.state },
    };
  }

  const aSecondary = secondaryObservation(rule, a, aRelease, radarrConnectionId);
  const bSecondary = secondaryObservation(rule, b, bRelease, radarrConnectionId);
  if (aSecondary === null || bSecondary === null) return { kind: 'equal' };
  if (
    aSecondary.type !== bSecondary.type ||
    aSecondary.direction !== bSecondary.direction ||
    aSecondary.value === bSecondary.value
  ) {
    return { kind: 'equal' };
  }
  const winner =
    aSecondary.direction === 'higher'
      ? aSecondary.value > bSecondary.value
        ? 'A'
        : 'B'
      : aSecondary.value < bSecondary.value
        ? 'A'
        : 'B';
  return {
    kind: 'winner',
    winner,
    reason: 'secondary_tiebreak',
    details: {
      [`a${aSecondary.detailKey}`]: aSecondary.value,
      [`b${bSecondary.detailKey}`]: bSecondary.value,
    },
  };
}

export function evaluationMatchesProfile(
  evaluation: ReleaseEvaluation,
  profile: EvaluationProfile,
): boolean {
  return (
    evaluation.profileId === profile.id &&
    evaluation.profileSchemaVersion === profile.schemaVersion &&
    evaluation.profileRevision === profile.revision
  );
}

export function evaluationMatchesRadarrContext(
  evaluation: ReleaseEvaluation,
  radarrConnectionId: number,
): boolean {
  return evaluation.rules.indexer.observed.radarrConnectionId === radarrConnectionId;
}

export function validEvaluationRule(
  evaluation: ReleaseEvaluation,
  rule: ComparableProfileRule,
): ComparableRuleEvaluation | OrdinalPolicyFailure {
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
      { rule: rule.type },
    );
  }
  if (ruleEvaluation.state !== 'not_applicable' && !isSemanticState(ruleEvaluation.state)) {
    return failure(
      'release_evaluation_invalid',
      'Release evaluation contains an unsupported rule state.',
      { rule: rule.type, state: ruleEvaluation.state },
    );
  }
  return ruleEvaluation as ComparableRuleEvaluation;
}

export function isOrdinalFailure(
  value: ComparableRuleEvaluation | OrdinalPolicyFailure,
): value is OrdinalPolicyFailure {
  return 'error' in value;
}
