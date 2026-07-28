import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorizeSummaryFailedTerminalRetry } from './authorize-agentmemory-summary-failed-terminal-retry.mjs';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';
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
  return {
    ok: true,
    data: {
      status: 'succeeded',
      attemptId,
      runnerInputHash: inputHash,
      serviceInputHash: stableHash({ attemptId, inputHash, source: 'summary-service' }),
      resumableRunId: stableHash({ attemptId, inputHash, source: 'resumable-run' }),
      summary: { title },
    },
  };
}

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
  const summaryRemote = {
    advance: async ({ operationUnitId }) => {
      if (operationUnitId === 's1:map:0') {
        return {
          ok: true,
          data: {
            status: 'in_progress',
            advanced: 'completed',
            completedChunks: 1,
            totalChunks: 1,
            operationUnitId,
          },
        };
      }
      return {
        ok: false,
        status_code: 500,
        data: {
          status: 'failed',
          operationUnitId,
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
          },
        },
      };
    },
    record: async () => {},
  };

  assert.equal(await mainForEarlyStages(argv, {
    v2SummaryRemote: summaryRemote,
    v2LessonsRemote: lessonsRemote,
  }), 1);
  const rootDir = path.join(stateDir, `${runId}.v2`);
  const journal = new RunStateJournalV2({ rootDir, runId });
  const failedEvents = await journal.readStage('summary');
  const planned = failedEvents.find((event) => event.type === 'unit_planned');
  const started = failedEvents.find((event) => event.type === 'unit_started');
  const failedTerminal = failedEvents.at(-1);
  const receiptInputHash = 'c'.repeat(64);
  const lastSafeTimestamp = '2026-07-28T00:00:00.000Z';
  assert.equal(failedTerminal.type, 'unit_terminal');

  await authorizeSummaryFailedTerminalRetry({
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir,
    formalRunId: runId,
    expectedJournalSeq: failedTerminal.seq,
    unitId: 's1',
    attemptId: started.payload.attempt_id,
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
        runId: started.payload.attempt_id,
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
    attemptId: started.payload.attempt_id,
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
      assert.equal(stage.at(-1).type, 'unit_blocked');
      assert.equal(stage.at(-1).payload.reason, 'summary_source_unproven');
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

test('v2 summary recovery hard-stops when no durable result is visible', async () => {
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
    assert.equal(events.at(-1).type, 'unit_blocked');
    assert.equal(events.at(-1).payload.reason, 'extraction_operation_reconciliation_required');
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
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
      'unit_terminal',
      'unit_recorded',
      'stage_completed',
    ]);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary retains an active reduce operation for a retryable structured failure', async () => {
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
      assert.deepEqual(status.summary.failure, {
        class: 'transient_provider',
        cause: 'network_error',
        phase: 'provider_call',
      });
      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 0);
    });
    assert.deepEqual(receiptModes, [false, false, false, true]);
    const events = (await fs.readFile(
      path.join(stateDir, 'summary-retryable-reduce.v2', 'summary.jsonl'),
      'utf8',
    )).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((event) => event.type === 'unit_terminal').length, 1);
    assert.equal(events.some((event) => event.type === 'unit_blocked'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary resumes an authorized legacy failed reduce only through the existing receipt', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-authorized-retry-'));
  const runId = 'summary-authorized-retry';
  const receiptInputHash = 'c'.repeat(64);
  const receiptModes = [];
  let legacyFailure = true;
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
        if (payload.operationUnitId === 's1:map:0') {
          response.end(JSON.stringify({
            success: true,
            status: 'in_progress',
            advanced: 'completed',
            completedChunks: 1,
            totalChunks: 1,
            operationUnitId: payload.operationUnitId,
          }));
          return;
        }
        if (legacyFailure) {
          legacyFailure = false;
          response.statusCode = 500;
          response.end(JSON.stringify({
            success: false,
            status: 'failed',
            operationUnitId: payload.operationUnitId,
            failure: {
              class: 'transient_provider',
              cause: 'pi_stream_failed',
            },
          }));
          return;
        }
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

      assert.equal(await mainForEarlyStages(argv, {
        v2LessonsRemote: lessonsRemote,
      }), 1);

      const rootDir = path.join(stateDir, `${runId}.v2`);
      const journal = new RunStateJournalV2({ rootDir, runId });
      const failedEvents = await journal.readStage('summary');
      const planned = failedEvents.find((event) => event.type === 'unit_planned');
      const started = failedEvents.find((event) => event.type === 'unit_started');
      const failedTerminal = failedEvents.at(-1);
      assert.equal(failedTerminal.type, 'unit_terminal');
      assert.equal(failedTerminal.payload.status, 'failed');

      const authorization = await authorizeSummaryFailedTerminalRetry({
        engineUrl: 'ws://127.0.0.1:49134',
        stateDir,
        formalRunId: runId,
        expectedJournalSeq: failedTerminal.seq,
        unitId: 's1',
        attemptId: started.payload.attempt_id,
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
          timestamp: '2026-07-28T00:00:00.000Z',
        },
      }, {
        lookupReceipt: async () => ({
          success: true,
          operation: {
            runId: started.payload.attempt_id,
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
                timestamp: '2026-07-28T00:00:00.000Z',
              },
            },
          },
        }),
      });
      assert.equal(authorization.replayed, false);

      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2LessonsRemote: lessonsRemote,
      }), 0);
    });

    assert.deepEqual(receiptModes, [
      {
        operationUnitId: 's1:map:0',
        requireExistingReceipt: false,
        failedReceiptRetryAuthorization: undefined,
      },
      {
        operationUnitId: 's1:reduce',
        requireExistingReceipt: false,
        failedReceiptRetryAuthorization: undefined,
      },
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
      ['failed', 'succeeded'],
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
      expectedCodes: [75, 1],
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

test('v2 summary recovers a completed final inner operation without another remote call', async () => {
  const previousSecret = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-summary-terminal-'));
  let summaryCalls = 0;
  let crashAfterOperation = true;
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
        '--run-id', 'summary-terminal',
        '--run-state-format', 'v2',
      ];
      const summaryRemote = {
        advance: async ({ attemptId, inputHash, operationUnitId }) => {
          summaryCalls += 1;
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
          if (crashAfterOperation && type === 'unit_operation_completed') {
            crashAfterOperation = false;
            throw new Error('crash_after_final_operation');
          }
        },
      }), /crash_after_final_operation/);

      assert.equal(await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: summaryRemote,
        v2LessonsRemote: lessonsRemote,
      }), 0);
    });
    assert.equal(summaryCalls, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
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
        response.end(JSON.stringify({ success: true, status: 'succeeded', memoryIds: ['mem-1'] }));
      } else if (request.url === '/agentmemory/semantic-rollup') {
        response.end(JSON.stringify({ success: true, status: 'succeeded', semanticMemoryIds: ['sem-1'] }));
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
        response.end(JSON.stringify({
          success: true,
          groups: [{ groupId: 'cg-1', status: 'succeeded', crystalIds: ['crystal-1'] }],
        }));
      } else if (request.url === '/agentmemory/full/consolidation-procedural-windows/plan') {
        response.end(JSON.stringify({
          success: true,
          windows: [{ windowId: 'cpw-1', memoryIds: ['pattern-1'], inputHash: 'proc-input-1' }],
        }));
      } else if (request.url === '/agentmemory/full/consolidation-procedural-window') {
        response.end(JSON.stringify({
          success: true,
          status: 'succeeded',
          proceduralMemoryIds: ['proc-1'],
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
        response.end(JSON.stringify({ success: true, status: 'succeeded', insightIds: ['insight-1'] }));
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
      assert.equal(await mainForTest(argv), 0);

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
      return { ok: true, data: { runs: [{ id: operation.id, status: 'succeeded' }] } };
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
          if (scope === 'lessons' && type === 'unit_terminal' && crashTerminal) {
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
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.requireExistingReceipt), [false, true]);
    assert.equal(new Set(records.map((record) => record.attemptId)).size, 1);
    assert.equal(records.length, 2);
    const root = path.join(stateDir, 'lessons-boundaries.v2');
    const lessons = (await fs.readFile(path.join(root, 'lessons.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lessons.map((event) => event.type), [
      'unit_planned', 'stage_plan_completed', 'unit_started', 'unit_terminal', 'unit_recorded', 'stage_completed',
    ]);
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control.some((event) => event.type === 'stage_sealed'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 lessons hard-stops reconciliation-required receipts without sealing', async () => {
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
          start: async () => ({
            ok: false,
            error: 'extraction_operation_reconciliation_required',
            data: { failure: { cause: 'extraction_operation_reconciliation_required' } },
          }),
          record: async () => assert.fail('must not record a reconciled failure'),
        },
      });
      assert.equal(code, 1);
    });
    const root = path.join(stateDir, 'lessons-reconcile.v2');
    const lessons = (await fs.readFile(path.join(root, 'lessons.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lessons.at(-1).type, 'unit_blocked');
    assert.equal(lessons.at(-1).payload.reason, 'extraction_operation_reconciliation_required');
    assert.equal(lessons.some((event) => event.type === 'unit_terminal'), false);
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control.some((event) => event.type === 'stage_sealed' && event.payload.stage === 'lessons'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});

test('v2 summary hard-stops a persisted reconciliation failure without redispatching', async () => {
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
          advance: async () => ({
            ok: false,
            error: 'extraction_operation_reconciliation_required',
            data: { status: 'failed', failure: { cause: 'extraction_operation_reconciliation_required' } },
          }),
          record: async () => assert.fail('must not record a reconciled summary failure'),
        },
        v2LessonsRemote: { start: async () => assert.fail('lessons must not start'), record: async () => {} },
      });
      assert.equal(code, 1);
      const resumed = await mainForEarlyStages([...argv, '--resume'], {
        v2SummaryRemote: { advance: async () => assert.fail('persisted failed summary must not redispatch'), record: async () => {} },
        v2LessonsRemote: { start: async () => assert.fail('lessons must not start'), record: async () => {} },
      });
      assert.equal(resumed, 1);
    });
    const root = path.join(stateDir, 'summary-reconcile.v2');
    const summary = (await fs.readFile(path.join(root, 'summary.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(summary.at(-1).type, 'unit_blocked');
    assert.equal(summary.at(-1).payload.reason, 'extraction_operation_reconciliation_required');
    assert.equal(summary.some((event) => event.type === 'unit_terminal'), false);
    const control = (await fs.readFile(path.join(root, 'control.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(control.some((event) => event.type === 'stage_sealed' && event.payload.stage === 'summary'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previousSecret;
  }
});
