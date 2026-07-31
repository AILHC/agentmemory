import {
  adaptCrystalOperationEvidence,
} from './crystal-recovery-adapter-v1.mjs';
import {
  adaptSemanticRollupOperationEvidence,
} from './semantic-rollup-recovery-adapter-v1.mjs';
import {
  adaptMemoryConsolidateOperationEvidence,
  adaptSkillExtractOperationEvidence,
} from './safe-stage-recovery-adapters-v1.mjs';
import {
  adaptReflectInsightOperationEvidence,
} from './reflect-insight-recovery-adapter-v1.mjs';
import {
  adaptConsolidationProceduralOperationEvidence,
} from './consolidation-procedural-recovery-adapter-v1.mjs';

function firstArray(value, keys) {
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function responseData(response) {
  if (!response || typeof response !== 'object') return response ?? null;
  if (Object.prototype.hasOwnProperty.call(response, 'data')) return response.data;
  if (Object.prototype.hasOwnProperty.call(response, 'response')) return response.response;
  return response;
}

export function extractionOperationReconciliationBinding(
  response,
  {
    attemptId,
    stage,
    unitId,
    runnerInputHash,
    expectedReceiptInputHash,
    stableHash,
  },
) {
  const receipt = responseData(response)?.operationReceipt;
  const expectedKey = `xop_${stableHash([attemptId, stage, unitId]).slice(0, 32)}`;
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || receipt.key !== expectedKey
    || receipt.version !== 1
    || receipt.status !== 'running'
    || receipt.runId !== attemptId
    || receipt.stage !== stage
    || receipt.unitId !== unitId
    || receipt.runnerInputHash !== runnerInputHash
    || !/^[0-9a-f]{64}$/.test(String(receipt.inputHash || ''))
    || (
      expectedReceiptInputHash !== undefined
      && receipt.inputHash !== expectedReceiptInputHash
    )
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      String(receipt.startedAt || ''),
    )
    || Number.isNaN(Date.parse(receipt.startedAt))
  ) return null;
  return {
    receipt_key: receipt.key,
    receipt_run_id: receipt.runId,
    receipt_stage: receipt.stage,
    receipt_unit_id: receipt.unitId,
    receipt_input_hash: receipt.inputHash,
    receipt_started_at: receipt.startedAt,
  };
}

export function exactExtractionOperationReceiptAbsence(
  response,
  {
    attemptId,
    stage,
    unitId,
    runnerInputHash,
    stableHash,
  },
) {
  const data = responseData(response);
  const absence = data?.operationReceiptAbsence;
  const observedAt = String(absence?.observedAt || '');
  const expectedKey = `xop_${stableHash([attemptId, stage, unitId]).slice(0, 32)}`;
  const matches = failureCause(response, data) === 'extraction_operation_reconciliation_required'
    && absence
    && typeof absence === 'object'
    && !Array.isArray(absence)
    && Object.keys(absence).sort().join(',')
      === 'inputHash,key,observedAt,runId,runnerInputHash,schema,stage,unitId'
    && absence.schema === 'extraction-operation-receipt-absence/v1'
    && absence.key === expectedKey
    && absence.runId === attemptId
    && absence.stage === stage
    && absence.unitId === unitId
    && absence.runnerInputHash === runnerInputHash
    && /^[0-9a-f]{64}$/.test(String(absence.inputHash || ''))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
    && !Number.isNaN(Date.parse(observedAt));
  return matches ? absence : null;
}

export function matchesExtractionOperationReceiptAbsence(response, expected) {
  return exactExtractionOperationReceiptAbsence(response, expected) !== null;
}

function failureCause(response, data = responseData(response)) {
  return data?.failure?.cause
    || data?.failure?.error
    || data?.failureCause
    || data?.failure_cause
    || data?.error
    || response?.error
    || null;
}

function inputTooLarge(response) {
  const data = responseData(response);
  return /input_too_large/i.test(JSON.stringify({
    error: response?.error,
    code: data?.code,
    reason: data?.reason,
    dataError: data?.error,
  }));
}

function resultIdsFromData(data, resultFields) {
  const direct = firstArray(data, resultFields);
  if (direct.length > 0) return direct;
  return firstArray(data, ['groups', 'items', 'units'])
    .flatMap((item) => firstArray(item, resultFields));
}

function hasResultField(data, resultFields) {
  if (resultFields.some((field) => Array.isArray(data?.[field]))) return true;
  return firstArray(data, ['groups', 'items', 'units'])
    .some((item) => resultFields.some((field) => Array.isArray(item?.[field])));
}

export function classifyResponse(response, resultFields) {
  const statusCode = Number(response?.status_code ?? response?.statusCode ?? 0);
  const data = responseData(response);
  const cause = failureCause(response, data);
  if (cause === 'extraction_operation_reconciliation_required') {
    return { status: 'blocked', reason: cause, payload: { error: cause } };
  }
  if (response?.ok === false && statusCode === 0) {
    return {
      status: 'blocked',
      reason: 'request_transport_failed',
      payload: { error: 'request_transport_failed' },
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'failed', payload: { error: 'invalid_stage_response' } };
  }
  const text = [
    data?.status,
    data?.result,
    data?.reason,
    data?.error,
    response?.error,
  ].filter(Boolean).join(' ').toLowerCase();
  const resultIds = resultIdsFromData(data, resultFields);
  const declaredStatus = typeof data.status === 'string'
    ? data.status.toLowerCase()
    : (typeof data.result === 'string' ? data.result.toLowerCase() : '');
  const successfulStatuses = ['succeeded', 'committed', 'completed'];
  if (response?.ok === false) {
    return { status: 'failed', payload: { error: cause || 'stage request failed' } };
  }
  if (cause || data.failure) {
    return { status: 'failed', payload: { error: cause || 'stage request failed' } };
  }
  if (
    declaredStatus
    && ![...successfulStatuses, 'skipped'].includes(declaredStatus)
  ) {
    return { status: 'failed', payload: { error: 'invalid_stage_response' } };
  }
  if (
    data.success === true
    && (data.skipped === true || declaredStatus === 'skipped')
  ) {
    return {
      status: 'skipped',
      payload: { result_ids: resultIds, reason: data?.reason || data?.status || 'skipped' },
    };
  }
  if (
    data.success === false
    || /failed|error|infeasible/.test(text)
  ) {
    return { status: 'failed', payload: { error: cause || 'stage request failed' } };
  }
  if (
    data.success !== true
    && !successfulStatuses.includes(declaredStatus)
    && !hasResultField(data, resultFields)
  ) {
    return { status: 'failed', payload: { error: 'invalid_stage_response' } };
  }
  return { status: 'succeeded', payload: { result_ids: resultIds } };
}

