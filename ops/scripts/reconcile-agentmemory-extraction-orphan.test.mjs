import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseArguments,
  reconcileSummaryOrphan,
} from './reconcile-agentmemory-extraction-orphan.mjs';
import {
  foldStageEvents,
  RunStateJournalV2,
} from './lib/run-state-journal-v2.mjs';

const identity = {
  runId: 'a'.repeat(64),
  stage: 'summary',
  unitId: 'session-1:reduce',
  inputHash: 'b'.repeat(64),
};
const resultBinding = {
  sessionId: 'session-1',
  resumableRunId: `sumr_${'c'.repeat(24)}`,
  serviceInputHash: 'd'.repeat(64),
  runnerInputHash: 'e'.repeat(64),
  generationConfigHash: 'f'.repeat(64),
};

async function makeBlockedJournal() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-orphan-reconcile-'));
  const formalRunId = 'formal-run-1';
  const rootDir = path.join(stateDir, `${formalRunId}.v2`);
  const journal = new RunStateJournalV2({ rootDir, runId: formalRunId });
  await journal.acquireLock();
  await journal.open();
  await journal.appendStage('summary', 'unit_planned', {
    unit_id: 'session-1',
    input_hash: resultBinding.runnerInputHash,
  });
  await journal.appendStage('summary', 'stage_plan_completed', { unit_count: 1 });
  await journal.appendStage('summary', 'unit_started', {
    unit_id: 'session-1',
    input_hash: resultBinding.runnerInputHash,
    attempt_id: identity.runId,
  });
  await journal.appendStage('summary', 'unit_operation_started', {
    unit_id: 'session-1',
    attempt_id: identity.runId,
    operation_id: identity.unitId,
  });
  await journal.appendStage('summary', 'unit_blocked', {
    unit_id: 'session-1',
    attempt_id: identity.runId,
    reason: 'extraction_operation_reconciliation_required',
    error: 'extraction_operation_reconciliation_required',
  });
  await journal.releaseLock();
  return { stateDir, formalRunId, rootDir };
}

function options(fixture) {
  return {
    stateDir: fixture.stateDir,
    formalRunId: fixture.formalRunId,
    expectedJournalSeq: 4,
    operation: {
      ...identity,
      expectedStatus: 'running',
      expectedStartedAt: '2026-07-26T17:44:07.622Z',
    },
    result: resultBinding,
  };
}

test('single orphan reconciliation appends an audited event and clears the exact block', async () => {
  const fixture = await makeBlockedJournal();
  const calls = [];
  const report = await reconcileSummaryOrphan(options(fixture), {
    reconcileReceipt: async (payload) => {
      calls.push(payload);
      return {
        success: true,
        replayed: false,
        operation: identity,
        receipt: {
          status: 'reconciled',
          startedAt: '2026-07-26T17:44:07.622Z',
          completedAt: '2026-07-27T02:00:00.000Z',
          failure: {
            class: 'transient_runtime',
            cause: 'orphaned_operation_result_absent',
          },
        },
        reconciliation: {
          id: 'xrec_0123456789abcdef0123456789abcdef',
          at: '2026-07-27T02:00:00.000Z',
          resultStatus: 'absent',
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    operation: options(fixture).operation,
    result: resultBinding,
  });
  assert.deepEqual(report, {
    success: true,
    replayed: false,
    runId: fixture.formalRunId,
    stage: 'summary',
    unitId: 'session-1',
    operationId: identity.unitId,
    attemptId: identity.runId,
    reconciliationId: 'xrec_0123456789abcdef0123456789abcdef',
    receiptInputHash: identity.inputHash,
    receiptStartedAt: '2026-07-26T17:44:07.622Z',
    receiptStatus: 'reconciled',
    resultStatus: 'absent',
    journalSeq: 5,
    reconciledAt: '2026-07-27T02:00:00.000Z',
  });

  const journal = new RunStateJournalV2({
    rootDir: fixture.rootDir,
    runId: fixture.formalRunId,
  });
  const events = await journal.readStage('summary');
  const state = foldStageEvents(events);
  assert.equal(events.at(-1).type, 'unit_reconciliation_resolved');
  assert.equal(state.units.get('session-1').blocked, false);
  assert.equal(state.units.get('session-1').active_operation, null);
});

test('stale journal CAS evidence stops before changing the receipt', async () => {
  const fixture = await makeBlockedJournal();
  let called = false;
  await assert.rejects(
    () => reconcileSummaryOrphan({
      ...options(fixture),
      expectedJournalSeq: 3,
    }, {
      reconcileReceipt: async () => {
        called = true;
        throw new Error('must_not_call');
      },
    }),
    /orphan_reconciliation_journal_drifted/,
  );
  assert.equal(called, false);
});

test('safe receipt rejection preserves the exact failure cause without appending a journal event', async () => {
  const fixture = await makeBlockedJournal();
  await assert.rejects(
    () => reconcileSummaryOrphan(options(fixture), {
      reconcileReceipt: async () => ({
        success: false,
        failure: {
          class: 'hard',
          cause: 'orphan_reconciliation_result_binding_drifted',
        },
      }),
    }),
    /orphan_reconciliation_rejected:orphan_reconciliation_result_binding_drifted/,
  );

  const journal = new RunStateJournalV2({
    rootDir: fixture.rootDir,
    runId: fixture.formalRunId,
  });
  const events = await journal.readStage('summary');
  assert.equal(events.at(-1).type, 'unit_blocked');
  assert.equal(events.at(-1).seq, 4);
});

test('CLI requires one complete explicit identity and has no bulk reset mode', () => {
  assert.throws(() => parseArguments(['--all']), /unknown_argument:--all/);
  assert.throws(() => parseArguments([]), /state_dir_required/);
});
