import { createHash } from 'node:crypto';

function receiptKey(attemptId, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'consolidation_procedural', unitId]))
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
    && receipt.stage === 'consolidation_procedural'
    && receipt.unitId === unit?.unit_id
    && receipt.runnerInputHash === unit?.input_hash
    && isHash(receipt.inputHash)
    && typeof receipt.runnerInputHash === 'string'
    && receipt.runnerInputHash.length > 0;
}

function validFailedOperationReceipt(receipt, unit, attemptId) {
  return Boolean(receipt)
    && receipt.key === receiptKey(attemptId, unit?.unit_id)
    && receipt.version === 1
    && receipt.status === 'failed'
    && receipt.runId === attemptId
    && receipt.stage === 'consolidation_procedural'
    && receipt.unitId === unit?.unit_id
    && receipt.runnerInputHash === unit?.input_hash
    && isHash(receipt.inputHash);
}

const HARD_RECOVERY_CODES = new Set([
  'consolidation_procedural_recovery_identity_conflict',
  'consolidation_procedural_recovery_receipt_unavailable',
  'consolidation_procedural_source_mutation_conflict',
  'consolidation_procedural_committed_result_missing',
  'consolidation_procedural_committed_result_conflict',
  'consolidation_procedural_audit_conflict',
  'consolidation_procedural_committed_audit_missing',
  'consolidation_procedural_terminal_reconciliation_required',
  'consolidation_procedural_contribution_reconciliation_required',
]);

function committedEvidence(data, unit, attemptId) {
  const evidence = data?.proceduralRecoveryEvidence;
  const operationReceipt = data?.operationReceipt;
  const ids = strings(data?.proceduralMemoryIds);
  const expectedReceiptKey = receiptKey(attemptId, unit?.unit_id);
  if (
    data?.success !== true
    || data?.status !== 'succeeded'
    || evidence?.schema !== 'consolidation-procedural-commit/v1'
    || evidence?.kind !== 'committed'
    || evidence?.receiptKey !== expectedReceiptKey
    || evidence?.receiptVersion !== 1
    || evidence?.resultRef !== `procedural-recoveries:${expectedReceiptKey}`
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
      proceduralRecovery: {
        identity: evidence.identity,
        expectedProceduralMemoryIds: [...ids],
      },
    },
    effectVerification: 'all_applied',
  };
}

function noEffectEvidence(data, unit, attemptId) {
  const evidence = data?.proceduralRecoveryEvidence;
  const operationReceipt = data?.operationReceipt;
  const proof = evidence?.proof;
  const expectedReceiptKey = receiptKey(attemptId, unit?.unit_id);
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
    && evidence?.reasonCode === 'no_reusable_procedure'
    && evidence?.identity?.runId === attemptId
    && evidence?.identity?.unitId === unit?.unit_id
    && evidence?.identity?.inputHash === data?.inputHash
    && evidence?.identity?.inputHash === operationReceipt?.inputHash
    && isHash(evidence?.identity?.inputHash)
    && proof?.kind === 'committed_structured_no_effect'
    && proof?.receiptKey === expectedReceiptKey
    && proof?.receiptVersion === 1
    && proof?.schema === 'consolidation-procedural-no-effect/v1'
    && isHash(proof?.proposalHash)
    && proof?.reasonCode === evidence.reasonCode
    && proof?.proofHash === stableHash({
      schema: proof.schema,
      proposalHash: proof.proposalHash,
      reasonCode: proof.reasonCode,
    })
    && Array.isArray(data?.proceduralMemoryIds)
    && data.proceduralMemoryIds.length === 0
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
        receipt: {
          key: expectedReceiptKey,
          version: 1,
          status: operationReceipt.status,
        },
        committedNoEffect,
      },
    };
  }
  if (
    data?.success !== true
    || data?.status !== 'skipped'
    || evidence?.kind !== 'no_effect'
    || evidence?.observation !== 'business_empty'
    || evidence?.reasonCode !== 'fewer_than_2_recurring_patterns'
    || evidence?.identity?.runId !== attemptId
    || evidence?.identity?.unitId !== unit?.unit_id
    || evidence?.identity?.inputHash !== data?.inputHash
    || evidence?.identity?.inputHash !== operationReceipt?.inputHash
    || !isHash(evidence?.identity?.inputHash)
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

export function adaptConsolidationProceduralOperationEvidence({
  result,
  unit,
  attemptId,
} = {}) {
  const data = result?.data || result || {};
  if (
    data?.failure?.class === 'hard'
    && [
      'consolidation_procedural_source_drifted_before_commit',
      'consolidation_procedural_source_correction_requires_migration',
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
  if (
    data?.failure?.class === 'hard'
    && HARD_RECOVERY_CODES.has(data?.failure?.cause)
  ) {
    return {
      candidateEvidence: {
        kind: 'system_fault',
        code: [
          'consolidation_procedural_recovery_identity_conflict',
          'consolidation_procedural_recovery_receipt_unavailable',
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
        : typeof data?.proceduralRecoveryEvidence?.receiptKey === 'string'
          ? data.proceduralRecoveryEvidence.receiptKey
        : receiptKey(attemptId || 'unknown', unit?.unit_id || 'unknown'),
      reasonCode: 'consolidation_procedural_effect_state_unknown',
    },
    snapshot: {
      proceduralRecovery: {
        unitId: unit?.unit_id,
      },
    },
  };
}
