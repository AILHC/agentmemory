import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const options = { requiredStages: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runtime-root') options.runtimeRoot = argv[++index];
    else if (argument === '--run-id') options.runId = argv[++index];
    else if (argument === '--required-stages') {
      options.requiredStages = String(argv[++index] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.runtimeRoot || !path.isAbsolute(options.runtimeRoot)) {
    throw new Error('--runtime-root must be absolute');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.runId || '')) {
    throw new Error('--run-id is invalid');
  }
  return options;
}

export async function readRecoveryStatus({ runtimeRoot, runId, requiredStages = [] }) {
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
  return projectSafeRecoveryStatus({
    runId,
    controlEvents,
    stageEvents,
    requiredStages,
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
