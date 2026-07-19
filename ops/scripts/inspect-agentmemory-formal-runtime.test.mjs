import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectStateDirectory,
  parseArgs,
  validateOutputPath,
} from './inspect-agentmemory-formal-runtime.mjs';

const scriptPath = fileURLToPath(
  new URL('./inspect-agentmemory-formal-runtime.mjs', import.meta.url)
);

function encodeScope(scope) {
  return `${[...Buffer.from(scope, 'utf8')]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return /[A-Za-z0-9_.-]/.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('')}.bin`;
}

async function writeScope(directory, scope, content = 'fixture') {
  await fs.writeFile(path.join(directory, encodeScope(scope)), content);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('解析绝对状态目录和 expected-empty 参数', () => {
  const stateDir = path.resolve('temporary-state-store.db');
  const options = parseArgs(['--state-dir', stateDir, '--expected-empty']);

  assert.equal(options.stateDir, stateDir);
  assert.equal(options.expectedEmpty, true);
});

test('拒绝相对 out 路径', () => {
  const stateDir = path.resolve('temporary-state-store.db');

  assert.throws(
    () => parseArgs(['--state-dir', stateDir, '--out', 'relative-report.json']),
    /--out 必须是绝对路径/
  );
});

test('输出路径守卫拒绝 session-source 且不写入文件', async () => {
  const fileName = `agentmemory-inspect-guard-${process.pid}-${Date.now()}.json`;
  const outPath = path.win32.join('F:\\ai-runtime\\session-source', fileName);
  const stateDir = path.resolve('temporary-state-store.db');

  await assert.rejects(fs.access(outPath));
  await assert.rejects(validateOutputPath(outPath, stateDir), /session-source/);
  await assert.rejects(fs.access(outPath));
});

test('CLI 拒绝把 out 写入 session-source', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-out-source-'));
  const fileName = `agentmemory-inspect-cli-guard-${process.pid}-${Date.now()}.json`;
  const outPath = path.win32.join('F:\\ai-runtime\\session-source', fileName);
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));

  await assert.rejects(fs.access(outPath));
  const result = await runCli(['--state-dir', stateDir, '--out', outPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /session-source/);
  await assert.rejects(fs.access(outPath));
});

test('CLI 拒绝通过目录联接把 out 写入 session-source', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-out-junction-'));
  const stateDir = path.join(root, 'state_store.db');
  const junctionPath = path.join(root, 'source-link');
  const fileName = `agentmemory-inspect-junction-guard-${process.pid}-${Date.now()}.json`;
  const sourceOutPath = path.win32.join('F:\\ai-runtime\\session-source', fileName);
  const aliasOutPath = path.join(junctionPath, fileName);
  await fs.mkdir(stateDir);
  await fs.symlink('F:\\ai-runtime\\session-source', junctionPath, 'junction');
  context.after(async () => {
    await fs.unlink(junctionPath).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(fs.access(sourceOutPath));
  const result = await runCli(['--state-dir', stateDir, '--out', aliasOutPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /符号链接|目录联接|session-source/);
  await assert.rejects(fs.access(sourceOutPath));
});

test('CLI 仍拒绝把 out 写入 state-dir', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-out-state-'));
  const outPath = path.join(stateDir, 'report.json');
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));

  const result = await runCli(['--state-dir', stateDir, '--out', outPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /StateKV 目录内/);
  await assert.rejects(fs.access(outPath));
});

test('空状态目录返回所有受管计数为零', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-empty-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));

  const result = await inspectStateDirectory(stateDir, { expectedEmpty: true });

  assert.equal(result.exists, true);
  assert.equal(result.totals.fileCount, 0);
  assert.equal(result.managedDataPresent, false);
  assert.equal(result.expectedEmpty.satisfied, true);
  for (const category of Object.values(result.counts)) {
    assert.equal(category.count, 0);
    assert.equal(category.exact, true);
  }
  assert.equal(
    result.warnings.some((warning) => warning.code === 'scope_file_missing'),
    true
  );
});

