import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorizeSummaryFailedTerminalRetry } from './authorize-agentmemory-summary-failed-terminal-retry.mjs';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';
import {
  appendRecoveryContractFence,
  buildRecoveryMigrationManifest,
} from './lib/recovery-frontier-migration-v1.mjs';
import { RECOVERY_POLICY_VERSION } from './lib/recovery-policy-v1.mjs';
import { reconcileSummaryOrphan } from './reconcile-agentmemory-extraction-orphan.mjs';
import { mainForTest, stableHash } from './run-agentmemory-full-extraction.mjs';

function mainForEarlyStages(argv, dependencies = {}) {
  return mainForTest(argv, {
    v2RuntimeCheck: async () => ({ summarizeChunkConcurrency: 1 }),
    ...dependencies,
    v2RemainingStages: false,
  });
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function successfulSummaryResponse({ attemptId, inputHash }, title = 'summary') {
  const summary = { title };
  const resumableRunId = stableHash({ attemptId, inputHash, source: 'resumable-run' });
  return {
    ok: true,
    data: {
      status: 'succeeded',
      attemptId,
      runnerInputHash: inputHash,
      serviceInputHash: stableHash({ attemptId, inputHash, source: 'summary-service' }),
      resumableRunId,
      summary,
      recoveryEvidence: {
        kind: 'committed',
        receiptKey: `xop_${stableHash({ attemptId, inputHash }).slice(0, 32)}`,
        receiptVersion: 1,
        resultRef: `mem:summary-resumable:runs:${resumableRunId}`,
        effectHash: stableHash({
          title,
          narrative: '',
          keyDecisions: [],
          filesModified: [],
          concepts: [],
        }),
      },
    },
  };
}

function runningSummaryOperationReceipt({
  attemptId,
  runnerInputHash,
  operationUnitId,
}) {
  return {
    key: `xop_${stableHash([attemptId, 'summary', operationUnitId]).slice(0, 32)}`,
    version: 1,
    status: 'running',
    runId: attemptId,
    stage: 'summary',
    unitId: operationUnitId,
    inputHash: stableHash({ attemptId, runnerInputHash, operationUnitId }),
    runnerInputHash,
    startedAt: '2026-07-30T00:00:00.000Z',
  };
}

function missingOperationReceiptResponse({
  attemptId,
  stage,
  unitId,
  runnerInputHash,
}) {
  return {
    ok: false,
    status_code: 503,
    data: {
      success: false,
      failure: {
        class: 'transient_runtime',
        cause: 'extraction_operation_reconciliation_required',
      },
      operationReceiptAbsence: {
        schema: 'extraction-operation-receipt-absence/v1',
        key: `xop_${stableHash([attemptId, stage, unitId]).slice(0, 32)}`,
        runId: attemptId,
        stage,
        unitId,
        inputHash: stableHash({ attemptId, stage, unitId, runnerInputHash }),
        runnerInputHash,
        observedAt: '2026-07-30T00:00:00.000Z',
      },
    },
  };
}

function committedLessonResponse(runId = 'lesson-run-1') {
  const planId = `plan-${runId}`;
  return {
    ok: true,
    data: {
      runs: [{ id: runId, status: 'succeeded' }],
      lessonEvidence: [{
        kind: 'committed',
        runId,
        stagingId: `staging-${runId}`,
        planId,
        receiptKey: `lcr_${stableHash({ runId, planId }).slice(0, 32)}`,
        receiptVersion: 1,
        resultRef: `lesson-commit-plans:${planId}`,
        effectHash: stableHash({ runId, planId, effect: 'lessons' }),
      }],
    },
  };
}

test('new runner refuses business APIs while a fenced migration is incomplete', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-fenced-runner-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const runId = 'fenced-runner';
  const journal = new RunStateJournalV2({
    rootDir: path.join(stateDir, `${runId}.v2`),
    runId,
  });
  await journal.acquireLock();
  try {
    await journal.appendStage('lessons', 'unit_planned', {
      unit_id: 'lesson-a',
      input_hash: 'input-a',
    });
    await journal.appendStage('lessons', 'stage_plan_completed', { unit_count: 1 });
    await journal.appendStage('lessons', 'unit_started', {
      unit_id: 'lesson-a',
      attempt_id: 'attempt-a',
    });
    await journal.appendStage('lessons', 'unit_terminal', {
      unit_id: 'lesson-a',
      attempt_id: 'attempt-a',
      status: 'failed',
    });
  } finally {
    await journal.releaseLock();
  }
  const manifest = buildRecoveryMigrationManifest({
    runId,
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: {
      'lesson-a': {
        adapter: 'lessons/legacy-safe-facts-v1',
        attempt_id: 'attempt-a',
        operation_id: 'lesson-a:legacy',
        safe_facts: { failure: { cause: 'response_lost' } },
      },
    },
    originalContractVersion: 'run-state-journal-v2/legacy',
    targetContractVersion: RECOVERY_POLICY_VERSION,
    originalPolicyVersion: 'legacy-stage-recovery/v2',
    targetPolicyVersion: RECOVERY_POLICY_VERSION,
    upgradeAt: '2026-07-30T00:00:00.000Z',
    authorizedAt: '2026-07-30T00:00:00.000Z',
    authorizationSourceType: 'change_ticket',
  });
  await appendRecoveryContractFence({
    journal,
    stage: 'lessons',
    manifest,
    expectedManifestHash: manifest.manifest_hash,
    verifyOfflineWritersAbsent: async () => ({
      oldRunnerAbsent: true,
      writerLockAbsent: true,
      otherWritersAbsent: true,
    }),
    verifyEvidenceProvenance: async () => ({
      source_type: 'trusted_read_only_collector',
      safeEvidenceByUnit: {
        'lesson-a': {
          adapter: 'lessons/legacy-safe-facts-v1',
          attempt_id: 'attempt-a',
          operation_id: 'lesson-a:legacy',
          safe_facts: { failure: { cause: 'response_lost' } },
        },
      },
    }),
  });
  let businessCalls = 0;
  const result = await mainForEarlyStages([
    '--base-url', 'http://127.0.0.1:9',
    '--state-dir', stateDir,
    '--run-id', runId,
    '--run-state-format', 'v2',
    '--resume',
  ], {
    v2RuntimeCheck: async () => {
      businessCalls += 1;
      throw new Error('runtime API must not be called');
    },
    v2SummaryRemote: {
      advance: async () => {
        businessCalls += 1;
      },
      record: async () => {
        businessCalls += 1;
      },
    },
    v2LessonsRemote: {
      start: async () => {
        businessCalls += 1;
      },
      record: async () => {
        businessCalls += 1;
      },
    },
  });
  assert.equal(result, 1);
  assert.equal(businessCalls, 0);
  const status = JSON.parse(await fs.readFile(journal.statusPath, 'utf8'));
  assert.equal(status.status, 'blocked');
  assert.equal(status.system_block_reason_code, 'recovery_migration_incomplete');
});

async function prepareAuthorizedLegacySummaryRun({ baseUrl, stateDir, runId }) {
  const argv = [
    '--base-url', baseUrl,
    '--state-dir', stateDir,
    '--run-id', runId,
    '--run-state-format', 'v2',
  ];
  const lessonsRemote = {
    start: async ({ attemptId }) => ({
      ok: true,
      data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
    }),
    record: async () => {},
  };
  assert.equal(await mainForEarlyStages([...argv, '--dry-run'], {
    v2SummaryRemote: {
      advance: async () => assert.fail('dry-run must not dispatch Summary'),
      record: async () => assert.fail('dry-run must not record Summary'),
    },
    v2LessonsRemote: lessonsRemote,
  }), 0);
  const rootDir = path.join(stateDir, `${runId}.v2`);
  const journal = new RunStateJournalV2({ rootDir, runId });
  await journal.acquireLock();
  let planned;
  let attemptId;
  let failedTerminal;
  try {
    await journal.open();
    const plannedEvents = await journal.readStage('summary');
    planned = plannedEvents.find((event) => event.type === 'unit_planned');
    attemptId = stableHash({ run_id: runId, stage: 'summary', unit_id: 's1' });
    await journal.appendStage('summary', 'unit_started', {
      unit_id: 's1',
      input_hash: planned.payload.input_hash,
      attempt_id: attemptId,
    });
    await journal.appendStage('summary', 'unit_operation_started', {
      unit_id: 's1',
      attempt_id: attemptId,
      operation_id: 's1:map:0',
    });
    await journal.appendStage('summary', 'unit_operation_completed', {
      unit_id: 's1',
      attempt_id: attemptId,
      operation_id: 's1:map:0',
      status: 'completed',
      completed_chunks: 1,
      total_chunks: 1,
      skipped_chunks: 0,
      next_operation_id: 's1:reduce',
    });
    await journal.appendStage('summary', 'unit_operation_started', {
      unit_id: 's1',
      attempt_id: attemptId,
      operation_id: 's1:reduce',
    });
    const completed = await journal.appendStage('summary', 'unit_operation_completed', {
      unit_id: 's1',
      attempt_id: attemptId,
      operation_id: 's1:reduce',
      status: 'failed',
      error: 'pi_stream_failed',
      terminal_result: {
        status: 'failed',
        payload: { error: 'pi_stream_failed' },
      },
    });
    failedTerminal = await journal.appendStage('summary', 'unit_terminal', {
      unit_id: 's1',
      attempt_id: attemptId,
      status: 'failed',
      error: 'pi_stream_failed',
    });
    assert.equal(completed.seq + 1, failedTerminal.seq);
  } finally {
    await journal.releaseLock();
  }
  const receiptInputHash = 'c'.repeat(64);
  const lastSafeTimestamp = '2026-07-28T00:00:00.000Z';

  await authorizeSummaryFailedTerminalRetry({
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir,
    formalRunId: runId,
    expectedJournalSeq: failedTerminal.seq,
    unitId: 's1',
    attemptId,
    operationId: 's1:reduce',
    runnerInputHash: planned.payload.input_hash,
    receiptInputHash,
    expectedFailureClass: 'transient_provider',
    expectedFailureCause: 'pi_stream_failed',
    expectedFailurePhase: 'provider_call',
    expectedRetryEpoch: 0,
    expectedLastSafeFailure: {
      errorClass: 'transient_provider',
      cause: 'pi_stream_failed',
      phase: 'provider_call',
      timestamp: lastSafeTimestamp,
    },
  }, {
    lookupReceipt: async () => ({
      success: true,
      operation: {
        runId: attemptId,
        stage: 'summary',
        unitId: 's1:reduce',
        inputHash: receiptInputHash,
      },
      receipt: {
        status: 'failed',
        startedAt: '2026-07-27T23:59:00.000Z',
        completedAt: '2026-07-28T00:00:01.000Z',
        failure: {
          class: 'transient_provider',
          cause: 'pi_stream_failed',
          phase: 'provider_call',
        },
        retry: {
          epoch: 0,
          lastSafeFailure: {
            errorClass: 'transient_provider',
            cause: 'pi_stream_failed',
            phase: 'provider_call',
            timestamp: lastSafeTimestamp,
          },
        },
      },
    }),
  });

  return {
    argv,
    lessonsRemote,
    rootDir,
    receiptInputHash,
    attemptId,
    runnerInputHash: planned.payload.input_hash,
  };
}