export function classifyIdempotentCommitResponse(response, resultFields) {
  const statusCode = Number(response?.status_code ?? response?.statusCode ?? 0);
  const data = responseData(response);
  if (
    (response?.ok === false && statusCode === 0)
    || data?.retrySameIdentity === true
    || data?.retry_same_identity === true
  ) {
    return { status: 'pending' };
  }
  return classifyResponse(response, resultFields);
}

export async function executeReceiptAwareRequest({
  recovered,
  invoke,
  acceptReceiptAbsence = () => false,
}) {
  let requireExistingReceipt = recovered;
  let absenceConsumed = false;
  let expectedReceiptInputHash;
  let freshDispatchCount = 0;
  for (let requestCount = 0; requestCount < 3; requestCount += 1) {
    if (!requireExistingReceipt) freshDispatchCount += 1;
    const response = await invoke(requireExistingReceipt, expectedReceiptInputHash);
    const absence = requireExistingReceipt ? acceptReceiptAbsence(response) : null;
    if (
      absence
      && typeof absence === 'object'
      && /^[0-9a-f]{64}$/.test(String(absence.inputHash || ''))
      && !absenceConsumed
      && freshDispatchCount < 2
    ) {
      absenceConsumed = true;
      expectedReceiptInputHash = absence.inputHash;
      requireExistingReceipt = false;
      continue;
    }
    const rawStatusCode = response?.status_code ?? response?.statusCode;
    const statusCode = Number(rawStatusCode);
    const dispatchUncertain = response?.ok === false
      && rawStatusCode !== undefined
      && [0, 500, 502, 504].includes(statusCode);
    if (!dispatchUncertain) return { response, expectedReceiptInputHash };
    if (requireExistingReceipt) return { pending: true };
    if (absenceConsumed || freshDispatchCount >= 2) return { pending: true };
    requireExistingReceipt = true;
  }
  return { pending: true };
}

function normalizePlanItems(data) {
  return firstArray(data, ['windows', 'units', 'items', 'groups'])
    .concat(firstArray(data?.plan, ['windows', 'units', 'items', 'groups']));
}

function normalizePlanUnit(item, index, prefix, stableHash) {
  const sourceIds = firstArray(item, [
    'sourceIds',
    'source_ids',
    'sourceObservationIds',
    'source_observation_ids',
    'observationIds',
    'observation_ids',
    'sessionIds',
    'session_ids',
    'semanticMemoryIds',
    'semantic_memory_ids',
    'lessonIds',
    'lesson_ids',
    'crystalIds',
    'crystal_ids',
    'actionIds',
    'action_ids',
    'memoryIds',
    'memory_ids',
    'patternMemoryIds',
    'pattern_memory_ids',
  ]);
  const unitId = item?.unitId
    || item?.unit_id
    || item?.windowId
    || item?.window_id
    || item?.groupId
    || item?.group_id
    || item?.id
    || `${prefix}${String(index + 1).padStart(4, '0')}`;
  return {
    ...item,
    unit_id: unitId,
    window_id: item?.windowId || item?.window_id || unitId,
    source_ids: sourceIds,
    action_ids: firstArray(item, ['actionIds', 'action_ids']),
    action_updated_ats: firstArray(item, ['actionUpdatedAts', 'action_updated_ats']),
    source_count: Number(item?.sourceCount || item?.source_count || sourceIds.length || 0),
    input_hash: item?.inputHash || item?.input_hash || stableHash({ unitId, sourceIds }),
  };
}

function noneUnit(reason, stableHash) {
  return {
    unit_id: 'none',
    source_ids: [],
    input_hash: stableHash({ reason }),
    skip_reason: reason,
  };
}

function planOrNone(units, reason, stableHash) {
  return units.length > 0 ? units : [noneUnit(reason, stableHash)];
}

function buildFormalBody({ stage, unit, attemptId, inputHash = unit.input_hash, payload = {} }) {
  return {
    ...payload,
    runId: attemptId,
    stage,
    unitId: unit.unit_id,
    inputHash,
  };
}

function modelBody(payload, options, stage) {
  const configured = options?.stageModels?.[stage]
    || options?.[{
      memory_consolidate: 'memoryConsolidateModel',
      semantic_rollup: 'semanticRollupModel',
      skill_extract: 'skillExtractModel',
      crystal: 'crystalModel',
      consolidation_procedural: 'proceduralModel',
      reflect_insight: 'reflectInsightModel',
    }[stage]]
    || options?.defaultStageModel;
  return configured ? { ...payload, model: configured } : payload;
}

function recordAdapter({ request, runId, mark, stage, resultType }) {
  return async ({ unit, terminal }) => {
    const response = await request('/agentmemory/extraction-runs/record', {
      runId,
      mark,
      status: terminal.status,
      stage,
      unitId: unit.unit_id,
      sourceIds: unit.source_ids || [],
      resultIds: terminal.result_ids || [],
      resultType,
    });
    if (response?.ok === false || responseData(response)?.success === false) {
      throw new Error(failureCause(response) || `${stage}_record_failed`);
    }
  };
}

