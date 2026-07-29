import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWorker } from 'iii-sdk';
import { validateSinglePhaseStage } from './lib/recoverable-stage-v2.mjs';
import { foldStageEvents, RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_PROVIDER_CAUSES = new Set(['rate_limited', 'timeout', 'network_error', 'server_error']);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function validateOptions(options) {
  if (!options.stateDir || !options.formalRunId || !options.unitId) {
    throw new Error('lessons_retry_authorization_identity_required');
  }
  if (!Number.isSafeInteger(options.expectedJournalSeq) || options.expectedJournalSeq < 0) {
    throw new Error('expected_journal_seq_invalid');
  }
  for (const [name, value] of [
    ['attempt_id', options.attemptId],
    ['runner_input_hash', options.runnerInputHash],
    ['receipt_input_hash', options.receiptInputHash],
    ['lesson_run_input_hash', options.expectedLessonRunInputHash],
    ['lesson_run_config_hash', options.expectedLessonRunConfigHash],
  ]) {
    if (!SHA256_HEX.test(value)) throw new Error(`${name}_invalid`);
  }
  if (
    options.expectedReceiptFailureClass !== 'transient_provider'
    || options.expectedReceiptFailureCause !== 'lesson_extraction_failed'
    || options.expectedRetryEpoch !== 0
  ) {
    throw new Error('expected_receipt_failure_unsafe');
  }
  if (!SAFE_PROVIDER_CAUSES.has(options.expectedLessonFailureCause)) {
    throw new Error('expected_lesson_failure_unsafe');
  }
  if (!ISO_TIMESTAMP.test(options.expectedLessonFailedAt)) {
    throw new Error('expected_lesson_failed_at_invalid');
  }
  if (
    options.expectedCreatedLessonCount !== 0
    || options.expectedReplacedLessonCount !== 0
    || options.expectedChunkLessonCount !== 0
  ) {
    throw new Error('expected_lesson_result_counts_unsafe');
  }
}

export function parseArguments(argv) {
  const options = {
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir: '',
    formalRunId: '',
    expectedJournalSeq: -1,
    unitId: '',
    attemptId: '',
    runnerInputHash: '',
    receiptInputHash: '',
    expectedReceiptFailureClass: '',
    expectedReceiptFailureCause: '',
    expectedRetryEpoch: -1,
    expectedLessonRunInputHash: '',
    expectedLessonRunConfigHash: '',
    expectedLessonFailureCause: '',
    expectedLessonFailedAt: '',
    expectedCreatedLessonCount: -1,
    expectedReplacedLessonCount: -1,
    expectedChunkLessonCount: -1,
  };
  const setters = new Map([
    ['--engine-url', (value) => { options.engineUrl = value; }],
    ['--state-dir', (value) => { options.stateDir = value; }],
    ['--run-id', (value) => { options.formalRunId = value; }],
    ['--expected-journal-seq', (value) => { options.expectedJournalSeq = Number(value); }],
    ['--unit-id', (value) => { options.unitId = value; }],
    ['--attempt-id', (value) => { options.attemptId = value; }],
    ['--runner-input-hash', (value) => { options.runnerInputHash = value; }],
    ['--receipt-input-hash', (value) => { options.receiptInputHash = value; }],
    ['--expected-receipt-failure-class', (value) => { options.expectedReceiptFailureClass = value; }],
    ['--expected-receipt-failure-cause', (value) => { options.expectedReceiptFailureCause = value; }],
    ['--expected-retry-epoch', (value) => { options.expectedRetryEpoch = Number(value); }],
    ['--expected-lesson-run-input-hash', (value) => { options.expectedLessonRunInputHash = value; }],
    ['--expected-lesson-run-config-hash', (value) => { options.expectedLessonRunConfigHash = value; }],
    ['--expected-lesson-failure-cause', (value) => { options.expectedLessonFailureCause = value; }],
    ['--expected-lesson-failed-at', (value) => { options.expectedLessonFailedAt = value; }],
    ['--expected-created-lesson-count', (value) => { options.expectedCreatedLessonCount = Number(value); }],
    ['--expected-replaced-lesson-count', (value) => { options.expectedReplacedLessonCount = Number(value); }],
    ['--expected-chunk-lesson-count', (value) => { options.expectedChunkLessonCount = Number(value); }],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const setter = setters.get(argv[index]);
    if (!setter || argv[index + 1] === undefined) throw new Error(`unknown_argument:${argv[index]}`);
    setter(argv[index + 1]);
  }
  validateOptions(options);
  return options;
}

function sameAuthorization(event, options) {
  const payload = event.payload;
  return event.type === 'unit_lessons_failed_terminal_retry_authorized'
    && payload?.stage === 'lessons'
    && payload?.unit_id === options.unitId
    && payload?.attempt_id === options.attemptId
    && payload?.runner_input_hash === options.runnerInputHash
    && payload?.receipt_input_hash === options.receiptInputHash
    && payload?.lesson_run_evidence?.input_hash === options.expectedLessonRunInputHash
    && payload?.lesson_run_evidence?.config_hash === options.expectedLessonRunConfigHash
    && payload?.lesson_run_evidence?.failure_cause === options.expectedLessonFailureCause
    && payload?.lesson_run_evidence?.failed_at === options.expectedLessonFailedAt;
}

function validateFailedJournal(events, options) {
  const state = foldStageEvents(events);
  const unit = state.units.get(options.unitId);
  const terminal = events.at(-1);
  if (
    !unit
    || unit.blocked
    || unit.recorded
    || unit.active_operation
    || unit.input_hash !== options.runnerInputHash
    || unit.attempt_id !== options.attemptId
    || unit.terminal !== 'failed'
    || terminal?.seq !== options.expectedJournalSeq
    || terminal?.type !== 'unit_terminal'
    || terminal?.payload?.unit_id !== options.unitId
    || terminal?.payload?.attempt_id !== options.attemptId
    || terminal?.payload?.status !== 'failed'
    || terminal?.payload?.error !== options.expectedReceiptFailureCause
  ) {
    throw new Error('lessons_retry_authorization_journal_identity_drifted');
  }
  return terminal;
}

function validateReceipt(result, options) {
  const receipt = result?.receipt;
  if (
    result?.success !== true
    || result.operation?.runId !== options.attemptId
    || result.operation?.stage !== 'lessons'
    || result.operation?.unitId !== options.unitId
    || result.operation?.inputHash !== options.receiptInputHash
    || receipt?.status !== 'failed'
    || receipt?.failure?.class !== options.expectedReceiptFailureClass
    || receipt?.failure?.cause !== options.expectedReceiptFailureCause
    || receipt?.failure?.phase !== undefined
    || receipt?.retry !== undefined
  ) {
    throw new Error('lessons_retry_authorization_receipt_evidence_invalid');
  }
}

function validateLessonEvidence(runsResult, detailResult, options) {
  const runs = Array.isArray(runsResult?.runs) ? runsResult.runs : [];
  const matches = runs.filter((run) =>
    run?.sessionId === options.unitId
    && stableHash({
      runnerInputHash: options.runnerInputHash,
      serviceInputHash: run.inputHash,
      configHash: run.configHash,
    }) === options.receiptInputHash);
  if (matches.length !== 1) {
    throw new Error('lessons_retry_authorization_lesson_identity_invalid');
  }
  const run = matches[0];
  const detailRun = detailResult?.run;
  const diagnostics = detailRun?.failureDiagnostics;
  const chunks = Array.isArray(detailResult?.chunks) ? detailResult.chunks : [];
  const chunkLessonCount = chunks.reduce(
    (count, chunk) => count + (Array.isArray(chunk?.lessonIds) ? chunk.lessonIds.length : 0),
    0,
  );
  if (
    detailResult?.success !== true
    || detailRun?.id !== run.id
    || detailRun?.sessionId !== options.unitId
    || detailRun?.status !== 'retryable'
    || detailRun?.inputHash !== run.inputHash
    || detailRun?.configHash !== run.configHash
    || detailRun?.inputHash !== options.expectedLessonRunInputHash
    || detailRun?.configHash !== options.expectedLessonRunConfigHash
    || !Array.isArray(detailRun?.createdLessonIds)
    || detailRun.createdLessonIds.length !== options.expectedCreatedLessonCount
    || !Array.isArray(detailRun?.replacedLessonIds)
    || detailRun.replacedLessonIds.length !== options.expectedReplacedLessonCount
    || chunkLessonCount !== options.expectedChunkLessonCount
    || diagnostics?.requestPhase !== 'chunk'
    || diagnostics?.providerErrorCode !== options.expectedLessonFailureCause
    || detailRun.finishedAt !== options.expectedLessonFailedAt
  ) {
    throw new Error('lessons_retry_authorization_lesson_evidence_invalid');
  }
  return run;
}

function report(event, options, replayed) {
  return {
    success: true,
    replayed,
    runId: options.formalRunId,
    stage: 'lessons',
    retryEpoch: options.expectedRetryEpoch,
    journalSeq: event.seq,
  };
}

export async function authorizeLessonsFailedTerminalRetry(options, dependencies) {
  validateOptions(options);
  const rootDir = path.join(path.resolve(options.stateDir), `${options.formalRunId}.v2`);
  const journal = new RunStateJournalV2({ rootDir, runId: options.formalRunId });
  await journal.acquireLock();
  try {
    await journal.open();
    const control = await journal.readControl();
    const events = await journal.readStage('lessons');
    validateSinglePhaseStage(events);
    const existing = events.find((event) => sameAuthorization(event, options));
    if (existing) return report(existing, options, true);
    if (control.some((event) => event.type === 'run_completed')) {
      throw new Error('lessons_retry_authorization_formal_run_completed');
    }
    const terminal = validateFailedJournal(events, options);
    const receiptResult = await dependencies.lookupReceipt({
      runId: options.attemptId,
      stage: 'lessons',
      unitId: options.unitId,
      inputHash: options.receiptInputHash,
    });
    validateReceipt(receiptResult, options);
    const runsResult = await dependencies.lookupLessonRuns({
      sessionId: options.unitId,
      limit: 500,
    });
    const candidate = Array.isArray(runsResult?.runs)
      ? runsResult.runs.find((run) => run.inputHash === options.expectedLessonRunInputHash
        && run.configHash === options.expectedLessonRunConfigHash)
      : null;
    if (!candidate?.id) throw new Error('lessons_retry_authorization_lesson_identity_invalid');
    const detailResult = await dependencies.lookupLessonRunDetail({ runId: candidate.id });
    validateLessonEvidence(runsResult, detailResult, options);
    const event = await journal.appendStageExpectedSeq(
      'lessons',
      options.expectedJournalSeq,
      'unit_lessons_failed_terminal_retry_authorized',
      {
        stage: 'lessons',
        unit_id: options.unitId,
        attempt_id: options.attemptId,
        runner_input_hash: options.runnerInputHash,
        receipt_input_hash: options.receiptInputHash,
        receipt_status: 'failed',
        receipt_failure_class: options.expectedReceiptFailureClass,
        receipt_failure_cause: options.expectedReceiptFailureCause,
        failure_class: options.expectedReceiptFailureClass,
        failure_cause: options.expectedReceiptFailureCause,
        failure_phase: 'provider_call',
        retry_epoch: options.expectedRetryEpoch,
        last_safe_failure: {
          error_class: options.expectedReceiptFailureClass,
          cause: options.expectedReceiptFailureCause,
          phase: 'provider_call',
          timestamp: options.expectedLessonFailedAt,
        },
        lesson_run_evidence: {
          status: 'retryable',
          input_hash: options.expectedLessonRunInputHash,
          config_hash: options.expectedLessonRunConfigHash,
          failure_cause: options.expectedLessonFailureCause,
          failure_phase: 'provider_call',
          failed_at: options.expectedLessonFailedAt,
          created_lesson_count: options.expectedCreatedLessonCount,
          replaced_lesson_count: options.expectedReplacedLessonCount,
          chunk_lesson_count: options.expectedChunkLessonCount,
        },
        superseded_terminal_seq: terminal.seq,
        expected_journal_seq: options.expectedJournalSeq,
      },
    );
    return report(event, options, false);
  } finally {
    await journal.releaseLock();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sdk = registerWorker(options.engineUrl);
  try {
    const result = await authorizeLessonsFailedTerminalRetry(options, {
      lookupReceipt: (payload) => sdk.trigger({
        function_id: 'mem::extraction-operation-receipt-get',
        payload,
      }),
      lookupLessonRuns: (payload) => sdk.trigger({
        function_id: 'mem::lessons::extract-runs',
        payload,
      }),
      lookupLessonRunDetail: (payload) => sdk.trigger({
        function_id: 'mem::lessons::extract-run-get',
        payload,
      }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await sdk.shutdown();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