test('default v2 runs the shared runtime concurrency gate before inventory access', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-runtime-gate-'));
  try {
    await assert.rejects(
      () => mainForEarlyStages([
        '--base-url', 'http://127.0.0.1:1',
        '--state-dir', stateDir,
        '--run-id', 'runtime-gate',
      ], {
        v2RuntimeCheck: async () => {
          throw new Error('SUMMARIZE_CHUNK_CONCURRENCY=2');
        },
      }),
      /SUMMARIZE_CHUNK_CONCURRENCY=2/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 explicit resume takes over a dead writer lock for the same run', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-stale-lock-'));
  const runRoot = path.join(stateDir, 'stale-lock.v2');
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot, 'writer.lock.json'), JSON.stringify({
    run_id: 'stale-lock',
    pid: 2147483647,
    created_at: '2026-07-24T00:00:00.000Z',
    owner_id: 'dead-owner',
  }));
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [] }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'stale-lock',
        '--run-state-format', 'v2',
        '--dry-run',
      ];
      await assert.rejects(
        () => mainForEarlyStages(argv),
        /v2_writer_lock_stale_requires_verified_takeover/,
      );
      assert.equal(await mainForEarlyStages([...argv, '--resume']), 0);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary treats unit_started without an inner operation as not yet dispatched', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-runner-'));
  const attempts = [];
  const recorded = [];
  let summaryVisible = false;
  const lessonsRemote = {
    start: async ({ attemptId }) => ({ ok: true, data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] } }),
    record: async () => {},
  };
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{
          id: 's1',
          startedAt: '2026-07-22T00:00:00.000Z',
          observationCount: 1,
          ...(summaryVisible
            ? {
                summary: {
                  title: 'durable summary',
                  narrative: 'The persisted result is the recovery authority.',
                  observationCount: 1,
                },
              }
            : {}),
        }],
      }));
    }, async (baseUrl) => {
      const argv = ['--base-url', baseUrl, '--state-dir', stateDir, '--run-id', 'summary-recovery', '--run-state-format', 'v2'];
      await assert.rejects(
        () => mainForEarlyStages(argv, {
          v2SummaryRemote: { advance: async () => assert.fail('must not call before unit_started durability'), record: async () => {} },
          v2LessonsRemote: lessonsRemote,
          onV2DurableEvent: async ({ type }) => { if (type === 'unit_started') throw new Error('injected_crash'); },
        }),
        /injected_crash/,
      );
      summaryVisible = true;
      const code = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async ({ attemptId, inputHash, requireExistingReceipt }) => {
            attempts.push({ attemptId, inputHash, requireExistingReceipt });
            return successfulSummaryResponse({
              attemptId: 'old-attempt',
              inputHash,
            }, 'durable summary');
          },
          record: async ({ attemptId }) => { recorded.push(attemptId); },
        },
        v2LessonsRemote: lessonsRemote,
      });
      assert.equal(code, 1);
      const root = path.join(stateDir, 'summary-recovery.v2');
      const stage = (await fs.readFile(path.join(root, 'summary.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(stage.at(-1).type, 'run_blocked');
      assert.equal(stage.at(-1).payload.reason, 'reconciliation_evidence_missing');
      assert.equal(stage.some((event) => event.type === 'unit_reconciliation_requested'), false);
      assert.equal(stage.some((event) => event.type === 'unit_terminal'), false);
    });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].requireExistingReceipt, false);
    assert.equal(typeof attempts[0].attemptId, 'string');
    assert.equal(typeof attempts[0].inputHash, 'string');
    assert.equal(recorded.length, 0);
    const root = path.join(stateDir, 'summary-recovery.v2');
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control[0].payload.format, 'run-state-journal-v2');
    assert.equal(control[0].payload.schema_version, 2);
    assert.equal(control.some((event) => event.type === 'stage_sealed'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary recovery waits when no durable result is visible', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-missing-'));
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'summary-missing',
        '--run-state-format', 'v2',
      ];
      await assert.rejects(() => mainForEarlyStages(argv, {
        v2SummaryRemote: {
          advance: async () => assert.fail('must not call before operation_started durability'),
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async () => assert.fail('lessons must not start'),
          record: async () => {},
        },
        onV2DurableEvent: async ({ type }) => {
          if (type === 'unit_operation_started') throw new Error('injected_crash');
        },
      }), /injected_crash/);

      const code = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async ({ requireExistingReceipt }) => {
            assert.equal(requireExistingReceipt, true);
            return {
              ok: false,
              error: 'extraction_operation_reconciliation_required',
              data: {
                status: 'failed',
                failure: { cause: 'extraction_operation_reconciliation_required' },
              },
            };
          },
          record: async () => assert.fail('missing result must not be recorded'),
        },
        v2LessonsRemote: {
          start: async () => assert.fail('lessons must not start'),
          record: async () => {},
        },
      });
      assert.equal(code, 1);
    });
    const events = (await fs.readFile(
      path.join(stateDir, 'summary-missing.v2', 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'run_blocked');
    assert.equal(events.at(-1).payload.reason, 'reconciliation_evidence_missing');
    assert.equal(events.some((event) => event.type === 'unit_reconciliation_requested'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary retries the same identity after exact missing-receipt proof', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-absence-'));
  const requests = [];
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'summary-absence',
        '--run-state-format', 'v2',
      ];
      await assert.rejects(() => mainForEarlyStages(argv, {
        v2SummaryRemote: {
          advance: async () => assert.fail('must not dispatch before operation journal durability'),
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async () => assert.fail('lessons must not start before Summary recovery'),
          record: async () => {},
        },
        onV2DurableEvent: async ({ scope, type }) => {
          if (scope === 'summary' && type === 'unit_operation_started') {
            throw new Error('injected_crash');
          }
        },
      }), /injected_crash/);

      const code = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async (request) => {
            requests.push(request);
            return request.requireExistingReceipt
              ? missingOperationReceiptResponse({
                  attemptId: request.attemptId,
                  stage: 'summary',
                  unitId: request.operationUnitId,
                  runnerInputHash: request.inputHash,
                })
              : successfulSummaryResponse(request, 'absence recovery');
          },
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async () => committedLessonResponse('lesson-after-summary-absence'),
          record: async () => {},
        },
      });

      assert.equal(code, 0);
    });
    assert.deepEqual(
      requests.map((request) => request.requireExistingReceipt),
      [true, false],
    );
    assert.equal(
      requests[1].expectedReceiptInputHash,
      stableHash({
        attemptId: requests[0].attemptId,
        stage: 'summary',
        unitId: requests[0].operationUnitId,
        runnerInputHash: requests[0].inputHash,
      }),
    );
    const events = (await fs.readFile(
      path.join(stateDir, 'summary-absence.v2', 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'stage_completed');
    assert.equal(events.some((event) => event.type === 'run_blocked'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary keeps an uncontracted 5xx pending and re-verifies the same receipt', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-5xx-'));
  const calls = [];
  const lessonsRemote = {
    start: async ({ attemptId }) => ({
      ok: true,
      data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
    }),
    record: async () => {},
  };
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'summary-uncontracted-5xx',
        '--run-state-format', 'v2',
      ];
      const firstCode = await mainForEarlyStages(argv, {
        v2SummaryRemote: {
          advance: async (request) => {
            calls.push(request);
            return {
              ok: false,
              status_code: 500,
              data: { error: 'generic runtime failure' },
            };
          },
          record: async () => assert.fail('unverified result must not be recorded'),
        },
        v2LessonsRemote: lessonsRemote,
      });
      assert.equal(firstCode, 75);

      const resumedCode = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async (request) => {
            calls.push(request);
            assert.equal(request.requireExistingReceipt, true);
            return {
              ...successfulSummaryResponse(request, 'recovered summary'),
              data: {
                ...successfulSummaryResponse(request, 'recovered summary').data,
                operationUnitId: request.operationUnitId,
              },
            };
          },
          record: async () => {},
        },
        v2LessonsRemote: lessonsRemote,
      });
      assert.equal(resumedCode, 0);
    });
    assert.deepEqual(calls.map((call) => call.requireExistingReceipt), [false, true]);
    const events = (await fs.readFile(
      path.join(stateDir, 'summary-uncontracted-5xx.v2', 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(events.some((event) => event.type === 'unit_reconciliation_requested'), false);
    assert.ok(
      events.some((event) => event.type === 'unit_resolution'),
      JSON.stringify(events.map((event) => ({
        type: event.type,
        action: event.payload?.decision?.action,
      }))),
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 Summary routes structured domain and unknown outcomes through recovery evidence', async (context) => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  try {
    const scenarios = [
      {
        name: 'skipped',
        status: 'skipped',
        expectedCode: 0,
        expectedObservation: 'business_empty',
        expectedAction: 'skipped',
      },
      {
        name: 'infeasible',
        status: 'infeasible',
        expectedCode: 1,
        expectedObservation: 'business_rejected',
        expectedAction: 'isolate',
      },
      {
        name: 'unknown',
        status: 'future_summary_state',
        expectedCode: 1,
        expectedObservation: null,
        expectedAction: 'reconcile',
      },
      {
        name: 'proved-no-effect',
        status: 'preflight_unavailable',
        expectedCode: 75,
        expectedObservation: 'execution_error',
        expectedAction: 'retry',
        expectedNotBefore: '2099-07-30T00:00:00.000Z',
      },
    ];

    for (const scenario of scenarios) {
      await context.test(scenario.name, async () => {
        const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-contract-'));
        try {
          await withServer((request, response) => {
            assert.equal(request.url, '/agentmemory/sessions?agentId=*');
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
              success: true,
              sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
            }));
          }, async (baseUrl) => {
            const argv = [
              '--base-url', baseUrl,
              '--state-dir', stateDir,
              '--run-id', `summary-contract-${scenario.name}`,
              '--run-state-format', 'v2',
            ];
            const summaryRemote = {
              advance: async ({ attemptId, operationUnitId }) => ({
                ok: true,
                data: {
                  status: scenario.status,
                  error: scenario.status,
                  operationUnitId,
                  ...(scenario.expectedObservation
                    ? {
                        recoveryEvidence: {
                          kind: 'no_effect',
                          observation: scenario.expectedObservation,
                          reasonCode: scenario.status,
                          ...(scenario.expectedNotBefore
                            ? { retryHint: { notBefore: scenario.expectedNotBefore } }
                            : {}),
                          proof: {
                            kind: 'receipt_before_formal_effect',
                            receiptKey: 'receipt-1',
                            receiptVersion: 1,
                            phase: 'preflight',
                            commitPlanAbsent: true,
                          },
                        },
                      }
                    : {}),
                },
              }),
              record: async () => {},
            };
            const lessonsRemote = {
              start: async ({ attemptId }) => ({
                ok: true,
                data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
              }),
              record: async () => {},
            };
            assert.equal(await mainForEarlyStages(argv, {
              v2SummaryRemote: summaryRemote,
              v2LessonsRemote: lessonsRemote,
            }), scenario.expectedCode);
          });

          const journalPath = path.join(
            stateDir,
            `summary-contract-${scenario.name}.v2`,
            'summary.jsonl',
          );
          const events = (await fs.readFile(journalPath, 'utf8'))
            .trim()
            .split('\n')
            .map(JSON.parse);
          const observed = events.find((event) => event.type === 'unit_outcome_observed');
          assert.equal(observed.payload.decision.action, scenario.expectedAction);
          if (scenario.expectedObservation) {
            assert.equal(observed.payload.evidence.kind, 'no_effect');
            assert.equal(observed.payload.evidence.observation, scenario.expectedObservation);
          } else {
            assert.equal(observed.payload.evidence.kind, 'unknown');
          }
          assert.equal(
            events.some((event) => event.type.startsWith('unit_summary_')),
            false,
          );
          if (scenario.expectedAction === 'retry') {
            assert.equal(events.at(-1).type, 'unit_retry_scheduled');
            assert.equal(
              events.at(-1).payload.decision.notBefore,
              scenario.expectedNotBefore,
            );
            assert.equal(events.at(-1).payload.retry_at, scenario.expectedNotBefore);
          }
        } finally {
          await fs.rm(stateDir, { recursive: true, force: true });
        }
      });
    }
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 Summary isolates one permanent failure without stopping an independent unit', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-independent-'));
  const recorded = [];
  const lessonStarts = [];
  const lessonRecords = [];
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [
          { id: 'failed-session', startedAt: '2026-07-22T00:00:00.000Z' },
          { id: 'healthy-session', startedAt: '2026-07-22T00:01:00.000Z' },
        ],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'independent-summary-units',
        '--run-state-format', 'v2',
      ];
      const code = await mainForEarlyStages(argv, {
        v2SummaryRemote: {
          advance: async (request) => {
            if (request.sessionId === 'healthy-session') {
              return successfulSummaryResponse(request, 'healthy');
            }
            return {
              ok: true,
              data: {
                status: 'infeasible',
                error: 'infeasible',
                operationUnitId: request.operationUnitId,
                recoveryEvidence: {
                  kind: 'no_effect',
                  observation: 'business_rejected',
                  reasonCode: 'infeasible',
                  proof: {
                    kind: 'receipt_before_formal_effect',
                    receiptKey: 'receipt-failed-session',
                    receiptVersion: 1,
                    phase: 'preflight',
                    commitPlanAbsent: true,
                  },
                },
              },
            };
          },
          record: async ({ sessionId }) => recorded.push(sessionId),
        },
        v2LessonsRemote: {
          start: async ({ sessionId, attemptId }) => {
            lessonStarts.push(sessionId);
            assert.equal(sessionId, 'healthy-session');
            return {
              ok: true,
              data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
            };
          },
          record: async ({ runId }) => lessonRecords.push(runId),
        },
      });
      assert.equal(code, 1);
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async () => assert.fail('isolated Summary must not redispatch'),
          record: async () => assert.fail('recorded Summary must not record again'),
        },
        v2LessonsRemote: {
          start: async () => assert.fail('reduced dependencies must not redispatch'),
          record: async () => assert.fail('recorded Lesson must not record again'),
        },
      }), 1);
    });

    const root = path.join(stateDir, 'independent-summary-units.v2');
    const events = (await fs.readFile(path.join(root, 'summary.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(recorded, ['healthy-session']);
    assert.deepEqual(lessonStarts, ['healthy-session']);
    assert.equal(lessonRecords.length, 1);
    assert.equal(events.at(-1).type, 'run_attention_required');
    assert.equal(
      events.some((event) => (
        event.type === 'unit_resolution'
        && event.payload.unit_id === 'healthy-session'
        && event.payload.status === 'succeeded'
      )),
      true,
    );
    const status = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8'));
    assert.equal(status.status, 'attention_required');
    assert.equal(status.summary.status, 'attention_required');
    assert.equal(status.summary.acceptance_ready, false);
    assert.equal(status.summary.recovery.isolated, 1);
    assert.equal(status.summary.recovery.succeeded, 1);
    const lessons = (await fs.readFile(path.join(root, 'lessons.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const dependencyBlock = lessons.find((event) => (
      event.type === 'unit_dependency_blocked'
    ));
    assert.equal(dependencyBlock.payload.unit_id, 'failed-session');
    assert.deepEqual(dependencyBlock.payload.dependencies, [{
      stage: 'summary',
      unit_id: 'failed-session',
      state: 'isolated',
      terminal: 'failed',
      recorded: false,
      source_seq: events.find((event) => event.type === 'unit_isolated').seq,
    }]);
    assert.equal(
      lessons.some((event) => (
        event.type === 'unit_terminal'
        && event.payload.unit_id === 'healthy-session'
        && event.payload.status === 'succeeded'
      )),
      true,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('v2 Summary attention still drains an independent remaining stage', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-cross-stage-drain-'));
  const executed = [];
  const recorded = [];
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 'failed-summary', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const code = await mainForTest([
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'cross-stage-drain',
        '--run-state-format', 'v2',
      ], {
        v2RuntimeCheck: async () => ({ summarizeChunkConcurrency: 1 }),
        v2SummaryRemote: {
          advance: async (request) => ({
            ok: true,
            data: {
              status: 'infeasible',
              error: 'infeasible',
              operationUnitId: request.operationUnitId,
              recoveryEvidence: {
                kind: 'no_effect',
                observation: 'business_rejected',
                reasonCode: 'infeasible',
                proof: {
                  kind: 'receipt_before_formal_effect',
                  receiptKey: 'receipt-failed-summary',
                  receiptVersion: 1,
                  phase: 'preflight',
                  commitPlanAbsent: true,
                },
              },
            },
          }),
          record: async () => assert.fail('isolated Summary must not record'),
        },
        v2LessonsRemote: {
          start: async () => assert.fail('Summary-dependent Lesson must not dispatch'),
          record: async () => assert.fail('Summary-dependent Lesson must not record'),
        },
        v2RemainingStages: async ({ eligibleStages, runSingleStage }) => {
          assert.deepEqual(eligibleStages, {
            semantic_rollup: false,
            skill_extract: false,
            reflect_insight: false,
          });
          return runSingleStage({
            stage: 'memory_consolidate',
            plan: [{
              unit_id: 'independent-memory-unit',
              source_ids: ['memory-1'],
              input_hash: 'independent-memory-input',
            }],
            adapter: {
              attemptIdForUnit: () => 'independent-memory-attempt',
              execute: async ({ unit }) => {
                executed.push(unit.unit_id);
                return { status: 'succeeded', payload: { memory_ids: ['memory-1'] } };
              },
              record: async ({ unit }) => recorded.push(unit.unit_id),
            },
          });
        },
      });
      assert.equal(code, 1);
    });

    assert.deepEqual(executed, ['independent-memory-unit']);
    assert.deepEqual(recorded, ['independent-memory-unit']);
    const events = (await fs.readFile(
      path.join(stateDir, 'cross-stage-drain.v2', 'memory_consolidate.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(
      events.some((event) => (
        event.type === 'unit_terminal'
        && event.payload.unit_id === 'independent-memory-unit'
        && event.payload.status === 'succeeded'
      )),
      true,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('v2 summary recovery reconciles one durable chunk before advancing the next chunk', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-cursor-'));
  const receiptModes = [];
  const operationIds = [];
  let responseLost = true;
  let recoveredSteps = 0;
  const lessonsRemote = {
    start: async ({ attemptId }) => ({
      ok: true,
      data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
    }),
    record: async () => {},
  };
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'summary-cursor',
        '--run-state-format', 'v2',
      ];
      const summaryRemote = {
        advance: async ({ attemptId, inputHash, operationUnitId, requireExistingReceipt }) => {
          receiptModes.push(requireExistingReceipt);
          operationIds.push(operationUnitId);
          if (responseLost) {
            responseLost = false;
            throw new Error('summary_response_lost');
          }
          recoveredSteps += 1;
          if (recoveredSteps <= 2) {
            return {
              ok: true,
              data: {
                status: 'in_progress',
                advanced: 'completed',
                completedChunks: recoveredSteps,
                totalChunks: 2,
                operationUnitId,
              },
            };
          }
          return successfulSummaryResponse({ attemptId, inputHash }, 'merged summary');
        },
        record: async () => {},
      };

      await assert.rejects(
        () => mainForEarlyStages(argv, { v2SummaryRemote: summaryRemote, v2LessonsRemote: lessonsRemote }),
        /summary_response_lost/,
      );
      assert.equal(await mainForEarlyStages(
        [...argv, '--resume'],
        { v2SummaryRemote: summaryRemote, v2LessonsRemote: lessonsRemote },
      ), 0);
    });

    assert.deepEqual(receiptModes, [false, true, false, false]);
    assert.deepEqual(operationIds, [
      's1:map:0',
      's1:map:0',
      's1:map:1',
      's1:reduce',
    ]);
    const events = (await fs.readFile(
      path.join(stateDir, 'summary-cursor.v2', 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.type), [
      'unit_planned',
      'stage_plan_completed',
      'unit_started',
      'unit_operation_started',
      'unit_operation_completed',
      'unit_operation_started',
      'unit_operation_completed',
      'unit_operation_started',
      'unit_operation_completed',
      'unit_outcome_observed',
      'unit_effect_committed',
      'unit_resolution',
      'unit_recorded',
      'stage_completed',
    ]);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary does not retry a provider failure without persisted no-effect evidence', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-retryable-reduce-'));
  const receiptModes = [];
  let reduceFailed = false;
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'summary-retryable-reduce',
        '--run-state-format', 'v2',
      ];
      const summaryRemote = {
        advance: async ({ attemptId, inputHash, operationUnitId, requireExistingReceipt }) => {
          receiptModes.push(requireExistingReceipt);
          if (operationUnitId === 's1:map:0' || operationUnitId === 's1:map:1') {
            const completedChunks = operationUnitId.endsWith(':0') ? 1 : 2;
            return {
              ok: true,
              data: {
                status: 'in_progress',
                advanced: 'completed',
                completedChunks,
                totalChunks: 2,
                operationUnitId,
              },
            };
          }
          if (!reduceFailed) {
            reduceFailed = true;
            return {
              ok: false,
              status_code: 500,
              data: {
                status: 'failed',
                operationUnitId,
                failure: {
                  class: 'transient_provider',
                  cause: 'network_error',
                  phase: 'provider_call',
                },
                operationReceipt: runningSummaryOperationReceipt({
                  attemptId,
                  runnerInputHash: inputHash,
                  operationUnitId,
                }),
              },
            };
          }
          return {
            ...successfulSummaryResponse({ attemptId, inputHash }, 'retried reduce'),
            data: {
              ...successfulSummaryResponse({ attemptId, inputHash }, 'retried reduce').data,
              operationUnitId,
            },
          };
        },
        record: async () => {},
      };
      const lessonsRemote = {
        start: async ({ attemptId }) => ({ ok: true, data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] } }),
        record: async () => {},
      };

      assert.equal(await mainForEarlyStages(argv, {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 75);
      const status = JSON.parse(await fs.readFile(
        path.join(stateDir, 'summary-retryable-reduce.v2', 'status.json'),
        'utf8',
      ));
      assert.equal(status.summary.recovery.reconciling, 1);
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 75);
    });
    assert.deepEqual(receiptModes, [false, false, false]);
    const events = (await fs.readFile(
      path.join(stateDir, 'summary-retryable-reduce.v2', 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'unit_reconciliation_requested');
    assert.equal(events.some((event) => event.type === 'unit_terminal'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary consumes an authorized legacy failed terminal through the existing receipt', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-authorized-retry-'));
  const runId = 'summary-authorized-retry';
  const receiptInputHash = 'c'.repeat(64);
  const receiptModes = [];
  try {
    await withServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/agentmemory/sessions?agentId=*') {
        response.end(JSON.stringify({
          success: true,
          sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/agentmemory/summarize/resumable') {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const payload = JSON.parse(raw);
        receiptModes.push({
          operationUnitId: payload.operationUnitId,
          requireExistingReceipt: payload.requireExistingReceipt === true,
          failedReceiptRetryAuthorization: payload.failedReceiptRetryAuthorization,
        });
        const succeeded = successfulSummaryResponse({
          attemptId: payload.attemptId,
          inputHash: payload.inputHash,
        }, 'authorized retry').data;
        response.end(JSON.stringify({
          success: true,
          ...succeeded,
          operationUnitId: payload.operationUnitId,
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/agentmemory/extraction-runs/record') {
        response.end(JSON.stringify({ success: true }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ success: false }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', runId,
        '--run-state-format', 'v2',
      ];
      const lessonsRemote = {
        start: async ({ attemptId }) => ({
          ok: true,
          data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
        }),
        record: async () => {},
      };

      await prepareAuthorizedLegacySummaryRun({
        baseUrl,
        stateDir,
        runId,
      });

      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2LessonsRemote: lessonsRemote,
      }), 0);
    });

    assert.deepEqual(receiptModes, [
      {
        operationUnitId: 's1:reduce',
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization: {
          receiptInputHash,
          retryEpoch: 0,
          failureClass: 'transient_provider',
          failureCause: 'pi_stream_failed',
          failurePhase: 'provider_call',
          lastSafeFailure: {
            errorClass: 'transient_provider',
            cause: 'pi_stream_failed',
            phase: 'provider_call',
            timestamp: '2026-07-28T00:00:00.000Z',
          },
        },
      },
    ]);
    const events = (await fs.readFile(
      path.join(stateDir, `${runId}.v2`, 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(
      events.filter((event) => event.type === 'unit_summary_failed_terminal_retry_authorized').length,
      1,
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'unit_terminal')
        .map((event) => event.payload.status),
      ['failed'],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'unit_resolution')
        .map((event) => event.payload.status),
      ['succeeded'],
    );
    assert.equal(
      events.filter((event) =>
        event.type === 'unit_operation_completed'
        && event.payload.operation_id === 's1:reduce').length,
      2,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('v2 summary authorized retry preserves recoverable receipt boundaries', async (context) => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const scenarios = [
    {
      name: 'safe failure becomes a new terminal that can be authorized again',
      responses: [{
        ok: false,
        status_code: 500,
        data: {
          status: 'failed',
          operationUnitId: 's1:reduce',
          failure: {
            class: 'transient_provider',
            cause: 'provider_retry_failed',
            phase: 'provider_call',
          },
        },
      }],
      expectedCodes: [1],
      expectedLastType: 'unit_terminal',
      expectedCause: 'provider_retry_failed',
      reauthorize: true,
    },
    {
      name: 'lost safe-failure response becomes the real failure terminal on resume',
      responses: [
        { ok: false, status_code: 0, error: 'response_lost' },
        {
          ok: false,
          status_code: 500,
          data: {
            status: 'failed',
            operationUnitId: 's1:reduce',
            failure: {
              class: 'transient_runtime',
              cause: 'reduce_retry_failed',
              phase: 'before_final_persistence',
            },
          },
        },
      ],
      expectedCodes: [75, 1],
      expectedLastType: 'unit_terminal',
      expectedCause: 'reduce_retry_failed',
    },
    {
      name: 'lost succeeded response replays success',
      responses: [
        { ok: false, status_code: 0, error: 'response_lost' },
        'success',
      ],
      expectedCodes: [75, 0],
      expectedLastType: 'stage_completed',
      expectedCause: null,
    },
    {
      name: 'lost running response reconciles absent and resumes without stale authorization',
      responses: [
        { ok: false, status_code: 0, error: 'response_lost' },
        {
          ok: false,
          status_code: 409,
          data: {
            status: 'failed',
            failure: {
              class: 'transient_runtime',
              cause: 'extraction_operation_reconciliation_required',
            },
          },
        },
        'success',
      ],
      expectedCodes: [75, 75],
      expectedLastType: 'stage_completed',
      expectedCause: null,
      reconcileAfterBlock: true,
    },
  ];

  try {
    for (const scenario of scenarios) {
      await context.test(scenario.name, async () => {
        const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-authorized-boundary-'));
        const runId = `authorized-${scenario.name.replaceAll(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;
        try {
          await withServer((request, response) => {
            assert.equal(request.url, '/agentmemory/sessions?agentId=*');
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
              success: true,
              sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
            }));
          }, async (baseUrl) => {
            const prepared = await prepareAuthorizedLegacySummaryRun({
              baseUrl,
              stateDir,
              runId,
            });
            let responseIndex = 0;
            const requests = [];
            const summaryRemote = {
              advance: async (request) => {
                requests.push(request);
                const response = scenario.responses[responseIndex++];
                assert.notEqual(response, undefined, 'unexpected authorized summary dispatch');
                if (response === 'success') {
                  return {
                    ...successfulSummaryResponse(request, 'replayed success'),
                    data: {
                      ...successfulSummaryResponse(request, 'replayed success').data,
                      operationUnitId: request.operationUnitId,
                    },
                  };
                }
                return response;
              },
              record: async () => {},
            };

            for (const expectedCode of scenario.expectedCodes) {
              const code = await mainForEarlyStages([...prepared.argv, '--resume'], {
                v2SummaryRemote: summaryRemote,
                v2LessonsRemote: prepared.lessonsRemote,
              });
              assert.equal(code, expectedCode);
            }

            if (scenario.reconcileAfterBlock) {
              const journal = new RunStateJournalV2({
                rootDir: prepared.rootDir,
                runId,
              });
              const blockedEvents = await journal.readStage('summary');
              const blocked = blockedEvents.at(-1);
              assert.equal(blocked.type, 'unit_blocked');
              assert.equal(
                blocked.payload.reason,
                'extraction_operation_reconciliation_required',
              );
              const receiptStartedAt = '2026-07-28T00:02:00.000Z';
              const reconciliation = await reconcileSummaryOrphan({
                stateDir,
                formalRunId: runId,
                expectedJournalSeq: blocked.seq,
                operation: {
                  runId: prepared.attemptId,
                  stage: 'summary',
                  unitId: 's1:reduce',
                  inputHash: prepared.receiptInputHash,
                  expectedStatus: 'running',
                  expectedStartedAt: receiptStartedAt,
                },
                result: {
                  sessionId: 's1',
                  resumableRunId: `sumr_${'d'.repeat(24)}`,
                  serviceInputHash: 'e'.repeat(64),
                  runnerInputHash: prepared.runnerInputHash,
                  generationConfigHash: 'f'.repeat(64),
                },
              }, {
                reconcileReceipt: async ({ operation }) => ({
                  success: true,
                  replayed: false,
                  operation: {
                    runId: operation.runId,
                    stage: operation.stage,
                    unitId: operation.unitId,
                    inputHash: operation.inputHash,
                  },
                  receipt: {
                    status: 'reconciled',
                    startedAt: receiptStartedAt,
                    completedAt: '2026-07-28T00:02:01.000Z',
                    failure: {
                      class: 'transient_runtime',
                      cause: 'orphaned_operation_result_absent',
                    },
                  },
                  reconciliation: {
                    id: 'xrec_0123456789abcdef0123456789abcdef',
                    at: '2026-07-28T00:02:01.000Z',
                    resultStatus: 'absent',
                  },
                }),
              });
              assert.equal(reconciliation.success, true);

              const resumedCode = await mainForEarlyStages([...prepared.argv, '--resume'], {
                v2SummaryRemote: summaryRemote,
                v2LessonsRemote: prepared.lessonsRemote,
              });
              assert.equal(resumedCode, 0);
            }

            assert.equal(requests.length, scenario.responses.length);
            for (const [requestIndex, request] of requests.entries()) {
              assert.equal(request.operationUnitId, 's1:reduce');
              assert.equal(request.attemptId, prepared.attemptId);
              assert.equal(request.inputHash, prepared.runnerInputHash);
              if (scenario.reconcileAfterBlock && requestIndex === requests.length - 1) {
                assert.equal(request.requireExistingReceipt, false);
                assert.equal(request.failedReceiptRetryAuthorization, undefined);
                continue;
              }
              assert.equal(request.requireExistingReceipt, true);
              assert.equal(request.failedReceiptRetryAuthorization.retryEpoch, 0);
              assert.equal(
                request.failedReceiptRetryAuthorization.receiptInputHash,
                prepared.receiptInputHash,
              );
            }
            const events = (await fs.readFile(
              path.join(prepared.rootDir, 'summary.jsonl'),
              'utf8',
            )).trim().split('\n').map(JSON.parse);
            assert.equal(events.at(-1).type, scenario.expectedLastType);
            assert.equal(
              events.some((event) =>
                event.type === 'unit_terminal'
                && event.payload.error === 'extraction_operation_retry_authorization_drifted'),
              false,
            );
            if (scenario.expectedLastType === 'unit_terminal') {
              assert.equal(events.at(-1).payload.error, scenario.expectedCause);
              const completed = events.at(-2);
              assert.equal(completed.type, 'unit_operation_completed');
              assert.equal(completed.payload.error, scenario.expectedCause);
              assert.equal(completed.payload.terminal_result.payload.error, scenario.expectedCause);
            }
            if (scenario.expectedLastType === 'unit_blocked') {
              assert.equal(events.at(-1).payload.reason, scenario.expectedCause);
            }
            if (scenario.reconcileAfterBlock) {
              assert.equal(
                events.filter((event) => event.type === 'unit_reconciliation_resolved').length,
                1,
              );
              assert.equal(
                events.filter((event) =>
                  event.type === 'unit_operation_started'
                  && event.payload.operation_id === 's1:reduce').length,
                3,
              );
            }
            if (scenario.reauthorize) {
              const terminal = events.at(-1);
              const secondAuthorization = await authorizeSummaryFailedTerminalRetry({
                engineUrl: 'ws://127.0.0.1:49134',
                stateDir,
                formalRunId: runId,
                expectedJournalSeq: terminal.seq,
                unitId: 's1',
                attemptId: prepared.attemptId,
                operationId: 's1:reduce',
                runnerInputHash: prepared.runnerInputHash,
                receiptInputHash: prepared.receiptInputHash,
                expectedFailureClass: 'transient_provider',
                expectedFailureCause: scenario.expectedCause,
                expectedFailurePhase: 'provider_call',
                expectedRetryEpoch: 1,
                expectedLastSafeFailure: {
                  errorClass: 'transient_provider',
                  cause: scenario.expectedCause,
                  phase: 'provider_call',
                  timestamp: '2026-07-28T00:01:00.000Z',
                },
              }, {
                lookupReceipt: async () => ({
                  success: true,
                  operation: {
                    runId: prepared.attemptId,
                    stage: 'summary',
                    unitId: 's1:reduce',
                    inputHash: prepared.receiptInputHash,
                  },
                  receipt: {
                    status: 'failed',
                    startedAt: '2026-07-27T23:59:00.000Z',
                    completedAt: '2026-07-28T00:01:01.000Z',
                    failure: {
                      class: 'transient_provider',
                      cause: scenario.expectedCause,
                      phase: 'provider_call',
                    },
                    retry: {
                      epoch: 1,
                      lastSafeFailure: {
                        errorClass: 'transient_provider',
                        cause: scenario.expectedCause,
                        phase: 'provider_call',
                        timestamp: '2026-07-28T00:01:00.000Z',
                      },
                    },
                  },
                }),
              });
              assert.equal(secondAuthorization.replayed, false);
            }
          });
        } finally {
          await fs.rm(stateDir, { recursive: true, force: true });
        }
      });
    }
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary recovery appends each accepted outcome fact once across final boundaries', async (context) => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  context.after(() => {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  });

  for (const crashType of [
    'unit_operation_completed',
    'unit_outcome_observed',
    'unit_effect_committed',
    'unit_resolution',
  ]) {
    await context.test(`crash after ${crashType}`, async () => {
      const stateDir = await fs.mkdtemp(path.join(
        os.tmpdir(),
        `agentmemory-v2-summary-${crashType}-`,
      ));
      const runId = `summary-${crashType}`;
      let summaryCalls = 0;
      let providerCalls = 0;
      let crashPending = true;
      const lessonsRemote = {
        start: async ({ attemptId }) => ({
          ok: true,
          data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
        }),
        record: async () => {},
      };
      try {
        await withServer((request, response) => {
          assert.equal(request.url, '/agentmemory/sessions?agentId=*');
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            success: true,
            sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
          }));
        }, async (baseUrl) => {
          const argv = [
            '--base-url', baseUrl,
            '--state-dir', stateDir,
            '--run-id', runId,
            '--run-state-format', 'v2',
          ];
          const summaryRemote = {
            advance: async ({
              attemptId,
              inputHash,
              operationUnitId,
              requireExistingReceipt,
            }) => {
              summaryCalls += 1;
              if (!requireExistingReceipt) providerCalls += 1;
              return {
                ...successfulSummaryResponse({ attemptId, inputHash }, 'terminal summary'),
                data: {
                  ...successfulSummaryResponse({ attemptId, inputHash }, 'terminal summary').data,
                  operationUnitId,
                },
              };
            },
            record: async () => {},
          };

          await assert.rejects(() => mainForEarlyStages(argv, {
            v2SummaryRemote: summaryRemote,
            v2LessonsRemote: lessonsRemote,
            onV2DurableEvent: async ({ type }) => {
              if (crashPending && type === crashType) {
                crashPending = false;
                throw new Error(`crash_after_${crashType}`);
              }
            },
          }), new RegExp(`crash_after_${crashType}`));

          assert.equal(await mainForEarlyStages([...argv, '--resume'], {
            v2SummaryRemote: summaryRemote,
            v2LessonsRemote: lessonsRemote,
          }), 0);
        });

        const events = (await fs.readFile(
          path.join(stateDir, `${runId}.v2`, 'summary.jsonl'),
          'utf8',
        )).trim().split('\n').map(JSON.parse);
        for (const type of [
          'unit_outcome_observed',
          'unit_effect_committed',
          'unit_resolution',
        ]) {
          assert.equal(events.filter((event) => event.type === type).length, 1);
        }
        assert.equal(summaryCalls, 2);
        assert.equal(providerCalls, 1);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('v2 recovery consumes the completed journal plan instead of a rebuilt live plan', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-persisted-plan-'));
  const persistedUnit = {
    unit_id: 'crystal-group:1:repo',
    source_ids: ['action-1'],
    action_ids: ['action-1'],
    action_updated_ats: ['2026-07-24T00:00:00.000Z'],
    input_hash: 'pinned-crystal-input',
  };
  const summaryRemote = {
    advance: async (request) => successfulSummaryResponse(request),
    record: async () => {},
  };
  const lessonsRemote = {
    start: async ({ attemptId }) => ({
      ok: true,
      data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
    }),
    record: async () => {},
  };
  try {
    await withServer((request, response) => {
      assert.equal(request.url, '/agentmemory/sessions?agentId=*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-22T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'persisted-plan',
        '--run-state-format', 'v2',
      ];
      const baseDependencies = {
        v2RuntimeCheck: async () => ({ summarizeChunkConcurrency: 1 }),
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      };
      await assert.rejects(
        () => mainForTest(argv, {
          ...baseDependencies,
          v2RemainingStages: ({ runSingleStage }) => runSingleStage({
            stage: 'crystal',
            plan: [persistedUnit],
            adapter: {
              attemptIdForUnit: () => 'crystal-attempt',
              execute: async () => {
                throw new Error('crystal_response_lost');
              },
              record: async () => {},
            },
          }),
        }),
        /crystal_response_lost/,
      );

      assert.equal(await mainForTest([...argv, '--resume'], {
        ...baseDependencies,
        v2RemainingStages: ({ runSingleStage }) => runSingleStage({
          stage: 'crystal',
          plan: async () => {
            throw new Error('completed journal plan must skip live planner');
          },
          adapter: {
            attemptIdForUnit: () => 'must-not-replace-persisted-attempt',
            execute: async ({ unit, attemptId, recovered }) => {
              assert.equal(unit.unit_id, persistedUnit.unit_id);
              assert.deepEqual(unit.action_ids, persistedUnit.action_ids);
              assert.deepEqual(unit.action_updated_ats, persistedUnit.action_updated_ats);
              assert.equal(unit.input_hash, persistedUnit.input_hash);
              assert.equal(attemptId, 'crystal-attempt');
              assert.equal(recovered, true);
              return { status: 'succeeded', payload: { result_ids: ['crystal-1'] } };
            },
            record: async ({ unit }) => {
              assert.equal(unit.unit_id, persistedUnit.unit_id);
              assert.deepEqual(unit.action_ids, persistedUnit.action_ids);
            },
          },
        }),
      }), 0);
    });

    const events = (await fs.readFile(
      path.join(stateDir, 'persisted-plan.v2', 'crystal.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter((event) => event.type === 'unit_planned').map((event) => event.payload), [
      persistedUnit,
    ]);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 default production adapters send stable summary and lesson identities', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-contract-'));
  const requests = [];
  try {
    await withServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = body ? JSON.parse(body) : null;
      requests.push({ url: request.url, payload });
      const operationReceipt = (stage, serviceInputHash = payload?.inputHash) => ({
        key: `xop_${stableHash([payload.runId, stage, payload.unitId]).slice(0, 32)}`,
        version: 1,
        status: 'succeeded',
        runId: payload.runId,
        stage,
        unitId: payload.unitId,
        inputHash: serviceInputHash,
        runnerInputHash: payload.inputHash,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/agentmemory/runtime-config') {
        response.end(JSON.stringify({
          success: true,
          runtime: { summarizeChunkConcurrency: 1 },
        }));
      } else if (request.url.startsWith('/agentmemory/sessions')) {
        response.end(JSON.stringify({
          success: true,
          sessions: [{
            id: 's1',
            status: 'completed',
            startedAt: '2026-07-22T00:00:00.000Z',
            summary: { title: 'summary', narrative: 'durable recovery' },
          }],
        }));
      } else if (request.url === '/agentmemory/summarize/resumable') {
        response.end(JSON.stringify({
          success: true,
          ...successfulSummaryResponse({
            attemptId: payload.attemptId,
            inputHash: payload.inputHash,
          }).data,
        }));
      } else if (request.url === '/agentmemory/lessons/extract') {
        response.end(JSON.stringify({ success: true, runs: [{ id: 'lesson-1', status: 'succeeded' }] }));
      } else if (request.url === '/agentmemory/full/memory-consolidate-windows/plan') {
        response.end(JSON.stringify(payload.sessionOffset !== undefined
          ? {
              success: true,
              plannerId: payload.plannerId,
              descriptors: [{ id: 'descriptor-1' }],
              totalSessions: 1,
              sessionOffset: payload.sessionOffset,
              nextSessionOffset: null,
              sessionInventoryHash: 'inventory-1',
            }
          : {
              success: true,
              plannerId: payload.plannerId,
              windows: [{
                windowId: 'mcw-1',
                concept: 'recovery',
                sourceObservationIds: ['obs-1'],
                inputHash: 'memory-input-1',
              }],
              totalWindows: 1,
              windowOffset: payload.windowOffset,
              nextWindowOffset: null,
            }));
      } else if (request.url === '/agentmemory/full/memory-consolidate-window/prepare') {
        response.end(JSON.stringify({
          success: true,
          status: 'prepared',
          preparedHandle: 'memory-handle-1',
          proposalHash: 'memory-proposal-1',
          inputHash: 'memory-verified-input-1',
        }));
      } else if (request.url === '/agentmemory/full/memory-consolidate-window/commit') {
        response.end(JSON.stringify({
          success: true,
          status: 'succeeded',
          memoryIds: ['mem-1'],
          domainEffectEvidence: {
            schema: 'memory-consolidate-domain-effect/v1',
            proposalHash: 'memory-proposal-1',
            resultId: 'mem-1',
            auditId: 'memory-audit-1',
            effectHash: '5'.repeat(64),
          },
          operationReceipt: operationReceipt('memory_consolidate'),
        }));
      } else if (request.url === '/agentmemory/semantic-rollup') {
        const receipt = operationReceipt('semantic_rollup', 'a'.repeat(64));
        response.end(JSON.stringify({
          success: true,
          status: 'succeeded',
          runId: payload.runId,
          windowId: payload.windowId,
          inputHash: 'b'.repeat(64),
          configHash: 'c'.repeat(64),
          semanticMemoryIds: ['sem-1'],
          semanticRecoveryEvidence: {
            schema: 'semantic-rollup-recovery/v1',
            phase: 'committed',
            receiptKey: receipt.key,
            receiptVersion: 1,
            resultRef: 'mem:audit:audit-semantic-1',
            effectHash: 'd'.repeat(64),
            identity: {
              runId: payload.runId,
              unitId: payload.unitId,
              receiptInputHash: receipt.inputHash,
              runnerInputHash: payload.inputHash,
              extractionRunId: payload.runId,
              extractionWindowId: payload.windowId,
              inputHash: 'b'.repeat(64),
              configHash: 'c'.repeat(64),
            },
            sourceSummaryHashes: payload.sourceSummaryHashes,
          },
          operationReceipt: receipt,
        }));
      } else if (request.url === '/agentmemory/full/skill-extract/prepare') {
        response.end(JSON.stringify({
          success: true,
          status: 'prepared',
          preparedHandle: 'skill-handle-1',
          proposalHash: 'skill-proposal-1',
          inputHash: 'skill-verified-input-1',
        }));
      } else if (request.url === '/agentmemory/full/skill-extract/commit') {
        response.end(JSON.stringify({
          success: true,
          status: 'succeeded',
          proceduralMemoryIds: ['skill-1'],
          domainEffectEvidence: {
            schema: 'skill-extract-domain-effect/v1',
            proposalHash: 'skill-proposal-1',
            resultId: 'skill-1',
            auditId: 'skill-audit-1',
            effectHash: '6'.repeat(64),
          },
          operationReceipt: operationReceipt('skill_extract'),
        }));
      } else if (request.url === '/agentmemory/full/crystals/auto' && payload.dryRun === true) {
        response.end(JSON.stringify({
          success: true,
          groups: [{
            groupId: 'cg-1',
            actionIds: ['action-1'],
            actionUpdatedAts: ['2026-07-22T00:00:00.000Z'],
          }],
        }));
      } else if (request.url === '/agentmemory/full/crystals/auto') {
        const receipt = operationReceipt('crystal', 'e'.repeat(64));
        response.end(JSON.stringify({
          success: true,
          crystalIds: ['crystal-1'],
          groups: [{ groupId: 'cg-1', status: 'succeeded', crystalIds: ['crystal-1'] }],
          crystalRecoveryEvidence: {
            schema: 'crystal-recovery/v1',
            phase: 'committed',
            receiptKey: receipt.key,
            receiptVersion: receipt.version,
            resultRef: 'crystal:crystal-1',
            effectHash: 'f'.repeat(64),
            identity: {
              runId: payload.runId,
              unitId: payload.unitId,
              inputHash: receipt.inputHash,
            },
            group: {
              groupId: payload.groupId,
              actionIds: payload.actionIds,
              actionUpdatedAts: payload.actionUpdatedAts,
            },
          },
          operationReceipt: receipt,
        }));
      } else if (request.url === '/agentmemory/full/consolidation-procedural-windows/plan') {
        response.end(JSON.stringify({
          success: true,
          windows: [{ windowId: 'cpw-1', memoryIds: ['pattern-1'], inputHash: 'proc-input-1' }],
        }));
      } else if (request.url === '/agentmemory/full/consolidation-procedural-window') {
        const receipt = operationReceipt('consolidation_procedural', '1'.repeat(64));
        response.end(JSON.stringify({
          success: true,
          status: 'succeeded',
          inputHash: receipt.inputHash,
          proceduralMemoryIds: ['proc-1'],
          proceduralRecoveryEvidence: {
            schema: 'consolidation-procedural-commit/v1',
            kind: 'committed',
            receiptKey: receipt.key,
            receiptVersion: 1,
            resultRef: `procedural-recoveries:${receipt.key}`,
            effectHash: '2'.repeat(64),
            identity: {
              runId: payload.runId,
              unitId: payload.unitId,
              inputHash: receipt.inputHash,
            },
          },
          operationReceipt: receipt,
        }));
      } else if (request.url === '/agentmemory/full/reflect-insight-windows/plan') {
        response.end(JSON.stringify({
          success: true,
          windows: [{
            windowId: 'riw-1',
            semanticMemoryIds: ['sem-1'],
            lessonIds: ['lesson-1'],
            crystalIds: ['crystal-1'],
            inputHash: 'reflect-input-1',
          }],
        }));
      } else if (request.url === '/agentmemory/full/reflect-insight-window') {
        const receipt = operationReceipt('reflect_insight', '3'.repeat(64));
        response.end(JSON.stringify({
          success: true,
          status: 'succeeded',
          insightIds: ['insight-1'],
          reflectRecoveryEvidence: {
            schema: 'reflect-insight-commit/v1',
            kind: 'committed',
            receiptKey: receipt.key,
            receiptVersion: 1,
            resultRef: `reflect-insight-recoveries:${receipt.key}`,
            effectHash: '4'.repeat(64),
          },
          operationReceipt: receipt,
        }));
      } else if (request.url === '/agentmemory/extraction-runs/record') {
        response.end(JSON.stringify({ success: true }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unexpected endpoint' }));
      }
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'contract',
        '--run-state-format', 'v2',
      ];
      const initialExitCode = await mainForTest(argv);
      const initialStatus = await fs.readFile(
        path.join(stateDir, 'contract.v2', 'status.json'),
        'utf8',
      );
      assert.equal(initialExitCode, 0, initialStatus);

      const runRoot = path.join(stateDir, 'contract.v2');
      const readRunFiles = async () => Object.fromEntries(await Promise.all(
        (await fs.readdir(runRoot)).sort().map(async (name) => [
          name,
          await fs.readFile(path.join(runRoot, name), 'utf8'),
        ]),
      ));
      const completedFiles = await readRunFiles();
      assert.equal(await mainForTest([...argv, '--resume']), 0);
      assert.deepEqual(await readRunFiles(), completedFiles);

      const completedJournals = Object.fromEntries(
        Object.entries(completedFiles).filter(([name]) => name.endsWith('.jsonl')),
      );
      await fs.rm(path.join(runRoot, 'status.json'));
      assert.equal(await mainForTest([...argv, '--resume']), 0);
      const repairedFiles = await readRunFiles();
      assert.deepEqual(
        Object.fromEntries(Object.entries(repairedFiles).filter(([name]) => name.endsWith('.jsonl'))),
        completedJournals,
      );
      assert.deepEqual(JSON.parse(repairedFiles['status.json']), {
        status: 'completed',
        current_stage: null,
        stage_count: 8,
        run_id: 'contract',
        control_seq: 9,
      });
    });
    const summary = requests.find((entry) => entry.url === '/agentmemory/summarize/resumable').payload;
    const lessons = requests.find((entry) => entry.url === '/agentmemory/lessons/extract').payload;
    assert.equal(typeof summary.attemptId, 'string');
    assert.equal(typeof summary.inputHash, 'string');
    assert.equal(typeof lessons.attemptId, 'string');
    assert.equal(typeof lessons.inputHash, 'string');
    assert.equal(summary.inputHash, stableHash({
      session_id: 's1',
      started_at: '2026-07-22T00:00:00.000Z',
    }));
    assert.equal(lessons.inputHash, summary.inputHash);
    const memoryPrepare = requests.find((entry) =>
      entry.url === '/agentmemory/full/memory-consolidate-window/prepare').payload;
    const memoryCommit = requests.find((entry) =>
      entry.url === '/agentmemory/full/memory-consolidate-window/commit').payload;
    const skillPrepare = requests.find((entry) =>
      entry.url === '/agentmemory/full/skill-extract/prepare').payload;
    const skillCommit = requests.find((entry) =>
      entry.url === '/agentmemory/full/skill-extract/commit').payload;
    assert.equal(memoryPrepare.inputHash, 'memory-input-1');
    assert.equal(memoryCommit.prepareInputHash, 'memory-verified-input-1');
    assert.equal(memoryCommit.inputHash, stableHash({
      prepareRunId: memoryCommit.prepareRunId,
      unitId: 'mcw-1',
      prepareInputHash: 'memory-verified-input-1',
      preparedHandle: 'memory-handle-1',
      proposalHash: 'memory-proposal-1',
    }));
    assert.equal(skillPrepare.operationReceiptManaged, true);
    assert.equal(skillCommit.prepareInputHash, 'skill-verified-input-1');
    assert.equal(skillCommit.inputHash, stableHash({
      prepareRunId: skillCommit.prepareRunId,
      unitId: 'skill-0001',
      prepareInputHash: 'skill-verified-input-1',
      preparedHandle: 'skill-handle-1',
      proposalHash: 'skill-proposal-1',
    }));
    const summaryPlan = (await fs.readFile(path.join(stateDir, 'contract.v2', 'summary.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse)
      .find((event) => event.type === 'unit_planned');
    assert.equal(typeof summaryPlan.payload.request_hash, 'string');
    for (const stage of [
      'memory_consolidate',
      'semantic_rollup',
      'skill_extract',
      'crystal',
      'consolidation_procedural',
      'reflect_insight',
    ]) {
      const events = (await fs.readFile(path.join(stateDir, 'contract.v2', `${stage}.jsonl`), 'utf8'))
        .trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).type, 'stage_completed');
    }
    const control = (await fs.readFile(path.join(stateDir, 'contract.v2', 'control.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(control.at(-1).type, 'run_completed');
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 resumes a partial summary plan without duplicating planned units', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-plan-'));
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [
        { id: 's1', startedAt: '2026-07-22T00:00:00.000Z' },
        { id: 's2', startedAt: '2026-07-22T00:01:00.000Z' },
      ] }));
    }, async (baseUrl) => {
      const argv = ['--base-url', baseUrl, '--state-dir', stateDir, '--run-id', 'partial-plan', '--run-state-format', 'v2'];
      let planned = 0;
      await assert.rejects(() => mainForEarlyStages(argv, {
        v2SummaryRemote: { advance: async () => assert.fail('must not dispatch before plan completes'), record: async () => {} },
        v2LessonsRemote: { start: async () => assert.fail('must not dispatch before plan completes'), record: async () => {} },
        onV2DurableEvent: async ({ type }) => {
          if (type === 'unit_planned' && ++planned === 2) throw new Error('plan_crash');
        },
      }), /plan_crash/);
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async (request) => successfulSummaryResponse(request, 'done'),
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async ({ sessionId }) => ({ ok: true, data: { runs: [{ id: `lesson-${sessionId}`, status: 'succeeded' }] } }),
          record: async () => {},
        },
      }), 0);
    });
    const lines = (await fs.readFile(path.join(stateDir, 'partial-plan.v2', 'summary.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.filter((event) => event.type === 'unit_planned').map((event) => event.payload.unit_id), ['s1', 's2']);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 rejects a run id with existing v1 state before any summary dispatch', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-collision-'));
  await fs.writeFile(path.join(stateDir, 'existing.json'), '{}');
  try {
    await assert.rejects(
      () => mainForEarlyStages(['--base-url', 'http://127.0.0.1:1', '--state-dir', stateDir, '--run-id', 'existing', '--run-state-format', 'v2'], {
        v2SummaryRemote: { advance: async () => assert.fail('must not dispatch'), record: async () => {} },
      }),
      /v2_v1_state_collision/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 detects the actual v1 journal path before remote inventory access', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-journal-collision-'));
  await fs.writeFile(path.join(stateDir, 'existing.journal.jsonl'), '{}\n');
  try {
    await assert.rejects(
      () => mainForEarlyStages(['--base-url', 'http://127.0.0.1:1', '--state-dir', stateDir, '--run-id', 'existing', '--run-state-format', 'v2'], {
        v2SummaryRemote: { advance: async () => assert.fail('must not dispatch'), record: async () => {} },
      }),
      /v2_v1_state_collision/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 release gate blocks a different unfinished v1 run before remote inventory access', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-release-gate-'));
  await fs.writeFile(path.join(stateDir, 'unfinished.status.json'), JSON.stringify({
    current_stage: 'lessons',
    coverage: { acceptance_ready: false },
    in_flight_gaps: { total: 0 },
  }));
  try {
    await assert.rejects(
      () => mainForEarlyStages([
        '--base-url', 'http://127.0.0.1:1',
        '--state-dir', stateDir,
        '--run-id', 'new-v2-run',
        '--run-state-format', 'v2',
      ], {
        v2SummaryRemote: { advance: async () => assert.fail('must not dispatch'), record: async () => {} },
      }),
      /v2_v1_release_gate_blocked:unfinished:v1_run_incomplete/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 dry-run persists plans without calling model or record adapters', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-dry-run-'));
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      assert.equal(await mainForEarlyStages([
        '--base-url', `${baseUrl}/`,
        '--state-dir', stateDir,
        '--run-id', 'dry-run',
        '--run-state-format', 'v2',
        '--dry-run',
      ], {
        v2SummaryRemote: {
          advance: async () => assert.fail('dry-run must not call summary'),
          record: async () => assert.fail('dry-run must not record summary'),
        },
        v2LessonsRemote: {
          start: async () => assert.fail('dry-run must not call lessons'),
          record: async () => assert.fail('dry-run must not record lessons'),
        },
      }), 0);
    });
    for (const stage of ['summary', 'lessons']) {
      const events = (await fs.readFile(path.join(stateDir, 'dry-run.v2', `${stage}.jsonl`), 'utf8'))
        .trim().split('\n').map(JSON.parse);
      assert.deepEqual(events.map((event) => event.type), ['unit_planned', 'stage_plan_completed']);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 resume freezes a completed summary plan and ignores appended live sessions', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-frozen-plan-addition-'));
  let sessions = [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }];
  const summaryCalls = [];
  const lessonCalls = [];
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'frozen-plan-addition',
        '--run-state-format', 'v2',
      ];
      assert.equal(await mainForEarlyStages([...argv, '--dry-run']), 0);

      sessions = [
        ...sessions,
        { id: 's2', startedAt: '2026-07-25T00:00:00.000Z' },
      ];
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async (request) => {
            summaryCalls.push(request.sessionId);
            return successfulSummaryResponse(request);
          },
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async ({ sessionId, attemptId }) => {
            lessonCalls.push(sessionId);
            return {
              ok: true,
              data: { runs: [{ id: `lesson-${attemptId}`, status: 'succeeded' }] },
            };
          },
          record: async () => {},
        },
      }), 0);
    });

    assert.deepEqual(summaryCalls, ['s1']);
    assert.deepEqual(lessonCalls, ['s1']);
    for (const stage of ['summary', 'lessons']) {
      const events = (await fs.readFile(
        path.join(stateDir, 'frozen-plan-addition.v2', `${stage}.jsonl`),
        'utf8',
      )).trim().split('\n').map(JSON.parse);
      assert.deepEqual(
        events.filter((event) => event.type === 'unit_planned')
          .map((event) => event.payload.unit_id),
        ['s1'],
      );
    }
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 frozen resume hard-stops when an original live session is missing or changed', async (context) => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  context.after(() => {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  });

  for (const scenario of [
    {
      name: 'missing',
      sessions: [{ id: 's2', startedAt: '2026-07-25T00:00:00.000Z' }],
      expected: /v2_frozen_plan_source_missing/,
    },
    {
      name: 'changed',
      sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:01.000Z' }],
      expected: /v2_frozen_plan_source_drifted/,
    },
  ]) {
    await context.test(scenario.name, async () => {
      const stateDir = await fs.mkdtemp(path.join(
        os.tmpdir(),
        `agentmemory-v2-frozen-plan-${scenario.name}-`,
      ));
      let sessions = [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }];
      await withServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ success: true, sessions }));
      }, async (baseUrl) => {
        const argv = [
          '--base-url', baseUrl,
          '--state-dir', stateDir,
          '--run-id', `frozen-plan-${scenario.name}`,
          '--run-state-format', 'v2',
        ];
        assert.equal(await mainForEarlyStages([...argv, '--dry-run']), 0);
        sessions = scenario.sessions;
        await assert.rejects(
          () => mainForEarlyStages([...argv, '--resume']),
          scenario.expected,
        );
      });
    });
  }
});

test('v2 binds normalized base URL into run identity drift checks', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-base-url-'));
  const args = ['--state-dir', stateDir, '--run-id', 'base-url', '--run-state-format', 'v2', '--dry-run'];
  const dependencies = {
    v2SummaryRemote: { advance: async () => assert.fail('dry-run'), record: async () => assert.fail('dry-run') },
    v2LessonsRemote: { start: async () => assert.fail('dry-run'), record: async () => assert.fail('dry-run') },
  };
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      assert.equal(await mainForEarlyStages([
        '--base-url', `${baseUrl}/`,
        ...args,
        '--mark', 'mark-a',
      ], dependencies), 0);
      await assert.rejects(
        () => mainForEarlyStages([
          '--base-url', `${baseUrl}/`,
          ...args,
          '--mark', 'mark-b',
          '--resume',
        ], dependencies),
        /v2_run_input_drifted/,
      );
    });
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      await assert.rejects(
        () => mainForEarlyStages(['--base-url', baseUrl, ...args, '--resume'], dependencies),
        /v2_run_input_drifted/,
      );
    });
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 lessons recovers every durable boundary with one stable remote operation', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-lessons-recovery-'));
  const operations = new Map();
  const calls = [];
  const records = [];
  let loseResponse = true;
  let crashTerminal = true;
  let loseRecord = true;
  const summaryRemote = {
    advance: async (request) => successfulSummaryResponse(request),
    record: async () => {},
  };
  const lessonsRemote = {
    start: async ({ attemptId, inputHash, requireExistingReceipt }) => {
      calls.push({ attemptId, inputHash, requireExistingReceipt });
      operations.set(attemptId, operations.get(attemptId) || { id: `lesson-${attemptId}`, inputHash });
      if (loseResponse) {
        loseResponse = false;
        throw new Error('lesson_response_lost');
      }
      const operation = operations.get(attemptId);
      return {
        ok: true,
        data: {
          runs: [{ id: operation.id, status: 'succeeded' }],
          lessonEvidence: {
            kind: 'committed',
            runId: operation.id,
            stagingId: 'staging-1',
            planId: 'plan-1',
            receiptKey: `lcr_${'1'.repeat(32)}`,
            receiptVersion: 1,
            resultRef: 'lesson-commit-plans:plan-1',
            effectHash: 'd'.repeat(64),
          },
        },
      };
    },
    record: async ({ runId, attemptId }) => {
      records.push({ runId, attemptId });
      if (loseRecord) {
        loseRecord = false;
        throw new Error('lesson_record_lost');
      }
    },
  };
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      const argv = ['--base-url', baseUrl, '--state-dir', stateDir, '--run-id', 'lessons-boundaries', '--run-state-format', 'v2'];
      await assert.rejects(() => mainForEarlyStages(argv, { v2SummaryRemote: summaryRemote, v2LessonsRemote: lessonsRemote }), /lesson_response_lost/);
      await assert.rejects(() => mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
        onV2DurableEvent: async ({ scope, type }) => {
          if (scope === 'lessons' && type === 'unit_resolution' && crashTerminal) {
            crashTerminal = false;
            throw new Error('crash_before_terminal_return');
          }
        },
      }), /crash_before_terminal_return/);
      await assert.rejects(() => mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), /lesson_record_lost/);
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 0);
    });
    assert.equal(operations.size, 1);
    assert.equal(new Set(calls.map((call) => call.attemptId)).size, 1);
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((call) => call.requireExistingReceipt),
      [false, true, true, true],
    );
    assert.equal(new Set(records.map((record) => record.attemptId)).size, 1);
    assert.equal(records.length, 2);
    const root = path.join(stateDir, 'lessons-boundaries.v2');
    const lessons = (await fs.readFile(path.join(root, 'lessons.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lessons.map((event) => event.type), [
      'unit_planned',
      'stage_plan_completed',
      'unit_started',
      'unit_operation_started',
      'unit_outcome_observed',
      'unit_operation_completed',
      'unit_effect_committed',
      'unit_resolution',
      'unit_recorded',
      'stage_completed',
    ]);
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control.some((event) => event.type === 'stage_sealed'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 lessons waits on reconciliation-required receipts without sealing', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-lessons-reconcile-'));
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      const code = await mainForEarlyStages(['--base-url', baseUrl, '--state-dir', stateDir, '--run-id', 'lessons-reconcile', '--run-state-format', 'v2'], {
        v2SummaryRemote: {
          advance: async (request) => successfulSummaryResponse(request),
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async (request) => ({
            ok: false,
            error: 'extraction_operation_reconciliation_required',
            data: {
              failure: { cause: 'extraction_operation_reconciliation_required' },
              operationReceipt: {
                key: `xop_${stableHash([
                  request.attemptId,
                  'lessons',
                  request.sessionId,
                ]).slice(0, 32)}`,
                version: 1,
                status: 'running',
                runId: request.attemptId,
                stage: 'lessons',
                unitId: request.sessionId,
                inputHash: '2'.repeat(64),
                runnerInputHash: request.inputHash,
                startedAt: '2026-07-30T00:00:00.000Z',
              },
            },
          }),
          record: async () => assert.fail('must not record a reconciled failure'),
        },
      });
      assert.equal(code, 75);
    });
    const root = path.join(stateDir, 'lessons-reconcile.v2');
    const lessons = (await fs.readFile(path.join(root, 'lessons.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lessons.at(-1).type, 'unit_reconciliation_requested');
    assert.equal(lessons.at(-1).payload.decision.action, 'reconcile');
    assert.equal(
      lessons.at(-1).payload.evidence.reasonCode,
      'legacy_lessons_effect_unknown',
    );
    assert.equal(
      lessons.at(-1).payload.receipt_key,
      `xop_${stableHash([
        lessons.at(-1).payload.attempt_id,
        'lessons',
        lessons.at(-1).payload.unit_id,
      ]).slice(0, 32)}`,
    );
    assert.equal(lessons.at(-1).payload.receipt_stage, 'lessons');
    assert.equal(lessons.at(-1).payload.receipt_input_hash, '2'.repeat(64));
    assert.equal(lessons.at(-1).payload.receipt_started_at, '2026-07-30T00:00:00.000Z');
    assert.equal(lessons.some((event) => event.type === 'unit_terminal'), false);
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control.some((event) => event.type === 'stage_sealed' && event.payload.stage === 'lessons'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 lessons retries the same identity after exact missing-receipt proof', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-lessons-absence-'));
  const requests = [];
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'lessons-absence',
        '--run-state-format', 'v2',
      ];
      await assert.rejects(() => mainForEarlyStages(argv, {
        v2SummaryRemote: {
          advance: async (request) => successfulSummaryResponse(request),
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async () => assert.fail('must not dispatch before operation journal durability'),
          record: async () => {},
        },
        onV2DurableEvent: async ({ scope, type }) => {
          if (scope === 'lessons' && type === 'unit_operation_started') {
            throw new Error('injected_crash');
          }
        },
      }), /injected_crash/);

      const code = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: {
          advance: async (request) => successfulSummaryResponse(request),
          record: async () => {},
        },
        v2LessonsRemote: {
          start: async (request) => {
            requests.push(request);
            return request.requireExistingReceipt
              ? missingOperationReceiptResponse({
                  attemptId: request.attemptId,
                  stage: 'lessons',
                  unitId: request.sessionId,
                  runnerInputHash: request.inputHash,
                })
              : committedLessonResponse('lesson-after-absence');
          },
          record: async () => {},
        },
      });

      assert.equal(code, 0);
    });
    assert.deepEqual(
      requests.map((request) => request.requireExistingReceipt),
      [true, false],
    );
    assert.equal(
      requests[1].expectedReceiptInputHash,
      stableHash({
        attemptId: requests[0].attemptId,
        stage: 'lessons',
        unitId: requests[0].sessionId,
        runnerInputHash: requests[0].inputHash,
      }),
    );
    const events = (await fs.readFile(
      path.join(stateDir, 'lessons-absence.v2', 'lessons.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'stage_completed');
    assert.equal(events.some((event) => event.type === 'run_blocked'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 lessons keeps safe transient failures pending but seals deterministic failures', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-lessons-failure-contract-'));
  const summaryRemote = {
    advance: async (request) => successfulSummaryResponse(request),
    record: async () => {},
  };
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      const pendingCode = await mainForEarlyStages([
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'lessons-transient',
        '--run-state-format', 'v2',
      ], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: {
          start: async () => ({
            ok: false,
            status_code: 503,
            data: {
              failure: {
                class: 'transient_provider',
                cause: 'timeout',
                phase: 'provider_call',
              },
            },
          }),
          record: async () => assert.fail('pending failure must not record'),
        },
      });
      assert.equal(pendingCode, 75);

      const terminalCode = await mainForEarlyStages([
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', 'lessons-terminal',
        '--run-state-format', 'v2',
      ], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: {
          start: async () => ({
            ok: true,
            data: { runs: [{ id: 'lesson-failed', status: 'failed' }] },
          }),
          record: async () => assert.fail('terminal failure must not record'),
        },
      });
      assert.equal(terminalCode, 1);
    });

    const pendingEvents = (await fs.readFile(
      path.join(stateDir, 'lessons-transient.v2', 'lessons.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(pendingEvents.some((event) => event.type === 'unit_terminal'), false);

    const terminalEvents = (await fs.readFile(
      path.join(stateDir, 'lessons-terminal.v2', 'lessons.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(terminalEvents.at(-1).type, 'unit_terminal');
    assert.equal(terminalEvents.at(-1).payload.status, 'failed');
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 lessons resume forwards append-only legacy retry authorization to the same receipt', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-lessons-authorized-resume-'));
  const runId = 'lessons-authorized-resume';
  const summaryRemote = {
    advance: async (request) => successfulSummaryResponse(request),
    record: async () => {},
  };
  let resumedRequest;
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', runId,
        '--run-state-format', 'v2',
      ];
      assert.equal(await mainForEarlyStages(argv, {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: {
          start: async () => ({
            ok: false,
            status_code: 400,
            data: {
              failure: {
                class: 'transient_provider',
                cause: 'lesson_extraction_failed',
              },
            },
          }),
          record: async () => assert.fail('failed request must not record'),
        },
      }), 1);

      const rootDir = path.join(stateDir, `${runId}.v2`);
      const journal = new RunStateJournalV2({ rootDir, runId });
      await journal.acquireLock();
      try {
        await journal.open();
        const events = await journal.readStage('lessons');
        const started = events.find((event) => event.type === 'unit_started');
        const terminal = events.at(-1);
        await journal.appendStage('lessons', 'unit_lessons_failed_terminal_retry_authorized', {
          stage: 'lessons',
          unit_id: started.payload.unit_id,
          attempt_id: started.payload.attempt_id,
          runner_input_hash: started.payload.input_hash,
          receipt_input_hash: 'c'.repeat(64),
          receipt_status: 'failed',
          receipt_failure_class: 'transient_provider',
          receipt_failure_cause: 'lesson_extraction_failed',
          failure_class: 'transient_provider',
          failure_cause: 'lesson_extraction_failed',
          failure_phase: 'provider_call',
          retry_epoch: 0,
          last_safe_failure: {
            error_class: 'transient_provider',
            cause: 'lesson_extraction_failed',
            phase: 'provider_call',
            timestamp: '2026-07-28T16:23:40.115Z',
          },
          lesson_run_evidence: {
            status: 'retryable',
            input_hash: 'd'.repeat(64),
            config_hash: 'e'.repeat(64),
            failure_cause: 'timeout',
            failure_phase: 'provider_call',
            failed_at: '2026-07-28T16:23:40.115Z',
            created_lesson_count: 0,
            replaced_lesson_count: 0,
            chunk_lesson_count: 0,
          },
          superseded_terminal_seq: terminal.seq,
          expected_journal_seq: terminal.seq,
        });
      } finally {
        await journal.releaseLock();
      }

      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: {
          start: async (request) => {
            resumedRequest = request;
            return {
              ok: true,
              data: { runs: [{ id: 'lesson-resumed', status: 'succeeded' }] },
            };
          },
          record: async () => {},
        },
      }), 0);
    });

    assert.equal(resumedRequest.requireExistingReceipt, true);
    assert.deepEqual(resumedRequest.failedReceiptRetryAuthorization, {
      receiptInputHash: 'c'.repeat(64),
      retryEpoch: 0,
      failureClass: 'transient_provider',
      failureCause: 'lesson_extraction_failed',
      failurePhase: 'provider_call',
      lastSafeFailure: {
        errorClass: 'transient_provider',
        cause: 'lesson_extraction_failed',
        phase: 'provider_call',
        timestamp: '2026-07-28T16:23:40.115Z',
      },
    });
    assert.deepEqual(resumedRequest.failedLessonRunEvidence, {
      status: 'retryable',
      inputHash: 'd'.repeat(64),
      configHash: 'e'.repeat(64),
      failureCause: 'timeout',
      failurePhase: 'provider_call',
      failedAt: '2026-07-28T16:23:40.115Z',
      createdLessonCount: 0,
      replacedLessonCount: 0,
      chunkLessonCount: 0,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 Lessons resumes every committed recovery boundary without repeating Provider work', async (context) => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  context.after(() => {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  });

  for (const crashType of [
    'unit_operation_completed',
    'unit_outcome_observed',
    'unit_effect_committed',
    'unit_resolution',
  ]) {
    await context.test(`crash after ${crashType}`, async () => {
      const stateDir = await fs.mkdtemp(path.join(
        os.tmpdir(),
        `agentmemory-v2-lessons-${crashType}-`,
      ));
      const runId = `lessons-${crashType}`;
      let lessonCalls = 0;
      let providerCalls = 0;
      let recordCalls = 0;
      let crashPending = true;
      try {
        await withServer((_request, response) => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            success: true,
            sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }],
          }));
        }, async (baseUrl) => {
          const argv = [
            '--base-url', baseUrl,
            '--state-dir', stateDir,
            '--run-id', runId,
            '--run-state-format', 'v2',
          ];
          const lessonsRemote = {
            start: async ({ requireExistingReceipt }) => {
              lessonCalls += 1;
              if (!requireExistingReceipt) providerCalls += 1;
              return committedLessonResponse('lesson-run-1');
            },
            record: async () => {
              recordCalls += 1;
            },
          };
          await assert.rejects(() => mainForEarlyStages(argv, {
            v2SummaryRemote: {
              advance: async (request) => successfulSummaryResponse(request),
              record: async () => {},
            },
            v2LessonsRemote: lessonsRemote,
            onV2DurableEvent: async ({ scope, type }) => {
              if (scope === 'lessons' && crashPending && type === crashType) {
                crashPending = false;
                throw new Error(`crash_after_${crashType}`);
              }
            },
          }), new RegExp(`crash_after_${crashType}`));

          assert.equal(await mainForEarlyStages([...argv, '--resume'], {
            v2SummaryRemote: {
              advance: async (request) => successfulSummaryResponse(request),
              record: async () => {},
            },
            v2LessonsRemote: lessonsRemote,
          }), 0);
        });

        const events = (await fs.readFile(
          path.join(stateDir, `${runId}.v2`, 'lessons.jsonl'),
          'utf8',
        )).trim().split('\n').map(JSON.parse);
        for (const type of [
          'unit_operation_completed',
          'unit_outcome_observed',
          'unit_effect_committed',
          'unit_resolution',
        ]) {
          assert.equal(events.filter((event) => event.type === type).length, 1);
        }
        assert.equal(
          events.some((event) => event.type.startsWith('unit_lessons_')),
          false,
        );
        assert.equal(lessonCalls, 2);
        assert.equal(providerCalls, 1);
        assert.equal(recordCalls, 1);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('v2 Lessons persists staged recovery and resumes the same commit operation', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-lessons-staged-'));
  const runId = 'lessons-staged-resume';
  const receiptModes = [];
  let calls = 0;
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }],
      }));
    }, async (baseUrl) => {
      const argv = [
        '--base-url', baseUrl,
        '--state-dir', stateDir,
        '--run-id', runId,
        '--run-state-format', 'v2',
      ];
      const lessonsRemote = {
        start: async ({ requireExistingReceipt }) => {
          receiptModes.push(requireExistingReceipt);
          calls += 1;
          if (calls === 1) {
            return {
              ok: true,
              data: {
                runs: [{ id: 'lesson-run-1', status: 'succeeded' }],
                lessonEvidence: [{
                  kind: 'staged',
                  resultRef: 'lesson-candidate-staging:staging-1',
                  effectHash: 'a'.repeat(64),
                }],
              },
            };
          }
          return committedLessonResponse('lesson-run-1');
        },
        record: async () => {},
      };
      const summaryRemote = {
        advance: async (request) => successfulSummaryResponse(request),
        record: async () => {},
      };

      assert.equal(await mainForEarlyStages(argv, {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 75);
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 0);
    });

    const events = (await fs.readFile(
      path.join(stateDir, `${runId}.v2`, 'lessons.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    const resumed = events.filter((event) => event.type === 'unit_commit_resumed');
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].payload.decision.action, 'resume_commit');
    assert.deepEqual(receiptModes, [false, true]);
    assert.equal(events.filter((event) => event.type === 'unit_resolution').length, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('v2 summary waits on a persisted reconciliation failure without redispatching', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-reconcile-'));
  try {
    await withServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, sessions: [{ id: 's1', startedAt: '2026-07-24T00:00:00.000Z' }] }));
    }, async (baseUrl) => {
      const argv = ['--base-url', baseUrl, '--state-dir', stateDir, '--run-id', 'summary-reconcile', '--run-state-format', 'v2'];
      const code = await mainForEarlyStages(argv, {
        v2SummaryRemote: {
          advance: async ({ attemptId, inputHash, operationUnitId }) => ({
            ok: false,
            error: 'extraction_operation_reconciliation_required',
            data: {
              status: 'failed',
              failure: { cause: 'extraction_operation_reconciliation_required' },
              operationReceipt: runningSummaryOperationReceipt({
                attemptId,
                runnerInputHash: inputHash,
                operationUnitId,
              }),
            },
          }),
          record: async () => assert.fail('must not record a reconciled summary failure'),
        },
        v2LessonsRemote: { start: async () => assert.fail('lessons must not start'), record: async () => {} },
      });
      assert.equal(code, 75);
      const resumed = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: { advance: async () => assert.fail('persisted failed summary must not redispatch'), record: async () => {} },
        v2LessonsRemote: { start: async () => assert.fail('lessons must not start'), record: async () => {} },
      });
      assert.equal(resumed, 75);
    });
    const root = path.join(stateDir, 'summary-reconcile.v2');
    const summary = (await fs.readFile(path.join(root, 'summary.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(summary.at(-1).type, 'unit_reconciliation_requested');
    assert.equal(summary.at(-1).payload.decision.action, 'reconcile');
    assert.equal(summary.some((event) => event.type === 'unit_terminal'), false);
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control.some((event) => event.type === 'stage_sealed' && event.payload.stage === 'summary'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});
