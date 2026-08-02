import { createHash } from 'node:crypto';

export const RECOVERY_POLICY_VERSION = 'effect-state-recovery/v1';

export const RECOVERY_SYSTEM_FAULT_CODES = Object.freeze([
  'operation_identity_conflict',
  'configuration_identity_conflict',
  'journal_integrity_error',
  'receipt_integrity_error',
  'commit_plan_conflict',
  'unsupported_recovery_contract',
]);

export const RECOVERY_POLICY_DESCRIPTOR = Object.freeze({
  version: RECOVERY_POLICY_VERSION,
  evidence: {
    kinds: ['no_effect', 'staged', 'committing', 'committed', 'unknown', 'system_fault'],
    noEffectObservations: ['execution_error', 'business_empty', 'business_rejected'],
    noEffectProofs: {
      request_not_dispatched: ['attemptId', 'journalSeq'],
      receipt_before_formal_effect: [
        'receiptKey',
        'receiptVersion',
        'phase:preflight|provider_call|candidate_staging',
        'commitPlanAbsent:true',
      ],
      committed_structured_no_effect: [
        'receiptKey',
        'receiptVersion',
        'schema',
        'proposalHash',
        'reasonCode',
        'proofHash',
      ],
      legacy_lessons_zero_effect: [
        'lessonRunId',
        'receiptKey',
        'inputHash',
        'configHash',
        'createdLessonCount:0',
        'replacedLessonCount:0',
        'chunkLessonCount:0',
        'finishedAt',
      ],
      legacy_summary_before_final_write: [
        'summaryRunId',
        'receiptKey',
        'inputHash',
        'completedFinalWrites:0',
      ],
    },
    systemFaultCodes: RECOVERY_SYSTEM_FAULT_CODES,
  },
  validation: {
    reasonCodePattern: '^[a-z0-9][a-z0-9_.:-]{0,127}$:i',
    effectHashPattern: '^[0-9a-f]{64}$',
    committedReceiptStatuses: ['succeeded', 'committed'],
    receiptVersion: 'positive_safe_integer',
    retryBudget: {
      attemptsUsed: 'non_negative_safe_integer',
      maxAttempts: 'non_negative_safe_integer',
      availableWhen: 'attemptsUsed<maxAttempts',
    },
    effectVerification: ['all_applied', 'plan_incomplete', 'conflict'],
  },
  failClosed: {
    malformedEvidence: 'unknown',
    unprovedNoEffect: 'unknown',
    unverifiedCommitted: 'unknown',
    unsupportedEvidence: 'system_fault:unsupported_recovery_contract',
    unsupportedDecision: 'block_run:unsupported_recovery_contract',
  },
  decisions: [
    ['committed', 'all_applied', 'replay'],
    ['committed', 'plan_incomplete', 'resume_commit'],
    ['committed', 'conflict', 'block_run:commit_plan_conflict'],
    ['unknown', '*', 'reconcile'],
    ['committing', '*', 'reconcile_commit'],
    ['staged', '*', 'resume_commit'],
    ['no_effect:business_empty', '*', 'skipped'],
    ['no_effect:business_rejected', '*', 'isolate'],
    ['no_effect:execution_error', 'budget_available', 'retry'],
    ['no_effect:execution_error', 'budget_exhausted', 'isolate'],
    ['system_fault', '*', 'block_run'],
    ['unsupported', '*', 'block_run:unsupported_recovery_contract'],
  ],
});

export function recoveryPolicyHash(descriptor) {
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
}

export const RECOVERY_POLICY_HASH = recoveryPolicyHash(RECOVERY_POLICY_DESCRIPTOR);

const SYSTEM_FAULT_CODES = new Set(RECOVERY_SYSTEM_FAULT_CODES);
const NO_EFFECT_OBSERVATIONS = new Set([
  'execution_error',
  'business_empty',
  'business_rejected',
]);
const RECEIPT_PROOF_PHASES = new Set([
  'preflight',
  'provider_call',
  'candidate_staging',
]);
const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i;
const EFFECT_HASH = /^[0-9a-f]{64}$/;

function canonicalRecoveryValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRecoveryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((key) => [key, canonicalRecoveryValue(value[key])]),
    );
  }
  return value;
}

export function recoveryValueHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalRecoveryValue(value)))
    .digest('hex');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function same(left, right) {
  return left === right;
}

function unknownEvidence(evidence, snapshot, reasonCode = 'effect_state_unknown') {
  const receiptKey = snapshot?.receipt?.key
    || evidence?.receiptKey
    || evidence?.proof?.receiptKey
    || 'receipt_unavailable';
  return {
    kind: 'unknown',
    receiptKey,
    reasonCode: SAFE_CODE.test(reasonCode) ? reasonCode : 'effect_state_unknown',
  };
}

function matchesRequestNotDispatched(proof, snapshot) {
  const fact = snapshot?.requestDispatch;
  return (
    isNonEmptyString(proof.attemptId)
    && Number.isSafeInteger(proof.journalSeq)
    && proof.journalSeq >= 0
    && fact?.state === 'not_dispatched'
    && fact.persisted === true
    && same(fact.attemptId, proof.attemptId)
    && same(fact.journalSeq, proof.journalSeq)
    && snapshot?.receipt?.formalEffect !== true
  );
}

function matchesReceiptBeforeFormalEffect(proof, snapshot) {
  const receipt = snapshot?.receipt;
  return (
    isNonEmptyString(proof.receiptKey)
    && Number.isSafeInteger(proof.receiptVersion)
    && proof.receiptVersion > 0
    && RECEIPT_PROOF_PHASES.has(proof.phase)
    && proof.commitPlanAbsent === true
    && same(receipt?.key, proof.receiptKey)
    && same(receipt?.version, proof.receiptVersion)
    && same(receipt?.phase, proof.phase)
    && receipt?.commitPlanAbsent === true
    && receipt?.formalEffect !== true
  );
}

function matchesCommittedStructuredNoEffect(proof, snapshot, reasonCode) {
  const receipt = snapshot?.receipt;
  const committed = snapshot?.committedNoEffect;
  return (
    isNonEmptyString(proof.receiptKey)
    && Number.isSafeInteger(proof.receiptVersion)
    && proof.receiptVersion > 0
    && isNonEmptyString(proof.schema)
    && isNonEmptyString(proof.proposalHash)
    && isNonEmptyString(proof.reasonCode)
    && EFFECT_HASH.test(proof.proofHash)
    && same(proof.reasonCode, reasonCode)
    && same(receipt?.key, proof.receiptKey)
    && same(receipt?.version, proof.receiptVersion)
    && ['succeeded', 'committed'].includes(receipt?.status)
    && same(committed?.schema, proof.schema)
    && same(committed?.proposalHash, proof.proposalHash)
    && same(committed?.reasonCode, proof.reasonCode)
    && same(committed?.proofHash, proof.proofHash)
  );
}

function matchesLegacyLessonsZeroEffect(proof, snapshot) {
  const run = snapshot?.lessonRun;
  const receipt = snapshot?.receipt;
  return (
    isNonEmptyString(proof.lessonRunId)
    && isNonEmptyString(proof.receiptKey)
    && isNonEmptyString(proof.inputHash)
    && isNonEmptyString(proof.configHash)
    && proof.createdLessonCount === 0
    && proof.replacedLessonCount === 0
    && proof.chunkLessonCount === 0
    && isNonEmptyString(proof.finishedAt)
    && same(run?.id, proof.lessonRunId)
    && same(run?.inputHash, proof.inputHash)
    && same(run?.configHash, proof.configHash)
    && run?.createdLessonCount === 0
    && run?.replacedLessonCount === 0
    && run?.chunkLessonCount === 0
    && same(run?.finishedAt, proof.finishedAt)
    && same(receipt?.key, proof.receiptKey)
    && receipt?.formalEffect !== true
  );
}

