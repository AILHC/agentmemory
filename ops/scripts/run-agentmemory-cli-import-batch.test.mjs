import assert from 'node:assert/strict';
import {
  DEFAULT_DOCTOR_OK,
  DEFAULT_DOCTOR_SCRIPT,
  DEFAULT_IMPORT_TIMEOUT_MS,
  buildFinalizeArgs,
  buildImportArgs,
  classifyImportError,
  isTransientServiceText,
  parseArgs,
  parseCommandText,
  shouldImportRecord,
} from './run-agentmemory-cli-import-batch.mjs';

const importArgs = buildImportArgs('cli.mjs', 'C:\\sessions\\one.jsonl');
assert.deepEqual(importArgs, [
  'cli.mjs',
  'import-jsonl',
  'C:\\sessions\\one.jsonl',
  '--max-files',
  '1',
  '--manual-index',
  '--no-lesson-extraction',
  '--timeout-ms',
  String(DEFAULT_IMPORT_TIMEOUT_MS),
]);

const commandText = parseCommandText('cli.mjs', 'C:\\sessions\\one.jsonl', '.env');
assert.match(commandText, /import-jsonl/);
assert.match(commandText, /--max-files 1/);
assert.match(commandText, /--manual-index/);
assert.match(commandText, /--no-lesson-extraction/);
assert.match(commandText, new RegExp(`--timeout-ms ${DEFAULT_IMPORT_TIMEOUT_MS}`));

assert.deepEqual(buildFinalizeArgs('cli.mjs'), ['cli.mjs', 'finalize-replay-index']);

const defaults = parseArgs(['--record', 'record.json', '--agentmemory-cli', 'cli.mjs', '--env-file', '.env']);
assert.equal(defaults.importTimeoutMs, DEFAULT_IMPORT_TIMEOUT_MS);
assert.equal(defaults.doctorScript, DEFAULT_DOCTOR_SCRIPT);
assert.equal(defaults.doctorOk, DEFAULT_DOCTOR_OK);
assert.equal(defaults.forceImport, false);

const custom = parseArgs([
  '--record',
  'record.json',
  '--agentmemory-cli',
  'cli.mjs',
  '--env-file',
  '.env',
  '--import-timeout-ms',
  '7200000',
  '--doctor-script',
  'doctor.ps1',
  '--doctor-ok',
  'diagnosis=OK_CUSTOM',
  '--force-import',
]);
assert.equal(custom.importTimeoutMs, 7200000);
assert.equal(custom.doctorScript, 'doctor.ps1');
assert.equal(custom.doctorOk, 'diagnosis=OK_CUSTOM');
assert.equal(custom.forceImport, true);

assert.equal(shouldImportRecord({ import_cli: { exit_code: 0 } }, false), false);
assert.equal(shouldImportRecord({ import_cli: { exit_code: 0 } }, true), true);
assert.equal(shouldImportRecord({ import_cli: { exit_code: 1 } }, false), true);

assert.equal(
  isTransientServiceText('agentmemory livez probe failed on port 3111: reachable but unhealthy (HTTP 404).'),
  true,
);
assert.equal(isTransientServiceText('x  Invocation stopped'), true);
assert.equal(classifyImportError(1, 'x  Invocation stopped', ''), '服务短暂不可用');
assert.equal(classifyImportError(1, 'agentmemory livez probe failed on port 3111: reachable but unhealthy (HTTP 404).', ''), '服务短暂不可用');
assert.equal(classifyImportError(1, 'set AGENTMEMORY_SECRET', ''), '服务鉴权失败');
