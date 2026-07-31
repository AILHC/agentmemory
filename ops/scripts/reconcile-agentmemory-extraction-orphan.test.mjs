import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseArguments,
  reconcileExtractionOrphan,
  reconcileSummaryOrphan,
} from './reconcile-agentmemory-extraction-orphan.mjs';
import {
  foldStageEvents,
  RunStateJournalV2,
} from './lib/run-state-journal-v2.mjs';
import { resolveOperationRecovery } from './lib/recovery-policy-v1.mjs';

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
    result: {
      kind: 'summary_resumable_run',
      phase: 'execute',
      ...resultBinding,
    },
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

test('generic resolver binds the exact request and receipt before clearing it', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-generic-reconcile-'));
  const formalRunId = 'formal-generic-1';
  const rootDir = path.join(stateDir, `${formalRunId}.v2`);
  const journal = new RunStateJournalV2({ rootDir, runId: formalRunId });
  const attemptId = '1'.repeat(64);
  const runnerInputHash = '2'.repeat(64);
  const receiptInputHash = '3'.repeat(64);
  const receiptKey = `xop_${'4'.repeat(32)}`;
  const startedAt = '2026-07-30T00:00:00.000Z';
  const recovery = resolveOperationRecovery({
    candidateEvidence: {
      kind: 'unknown',
      receiptKey,
      reasonCode: 'response_lost',
    },
    budget: { attemptsUsed: 0, maxAttempts: 0 },
  });
  const action = {
    unit_id: 'semantic-unit',
    attempt_id: attemptId,
    operation_id: 'semantic-unit',
    phase: 'execute',
    policy_version: recovery.policyVersion,
    policy_hash: recovery.policyHash,
    evidence: recovery.evidence,
    decision: recovery.decision,
    budget: recovery.budget,
    normalization: recovery.normalization,
    receipt_key: receiptKey,
    receipt_run_id: attemptId,
    receipt_stage: 'semantic_rollup',
    receipt_unit_id: 'semantic-unit',
    receipt_input_hash: receiptInputHash,
    receipt_started_at: startedAt,
  };
  await journal.acquireLock();
  await journal.open();
  await journal.appendStage('semantic_rollup', 'unit_planned', {
    unit_id: 'semantic-unit',
    input_hash: runnerInputHash,
  });
  await journal.appendStage('semantic_rollup', 'stage_plan_completed', { unit_count: 1 });
  await journal.appendStage('semantic_rollup', 'unit_started', {
    unit_id: 'semantic-unit',
    attempt_id: attemptId,
  });
  await journal.appendStage('semantic_rollup', 'unit_operation_started', {
    unit_id: 'semantic-unit',
    attempt_id: attemptId,
    operation_id: 'semantic-unit',
  });
  await journal.appendStage('semantic_rollup', 'unit_outcome_observed', action);
  const request = await journal.appendStage(
    'semantic_rollup',
    'unit_reconciliation_requested',
    action,
  );
  await journal.releaseLock();

  const genericOptions = {
    stateDir,
    formalRunId,
    expectedJournalSeq: request.seq,
    journalUnitId: 'semantic-unit',
    operationId: 'semantic-unit',
    phase: 'execute',
    reconciliationRequestSeq: request.seq,
    receiptKey,
    operation: {
      runId: attemptId,
      stage: 'semantic_rollup',
      unitId: 'semantic-unit',
      inputHash: receiptInputHash,
      expectedStatus: 'running',
      expectedStartedAt: startedAt,
    },
    result: {
      kind: 'protocol_state',
      phase: 'execute',
      runnerInputHash,
    },
  };
  let calls = 0;
  const report = await reconcileExtractionOrphan(genericOptions, {
    journal,
    reconcileReceipt: async () => {
      calls += 1;
      return {
        success: true,
        replayed: false,
        operation: genericOptions.operation,
        receipt: {
          status: 'reconciled',
          startedAt,
          failure: {
            class: 'transient_runtime',
            cause: 'orphaned_operation_result_absent',
          },
        },
        reconciliation: {
          id: `xrec_${'5'.repeat(32)}`,
          at: '2026-07-30T00:01:00.000Z',
          resultStatus: 'absent',
        },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(report.stage, 'semantic_rollup');
  assert.equal(report.journalSeq, request.seq + 1);
  const events = await journal.readStage('semantic_rollup');
  assert.equal(events.at(-1).payload.receipt_input_hash, receiptInputHash);
  assert.equal(foldStageEvents(events).units.get('semantic-unit').blocked, false);

  await assert.rejects(
    () => reconcileExtractionOrphan({
      ...genericOptions,
      expectedJournalSeq: request.seq,
      operation: {
        ...genericOptions.operation,
        inputHash: '6'.repeat(64),
      },
    }, {
      journal,
      reconcileReceipt: async () => {
        throw new Error('must_not_call');
      },
    }),
    /orphan_reconciliation_journal_(?:drifted|identity_drifted)/,
  );
});

test('CLI requires one complete explicit identity and has no bulk reset mode', () => {
  assert.throws(() => parseArguments(['--all']), /unknown_argument:--all/);
  assert.throws(() => parseArguments([]), /state_dir_required/);
});

test('CLI accepts an exact Lessons execute reconciliation identity', () => {
  const parsed = parseArguments([
    '--state-dir', path.resolve('lesson-reconciliation-state'),
    '--run-id', 'formal-lessons-run',
    '--expected-journal-seq', '5',
    '--journal-unit-id', 'lesson-unit',
    '--operation-id', 'lesson-unit:lessons',
    '--phase', 'execute',
    '--reconciliation-request-seq', '5',
    '--receipt-key', `xop_${'1'.repeat(32)}`,
    '--operation-run-id', '2'.repeat(64),
    '--stage', 'lessons',
    '--unit-id', 'lesson-unit',
    '--input-hash', '3'.repeat(64),
    '--expected-status', 'running',
    '--expected-started-at', '2026-07-30T00:00:00.000Z',
    '--runner-input-hash', '4'.repeat(64),
  ]);

  assert.equal(parsed.operation.stage, 'lessons');
  assert.deepEqual(parsed.result, {
    kind: 'protocol_state',
    phase: 'execute',
    runnerInputHash: '4'.repeat(64),
  });
});

test('CLI accepts an exact Summary map reconciliation identity', () => {
  const parsed = parseArguments([
    '--state-dir', path.resolve('summary-map-reconciliation-state'),
    '--run-id', 'formal-summary-run',
    '--expected-journal-seq', '5',
    '--operation-run-id', '2'.repeat(64),
    '--stage', 'summary',
    '--unit-id', 'session-1:map:3',
    '--input-hash', '3'.repeat(64),
    '--expected-status', 'running',
    '--expected-started-at', '2026-07-30T00:00:00.000Z',
    '--session-id', 'session-1',
    '--resumable-run-id', `sumr_${'4'.repeat(24)}`,
    '--service-input-hash', '5'.repeat(64),
    '--runner-input-hash', '6'.repeat(64),
    '--generation-config-hash', '7'.repeat(64),
  ]);

  assert.equal(parsed.operation.unitId, 'session-1:map:3');
  assert.equal(parsed.operationId, 'session-1:map:3');
  assert.deepEqual(parsed.result, {
    kind: 'summary_resumable_run',
    sessionId: 'session-1',
    resumableRunId: `sumr_${'4'.repeat(24)}`,
    serviceInputHash: '5'.repeat(64),
    runnerInputHash: '6'.repeat(64),
    generationConfigHash: '7'.repeat(64),
    prepareRunId: '',
    prepareInputHash: '',
  });
});
