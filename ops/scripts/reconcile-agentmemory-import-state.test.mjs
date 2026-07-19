import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chunkRecords, parseArgs, reconcileRecords, withImportTargetSession } from './reconcile-agentmemory-import-state.mjs';

const options = parseArgs([
  '--record',
  'full.json',
  '--out',
  'missing.json',
  '--batch-size',
  '100',
  '--batch-dir',
  'batches',
]);
assert.equal(options.recordPath, 'full.json');
assert.equal(options.outPath, 'missing.json');
assert.equal(options.batchSize, 100);
assert.equal(options.batchDir, 'batches');

const records = [
  { derived_session_id: 's1', raw_hash: 'h1' },
  { derived_session_id: 's2', raw_hash: 'h2' },
  { derived_session_id: 's2', raw_hash: 'h2b' },
  { derived_session_id: 's3', raw_hash: 'h3' },
  {
    derived_session_id: 'child-1',
    import_source_session_id: 'child-1',
    import_target_session_id: 'child-1',
    import_parent_session_id: 'parent-1',
    import_lineage: 'child',
    raw_hash: 'child-h1',
  },
  {
    derived_session_id: 'empty-1',
    raw_hash: 'empty-h1',
    import_cli: {
      exit_code: 0,
      stdout: 'imported 1 file(s), 0 observation(s) across 0 session(s)',
    },
  },
  { derived_session_id: 'empty-2', raw_hash: 'empty-h2', import_observation_candidates: 0 },
  { raw_hash: 'no-session-id' },
];
const sessions = [
  { id: 's1' },
  { id: 'child-1' },
  { id: 's4' },
];

const result = reconcileRecords(records, sessions);
assert.equal(result.summary.record_count, 8);
assert.equal(result.summary.distinct_record_session_ids, 4);
assert.equal(result.summary.distinct_expected_session_ids, 4);
assert.equal(result.summary.agentmemory_session_count, 3);
assert.equal(result.summary.matched_record_session_ids, 2);
assert.equal(result.summary.missing_record_session_ids, 2);
assert.equal(result.summary.missing_records, 3);
assert.deepEqual(result.missingRecords.map((item) => item.raw_hash), ['h2', 'h2b', 'h3']);
assert.equal(result.summary.records_without_session_id, 1);
assert.equal(result.summary.duplicate_record_session_ids, 1);
assert.equal(result.summary.skipped_no_session_records, 2);
assert.equal(result.summary.extra_agentmemory_session_ids, 1);
assert.equal(result.warnings.some((warning) => warning.type === 'record_missing_session_id'), true);
assert.equal(result.warnings.some((warning) => warning.type === 'duplicate_record_session_ids'), true);

const legacyChildResult = reconcileRecords(
  [
    {
      derived_session_id: 'legacy-child',
      parent_session_id: 'legacy-parent',
      raw_hash: 'legacy-child-hash',
    },
  ],
  [{ id: 'legacy-parent' }],
);
assert.equal(legacyChildResult.summary.matched_record_session_ids, 0);
assert.equal(legacyChildResult.summary.missing_record_session_ids, 1);
assert.deepEqual(
  legacyChildResult.missingRecords.map((item) => item.raw_hash),
  ['legacy-child-hash'],
);

assert.deepEqual(chunkRecords([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);

const childJsonl = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'am-reconcile-child-')), 'child.jsonl');
await fs.writeFile(
  childJsonl,
  [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'child-session',
        cwd: '/workspace/child',
        parent_thread_id: 'parent-session',
      },
    }),
  ].join('\n'),
);

const enrichedChild = await withImportTargetSession({
  absolute_path: childJsonl,
  raw_hash: 'child-hash',
});

assert.equal(enrichedChild.import_source_session_id, 'child-session');
assert.equal(enrichedChild.import_target_session_id, 'child-session');
assert.equal(enrichedChild.import_parent_session_id, 'parent-session');
assert.equal(enrichedChild.import_lineage, 'child');

const delayedMetaJsonl = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'am-reconcile-delayed-meta-')), 'delayed.jsonl');
await fs.writeFile(
  delayedMetaJsonl,
  [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        id: 'event-not-session',
        message: 'hello before metadata',
      },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: 'delayed-child-session',
        cwd: '/workspace/delayed-child',
        parent_thread_id: 'delayed-parent-session',
      },
    }),
  ].join('\n'),
);

const enrichedDelayedMeta = await withImportTargetSession({
  absolute_path: delayedMetaJsonl,
  raw_hash: 'delayed-meta-hash',
});

assert.equal(enrichedDelayedMeta.import_source_session_id, 'delayed-child-session');
assert.equal(enrichedDelayedMeta.import_target_session_id, 'delayed-child-session');
assert.equal(enrichedDelayedMeta.import_parent_session_id, 'delayed-parent-session');
assert.equal(enrichedDelayedMeta.import_lineage, 'child');

const sidechainJsonl = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'am-reconcile-sidechain-')), 'sidechain.jsonl');
await fs.writeFile(
  sidechainJsonl,
  [
    JSON.stringify({
      type: 'user',
      sessionId: 'claude-sidechain',
      parentSessionId: 'claude-parent',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'sidechain work' }] },
    }),
  ].join('\n'),
);

const enrichedSidechain = await withImportTargetSession({
  absolute_path: sidechainJsonl,
  raw_hash: 'sidechain-hash',
});

assert.equal(enrichedSidechain.import_source_session_id, 'claude-sidechain');
assert.equal(enrichedSidechain.import_target_session_id, 'claude-sidechain');
assert.equal(enrichedSidechain.import_parent_session_id, 'claude-parent');
assert.equal(enrichedSidechain.import_lineage, 'sidechain');
assert.equal(enrichedSidechain.import_observation_candidates, 1);
