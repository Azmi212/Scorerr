import type { EvaluationProfile, ReleaseEvaluation, RuleImportance } from './release-evaluator.js';
import {
  compareOrdinalRule,
  evaluationMatchesProfile,
  evaluationMatchesRadarrContext,
  importanceOf,
  isOrdinalFailure,
  ordinalImportanceTiers,
  prepareOrdinalProfile,
  rulesInPositionOrder,
  validEvaluationRule,
  type ComparableProfileRule,
  type OrdinalPolicyError,
  type OrdinalPolicyErrorCode,
} from './release-ordinal-policy.js';
import type { ProfileRuleType } from '../services/profile-service.js';

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

export type PairwiseReleaseComparisonErrorCode = OrdinalPolicyErrorCode;
export type PairwiseReleaseComparisonError = OrdinalPolicyError;

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
 * Collection selection is deliberately implemented by the survivor pipeline,
 * not by using this pairwise function as an Array.sort callback.
 */
export function compareEligibleReleases(
  input: PairwiseReleaseComparisonInput,
): PairwiseReleaseComparisonResult {
  const prepared = prepareOrdinalProfile(input.profile);
  if (!prepared.ok) return prepared;
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
    !evaluationMatchesRadarrContext(input.a, input.radarrConnectionId) ||
    !evaluationMatchesRadarrContext(input.b, input.radarrConnectionId)
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

  for (const tier of ordinalImportanceTiers) {
    for (const rule of rulesInPositionOrder(prepared.profile.rules, tier)) {
      const a = validEvaluationRule(input.a, rule);
      if (isOrdinalFailure(a)) return a;
      const b = validEvaluationRule(input.b, rule);
      if (isOrdinalFailure(b)) return b;
      const decision = compareOrdinalRule(rule, a, b, input.a, input.b, input.radarrConnectionId);
      if (decision.kind === 'winner') {
        return userPreferenceResult(decision.winner, rule, decision.reason, decision.details);
      }
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
