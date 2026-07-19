import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./select-session-import-batch.mjs', import.meta.url));

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-selector-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'vault', 'local'), { recursive: true });
  await fs.writeFile(path.join(root, 'manifest.jsonl'), '', 'utf8');
  await fs.writeFile(path.join(root, 'remote-manifest.jsonl'), '', 'utf8');
  return root;
}

function manifestRecord({ tool = 'codex', fileName, hash }) {
  return {
    source_tool: tool,
    source_name: 'default',
    node_name: 'local',
    relative_source_path: `sessions/${fileName}`,
    vault_relpath: `vault/local/${fileName}`,
    raw_hash: hash,
  };
}

async function writeManifest(root, records) {
  const contents = records.map((record) => JSON.stringify(record)).join('\n');
  await fs.writeFile(path.join(root, 'manifest.jsonl'), `${contents}\n`, 'utf8');
}

async function writeRemoteManifest(root, records) {
  const contents = records.map((record) => JSON.stringify(record)).join('\n');
  await fs.writeFile(path.join(root, 'remote-manifest.jsonl'), `${contents}\n`, 'utf8');
}

async function writeSession(root, fileName, lines) {
  const contents = lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n');
  await fs.writeFile(path.join(root, 'vault', 'local', fileName), `${contents}\n`, 'utf8');
}

async function runSelector(root, args = []) {
  const outputPath = path.join(root, `selection-${Math.random().toString(16).slice(2)}.json`);
  const result = await execFileAsync(process.execPath, [
    scriptPath,
    '--state-dir', root,
    '--out', outputPath,
    ...args,
  ]);
  const rawOutput = await fs.readFile(outputPath, 'utf8');
  return { ...result, rawOutput, output: JSON.parse(rawOutput) };
}

async function writeSelectorRecord(root, records) {
  const recordPath = path.join(root, `child-record-${Math.random().toString(16).slice(2)}.json`);
  await fs.writeFile(recordPath, JSON.stringify({ records }), 'utf8');
  return recordPath;
}

test('parent 模式从 child record 识别直接与 meta parent，匹配两份 manifest 并按时间排序', async (t) => {
  const root = await createFixture(t);
  const childFiles = [
    ['child-direct.jsonl', [
      { type: 'event_msg', payload: { message: 'child-direct-body-secret' } },
      { type: 'session_meta', payload: { parent_thread_id: 'parent-direct-id-secret' } },
    ]],
    ['child-meta.jsonl', [
      '{invalid-json',
      { type: 'session_meta', payload: { meta: { parent_thread_id: 'parent-meta-id-secret' } } },
    ]],
    ['child-duplicate.jsonl', [
      { type: 'session_meta', payload: { parent_thread_id: 'parent-direct-id-secret' } },
    ]],
    ['child-unmatched.jsonl', [
      { type: 'session_meta', payload: { parent_thread_id: 'parent-unmatched-id-secret' } },
    ]],
    ['child-without-parent.jsonl', [
      { type: 'session_meta', payload: { id: 'child-session-id-secret' } },
      { type: 'event_msg', payload: { message: 'child-without-parent-body-secret' } },
    ]],
  ];
  for (const [fileName, lines] of childFiles) {
    await writeSession(root, fileName, lines);
  }

  const newerParent = 'rollout-2026-04-03T10-00-00-parent-direct.jsonl';
  const olderParent = 'rollout-2026-04-01T10-00-00-parent-meta.jsonl';
  const unrelated = 'rollout-2026-04-02T10-00-00-unrelated.jsonl';
  await writeManifest(root, [
    manifestRecord({ fileName: newerParent, hash: 'hash-parent-direct' }),
    manifestRecord({ fileName: unrelated, hash: 'hash-unrelated' }),
  ]);
  await writeRemoteManifest(root, [
    manifestRecord({ fileName: olderParent, hash: 'hash-parent-meta' }),
  ]);
  await writeSession(root, newerParent, [
    { type: 'event_msg', payload: { message: 'parent-direct-body-secret' } },
    { type: 'session_meta', payload: { id: 'parent-direct-id-secret' } },
  ]);
  await writeSession(root, olderParent, [
    { type: 'session_meta', payload: { meta: { id: 'parent-meta-id-secret' }, message: 'parent-meta-body-secret' } },
  ]);
  await writeSession(root, unrelated, [
    { type: 'session_meta', payload: { id: 'unrelated-session-id-secret', message: 'unrelated-body-secret' } },
  ]);

  const childRecordPath = await writeSelectorRecord(root, childFiles.map(([fileName], index) => ({
    source_tool: 'codex',
    raw_hash: `child-hash-${index}`,
    absolute_path: path.join(root, 'vault', 'local', fileName),
  })));
  const { output, rawOutput } = await runSelector(root, [
    '--codex-parents-from', childRecordPath,
    '--codex', '0',
    '--claude-code', '0',
    '--codex-child', '0',
  ]);

  assert.equal(output.selection.mode, 'codex_parents');
  assert.deepEqual(output.records.map((record) => record.raw_hash), [
    'hash-parent-meta',
    'hash-parent-direct',
  ]);
  assert.deepEqual(output.selection.codex_parents, {
    enabled: true,
    requested: 5,
    identified: 4,
    unique_parents: 3,
    matched: 2,
    matched_source_records: 2,
    selected: 2,
    unmatched: 1,
    duplicate_parent_references: 1,
    child_without_parent: 1,
    duplicate_raw_hash_records: 0,
    excluded_raw_hash_records: 0,
  });
  assert.deepEqual(output.warnings.filter((warning) => warning.type.startsWith('codex_parent_')), [
    { type: 'codex_parent_duplicate_references', count: 1 },
    { type: 'codex_parent_child_without_parent', count: 1 },
    { type: 'codex_parent_unmatched', count: 1 },
  ]);
  for (const forbidden of [
    'parent-direct-id-secret',
    'parent-meta-id-secret',
    'parent-unmatched-id-secret',
    'child-session-id-secret',
    'unrelated-session-id-secret',
    'child-direct-body-secret',
    'child-without-parent-body-secret',
    'parent-direct-body-secret',
    'parent-meta-body-secret',
    'unrelated-body-secret',
  ]) {
    assert.equal(rawOutput.includes(forbidden), false, `输出泄漏了 ${forbidden}`);
  }
});