function matchesLegacySummaryBeforeFinalWrite(proof, snapshot) {
  const run = snapshot?.summaryRun;
  const receipt = snapshot?.receipt;
  return (
    isNonEmptyString(proof.summaryRunId)
    && isNonEmptyString(proof.receiptKey)
    && isNonEmptyString(proof.inputHash)
    && proof.completedFinalWrites === 0
    && same(run?.id, proof.summaryRunId)
    && same(run?.inputHash, proof.inputHash)
    && run?.completedFinalWrites === 0
    && same(receipt?.key, proof.receiptKey)
    && receipt?.formalEffect !== true
  );
}

function proofMatches(proof, snapshot, reasonCode) {
  if (!isObject(proof)) return false;
  if (proof.kind === 'request_not_dispatched') {
    return matchesRequestNotDispatched(proof, snapshot);
  }
  if (proof.kind === 'receipt_before_formal_effect') {
    return matchesReceiptBeforeFormalEffect(proof, snapshot);
  }
  if (proof.kind === 'committed_structured_no_effect') {
    return matchesCommittedStructuredNoEffect(proof, snapshot, reasonCode);
  }
  if (proof.kind === 'legacy_lessons_zero_effect') {
    return matchesLegacyLessonsZeroEffect(proof, snapshot);
  }
  if (proof.kind === 'legacy_summary_before_final_write') {
    return matchesLegacySummaryBeforeFinalWrite(proof, snapshot);
  }
  return false;
}

function validRetryHint(retryHint) {
  if (retryHint === undefined) return true;
  if (!isObject(retryHint)) return false;
  if (retryHint.notBefore === undefined) return true;
  return (
    typeof retryHint.notBefore === 'string'
    && Number.isFinite(Date.parse(retryHint.notBefore))
  );
}

function receiptMatchesCommittedEvidence(evidence, snapshot) {
  const receipt = snapshot?.receipt;
  if (!receipt) return false;
  return (
    same(receipt.key, evidence.receiptKey)
    && same(receipt.version, evidence.receiptVersion)
    && same(receipt.resultRef, evidence.resultRef)
    && same(receipt.effectHash, evidence.effectHash)
    && ['succeeded', 'committed'].includes(receipt.status)
  );
}

export function normalizeOperationEvidence(evidence, snapshot = {}) {
  if (!isObject(evidence) || !isNonEmptyString(evidence.kind)) {
    return unknownEvidence(evidence, snapshot, 'invalid_operation_evidence');
  }
  if (evidence.kind === 'no_effect') {
    if (
      !NO_EFFECT_OBSERVATIONS.has(evidence.observation)
      || !isNonEmptyString(evidence.reasonCode)
      || !SAFE_CODE.test(evidence.reasonCode)
      || !validRetryHint(evidence.retryHint)
      || !proofMatches(evidence.proof, snapshot, evidence.reasonCode)
    ) {
      return unknownEvidence(evidence, snapshot, 'no_effect_unproven');
    }
    return structuredClone(evidence);
  }
  if (evidence.kind === 'staged') {
    if (!isNonEmptyString(evidence.resultRef) || !EFFECT_HASH.test(evidence.effectHash)) {
      return unknownEvidence(evidence, snapshot, 'invalid_staged_evidence');
    }
    return structuredClone(evidence);
  }
  if (evidence.kind === 'committing') {
    if (!isNonEmptyString(evidence.commitPlanRef) || !EFFECT_HASH.test(evidence.effectHash)) {
      return unknownEvidence(evidence, snapshot, 'invalid_committing_evidence');
    }
    return structuredClone(evidence);
  }
  if (evidence.kind === 'committed') {
    if (
      !isNonEmptyString(evidence.receiptKey)
      || !Number.isSafeInteger(evidence.receiptVersion)
      || evidence.receiptVersion <= 0
      || !isNonEmptyString(evidence.resultRef)
      || !EFFECT_HASH.test(evidence.effectHash)
      || !receiptMatchesCommittedEvidence(evidence, snapshot)
    ) {
      return unknownEvidence(evidence, snapshot, 'committed_evidence_unverified');
    }
    return structuredClone(evidence);
  }
  if (evidence.kind === 'unknown') {
    if (
      !isNonEmptyString(evidence.receiptKey)
      || !isNonEmptyString(evidence.reasonCode)
      || !SAFE_CODE.test(evidence.reasonCode)
    ) {
      return unknownEvidence(evidence, snapshot, 'invalid_unknown_evidence');
    }
    return structuredClone(evidence);
  }
  if (evidence.kind === 'system_fault' && SYSTEM_FAULT_CODES.has(evidence.code)) {
    return structuredClone(evidence);
  }
  return {
    kind: 'system_fault',
    code: 'unsupported_recovery_contract',
  };
}

