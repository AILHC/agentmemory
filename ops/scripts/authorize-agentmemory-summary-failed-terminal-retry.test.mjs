import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorizeSummaryFailedTerminalRetry,
  parseArguments,
} from './authorize-agentmemory-summary-failed-terminal-retry.mjs';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';

const formalRunId = 'formal-summary-retry';
const attemptId = 'a'.repeat(64);
const runnerInputHash = 'b'.repeat(64);
const receiptInputHash = 'c'.repeat(64);
const timestamp = '2026-07-28T00:00:00.000Z';

function options(stateDir, overrides = {}) {
  return {
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir,
    formalRunId,
    expectedJournalSeq: 5,
    unitId: 'session-1',
    attemptId,
    operationId: 'session-1:reduce',
    runnerInputHash,
    receiptInputHash,
    expectedFailureClass: 'transient_provider',
    expectedFailureCause: 'pi_stream_failed',
    expectedFailurePhase: 'provider_call',
    expectedRetryEpoch: 0,
    expectedLastSafeFailure: {
      errorClass: 'transient_provider',
      cause: 'pi_stream_failed',
      phase: 'provider_call',
      timestamp,
    },
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    success: true,
    operation: {
      runId: attemptId,
      stage: 'summary',
      unitId: 'session-1:reduce',
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
          timestamp,
        },
      },
      ...overrides,
    },
  };
}

async function makeFailedRun(name) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const rootDir = path.join(stateDir, `${formalRunId}.v2`);
  const journal = new RunStateJournalV2({ rootDir, runId: formalRunId });
  await journal.acquireLock();
  try {
    await journal.open();
    await journal.appendControl('run_started', {
      run_id: formalRunId,
      format: 'run-state-journal-v2',
      schema_version: 2,
    });
    await journal.appendStage('summary', 'unit_planned', {
      unit_id: 'session-1',
      input_hash: runnerInputHash,
    });
    await journal.appendStage('summary', 'stage_plan_completed', { unit_count: 1 });
    await journal.appendStage('summary', 'unit_started', {
      unit_id: 'session-1',
      input_hash: runnerInputHash,
      attempt_id: attemptId,
    });
    await journal.appendStage('summary', 'unit_operation_started', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      operation_id: 'session-1:reduce',
    });
    await journal.appendStage('summary', 'unit_operation_completed', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      operation_id: 'session-1:reduce',
      status: 'failed',
      error: 'pi_stream_failed',
      terminal_result: {
        status: 'failed',
        payload: { error: 'pi_stream_failed' },
      },
    });
    await journal.appendStage('summary', 'unit_terminal', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      status: 'failed',
      error: 'pi_stream_failed',
    });
  } finally {
    await journal.releaseLock();
  }
  return { stateDir, rootDir };
}

test('summary failed-terminal retry authorization is append-only and idempotent', async (context) => {
  const run = await makeFailedRun('agentmemory-authorize-summary-retry');
  context.after(() => fs.rm(run.stateDir, { recursive: true, force: true }));
  const lookups = [];
  const dependencies = {
    lookupReceipt: async (operation) => {
      lookups.push(operation);
      return receipt();
    },
  };

  const first = await authorizeSummaryFailedTerminalRetry(options(run.stateDir), dependencies);
  const progressJournal = new RunStateJournalV2({ rootDir: run.rootDir, runId: formalRunId });
  await progressJournal.acquireLock();
  try {
    await progressJournal.open();
    await progressJournal.readStage('summary');
    await progressJournal.appendStage('summary', 'unit_operation_started', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      operation_id: 'session-1:reduce',
    });
    await progressJournal.appendStage('summary', 'unit_operation_completed', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      operation_id: 'session-1:reduce',
      status: 'succeeded',
      terminal_result: { status: 'succeeded' },
    });
    await progressJournal.appendStage('summary', 'unit_terminal', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      status: 'succeeded',
    });
    await progressJournal.appendStage('summary', 'unit_recorded', {
      unit_id: 'session-1',
      attempt_id: attemptId,
    });
    await progressJournal.appendStage('summary', 'stage_completed', {
      unit_count: 1,
      accepted_count: 1,
    });
    await progressJournal.appendControl('run_completed', {
      run_id: formalRunId,
      stage_count: 8,
    });
  } finally {
    await progressJournal.releaseLock();
  }
  const replay = await authorizeSummaryFailedTerminalRetry(options(run.stateDir), dependencies);
  const journal = new RunStateJournalV2({ rootDir: run.rootDir, runId: formalRunId });
  const events = await journal.readStage('summary');

  assert.equal(first.success, true);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(
    events.filter((event) => event.type === 'unit_summary_failed_terminal_retry_authorized').length,
    1,
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'unit_terminal')
      .map((event) => event.payload.status),
    ['failed', 'succeeded'],
  );
  assert.equal(events.filter((event) => event.type === 'unit_operation_completed').length, 2);
  assert.deepEqual(lookups[0], {
    runId: attemptId,
    stage: 'summary',
    unitId: 'session-1:reduce',
    inputHash: receiptInputHash,
  });
});

