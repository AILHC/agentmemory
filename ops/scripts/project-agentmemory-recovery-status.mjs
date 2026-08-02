import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectIncrementalExtractionStatus } from './lib/incremental-extraction-status-v1.mjs';
import { openIiiStateReadOnlyWorkingCopy } from './lib/iii-state-read-only-adapter-v1.mjs';
import { verifyOfflineStateKvSnapshot } from './lib/offline-statekv-snapshot-v1.mjs';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';
import { projectSafeRecoveryStatus } from './lib/recovery-status-projection-v1.mjs';

const STAGES = [
  'summary',
  'lessons',
  'memory_consolidate',
  'semantic_rollup',
  'skill_extract',
  'crystal',
  'consolidation_procedural',
  'reflect_insight',
];

function parseArgs(argv) {
  const options = {
    requiredStages: [],
    contractsPath: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'extraction-model-contracts-v1.json',
    ),
    memoryCharBudget: 64_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runtime-root') options.runtimeRoot = argv[++index];
    else if (argument === '--run-id') options.runId = argv[++index];
    else if (argument === '--required-stages') {
      options.requiredStages = String(argv[++index] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (argument === '--evidence-snapshot') {
      options.evidenceSnapshot = argv[++index];
    } else if (argument === '--contracts') {
      options.contractsPath = argv[++index];
    } else if (argument === '--project') {
      options.project = argv[++index];
    } else if (argument === '--memory-char-budget') {
      options.memoryCharBudget = Number(argv[++index]);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.runtimeRoot || !path.isAbsolute(options.runtimeRoot)) {
    throw new Error('--runtime-root must be absolute');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.runId || '')) {
    throw new Error('--run-id is invalid');
  }
  for (const [flag, value] of [
    ['--evidence-snapshot', options.evidenceSnapshot],
    ['--contracts', options.contractsPath],
  ]) {
    if (value !== undefined && !path.isAbsolute(value)) {
      throw new Error(`${flag} must be absolute`);
    }
  }
  if (!Number.isSafeInteger(options.memoryCharBudget) || options.memoryCharBudget < 1) {
    throw new Error('--memory-char-budget is invalid');
  }
  return options;
}

async function readJson(filePath, code) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(code, { cause: error });
  }
}

async function readIncrementalStatus({
  evidenceSnapshot,
  contractsPath,
  runId,
  project,
  stageEvents,
  memoryCharBudget,
}) {
  if (!evidenceSnapshot) return null;
  const snapshot = await verifyOfflineStateKvSnapshot({
    snapshotDir: evidenceSnapshot,
  });
  if (snapshot.expected_journal?.run_id !== runId) {
    throw new Error('incremental_status_snapshot_run_mismatch');
  }
  const contracts = await readJson(contractsPath, 'incremental_status_contracts_unreadable');
  const view = await openIiiStateReadOnlyWorkingCopy({
    snapshot,
    snapshotDir: evidenceSnapshot,
    stateDir: path.join(evidenceSnapshot, 'state'),
    enginePath: path.join(evidenceSnapshot, 'engine.bin'),
  });
  try {
    return await collectIncrementalExtractionStatus({
      kv: view,
      contracts,
      runId,
      project,
      stageEvents,
      snapshotHash: snapshot.snapshot_hash,
      memoryCharBudget,
    });
  } finally {
    await view.close();
  }
}

export async function readRecoveryStatus({
  runtimeRoot,
  runId,
  requiredStages = [],
  evidenceSnapshot,
  contractsPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'extraction-model-contracts-v1.json',
  ),
  project,
  memoryCharBudget = 64_000,
}) {
  const runRoot = path.resolve(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  const expectedParent = path.resolve(runtimeRoot, 'extraction-runs');
  if (!runRoot.startsWith(`${expectedParent}${path.sep}`)) {
    throw new Error('run root must stay under extraction-runs');
  }
  const journal = new RunStateJournalV2({ rootDir: runRoot, runId });
  const controlEvents = await journal.readControl();
  const started = controlEvents.find((event) => event.type === 'run_started');
  if (!started || started.payload?.run_id !== runId) {
    throw new Error('v2 control journal run_id does not match requested run');
  }
  const stageEvents = {};
  for (const stage of STAGES) {
    const stagePath = journal.stagePath(stage);
    const exists = await fs.access(stagePath).then(
      () => true,
      (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
    );
    if (exists) stageEvents[stage] = await journal.readStage(stage);
  }
  const incrementalStatus = await readIncrementalStatus({
    evidenceSnapshot,
    contractsPath,
    runId,
    project,
    stageEvents,
    memoryCharBudget,
  });
  return projectSafeRecoveryStatus({
    runId,
    controlEvents,
    stageEvents,
    requiredStages,
    incrementalStatus,
  });
}

async function main(argv = process.argv.slice(2)) {
  const status = await readRecoveryStatus(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