test('parent 模式从非 session_meta 行提取 child 的直接与 meta parent 且不泄漏内容', async (t) => {
  const root = await createFixture(t);
  const directChild = 'child-parent-in-event.jsonl';
  const metaChild = 'child-parent-in-response.jsonl';
  const directParent = 'rollout-2026-04-04T10-00-00-parent-event.jsonl';
  const metaParent = 'rollout-2026-04-05T10-00-00-parent-response.jsonl';
  await writeSession(root, directChild, [
    {
      type: 'event_msg',
      payload: {
        parent_thread_id: 'parent-event-line-id-secret',
        message: 'child-event-line-body-secret',
      },
    },
  ]);
  await writeSession(root, metaChild, [
    {
      type: 'response_item',
      payload: {
        meta: { parent_thread_id: 'parent-response-line-id-secret' },
        message: 'child-response-line-body-secret',
      },
    },
  ]);
  await writeSession(root, directParent, [
    {
      type: 'session_meta',
      payload: { id: 'parent-event-line-id-secret', message: 'parent-event-line-body-secret' },
    },
  ]);
  await writeSession(root, metaParent, [
    {
      type: 'session_meta',
      payload: { meta: { id: 'parent-response-line-id-secret' }, message: 'parent-response-line-body-secret' },
    },
  ]);
  await writeManifest(root, [
    manifestRecord({ fileName: directParent, hash: 'hash-parent-event-line' }),
    manifestRecord({ fileName: metaParent, hash: 'hash-parent-response-line' }),
  ]);

  const childRecordPath = await writeSelectorRecord(root, [directChild, metaChild].map((fileName, index) => ({
    source_tool: 'codex',
    raw_hash: `child-non-meta-hash-${index}`,
    absolute_path: path.join(root, 'vault', 'local', fileName),
  })));
  const { output, rawOutput } = await runSelector(root, [
    '--codex-parents-from', childRecordPath,
    '--codex', '0',
    '--claude-code', '0',
    '--codex-child', '0',
  ]);

  assert.deepEqual(output.records.map((record) => record.raw_hash), [
    'hash-parent-event-line',
    'hash-parent-response-line',
  ]);
  assert.equal(output.selection.codex_parents.identified, 2);
  assert.equal(output.selection.codex_parents.matched, 2);
  assert.equal(output.selection.codex_parents.child_without_parent, 0);
  for (const forbidden of [
    'parent-event-line-id-secret',
    'parent-response-line-id-secret',
    'child-event-line-body-secret',
    'child-response-line-body-secret',
    'parent-event-line-body-secret',
    'parent-response-line-body-secret',
  ]) {
    assert.equal(rawOutput.includes(forbidden), false, `输出泄漏了 ${forbidden}`);
  }
});

