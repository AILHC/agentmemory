import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWorker } from 'iii-sdk';
import {
  validateSinglePhaseStage,
  validateTwoPhaseStage,
} from './lib/recoverable-stage-v2.mjs';
import {
  foldStageEvents,
  RunStateJournalV2,
} from './lib/run-state-journal-v2.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESUMABLE_RUN_ID = /^sumr_[0-9a-f]{24}$/;
const RECONCILIATION_ID = /^xrec_[0-9a-f]{32}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECEIPT_KEY = /^xop_[0-9a-f]{32}$/;
const GENERIC_STAGES = new Set([
  'lessons',
  'memory_consolidate',
  'skill_extract',
  'semantic_rollup',
  'crystal',
  'consolidation_procedural',
  'reflect_insight',
]);
const SAFE_RECONCILIATION_FAILURES = new Set([
  'invalid_orphan_reconciliation_identity',
  'orphan_reconciliation_evidence_drifted',
  'orphan_reconciliation_result_present',
  'orphan_reconciliation_result_binding_drifted',
]);

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

function isSummaryOperationUnit(sessionId, unitId) {
  if (unitId === `${sessionId}:reduce`) return true;
  const prefix = `${sessionId}:map:`;
  return unitId.startsWith(prefix)
    && /^(?:0|[1-9]\d*)$/.test(unitId.slice(prefix.length));
}

