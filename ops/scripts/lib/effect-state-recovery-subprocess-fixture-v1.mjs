import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runSinglePhaseStage,
  runTwoPhaseStage,
  validateSinglePhaseStage,
  validateTwoPhaseStage,
} from './recoverable-stage-v2.mjs';
import { RunStateJournalV2 } from './run-state-journal-v2.mjs';

export const SUBPROCESS_INTEGRATION_FAMILIES = Object.freeze({
  summary_custom: Object.freeze({ mode: 'single', stage: 'summary' }),
  lessons_custom: Object.freeze({ mode: 'single', stage: 'lessons' }),
  two_phase_prepare_commit: Object.freeze({
    mode: 'two_phase',
    stage: 'memory_consolidate',
  }),
  two_phase_prepare_commit_skill_extract: Object.freeze({
    mode: 'two_phase',
    stage: 'skill_extract',
  }),
  generic_single: Object.freeze({ mode: 'single', stage: 'semantic_rollup' }),
  generic_single_crystal: Object.freeze({
    mode: 'single',
    stage: 'crystal',
  }),
  generic_single_consolidation_procedural: Object.freeze({
    mode: 'single',
    stage: 'consolidation_procedural',
  }),
  generic_single_reflect_insight: Object.freeze({
    mode: 'single',
    stage: 'reflect_insight',
  }),
});

const CRASH_EXIT_CODE = 86;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`unexpected_argument:${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing_argument_value:${name}`);
    }
    values.set(name.slice(2), value);
    index += 1;
  }
  const stateDir = values.get('state-dir');
  const family = values.get('family');
  if (!stateDir) throw new Error('state_dir_required');
  if (!SUBPROCESS_INTEGRATION_FAMILIES[family]) {
    throw new Error(`unknown_integration_family:${family}`);
  }
  return {
    stateDir: path.resolve(stateDir),
    family,
    crashBoundary: values.get('crash-boundary') || null,
  };
}

async function readLedger(ledgerPath) {
  try {
    return JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { effects: {}, records: {} };
    throw error;
  }
}

