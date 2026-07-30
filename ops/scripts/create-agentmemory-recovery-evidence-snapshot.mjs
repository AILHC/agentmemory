import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOfflineStateKvSnapshot,
} from './lib/offline-statekv-snapshot-v1.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--state-dir') options.stateDir = argv[++index];
    else if (argument === '--journal') options.journalPath = argv[++index];
    else if (argument === '--engine') options.enginePath = argv[++index];
    else if (argument === '--destination') options.destinationDir = argv[++index];
    else if (argument === '--run-id') options.runId = argv[++index];
    else if (argument === '--stage') options.stage = argv[++index];
    else if (argument === '--journal-seq') options.journalSeq = Number(argv[++index]);
    else if (argument === '--input-summary-hash') {
      options.inputSummaryHash = argv[++index];
    } else if (argument === '--captured-at') options.capturedAt = argv[++index];
    else if (argument === '--confirm-old-runner-stopped') {
      options.oldRunnerStopped = true;
    } else if (argument === '--confirm-all-state-writers-stopped') {
      options.allStateWritersStopped = true;
    } else if (argument === '--confirm-journal-writers-stopped') {
      options.journalWritersStopped = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  for (const [flag, value] of [
    ['--state-dir', options.stateDir],
    ['--journal', options.journalPath],
    ['--engine', options.enginePath],
    ['--destination', options.destinationDir],
  ]) {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`${flag} must be an absolute path`);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.runId || '')) {
    throw new Error('--run-id is invalid');
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.stage || '')) {
    throw new Error('--stage is invalid');
  }
  if (!Number.isSafeInteger(options.journalSeq) || options.journalSeq < -1) {
    throw new Error('--journal-seq is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(options.inputSummaryHash || '')) {
    throw new Error('--input-summary-hash is invalid');
  }
  if (
    options.oldRunnerStopped !== true
    || options.allStateWritersStopped !== true
    || options.journalWritersStopped !== true
  ) {
    throw new Error('snapshot_all_writers_stopped_confirmation_required');
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = await createOfflineStateKvSnapshot({
    stateDir: options.stateDir,
    journalPath: options.journalPath,
    enginePath: options.enginePath,
    destinationDir: options.destinationDir,
    ...(options.capturedAt ? { capturedAt: options.capturedAt } : {}),
    expectedJournal: {
      run_id: options.runId,
      stage: options.stage,
      journal_seq: options.journalSeq,
      input_summary_hash: options.inputSummaryHash,
    },
  });
  process.stdout.write(`${JSON.stringify({
    schema: manifest.schema,
    snapshot_hash: manifest.snapshot_hash,
    state_tree_hash: manifest.state_tree_hash,
    engine_hash: manifest.engine.sha256,
    state_file_count: manifest.state_files.length,
  })}\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
