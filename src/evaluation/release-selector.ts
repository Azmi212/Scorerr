import type { EvaluationProfile, ReleaseEvaluation, RuleImportance } from './release-evaluator.js';
import {
  bestSemanticState,
  evaluationMatchesProfile,
  evaluationMatchesRadarrContext,
  isOrdinalFailure,
  ordinalImportanceTiers,
  prepareOrdinalProfile,
  rulesInPositionOrder,
  secondaryObservation,
  validEvaluationRule,
  type ComparableEvaluationState,
  type ComparableProfileRule,
  type ComparableRuleEvaluation,
  type OrdinalPolicyError,
  type OrdinalPolicyErrorCode,
  type RuleSecondaryObservation,
} from './release-ordinal-policy.js';
import type { ProfileRuleType } from '../services/profile-service.js';

export interface CandidateReference {
  fingerprint: string;
  title: string | null;
  protocol: ReleaseEvaluation['release']['protocol'];
}

export type CandidateSelectionBasis =
  'sole_candidate' | 'user_preference' | 'technical_tiebreak' | 'equivalent';

export type CandidateSelectionErrorCode = OrdinalPolicyErrorCode | 'no_candidates';

export interface CandidateSelectionError extends Omit<OrdinalPolicyError, 'code'> {
  code: CandidateSelectionErrorCode;
}

export interface CandidateElimination {
  candidate: CandidateReference;
  reason: 'lower_state' | 'secondary_tiebreak';
  state: ComparableEvaluationState;
  observedValue?: number;
}

export interface CandidateSelectionSecondaryTrace {
  type: RuleSecondaryObservation['type'];
  direction: RuleSecondaryObservation['direction'];
  preferredValue: number;
}

export interface CandidateSelectionStep {
  tier: RuleImportance;
  rule: ProfileRuleType;
  position: number;
  candidatesBefore: CandidateReference[];
  applicable: CandidateReference[];
  notApplicable: CandidateReference[];
  bestState: ComparableEvaluationState | null;
  secondaryTiebreak: CandidateSelectionSecondaryTrace | null;
  eliminated: CandidateElimination[];
  survivors: CandidateReference[];
}

export interface CandidateSelectionExplanation {
  code:
    | 'sole_candidate'
    | 'survivor_reduction_selected'
    | 'technical_fingerprint_tiebreak'
    | 'functionally_equivalent';
  details?: Record<string, unknown>;
}

export interface CandidateSelection {
  winner: CandidateReference | null;
  basis: CandidateSelectionBasis;
  decidingRule: ProfileRuleType | null;
  decidingTier: RuleImportance | null;
  decidingReason: 'state' | 'secondary_tiebreak' | null;
  finalists: CandidateReference[];
  explanation: CandidateSelectionExplanation;
}

export interface CandidateSelectionInput {
  profile: EvaluationProfile;
  radarrConnectionId: number;
  candidates: readonly ReleaseEvaluation[];
}

export type CandidateSelectionResult =
  | { ok: true; selection: CandidateSelection; steps: CandidateSelectionStep[] }
  | { ok: false; error: CandidateSelectionError };

type CandidateSelectionFailure = Extract<CandidateSelectionResult, { ok: false }>;

interface Candidate {
  reference: CandidateReference;
  stableKey: string;
  evaluation: ReleaseEvaluation;
}

interface RuleReduction {
  survivors: Candidate[];
  step: CandidateSelectionStep;
  decidingReason: 'state' | 'secondary_tiebreak' | null;
}