test('仅按 StateKV 键文件名统计产物桶和 BM25 chunk', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-data-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));

  await Promise.all([
    writeScope(stateDir, 'mem:sessions', 'abc'),
    writeScope(stateDir, 'mem:obs:session-a', '12345'),
    writeScope(stateDir, 'mem:obs:session-b', '1234567'),
    writeScope(stateDir, 'mem:summaries'),
    writeScope(stateDir, 'mem:lessons'),
    writeScope(stateDir, 'mem:semantic'),
    writeScope(stateDir, 'mem:procedural'),
    writeScope(stateDir, 'mem:crystals'),
    writeScope(stateDir, 'mem:insights'),
    writeScope(stateDir, 'mem:index:bm25'),
    writeScope(stateDir, 'mem:index:bm25:bm25:idx_1:00000'),
    writeScope(stateDir, 'mem:index:bm25:bm25:idx_1:00001'),
    writeScope(stateDir, 'unmanaged:scope'),
  ]);

  const result = await inspectStateDirectory(stateDir);

  assert.equal(result.totals.fileCount, 13);
  assert.equal(result.totals.byteCount, 85);
  assert.equal(result.totals.stateKeyFileCount, 13);
  assert.equal(result.totals.managedFileCount, 12);
  assert.equal(result.totals.managedBytes, 78);
  assert.equal(result.counts.sessions.count, null);
  assert.equal(result.counts.sessions.exact, false);
  assert.equal(result.counts.sessions.scopeFileCount, 1);
  assert.equal(result.counts.observationBuckets.count, 2);
  assert.equal(result.counts.observationBuckets.exact, true);
  assert.equal(result.counts.summaries.count, null);
  assert.equal(result.counts.lessons.count, null);
  assert.equal(result.counts.semantic.count, null);
  assert.equal(result.counts.procedural.count, null);
  assert.equal(result.counts.crystals.count, null);
  assert.equal(result.counts.insights.count, null);
  assert.equal(result.counts.bm25Chunks.count, 2);
  assert.equal(result.counts.bm25Chunks.exact, true);
  assert.equal(result.managedDataPresent, true);
  assert.deepEqual(
    result.managedKeys.filter((key) => key.startsWith('mem:obs:')),
    ['mem:obs:session-a', 'mem:obs:session-b']
  );
  assert.equal(
    result.warnings.some((warning) => warning.code === 'item_count_unavailable'),
    true
  );
});

test('expected-empty 在发现受管状态时返回非零并保留安全 JSON 摘要', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-nonempty-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await writeScope(stateDir, 'mem:obs:session-safe', 'observation-body-is-not-read');

  const result = await runCli(['--state-dir', stateDir, '--expected-empty']);
  const report = JSON.parse(result.stdout);

  assert.notEqual(result.code, 0);
  assert.equal(report.expectedEmpty.satisfied, false);
  assert.equal(report.counts.observationBuckets.count, 1);
  assert.equal(result.stdout.includes('observation-body-is-not-read'), false);
  assert.match(result.stderr, /expected-empty/);
});

test('expected-empty 不忽略未细分类的 mem 前缀状态', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-managed-prefix-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await writeScope(stateDir, 'mem:graph:nodes', 'graph-value-is-not-read');

  const result = await runCli(['--state-dir', stateDir, '--expected-empty']);
  const report = JSON.parse(result.stdout);

  assert.notEqual(result.code, 0);
  assert.equal(report.totals.managedFileCount, 1);
  assert.equal(report.totals.unclassifiedManagedFileCount, 1);
  assert.equal(
    report.warnings.some((warning) => warning.code === 'unclassified_managed_keys'),
    true
  );
  assert.equal(result.stdout.includes('graph-value-is-not-read'), false);
});

