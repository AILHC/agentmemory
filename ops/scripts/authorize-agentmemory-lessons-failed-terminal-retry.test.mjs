import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorizeLessonsFailedTerminalRetry,
  parseArguments,
} from './authorize-agentmemory-lessons-failed-terminal-retry.mjs';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';

const formalRunId = 'formal-lessons-retry';
const attemptId = 'a'.repeat(64);
const runnerInputHash = 'b'.repeat(64);
const lessonRunInputHash = 'd'.repeat(64);
const lessonRunConfigHash = 'e'.repeat(64);
const receiptInputHash = createHash('sha256').update(JSON.stringify({
  configHash: lessonRunConfigHash,
  runnerInputHash,
  serviceInputHash: lessonRunInputHash,
})).digest('hex');
const timestamp = '2026-07-28T16:23:40.115Z';

function options(stateDir, overrides = {}) {
  return {
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir,
    formalRunId,
    expectedJournalSeq: 3,
    unitId: 'session-1',
    attemptId,
    runnerInputHash,
    receiptInputHash,
    expectedReceiptFailureClass: 'transient_provider',
    expectedReceiptFailureCause: 'lesson_extraction_failed',
    expectedRetryEpoch: 0,
    expectedLessonRunInputHash: lessonRunInputHash,
    expectedLessonRunConfigHash: lessonRunConfigHash,
    expectedLessonFailureCause: 'timeout',
    expectedLessonFailedAt: timestamp,
    expectedCreatedLessonCount: 0,
    expectedReplacedLessonCount: 0,
    expectedChunkLessonCount: 0,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    success: true,
    operation: {
      runId: attemptId,
      stage: 'lessons',
      unitId: 'session-1',
      inputHash: receiptInputHash,
    },
    receipt: {
      status: 'failed',
      startedAt: '2026-07-28T16:22:40.100Z',
      completedAt: '2026-07-28T16:23:40.116Z',
      failure: {
        class: 'transient_provider',
        cause: 'lesson_extraction_failed',
      },
      ...overrides,
    },
  };
}

function lessonRun(overrides = {}) {
  return {
    id: 'lesson-run-1',
    sessionId: 'session-1',
    status: 'retryable',
    inputHash: lessonRunInputHash,
    configHash: lessonRunConfigHash,
    attempts: 1,
    createdLessonIds: [],
    replacedLessonIds: [],
    createdAt: '2026-07-28T16:22:40.093Z',
    updatedAt: timestamp,
    startedAt: '2026-07-28T16:22:40.100Z',
    finishedAt: timestamp,
    failureDiagnostics: {
      requestPhase: 'chunk',
      providerErrorCode: 'timeout',
      statusCode: 200,
      elapsedMs: 60_002,
      inputChars: 120,
      maxOutputTokens: 4096,
      responseStarted: true,
      stopReason: 'error',
    },
    ...overrides,
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
    await journal.appendStage('lessons', 'unit_planned', {
      unit_id: 'session-1',
      input_hash: runnerInputHash,
    });
    await journal.appendStage('lessons', 'stage_plan_completed', { unit_count: 1 });
    await journal.appendStage('lessons', 'unit_started', {
      unit_id: 'session-1',
      input_hash: runnerInputHash,
      attempt_id: attemptId,
    });
    await journal.appendStage('lessons', 'unit_terminal', {
      unit_id: 'session-1',
      attempt_id: attemptId,
      status: 'failed',
      error: 'lesson_extraction_failed',
    });
  } finally {
    await journal.releaseLock();
  }
  return { stateDir, rootDir };
}

function dependencies(overrides = {}) {
  return {
    lookupReceipt: async () => receipt(),
    lookupLessonRuns: async () => ({ success: true, runs: [lessonRun()] }),
    lookupLessonRunDetail: async () => ({ success: true, run: lessonRun(), chunks: [] }),
    ...overrides,
  };
}

