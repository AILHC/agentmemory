import { createHash } from 'node:crypto';

function receiptKey(attemptId, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'reflect_insight', unitId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function isHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function stableHash(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item)
    ? value
    : null;
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
    && isHash(receipt.inputHash);
}

function validFailedOperationReceipt(receipt, unit, attemptId) {
  return Boolean(receipt)
    && receipt.key === receiptKey(attemptId, unit?.unit_id)
    && receipt.version === 1
    && receipt.status === 'failed'
    && receipt.runId === attemptId
    && receipt.stage === 'reflect_insight'
    && receipt.unitId === unit?.unit_id
    && receipt.runnerInputHash === unit?.input_hash
    && isHash(receipt.inputHash);
}

const HARD_RECOVERY_CODES = new Set([
  'reflect_insight_recovery_identity_conflict',
  'reflect_insight_recovery_receipt_unavailable',
  'reflect_insight_source_mutation_conflict',
  'reflect_insight_committed_result_missing',
  'reflect_insight_committed_result_conflict',
  'reflect_insight_audit_conflict',
  'reflect_insight_committed_audit_missing',
  'reflect_insight_terminal_reconciliation_required',
  'reflect_insight_contribution_reconciliation_required',
  'reflect_insight_contribution_contract_migration_required',
]);

function committedEvidence(data, unit, attemptId) {
  const evidence = data?.reflectRecoveryEvidence;
  const operationReceipt = data?.operationReceipt;
  const ids = strings(data?.insightIds);
  const expectedReceiptKey = receiptKey(attemptId, unit?.unit_id);
  if (
    data?.success !== true
    || data?.status !== 'succeeded'
    || evidence?.schema !== 'reflect-insight-commit/v1'
    || evidence?.kind !== 'committed'
    || evidence?.receiptKey !== expectedReceiptKey
    || evidence?.receiptVersion !== 1
    || evidence?.resultRef !== `reflect-insight-recoveries:${expectedReceiptKey}`
    || !isHash(evidence?.effectHash)
    || evidence?.identity?.runId !== attemptId
    || evidence?.identity?.unitId !== unit?.unit_id
    || evidence?.identity?.inputHash !== data?.inputHash
    || evidence?.identity?.inputHash !== operationReceipt?.inputHash
    || !isHash(evidence?.identity?.inputHash)
    || !ids
    || ids.length === 0
    || new Set(ids).size !== ids.length
    || !validOperationReceipt(operationReceipt, unit, attemptId)
  ) return null;
  return {
    candidateEvidence: {
      kind: 'committed',
      receiptKey: expectedReceiptKey,
      receiptVersion: 1,
      resultRef: evidence.resultRef,
      effectHash: evidence.effectHash,
    },
    snapshot: {
      receipt: {
        key: expectedReceiptKey,
        version: 1,
        resultRef: evidence.resultRef,
        effectHash: evidence.effectHash,
        status: operationReceipt.status,
      },
      reflectRecovery: {
        identity: evidence.identity,
        expectedInsightIds: [...ids],
      },
    },
    effectVerification: 'all_applied',
  };
}

