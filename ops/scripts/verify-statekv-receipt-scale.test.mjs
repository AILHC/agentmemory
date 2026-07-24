import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildReceiptOperations,
  parseArguments,
  scopeFilePath,
} from './verify-statekv-receipt-scale.mjs';

test('StateKV receipt scale plan matches the eight-stage receipt policy', () => {
  const operations = buildReceiptOperations({ runId: 'scale-n1', units: 3 });
  assert.equal(operations.length, 30);
  assert.equal(new Set(operations.map((operation) => operation.key)).size, 30);
  assert.equal(
    operations.filter((operation) => operation.value.stage === 'memory_consolidate').length,
    6,
  );
  assert.equal(
    operations.filter((operation) => operation.value.stage === 'skill_extract').length,
    6,
  );
  assert.equal(
    operations.some((operation) => Object.hasOwn(operation.value.response, 'narrative')),
    false,
  );
});

test('StateKV scope path uses the actual file-backed scope encoding', () => {
  assert.equal(
    path.basename(scopeFilePath('F:\\state', 'bench:v2:receipts:n')),
    'bench%3Av2%3Areceipts%3An.bin',
  );
});

test('StateKV receipt scale CLI requires isolated absolute paths and a fresh scope prefix', () => {
  assert.deepEqual(
    parseArguments([
      '--state-dir', 'F:\\runtime\\state_store.db',
      '--scope-prefix', 'bench:v2:20260724',
      '--units', '25',
      '--operation-delay-ms', '20',
      '--out', 'F:\\runtime\\report.json',
    ]),
    {
      engineUrl: 'ws://127.0.0.1:49234',
      stateDir: 'F:\\runtime\\state_store.db',
      scopePrefix: 'bench:v2:20260724',
      units: 25,
      operationDelayMs: 20,
      out: 'F:\\runtime\\report.json',
    },
  );
  assert.throws(
    () => parseArguments(['--state-dir', 'relative', '--scope-prefix', 'bench']),
    /state_dir_must_be_absolute/,
  );
  assert.throws(
    () => parseArguments(['--state-dir', 'F:\\state', '--scope-prefix', 'bench', '--units', '0']),
    /units_must_be_a_positive_integer/,
  );
});
