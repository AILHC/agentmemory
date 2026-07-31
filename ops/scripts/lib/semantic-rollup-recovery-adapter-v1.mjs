function isHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function safeReasonCode(result, data) {
  const candidate = data?.error || result?.error;
  return typeof candidate === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(candidate)
    ? candidate
    : 'semantic_rollup_effect_state_unknown';
}

function validIdentity(identity, data, unit, attemptId, operationId, operationReceipt) {
  return Boolean(identity)
    && identity.runId === attemptId
    && identity.unitId === unit?.unit_id
    && identity.receiptInputHash === operationReceipt?.inputHash
    && identity.runnerInputHash === unit?.input_hash
    && identity.extractionRunId === data?.runId
    && identity.extractionWindowId === data?.windowId
    && identity.extractionWindowId === operationId
    && identity.inputHash === data?.inputHash
    && identity.configHash === data?.configHash
    && isHash(identity.receiptInputHash)
    && isHash(identity.runnerInputHash)
    && isHash(identity.inputHash)
    && isHash(identity.configHash);
}

function validOperationReceipt(receipt, unit, attemptId) {
  return Boolean(receipt)
    && /^xop_[0-9a-f]{32}$/.test(receipt.key)
    && receipt.version === 1
    && receipt.status === 'succeeded'
    && receipt.runId === attemptId
    && receipt.stage === 'semantic_rollup'
    && receipt.unitId === unit?.unit_id
    && receipt.runnerInputHash === unit?.input_hash
    && isHash(receipt.inputHash)
    && isHash(receipt.runnerInputHash);
}

function committedEvidence(data, unit, attemptId, operationId) {
  const evidence = data?.semanticRecoveryEvidence;
  const operationReceipt = data?.operationReceipt;
  const ids = data?.semanticMemoryIds;
  const sourceSummaryHashes = evidence?.sourceSummaryHashes;
  if (
    data?.success !== true
    || data?.status !== 'succeeded'
    || evidence?.schema !== 'semantic-rollup-recovery/v1'
    || evidence?.phase !== 'committed'
    || !validIdentity(evidence.identity, data, unit, attemptId, operationId, operationReceipt)
    || evidence.receiptKey !== operationReceipt?.key
    || evidence.receiptVersion !== 1
    || typeof evidence.resultRef !== 'string'
    || !/^mem:audit:[^:]+$/.test(evidence.resultRef)
    || !isHash(evidence.effectHash)
    || !sourceSummaryHashes
    || typeof sourceSummaryHashes !== 'object'
    || Array.isArray(sourceSummaryHashes)
    || Object.values(sourceSummaryHashes).some((hash) => !isHash(hash))
    || stableStringify(sourceSummaryHashes) !== stableStringify(unit?.source_summary_hashes)
    || !Array.isArray(ids)
    || ids.length === 0
    || ids.some((id) => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length
    || !validOperationReceipt(operationReceipt, unit, attemptId)
  ) return null;
  return {
    evidence: {
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
      semanticRollup: {
        identity: evidence.identity,
        expectedSemanticMemoryIds: [...ids],
        sourceSummaryHashes,
        domainCommitResultRef: evidence.resultRef,
      },
    },
    effectVerification: 'all_applied',
  };
}

export function adaptSemanticRollupOperationEvidence({
  result,
  unit,
  attemptId,
  operationId,
}) {
  const data = result?.data || result || {};
  const systemFaultCodes = new Map([
    ['configuration_identity_conflict', 'configuration_identity_conflict'],
    ['semantic_rollup_commit_conflict', 'commit_plan_conflict'],
    ['semantic_rollup_recovery_identity_conflict', 'operation_identity_conflict'],
    ['semantic_rollup_recovery_receipt_unavailable', 'operation_identity_conflict'],
    ['semantic_rollup_runner_input_hash_conflict', 'operation_identity_conflict'],
    ['semantic_rollup_source_summary_drifted', 'operation_identity_conflict'],
  ]);
  const systemFaultCode = data?.failure?.class === 'hard'
    ? systemFaultCodes.get(data?.failure?.cause)
    : undefined;
  let adapted;
  if (systemFaultCode) {
    adapted = {
      evidence: {
        kind: 'system_fault',
        code: systemFaultCode,
      },
      snapshot: {},
    };
  } else {
    adapted = committedEvidence(data, unit, attemptId, operationId);
  }
  if (!adapted) {
    adapted = {
      evidence: {
        kind: 'unknown',
        receiptKey: typeof data?.operationReceipt?.key === 'string'
          ? data.operationReceipt.key
          : typeof data?.semanticRecoveryEvidence?.receiptKey === 'string'
            ? data.semanticRecoveryEvidence.receiptKey
          : `semantic-rollup:${attemptId}:${operationId}`,
        reasonCode: safeReasonCode(result, data),
      },
      snapshot: {
        semanticRollup: {
          operationId,
          unitId: unit?.unit_id,
        },
      },
    };
  }
  return {
    candidateEvidence: adapted.evidence,
    snapshot: adapted.snapshot,
    ...(adapted.effectVerification
      ? { effectVerification: adapted.effectVerification }
      : {}),
  };
}
