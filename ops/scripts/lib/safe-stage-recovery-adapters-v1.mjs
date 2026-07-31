import { createHash } from 'node:crypto';

const STAGES = new Map([
  ['memory_consolidate', {
    resultField: 'memoryIds',
    resultRef: 'memories',
    commitFunction: 'mem::full-memory-consolidate-window-commit',
    domainEffectSchema: 'memory-consolidate-domain-effect/v1',
    noEffect: (response) => response?.status === 'skipped' && response?.consolidated === 0,
    noEffectReason: 'insufficient_observations',
  }],
  ['skill_extract', {
    resultField: 'proceduralMemoryIds',
    resultRef: 'procedural-memories',
    commitFunction: 'mem::full-skill-extract-commit',
    domainEffectSchema: 'skill-extract-domain-effect/v1',
    noEffect: (response) => response?.status === 'skipped' && response?.extracted === false,
    noEffectReason: 'no_clear_procedure_found',
  }],
]);

const STRUCTURED_HARD_FAILURES = new Map([
  ['memory_consolidate', new Map([
    ['proposal_not_found', 'receipt_integrity_error'],
    ['proposal_identity_conflict', 'operation_identity_conflict'],
    ['extraction_operation_input_hash_conflict', 'operation_identity_conflict'],
    ['memory_consolidate_committed_effect_missing', 'receipt_integrity_error'],
    ['memory_consolidate_committed_effect_conflict', 'commit_plan_conflict'],
  ])],
  ['skill_extract', new Map([
    ['proposal_not_found', 'receipt_integrity_error'],
    ['proposal_identity_conflict', 'operation_identity_conflict'],
    ['extraction_operation_input_hash_conflict', 'operation_identity_conflict'],
    ['skill_extract_committed_effect_missing', 'receipt_integrity_error'],
    ['skill_extract_committed_effect_conflict', 'commit_plan_conflict'],
    ['skill_proposal_missing_candidate', 'commit_plan_conflict'],
  ])],
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, child]) => [key, canonical(child)]));
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function valueAt(record, camel, snake) {
  return record?.[camel] ?? record?.[snake];
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

function commitInputHash(unitId, commitContext) {
  return hash({
    prepareRunId: commitContext.prepareAttemptId,
    unitId,
    prepareInputHash: commitContext.prepareInputHash,
    preparedHandle: commitContext.preparedHandle,
    proposalHash: commitContext.proposalHash,
  });
}

function receiptKey(attemptId, stage, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, stage, unitId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function factsFrom(input) {
  return input?.safeFacts || input?.recoverySnapshot || input?.facts || {};
}

function responseFrom(input, facts) {
  return facts.response || input?.result?.data || input?.result || {};
}

function unknown({ stage, attemptId, unitId, facts, reasonCode = 'safe_stage_effect_unknown' }) {
  return {
    candidateEvidence: {
      kind: 'unknown',
      receiptKey: nonEmpty(facts?.receipt?.key)
        ? facts.receipt.key
        : receiptKey(attemptId, stage, unitId),
      reasonCode,
    },
    snapshot: {},
  };
}

function systemFault(code) {
  return {
    candidateEvidence: {
      kind: 'system_fault',
      code,
    },
    snapshot: {},
  };
}

function structuredHardFailure(stage, response) {
  const failure = response?.failure;
  if (
    !failure
    || failure.class !== 'hard'
    || typeof failure.cause !== 'string'
  ) return null;
  const code = STRUCTURED_HARD_FAILURES.get(stage)?.get(failure.cause);
  return code ? systemFault(code) : null;
}

function receiptIdentityMatches(receipt, { stage, attemptId, unitId, inputHash }) {
  return (
    receipt
    && receipt.key === receiptKey(attemptId, stage, unitId)
    && receipt.version === 1
    && receipt.stage === stage
    && receipt.runId === attemptId
    && receipt.unitId === unitId
    && receipt.inputHash === inputHash
  );
}

function proposalIdentityConflicts(proposal, { stage, inputHash }) {
  return proposal && (
    proposal.stage !== stage
    || proposal.inputHash !== inputHash
    || !nonEmpty(proposal.key)
    || !nonEmpty(proposal.handle)
    || !nonEmpty(proposal.proposalHash)
  );
}

function committedFacts({ stage, stageSpec, unit, attemptId, facts, response }) {
  const proposal = facts.proposal;
  const intent = proposal?.commitIntent;
  const result = facts.result;
  const audit = facts.audit;
  const receipt = facts.receipt;
  const resultIds = strings(valueAt(response, stageSpec.resultField, stageSpec.resultField.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)));
  if (!proposal || proposal.status !== 'committed') return null;
  if (!intent || !nonEmpty(intent.resultId) || !nonEmpty(intent.auditId) || !nonEmpty(intent.createdAt)) return null;
  if (!result || result.id !== intent.resultId) return null;
  if (!audit || audit.id !== intent.auditId || audit.functionId !== stageSpec.commitFunction) return null;
  if (!strings(audit.targetIds)?.includes(intent.resultId)) return null;
  if (response?.status !== 'succeeded' || !resultIds?.includes(intent.resultId)) return null;
  if (!receiptIdentityMatches(receipt, {
    stage,
    attemptId,
    unitId: unit.unit_id,
    inputHash: unit.input_hash,
  })) return null;

  const resultRef = `${stageSpec.resultRef}:${intent.resultId}`;
  const effectHash = hash({
    stage,
    proposal: {
      key: proposal.key,
      handle: proposal.handle,
      proposalHash: proposal.proposalHash,
      inputHash: proposal.inputHash,
    },
    commitIntent: {
      resultId: intent.resultId,
      auditId: intent.auditId,
      createdAt: intent.createdAt,
    },
    result: { id: result.id },
    audit: { id: audit.id, targetIds: audit.targetIds },
  });
  return {
    candidateEvidence: {
      kind: 'committed',
      receiptKey: receipt.key,
      receiptVersion: receipt.version,
      resultRef,
      effectHash,
    },
    snapshot: {
      receipt: {
        key: receipt.key,
        version: receipt.version,
        resultRef,
        effectHash,
        status: 'committed',
      },
      proposal: {
        key: proposal.key,
        proposalHash: proposal.proposalHash,
        status: proposal.status,
      },
      commitIntent: {
        resultId: intent.resultId,
        auditId: intent.auditId,
      },
      result: { id: result.id },
      audit: { id: audit.id, targetIds: audit.targetIds },
    },
    effectVerification: 'all_applied',
  };
}

function receiptBoundCommittedFacts({
  stage,
  stageSpec,
  unit,
  attemptId,
  facts,
  response,
}) {
  const receipt = facts.receipt || response?.operationReceipt;
  const commitContext = facts.commitContext;
  const domainEffect = valueAt(response, 'domainEffectEvidence', 'domain_effect_evidence');
  const resultIds = strings(valueAt(
    response,
    stageSpec.resultField,
    stageSpec.resultField.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ));
  if (
    response?.success !== true
    || response?.status !== 'succeeded'
    || !resultIds
    || resultIds.length !== 1
    || !receiptIdentityMatches(receipt, {
      stage,
      attemptId,
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    })
    || receipt.status !== 'succeeded'
    || !nonEmpty(commitContext?.preparedHandle)
    || !nonEmpty(commitContext?.proposalHash)
    || !nonEmpty(commitContext?.prepareAttemptId)
    || !nonEmpty(commitContext?.prepareInputHash)
    || unit.input_hash !== commitInputHash(unit.unit_id, commitContext)
    || !domainEffect
    || Object.keys(domainEffect).sort().join(',') !== 'auditId,effectHash,proposalHash,resultId,schema'
    || domainEffect.schema !== stageSpec.domainEffectSchema
    || domainEffect.proposalHash !== commitContext.proposalHash
    || domainEffect.resultId !== resultIds[0]
    || !nonEmpty(domainEffect.auditId)
    || !/^[0-9a-f]{64}$/.test(domainEffect.effectHash)
  ) return null;
  const resultRef = `${stageSpec.resultRef}:${domainEffect.resultId}`;
  const effectHash = domainEffect.effectHash;
  return {
    candidateEvidence: {
      kind: 'committed',
      receiptKey: receipt.key,
      receiptVersion: receipt.version,
      resultRef,
      effectHash,
    },
    snapshot: {
      receipt: {
        key: receipt.key,
        version: receipt.version,
        resultRef,
        effectHash,
        status: receipt.status,
      },
      commit: {
        ...commitContext,
        resultIds,
      },
      domainEffect: { ...domainEffect },
    },
    effectVerification: 'all_applied',
  };
}

function receiptBoundCommittingFacts({
  stage,
  unit,
  attemptId,
  facts,
  response,
}) {
  const receipt = facts.receipt || response?.operationReceipt;
  const commitContext = facts.commitContext;
  if (
    receipt?.status !== 'running'
    || !receiptIdentityMatches(receipt, {
      stage,
      attemptId,
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    })
    || !nonEmpty(commitContext?.preparedHandle)
    || !nonEmpty(commitContext?.proposalHash)
    || !nonEmpty(commitContext?.prepareAttemptId)
    || !nonEmpty(commitContext?.prepareInputHash)
    || unit.input_hash !== commitInputHash(unit.unit_id, commitContext)
  ) return null;
  const commitPlanRef = `${stage}:${commitContext.preparedHandle}`;
  const effectHash = hash({
    stage,
    receipt: {
      key: receipt.key,
      version: receipt.version,
      inputHash: receipt.inputHash,
    },
    commitContext,
  });
  return {
    candidateEvidence: {
      kind: 'committing',
      commitPlanRef,
      effectHash,
    },
    snapshot: {
      receipt: {
        key: receipt.key,
        version: receipt.version,
        status: receipt.status,
      },
      commit: { ...commitContext },
    },
  };
}

function noEffectFacts({ stage, stageSpec, unit, attemptId, facts, response }) {
  const receipt = facts.receipt;
  const proposal = facts.proposal;
  if (
    !stageSpec.noEffect(response)
    || !receiptIdentityMatches(receipt, {
      stage,
      attemptId,
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    })
    || !['preflight', 'provider_call', 'candidate_staging'].includes(receipt.phase)
    || receipt.commitPlanAbsent !== true
    || receipt.formalEffect === true
    || facts.result !== undefined
    || facts.audit !== undefined
    || proposal?.commitIntent !== undefined
  ) return null;
  return {
    candidateEvidence: {
      kind: 'no_effect',
      observation: 'business_empty',
      reasonCode: stageSpec.noEffectReason,
      proof: {
        kind: 'receipt_before_formal_effect',
        receiptKey: receipt.key,
        receiptVersion: receipt.version,
        phase: receipt.phase,
        commitPlanAbsent: true,
      },
    },
    snapshot: {
      receipt: {
        key: receipt.key,
        version: receipt.version,
        phase: receipt.phase,
        commitPlanAbsent: true,
        formalEffect: false,
      },
      ...(proposal ? {
        proposal: {
          key: proposal.key,
          proposalHash: proposal.proposalHash,
          status: proposal.status,
        },
      } : {}),
    },
  };
}

/**
 * 将已采集的持久化事实映射为恢复策略的输入；不作恢复决策，也不写入任何状态。
 */
export function adaptSafeStageOperationEvidence({
  stage,
  unit,
  attemptId,
  safeFacts,
  recoverySnapshot,
  facts,
  result,
} = {}) {
  const stageSpec = STAGES.get(stage);
  if (!stageSpec || !unit || !nonEmpty(unit.unit_id) || !nonEmpty(unit.input_hash) || !nonEmpty(attemptId)) {
    return unknown({
      stage: typeof stage === 'string' ? stage : 'unknown',
      attemptId: typeof attemptId === 'string' ? attemptId : 'unknown',
      unitId: unit?.unit_id || 'unknown',
      facts: {},
      reasonCode: 'safe_stage_adapter_input_invalid',
    });
  }
  const input = { safeFacts, recoverySnapshot, facts, result };
  const collected = factsFrom(input);
  const response = responseFrom(input, collected);
  const hardFailure = structuredHardFailure(stage, response);
  if (hardFailure) return hardFailure;
  if (proposalIdentityConflicts(collected.proposal, { stage, inputHash: unit.input_hash })) {
    return systemFault('operation_identity_conflict');
  }
  const receiptBoundCommitting = receiptBoundCommittingFacts({
    stage,
    unit,
    attemptId,
    facts: collected,
    response,
  });
  if (receiptBoundCommitting) return receiptBoundCommitting;
  const receiptBoundCommitted = receiptBoundCommittedFacts({
    stage,
    stageSpec,
    unit,
    attemptId,
    facts: collected,
    response,
  });
  if (receiptBoundCommitted) return receiptBoundCommitted;
  const noEffect = noEffectFacts({
    stage,
    stageSpec,
    unit,
    attemptId,
    facts: collected,
    response,
  });
  if (noEffect) return noEffect;
  return unknown({ stage, attemptId, unitId: unit.unit_id, facts: collected });
}

export function adaptMemoryConsolidateOperationEvidence(input) {
  return adaptSafeStageOperationEvidence({ ...input, stage: 'memory_consolidate' });
}

export function adaptSkillExtractOperationEvidence(input) {
  return adaptSafeStageOperationEvidence({ ...input, stage: 'skill_extract' });
}