function unsupportedDecision() {
  return {
    policyVersion: RECOVERY_POLICY_VERSION,
    action: 'block_run',
    code: 'unsupported_recovery_contract',
  };
}

function validProofShape(proof) {
  if (!isObject(proof)) return false;
  if (proof.kind === 'request_not_dispatched') {
    return (
      isNonEmptyString(proof.attemptId)
      && Number.isSafeInteger(proof.journalSeq)
      && proof.journalSeq >= 0
    );
  }
  if (proof.kind === 'receipt_before_formal_effect') {
    return (
      isNonEmptyString(proof.receiptKey)
      && Number.isSafeInteger(proof.receiptVersion)
      && proof.receiptVersion > 0
      && RECEIPT_PROOF_PHASES.has(proof.phase)
      && proof.commitPlanAbsent === true
    );
  }
  if (proof.kind === 'committed_structured_no_effect') {
    return (
      isNonEmptyString(proof.receiptKey)
      && Number.isSafeInteger(proof.receiptVersion)
      && proof.receiptVersion > 0
      && isNonEmptyString(proof.schema)
      && isNonEmptyString(proof.proposalHash)
      && isNonEmptyString(proof.reasonCode)
      && EFFECT_HASH.test(proof.proofHash)
    );
  }
  if (proof.kind === 'legacy_lessons_zero_effect') {
    return (
      isNonEmptyString(proof.lessonRunId)
      && isNonEmptyString(proof.receiptKey)
      && isNonEmptyString(proof.inputHash)
      && isNonEmptyString(proof.configHash)
      && proof.createdLessonCount === 0
      && proof.replacedLessonCount === 0
      && proof.chunkLessonCount === 0
      && isNonEmptyString(proof.finishedAt)
    );
  }
  if (proof.kind === 'legacy_summary_before_final_write') {
    return (
      isNonEmptyString(proof.summaryRunId)
      && isNonEmptyString(proof.receiptKey)
      && isNonEmptyString(proof.inputHash)
      && proof.completedFinalWrites === 0
    );
  }
  return false;
}

function validNormalizedEvidenceShape(evidence) {
  if (!isObject(evidence)) return false;
  if (evidence.kind === 'no_effect') {
    return (
      NO_EFFECT_OBSERVATIONS.has(evidence.observation)
      && isNonEmptyString(evidence.reasonCode)
      && SAFE_CODE.test(evidence.reasonCode)
      && validProofShape(evidence.proof)
      && validRetryHint(evidence.retryHint)
    );
  }
  if (evidence.kind === 'staged') {
    return isNonEmptyString(evidence.resultRef) && EFFECT_HASH.test(evidence.effectHash);
  }
  if (evidence.kind === 'committing') {
    return isNonEmptyString(evidence.commitPlanRef) && EFFECT_HASH.test(evidence.effectHash);
  }
  if (evidence.kind === 'committed') {
    return (
      isNonEmptyString(evidence.receiptKey)
      && Number.isSafeInteger(evidence.receiptVersion)
      && evidence.receiptVersion > 0
      && isNonEmptyString(evidence.resultRef)
      && EFFECT_HASH.test(evidence.effectHash)
    );
  }
  if (evidence.kind === 'unknown') {
    return (
      isNonEmptyString(evidence.receiptKey)
      && isNonEmptyString(evidence.reasonCode)
      && SAFE_CODE.test(evidence.reasonCode)
    );
  }
  return evidence.kind === 'system_fault' && SYSTEM_FAULT_CODES.has(evidence.code);
}