export function parseArguments(argv) {
  const options = {
    engineUrl: 'ws://127.0.0.1:49134',
    stateDir: '',
    formalRunId: '',
    expectedJournalSeq: -1,
    journalUnitId: '',
    operationId: '',
    phase: '',
    reconciliationRequestSeq: -1,
    receiptKey: '',
    operation: {
      runId: '',
      stage: '',
      unitId: '',
      inputHash: '',
      expectedStatus: '',
      expectedStartedAt: '',
    },
    result: {
      kind: '',
      sessionId: '',
      resumableRunId: '',
      serviceInputHash: '',
      runnerInputHash: '',
      generationConfigHash: '',
      prepareRunId: '',
      prepareInputHash: '',
    },
  };
  const setters = new Map([
    ['--engine-url', (value) => { options.engineUrl = value; }],
    ['--state-dir', (value) => { options.stateDir = value; }],
    ['--run-id', (value) => { options.formalRunId = value; }],
    ['--expected-journal-seq', (value) => { options.expectedJournalSeq = Number(value); }],
    ['--journal-unit-id', (value) => { options.journalUnitId = value; }],
    ['--operation-id', (value) => { options.operationId = value; }],
    ['--phase', (value) => { options.phase = value; }],
    ['--reconciliation-request-seq', (value) => {
      options.reconciliationRequestSeq = Number(value);
    }],
    ['--receipt-key', (value) => { options.receiptKey = value; }],
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
    ['--prepare-run-id', (value) => { options.result.prepareRunId = value; }],
    ['--prepare-input-hash', (value) => { options.result.prepareInputHash = value; }],
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
  if (options.operation.expectedStatus !== 'running') {
    throw new Error('expected_status_must_be_running');
  }
  if (!ISO_TIMESTAMP.test(options.operation.expectedStartedAt)) {
    throw new Error('expected_started_at_invalid');
  }
  assertHash(options.operation.runId, 'operation_run_id');
  assertHash(options.operation.inputHash, 'input_hash');
  if (options.operation.stage === 'summary') {
    options.phase = 'execute';
    options.journalUnitId = options.result.sessionId;
    options.operationId = options.operation.unitId;
    options.result.kind = 'summary_resumable_run';
    assertHash(options.result.serviceInputHash, 'service_input_hash');
    assertHash(options.result.runnerInputHash, 'runner_input_hash');
    assertHash(options.result.generationConfigHash, 'generation_config_hash');
    if (!RESUMABLE_RUN_ID.test(options.result.resumableRunId)) {
      throw new Error('resumable_run_id_invalid');
    }
    if (
      !options.result.sessionId
      || !isSummaryOperationUnit(options.result.sessionId, options.operation.unitId)
    ) {
      throw new Error('summary_operation_identity_invalid');
    }
  } else {
    if (!GENERIC_STAGES.has(options.operation.stage)) throw new Error('stage_invalid');
    const twoPhase = ['memory_consolidate', 'skill_extract'].includes(options.operation.stage);
    if (
      !options.journalUnitId
      || !options.operationId
      || !RECEIPT_KEY.test(options.receiptKey)
      || !Number.isSafeInteger(options.reconciliationRequestSeq)
      || options.reconciliationRequestSeq < 0
      || (twoPhase
        ? !['prepare', 'commit'].includes(options.phase)
        : options.phase !== 'execute')
    ) {
      throw new Error('generic_reconciliation_identity_invalid');
    }
    assertHash(options.result.runnerInputHash, 'runner_input_hash');
    options.result = {
      kind: 'protocol_state',
      phase: options.phase,
      runnerInputHash: options.result.runnerInputHash,
      ...(options.phase === 'commit'
        ? {
            prepareRunId: options.result.prepareRunId,
            prepareInputHash: options.result.prepareInputHash,
          }
        : {}),
    };
    if (options.phase === 'commit') {
      assertHash(options.result.prepareRunId, 'prepare_run_id');
      assertHash(options.result.prepareInputHash, 'prepare_input_hash');
    }
  }
  return options;
}

function validateBlockedUnit(events, options) {
  const twoPhase = ['memory_consolidate', 'skill_extract'].includes(
    options.operation.stage,
  );
  (twoPhase ? validateTwoPhaseStage : validateSinglePhaseStage)(events);
  if (events.at(-1)?.seq !== options.expectedJournalSeq) {
    throw new Error('orphan_reconciliation_journal_drifted');
  }
  const state = foldStageEvents(events);
  const unit = state.units.get(options.journalUnitId);
  const request = unit?.blocked_payload;
  const generic = request?.decision?.action === 'reconcile';
  if (
    !unit
    || unit.input_hash !== options.result.runnerInputHash
    || unit.attempt_id !== options.operation.runId
    || !unit.blocked
    || (
      generic
        ? (
            request.phase !== options.phase
            || request.reconciliation_request_seq !== options.reconciliationRequestSeq
            || request.receipt_key !== options.receiptKey
            || request.receipt_run_id !== options.operation.runId
            || request.receipt_stage !== options.operation.stage
            || request.receipt_unit_id !== options.operation.unitId
            || request.receipt_input_hash !== options.operation.inputHash
            || request.receipt_started_at !== options.operation.expectedStartedAt
          )
        : request?.reason !== 'extraction_operation_reconciliation_required'
    )
    || unit.active_operation?.operation_id !== options.operationId
    || unit.active_operation?.attempt_id !== options.operation.runId
  ) {
    throw new Error('orphan_reconciliation_journal_identity_drifted');
  }
  return { generic };
}

function validateReceiptResult(result, options) {
  if (
    result?.success === false
    && result.failure?.class === 'hard'
    && SAFE_RECONCILIATION_FAILURES.has(result.failure?.cause)
  ) {
    throw new Error(`orphan_reconciliation_rejected:${result.failure.cause}`);
  }
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

export async function reconcileExtractionOrphan(options, dependencies) {
  if (options.operation.stage === 'summary') {
    options = {
      ...options,
      journalUnitId: options.journalUnitId || options.result.sessionId,
      operationId: options.operationId || options.operation.unitId,
      phase: options.phase || 'execute',
      receiptKey: options.receiptKey || '',
      result: {
        kind: 'summary_resumable_run',
        phase: 'execute',
        ...options.result,
      },
    };
  }
  const rootDir = path.join(path.resolve(options.stateDir), `${options.formalRunId}.v2`);
  const journal = dependencies.journal
    || new RunStateJournalV2({ rootDir, runId: options.formalRunId });
  await journal.acquireLock();
  try {
    await journal.open();
    const events = await journal.readStage(options.operation.stage);
    const { generic } = validateBlockedUnit(events, options);
    const receiptResult = await dependencies.reconcileReceipt({
      operation: options.operation,
      result: options.result,
    });
    validateReceiptResult(receiptResult, options);
    const event = await journal.appendStage(
      options.operation.stage,
      'unit_reconciliation_resolved',
      {
      unit_id: options.journalUnitId,
      attempt_id: options.operation.runId,
      operation_id: options.operationId,
      phase: options.phase,
      ...(generic
        ? { reconciliation_request_seq: options.reconciliationRequestSeq }
        : {}),
      reconciliation_id: receiptResult.reconciliation.id,
      receipt_key: options.receiptKey || undefined,
      receipt_run_id: options.operation.runId,
      receipt_stage: options.operation.stage,
      receipt_unit_id: options.operation.unitId,
      receipt_input_hash: options.operation.inputHash,
      receipt_started_at: options.operation.expectedStartedAt,
      receipt_status: receiptResult.receipt.status,
      result_status: receiptResult.reconciliation.resultStatus,
      cause: receiptResult.receipt.failure.cause,
      },
    );
    (['memory_consolidate', 'skill_extract'].includes(options.operation.stage)
      ? validateTwoPhaseStage
      : validateSinglePhaseStage)(
      await journal.readStage(options.operation.stage),
    );
    return {
      success: true,
      replayed: receiptResult.replayed === true,
      runId: options.formalRunId,
      stage: options.operation.stage,
      unitId: options.journalUnitId,
      operationId: options.operationId,
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

export const reconcileSummaryOrphan = reconcileExtractionOrphan;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sdk = registerWorker(options.engineUrl);
  try {
    const report = await reconcileExtractionOrphan(options, {
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