function singleAdapter({
  stage,
  endpoint,
  resultFields,
  resultType,
  request,
  runId,
  mark,
  stableHash,
  buildPayload,
  splitUnit,
  idempotentCommit = false,
  adaptRecoveryEvidence,
}) {
  const classify = (response) => (
    idempotentCommit
      ? classifyIdempotentCommitResponse(response, resultFields)
      : classifyResponse(response, resultFields)
  );
  const receiptExpectation = ({
    unit,
    attemptId,
    runnerInputHash = unit.input_hash,
    expectedReceiptInputHash,
  }) => ({
    attemptId,
    stage,
    unitId: unit.unit_id,
    runnerInputHash,
    expectedReceiptInputHash,
    stableHash,
  });
  const invoke = ({
    unit,
    attemptId,
    requireExistingReceipt,
    expectedReceiptInputHash,
  }) => request(
    endpoint,
    buildFormalBody({
      stage,
      unit,
      attemptId,
      payload: {
        ...buildPayload(unit),
        ...(requireExistingReceipt ? { requireExistingReceipt: true } : {}),
        ...(expectedReceiptInputHash ? { expectedReceiptInputHash } : {}),
      },
    }),
  );
  const terminalMatches = (classified, terminal) => (
    classified.status === terminal?.status
    && JSON.stringify(classified.payload?.result_ids || [])
      === JSON.stringify(terminal?.result_ids || terminal?.payload?.result_ids || [])
    && (
      classified.status !== 'skipped'
      || classified.payload?.reason === (terminal?.reason || terminal?.payload?.reason)
    )
  );
  const blockedFromRecovery = (recovery, fallback, response, expected) => {
    const reconciliationBinding = extractionOperationReconciliationBinding(
      response,
      expected,
    );
    return {
      status: 'blocked',
      reason: recovery.decision.code || fallback,
      payload: { error: recovery.decision.code || fallback },
      recovery,
      ...(reconciliationBinding ? { reconciliationBinding } : {}),
    };
  };
  return {
    attemptIdForUnit: (unit) => stableHash({
      run_id: runId,
      stage,
      unit_id: unit.unit_id,
      phase: 'execute',
    }),
    ...(adaptRecoveryEvidence ? {
      verifyRecoveredTerminal: async ({
        unit,
        attemptId,
        terminal,
        completedOperations,
      }) => {
        const operationId = completedOperations.at(-1)?.operation_id || unit.unit_id;
        const result = await invoke({
          unit,
          attemptId,
          requireExistingReceipt: true,
        });
        const classified = classify(result);
        return {
          recoveryCandidate: adaptRecoveryEvidence({
            result: terminalMatches(classified, terminal)
              ? result
              : {
                  ok: false,
                  data: {
                    error: `${stage}_recovered_terminal_unverified`,
                  },
                },
            unit,
            attemptId,
            operationId,
          }),
        };
      },
    } : {}),
    execute: async ({
      unit,
      attemptId,
      recovered,
      activeOperation,
      completedOperations = [],
      startOperation,
      completeOperation,
      resolveOutcome,
    }) => {
      if (unit.skip_reason) {
        return { status: 'skipped', payload: { reason: unit.skip_reason, result_ids: [] } };
      }
      const recoveryEnabled = Boolean(
        adaptRecoveryEvidence
        && startOperation
        && completeOperation
        && resolveOutcome,
      );
      const operationId = activeOperation?.operation_id
        || completedOperations.at(-1)?.operation_id
        || unit.unit_id;
      const completedTerminal = completedOperations.at(-1)?.terminal_result;
      if (recoveryEnabled && completedTerminal) {
        const result = await invoke({
          unit,
          attemptId,
          requireExistingReceipt: true,
        });
        const classified = classify(result);
        const recovery = await resolveOutcome({
          operationId,
          verification: true,
          ...adaptRecoveryEvidence({
            result: terminalMatches(classified, completedTerminal)
              ? result
              : {
                  ok: false,
                  data: {
                    error: `${stage}_recovered_terminal_unverified`,
                  },
                },
            unit,
            attemptId,
            operationId,
          }),
        });
        if (recovery.decision.action === 'replay') {
          return { ...completedTerminal, recovery };
        }
        return blockedFromRecovery(
          recovery,
          `${stage}_recovered_terminal_unverified`,
          result,
          receiptExpectation({ unit, attemptId }),
        );
      }
      if (recoveryEnabled && !activeOperation) {
        await startOperation({ operationId });
      }
      const requestResult = await executeReceiptAwareRequest({
        recovered: recovered || Boolean(activeOperation),
        invoke: (requireExistingReceipt, expectedReceiptInputHash) => invoke({
          unit,
          attemptId,
          requireExistingReceipt,
          expectedReceiptInputHash,
        }),
        acceptReceiptAbsence: (response) => exactExtractionOperationReceiptAbsence(
          response,
          {
            attemptId,
            stage,
            unitId: unit.unit_id,
            runnerInputHash: unit.input_hash,
            stableHash,
          },
        ),
      });
      if (requestResult.pending) return { status: 'pending' };
      const response = requestResult.response;
      const children = inputTooLarge(response) ? splitUnit?.(unit) || [] : [];
      if (children.length > 0) {
        if (recoveryEnabled) {
          await completeOperation({
            operationId,
            status: 'split',
            child_unit_ids: children.map((child) => child.unit_id),
          });
        }
        return { status: 'split', children };
      }
      const classified = classify(response);
      if (!recoveryEnabled) return classified;
      const recovery = await resolveOutcome({
        operationId,
        ...adaptRecoveryEvidence({
          result: response,
          unit,
          attemptId,
          operationId,
        }),
      });
      if (recovery.decision.action === 'replay' && classified.status === 'succeeded') {
        const terminalResult = {
          status: 'succeeded',
          payload: classified.payload,
        };
        await completeOperation({
          operationId,
          status: 'succeeded',
          terminal_result: terminalResult,
        });
        return {
          ...terminalResult,
          recovery,
        };
      }
      if (recovery.decision.action === 'skipped' && classified.status === 'skipped') {
        const terminalResult = {
          status: 'skipped',
          payload: classified.payload,
        };
        await completeOperation({
          operationId,
          status: 'skipped',
          terminal_result: terminalResult,
        });
        return {
          ...terminalResult,
          recovery,
        };
      }
      if (['retry', 'resume_commit', 'reconcile_commit'].includes(recovery.decision.action)) {
        return { status: 'pending', recovery };
      }
      if (recovery.decision.action === 'reconcile') {
        return blockedFromRecovery(
          recovery,
          `${stage}_reconciliation_required`,
          response,
          receiptExpectation({
            unit,
            attemptId,
            expectedReceiptInputHash: requestResult.expectedReceiptInputHash,
          }),
        );
      }
      if (recovery.decision.action === 'isolate') {
        const terminalResult = {
          status: 'failed',
          payload: { error: recovery.evidence.reasonCode || `${stage}_isolated` },
        };
        await completeOperation({
          operationId,
          status: 'failed',
          terminal_result: terminalResult,
        });
        return { ...terminalResult, recovery };
      }
      return blockedFromRecovery(
        recovery,
        `${stage}_recovery_contract_invalid`,
        response,
        receiptExpectation({ unit, attemptId }),
      );
    },
    record: recordAdapter({ request, runId, mark, stage, resultType }),
  };
}

