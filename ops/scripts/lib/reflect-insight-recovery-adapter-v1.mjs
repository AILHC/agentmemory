import { createHash } from 'node:crypto';

function receiptKey(attemptId, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'reflect_insight', unitId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function validCommittedEvidence(value) {
  return value
    && value.schema === 'reflect-insight-commit/v1'
    && value.kind === 'committed'
    && typeof value.receiptKey === 'string' && value.receiptKey
    && value.receiptVersion === 1
    && typeof value.resultRef === 'string' && value.resultRef
    && typeof value.effectHash === 'string' && /^[0-9a-f]{64}$/.test(value.effectHash);
}

function validNoEffectEvidence(value) {
  const proof = value?.proof;
  return value
    && value.kind === 'no_effect'
    && value.observation === 'business_empty'
    && value.reasonCode === 'insufficient_supporting_items'
    && proof?.kind === 'receipt_before_formal_effect'
    && typeof proof.receiptKey === 'string' && proof.receiptKey
    && proof.receiptVersion === 1
    && proof.phase === 'candidate_staging'
    && proof.commitPlanAbsent === true;
}

function validOperationReceipt(receipt, unit, attemptId) {
  return Boolean(receipt)
    && receipt.key === receiptKey(attemptId, unit?.unit_id)
    && receipt.version === 1
    && receipt.status === 'succeeded'
    && receipt.runId === attemptId
    && receipt.stage === 'reflect_insight'
    && receipt.unitId === unit?.unit_id
    && receipt.runnerInputHash === unit?.input_hash
    && typeof receipt.inputHash === 'string'
    && /^[0-9a-f]{64}$/.test(receipt.inputHash);
}

const HARD_RECOVERY_CODES = new Set([
  'reflect_insight_recovery_identity_conflict',
  'reflect_insight_recovery_receipt_unavailable',
  'reflect_insight_source_mutation_conflict',
  'reflect_insight_committed_result_missing',
  'reflect_insight_committed_result_conflict',
  'reflect_insight_audit_conflict',
  'reflect_insight_committed_audit_missing',
]);

export function adaptReflectInsightOperationEvidence({ result, unit, attemptId } = {}) {
  const data = result?.data || result || {};
  const fallbackReceiptKey = receiptKey(attemptId || 'unknown', unit?.unit_id || 'unknown');
  if (
    data?.failure?.class === 'hard'
    && HARD_RECOVERY_CODES.has(data?.failure?.cause)
  ) {
    return {
      candidateEvidence: {
        kind: 'system_fault',
        code: [
          'reflect_insight_recovery_identity_conflict',
          'reflect_insight_recovery_receipt_unavailable',
        ].includes(data.failure.cause)
          ? 'operation_identity_conflict'
          : 'commit_plan_conflict',
      },
      snapshot: {},
    };
  }
  const evidence = data.reflectRecoveryEvidence;
  const operationReceipt = data.operationReceipt;
  if (
    data.status === 'succeeded'
    && validCommittedEvidence(evidence)
    && validOperationReceipt(operationReceipt, unit, attemptId)
    && evidence.receiptKey === operationReceipt.key
  ) {
    return {
      candidateEvidence: {
        kind: 'committed',
        receiptKey: operationReceipt.key,
        receiptVersion: operationReceipt.version,
        resultRef: evidence.resultRef,
        effectHash: evidence.effectHash,
      },
      snapshot: {
        receipt: {
          key: operationReceipt.key,
          version: operationReceipt.version,
          resultRef: evidence.resultRef,
          effectHash: evidence.effectHash,
          status: operationReceipt.status,
        },
      },
      effectVerification: 'all_applied',
    };
  }
  if (
    data.status === 'skipped'
    && validNoEffectEvidence(evidence)
    && validOperationReceipt(operationReceipt, unit, attemptId)
    && evidence.proof.receiptKey === operationReceipt.key
  ) {
    return {
      candidateEvidence: {
        kind: 'no_effect',
        observation: evidence.observation,
        reasonCode: evidence.reasonCode,
        proof: evidence.proof,
      },
      snapshot: {
        receipt: {
          key: evidence.proof.receiptKey,
          version: evidence.proof.receiptVersion,
          phase: evidence.proof.phase,
          commitPlanAbsent: true,
          formalEffect: false,
        },
      },
    };
  }
  return {
    candidateEvidence: {
      kind: 'unknown',
      receiptKey: typeof operationReceipt?.key === 'string'
        ? operationReceipt.key
        : typeof evidence?.receiptKey === 'string'
          ? evidence.receiptKey
          : fallbackReceiptKey,
      reasonCode: 'reflect_insight_effect_unknown',
    },
    snapshot: {},
  };
}