test('summary retry authorization fails closed on receipt safety or journal CAS drift without append', async (context) => {
  const unsafeCases = [
    ['provider preflight', receipt({
      failure: {
        class: 'transient_provider',
        cause: 'pi_stream_failed',
        phase: 'provider_preflight',
      },
      retry: {
        epoch: 0,
        lastSafeFailure: {
          errorClass: 'transient_provider',
          cause: 'pi_stream_failed',
          phase: 'provider_preflight',
          timestamp,
        },
      },
    })],
    ['final persistence', receipt({
      failure: {
        class: 'transient_runtime',
        cause: 'persistence_failed',
        phase: 'final_result_persistence',
      },
      retry: {
        epoch: 0,
        lastSafeFailure: {
          errorClass: 'transient_runtime',
          cause: 'persistence_failed',
          phase: 'final_result_persistence',
          timestamp,
        },
      },
    })],
    ['unknown phase', receipt({
      failure: {
        class: 'transient_provider',
        cause: 'pi_stream_failed',
        phase: 'future_phase',
      },
    })],
    ['hash drift', {
      ...receipt(),
      operation: {
        ...receipt().operation,
        inputHash: 'd'.repeat(64),
      },
    }],
  ];

  for (const [name, unsafeReceipt] of unsafeCases) {
    const run = await makeFailedRun(`agentmemory-authorize-summary-retry-${name.replaceAll(' ', '-')}`);
    context.after(() => fs.rm(run.stateDir, { recursive: true, force: true }));
    await assert.rejects(
      () => authorizeSummaryFailedTerminalRetry(options(run.stateDir), {
        lookupReceipt: async () => unsafeReceipt,
      }),
      /summary_retry_authorization_/,
      name,
    );
    const journal = new RunStateJournalV2({ rootDir: run.rootDir, runId: formalRunId });
    assert.equal(
      (await journal.readStage('summary'))
        .some((event) => event.type === 'unit_summary_failed_terminal_retry_authorized'),
      false,
      name,
    );
  }

  const drifted = await makeFailedRun('agentmemory-authorize-summary-retry-seq-drift');
  context.after(() => fs.rm(drifted.stateDir, { recursive: true, force: true }));
  await assert.rejects(
    () => authorizeSummaryFailedTerminalRetry(options(drifted.stateDir, {
      expectedJournalSeq: 4,
    }), {
      lookupReceipt: async () => receipt(),
    }),
    /summary_retry_authorization_journal_drifted/,
  );
  const driftJournal = new RunStateJournalV2({ rootDir: drifted.rootDir, runId: formalRunId });
  assert.equal(
    (await driftJournal.readStage('summary'))
      .some((event) => event.type === 'unit_summary_failed_terminal_retry_authorized'),
    false,
  );
});

test('summary retry authorization CLI requires all expected safety evidence', () => {
  assert.throws(() => parseArguments([
    '--state-dir', 'F:\\state',
    '--run-id', formalRunId,
    '--expected-journal-seq', '5',
    '--unit-id', 'session-1',
    '--attempt-id', attemptId,
    '--operation-id', 'session-1:reduce',
    '--runner-input-hash', runnerInputHash,
    '--receipt-input-hash', receiptInputHash,
    '--expected-failure-class', 'transient_provider',
    '--expected-failure-cause', 'pi_stream_failed',
    '--expected-failure-phase', 'provider_call',
    '--expected-retry-epoch', '0',
    '--expected-last-safe-error-class', 'transient_provider',
    '--expected-last-safe-cause', 'pi_stream_failed',
    '--expected-last-safe-phase', 'provider_call',
  ]), /expected_last_safe_timestamp_required/);
});