test('expected-empty 保守拒绝 StateKV 临时键文件', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-temporary-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(stateDir, `${encodeScope('mem:sessions')}.tmp`), 'temporary-value');

  const result = await runCli(['--state-dir', stateDir, '--expected-empty']);
  const report = JSON.parse(result.stdout);

  assert.notEqual(result.code, 0);
  assert.equal(report.totals.temporaryStateKeyFileCount, 1);
  assert.equal(report.managedDataPresent, true);
  assert.equal(report.counts.sessions.count, null);
  assert.equal(report.counts.sessions.exact, false);
  assert.equal(report.counts.sessions.knownCount, 0);
  assert.equal(
    report.warnings.some((warning) => warning.code === 'temporary_state_key_files'),
    true
  );
  assert.equal(result.stdout.includes('temporary-value'), false);
});

test('expected-empty 在键文件名无法确定时不伪造空状态', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-invalid-key-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(stateDir, 'mem%ZZsessions.bin'), 'unknown-value');

  const result = await runCli(['--state-dir', stateDir, '--expected-empty']);
  const report = JSON.parse(result.stdout);

  assert.notEqual(result.code, 0);
  assert.equal(report.totals.indeterminateKeyFileCount, 1);
  assert.equal(report.expectedEmpty.satisfied, false);
  assert.equal(report.counts.sessions.count, null);
  assert.equal(report.counts.sessions.exact, false);
  assert.equal(report.counts.sessions.knownCount, 0);
  assert.equal(
    report.warnings.some((warning) => warning.code === 'invalid_state_key_file_names'),
    true
  );
  assert.equal(result.stdout.includes('unknown-value'), false);
});

test('缺失目录在 expected-empty 模式下成功并报告 warning', async () => {
  const stateDir = path.join(os.tmpdir(), `am-inspect-missing-${process.pid}-${Date.now()}`);

  const result = await runCli(['--state-dir', stateDir, '--expected-empty']);
  const report = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(report.exists, false);
  assert.equal(report.expectedEmpty.satisfied, true);
  assert.equal(
    report.warnings.some((warning) => warning.code === 'state_dir_missing'),
    true
  );
});

test('报告不输出 env、token 或 JSONL 正文', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-sensitive-'));
  context.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(stateDir, '.env'), 'PROVIDER_TOKEN=secret-env-marker');
  await fs.writeFile(path.join(stateDir, 'session.jsonl'), 'secret-jsonl-marker');

  const result = await runCli(['--state-dir', stateDir, '--expected-empty']);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes('secret-env-marker'), false);
  assert.equal(result.stdout.includes('secret-jsonl-marker'), false);
  assert.equal(result.stderr.includes('secret-env-marker'), false);
  assert.equal(result.stderr.includes('secret-jsonl-marker'), false);
});

test('缺失目录在普通盘点模式下返回非零', async () => {
  const stateDir = path.join(os.tmpdir(), `am-inspect-required-${process.pid}-${Date.now()}`);

  const result = await runCli(['--state-dir', stateDir]);
  const report = JSON.parse(result.stdout);

  assert.notEqual(result.code, 0);
  assert.equal(report.exists, false);
  assert.match(result.stderr, /目标 StateKV 目录不存在/);
});

test('out 参数写入 JSON 且不向 stdout 重复输出完整报告', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'am-inspect-out-'));
  const stateDir = path.join(root, 'state_store.db');
  const outPath = path.join(root, 'report.json');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(stateDir);

  const result = await runCli(['--state-dir', stateDir, '--out', outPath]);
  const report = JSON.parse(await fs.readFile(outPath, 'utf8'));

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '');
  assert.equal(report.stateDir, stateDir);
  assert.match(result.stderr, /盘点完成/);
});

test('拒绝 session-source 根及其子路径', async () => {
  const forbiddenPath = 'F:\\ai-runtime\\session-source\\private-state';
  const result = await runCli(['--state-dir', forbiddenPath]);

  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /session-source/);
});
