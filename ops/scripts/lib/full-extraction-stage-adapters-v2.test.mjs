import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  classifyResponse,
  classifyIdempotentCommitResponse,
  executeReceiptAwareRequest,
  runV2RemainingStages,
} from './full-extraction-stage-adapters-v2.mjs';

function stableHash(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

test('remaining v2 stages are thin adapters over the two common recovery modes', async () => {
  const calls = [];
  const records = [];
  const stages = [];
  const verifiedMemoryInput = stableHash('verified-memory-input');
  const verifiedSkillInput = stableHash('verified-skill-input');

  const request = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint === '/agentmemory/full/memory-consolidate-windows/plan') {
      if (body.sessionOffset !== undefined) {
        return {
          ok: true,
          data: {
            success: true,
            plannerId: body.plannerId,
            descriptors: [{ id: 'descriptor-1' }],
            totalSessions: 1,
            sessionOffset: body.sessionOffset,
            nextSessionOffset: null,
            sessionInventoryHash: 'inventory-1',
          },
        };
      }
      return {
        ok: true,
        data: {
          success: true,
          plannerId: body.plannerId,
          windows: [{
            windowId: 'mcw-1',
            concept: 'recovery',
            sourceObservationIds: ['obs-1', 'obs-2'],
            observationSessionIds: { 'obs-1': 's1', 'obs-2': 's1' },
            inputHash: 'memory-plan-input',
          }],
          totalWindows: 1,
          windowOffset: body.windowOffset,
          nextWindowOffset: null,
        },
      };
    }
    if (endpoint === '/agentmemory/full/memory-consolidate-window/prepare') {
      return {
        ok: true,
        data: {
          success: true,
          status: 'prepared',
          preparedHandle: 'memory-handle',
          proposalHash: 'memory-proposal',
          inputHash: verifiedMemoryInput,
        },
      };
    }
    if (endpoint === '/agentmemory/full/memory-consolidate-window/commit') {
      return { ok: true, data: { success: true, status: 'succeeded', memoryIds: ['mem-1'] } };
    }
    if (endpoint === '/agentmemory/semantic-rollup') {
      return { ok: true, data: { success: true, status: 'succeeded', semanticMemoryIds: ['sem-1'] } };
    }
    if (endpoint === '/agentmemory/full/skill-extract/prepare') {
      return {
        ok: true,
        data: {
          success: true,
          status: 'prepared',
          preparedHandle: 'skill-handle',
          proposalHash: 'skill-proposal',
          inputHash: verifiedSkillInput,
        },
      };
    }
    if (endpoint === '/agentmemory/full/skill-extract/commit') {
      return {
        ok: true,
        data: { success: true, status: 'succeeded', proceduralMemoryIds: ['skill-1'] },
      };
    }
    if (endpoint === '/agentmemory/full/crystals/auto' && body.dryRun === true) {
      return {
        ok: true,
        data: {
          success: true,
          groups: [{
            groupId: 'cg-1',
            actionIds: ['action-1'],
            actionUpdatedAts: ['2026-07-24T00:00:00.000Z'],
          }],
        },
      };
    }
    if (endpoint === '/agentmemory/full/crystals/auto') {
      return {
        ok: true,
        data: {
          success: true,
          groups: [{ groupId: 'cg-1', status: 'succeeded', crystalIds: ['crystal-1'] }],
        },
      };
    }
    if (endpoint === '/agentmemory/full/consolidation-procedural-windows/plan') {
      return {
        ok: true,
        data: {
          success: true,
          windows: [{ windowId: 'cpw-1', memoryIds: ['pattern-1'], inputHash: 'procedural-input' }],
        },
      };
    }
    if (endpoint === '/agentmemory/full/consolidation-procedural-window') {
      return {
        ok: true,
        data: { success: true, status: 'succeeded', proceduralMemoryIds: ['proc-1'] },
      };
    }
    if (endpoint === '/agentmemory/full/reflect-insight-windows/plan') {
      return {
        ok: true,
        data: {
          success: true,
          windows: [{
            windowId: 'riw-1',
            semanticMemoryIds: ['sem-1'],
            lessonIds: ['lesson-1'],
            crystalIds: ['crystal-1'],
            inputHash: 'reflect-input',
          }],
        },
      };
    }
    if (endpoint === '/agentmemory/full/reflect-insight-window') {
      return { ok: true, data: { success: true, status: 'succeeded', insightIds: ['insight-1'] } };
    }
    if (endpoint === '/agentmemory/extraction-runs/record') {
      records.push(body);
      return { ok: true, data: { success: true } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  const runSingleStage = async ({ stage, plan, adapter }) => {
    const effectivePlan = await (typeof plan === 'function' ? plan() : plan);
    stages.push({ stage, mode: 'single', plan: effectivePlan });
    for (const unit of effectivePlan) {
      const attemptId = adapter.attemptIdForUnit(unit);
      const terminal = await adapter.execute({ unit, attemptId, recovered: true });
      assert.match(terminal.status, /^(succeeded|skipped)$/);
      await adapter.record({ unit, attemptId, terminal: { ...terminal.payload, status: terminal.status } });
    }
    return { status: 'completed', acceptedCount: effectivePlan.length };
  };
  const runTwoPhaseStage = async ({ stage, plan, adapter }) => {
    const effectivePlan = await (typeof plan === 'function' ? plan() : plan);
    stages.push({ stage, mode: 'two_phase', plan: effectivePlan });
    for (const unit of effectivePlan) {
      const prepareAttemptId = adapter.prepareAttemptIdForUnit(unit);
      const preparedResult = await adapter.prepare({
        unit,
        attemptId: prepareAttemptId,
        recovered: true,
      });
      assert.equal(preparedResult.status, 'prepared');
      const prepared = { ...preparedResult.prepared, attempt_id: prepareAttemptId };
      const commitAttemptId = adapter.commitAttemptIdForUnit({ unit, prepared });
      const terminal = await adapter.commit({ unit, attemptId: commitAttemptId, prepared });
      assert.equal(terminal.status, 'succeeded');
      await adapter.record({
        unit,
        prepareAttemptId,
        commitAttemptId,
        prepared,
        terminal: { ...terminal.payload, status: terminal.status },
      });
    }
    return { status: 'completed', acceptedCount: effectivePlan.length };
  };

  const result = await runV2RemainingStages({
    options: {
      mark: 'test-mark',
      memoryConsolidateModel: 'memory-model',
      semanticRollupModel: 'semantic-model',
      skillExtractModel: 'skill-model',
      crystalModel: 'crystal-model',
      proceduralModel: 'procedural-model',
      reflectInsightModel: 'reflect-model',
    },
    runId: 'run-1',
    config: {
      semantic_window_size: 20,
      semantic_rollup_target_prompt_chars: 64000,
      memory_consolidate_char_budget: 64000,
      reflect_insight_char_budget: 64000,
    },
    configHash: 'config-1',
    inventoryHash: 'inventory-1',
    request,
    stableHash,
    loadSelectedSessions: async () => [{
      id: 's1',
      status: 'completed',
      summary: {
        title: 'Recovery',
        narrative: 'Keep the durable identity before invoking the model.',
        keyDecisions: ['use receipts'],
      },
    }],
    runSingleStage,
    runTwoPhaseStage,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(stages.map(({ stage, mode }) => [stage, mode]), [
    ['memory_consolidate', 'two_phase'],
    ['semantic_rollup', 'single'],
    ['skill_extract', 'two_phase'],
    ['crystal', 'single'],
    ['consolidation_procedural', 'single'],
    ['reflect_insight', 'single'],
  ]);
  assert.equal(records.length, 6);
  for (const endpoint of [
    '/agentmemory/full/memory-consolidate-window/prepare',
    '/agentmemory/semantic-rollup',
    '/agentmemory/full/skill-extract/prepare',
    '/agentmemory/full/crystals/auto',
    '/agentmemory/full/consolidation-procedural-window',
    '/agentmemory/full/reflect-insight-window',
  ]) {
    const modelCall = calls.find((call) =>
      call.endpoint === endpoint && call.body.dryRun !== true);
    assert.equal(modelCall.body.requireExistingReceipt, true, endpoint);
  }

  const memoryPrepare = calls.find((call) =>
    call.endpoint === '/agentmemory/full/memory-consolidate-window/prepare').body;
  const memoryCommit = calls.find((call) =>
    call.endpoint === '/agentmemory/full/memory-consolidate-window/commit').body;
  assert.equal(memoryPrepare.inputHash, 'memory-plan-input');
  assert.equal(memoryPrepare.model, 'memory-model');
  assert.deepEqual(memoryPrepare.sourceObservationIds, ['obs-1', 'obs-2']);
  assert.equal(memoryCommit.prepareInputHash, verifiedMemoryInput);
  assert.equal(memoryCommit.inputHash, stableHash({
    prepareRunId: memoryCommit.prepareRunId,
    unitId: 'mcw-1',
    prepareInputHash: verifiedMemoryInput,
    preparedHandle: 'memory-handle',
    proposalHash: 'memory-proposal',
  }));

  const skillPrepare = calls.find((call) =>
    call.endpoint === '/agentmemory/full/skill-extract/prepare').body;
  const skillCommit = calls.find((call) =>
    call.endpoint === '/agentmemory/full/skill-extract/commit').body;
  assert.equal(skillPrepare.operationReceiptManaged, true);
  assert.equal(skillPrepare.sessionId, 's1');
  assert.equal(skillCommit.prepareInputHash, verifiedSkillInput);
  assert.equal(skillCommit.inputHash, stableHash({
    prepareRunId: skillCommit.prepareRunId,
    unitId: 'skill-0001',
    prepareInputHash: verifiedSkillInput,
    preparedHandle: 'skill-handle',
    proposalHash: 'skill-proposal',
  }));

  const crystalCall = calls.find((call) =>
    call.endpoint === '/agentmemory/full/crystals/auto' && call.body.dryRun !== true).body;
  assert.equal(crystalCall.groupId, 'cg-1');
  assert.deepEqual(crystalCall.actionIds, ['action-1']);
  assert.deepEqual(crystalCall.actionUpdatedAts, ['2026-07-24T00:00:00.000Z']);

  for (const call of calls.filter((entry) => [
    '/agentmemory/semantic-rollup',
    '/agentmemory/full/crystals/auto',
    '/agentmemory/full/consolidation-procedural-window',
    '/agentmemory/full/reflect-insight-window',
  ].includes(entry.endpoint) && entry.body.dryRun !== true)) {
    assert.equal(typeof call.body.runId, 'string');
    assert.equal(typeof call.body.inputHash, 'string');
    assert.equal(typeof call.body.unitId, 'string');
  }
  assert.deepEqual(
    records.map((record) => [record.stage, record.resultIds]),
    [
      ['memory_consolidate', ['mem-1']],
      ['semantic_rollup', ['sem-1']],
      ['skill_extract', ['skill-1']],
      ['crystal', ['crystal-1']],
      ['consolidation_procedural', ['proc-1']],
      ['reflect_insight', ['insight-1']],
    ],
  );
});

test('default remaining-stage planners stay lazy for journal-backed recovery', async () => {
  const stages = [];
  const skipPlanner = async ({ stage, plan }) => {
    assert.equal(typeof plan, 'function');
    stages.push(stage);
    return { status: 'completed', acceptedCount: 1 };
  };

  const result = await runV2RemainingStages({
    options: { mark: 'test-mark' },
    runId: 'lazy-plan-run',
    config: {
      semantic_window_size: 20,
      semantic_rollup_target_prompt_chars: 64000,
      memory_consolidate_char_budget: 64000,
      reflect_insight_char_budget: 64000,
    },
    configHash: 'config-1',
    inventoryHash: 'inventory-1',
    request: async () => assert.fail('journal-backed recovery must not call a planner endpoint'),
    loadSelectedSessions: async () => assert.fail('journal-backed recovery must not reload planner inputs'),
    stableHash,
    runSingleStage: skipPlanner,
    runTwoPhaseStage: skipPlanner,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(stages, [
    'memory_consolidate',
    'semantic_rollup',
    'skill_extract',
    'crystal',
    'consolidation_procedural',
    'reflect_insight',
  ]);
});

test('idempotent commit response loss stays retryable with the same identity', () => {
  assert.deepEqual(
    classifyIdempotentCommitResponse({
      ok: false,
      status_code: 0,
      error: 'connection reset after request dispatch',
    }, ['memoryIds']),
    { status: 'pending' },
  );
  assert.deepEqual(
    classifyIdempotentCommitResponse({
      ok: false,
      status_code: 503,
      data: {
        success: false,
        retrySameIdentity: true,
        failure: {
          class: 'transient_runtime',
          cause: 'extraction_operation_interrupted',
        },
      },
    }, ['memoryIds']),
    { status: 'pending' },
  );
});

test('v2 stage response classification fails closed on ambiguous and failed envelopes', () => {
  const cases = [
    {
      name: 'missing response body',
      response: { ok: true, status_code: 200, data: null },
      expected: { status: 'failed', payload: { error: 'invalid_stage_response' } },
    },
    {
      name: 'malformed response body',
      response: { ok: true, status_code: 200, data: { raw: '{"success":' } },
      expected: { status: 'failed', payload: { error: 'invalid_stage_response' } },
    },
    {
      name: 'unknown failure cause',
      response: {
        ok: true,
        status_code: 200,
        data: { failure: { cause: 'future_failure_code' } },
      },
      expected: { status: 'failed', payload: { error: 'future_failure_code' } },
    },
    {
      name: 'unknown status',
      response: { ok: true, status_code: 200, data: { status: 'future_status' } },
      expected: { status: 'failed', payload: { error: 'invalid_stage_response' } },
    },
    {
      name: 'HTTP failure with an explicit skip',
      response: {
        ok: false,
        status_code: 409,
        data: { success: true, status: 'skipped' },
      },
      expected: { status: 'failed', payload: { error: 'stage request failed' } },
    },
    {
      name: 'explicit skip with a failure cause',
      response: {
        ok: true,
        status_code: 200,
        data: {
          success: true,
          status: 'skipped',
          failure: { cause: 'future_failure_code' },
        },
      },
      expected: { status: 'failed', payload: { error: 'future_failure_code' } },
    },
    {
      name: 'skip flag with a conflicting status',
      response: {
        ok: true,
        status_code: 200,
        data: { success: true, skipped: true, status: 'future_status' },
      },
      expected: { status: 'failed', payload: { error: 'invalid_stage_response' } },
    },
    {
      name: 'server failure that contains skip-like text',
      response: {
        ok: false,
        status_code: 503,
        data: { success: false, reason: 'none eligible; skipped' },
      },
      expected: { status: 'failed', payload: { error: 'stage request failed' } },
    },
    {
      name: 'transport failure',
      response: { ok: false, status_code: 0, error: 'connection lost' },
      expected: {
        status: 'blocked',
        reason: 'request_transport_failed',
        payload: { error: 'request_transport_failed' },
      },
    },
    {
      name: 'explicit skip',
      response: {
        ok: true,
        status_code: 200,
        data: { success: true, status: 'skipped', reason: 'no eligible inputs' },
      },
      expected: {
        status: 'skipped',
        payload: { result_ids: [], reason: 'no eligible inputs' },
      },
    },
    {
      name: 'explicit success with no result ids',
      response: {
        ok: true,
        status_code: 200,
        data: { success: true, status: 'succeeded', memoryIds: [] },
      },
      expected: { status: 'succeeded', payload: { result_ids: [] } },
    },
    {
      name: 'non-enumerable valid data',
      response: Object.defineProperty(
        { ok: true, status_code: 200 },
        'data',
        {
          value: { success: true, status: 'succeeded', memoryIds: [] },
          enumerable: false,
        },
      ),
      expected: { status: 'succeeded', payload: { result_ids: [] } },
    },
    {
      name: 'explicit null data does not fall back to response',
      response: Object.defineProperty(
        {
          ok: true,
          status_code: 200,
          response: { success: true, status: 'succeeded', memoryIds: ['wrong'] },
        },
        'data',
        { value: null, enumerable: false },
      ),
      expected: { status: 'failed', payload: { error: 'invalid_stage_response' } },
    },
  ];

  for (const { name, response, expected } of cases) {
    assert.deepEqual(classifyResponse(response, ['memoryIds']), expected, name);
  }
});

test('v2 remaining-stage adapters never promote an ambiguous response', async (context) => {
  const common = {
    options: { mark: 'test-mark' },
    runId: 'ambiguous-response-run',
    config: {
      semantic_window_size: 20,
      semantic_rollup_target_prompt_chars: 64000,
      memory_consolidate_char_budget: 64000,
      reflect_insight_char_budget: 64000,
    },
    configHash: 'config-1',
    inventoryHash: 'inventory-1',
    stableHash,
  };

  await context.test('two-phase prepare', async () => {
    const result = await runV2RemainingStages({
      ...common,
      request: async (endpoint, body) => {
        if (endpoint === '/agentmemory/full/memory-consolidate-windows/plan') {
          return body.sessionOffset !== undefined
            ? {
                ok: true,
                data: {
                  success: true,
                  plannerId: body.plannerId,
                  descriptors: [{ id: 'descriptor-1' }],
                  totalSessions: 1,
                  sessionOffset: 0,
                  nextSessionOffset: null,
                  sessionInventoryHash: 'inventory-1',
                },
              }
            : {
                ok: true,
                data: {
                  success: true,
                  plannerId: body.plannerId,
                  windows: [{
                    windowId: 'mcw-1',
                    sourceObservationIds: ['obs-1'],
                    inputHash: 'memory-input',
                  }],
                  totalWindows: 1,
                  windowOffset: 0,
                  nextWindowOffset: null,
                },
              };
        }
        assert.equal(endpoint, '/agentmemory/full/memory-consolidate-window/prepare');
        return { ok: true, status_code: 200, data: null };
      },
      loadSelectedSessions: async () => assert.fail('must stop after memory prepare'),
      runTwoPhaseStage: async ({ plan, adapter }) => {
        const units = await plan();
        const prepared = await adapter.prepare({
          unit: units[0],
          attemptId: adapter.prepareAttemptIdForUnit(units[0]),
          recovered: false,
        });
        assert.deepEqual(prepared, {
          status: 'failed',
          payload: { error: 'invalid_stage_response' },
        });
        return { status: 'failed' };
      },
      runSingleStage: async () => assert.fail('must stop after memory prepare'),
    });
    assert.equal(result.status, 'failed');
  });

  await context.test('single-stage execute', async () => {
    const result = await runV2RemainingStages({
      ...common,
      request: async (endpoint) => {
        assert.equal(endpoint, '/agentmemory/semantic-rollup');
        return { ok: true, status_code: 200, data: { status: 'future_status' } };
      },
      loadSelectedSessions: async () => [{
        id: 's1',
        status: 'completed',
        summary: { title: 'summary' },
      }],
      runTwoPhaseStage: async () => ({ status: 'completed', acceptedCount: 0 }),
      runSingleStage: async ({ stage, plan, adapter }) => {
        assert.equal(stage, 'semantic_rollup');
        const units = await plan();
        const executed = await adapter.execute({
          unit: units[0],
          attemptId: adapter.attemptIdForUnit(units[0]),
          recovered: false,
        });
        assert.deepEqual(executed, {
          status: 'failed',
          payload: { error: 'invalid_stage_response' },
        });
        return { status: 'failed' };
      },
    });
    assert.equal(result.status, 'failed');
  });
});

test('model operation transport loss performs receipt-only reconciliation', async () => {
  const freshModes = [];
  const fresh = await executeReceiptAwareRequest({
    recovered: false,
    invoke: async (requireExistingReceipt) => {
      freshModes.push(requireExistingReceipt);
      return requireExistingReceipt
        ? { ok: true, data: { status: 'succeeded' } }
        : { ok: false, status_code: 0, error: 'response lost' };
    },
  });
  assert.deepEqual(freshModes, [false, true]);
  assert.equal(fresh.response.data.status, 'succeeded');

  const recoveryModes = [];
  const unavailable = await executeReceiptAwareRequest({
    recovered: true,
    invoke: async (requireExistingReceipt) => {
      recoveryModes.push(requireExistingReceipt);
      return { ok: false, status_code: 0, error: 'temporarily unavailable' };
    },
  });
  assert.deepEqual(recoveryModes, [true]);
  assert.deepEqual(unavailable, { pending: true });
});

test('memory and semantic adapters deterministically split oversized units', async () => {
  const memorySplits = [];
  const semanticSplits = [];
  const request = async (endpoint, body) => {
    if (endpoint === '/agentmemory/full/memory-consolidate-windows/plan') {
      return body.sessionOffset !== undefined
        ? {
            ok: true,
            data: {
              success: true,
              plannerId: body.plannerId,
              descriptors: [{ id: 'descriptor-1' }],
              totalSessions: 1,
              sessionOffset: 0,
              nextSessionOffset: null,
              sessionInventoryHash: 'inventory-1',
            },
          }
        : {
            ok: true,
            data: {
              success: true,
              plannerId: body.plannerId,
              windows: [{
                windowId: 'mcw-1',
                sourceObservationIds: ['obs-1', 'obs-2'],
                observationSessionIds: { 'obs-1': 's1', 'obs-2': 's1' },
                inputHash: 'memory-parent',
              }],
              totalWindows: 1,
              windowOffset: 0,
              nextWindowOffset: null,
            },
          };
    }
    if (endpoint === '/agentmemory/full/memory-consolidate-window/prepare') {
      return { ok: false, data: { success: false, error: 'input_too_large' } };
    }
    if (endpoint === '/agentmemory/semantic-rollup') {
      return { ok: false, data: { success: false, error: 'input_too_large' } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const result = await runV2RemainingStages({
    options: { mark: 'test-mark' },
    runId: 'split-run',
    config: {
      semantic_window_size: 20,
      semantic_rollup_target_prompt_chars: 64000,
      memory_consolidate_char_budget: 64000,
      reflect_insight_char_budget: 64000,
    },
    configHash: 'config-1',
    inventoryHash: 'inventory-1',
    request,
    stableHash,
    loadSelectedSessions: async () => [
      { id: 's1', status: 'completed', summary: { title: 'one' } },
      { id: 's2', status: 'completed', summary: { title: 'two' } },
    ],
    runTwoPhaseStage: async ({ stage, plan, adapter }) => {
      assert.equal(stage, 'memory_consolidate');
      plan = await (typeof plan === 'function' ? plan() : plan);
      const prepared = await adapter.prepare({
        unit: plan[0],
        attemptId: adapter.prepareAttemptIdForUnit(plan[0]),
      });
      assert.equal(prepared.status, 'split');
      memorySplits.push(...prepared.children);
      return { status: 'completed', acceptedCount: prepared.children.length };
    },
    runSingleStage: async ({ stage, plan, adapter }) => {
      assert.equal(stage, 'semantic_rollup');
      plan = await (typeof plan === 'function' ? plan() : plan);
      const executed = await adapter.execute({
        unit: plan[0],
        attemptId: adapter.attemptIdForUnit(plan[0]),
      });
      assert.equal(executed.status, 'split');
      semanticSplits.push(...executed.children);
      return { status: 'failed', unitId: plan[0].unit_id };
    },
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(memorySplits.map((unit) => [unit.unit_id, unit.source_ids]), [
    ['mcw-1a', ['obs-1']],
    ['mcw-1b', ['obs-2']],
  ]);
  assert.deepEqual(semanticSplits.map((unit) => [unit.unit_id, unit.source_ids]), [
    ['w0001a', ['s1']],
    ['w0001b', ['s2']],
  ]);
  for (const unit of [...memorySplits, ...semanticSplits]) {
    assert.equal(typeof unit.input_hash, 'string');
    assert.equal(unit.split_from, unit.unit_id.slice(0, -1));
  }
});