test('parent 模式按 source_tool + raw_hash 去重并应用 exclude-record', async (t) => {
  const root = await createFixture(t);
  const child = 'child.jsonl';
  const firstParent = 'rollout-2026-05-01T10-00-00-first-parent.jsonl';
  const secondParent = 'rollout-2026-05-02T10-00-00-second-parent.jsonl';
  await writeSession(root, child, [
    { type: 'session_meta', payload: { parent_thread_id: 'parent-exclude-id-secret' } },
  ]);
  await writeSession(root, firstParent, [
    { type: 'session_meta', payload: { id: 'parent-exclude-id-secret' } },
  ]);
  await writeSession(root, secondParent, [
    { type: 'session_meta', payload: { id: 'parent-selected-id-secret' } },
  ]);
  await writeManifest(root, [
    manifestRecord({ fileName: firstParent, hash: 'hash-excluded-parent' }),
    manifestRecord({ fileName: firstParent, hash: 'hash-excluded-parent' }),
    manifestRecord({ fileName: secondParent, hash: 'hash-not-a-parent' }),
  ]);

  const childRecordPath = await writeSelectorRecord(root, [{
    source_tool: 'codex',
    raw_hash: 'child-hash',
    absolute_path: path.join(root, 'vault', 'local', child),
  }]);
  const excludePath = path.join(root, 'exclude-parent.json');
  await fs.writeFile(excludePath, JSON.stringify({
    records: [
      { source_tool: 'codex', raw_hash: 'hash-excluded-parent' },
      { source_tool: 'claude-code', raw_hash: 'hash-not-a-parent' },
    ],
  }), 'utf8');

  const { output } = await runSelector(root, [
    '--codex-parents-from', childRecordPath,
    '--codex', '0',
    '--claude-code', '0',
    '--codex-child', '0',
    '--exclude-record', excludePath,
  ]);

  assert.deepEqual(output.records, []);
  assert.equal(output.selection.codex_parents.matched, 1);
  assert.equal(output.selection.codex_parents.matched_source_records, 2);
  assert.equal(output.selection.codex_parents.selected, 0);
  assert.equal(output.selection.codex_parents.unmatched, 0);
  assert.equal(output.selection.codex_parents.duplicate_raw_hash_records, 1);
  assert.equal(output.selection.codex_parents.excluded_raw_hash_records, 1);
});

test('parent 模式拒绝与普通计数、child 模式或 --all 混用', async (t) => {
  const root = await createFixture(t);
  const childRecordPath = await writeSelectorRecord(root, []);
  const baseArgs = [
    scriptPath,
    '--state-dir', root,
    '--out', path.join(root, 'out.json'),
    '--codex-parents-from', childRecordPath,
  ];
  const cases = [
    [[], '--codex 0'],
    [['--codex', '0', '--claude-code', '1', '--codex-child', '0'], '--claude-code 0'],
    [['--codex', '0', '--claude-code', '0', '--codex-child', '1'], '--codex-child 0'],
    [['--codex', '0', '--claude-code', '0', '--codex-child', '0', '--all'], '--all'],
  ];

  for (const [args, expected] of cases) {
    await assert.rejects(
      execFileAsync(process.execPath, [...baseArgs, ...args]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(expected.replace('--', '\\-\\-')));
        return true;
      },
    );
  }
});