export function decideRecovery({
  policyVersion = RECOVERY_POLICY_VERSION,
  evidence,
  budget,
  effectVerification,
} = {}) {
  if (
    policyVersion !== RECOVERY_POLICY_VERSION
    || !validNormalizedEvidenceShape(evidence)
  ) {
    return unsupportedDecision();
  }
  if (evidence.kind === 'committed') {
    if (effectVerification === 'all_applied') {
      return { policyVersion, action: 'replay' };
    }
    if (effectVerification === 'plan_incomplete') {
      return { policyVersion, action: 'resume_commit' };
    }
    if (effectVerification === 'conflict') {
      return { policyVersion, action: 'block_run', code: 'commit_plan_conflict' };
    }
    return unsupportedDecision();
  }
  if (evidence.kind === 'unknown') {
    return { policyVersion, action: 'reconcile' };
  }
  if (evidence.kind === 'committing') {
    return { policyVersion, action: 'reconcile_commit' };
  }
  if (evidence.kind === 'staged') {
    return { policyVersion, action: 'resume_commit' };
  }
  if (evidence.kind === 'system_fault') {
    if (!SYSTEM_FAULT_CODES.has(evidence.code)) return unsupportedDecision();
    return { policyVersion, action: 'block_run', code: evidence.code };
  }
  if (evidence.kind !== 'no_effect' || !NO_EFFECT_OBSERVATIONS.has(evidence.observation)) {
    return unsupportedDecision();
  }
  if (evidence.observation === 'business_empty') {
    return { policyVersion, action: 'skipped', reasonCode: evidence.reasonCode };
  }
  if (evidence.observation === 'business_rejected') {
    return { policyVersion, action: 'isolate', reasonCode: evidence.reasonCode };
  }
  if (
    !budget
    || !Number.isSafeInteger(budget.attemptsUsed)
    || !Number.isSafeInteger(budget.maxAttempts)
    || budget.attemptsUsed < 0
    || budget.maxAttempts < 0
  ) {
    return unsupportedDecision();
  }
  if (budget.attemptsUsed < budget.maxAttempts) {
    return {
      policyVersion,
      action: 'retry',
      reasonCode: evidence.reasonCode,
      ...(evidence.retryHint?.notBefore ? { notBefore: evidence.retryHint.notBefore } : {}),
    };
  }
  return { policyVersion, action: 'isolate', reasonCode: evidence.reasonCode };
}

export function resolveOperationRecovery({
  policyVersion = RECOVERY_POLICY_VERSION,
  candidateEvidence,
  snapshot = {},
  budget,
  effectVerification,
} = {}) {
  const evidence = normalizeOperationEvidence(candidateEvidence, snapshot);
  const decision = decideRecovery({
    policyVersion,
    evidence,
    budget,
    effectVerification,
  });
  return {
    policyVersion,
    policyHash: RECOVERY_POLICY_HASH,
    evidence,
    decision,
    budget,
    normalization: {
      candidate_evidence_hash: recoveryValueHash(candidateEvidence ?? null),
      snapshot_hash: recoveryValueHash(snapshot),
      normalized_evidence_hash: recoveryValueHash(evidence),
    },
    ...(effectVerification ? { effectVerification } : {}),
  };
}
