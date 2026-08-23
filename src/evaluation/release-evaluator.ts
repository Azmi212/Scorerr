import type { ProfileRuleType, StoredProfileRuleInput } from '../services/profile-service.js';
import type { NormalizedRelease, ReleaseProtocol } from '../services/release-normalizer.js';

export type EvaluationState =
  | 'preferred'
  | 'fallback'
  | 'acceptable'
  | 'soft_miss'
  | 'hard_fail'
  | 'unknown'
  | 'not_applicable';

export type RuleImportance = 'low' | 'medium' | 'high' | 'priority';

const evaluationRuleTypes: readonly ProfileRuleType[] = [
  'language',
  'seeders',
  'resolution',
  'source',
  'size',
  'codec',
  'custom_formats',
  'indexer',
];

export interface EvaluationWarning {
  code: string;
  rule: ProfileRuleType;
  details?: Record<string, unknown>;
}

export interface EvaluationExplanation {
  code: string;
  details?: Record<string, unknown>;
}

export interface RuleEvaluation {
  rule: ProfileRuleType;
  configVersion: number | null;
  applicable: boolean;
  importance: RuleImportance | null;
  observed: Record<string, unknown>;
  expected: unknown;
  state: EvaluationState;
  hardConstraintViolation: boolean;
  explanation: EvaluationExplanation;
  warnings: EvaluationWarning[];
}

export type RuleEvaluations = Record<ProfileRuleType, RuleEvaluation>;

export interface EvaluationProfile {
  id: number;
  schemaVersion: number;
  revision: number;
  rules: readonly StoredProfileRuleInput[];
}

export interface MovieEvaluationContext {
  originalLanguage?: string | null;
}

export interface ReleaseEvaluationInput {
  release: NormalizedRelease;
  profile: EvaluationProfile;
  movieContext?: MovieEvaluationContext;
  radarrConnectionId: number;
  knownRadarrConnectionIds?: readonly number[];
}

export interface ReleaseEvaluation {
  profileId: number;
  profileSchemaVersion: number;
  profileRevision: number;
  release: {
    fingerprint: string;
    title: string | null;
    protocol: ReleaseProtocol;
  };
  radarrEligibility: {
    eligible: boolean;
    approved: boolean | null;
    rejected: boolean | null;
    reasons: string[];
    rejections: unknown[] | null;
  };
  profileEligible: boolean | null;
  eligible: boolean;
  rules: RuleEvaluations;
  warnings: EvaluationWarning[];
}

interface EvaluationResultInput {
  applicable: boolean;
  state: EvaluationState;
  observed: Record<string, unknown>;
  hardConstraintViolation?: boolean;
  explanation: EvaluationExplanation;
  warnings?: EvaluationWarning[];
}

const structuredLanguageNameCodes: Readonly<Record<string, string>> = {
  english: 'en',
  french: 'fr',
};

const languageCodePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

function explanation(code: string, details?: Record<string, unknown>): EvaluationExplanation {
  return details === undefined ? { code } : { code, details };
}

function warning(
  rule: ProfileRuleType,
  code: string,
  details?: Record<string, unknown>,
): EvaluationWarning {
  return details === undefined ? { rule, code } : { rule, code, details };
}

function importanceFor(rule: StoredProfileRuleInput): RuleImportance | null {
  if (rule.type !== 'language') return rule.config.importance;
  return 'importance' in rule.config ? rule.config.importance : null;
}

function result(rule: StoredProfileRuleInput, input: EvaluationResultInput): RuleEvaluation {
  return {
    rule: rule.type,
    configVersion: rule.configVersion,
    applicable: input.applicable,
    importance: importanceFor(rule),
    observed: input.observed,
    expected: rule.config,
    state: input.state,
    hardConstraintViolation: input.hardConstraintViolation ?? false,
    explanation: input.explanation,
    warnings: input.warnings ?? [],
  };
}

function assertCompleteRuleSet(rules: readonly StoredProfileRuleInput[]): void {
  const ruleTypes = new Set(rules.map((rule) => rule.type));
  if (
    rules.length !== evaluationRuleTypes.length ||
    ruleTypes.size !== evaluationRuleTypes.length ||
    evaluationRuleTypes.some((type) => !ruleTypes.has(type))
  ) {
    throw new TypeError('A release evaluation requires exactly one configuration for every rule.');
  }
}