test('child 模式识别两种 parent_thread_id 位置，排除普通会话并按时间取最早上限', async (t) => {
  const root = await createFixture(t);
  const files = [
    ['rollout-2026-01-03T10-00-00-third.jsonl', 'hash-third', [
      '{invalid-json',
      { payload: { meta: { parent_thread_id: 'parent-meta-secret' }, message: '正文-meta-secret' } },
    ]],
    ['rollout-2026-01-01T10-00-00-first.jsonl', 'hash-first', [
      {
        id: 'child-id-secret',
        parentSessionId: 'legacy-parent-secret',
        payload: { parent_thread_id: 'parent-direct-secret', message: '正文-direct-secret' },
      },
    ]],
    ['rollout-2026-01-02T10-00-00-normal.jsonl', 'hash-normal', [
      { payload: { parent_thread_id: '   ', meta: { parent_thread_id: 123 }, message: '正文-normal-secret' } },
    ]],
  ];

  await writeManifest(root, files.map(([fileName, hash]) => manifestRecord({ fileName, hash })));
  for (const [fileName, , lines] of files) {
    await writeSession(root, fileName, lines);
  }

  const { output, rawOutput } = await runSelector(root, [
    '--codex-child', '1',
    '--codex', '0',
    '--claude-code', '0',
  ]);

  assert.equal(output.selection.mode, 'codex_child');
  assert.equal(output.selection.requested.codex_child, 1);
  assert.equal(output.selection.codex_child.matched, 2);
  assert.equal(output.selection.codex_child.selected, 1);
  assert.deepEqual(output.records.map((record) => record.raw_hash), ['hash-first']);
  assert.equal(output.records.every((record) => record.source_tool === 'codex'), true);
  for (const forbidden of [
    'parent-meta-secret',
    'parent-direct-secret',
    '正文-meta-secret',
    '正文-direct-secret',
    '正文-normal-secret',
    'child-id-secret',
    'legacy-parent-secret',
    'parentSessionId',
  ]) {
    assert.equal(rawOutput.includes(forbidden), false, `输出泄漏了 ${forbidden}`);
  }
});

test('child 模式按 source_tool + raw_hash 应用 exclude-record', async (t) => {
  const root = await createFixture(t);
  const first = 'rollout-2026-02-01T10-00-00-first.jsonl';
  const second = 'rollout-2026-02-02T10-00-00-second.jsonl';
  await writeManifest(root, [
    manifestRecord({ fileName: first, hash: 'hash-excluded' }),
    manifestRecord({ fileName: second, hash: 'hash-selected' }),
  ]);
  await writeSession(root, first, [{ payload: { parent_thread_id: 'parent-1' } }]);
  await writeSession(root, second, [{ payload: { meta: { parent_thread_id: 'parent-2' } } }]);

  const excludePath = path.join(root, 'exclude.json');
  await fs.writeFile(excludePath, JSON.stringify({
    records: [
      { source_tool: 'codex', raw_hash: 'hash-excluded' },
      { source_tool: 'claude-code', raw_hash: 'hash-selected' },
    ],
  }), 'utf8');

  const { output } = await runSelector(root, [
    '--codex-child', '20',
    '--codex', '0',
    '--claude-code', '0',
    '--exclude-record', excludePath,
  ]);

  assert.deepEqual(output.records.map((record) => record.raw_hash), ['hash-selected']);
  assert.equal(output.selection.codex_child.excluded_raw_hash_records, 1);
  assert.equal(output.selection.codex_child.selected, 1);
});

test('child 模式拒绝与普通计数或 --all 混用，且参数必须是非负整数', async (t) => {
  const root = await createFixture(t);
  const baseArgs = [scriptPath, '--state-dir', root, '--out', path.join(root, 'out.json')];
  const cases = [
    [['--codex-child', '1', '--codex', '1', '--claude-code', '0'], '--codex 0'],
    [['--codex-child', '1', '--codex', '0', '--claude-code', '1'], '--claude-code 0'],
    [['--codex-child', '1', '--codex', '0', '--claude-code', '0', '--all'], '--all'],
    [['--codex-child', '-1'], '非负整数'],
    [['--codex-child', '1.5'], '非负整数'],
  ];

  for (const [args, expected] of cases) {
    await assert.rejects(
      execFileAsync(process.execPath, [...baseArgs, ...args]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(expected.replace('--', '\\-\\-')));
        return true;
      },
    );
  }
});

test('默认选择仍保留最早 Codex 20 + Claude Code 20', async (t) => {
  const root = await createFixture(t);
  const records = [];
  for (const tool of ['codex', 'claude-code']) {
    for (let day = 21; day >= 1; day -= 1) {
      const fileName = `rollout-2026-03-${String(day).padStart(2, '0')}T10-00-00-${tool}.jsonl`;
      records.push(manifestRecord({ tool, fileName, hash: `${tool}-${day}` }));
    }
  }
  await writeManifest(root, records);

  const { output } = await runSelector(root);

  assert.equal(output.records.length, 40);
  assert.deepEqual(output.records.slice(0, 20).map((record) => record.raw_hash),
    Array.from({ length: 20 }, (_, index) => `codex-${index + 1}`));
  assert.deepEqual(output.records.slice(20).map((record) => record.raw_hash),
    Array.from({ length: 20 }, (_, index) => `claude-code-${index + 1}`));
  assert.equal(output.selection.count_by_tool.codex.selected, 20);
  assert.equal(output.selection.count_by_tool.claude_code.selected, 20);
});