async function writeLedger(ledgerPath, ledger) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const temporaryPath = `${ledgerPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const handle = await fs.open(temporaryPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, ledgerPath);
}

async function applyEffectOnce({ ledgerPath, family, operationId }) {
  const ledger = await readLedger(ledgerPath);
  const effectKey = `${family}:${operationId}`;
  if (!ledger.effects[effectKey]) {
    ledger.effects[effectKey] = {
      effect_count: 1,
      result_id: `result-${family}`,
    };
    await writeLedger(ledgerPath, ledger);
  }
  return {
    status: 'succeeded',
    payload: { result_ids: [ledger.effects[effectKey].result_id] },
  };
}

async function recordOnce({ ledgerPath, family }) {
  const ledger = await readLedger(ledgerPath);
  const recordKey = `${family}:record`;
  if (!ledger.records[recordKey]) {
    ledger.records[recordKey] = { record_count: 1 };
    await writeLedger(ledgerPath, ledger);
  }
}

function committedCandidate(family) {
  const receiptKey = `receipt-${family}`;
  const resultRef = `results:${family}`;
  const effectHash = hash(`${family}:formal-effect`);
  return {
    candidateEvidence: {
      kind: 'committed',
      receiptKey,
      receiptVersion: 1,
      resultRef,
      effectHash,
    },
    snapshot: {
      receipt: {
        key: receiptKey,
        version: 1,
        resultRef,
        effectHash,
        status: 'succeeded',
      },
    },
    effectVerification: 'all_applied',
  };
}

function makeCommittedAdapter({ family, ledgerPath, operationId }) {
  return async ({
    activeOperation,
    completedOperations,
    startOperation,
    completeOperation,
    resolveOutcome,
  }) => {
    const completedOperation = completedOperations.at(-1);
    let resolvedOperationId = completedOperation?.terminal_result
      ? completedOperation.operation_id
      : null;
    let terminalResult = completedOperation?.terminal_result || null;

    if (!terminalResult) {
      const operation = activeOperation || await startOperation({ operationId });
      resolvedOperationId = operation.operation_id;
      terminalResult = await applyEffectOnce({
        ledgerPath,
        family,
        operationId: resolvedOperationId,
      });
      await completeOperation({
        operationId: resolvedOperationId,
        status: terminalResult.status,
        terminal_result: terminalResult,
      });
    }

    const recovery = await resolveOutcome({
      operationId: resolvedOperationId,
      verification: true,
      ...committedCandidate(family),
    });
    return { ...terminalResult, recovery };
  };
}

function countEventTypes(events) {
  const counts = new Map();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
  }
  return counts;
}

function summarizeLedger(ledger) {
  return {
    effect_count: Object.values(ledger.effects || {})
      .reduce((total, entry) => total + entry.effect_count, 0),
    record_count: Object.values(ledger.records || {})
      .reduce((total, entry) => total + entry.record_count, 0),
  };
}

async function runFixture({ stateDir, family, crashBoundary }) {
  const integration = SUBPROCESS_INTEGRATION_FAMILIES[family];
  const unitId = `${family}-unit`;
  const ledgerPath = path.join(stateDir, 'business-ledger.json');
  const journal = new RunStateJournalV2({
    rootDir: path.join(stateDir, 'journal'),
    runId: `subprocess-${family}`,
  });

  await journal.acquireLock({
    takeover: async ({ owner }) => owner.run_id === `subprocess-${family}`,
  });
  try {
    await journal.open();
    const initialEvents = await journal.readStage(integration.stage);
    const occurrences = countEventTypes(initialEvents);
    const append = async (type, payload) => {
      const event = await journal.appendStage(integration.stage, type, payload);
      const occurrence = (occurrences.get(type) || 0) + 1;
      occurrences.set(type, occurrence);
      if (crashBoundary === `${type}#${occurrence}`) {
        process.exit(CRASH_EXIT_CODE);
      }
      return event;
    };
    const adapter = makeCommittedAdapter({
      family,
      ledgerPath,
      operationId: `${unitId}:effect`,
    });
    const common = {
      events: initialEvents,
      plan: [{ unit_id: unitId, input_hash: hash(`${family}:input`) }],
      planMetadata: { integration_family: family },
      append,
      record: async () => recordOnce({ ledgerPath, family }),
      verifyRecoveredTerminal: async () => ({
        recoveryCandidate: committedCandidate(family),
      }),
      stage: integration.stage,
    };

    const result = integration.mode === 'single'
      ? await runSinglePhaseStage({
          ...common,
          attemptIdForUnit: () => `${family}-attempt`,
          execute: adapter,
        })
      : await runTwoPhaseStage({
          ...common,
          recoverPrepare: true,
          recoverCommit: true,
          prepareAttemptIdForUnit: () => `${family}-prepare`,
          commitAttemptIdForUnit: () => `${family}-commit`,
          prepare: async () => ({
            status: 'prepared',
            prepared: {
              prepared_handle: `handle-${family}`,
              proposal_hash: hash(`${family}:proposal`),
              prepare_input_hash: hash(`${family}:prepare-input`),
            },
          }),
          commit: adapter,
        });

    const events = await journal.readStage(integration.stage);
    const state = integration.mode === 'single'
      ? validateSinglePhaseStage(events)
      : validateTwoPhaseStage(events);
    const unit = state.units.get(unitId);
    const ledger = await readLedger(ledgerPath);
    return {
      family,
      mode: integration.mode,
      stage: integration.stage,
      status: result.status,
      accepted_count: result.acceptedCount || 0,
      ...summarizeLedger(ledger),
      terminal: unit?.terminal || null,
      recorded: unit?.recorded === true,
      event_types: events.map((event) => event.type),
    };
  } finally {
    await journal.releaseLock();
  }
}

async function main() {
  const result = await runFixture(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
