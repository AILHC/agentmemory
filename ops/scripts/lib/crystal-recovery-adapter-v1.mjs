function isHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sameOrderedStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => typeof value === 'string' && value === right[index]);
}

function validOperationReceipt(receipt, unit, attemptId) {
  return Boolean(receipt)
    && /^xop_[0-9a-f]{32}$/.test(receipt.key)
    && receipt.version === 1
    && receipt.status === 'succeeded'
    && receipt.runId === attemptId
    && receipt.stage === 'crystal'
    && receipt.unitId === unit?.unit_id
    && receipt.runnerInputHash === unit?.input_hash
    && isHash(receipt.inputHash)
    && isHash(receipt.runnerInputHash);
}

function committedFacts(data, unit, attemptId, operationId) {
  const evidence = data?.crystalRecoveryEvidence;
  const receipt = data?.operationReceipt;
  const ids = data?.crystalIds;
  const actionIds = unit?.action_ids || unit?.actionIds;
  const actionUpdatedAts = unit?.action_updated_ats || unit?.actionUpdatedAts;
  if (
    data?.success !== true
    || evidence?.schema !== 'crystal-recovery/v1'
    || evidence?.phase !== 'committed'
    || evidence?.receiptKey !== receipt?.key
    || evidence?.receiptVersion !== receipt?.version
    || evidence?.identity?.runId !== attemptId
    || evidence?.identity?.unitId !== unit?.unit_id
    || !isHash(evidence?.identity?.inputHash)
    || evidence.identity.inputHash !== receipt?.inputHash
    || evidence?.group?.groupId !== operationId
    || evidence?.group?.groupId !== unit?.unit_id
    || !sameOrderedStrings(evidence?.group?.actionIds, actionIds)
    || !sameOrderedStrings(evidence?.group?.actionUpdatedAts, actionUpdatedAts)
    || !isHash(evidence?.effectHash)
    || !Array.isArray(ids)
    || ids.length !== 1
    || typeof ids[0] !== 'string'
    || evidence.resultRef !== `crystal:${ids[0]}`
    || !validOperationReceipt(receipt, unit, attemptId)
  ) return null;
  return {
    candidateEvidence: {
      kind: 'committed',
      receiptKey: receipt.key,
      receiptVersion: receipt.version,
      resultRef: evidence.resultRef,
      effectHash: evidence.effectHash,
    },
    snapshot: {
      receipt: {
        key: receipt.key,
        version: receipt.version,
        resultRef: evidence.resultRef,
        effectHash: evidence.effectHash,
        status: receipt.status,
      },
      crystal: {
        identity: evidence.identity,
        group: evidence.group,
        expectedCrystalId: ids[0],
      },
    },
    effectVerification: 'all_applied',
  };
}

export function adaptCrystalOperationEvidence({
  result,
  unit,
  attemptId,
  operationId,
}) {
  const data = result?.data || result || {};
  const systemFaultCodes = new Map([
    ['crystal_operation_identity_invalid', 'operation_identity_conflict'],
    ['crystal_plan_identity_invalid', 'operation_identity_conflict'],
    ['crystal_plan_drifted', 'commit_plan_conflict'],
    ['crystal_recovery_receipt_unavailable', 'operation_identity_conflict'],
    ['crystal_recovery_identity_conflict', 'operation_identity_conflict'],
    ['crystal_recovery_plan_conflict', 'commit_plan_conflict'],
    ['crystal_formal_effect_conflict', 'commit_plan_conflict'],
  ]);
  const systemFaultCode = data?.failure?.class === 'hard'
    ? systemFaultCodes.get(data?.failure?.cause)
    : undefined;
  if (systemFaultCode) {
    return {
      candidateEvidence: {
        kind: 'system_fault',
        code: systemFaultCode,
      },
      snapshot: {},
    };
  }
  const committed = committedFacts(data, unit, attemptId, operationId);
  if (committed) return committed;
  return {
    candidateEvidence: {
      kind: 'unknown',
      receiptKey: typeof data?.operationReceipt?.key === 'string'
        ? data.operationReceipt.key
        : `crystal:${attemptId}:${operationId}`,
      reasonCode: 'crystal_effect_state_unknown',
    },
    snapshot: {
      crystal: {
        operationId,
        unitId: unit?.unit_id,
      },
    },
  };
}
