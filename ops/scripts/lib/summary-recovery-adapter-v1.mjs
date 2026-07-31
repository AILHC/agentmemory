import { createHash } from 'node:crypto';

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(sortObject(value))).digest('hex');
}

function receiptKey(attemptId, operationId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'summary', operationId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function summaryFields(summary) {
  return {
    title: summary?.title || '',
    narrative: summary?.narrative || '',
    keyDecisions: summary?.keyDecisions || summary?.decisions || [],
    filesModified: summary?.filesModified || summary?.files || [],
    concepts: summary?.concepts || [],
  };
}

function safeReasonCode(result, data) {
  const candidate = data?.failure?.cause || data?.failureCause || data?.error || result?.error;
  return typeof candidate === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(candidate)
    ? candidate
    : 'summary_operation_failed';
}

function successfulEvidence({ data, unit, attemptId }) {
  if (
    !data?.summary
    || data.attemptId !== attemptId
    || data.runnerInputHash !== unit.input_hash
    || typeof data.serviceInputHash !== 'string'
    || !data.serviceInputHash
    || typeof data.resumableRunId !== 'string'
    || !data.resumableRunId
  ) {
    return null;
  }
  const evidence = data.recoveryEvidence;
  if (
    evidence?.kind !== 'committed'
    || evidence.resultRef !== `mem:summary-resumable:runs:${data.resumableRunId}`
    || evidence.effectHash !== hash(summaryFields(data.summary))
  ) return null;
  return {
    evidence,
    snapshot: {
      receipt: {
        key: evidence.receiptKey,
        version: evidence.receiptVersion,
        resultRef: evidence.resultRef,
        effectHash: evidence.effectHash,
        status: 'succeeded',
      },
    },
    effectVerification: 'all_applied',
  };
}

function noEffectEvidence({ data, observation }) {
  const evidence = data?.recoveryEvidence;
  if (
    evidence?.kind !== 'no_effect'
    || evidence.observation !== observation
  ) return null;
  let snapshot = {};
  if (evidence.proof?.kind === 'receipt_before_formal_effect') {
    snapshot = {
      receipt: {
        key: evidence.proof.receiptKey,
        version: evidence.proof.receiptVersion,
        phase: evidence.proof.phase,
        commitPlanAbsent: true,
        formalEffect: false,
      },
    };
  } else if (evidence.proof?.kind === 'legacy_summary_before_final_write') {
    snapshot = {
      receipt: {
        key: evidence.proof.receiptKey,
        formalEffect: false,
      },
      summaryRun: {
        id: evidence.proof.summaryRunId,
        inputHash: evidence.proof.inputHash,
        completedFinalWrites: evidence.proof.completedFinalWrites,
      },
    };
  }
  return { evidence, snapshot };
}

export function adaptSummaryOperationEvidence({
  result,
  unit,
  attemptId,
  operationId,
}) {
  const data = result?.data || result || {};
  let adapted;

  if (
    (
      typeof data.operationUnitId === 'string'
      && data.operationUnitId !== operationId
    )
    || data?.failure?.cause === 'extraction_operation_input_hash_conflict'
    || data?.failure?.cause === 'summary_operation_identity_conflict'
  ) {
    adapted = {
      evidence: { kind: 'system_fault', code: 'operation_identity_conflict' },
      snapshot: {},
    };
  } else if (data.status === 'succeeded') {
    adapted = successfulEvidence({ data, unit, attemptId });
  } else if (data.status === 'skipped') {
    adapted = noEffectEvidence({
      data,
      observation: 'business_empty',
    });
  } else if (data.status === 'infeasible') {
    adapted = noEffectEvidence({
      data,
      observation: 'business_rejected',
    });
  } else if (data.status === 'preflight_unavailable' || data?.failure?.phase === 'provider_preflight') {
    adapted = noEffectEvidence({
      data,
      observation: data?.recoveryEvidence?.observation || 'execution_error',
    });
  } else if (
    data.status === 'failed'
    && ['execution_error', 'business_empty', 'business_rejected'].includes(
      data?.recoveryEvidence?.observation,
    )
  ) {
    adapted = noEffectEvidence({
      data,
      observation: data.recoveryEvidence.observation,
    });
  }

  if (!adapted) {
    const key = receiptKey(attemptId, operationId);
    adapted = {
      evidence: {
        kind: 'unknown',
        receiptKey: key,
        reasonCode: safeReasonCode(result, data),
      },
    };
  }

  return {
    candidateEvidence: adapted.evidence,
    snapshot: adapted.snapshot || {},
    ...(adapted.effectVerification
      ? { effectVerification: adapted.effectVerification }
      : {}),
  };
}