function missingRule(type: ProfileRuleType): RuleEvaluation {
  return {
    rule: type,
    configVersion: null,
    applicable: false,
    importance: null,
    observed: {},
    expected: null,
    state: 'unknown',
    hardConstraintViolation: false,
    explanation: explanation('profile_rule_missing'),
    warnings: [warning(type, 'profile_rule_missing')],
  };
}

function gatedByRadarr(
  rule: StoredProfileRuleInput | undefined,
  type: ProfileRuleType,
): RuleEvaluation {
  if (!rule) return missingRule(type);
  return result(rule, {
    applicable: false,
    state: 'not_applicable',
    observed: {},
    explanation: explanation('radarr_ineligible'),
  });
}

function ruleFor<T extends ProfileRuleType>(
  rules: readonly StoredProfileRuleInput[],
  type: T,
): Extract<StoredProfileRuleInput, { type: T }> | undefined {
  return rules.find((rule) => rule.type === type) as
    Extract<StoredProfileRuleInput, { type: T }> | undefined;
}

function canonicalLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll('_', '-').toLowerCase();
  if (languageCodePattern.test(normalized)) return normalized;
  return structuredLanguageNameCodes[normalized] ?? null;
}

function structuredLanguageCodes(languages: unknown[] | null): string[] | null {
  if (languages === null) return null;
  const codes: string[] = [];
  for (const language of languages) {
    const direct = canonicalLanguageCode(language);
    if (direct !== null) {
      codes.push(direct);
      continue;
    }
    if (language === null || typeof language !== 'object' || Array.isArray(language)) continue;
    const entry = language as Record<string, unknown>;
    for (const field of ['code', 'isoCode', 'iso639_1', 'iso_639_1', 'languageCode', 'name']) {
      const code = canonicalLanguageCode(entry[field]);
      if (code !== null) {
        codes.push(code);
        break;
      }
    }
  }
  return [...new Set(codes)];
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function evaluateLanguage(
  rule: Extract<StoredProfileRuleInput, { type: 'language' }> | undefined,
  release: NormalizedRelease,
  movieContext: MovieEvaluationContext | undefined,
): RuleEvaluation {
  if (!rule) return missingRule('language');
  const languageCodes = structuredLanguageCodes(release.language.languages);
  if (languageCodes === null || languageCodes.length === 0) {
    return result(rule, {
      applicable: true,
      state: 'unknown',
      observed: { languageCodes },
      explanation: explanation('release_languages_unavailable'),
      warnings: [warning('language', 'release_languages_unavailable')],
    });
  }
  const preferredLanguages = rule.config.preferredLanguages
    .map(canonicalLanguageCode)
    .filter((code): code is string => code !== null);
  const preferredIndex = preferredLanguages.findIndex((code) => languageCodes.includes(code));
  if (preferredIndex >= 0) {
    return result(rule, {
      applicable: true,
      state: 'preferred',
      observed: { languageCodes, matchedPreferenceIndex: preferredIndex },
      explanation: explanation('preferred_language_present', {
        matchedPreferenceIndex: preferredIndex,
      }),
    });
  }
  const originalLanguage = canonicalLanguageCode(movieContext?.originalLanguage);
  if (originalLanguage === null) {
    return result(rule, {
      applicable: true,
      state: 'unknown',
      observed: { languageCodes, originalLanguage: null },
      explanation: explanation('original_language_unavailable'),
      warnings: [warning('language', 'original_language_unavailable')],
    });
  }
  if (languageCodes.includes(originalLanguage)) {
    return result(rule, {
      applicable: true,
      state: 'fallback',
      observed: { languageCodes, originalLanguage },
      explanation: explanation('original_language_present'),
    });
  }
  return result(rule, {
    applicable: true,
    state: 'soft_miss',
    observed: { languageCodes, originalLanguage },
    explanation: explanation('preferred_or_original_language_not_present'),
  });
}

function evaluateSeeders(
  rule: Extract<StoredProfileRuleInput, { type: 'seeders' }> | undefined,
  release: NormalizedRelease,
): RuleEvaluation {
  if (!rule) return missingRule('seeders');
  const observed = {
    protocol: release.availability.protocol,
    seeders: release.availability.seeders,
  };
  if (release.availability.protocol !== 'torrent') {
    return result(rule, {
      applicable: false,
      state: 'not_applicable',
      observed,
      explanation: explanation('seeders_apply_to_torrents_only'),
    });
  }
  if (release.availability.seeders === null) {
    const hardConstraintViolation = rule.config.requireMinimum;
    return result(rule, {
      applicable: true,
      state: hardConstraintViolation ? 'hard_fail' : 'unknown',
      observed,
      hardConstraintViolation,
      explanation: explanation('seeders_unavailable'),
      warnings: [warning('seeders', 'seeders_unavailable')],
    });
  }
  if (release.availability.seeders >= rule.config.desiredMinimum) {
    return result(rule, {
      applicable: true,
      state: 'preferred',
      observed,
      explanation: explanation('seeders_minimum_met'),
    });
  }
  const hardConstraintViolation = rule.config.requireMinimum;
  return result(rule, {
    applicable: true,
    state: hardConstraintViolation ? 'hard_fail' : 'soft_miss',
    observed,
    hardConstraintViolation,
    explanation: explanation('seeders_below_minimum'),
  });
}

function evaluateResolution(
  rule: Extract<StoredProfileRuleInput, { type: 'resolution' }> | undefined,
  release: NormalizedRelease,
): RuleEvaluation {
  if (!rule) return missingRule('resolution');
  const observed = { height: release.media.resolution };
  if (release.media.resolution === null) {
    const hardConstraintViolation = rule.config.requireMinimum;
    return result(rule, {
      applicable: true,
      state: hardConstraintViolation ? 'hard_fail' : 'unknown',
      observed,
      hardConstraintViolation,
      explanation: explanation('resolution_unavailable'),
      warnings: [warning('resolution', 'resolution_unavailable')],
    });
  }
  const minimumMet = release.media.resolution >= rule.config.desiredMinimumHeight;
  const preferredMatch = release.media.resolution === rule.config.preferredHeight;
  if (!minimumMet) {
    const hardConstraintViolation = rule.config.requireMinimum;
    return result(rule, {
      applicable: true,
      state: hardConstraintViolation ? 'hard_fail' : 'soft_miss',
      observed: { ...observed, minimumMet, preferredMatch },
      hardConstraintViolation,
      explanation: explanation('resolution_below_minimum'),
    });
  }
  if (preferredMatch) {
    return result(rule, {
      applicable: true,
      state: 'preferred',
      observed: { ...observed, minimumMet, preferredMatch },
      explanation: explanation('resolution_matches_preference'),
    });
  }
  return result(rule, {
    applicable: true,
    state: 'acceptable',
    observed: { ...observed, minimumMet, preferredMatch },
    explanation: explanation('resolution_minimum_met_without_exact_preference'),
  });
}

function evaluateSource(
  rule: Extract<StoredProfileRuleInput, { type: 'source' }> | undefined,
  release: NormalizedRelease,
): RuleEvaluation {
  if (!rule) return missingRule('source');
  const preferredSources = rule.config.preferredSources.map(normalizeValue);
  if (preferredSources.length === 0) {
    return result(rule, {
      applicable: false,
      state: 'not_applicable',
      observed: { source: release.media.source },
      explanation: explanation('no_preferred_sources_configured'),
    });
  }
  if (release.media.source === null) {
    return result(rule, {
      applicable: true,
      state: 'unknown',
      observed: { source: null },
      explanation: explanation('source_unavailable'),
      warnings: [warning('source', 'source_unavailable')],
    });
  }
  const matchedPreferenceIndex = preferredSources.indexOf(normalizeValue(release.media.source));
  if (matchedPreferenceIndex === 0) {
    return result(rule, {
      applicable: true,
      state: 'preferred',
      observed: { source: release.media.source, matchedPreferenceIndex },
      explanation: explanation('primary_source_present'),
    });
  }
  if (matchedPreferenceIndex > 0) {
    return result(rule, {
      applicable: true,
      state: 'fallback',
      observed: { source: release.media.source, matchedPreferenceIndex },
      explanation: explanation('fallback_source_present', { matchedPreferenceIndex }),
    });
  }
  return result(rule, {
    applicable: true,
    state: 'soft_miss',
    observed: { source: release.media.source, matchedPreferenceIndex: null },
    explanation: explanation('source_not_preferred'),
  });
}

function evaluateSize(
  rule: Extract<StoredProfileRuleInput, { type: 'size' }> | undefined,
  release: NormalizedRelease,
): RuleEvaluation {
  if (!rule) return missingRule('size');
  const observed = { sizeBytes: release.media.sizeBytes };
  if (release.media.sizeBytes === null) {
    const hardConstraintViolation = rule.config.requireMaximum;
    return result(rule, {
      applicable: true,
      state: hardConstraintViolation ? 'hard_fail' : 'unknown',
      observed,
      hardConstraintViolation,
      explanation: explanation('size_unavailable'),
      warnings: [warning('size', 'size_unavailable')],
    });
  }
  if (release.media.sizeBytes <= rule.config.desiredMaximumBytes) {
    return result(rule, {
      applicable: true,
      state: 'preferred',
      observed,
      explanation: explanation('size_within_maximum'),
    });
  }
  const hardConstraintViolation = rule.config.requireMaximum;
  return result(rule, {
    applicable: true,
    state: hardConstraintViolation ? 'hard_fail' : 'soft_miss',
    observed,
    hardConstraintViolation,
    explanation: explanation('size_above_maximum'),
  });
}

function evaluateCodec(
  rule: Extract<StoredProfileRuleInput, { type: 'codec' }> | undefined,
): RuleEvaluation {
  if (!rule) return missingRule('codec');
  return result(rule, {
    applicable: true,
    state: 'unknown',
    observed: { codec: null },
    explanation: explanation('structured_codec_unavailable'),
    warnings: [warning('codec', 'structured_codec_unavailable')],
  });
}

function evaluateCustomFormats(
  rule: Extract<StoredProfileRuleInput, { type: 'custom_formats' }> | undefined,
  release: NormalizedRelease,
): RuleEvaluation {
  if (!rule) return missingRule('custom_formats');
  const observed = {
    customFormats: release.formats.customFormats,
    radarrReportedValue: release.formats.customFormatScore,
  };
  if (!rule.config.useRadarrPreferences) {
    return result(rule, {
      applicable: false,
      state: 'not_applicable',
      observed,
      explanation: explanation('radarr_preferences_disabled'),
    });
  }
  if (release.formats.customFormats === null && release.formats.customFormatScore === null) {
    return result(rule, {
      applicable: true,
      state: 'unknown',
      observed,
      explanation: explanation('radarr_custom_formats_unavailable'),
      warnings: [warning('custom_formats', 'radarr_custom_formats_unavailable')],
    });
  }
  return result(rule, {
    applicable: true,
    state: 'acceptable',
    observed,
    explanation: explanation('radarr_custom_formats_observed'),
  });
}

function evaluateIndexer(
  rule: Extract<StoredProfileRuleInput, { type: 'indexer' }> | undefined,
  release: NormalizedRelease,
  radarrConnectionId: number,
  knownRadarrConnectionIds: readonly number[] | undefined,
): RuleEvaluation {
  if (!rule) return missingRule('indexer');
  const knownConnectionIds =
    knownRadarrConnectionIds === undefined ? undefined : new Set(knownRadarrConnectionIds);
  const staleReferences = rule.config.preferredIndexers.filter(
    (reference) =>
      knownConnectionIds !== undefined && !knownConnectionIds.has(reference.radarrConnectionId),
  );
  const warnings = staleReferences.map((reference) =>
    warning('indexer', 'stale_radarr_connection_reference', {
      radarrConnectionId: reference.radarrConnectionId,
      indexerId: reference.indexerId,
    }),
  );
  const activeReferences = rule.config.preferredIndexers.filter(
    (reference) =>
      reference.radarrConnectionId === radarrConnectionId &&
      (knownConnectionIds === undefined || knownConnectionIds.has(reference.radarrConnectionId)),
  );
  const observed = {
    radarrConnectionId,
    indexerId: release.identity.indexerId,
    indexer: release.identity.indexer,
  };
  if (activeReferences.length === 0) {
    return result(rule, {
      applicable: false,
      state: 'not_applicable',
      observed,
      explanation: explanation('no_preferred_indexer_for_radarr_connection'),
      warnings,
    });
  }
  if (release.identity.indexerId === null) {
    return result(rule, {
      applicable: true,
      state: 'unknown',
      observed,
      explanation: explanation('indexer_identifier_unavailable'),
      warnings: [...warnings, warning('indexer', 'indexer_identifier_unavailable')],
    });
  }
  if (activeReferences.some((reference) => reference.indexerId === release.identity.indexerId)) {
    return result(rule, {
      applicable: true,
      state: 'preferred',
      observed,
      explanation: explanation('preferred_indexer_present'),
      warnings,
    });
  }
  if (rule.config.allowOthers) {
    return result(rule, {
      applicable: true,
      state: 'soft_miss',
      observed,
      explanation: explanation('other_indexer_allowed'),
      warnings,
    });
  }
  return result(rule, {
    applicable: true,
    state: 'hard_fail',
    observed,
    hardConstraintViolation: true,
    explanation: explanation('other_indexer_not_allowed'),
    warnings,
  });
}

function gatedRules(profile: EvaluationProfile): RuleEvaluations {
  return {
    language: gatedByRadarr(ruleFor(profile.rules, 'language'), 'language'),
    seeders: gatedByRadarr(ruleFor(profile.rules, 'seeders'), 'seeders'),
    resolution: gatedByRadarr(ruleFor(profile.rules, 'resolution'), 'resolution'),
    source: gatedByRadarr(ruleFor(profile.rules, 'source'), 'source'),
    size: gatedByRadarr(ruleFor(profile.rules, 'size'), 'size'),
    codec: gatedByRadarr(ruleFor(profile.rules, 'codec'), 'codec'),
    custom_formats: gatedByRadarr(ruleFor(profile.rules, 'custom_formats'), 'custom_formats'),
    indexer: gatedByRadarr(ruleFor(profile.rules, 'indexer'), 'indexer'),
  };
}

function evaluateRules(input: ReleaseEvaluationInput): RuleEvaluations {
  return {
    language: evaluateLanguage(
      ruleFor(input.profile.rules, 'language'),
      input.release,
      input.movieContext,
    ),
    seeders: evaluateSeeders(ruleFor(input.profile.rules, 'seeders'), input.release),
    resolution: evaluateResolution(ruleFor(input.profile.rules, 'resolution'), input.release),
    source: evaluateSource(ruleFor(input.profile.rules, 'source'), input.release),
    size: evaluateSize(ruleFor(input.profile.rules, 'size'), input.release),
    codec: evaluateCodec(ruleFor(input.profile.rules, 'codec')),
    custom_formats: evaluateCustomFormats(
      ruleFor(input.profile.rules, 'custom_formats'),
      input.release,
    ),
    indexer: evaluateIndexer(
      ruleFor(input.profile.rules, 'indexer'),
      input.release,
      input.radarrConnectionId,
      input.knownRadarrConnectionIds,
    ),
  };
}

/**
 * Pure, deterministic Phase 3 release evaluation.
 *
 * It describes Radarr eligibility, explicit profile constraints, and soft
 * preferences without applying a numerical policy or making a selection.
 */
export function evaluateRelease(input: ReleaseEvaluationInput): ReleaseEvaluation {
  assertCompleteRuleSet(input.profile.rules);
  const radarrEligible =
    input.release.radarr.approved === true && input.release.radarr.rejected !== true;
  const radarrEligibility = {
    eligible: radarrEligible,
    approved: input.release.radarr.approved,
    rejected: input.release.radarr.rejected,
    reasons: [...input.release.eligibility.reasons],
    rejections: input.release.radarr.rejections,
  };
  const rules = radarrEligible ? evaluateRules(input) : gatedRules(input.profile);
  const profileEligible = radarrEligible
    ? !evaluationRuleTypes.some((type) => rules[type].hardConstraintViolation)
    : null;
  return {
    profileId: input.profile.id,
    profileSchemaVersion: input.profile.schemaVersion,
    profileRevision: input.profile.revision,
    release: {
      fingerprint: input.release.identity.fingerprint,
      title: input.release.identity.title,
      protocol: input.release.availability.protocol,
    },
    radarrEligibility,
    profileEligible,
    eligible: radarrEligible && profileEligible === true,
    rules,
    warnings: evaluationRuleTypes.flatMap((type) => rules[type].warnings),
  };
}