function twoPhaseAdapter({
  stage,
  prepareEndpoint,
  commitEndpoint,
  resultFields,
  resultType,
  request,
  runId,
  mark,
  stableHash,
  buildPreparePayload,
  splitUnit,
  adaptRecoveryEvidence,
}) {
  const commitInputHash = ({ unit, prepared }) => stableHash({
    prepareRunId: prepared.attempt_id,
    unitId: unit.unit_id,
    prepareInputHash: prepared.prepare_input_hash,
    preparedHandle: prepared.prepared_handle,
    proposalHash: prepared.proposal_hash,
  });
  const receiptExpectation = ({
    unit,
    attemptId,
    runnerInputHash,
    expectedReceiptInputHash,
  }) => ({
    attemptId,
    stage,
    unitId: unit.unit_id,
    runnerInputHash,
    expectedReceiptInputHash,
    stableHash,
  });
  const commitRecoveryFacts = ({ unit, attemptId, prepared, result, inputHash }) => (
    adaptRecoveryEvidence({
      unit: { ...unit, input_hash: inputHash },
      attemptId,
      result,
      safeFacts: {
        response: responseData(result),
        receipt: responseData(result)?.operationReceipt,
        commitContext: {
          preparedHandle: prepared.prepared_handle,
          proposalHash: prepared.proposal_hash,
          prepareAttemptId: prepared.attempt_id,
          prepareInputHash: prepared.prepare_input_hash,
        },
      },
    })
  );
  const terminalMatches = (classified, terminal) => (
    classified.status === terminal?.status
    && JSON.stringify(classified.payload?.result_ids || [])
      === JSON.stringify(terminal?.result_ids || terminal?.payload?.result_ids || [])
    && (
      classified.status !== 'skipped'
      || classified.payload?.reason === (terminal?.reason || terminal?.payload?.reason)
    )
  );
  return {
    recoverPrepare: Boolean(adaptRecoveryEvidence),
    recoverCommit: Boolean(adaptRecoveryEvidence),
    ...(adaptRecoveryEvidence ? {
      verifyRecoveredTerminal: async ({
        unit,
        prepareAttemptId,
        commitAttemptId,
        prepared,
        terminal,
      }) => {
        if (terminal?.status === 'succeeded' && prepared && commitAttemptId) {
          const inputHash = commitInputHash({ unit, prepared });
          const result = await request(
            commitEndpoint,
            buildFormalBody({
              stage,
              unit,
              attemptId: commitAttemptId,
              inputHash,
              payload: {
                prepareRunId: prepared.attempt_id,
                prepareInputHash: prepared.prepare_input_hash,
                preparedHandle: prepared.prepared_handle,
                proposalHash: prepared.proposal_hash,
                requireExistingReceipt: true,
              },
            }),
          );
          const classified = classifyIdempotentCommitResponse(result, resultFields);
          return {
            recoveryCandidate: commitRecoveryFacts({
              unit,
              attemptId: commitAttemptId,
              prepared,
              result: terminalMatches(classified, terminal)
                ? result
                : {
                    ok: false,
                    data: { error: `${stage}_recovered_terminal_unverified` },
                  },
              inputHash,
            }),
          };
        }
        if (terminal?.status === 'skipped' && prepareAttemptId) {
          const result = await request(
            prepareEndpoint,
            buildFormalBody({
              stage,
              unit,
              attemptId: prepareAttemptId,
              payload: {
                ...buildPreparePayload(unit),
                requireExistingReceipt: true,
              },
            }),
          );
          const classified = classifyResponse(result, resultFields);
          const response = responseData(result);
          return {
            recoveryCandidate: adaptRecoveryEvidence({
              unit,
              attemptId: prepareAttemptId,
              result: terminalMatches(classified, terminal)
                ? result
                : {
                    ok: false,
                    data: { error: `${stage}_recovered_terminal_unverified` },
                  },
              safeFacts: {
                response,
                receipt: response?.operationReceipt,
              },
            }),
          };
        }
        return {
          recoveryCandidate: adaptRecoveryEvidence({
            unit,
            attemptId: commitAttemptId || prepareAttemptId,
            result: {
              ok: false,
              data: { error: `${stage}_recovered_terminal_unverified` },
            },
          }),
        };
      },
    } : {}),
    prepareAttemptIdForUnit: (unit) => stableHash({
      run_id: runId,
      stage,
      unit_id: unit.unit_id,
      phase: 'prepare',
    }),
    commitAttemptIdForUnit: ({ unit, prepared }) => stableHash({
      run_id: runId,
      stage,
      unit_id: unit.unit_id,
      phase: 'commit',
      prepare_attempt_id: prepared.attempt_id,
      prepare_input_hash: prepared.prepare_input_hash,
      prepared_handle: prepared.prepared_handle,
      proposal_hash: prepared.proposal_hash,
    }),
    prepare: async ({ unit, attemptId, recovered }) => {
      if (unit.skip_reason) {
        return { status: 'skipped', payload: { reason: unit.skip_reason, result_ids: [] } };
      }
      const invokePrepare = (requireExistingReceipt, expectedReceiptInputHash) => request(
        prepareEndpoint,
        buildFormalBody({
          stage,
          unit,
          attemptId,
          payload: {
            ...buildPreparePayload(unit),
            ...(requireExistingReceipt ? { requireExistingReceipt: true } : {}),
            ...(expectedReceiptInputHash ? { expectedReceiptInputHash } : {}),
          },
        }),
      );
      let requestResult = await executeReceiptAwareRequest({
        recovered,
        invoke: invokePrepare,
        acceptReceiptAbsence: (response) => exactExtractionOperationReceiptAbsence(
          response,
          {
            attemptId,
            stage,
            unitId: unit.unit_id,
            runnerInputHash: unit.input_hash,
            stableHash,
          },
        ),
      });
      if (requestResult.pending) return { status: 'pending' };
      let response = requestResult.response;
      let data = responseData(response);
      let cause = failureCause(response, data);
      const children = inputTooLarge(response) ? splitUnit?.(unit) || [] : [];
      if (children.length > 0) return { status: 'split', children };
      if (cause === 'extraction_operation_reconciliation_required') {
        const reconciliationBinding = extractionOperationReconciliationBinding(
          response,
          receiptExpectation({
            unit,
            attemptId,
            runnerInputHash: unit.input_hash,
            expectedReceiptInputHash: requestResult.expectedReceiptInputHash,
          }),
        );
        return {
          status: 'blocked',
          reason: cause,
          payload: { error: cause },
          ...(adaptRecoveryEvidence ? {
            recoveryCandidate: adaptRecoveryEvidence({
              unit: {
                ...unit,
                input_hash: responseData(response)?.operationReceipt?.inputHash
                  || unit.input_hash,
              },
              attemptId,
              result: response,
              safeFacts: {
                response: responseData(response),
                receipt: responseData(response)?.operationReceipt,
              },
            }),
          } : {}),
          ...(reconciliationBinding ? { reconciliationBinding } : {}),
        };
      }
      const preparedHandle = data?.preparedHandle || data?.prepared_handle;
      const proposalHash = data?.proposalHash || data?.proposal_hash;
      const prepareInputHash = data?.inputHash || data?.input_hash;
      if (preparedHandle || proposalHash || data?.status === 'prepared') {
        if (!preparedHandle || !proposalHash || !prepareInputHash) {
          return { status: 'failed', payload: { error: `${stage}_prepared_identity_incomplete` } };
        }
        return {
          status: 'prepared',
          prepared: {
            prepared_handle: preparedHandle,
            proposal_hash: proposalHash,
            prepare_input_hash: prepareInputHash,
          },
        };
      }
      return classifyResponse(response, resultFields);
    },
    commit: async ({
      unit,
      attemptId,
      prepared,
      recovered,
      activeOperation,
      completedOperations = [],
      completeOperation,
      resolveOutcome,
    }) => {
      const operationId = activeOperation?.operation_id
        || completedOperations.at(-1)?.operation_id
        || `${unit.unit_id}:commit`;
      const inputHash = commitInputHash({ unit, prepared });
      const invokeCommit = (requireExistingReceipt, expectedReceiptInputHash) => request(
        commitEndpoint,
        buildFormalBody({
          stage,
          unit,
          attemptId,
          inputHash,
          payload: {
            prepareRunId: prepared.attempt_id,
            prepareInputHash: prepared.prepare_input_hash,
            preparedHandle: prepared.prepared_handle,
            proposalHash: prepared.proposal_hash,
            ...(requireExistingReceipt ? { requireExistingReceipt: true } : {}),
            ...(expectedReceiptInputHash ? { expectedReceiptInputHash } : {}),
          },
        }),
      );
      const recoveryEnabled = Boolean(
        adaptRecoveryEvidence
        && completeOperation
        && resolveOutcome,
      );
      const completedTerminal = completedOperations.at(-1)?.terminal_result;
      if (recoveryEnabled && completedTerminal) {
        const response = await invokeCommit(true);
        const classified = classifyIdempotentCommitResponse(response, resultFields);
        const terminalMatches = classified.status === completedTerminal.status
          && JSON.stringify(classified.payload?.result_ids || [])
            === JSON.stringify(completedTerminal.payload?.result_ids || []);
        const recovery = await resolveOutcome({
          operationId,
          verification: true,
          ...commitRecoveryFacts({
            unit,
            attemptId,
            prepared,
            result: terminalMatches
              ? response
              : {
                  ok: false,
                  data: { error: `${stage}_recovered_terminal_unverified` },
                },
            inputHash,
          }),
        });
        const reconciliationBinding = extractionOperationReconciliationBinding(
          response,
          receiptExpectation({ unit, attemptId, runnerInputHash: inputHash }),
        );
        return recovery.decision.action === 'replay'
          ? {
              ...completedTerminal,
              recovery,
            }
          : {
              status: 'blocked',
              reason: `${stage}_recovered_terminal_unverified`,
              payload: { error: `${stage}_recovered_terminal_unverified` },
              recovery,
              ...(reconciliationBinding ? { reconciliationBinding } : {}),
            };
      }
      const requestResult = await executeReceiptAwareRequest({
        recovered,
        invoke: invokeCommit,
        acceptReceiptAbsence: (response) => exactExtractionOperationReceiptAbsence(
          response,
          {
            attemptId,
            stage,
            unitId: unit.unit_id,
            runnerInputHash: inputHash,
            stableHash,
          },
        ),
      });
      if (requestResult.pending) return { status: 'pending' };
      const response = requestResult.response;
      const classified = classifyIdempotentCommitResponse(response, resultFields);
      if (!recoveryEnabled) return classified;
      const recovery = await resolveOutcome({
        operationId,
        ...commitRecoveryFacts({
          unit,
          attemptId,
          prepared,
          result: response,
          inputHash,
        }),
      });
      if (recovery.decision.action === 'replay' && classified.status === 'succeeded') {
        const terminalResult = {
          status: 'succeeded',
          payload: classified.payload,
        };
        await completeOperation({
          operationId,
          status: 'succeeded',
          terminal_result: terminalResult,
        });
        return {
          ...terminalResult,
          recovery,
        };
      }
      if (['resume_commit', 'reconcile_commit'].includes(recovery.decision.action)) {
        return { status: 'pending', recovery };
      }
      if (recovery.decision.action === 'reconcile') {
        const reconciliationBinding = extractionOperationReconciliationBinding(
          response,
          receiptExpectation({
            unit,
            attemptId,
            runnerInputHash: inputHash,
            expectedReceiptInputHash: requestResult.expectedReceiptInputHash,
          }),
        );
        return {
          status: 'blocked',
          reason: `${stage}_commit_reconciliation_required`,
          payload: { error: `${stage}_commit_reconciliation_required` },
          recovery,
          ...(reconciliationBinding ? { reconciliationBinding } : {}),
        };
      }
      return {
        status: 'blocked',
        reason: recovery.decision.code || `${stage}_commit_recovery_contract_invalid`,
        payload: {
          error: recovery.decision.code || `${stage}_commit_recovery_contract_invalid`,
        },
        recovery,
      };
    },
    record: recordAdapter({ request, runId, mark, stage, resultType }),
  };
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

function usableSummary(summary) {
  const fields = summaryFields(summary);
  return [fields.title, fields.narrative].some((value) => typeof value === 'string' && value.trim())
    || [fields.keyDecisions, fields.filesModified, fields.concepts]
      .some((values) => Array.isArray(values) && values.length > 0);
}

function estimateSummaryChars(summary) {
  const fields = summaryFields(summary);
  return [
    `Title: ${fields.title}`,
    `Narrative: ${fields.narrative}`,
    `Decisions: ${fields.keyDecisions.join('; ')}`,
    `Files: ${fields.filesModified.join(', ')}`,
    `Concepts: ${fields.concepts.join(', ')}`,
  ].join('\n').length + 200;
}

function semanticPlan(sessions, config, stableHash) {
  const entries = sessions
    .filter((session) => usableSummary(session.summary))
    .map((session) => ({
      session_id: session.id,
      summary_hash: stableHash(summaryFields(session.summary)),
      estimated_chars: estimateSummaryChars(session.summary),
    }));
  const windows = [];
  let current = [];
  let currentChars = 0;
  const maxCount = config.semantic_window_size;
  const charBudget = config.semantic_rollup_target_prompt_chars ?? config.semantic_char_budget;
  for (const entry of entries) {
    if (current.length > 0 && (current.length >= maxCount || currentChars + entry.estimated_chars > charBudget)) {
      windows.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(entry);
    currentChars += entry.estimated_chars;
  }
  if (current.length > 0) windows.push(current);
  return windows.map((items, index) => {
    const sourceIds = items.map((item) => item.session_id);
    return {
      unit_id: `w${String(index + 1).padStart(4, '0')}`,
      window_id: `w${String(index + 1).padStart(4, '0')}`,
      source_ids: sourceIds,
      source_session_ids: sourceIds,
      source_summary_hashes: Object.fromEntries(
        items.map((item) => [item.session_id, item.summary_hash]),
      ),
      source_count: sourceIds.length,
      estimated_prompt_chars: items.reduce((sum, item) => sum + item.estimated_chars, 0),
      input_hash: stableHash(items.map((item) => [item.session_id, item.summary_hash])),
    };
  });
}

function splitSemanticUnit(unit, stableHash) {
  const sourceIds = unit.source_session_ids || unit.source_ids || [];
  if (sourceIds.length <= 1) return [];
  const mid = Math.ceil(sourceIds.length / 2);
  return [sourceIds.slice(0, mid), sourceIds.slice(mid)].map((ids, index) => {
    const unitId = `${unit.unit_id}${String.fromCharCode(97 + index)}`;
    const summaryHashes = Object.fromEntries(ids.map((id) => [
      id,
      unit.source_summary_hashes?.[id] || null,
    ]));
    return {
      unit_id: unitId,
      window_id: unitId,
      source_ids: ids,
      source_session_ids: ids,
      source_summary_hashes: summaryHashes,
      source_count: ids.length,
      input_hash: stableHash({
        unitId,
        sources: ids.map((id) => [id, summaryHashes[id]]),
      }),
      split_from: unit.unit_id,
    };
  });
}

function splitMemoryUnit(unit, stableHash) {
  const sourceIds = firstArray(unit, [
    'sourceObservationIds',
    'source_observation_ids',
    'observationIds',
    'observation_ids',
    'sourceIds',
    'source_ids',
  ]);
  if (sourceIds.length <= 1) return [];
  const mid = Math.ceil(sourceIds.length / 2);
  const sessionIds = unit.observationSessionIds || unit.observation_session_ids;
  return [sourceIds.slice(0, mid), sourceIds.slice(mid)].map((ids, index) => {
    const unitId = `${unit.unit_id}${String.fromCharCode(97 + index)}`;
    const observationSessionIds = sessionIds && typeof sessionIds === 'object'
      ? Object.fromEntries(ids
          .filter((id) => typeof sessionIds[id] === 'string' && sessionIds[id])
          .map((id) => [id, sessionIds[id]]))
      : null;
    const inputHash = stableHash({ unitId, sourceIds: ids });
    return {
      concept: unit.concept,
      unit_id: unitId,
      window_id: unitId,
      source_ids: ids,
      sourceObservationIds: ids,
      observationIds: ids,
      source_count: ids.length,
      ...(observationSessionIds && Object.keys(observationSessionIds).length === ids.length
        ? { observationSessionIds }
        : {}),
      inputHash,
      input_hash: inputHash,
      split_from: unit.unit_id,
    };
  });
}

function skillPlan(sessions, stableHash) {
  return sessions
    .filter((session) => ['completed', 'done'].includes(session.status))
    .filter((session) => usableSummary(session.summary))
    .map((session, index) => ({
      unit_id: `skill-${String(index + 1).padStart(4, '0')}`,
      session_id: session.id,
      source_ids: [session.id],
      source_count: 1,
      input_hash: stableHash({
        session_id: session.id,
        summary_hash: stableHash(summaryFields(session.summary)),
      }),
    }));
}

function memoryDescriptorPage(data) {
  if (!Array.isArray(data?.descriptors)) return null;
  const totalSessions = Number(data.totalSessions);
  const sessionOffset = Number(data.sessionOffset);
  const nextSessionOffset = data.nextSessionOffset === null ? null : Number(data.nextSessionOffset);
  if (
    !Number.isInteger(totalSessions)
    || !Number.isInteger(sessionOffset)
    || !data.sessionInventoryHash
    || (nextSessionOffset !== null && (!Number.isInteger(nextSessionOffset) || nextSessionOffset <= sessionOffset))
  ) return null;
  return {
    totalSessions,
    sessionOffset,
    nextSessionOffset,
    sessionInventoryHash: data.sessionInventoryHash,
    plannerId: data.plannerId,
  };
}

function memoryWindowPage(data) {
  if (!Array.isArray(data?.windows)) return null;
  const totalWindows = Number(data.totalWindows);
  const windowOffset = Number(data.windowOffset);
  const nextWindowOffset = data.nextWindowOffset === null ? null : Number(data.nextWindowOffset);
  if (
    !Number.isInteger(totalWindows)
    || !Number.isInteger(windowOffset)
    || (nextWindowOffset !== null && (!Number.isInteger(nextWindowOffset) || nextWindowOffset <= windowOffset))
  ) return null;
  return {
    windows: data.windows,
    totalWindows,
    windowOffset,
    nextWindowOffset,
    plannerId: data.plannerId,
  };
}

async function memoryPlan({ request, runId, configHash, inventoryHash, config, stableHash }) {
  const endpoint = '/agentmemory/full/memory-consolidate-windows/plan';
  const plannerId = stableHash(['memory-consolidate-plan-v2', runId, configHash, inventoryHash]);
  const base = { charBudget: config.memory_consolidate_char_budget, plannerId };
  let response = await request(endpoint, { ...base, sessionOffset: 0, sessionLimit: 8 });
  if (response?.ok === false) throw new Error(failureCause(response) || 'memory_consolidate_plan_failed');
  let page = memoryDescriptorPage(responseData(response));
  if (!page || page.plannerId !== plannerId) throw new Error('memory_consolidate_descriptor_page_invalid');
  const totalSessions = page.totalSessions;
  const inventory = page.sessionInventoryHash;
  while (page.nextSessionOffset !== null) {
    const expectedOffset = page.nextSessionOffset;
    response = await request(endpoint, { ...base, sessionOffset: expectedOffset, sessionLimit: 8 });
    if (response?.ok === false) throw new Error(failureCause(response) || 'memory_consolidate_plan_failed');
    page = memoryDescriptorPage(responseData(response));
    if (
      !page
      || page.plannerId !== plannerId
      || page.totalSessions !== totalSessions
      || page.sessionInventoryHash !== inventory
      || page.sessionOffset !== expectedOffset
    ) throw new Error('memory_consolidate_descriptor_page_drifted');
  }
  response = await request(endpoint, { ...base, windowOffset: 0, windowLimit: 8 });
  if (response?.ok === false) throw new Error(failureCause(response) || 'memory_consolidate_plan_failed');
  let windowPage = memoryWindowPage(responseData(response));
  if (!windowPage || windowPage.plannerId !== plannerId || windowPage.windowOffset !== 0) {
    throw new Error('memory_consolidate_window_page_invalid');
  }
  const totalWindows = windowPage.totalWindows;
  const windows = [...windowPage.windows];
  while (windowPage.nextWindowOffset !== null) {
    const expectedOffset = windowPage.nextWindowOffset;
    response = await request(endpoint, { ...base, windowOffset: expectedOffset, windowLimit: 8 });
    if (response?.ok === false) throw new Error(failureCause(response) || 'memory_consolidate_plan_failed');
    windowPage = memoryWindowPage(responseData(response));
    if (
      !windowPage
      || windowPage.plannerId !== plannerId
      || windowPage.totalWindows !== totalWindows
      || windowPage.windowOffset !== expectedOffset
    ) throw new Error('memory_consolidate_window_page_drifted');
    windows.push(...windowPage.windows);
  }
  if (windows.length !== totalWindows) throw new Error('memory_consolidate_plan_incomplete');
  return windows.map((item, index) => normalizePlanUnit(item, index, 'mcw', stableHash));
}

async function serverPlan({ request, endpoint, body, prefix, stableHash }) {
  const response = await request(endpoint, body);
  if (response?.ok === false || responseData(response)?.success === false) {
    throw new Error(failureCause(response) || `${prefix}_plan_failed`);
  }
  return normalizePlanItems(responseData(response))
    .map((item, index) => normalizePlanUnit(item, index, prefix, stableHash));
}

function stageAccepted(result) {
  return ['completed', 'planned'].includes(result.status);
}

export async function runV2RemainingStages({
  options,
  runId,
  config,
  configHash,
  inventoryHash,
  request,
  loadSelectedSessions,
  stableHash,
  runSingleStage,
  runTwoPhaseStage,
  eligibleStages = {},
}) {
  const results = new Map();
  const eligible = (stage) => eligibleStages[stage] !== false;
  const remember = (stage, result) => {
    results.set(stage, result);
    return result;
  };
  const blocked = () => [...results.values()].find((result) => result.status === 'blocked');
  const aggregate = () => (
    blocked()
    || [...results.values()].find((result) => !stageAccepted(result))
    || [...results.values()].at(-1)
    || { status: 'completed', acceptedCount: 0 }
  );

  if (eligible('memory_consolidate')) {
    remember('memory_consolidate', await runTwoPhaseStage({
    stage: 'memory_consolidate',
    plan: async () => planOrNone(await memoryPlan({
      request,
      runId,
      configHash,
      inventoryHash,
      config,
      stableHash,
    }), 'no eligible memory consolidate windows', stableHash),
    adapter: twoPhaseAdapter({
      stage: 'memory_consolidate',
      prepareEndpoint: '/agentmemory/full/memory-consolidate-window/prepare',
      commitEndpoint: '/agentmemory/full/memory-consolidate-window/commit',
      resultFields: ['memoryIds', 'memory_ids'],
      resultType: 'memory',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPreparePayload: (unit) => modelBody({
        windowId: unit.window_id || unit.unit_id,
        concept: unit.concept,
        sourceObservationIds: firstArray(unit, [
          'sourceObservationIds',
          'source_observation_ids',
          'observationIds',
          'observation_ids',
          'sourceIds',
          'source_ids',
        ]),
        ...(unit.observationSessionIds || unit.observation_session_ids
          ? { observationSessionIds: unit.observationSessionIds || unit.observation_session_ids }
          : {}),
        charBudget: config.memory_consolidate_char_budget,
      }, options, 'memory_consolidate'),
      splitUnit: (unit) => splitMemoryUnit(unit, stableHash),
      adaptRecoveryEvidence: adaptMemoryConsolidateOperationEvidence,
    }),
    }));
    if (blocked()) return aggregate();
  }

  let sessionsPromise;
  const selectedSessions = () => {
    sessionsPromise ||= loadSelectedSessions();
    return sessionsPromise;
  };
  if (eligible('semantic_rollup')) {
    remember('semantic_rollup', await runSingleStage({
    stage: 'semantic_rollup',
    plan: async () => planOrNone(
      semanticPlan(await selectedSessions(), config, stableHash),
      'no summarized sessions',
      stableHash,
    ),
    adapter: singleAdapter({
      stage: 'semantic_rollup',
      endpoint: '/agentmemory/semantic-rollup',
      resultFields: ['semanticMemoryIds', 'semantic_memory_ids'],
      resultType: 'semantic',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPayload: (unit) => modelBody({
        windowId: unit.window_id || unit.unit_id,
        mark: options.mark,
        kind: 'window',
        sessionIds: unit.source_session_ids || unit.source_ids,
        sourceSummaryHashes: unit.source_summary_hashes,
      }, options, 'semantic_rollup'),
      splitUnit: (unit) => splitSemanticUnit(unit, stableHash),
      adaptRecoveryEvidence: adaptSemanticRollupOperationEvidence,
    }),
    }));
    if (blocked()) return aggregate();
  }

  if (eligible('skill_extract')) {
    remember('skill_extract', await runTwoPhaseStage({
    stage: 'skill_extract',
    plan: async () => planOrNone(
      skillPlan(await selectedSessions(), stableHash),
      'no completed summarized sessions',
      stableHash,
    ),
    adapter: twoPhaseAdapter({
      stage: 'skill_extract',
      prepareEndpoint: '/agentmemory/full/skill-extract/prepare',
      commitEndpoint: '/agentmemory/full/skill-extract/commit',
      resultFields: ['proceduralMemoryIds', 'procedural_memory_ids', 'skillIds', 'skill_ids'],
      resultType: 'procedural',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPreparePayload: (unit) => modelBody({
        sessionId: unit.session_id,
        operationReceiptManaged: true,
      }, options, 'skill_extract'),
      adaptRecoveryEvidence: adaptSkillExtractOperationEvidence,
    }),
    }));
    if (blocked()) return aggregate();
  }

  if (eligible('crystal')) {
    remember('crystal', await runSingleStage({
    stage: 'crystal',
    plan: async () => {
      const crystalGroups = await serverPlan({
        request,
        endpoint: '/agentmemory/full/crystals/auto',
        body: modelBody({ dryRun: true }, options, 'crystal'),
        prefix: 'cg',
        stableHash,
      });
      return planOrNone(crystalGroups.map((unit) => {
        const actionIds = unit.action_ids.length > 0 ? unit.action_ids : unit.source_ids;
        return {
          ...unit,
          source_ids: actionIds,
          action_ids: actionIds,
          input_hash: stableHash({
            group_id: unit.unit_id,
            action_ids: actionIds,
            action_updated_ats: unit.action_updated_ats,
          }),
        };
      }), 'no eligible actions', stableHash);
    },
    adapter: singleAdapter({
      stage: 'crystal',
      endpoint: '/agentmemory/full/crystals/auto',
      resultFields: ['crystalIds', 'crystal_ids'],
      resultType: 'crystal',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPayload: (unit) => modelBody({
        groupId: unit.unit_id,
        actionIds: unit.action_ids,
        actionUpdatedAts: unit.action_updated_ats,
        ...(unit.project ? { project: unit.project } : {}),
      }, options, 'crystal'),
      idempotentCommit: true,
      adaptRecoveryEvidence: adaptCrystalOperationEvidence,
    }),
    }));
    if (blocked()) return aggregate();
  }

  if (eligible('consolidation_procedural')) {
    remember('consolidation_procedural', await runSingleStage({
    stage: 'consolidation_procedural',
    plan: async () => planOrNone(await serverPlan({
      request,
      endpoint: '/agentmemory/full/consolidation-procedural-windows/plan',
      body: {},
      prefix: 'cpw',
      stableHash,
    }), 'no eligible pattern memories', stableHash),
    adapter: singleAdapter({
      stage: 'consolidation_procedural',
      endpoint: '/agentmemory/full/consolidation-procedural-window',
      resultFields: ['proceduralMemoryIds', 'procedural_memory_ids', 'memoryIds', 'memory_ids'],
      resultType: 'procedural',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPayload: (unit) => modelBody({
        windowId: unit.window_id || unit.unit_id,
        memoryIds: firstArray(unit, [
          'memoryIds',
          'memory_ids',
          'patternMemoryIds',
          'pattern_memory_ids',
          'sourceIds',
          'source_ids',
        ]),
      }, options, 'consolidation_procedural'),
      adaptRecoveryEvidence: adaptConsolidationProceduralOperationEvidence,
    }),
    }));
    if (blocked()) return aggregate();
  }

  const semanticAccepted = !eligible('semantic_rollup')
    || stageAccepted(results.get('semantic_rollup'));
  const crystalAccepted = !eligible('crystal')
    || stageAccepted(results.get('crystal'));
  if (
    eligible('reflect_insight')
    && semanticAccepted
    && crystalAccepted
  ) {
    remember('reflect_insight', await runSingleStage({
    stage: 'reflect_insight',
    plan: async () => planOrNone(await serverPlan({
      request,
      endpoint: '/agentmemory/full/reflect-insight-windows/plan',
      body: { useGraph: false, charBudget: config.reflect_insight_char_budget },
      prefix: 'riw',
      stableHash,
    }), 'no eligible reflect insight windows', stableHash),
    adapter: singleAdapter({
      stage: 'reflect_insight',
      endpoint: '/agentmemory/full/reflect-insight-window',
      resultFields: ['insightIds', 'insight_ids', 'memoryIds', 'memory_ids'],
      resultType: 'insight',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPayload: (unit) => modelBody({
        windowId: unit.window_id || unit.unit_id,
        useGraph: false,
        semanticMemoryIds: firstArray(unit, ['semanticMemoryIds', 'semantic_memory_ids']),
        lessonIds: firstArray(unit, ['lessonIds', 'lesson_ids']),
        crystalIds: firstArray(unit, ['crystalIds', 'crystal_ids']),
        charBudget: config.reflect_insight_char_budget,
      }, options, 'reflect_insight'),
      adaptRecoveryEvidence: adaptReflectInsightOperationEvidence,
    }),
    }));
  }
  return aggregate();
}
