import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyResponse,
  classifyIdempotentCommitResponse,
  exactExtractionOperationReceiptAbsence,
  executeReceiptAwareRequest,
  extractionOperationReconciliationBinding,
  matchesExtractionOperationReceiptAbsence,
  runV2RemainingStages,
} from './full-extraction-stage-adapters-v2.mjs';
import {
  runSinglePhaseStage,
  runTwoPhaseStage as runRecoveryTwoPhaseStage,
} from './recoverable-stage-v2.mjs';
import { RunStateJournalV2 } from './run-state-journal-v2.mjs';

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
      assert.equal(body.requireExistingReceipt, undefined);
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
        recovered: false,
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
    assert.equal(
      modelCall.body.requireExistingReceipt,
      endpoint.endsWith('/prepare') ? undefined : true,
      endpoint,
    );
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
  assert.deepEqual(
    calls
      .filter((call) => call.endpoint === '/agentmemory/full/skill-extract/prepare')
      .map((call) => call.body.requireExistingReceipt),
    [undefined],
  );
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

test('an attention unit does not prevent independent remaining stages from draining', async () => {
  const stages = [];
  const request = async (endpoint, body) => {
    if (endpoint === '/agentmemory/full/memory-consolidate-windows/plan') {
      return body.sessionOffset !== undefined
        ? {
            ok: true,
            data: {
              success: true,
              plannerId: body.plannerId,
              descriptors: [],
              totalSessions: 0,
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
              windows: [],
              totalWindows: 0,
              windowOffset: 0,
              nextWindowOffset: null,
            },
          };
    }
    if (endpoint === '/agentmemory/full/crystals/auto') {
      return { ok: true, data: { success: true, groups: [] } };
    }
    if (endpoint === '/agentmemory/full/consolidation-procedural-windows/plan') {
      return { ok: true, data: { success: true, windows: [] } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  const result = await runV2RemainingStages({
    options: { mark: 'test-mark' },
    runId: 'drain-independent-run',
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
    eligibleStages: {
      semantic_rollup: false,
      skill_extract: false,
      reflect_insight: false,
    },
    loadSelectedSessions: async () => assert.fail('summary-dependent planning must stay deferred'),
    runTwoPhaseStage: async ({ stage, plan }) => {
      stages.push(stage);
      await plan();
      return { status: 'attention_required' };
    },
    runSingleStage: async ({ stage, plan }) => {
      stages.push(stage);
      await plan();
      return { status: 'completed' };
    },
  });

  assert.deepEqual(stages, [
    'memory_consolidate',
    'crystal',
    'consolidation_procedural',
  ]);
  assert.equal(result.status, 'attention_required');
});

test('semantic stage advances through the shared recovery kernel before acceptance', async () => {
  const events = [];
  let semanticResult;
  const request = async (endpoint, body) => {
    if (endpoint === '/agentmemory/semantic-rollup') {
      const domainInputHash = 'a'.repeat(64);
      const configHash = 'b'.repeat(64);
      const effectHash = 'c'.repeat(64);
      const receiptKey = `xop_${createHash('sha256')
        .update(JSON.stringify([body.runId, body.stage, body.unitId]))
        .digest('hex')
        .slice(0, 32)}`;
      return {
        ok: true,
        data: {
          success: true,
          status: 'succeeded',
          runId: body.runId,
          windowId: body.windowId,
          inputHash: domainInputHash,
          configHash,
          semanticMemoryIds: ['sem-1'],
          semanticRecoveryEvidence: {
            schema: 'semantic-rollup-recovery/v1',
            phase: 'committed',
            receiptKey,
            receiptVersion: 1,
            resultRef: 'mem:audit:aud-semantic-1',
            effectHash,
            identity: {
              runId: body.runId,
              unitId: body.unitId,
              receiptInputHash: 'd'.repeat(64),
              runnerInputHash: body.inputHash,
              extractionRunId: body.runId,
              extractionWindowId: body.windowId,
              inputHash: domainInputHash,
              configHash,
            },
            sourceSummaryHashes: body.sourceSummaryHashes,
          },
          operationReceipt: {
            key: receiptKey,
            version: 1,
            status: 'succeeded',
            runId: body.runId,
            stage: body.stage,
            unitId: body.unitId,
            inputHash: 'd'.repeat(64),
            runnerInputHash: body.inputHash,
          },
        },
      };
    }
    if (endpoint === '/agentmemory/extraction-runs/record') {
      return { ok: true, data: { success: true } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  let twoPhaseCalls = 0;
  const result = await runV2RemainingStages({
    options: { mark: 'test-mark' },
    runId: 'kernel-semantic-run',
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
    eligibleStages: {
      memory_consolidate: true,
      semantic_rollup: true,
      skill_extract: true,
      crystal: false,
      consolidation_procedural: false,
      reflect_insight: false,
    },
    loadSelectedSessions: async () => [{
      id: 's1',
      status: 'completed',
      summary: { title: 'Recovery' },
    }],
    runTwoPhaseStage: async () => {
      twoPhaseCalls += 1;
      return twoPhaseCalls === 1
        ? { status: 'completed', acceptedCount: 0 }
        : { status: 'failed' };
    },
    runSingleStage: async ({ stage, plan, adapter }) => {
      assert.equal(stage, 'semantic_rollup');
      const effectivePlan = await plan();
      semanticResult = await runSinglePhaseStage({
        events: [],
        plan: effectivePlan,
        append: async (type, payload) => {
          const event = { seq: events.length, type, payload };
          events.push(event);
          return event;
        },
        ...adapter,
      });
      return semanticResult;
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(semanticResult.status, 'completed');
  assert.deepEqual(
    events.filter((event) => [
      'unit_operation_started',
      'unit_outcome_observed',
      'unit_operation_completed',
      'unit_effect_committed',
      'unit_terminal',
      'unit_resolution',
      'unit_recorded',
    ].includes(event.type)).map((event) => event.type),
    [
      'unit_operation_started',
      'unit_outcome_observed',
      'unit_operation_completed',
      'unit_effect_committed',
      'unit_resolution',
      'unit_recorded',
    ],
  );
});

test('memory commit advances through the same shared recovery kernel', async () => {
  const events = [];
  let memoryResult;
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
                sourceObservationIds: ['obs-1'],
                inputHash: 'memory-plan-input',
              }],
              totalWindows: 1,
              windowOffset: 0,
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
          inputHash: 'memory-prepare-input',
        },
      };
    }
    if (endpoint === '/agentmemory/full/memory-consolidate-window/commit') {
      assert.equal(body.requireExistingReceipt, undefined);
      const key = `xop_${createHash('sha256')
        .update(JSON.stringify([body.runId, body.stage, body.unitId]))
        .digest('hex')
        .slice(0, 32)}`;
      return {
        ok: true,
        data: {
          success: true,
          status: 'succeeded',
          memoryIds: ['mem-1'],
          domainEffectEvidence: {
            schema: 'memory-consolidate-domain-effect/v1',
            proposalHash: 'memory-proposal',
            resultId: 'mem-1',
            auditId: 'memory-audit-1',
            effectHash: 'a'.repeat(64),
          },
          operationReceipt: {
            key,
            version: 1,
            status: 'succeeded',
            runId: body.runId,
            stage: body.stage,
            unitId: body.unitId,
            inputHash: body.inputHash,
            runnerInputHash: body.inputHash,
          },
        },
      };
    }
    if (endpoint === '/agentmemory/extraction-runs/record') {
      return { ok: true, data: { success: true } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const result = await runV2RemainingStages({
    options: { mark: 'test-mark' },
    runId: 'kernel-memory-run',
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
    eligibleStages: {
      memory_consolidate: true,
      semantic_rollup: false,
      skill_extract: false,
      crystal: false,
      consolidation_procedural: false,
      reflect_insight: false,
    },
    loadSelectedSessions: async () => assert.fail('must stop before semantic planning'),
    runTwoPhaseStage: async ({ plan, adapter }) => {
      const effectivePlan = await plan();
      memoryResult = await runRecoveryTwoPhaseStage({
        events: [],
        plan: effectivePlan,
        append: async (type, payload) => {
          const event = { seq: events.length, type, payload };
          events.push(event);
          return event;
        },
        ...adapter,
      });
      return memoryResult;
    },
    runSingleStage: async () => ({ status: 'failed' }),
  });

  assert.equal(result.status, 'completed');
  assert.equal(memoryResult.status, 'completed');
  assert.deepEqual(
    events.filter((event) => [
      'unit_operation_started',
      'unit_outcome_observed',
      'unit_operation_completed',
      'unit_effect_committed',
      'unit_resolution',
      'unit_recorded',
    ].includes(event.type)).map((event) => event.type),
    [
      'unit_operation_started',
      'unit_operation_completed',
      'unit_operation_started',
      'unit_outcome_observed',
      'unit_operation_completed',
      'unit_effect_committed',
      'unit_resolution',
      'unit_recorded',
    ],
  );
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
      eligibleStages: {
        memory_consolidate: true,
        semantic_rollup: false,
        skill_extract: false,
        crystal: false,
        consolidation_procedural: false,
        reflect_insight: false,
      },
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
      eligibleStages: {
        memory_consolidate: true,
        semantic_rollup: true,
        skill_extract: false,
        crystal: false,
        consolidation_procedural: false,
        reflect_insight: false,
      },
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

  const stoppedModes = [];
  const stopped = await executeReceiptAwareRequest({
    recovered: false,
    invoke: async (requireExistingReceipt) => {
      stoppedModes.push(requireExistingReceipt);
      return { ok: false, status_code: 500, data: { error: 'opaque engine failure' } };
    },
  });
  assert.deepEqual(stoppedModes, [false, true]);
  assert.deepEqual(stopped, { pending: true });

  const attemptId = 'missing-receipt-attempt';
  const stage = 'semantic_rollup';
  const unitId = 'semantic-unit';
  const runnerInputHash = 'a'.repeat(64);
  const expectedKey = `xop_${stableHash([attemptId, stage, unitId]).slice(0, 32)}`;
  const absenceModes = [];
  const expectedHashes = [];
  const absentThenRetried = await executeReceiptAwareRequest({
    recovered: true,
    invoke: async (requireExistingReceipt, expectedReceiptInputHash) => {
      absenceModes.push(requireExistingReceipt);
      expectedHashes.push(expectedReceiptInputHash);
      return requireExistingReceipt
        ? {
            ok: false,
            status_code: 503,
            data: {
              failure: {
                class: 'transient_runtime',
                cause: 'extraction_operation_reconciliation_required',
              },
              operationReceiptAbsence: {
                schema: 'extraction-operation-receipt-absence/v1',
                key: expectedKey,
                runId: attemptId,
                stage,
                unitId,
                inputHash: 'b'.repeat(64),
                runnerInputHash,
                observedAt: '2026-07-30T00:00:00.000Z',
              },
            },
          }
        : { ok: true, data: { success: true, status: 'succeeded' } };
    },
    acceptReceiptAbsence: (response) => exactExtractionOperationReceiptAbsence(
      response,
      { attemptId, stage, unitId, runnerInputHash, stableHash },
    ),
  });
  assert.deepEqual(absenceModes, [true, false]);
  assert.deepEqual(expectedHashes, [undefined, 'b'.repeat(64)]);
  assert.equal(absentThenRetried.response.data.status, 'succeeded');
  assert.equal(absentThenRetried.expectedReceiptInputHash, 'b'.repeat(64));

  const tamperedModes = [];
  const tampered = await executeReceiptAwareRequest({
    recovered: true,
    invoke: async (requireExistingReceipt) => {
      tamperedModes.push(requireExistingReceipt);
      return {
        ok: false,
        status_code: 503,
        data: {
          failure: {
            class: 'transient_runtime',
            cause: 'extraction_operation_reconciliation_required',
          },
          operationReceiptAbsence: {
            schema: 'extraction-operation-receipt-absence/v1',
            key: expectedKey,
            runId: attemptId,
            stage,
            unitId: 'different-unit',
            inputHash: 'b'.repeat(64),
            runnerInputHash,
            observedAt: '2026-07-30T00:00:00.000Z',
          },
        },
      };
    },
    acceptReceiptAbsence: (response) => matchesExtractionOperationReceiptAbsence(
      response,
      { attemptId, stage, unitId, runnerInputHash, stableHash },
    ),
  });
  assert.deepEqual(tamperedModes, [true]);
  assert.equal(
    tampered.response.data.operationReceiptAbsence.unitId,
    'different-unit',
  );
});

test('receipt absence can authorize only one bounded fresh retry', async () => {
  const attemptId = 'bounded-absence-attempt';
  const stage = 'lessons';
  const unitId = 'lesson-unit';
  const runnerInputHash = 'a'.repeat(64);
  const inputHash = 'b'.repeat(64);
  const key = `xop_${stableHash([attemptId, stage, unitId]).slice(0, 32)}`;
  const modes = [];
  const result = await executeReceiptAwareRequest({
    recovered: true,
    invoke: async (requireExistingReceipt, expectedReceiptInputHash) => {
      modes.push({ requireExistingReceipt, expectedReceiptInputHash });
      if (!requireExistingReceipt) {
        return {
          ok: false,
          status_code: 502,
          data: { error: 'response_lost' },
        };
      }
      return {
        ok: false,
        status_code: 503,
        data: {
          failure: {
            class: 'transient_runtime',
            cause: 'extraction_operation_reconciliation_required',
          },
          operationReceiptAbsence: {
            schema: 'extraction-operation-receipt-absence/v1',
            key,
            runId: attemptId,
            stage,
            unitId,
            inputHash,
            runnerInputHash,
            observedAt: '2026-07-30T00:00:00.000Z',
          },
        },
      };
    },
    acceptReceiptAbsence: (response) => exactExtractionOperationReceiptAbsence(
      response,
      { attemptId, stage, unitId, runnerInputHash, stableHash },
    ),
  });

  assert.deepEqual(result, { pending: true });
  assert.deepEqual(modes, [
    { requireExistingReceipt: true, expectedReceiptInputHash: undefined },
    { requireExistingReceipt: false, expectedReceiptInputHash: inputHash },
  ]);
});

test('reconciliation binding requires the exact running receipt for every phase', () => {
  const cases = [
    {
      name: 'single',
      expected: {
        attemptId: 'single-attempt',
        stage: 'semantic_rollup',
        unitId: 'semantic-unit',
        runnerInputHash: '1'.repeat(64),
        stableHash,
      },
      mutate: (receipt) => ({ ...receipt, status: 'succeeded' }),
    },
    {
      name: 'prepare',
      expected: {
        attemptId: 'prepare-attempt',
        stage: 'memory_consolidate',
        unitId: 'memory-unit',
        runnerInputHash: '2'.repeat(64),
        stableHash,
      },
      mutate: (receipt) => ({ ...receipt, unitId: 'other-memory-unit' }),
    },
    {
      name: 'commit',
      expected: {
        attemptId: 'commit-attempt',
        stage: 'skill_extract',
        unitId: 'skill-unit',
        runnerInputHash: '3'.repeat(64),
        stableHash,
      },
      mutate: (receipt) => ({ ...receipt, runnerInputHash: '4'.repeat(64) }),
    },
  ];

  for (const item of cases) {
    const receipt = {
      key: `xop_${stableHash([
        item.expected.attemptId,
        item.expected.stage,
        item.expected.unitId,
      ]).slice(0, 32)}`,
      version: 1,
      status: 'running',
      runId: item.expected.attemptId,
      stage: item.expected.stage,
      unitId: item.expected.unitId,
      inputHash: 'a'.repeat(64),
      runnerInputHash: item.expected.runnerInputHash,
      startedAt: '2026-07-30T00:00:00.000Z',
    };
    const response = {
      ok: false,
      status_code: 503,
      data: {
        failure: {
          class: 'transient_runtime',
          cause: 'extraction_operation_reconciliation_required',
        },
        operationReceipt: receipt,
      },
    };
    assert.deepEqual(
      extractionOperationReconciliationBinding(response, item.expected),
      {
        receipt_key: receipt.key,
        receipt_run_id: receipt.runId,
        receipt_stage: receipt.stage,
        receipt_unit_id: receipt.unitId,
        receipt_input_hash: receipt.inputHash,
        receipt_started_at: receipt.startedAt,
      },
      `${item.name} exact receipt`,
    );
    assert.deepEqual(
      extractionOperationReconciliationBinding(response, {
        ...item.expected,
        expectedReceiptInputHash: receipt.inputHash,
      }),
      {
        receipt_key: receipt.key,
        receipt_run_id: receipt.runId,
        receipt_stage: receipt.stage,
        receipt_unit_id: receipt.unitId,
        receipt_input_hash: receipt.inputHash,
        receipt_started_at: receipt.startedAt,
      },
      `${item.name} known service input hash`,
    );
    assert.equal(
      extractionOperationReconciliationBinding(response, {
        ...item.expected,
        expectedReceiptInputHash: 'f'.repeat(64),
      }),
      null,
      `${item.name} drifted service input hash`,
    );
    assert.equal(
      extractionOperationReconciliationBinding(
        {
          ...response,
          data: { ...response.data, operationReceipt: item.mutate(receipt) },
        },
        item.expected,
      ),
      null,
      `${item.name} stale or tampered receipt`,
    );
  }
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
    eligibleStages: {
      memory_consolidate: true,
      semantic_rollup: true,
      skill_extract: false,
      crystal: false,
      consolidation_procedural: false,
      reflect_insight: false,
    },
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

const INTEGRATION_STAGE_CASES = {
  memory_consolidate: {
    family: 'two_phase_prepare_commit',
    prepareEndpoint: '/agentmemory/full/memory-consolidate-window/prepare',
    commitEndpoint: '/agentmemory/full/memory-consolidate-window/commit',
    resultField: 'memoryIds',
    resultId: 'mem-integration',
  },
  skill_extract: {
    family: 'two_phase_prepare_commit',
    prepareEndpoint: '/agentmemory/full/skill-extract/prepare',
    commitEndpoint: '/agentmemory/full/skill-extract/commit',
    resultField: 'proceduralMemoryIds',
    resultId: 'skill-integration',
  },
  semantic_rollup: {
    family: 'generic_single',
    endpoint: '/agentmemory/semantic-rollup',
    resultField: 'semanticMemoryIds',
    resultId: 'semantic-integration',
  },
  crystal: {
    family: 'generic_single',
    endpoint: '/agentmemory/full/crystals/auto',
    resultField: 'crystalIds',
    resultId: 'crystal-integration',
  },
  consolidation_procedural: {
    family: 'generic_single',
    endpoint: '/agentmemory/full/consolidation-procedural-window',
    resultField: 'proceduralMemoryIds',
    resultId: 'procedural-integration',
  },
  reflect_insight: {
    family: 'generic_single',
    endpoint: '/agentmemory/full/reflect-insight-window',
    resultField: 'insightIds',
    resultId: 'insight-integration',
  },
};

const REMAINING_STAGE_NAMES = Object.keys(INTEGRATION_STAGE_CASES);

function eligibleOnly(stage) {
  return Object.fromEntries(
    REMAINING_STAGE_NAMES.map((candidate) => [candidate, candidate === stage]),
  );
}

function actualPlannerResponse(endpoint, body) {
  if (endpoint === '/agentmemory/full/memory-consolidate-windows/plan') {
    return body.sessionOffset !== undefined
      ? {
          ok: true,
          data: {
            success: true,
            plannerId: body.plannerId,
            descriptors: [{ id: 'descriptor-integration' }],
            totalSessions: 1,
            sessionOffset: body.sessionOffset,
            nextSessionOffset: null,
            sessionInventoryHash: 'inventory-integration',
          },
        }
      : {
          ok: true,
          data: {
            success: true,
            plannerId: body.plannerId,
            windows: [{
              windowId: 'memory-unit-integration',
              sourceObservationIds: ['observation-integration'],
              inputHash: stableHash('memory-unit-integration'),
            }],
            totalWindows: 1,
            windowOffset: body.windowOffset,
            nextWindowOffset: null,
          },
        };
  }
  if (endpoint === '/agentmemory/full/crystals/auto' && body.dryRun === true) {
    return {
      ok: true,
      data: {
        success: true,
        groups: [{
          groupId: 'crystal-unit-integration',
          actionIds: ['action-integration'],
          actionUpdatedAts: ['2026-07-31T00:00:00.000Z'],
        }],
      },
    };
  }
  if (endpoint === '/agentmemory/full/consolidation-procedural-windows/plan') {
    return {
      ok: true,
      data: {
        success: true,
        windows: [{
          windowId: 'procedural-unit-integration',
          memoryIds: ['pattern-integration'],
          inputHash: stableHash('procedural-unit-integration'),
        }],
      },
    };
  }
  if (endpoint === '/agentmemory/full/reflect-insight-windows/plan') {
    return {
      ok: true,
      data: {
        success: true,
        windows: [{
          windowId: 'reflect-unit-integration',
          semanticMemoryIds: ['semantic-integration'],
          lessonIds: ['lesson-integration'],
          crystalIds: ['crystal-integration'],
          inputHash: stableHash('reflect-unit-integration'),
        }],
      },
    };
  }
  return null;
}

function receiptKeyFor(body) {
  return `xop_${stableHash([body.runId, body.stage, body.unitId]).slice(0, 32)}`;
}

function serviceInputHashFor(body) {
  return stableHash({
    runId: body.runId,
    stage: body.stage,
    unitId: body.unitId,
    runnerInputHash: body.inputHash,
  });
}

function receiptInputHashFor(stageCase, body, phase) {
  return phase === 'commit' && stageCase.family === 'two_phase_prepare_commit'
    ? body.inputHash
    : serviceInputHashFor(body);
}

function operationReceiptFor(stageCase, body, phase = 'execute') {
  return {
    key: receiptKeyFor(body),
    version: 1,
    status: 'succeeded',
    runId: body.runId,
    stage: body.stage,
    unitId: body.unitId,
    inputHash: receiptInputHashFor(stageCase, body, phase),
    runnerInputHash: body.inputHash,
    startedAt: '2026-07-31T00:00:00.000Z',
  };
}

function successfulOperationResponse(stageCase, body, phase = 'execute') {
  const operationReceipt = operationReceiptFor(stageCase, body, phase);
  if (phase === 'prepare') {
    return {
      ok: true,
      data: {
        success: true,
        status: 'prepared',
        preparedHandle: `${body.stage}-prepared-handle`,
        proposalHash: stableHash(`${body.stage}-proposal`),
        inputHash: serviceInputHashFor(body),
        operationReceipt,
      },
    };
  }
  const common = {
    success: true,
    status: 'succeeded',
    inputHash: operationReceipt.inputHash,
    [stageCase.resultField]: [stageCase.resultId],
    operationReceipt,
  };
  if (stageCase.family === 'two_phase_prepare_commit') {
    return {
      ok: true,
      data: {
        ...common,
        domainEffectEvidence: {
          schema: body.stage === 'memory_consolidate'
            ? 'memory-consolidate-domain-effect/v1'
            : 'skill-extract-domain-effect/v1',
          proposalHash: body.proposalHash,
          resultId: stageCase.resultId,
          auditId: `${body.stage}-audit-integration`,
          effectHash: stableHash({
            stage: body.stage,
            unitId: body.unitId,
            resultId: stageCase.resultId,
          }),
        },
      },
    };
  }
  if (body.stage === 'semantic_rollup') {
    const domainInputHash = stableHash({
      stage: body.stage,
      windowId: body.windowId,
      sourceSummaryHashes: body.sourceSummaryHashes,
    });
    const configHash = stableHash({ stage: body.stage, config: 'integration' });
    return {
      ok: true,
      data: {
        ...common,
        runId: body.runId,
        windowId: body.windowId,
        inputHash: domainInputHash,
        configHash,
        semanticRecoveryEvidence: {
          schema: 'semantic-rollup-recovery/v1',
          phase: 'committed',
          receiptKey: operationReceipt.key,
          receiptVersion: 1,
          resultRef: `mem:audit:${body.unitId}-integration`,
          effectHash: stableHash({ stage: body.stage, resultId: stageCase.resultId }),
          identity: {
            runId: body.runId,
            unitId: body.unitId,
            receiptInputHash: operationReceipt.inputHash,
            runnerInputHash: body.inputHash,
            extractionRunId: body.runId,
            extractionWindowId: body.windowId,
            inputHash: domainInputHash,
            configHash,
          },
          sourceSummaryHashes: body.sourceSummaryHashes,
        },
      },
    };
  }
  if (body.stage === 'crystal') {
    return {
      ok: true,
      data: {
        ...common,
        crystalRecoveryEvidence: {
          schema: 'crystal-recovery/v1',
          phase: 'committed',
          receiptKey: operationReceipt.key,
          receiptVersion: 1,
          resultRef: `crystal:${stageCase.resultId}`,
          effectHash: stableHash({ stage: body.stage, resultId: stageCase.resultId }),
          identity: {
            runId: body.runId,
            unitId: body.unitId,
            inputHash: operationReceipt.inputHash,
          },
          group: {
            groupId: body.groupId,
            actionIds: body.actionIds,
            actionUpdatedAts: body.actionUpdatedAts,
          },
        },
      },
    };
  }
  if (body.stage === 'consolidation_procedural') {
    return {
      ok: true,
      data: {
        ...common,
        proceduralRecoveryEvidence: {
          schema: 'consolidation-procedural-commit/v1',
          kind: 'committed',
          receiptKey: operationReceipt.key,
          receiptVersion: 1,
          resultRef: `procedural-recoveries:${operationReceipt.key}`,
          effectHash: stableHash({ stage: body.stage, resultId: stageCase.resultId }),
          identity: {
            runId: body.runId,
            unitId: body.unitId,
            inputHash: operationReceipt.inputHash,
          },
        },
      },
    };
  }
  if (body.stage === 'reflect_insight') {
    return {
      ok: true,
      data: {
        ...common,
        reflectRecoveryEvidence: {
          schema: 'reflect-insight-commit/v1',
          kind: 'committed',
          receiptKey: operationReceipt.key,
          receiptVersion: 1,
          resultRef: `insights:${stageCase.resultId}`,
          effectHash: stableHash({ stage: body.stage, resultId: stageCase.resultId }),
        },
      },
    };
  }
  return {
    ok: true,
    data: common,
  };
}

function exactAbsenceResponse(stageCase, body, phase = 'execute') {
  return {
    ok: false,
    status_code: 503,
    data: {
      failure: {
        class: 'transient_runtime',
        cause: 'extraction_operation_reconciliation_required',
      },
      operationReceiptAbsence: {
        schema: 'extraction-operation-receipt-absence/v1',
        key: receiptKeyFor(body),
        runId: body.runId,
        stage: body.stage,
        unitId: body.unitId,
        inputHash: receiptInputHashFor(stageCase, body, phase),
        runnerInputHash: body.inputHash,
        observedAt: '2026-07-31T00:00:00.000Z',
      },
    },
  };
}

function assertStableIdentity(calls, label) {
  assert.ok(calls.length >= 2, `${label} must cross a recovery boundary`);
  const expected = calls[0].body;
  for (const call of calls.slice(1)) {
    assert.equal(call.body.runId, expected.runId, `${label} runId`);
    assert.equal(call.body.stage, expected.stage, `${label} stage`);
    assert.equal(call.body.unitId, expected.unitId, `${label} unitId`);
    assert.equal(call.body.inputHash, expected.inputHash, `${label} inputHash`);
  }
}

async function runActualStageCase(stage, runLabel, operationRequest, exercise) {
  const stageCase = INTEGRATION_STAGE_CASES[stage];
  const records = [];
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentmemory-${runLabel}-`));
  const runId = `integration-${stage}-${runLabel}`;
  const journal = new RunStateJournalV2({ rootDir, runId });
  let exercised = 0;
  const request = async (endpoint, body) => {
    const planner = actualPlannerResponse(endpoint, body);
    if (planner) return planner;
    if (endpoint === '/agentmemory/extraction-runs/record') {
      records.push(body);
      return { ok: true, data: { success: true } };
    }
    return operationRequest(endpoint, body, stageCase);
  };
  const runStage = async ({ stage: actualStage, plan, adapter }) => {
    assert.equal(actualStage, stage);
    const units = await (typeof plan === 'function' ? plan() : plan);
    assert.equal(units.length, 1, `${stage} actual planner unit count`);
    assert.equal(units[0].skip_reason, undefined, `${stage} actual planner must be eligible`);
    exercised += 1;
    let failAfterType = null;
    const append = async (type, payload) => {
      const event = await journal.appendStage(stage, type, payload);
      if (failAfterType === type) {
        failAfterType = null;
        throw new Error(`crash_after_${type}`);
      }
      return event;
    };
    const invoke = async () => (
      stageCase.family === 'two_phase_prepare_commit'
        ? runRecoveryTwoPhaseStage({
            events: await journal.readStage(stage),
            plan: units,
            append,
            ...adapter,
          })
        : runSinglePhaseStage({
            events: await journal.readStage(stage),
            plan: units,
            append,
            ...adapter,
          })
    );
    return exercise({
      adapter,
      unit: units[0],
      records,
      stageCase,
      invoke,
      journal,
      failAfter(type) {
        failAfterType = type;
      },
    });
  };
  await journal.acquireLock();
  try {
    await journal.open();
    const result = await runV2RemainingStages({
      options: {
        mark: 'integration-proof',
        memoryConsolidateModel: 'memory-model',
        semanticRollupModel: 'semantic-model',
        skillExtractModel: 'skill-model',
        crystalModel: 'crystal-model',
        proceduralModel: 'procedural-model',
        reflectInsightModel: 'reflect-model',
      },
      runId,
      config: {
        semantic_window_size: 20,
        semantic_rollup_target_prompt_chars: 64000,
        memory_consolidate_char_budget: 64000,
        reflect_insight_char_budget: 64000,
      },
      configHash: 'config-integration',
      inventoryHash: 'inventory-integration',
      request,
      stableHash,
      eligibleStages: eligibleOnly(stage),
      loadSelectedSessions: async () => [{
        id: 'session-integration',
        status: 'completed',
        summary: {
          title: 'Integration proof',
          narrative: 'Exercise the actual stage adapter and its stable operation identity.',
          keyDecisions: ['persist progress before advancing'],
        },
      }],
      runSingleStage: runStage,
      runTwoPhaseStage: runStage,
    });
    assert.equal(exercised, 1, `${stage} actual adapter invocation count`);
    return {
      result,
      records,
      events: await journal.readStage(stage),
    };
  } finally {
    await journal.releaseLock();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function phaseForTwoPhaseEndpoint(stageCase, endpoint) {
  if (endpoint === stageCase.prepareEndpoint) return 'prepare';
  if (endpoint === stageCase.commitEndpoint) return 'commit';
  assert.fail(`unexpected two-phase endpoint: ${endpoint}`);
}

function transientUnknownResponse() {
  return {
    ok: false,
    status_code: 502,
    data: {
      success: false,
      failure: {
        class: 'transient_provider',
        cause: 'provider_response_unknown',
      },
    },
  };
}

test('integration::two_phase_prepare_commit::receipt_protocol_conformance', async () => {
  const stages = Object.entries(INTEGRATION_STAGE_CASES)
    .filter(([, stageCase]) => stageCase.family === 'two_phase_prepare_commit');
  for (const [stage, stageCase] of stages) {
    for (const targetPhase of ['prepare', 'commit']) {
      for (const scenario of ['response_loss', 'exact_absence']) {
        const targetCalls = [];
        const operationRequest = async (endpoint, body) => {
          const phase = phaseForTwoPhaseEndpoint(stageCase, endpoint);
          if (phase !== targetPhase) {
            return successfulOperationResponse(stageCase, body, phase);
          }
          targetCalls.push({ endpoint, body });
          if (scenario === 'response_loss' && targetCalls.length === 1) {
            return { ok: false, status_code: 500, data: { error: 'response_lost' } };
          }
          if (scenario === 'exact_absence') {
            if (targetCalls.length <= 2) return transientUnknownResponse();
            if (targetCalls.length === 3) {
              return exactAbsenceResponse(stageCase, body, phase);
            }
          }
          return successfulOperationResponse(stageCase, body, phase);
        };
        const { result, records } = await runActualStageCase(
          stage,
          `${targetPhase}-${scenario}`,
          operationRequest,
          async ({ invoke }) => {
            if (scenario === 'exact_absence') {
              assert.equal((await invoke()).status, 'pending', `${stage}:${targetPhase}:pending`);
            }
            return invoke();
          },
        );
        assert.equal(result.status, 'completed', `${stage}:${targetPhase}:${scenario}`);
        assert.equal(records.length, 1, `${stage}:${targetPhase}:${scenario}:record`);
        assert.deepEqual(
          targetCalls.map(({ body }) => body.requireExistingReceipt === true),
          scenario === 'response_loss' ? [false, true] : [false, true, true, false],
          `${stage}:${targetPhase}:${scenario}:receipt modes`,
        );
        assertStableIdentity(targetCalls, `${stage}:${targetPhase}:${scenario}`);
        if (scenario === 'exact_absence') {
          assert.equal(
            targetCalls.at(-1).body.expectedReceiptInputHash,
            receiptInputHashFor(stageCase, targetCalls[2].body, targetPhase),
            `${stage}:${targetPhase}:absence binding`,
          );
        }
      }
    }
  }
});

test('integration::generic_single::receipt_protocol_conformance', async () => {
  const stages = Object.entries(INTEGRATION_STAGE_CASES)
    .filter(([, stageCase]) => stageCase.family === 'generic_single');
  for (const [stage, stageCase] of stages) {
    for (const scenario of ['response_loss', 'exact_absence']) {
      const operationCalls = [];
      const operationRequest = async (endpoint, body) => {
        assert.equal(endpoint, stageCase.endpoint, `${stage} actual single endpoint`);
        operationCalls.push({ endpoint, body });
        if (scenario === 'response_loss' && operationCalls.length === 1) {
          return { ok: false, status_code: 500, data: { error: 'response_lost' } };
        }
        if (scenario === 'exact_absence') {
          if (operationCalls.length <= 2) return transientUnknownResponse();
          if (operationCalls.length === 3) {
            return exactAbsenceResponse(stageCase, body);
          }
        }
        return successfulOperationResponse(stageCase, body);
      };
      const { result, records } = await runActualStageCase(
        stage,
        `execute-${scenario}`,
        operationRequest,
        async ({ invoke }) => {
          if (scenario === 'exact_absence') {
            assert.equal((await invoke()).status, 'pending', `${stage}:pending`);
          }
          return invoke();
        },
      );
      assert.equal(result.status, 'completed', `${stage}:${scenario}`);
      assert.equal(records.length, 1, `${stage}:${scenario}:record`);
      assert.deepEqual(
        operationCalls.map(({ body }) => body.requireExistingReceipt === true),
        scenario === 'response_loss' ? [false, true] : [false, true, true, false],
        `${stage}:${scenario}:receipt modes`,
      );
      assertStableIdentity(operationCalls, `${stage}:${scenario}`);
      if (scenario === 'exact_absence') {
        assert.equal(
          operationCalls.at(-1).body.expectedReceiptInputHash,
          receiptInputHashFor(stageCase, operationCalls[2].body, 'execute'),
          `${stage}:absence binding`,
        );
      }
    }
  }
});

test('integration::two_phase_prepare_commit::provider_boundaries_fail_closed', async () => {
  const stages = Object.entries(INTEGRATION_STAGE_CASES)
    .filter(([, stageCase]) => stageCase.family === 'two_phase_prepare_commit');
  for (const [stage, stageCase] of stages) {
    for (const targetPhase of ['prepare', 'commit']) {
      const targetCalls = [];
      const operationRequest = async (endpoint, body) => {
        const phase = phaseForTwoPhaseEndpoint(stageCase, endpoint);
        if (phase !== targetPhase) {
          return successfulOperationResponse(stageCase, body, phase);
        }
        targetCalls.push({ endpoint, body });
        return transientUnknownResponse();
      };
      const { result, records, events } = await runActualStageCase(
        stage,
        `${targetPhase}-provider-failure`,
        operationRequest,
        async ({ invoke }) => {
          assert.equal((await invoke()).status, 'pending', `${stage}:${targetPhase}:first`);
          return invoke();
        },
      );
      assert.equal(result.status, 'pending', `${stage}:${targetPhase}:resumed`);
      assert.equal(records.length, 0, `${stage}:${targetPhase}:no record`);
      assert.equal(
        events.some((event) => ['unit_recorded', 'stage_completed'].includes(event.type)),
        false,
        `${stage}:${targetPhase}:journal not accepted`,
      );
      assert.deepEqual(
        targetCalls.map(({ body }) => body.requireExistingReceipt === true),
        [false, true, true],
        `${stage}:${targetPhase}:receipt-only resume`,
      );
      assert.equal(
        targetCalls.filter(({ body }) => body.requireExistingReceipt !== true).length,
        1,
        `${stage}:${targetPhase}:one provider dispatch`,
      );
      assertStableIdentity(targetCalls, `${stage}:${targetPhase}:provider`);
    }
  }
});

test('integration::generic_single::provider_boundaries_fail_closed', async () => {
  const stages = Object.entries(INTEGRATION_STAGE_CASES)
    .filter(([, stageCase]) => stageCase.family === 'generic_single');
  for (const [stage, stageCase] of stages) {
    const operationCalls = [];
    const operationRequest = async (endpoint, body) => {
      assert.equal(endpoint, stageCase.endpoint, `${stage} actual single endpoint`);
      operationCalls.push({ endpoint, body });
      return transientUnknownResponse();
    };
    const { result, records, events } = await runActualStageCase(
      stage,
      'provider-failure',
      operationRequest,
      async ({ invoke }) => {
        assert.equal((await invoke()).status, 'pending', `${stage}:first`);
        return invoke();
      },
    );
    assert.equal(result.status, 'pending', `${stage}:resumed`);
    assert.equal(records.length, 0, `${stage}:no record`);
    assert.equal(
      events.some((event) => ['unit_recorded', 'stage_completed'].includes(event.type)),
      false,
      `${stage}:journal not accepted`,
    );
    assert.deepEqual(
      operationCalls.map(({ body }) => body.requireExistingReceipt === true),
      [false, true, true],
      `${stage}:receipt-only resume`,
    );
    assert.equal(
      operationCalls.filter(({ body }) => body.requireExistingReceipt !== true).length,
      1,
      `${stage}:one provider dispatch`,
    );
    assertStableIdentity(operationCalls, `${stage}:provider`);
  }
});

test('integration::two_phase_prepare_commit::persisted_progress_resumes_without_duplicate_effect', async () => {
  const stages = Object.entries(INTEGRATION_STAGE_CASES)
    .filter(([, stageCase]) => stageCase.family === 'two_phase_prepare_commit');
  for (const [stage, stageCase] of stages) {
    const phaseCalls = { prepare: [], commit: [] };
    const operationRequest = async (endpoint, body) => {
      const phase = phaseForTwoPhaseEndpoint(stageCase, endpoint);
      phaseCalls[phase].push({ endpoint, body });
      return successfulOperationResponse(stageCase, body, phase);
    };
    const { result, records, events } = await runActualStageCase(
      stage,
      'persisted-progress',
      operationRequest,
      async ({ invoke, failAfter }) => {
        failAfter('unit_effect_committed');
        await assert.rejects(invoke, /crash_after_unit_effect_committed/);
        const resumed = await invoke();
        assert.equal(resumed.status, 'completed', `${stage}:resumed`);
        assert.deepEqual(await invoke(), resumed, `${stage}:completed replay`);
        return resumed;
      },
    );
    assert.equal(result.status, 'completed', `${stage}:completed`);
    assert.deepEqual(
      phaseCalls.prepare.map(({ body }) => body.requireExistingReceipt === true),
      [false],
      `${stage}:one provider effect`,
    );
    assert.deepEqual(
      phaseCalls.commit.map(({ body }) => body.requireExistingReceipt === true),
      [false, true],
      `${stage}:one formal effect plus receipt verification`,
    );
    assert.equal(records.length, 1, `${stage}:one record`);
    assert.equal(
      events.filter((event) => event.type === 'unit_effect_committed').length,
      1,
      `${stage}:one committed effect fact`,
    );
    assert.equal(
      events.filter((event) => event.type === 'unit_recorded').length,
      1,
      `${stage}:one recorded fact`,
    );
  }
});

test('integration::generic_single::persisted_progress_resumes_without_duplicate_effect', async () => {
  const stages = Object.entries(INTEGRATION_STAGE_CASES)
    .filter(([, stageCase]) => stageCase.family === 'generic_single');
  for (const [stage, stageCase] of stages) {
    const operationCalls = [];
    const operationRequest = async (endpoint, body) => {
      assert.equal(endpoint, stageCase.endpoint, `${stage} actual single endpoint`);
      operationCalls.push({ endpoint, body });
      return successfulOperationResponse(stageCase, body);
    };
    const { result, records, events } = await runActualStageCase(
      stage,
      'persisted-progress',
      operationRequest,
      async ({ invoke, failAfter }) => {
        failAfter('unit_effect_committed');
        await assert.rejects(invoke, /crash_after_unit_effect_committed/);
        const resumed = await invoke();
        assert.equal(resumed.status, 'completed', `${stage}:resumed`);
        assert.deepEqual(await invoke(), resumed, `${stage}:completed replay`);
        return resumed;
      },
    );
    assert.equal(result.status, 'completed', `${stage}:completed`);
    assert.deepEqual(
      operationCalls.map(({ body }) => body.requireExistingReceipt === true),
      [false, true],
      `${stage}:one formal effect plus receipt verification`,
    );
    assert.equal(
      operationCalls.filter(({ body }) => body.requireExistingReceipt !== true).length,
      1,
      `${stage}:one provider and formal effect`,
    );
    assert.equal(records.length, 1, `${stage}:one record`);
    assert.equal(
      events.filter((event) => event.type === 'unit_effect_committed').length,
      1,
      `${stage}:one committed effect fact`,
    );
    assert.equal(
      events.filter((event) => event.type === 'unit_recorded').length,
      1,
      `${stage}:one recorded fact`,
    );
  }
});
