import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertEffectStateRecoveryReleaseInputs,
  assertEvidenceExecutionResult,
} from './lib/effect-state-recovery-release-gate-v2.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const proofPath = path.join(
  root,
  'ops',
  'effect-state-recovery-release-proof-v2.json',
);

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('effect_state_recovery_release_obligation_failed');
  }
  return result;
}

async function runEvidence(entry, enginePath, reportDir, index) {
  if (entry.runner === 'node' || entry.runner === 'node-subprocess') {
    const result = run(
      process.execPath,
      ['--test', '--test-reporter=tap', entry.testPath],
      process.env,
    );
    assertEvidenceExecutionResult({
      runner: entry.runner,
      expectedTestTitles: entry.expectedTestTitles,
      nodeTapOutput: result.stdout,
    });
    return;
  }
  const env = entry.runner === 'vitest-real-iii'
    ? {
        ...process.env,
        AGENTMEMORY_TEST_III_BIN: enginePath,
        AGENTMEMORY_REQUIRE_REAL_III: '1',
      }
    : process.env;
  const reportPath = path.join(reportDir, `vitest-${index}.json`);
  run(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      entry.testPath,
      '--reporter=json',
      '--outputFile',
      reportPath,
    ],
    env,
  );
  let vitestReport;
  try {
    vitestReport = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
  } catch {
    throw new Error('effect_state_recovery_release_gate_evidence_result_invalid');
  }
  assertEvidenceExecutionResult({
    runner: entry.runner,
    expectedTestTitles: entry.expectedTestTitles,
    vitestReport,
  });
}

export async function main() {
  const enginePath = process.env.AGENTMEMORY_TEST_III_BIN
    ? path.resolve(process.env.AGENTMEMORY_TEST_III_BIN)
    : '';
  const { testEntries } = await assertEffectStateRecoveryReleaseInputs({
    enginePath,
    proofPath,
    repositoryRoot: root,
  });

  const reportDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'effect-recovery-release-report-'),
  );
  try {
    for (const [index, entry] of testEntries.entries()) {
      await runEvidence(entry, enginePath, reportDir, index);
    }
    process.stdout.write(
      'effect-state recovery v2 risk-obligation release proof passed\n',
    );
  } finally {
    await fsp.rm(reportDir, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