function noEffectEvidence(data, unit, attemptId) {
  const evidence = data?.reflectRecoveryEvidence;
  const operationReceipt = data?.operationReceipt;
  const proof = evidence?.proof;
  const expectedReceiptKey = receiptKey(attemptId, unit?.unit_id);
  const identityMatches = evidence?.identity?.runId === attemptId
    && evidence?.identity?.unitId === unit?.unit_id
    && evidence?.identity?.inputHash === data?.inputHash
    && evidence?.identity?.inputHash === operationReceipt?.inputHash
    && isHash(evidence?.identity?.inputHash);
  const committedNoEffect = {
    schema: proof?.schema,
    proposalHash: proof?.proposalHash,
    reasonCode: proof?.reasonCode,
    proofHash: proof?.proofHash,
  };
  if (
    data?.success === true
    && data?.status === 'skipped'
    && evidence?.kind === 'no_effect'
    && evidence?.observation === 'business_empty'
    && evidence?.reasonCode === 'no_novel_insight'
    && identityMatches
    && proof?.kind === 'committed_structured_no_effect'
    && proof?.receiptKey === expectedReceiptKey
    && proof?.receiptVersion === 1
    && proof?.schema === 'reflect-insight-no-effect/v1'
    && isHash(proof?.proposalHash)
    && proof?.reasonCode === evidence.reasonCode
    && proof?.proofHash === stableHash({
      schema: proof.schema,
      proposalHash: proof.proposalHash,
      reasonCode: proof.reasonCode,
    })
    && Array.isArray(data?.insightIds)
    && data.insightIds.length === 0
    && validOperationReceipt(operationReceipt, unit, attemptId)
  ) {
    return {
      candidateEvidence: {
        kind: 'no_effect',
        observation: evidence.observation,
        reasonCode: evidence.reasonCode,
        proof: {
          kind: proof.kind,
          receiptKey: expectedReceiptKey,
          receiptVersion: 1,
          ...committedNoEffect,
        },
      },
      snapshot: {
        receipt: { key: expectedReceiptKey, version: 1, status: operationReceipt.status },
        committedNoEffect,
      },
    };
  }
  if (
    data?.success !== true
    || data?.status !== 'skipped'
    || evidence?.kind !== 'no_effect'
    || evidence?.observation !== 'business_empty'
    || evidence?.reasonCode !== 'insufficient_supporting_items'
    || !identityMatches
    || proof?.kind !== 'receipt_before_formal_effect'
    || proof?.receiptKey !== expectedReceiptKey
    || proof?.receiptVersion !== 1
    || proof?.phase !== 'candidate_staging'
    || proof?.commitPlanAbsent !== true
    || !validOperationReceipt(operationReceipt, unit, attemptId)
  ) return null;
  return {
    candidateEvidence: {
      kind: 'no_effect',
      observation: evidence.observation,
      reasonCode: evidence.reasonCode,
      proof: {
        kind: 'receipt_before_formal_effect',
        receiptKey: expectedReceiptKey,
        receiptVersion: 1,
        phase: 'candidate_staging',
        commitPlanAbsent: true,
      },
    },
    snapshot: {
      receipt: {
        key: expectedReceiptKey,
        version: 1,
        phase: 'candidate_staging',
        commitPlanAbsent: true,
        formalEffect: false,
      },
    },
  };
}

export function adaptReflectInsightOperationEvidence({ result, unit, attemptId } = {}) {
  const data = result?.data || result || {};
  if (
    data?.failure?.class === 'hard'
    && [
      'reflect_insight_source_drifted_before_commit',
      'reflect_insight_source_correction_requires_migration',
    ].includes(data?.failure?.cause)
    && validFailedOperationReceipt(data?.operationReceipt, unit, attemptId)
  ) {
    return {
      candidateEvidence: {
        kind: 'no_effect',
        observation: 'business_rejected',
        reasonCode: data.failure.cause,
        proof: {
          kind: 'receipt_before_formal_effect',
          receiptKey: data.operationReceipt.key,
          receiptVersion: 1,
          phase: 'candidate_staging',
          commitPlanAbsent: true,
        },
      },
      snapshot: {
        receipt: {
          key: data.operationReceipt.key,
          version: 1,
          phase: 'candidate_staging',
          commitPlanAbsent: true,
          formalEffect: false,
        },
      },
    };
  }
  if (data?.failure?.class === 'hard' && HARD_RECOVERY_CODES.has(data?.failure?.cause)) {
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
  const committed = committedEvidence(data, unit, attemptId);
  if (committed) return committed;
  const noEffect = noEffectEvidence(data, unit, attemptId);
  if (noEffect) return noEffect;
  return {
    candidateEvidence: {
      kind: 'unknown',
      receiptKey: typeof data?.operationReceipt?.key === 'string'
        ? data.operationReceipt.key
        : typeof data?.reflectRecoveryEvidence?.receiptKey === 'string'
          ? data.reflectRecoveryEvidence.receiptKey
          : receiptKey(attemptId || 'unknown', unit?.unit_id || 'unknown'),
      reasonCode: 'reflect_insight_effect_unknown',
    },
    snapshot: { reflectRecovery: { unitId: unit?.unit_id } },
  };
}
