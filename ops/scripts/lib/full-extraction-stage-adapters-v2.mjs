function firstArray(value, keys) {
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function responseData(response) {
  return response?.data || response?.response || response || {};
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

function classifyResponse(response, resultFields) {
  const data = responseData(response);
  const cause = failureCause(response, data);
  if (cause === 'extraction_operation_reconciliation_required') {
    return { status: 'blocked', reason: cause, payload: { error: cause } };
  }
  if (response?.ok === false && Number(response?.status_code ?? response?.statusCode ?? 0) === 0) {
    return {
      status: 'blocked',
      reason: 'request_transport_failed',
      payload: { error: 'request_transport_failed' },
    };
  }
  const text = [
    data?.status,
    data?.result,
    data?.reason,
    data?.error,
    response?.error,
  ].filter(Boolean).join(' ').toLowerCase();
  const resultIds = resultIdsFromData(data, resultFields);
  if (data?.skipped || /skipped|no eligible|none|too few observations/.test(text)) {
    return {
      status: 'skipped',
      payload: { result_ids: resultIds, reason: data?.reason || data?.status || 'skipped' },
    };
  }
  if (response?.ok === false || data?.success === false || /failed|error|infeasible/.test(text)) {
    return { status: 'failed', payload: { error: cause || 'stage request failed' } };
  }
  return { status: 'succeeded', payload: { result_ids: resultIds } };
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
}) {
  return {
    attemptIdForUnit: (unit) => stableHash({
      run_id: runId,
      stage,
      unit_id: unit.unit_id,
      phase: 'execute',
    }),
    execute: async ({ unit, attemptId, recovered }) => {
      if (unit.skip_reason) {
        return { status: 'skipped', payload: { reason: unit.skip_reason, result_ids: [] } };
      }
      const response = await request(endpoint, buildFormalBody({
        stage,
        unit,
        attemptId,
        payload: {
          ...buildPayload(unit),
          ...(recovered ? { requireExistingReceipt: true } : {}),
        },
      }));
      const children = inputTooLarge(response) ? splitUnit?.(unit) || [] : [];
      if (children.length > 0) return { status: 'split', children };
      return classifyResponse(response, resultFields);
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
}) {
  return {
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
      const response = await request(prepareEndpoint, buildFormalBody({
        stage,
        unit,
        attemptId,
        payload: {
          ...buildPreparePayload(unit),
          ...(recovered ? { requireExistingReceipt: true } : {}),
        },
      }));
      const children = inputTooLarge(response) ? splitUnit?.(unit) || [] : [];
      if (children.length > 0) return { status: 'split', children };
      const data = responseData(response);
      const cause = failureCause(response, data);
      if (cause === 'extraction_operation_reconciliation_required') {
        return { status: 'blocked', reason: cause, payload: { error: cause } };
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
    commit: async ({ unit, attemptId, prepared }) => {
      const commitInputHash = stableHash({
        prepareRunId: prepared.attempt_id,
        unitId: unit.unit_id,
        prepareInputHash: prepared.prepare_input_hash,
        preparedHandle: prepared.prepared_handle,
        proposalHash: prepared.proposal_hash,
      });
      const response = await request(commitEndpoint, buildFormalBody({
        stage,
        unit,
        attemptId,
        inputHash: commitInputHash,
        payload: {
          prepareRunId: prepared.attempt_id,
          prepareInputHash: prepared.prepare_input_hash,
          preparedHandle: prepared.prepared_handle,
          proposalHash: prepared.proposal_hash,
        },
      }));
      return classifyResponse(response, resultFields);
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
}) {
  const memoryUnits = planOrNone(await memoryPlan({
    request,
    runId,
    configHash,
    inventoryHash,
    config,
    stableHash,
  }), 'no eligible memory consolidate windows', stableHash);
  let result = await runTwoPhaseStage({
    stage: 'memory_consolidate',
    plan: memoryUnits,
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
    }),
  });
  if (!stageAccepted(result)) return result;

  const sessions = await loadSelectedSessions();
  const semanticUnits = planOrNone(
    semanticPlan(sessions, config, stableHash),
    'no summarized sessions',
    stableHash,
  );
  result = await runSingleStage({
    stage: 'semantic_rollup',
    plan: semanticUnits,
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
      }, options, 'semantic_rollup'),
      splitUnit: (unit) => splitSemanticUnit(unit, stableHash),
    }),
  });
  if (!stageAccepted(result)) return result;

  const skillUnits = planOrNone(
    skillPlan(sessions, stableHash),
    'no completed summarized sessions',
    stableHash,
  );
  result = await runTwoPhaseStage({
    stage: 'skill_extract',
    plan: skillUnits,
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
    }),
  });
  if (!stageAccepted(result)) return result;

  const crystalGroups = await serverPlan({
    request,
    endpoint: '/agentmemory/full/crystals/auto',
    body: modelBody({ dryRun: true }, options, 'crystal'),
    prefix: 'cg',
    stableHash,
  });
  const crystalUnits = crystalGroups.length > 0
    ? [{
        unit_id: 'auto',
        source_ids: crystalGroups.flatMap((unit) => unit.action_ids.length > 0 ? unit.action_ids : unit.source_ids),
        planned_group_ids: crystalGroups.map((unit) => unit.unit_id),
        input_hash: stableHash(crystalGroups.map((unit) => [
          unit.unit_id,
          stableHash({
            action_ids: unit.action_ids.length > 0 ? unit.action_ids : unit.source_ids,
            action_updated_ats: unit.action_updated_ats,
          }),
        ])),
      }]
    : [noneUnit('no eligible actions', stableHash)];
  result = await runSingleStage({
    stage: 'crystal',
    plan: crystalUnits,
    adapter: singleAdapter({
      stage: 'crystal',
      endpoint: '/agentmemory/full/crystals/auto',
      resultFields: ['crystalIds', 'crystal_ids'],
      resultType: 'crystal',
      request,
      runId,
      mark: options.mark,
      stableHash,
      buildPayload: () => modelBody({}, options, 'crystal'),
    }),
  });
  if (!stageAccepted(result)) return result;

  const proceduralUnits = planOrNone(await serverPlan({
    request,
    endpoint: '/agentmemory/full/consolidation-procedural-windows/plan',
    body: {},
    prefix: 'cpw',
    stableHash,
  }), 'no eligible pattern memories', stableHash);
  result = await runSingleStage({
    stage: 'consolidation_procedural',
    plan: proceduralUnits,
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
    }),
  });
  if (!stageAccepted(result)) return result;

  const reflectUnits = planOrNone(await serverPlan({
    request,
    endpoint: '/agentmemory/full/reflect-insight-windows/plan',
    body: { useGraph: false, charBudget: config.reflect_insight_char_budget },
    prefix: 'riw',
    stableHash,
  }), 'no eligible reflect insight windows', stableHash);
  return runSingleStage({
    stage: 'reflect_insight',
    plan: reflectUnits,
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
    }),
  });
}