function failure(
  code: CandidateSelectionErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CandidateSelectionFailure {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

function explanation(
  code: CandidateSelectionExplanation['code'],
  details?: Record<string, unknown>,
): CandidateSelectionExplanation {
  return details === undefined ? { code } : { code, details };
}

function candidateReference(evaluation: ReleaseEvaluation): CandidateReference {
  return {
    fingerprint: evaluation.release.fingerprint,
    title: evaluation.release.title,
    protocol: evaluation.release.protocol,
  };
}

function candidateStableKey(reference: CandidateReference): string {
  return `${reference.fingerprint}\u0000${reference.protocol}\u0000${reference.title ?? ''}`;
}

function stableCandidates(candidates: readonly Candidate[]): Candidate[] {
  const ordered: Candidate[] = [];
  for (const candidate of candidates) {
    let insertionIndex = ordered.length;
    for (const [index, current] of ordered.entries()) {
      if (candidate.stableKey < current.stableKey) {
        insertionIndex = index;
        break;
      }
    }
    ordered.splice(insertionIndex, 0, candidate);
  }
  return ordered;
}

function references(candidates: readonly Candidate[]): CandidateReference[] {
  return stableCandidates(candidates).map((candidate) => candidate.reference);
}

function stableEliminations(eliminated: readonly CandidateElimination[]): CandidateElimination[] {
  const ordered: CandidateElimination[] = [];
  for (const entry of eliminated) {
    const entryKey = `${candidateStableKey(entry.candidate)}\u0000${entry.reason}\u0000${String(
      entry.observedValue ?? '',
    )}`;
    let insertionIndex = ordered.length;
    for (const [index, current] of ordered.entries()) {
      const currentKey = `${candidateStableKey(current.candidate)}\u0000${current.reason}\u0000${String(
        current.observedValue ?? '',
      )}`;
      if (entryKey < currentKey) {
        insertionIndex = index;
        break;
      }
    }
    ordered.splice(insertionIndex, 0, entry);
  }
  return ordered;
}

function expectedProfileDetails(profile: EvaluationProfile): Record<string, unknown> {
  return {
    profileId: profile.id,
    profileSchemaVersion: profile.schemaVersion,
    profileRevision: profile.revision,
  };
}

function validateCandidates(
  candidates: readonly Candidate[],
  profile: EvaluationProfile,
  rules: readonly ComparableProfileRule[],
  radarrConnectionId: number,
): CandidateSelectionFailure | null {
  const ineligible = candidates.filter((candidate) => !candidate.evaluation.eligible);
  if (ineligible.length > 0) {
    return failure(
      'release_not_eligible',
      'Every release in the collection must be Phase 3 eligible.',
      { candidates: references(ineligible) },
    );
  }

  const profileMismatches = candidates.filter(
    (candidate) => !evaluationMatchesProfile(candidate.evaluation, profile),
  );
  if (profileMismatches.length > 0) {
    return failure(
      'evaluation_profile_mismatch',
      'Every release evaluation must belong to the supplied profile revision.',
      {
        expected: expectedProfileDetails(profile),
        candidates: stableCandidates(profileMismatches).map((candidate) => ({
          candidate: candidate.reference,
          profileId: candidate.evaluation.profileId,
          profileSchemaVersion: candidate.evaluation.profileSchemaVersion,
          profileRevision: candidate.evaluation.profileRevision,
        })),
      },
    );
  }

  const contextMismatches = candidates.filter(
    (candidate) => !evaluationMatchesRadarrContext(candidate.evaluation, radarrConnectionId),
  );
  if (contextMismatches.length > 0) {
    return failure(
      'evaluation_context_mismatch',
      'Every release evaluation must use the supplied active Radarr connection.',
      {
        expectedRadarrConnectionId: radarrConnectionId,
        candidates: stableCandidates(contextMismatches).map((candidate) => ({
          candidate: candidate.reference,
          radarrConnectionId: candidate.evaluation.rules.indexer.observed.radarrConnectionId,
        })),
      },
    );
  }

  for (const tier of ordinalImportanceTiers) {
    for (const rule of rulesInPositionOrder(rules, tier)) {
      for (const candidate of stableCandidates(candidates)) {
        const evaluatedRule = validEvaluationRule(candidate.evaluation, rule);
        if (isOrdinalFailure(evaluatedRule)) {
          return {
            ok: false,
            error: {
              ...evaluatedRule.error,
              details: {
                ...evaluatedRule.error.details,
                candidate: candidate.reference,
              },
            },
          };
        }
      }
    }
  }
  return null;
}

function evaluatedRule(
  candidate: Candidate,
  rule: ComparableProfileRule,
): ComparableRuleEvaluation {
  return candidate.evaluation.rules[rule.type] as ComparableRuleEvaluation;
}

function preferredSecondaryValue(observations: readonly RuleSecondaryObservation[]): number | null {
  if (observations.length < 2) return null;
  let preferred = observations[0]?.value;
  if (preferred === undefined) return null;
  for (const observation of observations.slice(1)) {
    if (
      (observation.direction === 'higher' && observation.value > preferred) ||
      (observation.direction === 'lower' && observation.value < preferred)
    ) {
      preferred = observation.value;
    }
  }
  return observations.some((observation) => observation.value !== preferred) ? preferred : null;
}

function reduceByRule(
  candidates: readonly Candidate[],
  rule: ComparableProfileRule,
  tier: RuleImportance,
  radarrConnectionId: number,
): RuleReduction {
  const applicable = candidates.filter(
    (candidate) => evaluatedRule(candidate, rule).state !== 'not_applicable',
  );
  const notApplicable = candidates.filter(
    (candidate) => evaluatedRule(candidate, rule).state === 'not_applicable',
  );
  let applicableSurvivors = [...applicable];
  const bestState =
    applicable.length === 0
      ? null
      : bestSemanticState(applicable.map((candidate) => evaluatedRule(candidate, rule)));
  const eliminated: CandidateElimination[] = [];
  let secondaryTiebreak: CandidateSelectionSecondaryTrace | null = null;

  if (applicable.length >= 2 && bestState !== null) {
    applicableSurvivors = applicable.filter(
      (candidate) => evaluatedRule(candidate, rule).state === bestState,
    );
    for (const candidate of applicable) {
      const state = evaluatedRule(candidate, rule).state;
      if (state !== bestState && state !== 'not_applicable') {
        eliminated.push({ candidate: candidate.reference, reason: 'lower_state', state });
      }
    }

    if (applicableSurvivors.length >= 2) {
      const observations = applicableSurvivors.map((candidate) => ({
        candidate,
        observation: secondaryObservation(
          rule,
          evaluatedRule(candidate, rule),
          candidate.evaluation,
          radarrConnectionId,
        ),
      }));
      const known = observations.flatMap(({ observation }) =>
        observation === null ? [] : [observation],
      );
      const preferredValue = preferredSecondaryValue(known);
      if (preferredValue !== null) {
        const sample = known[0];
        if (sample === undefined) throw new Error('Secondary observation invariant violated.');
        secondaryTiebreak = {
          type: sample.type,
          direction: sample.direction,
          preferredValue,
        };
        const secondaryEliminated = new Set<Candidate>();
        for (const { candidate, observation } of observations) {
          if (observation !== null && observation.value !== preferredValue) {
            secondaryEliminated.add(candidate);
            eliminated.push({
              candidate: candidate.reference,
              reason: 'secondary_tiebreak',
              state: bestState,
              observedValue: observation.value,
            });
          }
        }
        applicableSurvivors = applicableSurvivors.filter(
          (candidate) => !secondaryEliminated.has(candidate),
        );
      }
    }
  }

  const survivors = stableCandidates([...applicableSurvivors, ...notApplicable]);
  return {
    survivors,
    step: {
      tier,
      rule: rule.type,
      position: rule.position,
      candidatesBefore: references(candidates),
      applicable: references(applicable),
      notApplicable: references(notApplicable),
      bestState,
      secondaryTiebreak,
      eliminated: stableEliminations(eliminated),
      survivors: references(survivors),
    },
    decidingReason:
      eliminated.length === 0 ? null : secondaryTiebreak === null ? 'state' : 'secondary_tiebreak',
  };
}

function selected(
  selection: CandidateSelection,
  steps: CandidateSelectionStep[],
): CandidateSelectionResult {
  return { ok: true, selection, steps };
}

function firstCandidate(candidates: readonly Candidate[], context: string): Candidate {
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error(`${context} invariant violated.`);
  return candidate;
}

/** Pure Phase 4B survivor selection over a homogeneous collection. */
export function selectCandidates(input: CandidateSelectionInput): CandidateSelectionResult {
  if (input.candidates.length === 0) {
    return failure('no_candidates', 'At least one eligible release evaluation is required.');
  }
  const prepared = prepareOrdinalProfile(input.profile);
  if (!prepared.ok) return prepared;
  const candidates = stableCandidates(
    input.candidates.map((evaluation) => {
      const reference = candidateReference(evaluation);
      return { reference, stableKey: candidateStableKey(reference), evaluation };
    }),
  );
  const invalid = validateCandidates(
    candidates,
    input.profile,
    prepared.profile.rules,
    input.radarrConnectionId,
  );
  if (invalid !== null) return invalid;

  if (candidates.length === 1) {
    const candidate = firstCandidate(candidates, 'Sole candidate');
    return selected(
      {
        winner: candidate.reference,
        basis: 'sole_candidate',
        decidingRule: null,
        decidingTier: null,
        decidingReason: null,
        finalists: [candidate.reference],
        explanation: explanation('sole_candidate'),
      },
      [],
    );
  }

  let survivors = candidates;
  const steps: CandidateSelectionStep[] = [];
  let lastDecision:
    | {
        rule: ProfileRuleType;
        tier: RuleImportance;
        reason: 'state' | 'secondary_tiebreak';
      }
    | undefined;

  for (const tier of ordinalImportanceTiers) {
    for (const rule of rulesInPositionOrder(prepared.profile.rules, tier)) {
      const reduction = reduceByRule(survivors, rule, tier, input.radarrConnectionId);
      survivors = reduction.survivors;
      steps.push(reduction.step);
      if (reduction.decidingReason !== null) {
        lastDecision = { rule: rule.type, tier, reason: reduction.decidingReason };
      }
      if (survivors.length === 1) {
        const winner = firstCandidate(survivors, 'User selection');
        if (lastDecision === undefined) {
          throw new Error('User selection invariant violated.');
        }
        return selected(
          {
            winner: winner.reference,
            basis: 'user_preference',
            decidingRule: lastDecision.rule,
            decidingTier: lastDecision.tier,
            decidingReason: lastDecision.reason,
            finalists: [winner.reference],
            explanation: explanation('survivor_reduction_selected', {
              rule: lastDecision.rule,
              tier: lastDecision.tier,
              reason: lastDecision.reason,
            }),
          },
          steps,
        );
      }
    }
  }

  let minimalFingerprint = firstCandidate(survivors, 'Technical selection').evaluation.release
    .fingerprint;
  for (const candidate of survivors.slice(1)) {
    if (candidate.evaluation.release.fingerprint < minimalFingerprint) {
      minimalFingerprint = candidate.evaluation.release.fingerprint;
    }
  }
  const technicalFinalists = stableCandidates(
    survivors.filter(
      (candidate) => candidate.evaluation.release.fingerprint === minimalFingerprint,
    ),
  );
  if (technicalFinalists.length === 1) {
    const winner = firstCandidate(technicalFinalists, 'Technical finalist');
    return selected(
      {
        winner: winner.reference,
        basis: 'technical_tiebreak',
        decidingRule: null,
        decidingTier: null,
        decidingReason: null,
        finalists: [winner.reference],
        explanation: explanation('technical_fingerprint_tiebreak', {
          functionalFinalists: references(survivors),
          selectedFingerprint: minimalFingerprint,
        }),
      },
      steps,
    );
  }
  return selected(
    {
      winner: null,
      basis: 'equivalent',
      decidingRule: null,
      decidingTier: null,
      decidingReason: null,
      finalists: references(technicalFinalists),
      explanation: explanation('functionally_equivalent', {
        functionalFinalists: references(survivors),
        equivalentFingerprint: minimalFingerprint,
      }),
    },
    steps,
  );
}
