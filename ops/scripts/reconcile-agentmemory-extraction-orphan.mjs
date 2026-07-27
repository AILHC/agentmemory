import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWorker } from 'iii-sdk';
import {
  validateSinglePhaseStage,
} from './lib/recoverable-stage-v2.mjs';
import {
  foldStageEvents,
  RunStateJournalV2,
} from './lib/run-state-journal-v2.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESUMABLE_RUN_ID = /^sumr_[0-9a-f]{24}$/;
const RECONCILIATION_ID = /^xrec_[0-9a-f]{32}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing_value:${option}`);
  return value;
}

function assertAbsolute(value, option) {
  if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${option}_must_be_absolute`);
  }
}

function assertHash(value, option) {
  if (!SHA256_HEX.test(value)) throw new Error(`${option}_invalid`);
}

export function parseArguments(argv) {
  const options = {
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir: '',
    formalRunId: '',
    expectedJournalSeq: -1,
    operation: {
      runId: '',
      stage: '',
      unitId: '',
      inputHash: '',
      expectedStatus: '',
      expectedStartedAt: '',
    },
    result: {
      sessionId: '',
      resumableRunId: '',
      serviceInputHash: '',
      runnerInputHash: '',
      generationConfigHash: '',
    },
  };
  const setters = new Map([
    ['--engine-url', (value) => { options.engineUrl = value; }],
    ['--state-dir', (value) => { options.stateDir = value; }],
    ['--run-id', (value) => { options.formalRunId = value; }],
    ['--expected-journal-seq', (value) => { options.expectedJournalSeq = Number(value); }],
    ['--operation-run-id', (value) => { options.operation.runId = value; }],
    ['--stage', (value) => { options.operation.stage = value; }],
    ['--unit-id', (value) => { options.operation.unitId = value; }],
    ['--input-hash', (value) => { options.operation.inputHash = value; }],
    ['--expected-status', (value) => { options.operation.expectedStatus = value; }],
    ['--expected-started-at', (value) => { options.operation.expectedStartedAt = value; }],
    ['--session-id', (value) => { options.result.sessionId = value; }],
    ['--resumable-run-id', (value) => { options.result.resumableRunId = value; }],
    ['--service-input-hash', (value) => { options.result.serviceInputHash = value; }],
    ['--runner-input-hash', (value) => { options.result.runnerInputHash = value; }],
    ['--generation-config-hash', (value) => { options.result.generationConfigHash = value; }],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const setter = setters.get(argument);
    if (!setter) throw new Error(`unknown_argument:${argument}`);
    setter(requireValue(argv, index, argument));
    index += 1;
  }

  if (!options.stateDir) throw new Error('state_dir_required');
  if (!options.formalRunId) throw new Error('run_id_required');
  assertAbsolute(options.stateDir, 'state_dir');
  if (!Number.isSafeInteger(options.expectedJournalSeq) || options.expectedJournalSeq < 0) {
    throw new Error('expected_journal_seq_invalid');
  }
  if (options.operation.stage !== 'summary') throw new Error('stage_must_be_summary');
  if (options.operation.expectedStatus !== 'running') {
    throw new Error('expected_status_must_be_running');
  }
  if (!ISO_TIMESTAMP.test(options.operation.expectedStartedAt)) {
    throw new Error('expected_started_at_invalid');
  }
  assertHash(options.operation.runId, 'operation_run_id');
  assertHash(options.operation.inputHash, 'input_hash');
  assertHash(options.result.serviceInputHash, 'service_input_hash');
  assertHash(options.result.runnerInputHash, 'runner_input_hash');
  assertHash(options.result.generationConfigHash, 'generation_config_hash');
  if (!RESUMABLE_RUN_ID.test(options.result.resumableRunId)) {
    throw new Error('resumable_run_id_invalid');
  }
  if (
    !options.result.sessionId
    || options.operation.unitId !== `${options.result.sessionId}:reduce`
  ) {
    throw new Error('summary_reduce_identity_invalid');
  }
  return options;
}

function validateBlockedUnit(events, options) {
  validateSinglePhaseStage(events);
  if (events.at(-1)?.seq !== options.expectedJournalSeq) {
    throw new Error('orphan_reconciliation_journal_drifted');
  }
  const state = foldStageEvents(events);
  const unit = state.units.get(options.result.sessionId);
  if (
    !unit
    || unit.input_hash !== options.result.runnerInputHash
    || unit.attempt_id !== options.operation.runId
    || !unit.blocked
    || unit.blocked_payload?.reason !== 'extraction_operation_reconciliation_required'
    || unit.active_operation?.operation_id !== options.operation.unitId
    || unit.active_operation?.attempt_id !== options.operation.runId
  ) {
    throw new Error('orphan_reconciliation_journal_identity_drifted');
  }
}

function validateReceiptResult(result, options) {
  if (
    result?.success !== true
    || result.operation?.runId !== options.operation.runId
    || result.operation?.stage !== options.operation.stage
    || result.operation?.unitId !== options.operation.unitId
    || result.operation?.inputHash !== options.operation.inputHash
    || result.receipt?.status !== 'reconciled'
    || result.receipt?.startedAt !== options.operation.expectedStartedAt
    || result.receipt?.failure?.class !== 'transient_runtime'
    || result.receipt?.failure?.cause !== 'orphaned_operation_result_absent'
    || !RECONCILIATION_ID.test(String(result.reconciliation?.id || ''))
    || !ISO_TIMESTAMP.test(String(result.reconciliation?.at || ''))
    || result.reconciliation?.resultStatus !== 'absent'
  ) {
    throw new Error('orphan_reconciliation_receipt_result_invalid');
  }
}

export async function reconcileSummaryOrphan(options, dependencies) {
  const rootDir = path.join(path.resolve(options.stateDir), `${options.formalRunId}.v2`);
  const journal = dependencies.journal
    || new RunStateJournalV2({ rootDir, runId: options.formalRunId });
  await journal.acquireLock();
  try {
    await journal.open();
    const events = await journal.readStage('summary');
    validateBlockedUnit(events, options);
    const receiptResult = await dependencies.reconcileReceipt({
      operation: options.operation,
      result: options.result,
    });
    validateReceiptResult(receiptResult, options);
    const event = await journal.appendStage('summary', 'unit_reconciliation_resolved', {
      unit_id: options.result.sessionId,
      attempt_id: options.operation.runId,
      operation_id: options.operation.unitId,
      reconciliation_id: receiptResult.reconciliation.id,
      receipt_input_hash: options.operation.inputHash,
      receipt_started_at: options.operation.expectedStartedAt,
      receipt_status: receiptResult.receipt.status,
      result_status: receiptResult.reconciliation.resultStatus,
      cause: receiptResult.receipt.failure.cause,
    });
    validateSinglePhaseStage(await journal.readStage('summary'));
    return {
      success: true,
      replayed: receiptResult.replayed === true,
      runId: options.formalRunId,
      stage: 'summary',
      unitId: options.result.sessionId,
      operationId: options.operation.unitId,
      attemptId: options.operation.runId,
      reconciliationId: receiptResult.reconciliation.id,
      receiptInputHash: options.operation.inputHash,
      receiptStartedAt: options.operation.expectedStartedAt,
      receiptStatus: receiptResult.receipt.status,
      resultStatus: receiptResult.reconciliation.resultStatus,
      journalSeq: event.seq,
      reconciledAt: receiptResult.reconciliation.at,
    };
  } finally {
    await journal.releaseLock();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sdk = registerWorker(options.engineUrl);
  try {
    const report = await reconcileSummaryOrphan(options, {
      reconcileReceipt: (payload) => sdk.trigger({
        function_id: 'mem::extraction-operation-receipt-reconcile-orphan',
        payload,
      }),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