test('lessons failed-terminal retry authorization is append-only and idempotent', async (context) => {
  const run = await makeFailedRun('agentmemory-authorize-lessons-retry');
  context.after(() => fs.rm(run.stateDir, { recursive: true, force: true }));

  const first = await authorizeLessonsFailedTerminalRetry(options(run.stateDir), dependencies());
  const replay = await authorizeLessonsFailedTerminalRetry(options(run.stateDir), dependencies());
  const events = await new RunStateJournalV2({
    rootDir: run.rootDir,
    runId: formalRunId,
  }).readStage('lessons');

  assert.equal(first.success, true);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(
    events.filter((event) => event.type === 'unit_lessons_failed_terminal_retry_authorized').length,
    1,
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'unit_terminal').map((event) => event.payload.status),
    ['failed'],
  );
});

test('lessons retry authorization fails closed on journal drift or unsafe result evidence', async (context) => {
  const cases = [
    ['runner hash drift', options, dependencies, { runnerInputHash: 'f'.repeat(64) }],
    ['missing diagnostics', options, () => dependencies({
      lookupLessonRuns: async () => ({ success: true, runs: [lessonRun({ failureDiagnostics: undefined })] }),
      lookupLessonRunDetail: async () => ({ success: true, run: lessonRun({ failureDiagnostics: undefined }), chunks: [] }),
    }), {}],
    ['created lessons', options, () => dependencies({
      lookupLessonRuns: async () => ({ success: true, runs: [lessonRun({ createdLessonIds: ['created-1'] })] }),
      lookupLessonRunDetail: async () => ({ success: true, run: lessonRun({ createdLessonIds: ['created-1'] }), chunks: [] }),
    }), {}],
    ['chunk lessons', options, () => dependencies({
      lookupLessonRunDetail: async () => ({
        success: true,
        run: lessonRun(),
        chunks: [{ status: 'succeeded', lessonIds: ['created-1'] }],
      }),
    }), {}],
  ];

  for (const [name, optionFactory, dependencyFactory, optionOverrides] of cases) {
    const run = await makeFailedRun(`agentmemory-authorize-lessons-retry-${name.replaceAll(' ', '-')}`);
    context.after(() => fs.rm(run.stateDir, { recursive: true, force: true }));
    await assert.rejects(
      () => authorizeLessonsFailedTerminalRetry(
        optionFactory(run.stateDir, optionOverrides),
        dependencyFactory(),
      ),
      /lessons_retry_authorization_/,
      name,
    );
    const events = await new RunStateJournalV2({
      rootDir: run.rootDir,
      runId: formalRunId,
    }).readStage('lessons');
    assert.equal(
      events.some((event) => event.type === 'unit_lessons_failed_terminal_retry_authorized'),
      false,
      name,
    );
  }

  const drifted = await makeFailedRun('agentmemory-authorize-lessons-retry-seq-drift');
  context.after(() => fs.rm(drifted.stateDir, { recursive: true, force: true }));
  await assert.rejects(
    () => authorizeLessonsFailedTerminalRetry(
      options(drifted.stateDir, { expectedJournalSeq: 2 }),
      dependencies(),
    ),
    /lessons_retry_authorization_journal_/,
  );
});

test('lessons retry authorization CLI requires exact zero-result evidence', () => {
  assert.throws(() => parseArguments([
    '--state-dir', 'F:\\state',
    '--run-id', formalRunId,
    '--expected-journal-seq', '3',
    '--unit-id', 'session-1',
    '--attempt-id', attemptId,
    '--runner-input-hash', runnerInputHash,
    '--receipt-input-hash', receiptInputHash,
    '--expected-receipt-failure-class', 'transient_provider',
    '--expected-receipt-failure-cause', 'lesson_extraction_failed',
    '--expected-retry-epoch', '0',
    '--expected-lesson-run-input-hash', lessonRunInputHash,
    '--expected-lesson-run-config-hash', lessonRunConfigHash,
    '--expected-lesson-failure-cause', 'timeout',
    '--expected-lesson-failed-at', timestamp,
    '--expected-created-lesson-count', '1',
    '--expected-replaced-lesson-count', '0',
    '--expected-chunk-lesson-count', '0',
  ]), /expected_lesson_result_counts_unsafe/);
});
