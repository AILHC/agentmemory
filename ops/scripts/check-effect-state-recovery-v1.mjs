import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');

const nodeTests = [
  'ops/scripts/lib/recovery-policy-v1.test.mjs',
  'ops/scripts/lib/recovery-journal-reducer-v1.test.mjs',
  'ops/scripts/lib/recoverable-stage-v2.test.mjs',
  'ops/scripts/lib/full-extraction-stage-adapters-v2.test.mjs',
  'ops/scripts/lib/summary-recovery-adapter-v1.test.mjs',
  'ops/scripts/lib/lesson-recovery-adapter-v1.test.mjs',
  'ops/scripts/lib/safe-stage-recovery-adapters-v1.test.mjs',
  'ops/scripts/lib/semantic-rollup-recovery-adapter-v1.test.mjs',
  'ops/scripts/lib/crystal-recovery-adapter-v1.test.mjs',
  'ops/scripts/lib/consolidation-procedural-recovery-adapter-v1.test.mjs',
  'ops/scripts/lib/reflect-insight-recovery-adapter-v1.test.mjs',
  'ops/scripts/lib/recovery-status-projection-v1.test.mjs',
  'ops/scripts/lib/recovery-frontier-migration-v1.test.mjs',
  'ops/scripts/lib/v2-release-gate.test.mjs',
  'ops/scripts/lib/effect-state-recovery-release-gate-v2.test.mjs',
  'ops/scripts/run-agentmemory-full-extraction-v2.test.mjs',
];

const domainTests = [
  'test/summarize.test.ts',
  'test/lesson-extraction-recovery.test.ts',
  'test/consolidate.test.ts',
  'test/semantic-rollup.test.ts',
  'test/skill-extract.test.ts',
  'test/crystallize.test.ts',
  'test/consolidation-pipeline.test.ts',
  'test/reflect.test.ts',
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`effect_state_recovery_check_failed:${command}`);
  }
}

export function main() {
  for (const testPath of nodeTests) run(process.execPath, ['--test', testPath]);
  run(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--exclude', 'test/integration.test.ts',
    '--exclude', 'ops/**',
    ...domainTests,
  ]);
  process.stdout.write(
    'effect-state recovery v1 development check passed; real III release proof not evaluated\n',
  );
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) main();
