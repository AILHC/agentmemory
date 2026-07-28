// 运维专用：从干净正式源码 checkout（检出）运行并连接已部署 runtime（运行环境），不复制进 runtime。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWorker } from 'iii-sdk';
import { validateSinglePhaseStage } from './lib/recoverable-stage-v2.mjs';
import { foldStageEvents, RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAILURE_CAUSE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i;
const SAFE_CLASSES = new Set(['transient_provider', 'transient_runtime']);
const SAFE_PHASES = new Set(['provider_call', 'before_final_persistence']);

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing_value:${option}`);
  return value;
}

function validateOptions(options) {
  if (!options.stateDir) throw new Error('state_dir_required');
  if (!path.isAbsolute(options.stateDir) && !/^[A-Za-z]:[\\/]/.test(options.stateDir)) {
    throw new Error('state_dir_must_be_absolute');
  }
  if (!options.formalRunId || !/^[A-Za-z0-9._-]+$/.test(options.formalRunId)) {
    throw new Error('run_id_invalid');
  }
  if (!Number.isSafeInteger(options.expectedJournalSeq) || options.expectedJournalSeq < 0) {
    throw new Error('expected_journal_seq_invalid');
  }
  if (!options.unitId || options.operationId !== `${options.unitId}:reduce`) {
    throw new Error('summary_reduce_identity_invalid');
  }
  if (!SHA256_HEX.test(options.attemptId)) throw new Error('attempt_id_invalid');
  if (!SHA256_HEX.test(options.runnerInputHash)) throw new Error('runner_input_hash_invalid');
  if (!SHA256_HEX.test(options.receiptInputHash)) throw new Error('receipt_input_hash_invalid');
  if (!SAFE_CLASSES.has(options.expectedFailureClass)) {
    throw new Error('expected_failure_class_unsafe');
  }
  if (!FAILURE_CAUSE.test(options.expectedFailureCause)) {
    throw new Error('expected_failure_cause_invalid');
  }
  if (!SAFE_PHASES.has(options.expectedFailurePhase)) {
    throw new Error('expected_failure_phase_unsafe');
  }
  if (!Number.isSafeInteger(options.expectedRetryEpoch) || options.expectedRetryEpoch < 0) {
    throw new Error('expected_retry_epoch_invalid');
  }
  const lastSafe = options.expectedLastSafeFailure;
  if (!lastSafe?.timestamp) throw new Error('expected_last_safe_timestamp_required');
  if (
    lastSafe.errorClass !== options.expectedFailureClass
    || lastSafe.cause !== options.expectedFailureCause
    || lastSafe.phase !== options.expectedFailurePhase
    || !ISO_TIMESTAMP.test(lastSafe.timestamp)
  ) {
    throw new Error('expected_last_safe_failure_invalid');
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
    operationId: '',
    runnerInputHash: '',
    receiptInputHash: '',
    expectedFailureClass: '',
    expectedFailureCause: '',
    expectedFailurePhase: '',
    expectedRetryEpoch: -1,
    expectedLastSafeFailure: {
      errorClass: '',
      cause: '',
      phase: '',
      timestamp: '',
    },
  };
  const setters = new Map([
    ['--engine-url', (value) => { options.engineUrl = value; }],
    ['--state-dir', (value) => { options.stateDir = value; }],
    ['--run-id', (value) => { options.formalRunId = value; }],
    ['--expected-journal-seq', (value) => { options.expectedJournalSeq = Number(value); }],
    ['--unit-id', (value) => { options.unitId = value; }],
    ['--attempt-id', (value) => { options.attemptId = value; }],
    ['--operation-id', (value) => { options.operationId = value; }],
    ['--runner-input-hash', (value) => { options.runnerInputHash = value; }],
    ['--receipt-input-hash', (value) => { options.receiptInputHash = value; }],
    ['--expected-failure-class', (value) => { options.expectedFailureClass = value; }],
    ['--expected-failure-cause', (value) => { options.expectedFailureCause = value; }],
    ['--expected-failure-phase', (value) => { options.expectedFailurePhase = value; }],
    ['--expected-retry-epoch', (value) => { options.expectedRetryEpoch = Number(value); }],
    ['--expected-last-safe-error-class', (value) => {
      options.expectedLastSafeFailure.errorClass = value;
    }],
    ['--expected-last-safe-cause', (value) => {
      options.expectedLastSafeFailure.cause = value;
    }],
    ['--expected-last-safe-phase', (value) => {
      options.expectedLastSafeFailure.phase = value;
    }],
    ['--expected-last-safe-timestamp', (value) => {
      options.expectedLastSafeFailure.timestamp = value;
    }],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const setter = setters.get(argument);
    if (!setter) throw new Error(`unknown_argument:${argument}`);
    setter(requireValue(argv, index, argument));
    index += 1;
  }
  validateOptions(options);
  return options;
}

function sameAuthorization(event, options) {
  const payload = event.payload;
  const lastSafe = payload?.last_safe_failure;
  return event.type === 'unit_summary_failed_terminal_retry_authorized'
    && payload?.stage === 'summary'
    && payload?.unit_id === options.unitId
    && payload?.attempt_id === options.attemptId
    && payload?.operation_id === options.operationId
    && payload?.runner_input_hash === options.runnerInputHash
    && payload?.receipt_input_hash === options.receiptInputHash
    && payload?.receipt_status === 'failed'
    && payload?.failure_class === options.expectedFailureClass
    && payload?.failure_cause === options.expectedFailureCause
    && payload?.failure_phase === options.expectedFailurePhase
    && payload?.retry_epoch === options.expectedRetryEpoch
    && lastSafe?.error_class === options.expectedLastSafeFailure.errorClass
    && lastSafe?.cause === options.expectedLastSafeFailure.cause
    && lastSafe?.phase === options.expectedLastSafeFailure.phase
    && lastSafe?.timestamp === options.expectedLastSafeFailure.timestamp
    && payload?.expected_journal_seq === options.expectedJournalSeq;
}

function validateControl(control, options) {
  const started = control.filter((event) => event.type === 'run_started');
  if (
    started.length !== 1
    || started[0].payload?.run_id !== options.formalRunId
    || started[0].payload?.format !== 'run-state-journal-v2'
    || started[0].payload?.schema_version !== 2
  ) {
    throw new Error('summary_retry_authorization_formal_run_invalid');
  }
}

function validateFailedJournal(events, options) {
  validateSinglePhaseStage(events);
  if (events.at(-1)?.seq !== options.expectedJournalSeq) {
    throw new Error('summary_retry_authorization_journal_drifted');
  }
  const state = foldStageEvents(events);
  const unit = state.units.get(options.unitId);
  const terminalEvent = events.at(-1);
  const operationEvent = events.findLast((event) =>
    event.type === 'unit_operation_completed'
    && event.payload?.unit_id === options.unitId
    && event.payload?.operation_id === options.operationId
    && event.payload?.attempt_id === options.attemptId);
  if (
    !unit
    || unit.input_hash !== options.runnerInputHash
    || unit.attempt_id !== options.attemptId
    || unit.terminal !== 'failed'
    || unit.recorded
    || unit.blocked
    || unit.active_operation
    || terminalEvent?.seq !== options.expectedJournalSeq
    || terminalEvent?.payload?.status !== 'failed'
    || terminalEvent?.payload?.attempt_id !== options.attemptId
    || terminalEvent?.payload?.error !== options.expectedFailureCause
    || operationEvent?.seq !== options.expectedJournalSeq - 1
    || operationEvent?.payload?.status !== 'failed'
    || operationEvent?.payload?.terminal_result?.status !== 'failed'
    || operationEvent?.payload?.terminal_result?.payload?.error !== options.expectedFailureCause
  ) {
    throw new Error('summary_retry_authorization_journal_identity_drifted');
  }
  return { operationEvent, terminalEvent };
}

function validateReceipt(result, options) {
  const receipt = result?.receipt;
  const failure = receipt?.failure;
  const retry = receipt?.retry;
  const lastSafe = retry?.lastSafeFailure;
  if (
    result?.success !== true
    || result.operation?.runId !== options.attemptId
    || result.operation?.stage !== 'summary'
    || result.operation?.unitId !== options.operationId
    || result.operation?.inputHash !== options.receiptInputHash
    || receipt?.status !== 'failed'
    || failure?.class !== options.expectedFailureClass
    || failure?.cause !== options.expectedFailureCause
    || failure?.phase !== options.expectedFailurePhase
    || !SAFE_CLASSES.has(failure?.class)
    || !SAFE_PHASES.has(failure?.phase)
    || retry?.epoch !== options.expectedRetryEpoch
    || lastSafe?.errorClass !== options.expectedLastSafeFailure.errorClass
    || lastSafe?.cause !== options.expectedLastSafeFailure.cause
    || lastSafe?.phase !== options.expectedLastSafeFailure.phase
    || lastSafe?.timestamp !== options.expectedLastSafeFailure.timestamp
    || lastSafe?.errorClass !== failure?.class
    || lastSafe?.cause !== failure?.cause
    || lastSafe?.phase !== failure?.phase
  ) {
    throw new Error('summary_retry_authorization_receipt_evidence_invalid');
  }
}

function report(event, options, replayed) {
  return {
    success: true,
    replayed,
    runId: options.formalRunId,
    stage: 'summary',
    unitId: options.unitId,
    attemptId: options.attemptId,
    operationId: options.operationId,
    runnerInputHash: options.runnerInputHash,
    receiptInputHash: options.receiptInputHash,
    retryEpoch: options.expectedRetryEpoch,
    journalSeq: event.seq,
  };
}

export async function authorizeSummaryFailedTerminalRetry(options, dependencies) {
  validateOptions(options);
  const rootDir = path.join(path.resolve(options.stateDir), `${options.formalRunId}.v2`);
  const journal = dependencies.journal
    || new RunStateJournalV2({ rootDir, runId: options.formalRunId });
  await journal.acquireLock();
  try {
    const control = await journal.open();
    validateControl(control, options);
    const events = await journal.readStage('summary');
    validateSinglePhaseStage(events);
    const existing = events.find((event) => sameAuthorization(event, options));
    if (existing) return report(existing, options, true);
    if (control.some((event) => event.type === 'run_completed')) {
      throw new Error('summary_retry_authorization_formal_run_completed');
    }
    const { operationEvent, terminalEvent } = validateFailedJournal(events, options);
    const receiptResult = await dependencies.lookupReceipt({
      runId: options.attemptId,
      stage: 'summary',
      unitId: options.operationId,
      inputHash: options.receiptInputHash,
    });
    validateReceipt(receiptResult, options);
    const event = await journal.appendStageExpectedSeq(
      'summary',
      options.expectedJournalSeq,
      'unit_summary_failed_terminal_retry_authorized',
      {
        stage: 'summary',
        unit_id: options.unitId,
        attempt_id: options.attemptId,
        operation_id: options.operationId,
        runner_input_hash: options.runnerInputHash,
        receipt_input_hash: options.receiptInputHash,
        receipt_status: 'failed',
        failure_class: options.expectedFailureClass,
        failure_cause: options.expectedFailureCause,
        failure_phase: options.expectedFailurePhase,
        retry_epoch: options.expectedRetryEpoch,
        last_safe_failure: {
          error_class: options.expectedLastSafeFailure.errorClass,
          cause: options.expectedLastSafeFailure.cause,
          phase: options.expectedLastSafeFailure.phase,
          timestamp: options.expectedLastSafeFailure.timestamp,
        },
        superseded_operation_seq: operationEvent.seq,
        superseded_terminal_seq: terminalEvent.seq,
        expected_journal_seq: options.expectedJournalSeq,
      },
    );
    validateSinglePhaseStage(await journal.readStage('summary'));
    return report(event, options, false);
  } finally {
    await journal.releaseLock();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sdk = registerWorker(options.engineUrl);
  try {
    const result = await authorizeSummaryFailedTerminalRetry(options, {
      lookupReceipt: (payload) => sdk.trigger({
        function_id: 'mem::extraction-operation-receipt-get',
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
