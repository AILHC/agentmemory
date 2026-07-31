import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectLegacyLessonSafeFacts,
  createLegacyLessonEvidenceProvenanceVerifier,
  readRecoveryJournalSnapshot,
} from './legacy-lesson-safe-facts-collector-v1.mjs';
import { hashRecoveryValue } from './recovery-migration-contract-v1.mjs';
import {
  createOfflineStateKvSnapshot,
  verifyOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';

const unitId = 'session-1';
const attemptId = 'attempt-1';
const runnerInputHash = 'a'.repeat(64);
const runInputHash = 'b'.repeat(64);
const configHash = 'c'.repeat(64);
const receiptInputHash = hashRecoveryValue({
  configHash,
  runnerInputHash,
  serviceInputHash: runInputHash,
});
const receiptKey = `xop_${createHash('sha256')
  .update(JSON.stringify([attemptId, 'lessons', unitId]))
  .digest('hex')
  .slice(0, 32)}`;

function journalEvents() {
  return [
    {
      seq: 0,
      type: 'unit_planned',
      payload: { unit_id: unitId, input_hash: runnerInputHash },
    },
    {
      seq: 1,
      type: 'stage_plan_completed',
      payload: { unit_count: 1 },
    },
    {
      seq: 2,
      type: 'unit_started',
      payload: { unit_id: unitId, attempt_id: attemptId },
    },
    {
      seq: 3,
      type: 'unit_terminal',
      payload: {
        unit_id: unitId,
        attempt_id: attemptId,
        status: 'failed',
        error: 'lesson_no_blocks',
      },
    },
  ];
}

function receipt() {
  return {
    key: receiptKey,
    runId: attemptId,
    unitId,
    stage: 'lessons',
    inputHash: receiptInputHash,
    status: 'failed',
    startedAt: '2026-07-30T00:00:00.000Z',
    completedAt: '2026-07-30T00:00:01.000Z',
    failure: { class: 'unit', cause: 'lesson_no_blocks' },
    response: { content: 'receipt body sentinel' },
  };
}

function run() {
  return {
    id: 'lex-run-1',
    sessionId: unitId,
    status: 'failed',
    inputHash: runInputHash,
    configHash,
    extractionGeneration: 2,
    createdLessonIds: [],
    replacedLessonIds: [],
    finishedAt: '2026-07-30T00:00:01.000Z',
    lastError: 'run body sentinel',
  };
}

function snapshot(events) {
  return {
    schema: 'agentmemory-recovery-evidence-snapshot/v1',
    snapshot_hash: 'd'.repeat(64),
    state_tree_hash: 'e'.repeat(64),
    engine: { sha256: 'f'.repeat(64) },
    completeness: {
      two_pass_source_match: true,
      destination_hash_match: true,
    },
    expected_journal: {
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: events.at(-1).seq,
      input_summary_hash: hashRecoveryValue(events),
    },
  };
}

function readView(overrides = {}) {
  const values = {
    currentReceipt: receipt(),
    legacyReceipts: [],
    runs: [run()],
    chunks: [{
      id: 'chunk-1',
      runId: 'lex-run-1',
      sessionId: unitId,
      chunkIndex: 0,
      status: 'failed',
      lessonIds: [],
      lastError: 'chunk body sentinel',
    }],
    lessons: [{
      id: 'existing-lesson',
      content: 'lesson body sentinel',
      context: 'lesson context sentinel',
      tags: ['lesson tag sentinel'],
      deleted: true,
      sourceRunId: 'old-run',
      sourceWatermarks: {
        'other-session': { generation: 1, mutationId: 'old-mutation' },
      },
    }],
    commitReceipts: [],
    ...overrides,
  };
  return {
    capabilities: {
      completeScopeList: true,
      includesDeletedLessons: true,
      workingCopyOnly: true,
      snapshotHash: 'd'.repeat(64),
      stateTreeHash: 'e'.repeat(64),
      engineHash: 'f'.repeat(64),
    },
    async get(scope, key) {
      assert.equal(scope, `mem:extraction-operation-receipt:${receiptKey}`);
      assert.equal(key, receiptKey);
      return values.currentReceipt;
    },
    async list(scope) {
      if (scope === `mem:extraction-operation-receipt:${receiptKey}`) {
        return values.currentReceipt ? [values.currentReceipt] : [];
      }
      if (scope === 'mem:extraction-operation-receipts') return values.legacyReceipts;
      if (scope === 'mem:lesson-extraction:runs') return values.runs;
      if (scope === 'mem:lesson-extraction:chunks:lex-run-1') return values.chunks;
      if (scope === 'mem:lessons') return values.lessons;
      if (scope === 'mem:lesson-commit:receipts:lex-run-1') {
        return values.commitReceipts;
      }
      throw new Error(`unexpected scope: ${scope}`);
    },
  };
}

async function collect(view = readView()) {
  const events = journalEvents();
  const snap = snapshot(events);
  return collectLegacyLessonSafeFacts({
    view,
    snapshot: snap,
    journalEvents: events,
    request: {
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: events.at(-1).seq,
      input_summary_hash: hashRecoveryValue(events),
      units: [unitId],
    },
  });
}

test('collects the unique complete legacy Lesson zero-effect proof without bodies', async () => {
  const result = await collect();
  assert.equal(result[unitId].adapter, 'lessons/legacy-safe-facts-v1');
  assert.equal(result[unitId].safe_facts.expectedLessonRunId, 'lex-run-1');
  assert.equal(result[unitId].safe_facts.collection.scope_proofs.length, 6);
  const serialized = JSON.stringify(result);
  for (const sentinel of [
    'receipt body sentinel',
    'run body sentinel',
    'chunk body sentinel',
    'lesson body sentinel',
    'lesson context sentinel',
    'lesson tag sentinel',
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test('accepts a retryable legacy Lesson run only with the same closed zero-effect proof', async () => {
  const result = await collect(readView({
    runs: [{ ...run(), status: 'retryable' }],
  }));
  assert.equal(result[unitId].safe_facts.lessonRun.status, 'retryable');
});

test('rejects a non-failure legacy Lesson run even when effect collections are empty', async () => {
  await assert.rejects(
    () => collect(readView({
      runs: [{ ...run(), status: 'succeeded' }],
    })),
    /legacy_lesson_collector_zero_effect_not_proven/,
  );
});

test('accepts exactly one matching legacy aggregate receipt', async () => {
  const result = await collect(readView({
    currentReceipt: null,
    legacyReceipts: [receipt()],
  }));
  assert.equal(result[unitId].safe_facts.receipt.key, receiptKey);
});

for (const [name, view, pattern] of [
  [
    'new and legacy receipt conflict',
    () => readView({ legacyReceipts: [receipt()] }),
    /legacy_lesson_collector_receipt_ambiguous/,
  ],
  [
    'duplicate matching run',
    () => readView({ runs: [run(), { ...run(), id: 'lex-run-2' }] }),
    /legacy_lesson_collector_run_ambiguous/,
  ],
  [
    'nonzero chunk lesson ids',
    () => readView({
      chunks: [{
        id: 'chunk-1',
        runId: 'lex-run-1',
        sessionId: unitId,
        chunkIndex: 0,
        status: 'failed',
        lessonIds: ['written-lesson'],
      }],
    }),
    /legacy_lesson_collector_effect_detected/,
  ],
  [
    'deleted Lesson source run',
    () => readView({
      lessons: [{
        id: 'deleted-lesson',
        deleted: true,
        sourceRunId: 'lex-run-1',
        sourceWatermarks: {},
        content: 'body sentinel',
      }],
    }),
    /legacy_lesson_collector_effect_detected/,
  ],
  [
    'target generation watermark',
    () => readView({
      lessons: [{
        id: 'watermarked-lesson',
        sourceWatermarks: {
          [unitId]: { generation: 2, mutationId: 'mutation-2' },
        },
        content: 'body sentinel',
      }],
    }),
    /legacy_lesson_collector_effect_detected/,
  ],
  [
    'commit receipt',
    () => readView({
      commitReceipts: [{
        key: 'lcr-1',
        runId: 'lex-run-1',
        unitId,
        status: 'committing',
        effectHash: '1'.repeat(64),
      }],
    }),
    /legacy_lesson_collector_effect_detected/,
  ],
]) {
  test(`fails closed for ${name}`, async () => {
    await assert.rejects(() => collect(view()), pattern);
  });
}

test('requires complete deleted-inclusive working-copy list semantics', async () => {
  const view = readView();
  view.capabilities.includesDeletedLessons = false;
  await assert.rejects(
    () => collect(view),
    /legacy_lesson_collector_trusted_read_only_view_required/,
  );
});

test('requires the read-only working copy to bind the snapshot and engine hashes', async () => {
  const view = readView();
  view.capabilities.engineHash = '0'.repeat(64);
  await assert.rejects(
    () => collect(view),
    /legacy_lesson_collector_trusted_read_only_view_required/,
  );
});

test('binds the collector to the exact Journal snapshot facts', async () => {
  const events = journalEvents();
  const snap = snapshot(events);
  snap.expected_journal.input_summary_hash = '0'.repeat(64);
  await assert.rejects(
    () => collectLegacyLessonSafeFacts({
      view: readView(),
      snapshot: snap,
      journalEvents: events,
      request: {
        run_id: 'migration-run',
        stage: 'lessons',
        journal_seq: 3,
        input_summary_hash: hashRecoveryValue(events),
        units: [unitId],
      },
    }),
    /legacy_lesson_collector_snapshot_journal_binding_invalid/,
  );
});

test('verifier refuses to pretend a real engine adapter exists', () => {
  assert.throws(
    () => createLegacyLessonEvidenceProvenanceVerifier({}),
    /legacy_lesson_collector_engine_adapter_unavailable/,
  );
});

test('read-only Journal snapshot parser rejects torn and checksum-drifted facts', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'legacy-lesson-journal-snapshot-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const journalPath = path.join(root, 'lessons.jsonl');
  const core = {
    seq: 0,
    at: '2026-07-30T00:00:00.000Z',
    type: 'unit_planned',
    payload: { unit_id: unitId, input_hash: runnerInputHash },
  };
  const checksum = createHash('sha256')
    .update(JSON.stringify(core))
    .digest('hex');
  await fs.writeFile(journalPath, `${JSON.stringify({ ...core, checksum })}\n`);
  assert.equal((await readRecoveryJournalSnapshot(journalPath)).length, 1);
  await fs.writeFile(journalPath, JSON.stringify({ ...core, checksum }));
  await assert.rejects(
    () => readRecoveryJournalSnapshot(journalPath),
    /legacy_lesson_collector_journal_snapshot_incomplete/,
  );
  await fs.writeFile(
    journalPath,
    `${JSON.stringify({ ...core, checksum: '0'.repeat(64) })}\n`,
  );
  await assert.rejects(
    () => readRecoveryJournalSnapshot(journalPath),
    /legacy_lesson_collector_journal_snapshot_invalid/,
  );
});

async function createProvenanceSnapshotFixture(root) {
  const stateDir = path.join(root, 'state-source');
  const journalPath = path.join(root, 'lessons.jsonl');
  const enginePath = path.join(root, 'iii.exe');
  const snapshotDir = path.join(root, 'snapshot');
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, 'mem%3Alessons.bin'), 'opaque');
  await fs.writeFile(enginePath, 'engine');
  const durableEvents = journalEvents().map((event) => {
    const core = {
      seq: event.seq,
      at: `2026-07-30T00:00:0${event.seq}.000Z`,
      type: event.type,
      payload: event.payload,
    };
    return {
      ...core,
      checksum: createHash('sha256')
        .update(JSON.stringify(core))
        .digest('hex'),
    };
  });
  await fs.writeFile(
    journalPath,
    `${durableEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  await createOfflineStateKvSnapshot({
    stateDir,
    journalPath,
    enginePath,
    destinationDir: snapshotDir,
    capturedAt: '2026-07-30T00:00:04.000Z',
    expectedJournal: {
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: 3,
      input_summary_hash: hashRecoveryValue(durableEvents),
    },
  });
  return {
    durableEvents,
    snapshotDir,
    originalStateFile: path.join(
      snapshotDir,
      'state',
      'mem%3Alessons.bin',
    ),
  };
}

test('verified snapshot verifier plugs collected facts into provenance output', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'legacy-lesson-provenance-verifier-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createProvenanceSnapshotFixture(root);
  let adapterPaths;
  let viewClosed = false;
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixture.snapshotDir,
    openReadOnlyWorkingCopy: async (input) => {
      adapterPaths = input;
      const view = readView();
      view.capabilities.snapshotHash = input.snapshot.snapshot_hash;
      view.capabilities.stateTreeHash = input.snapshot.state_tree_hash;
      view.capabilities.engineHash = input.snapshot.engine.sha256;
      view.close = async () => {
        viewClosed = true;
      };
      return view;
    },
  });
  const result = await verifier({
    run_id: 'migration-run',
    stage: 'lessons',
    journal_seq: 3,
    input_summary_hash: hashRecoveryValue(fixture.durableEvents),
    units: [unitId],
  });
  assert.equal(result.source_type, 'trusted_read_only_collector');
  assert.equal(
    result.safeEvidenceByUnit[unitId].safe_facts.collection.snapshot_hash,
    result.collector_provenance.snapshot_hash,
  );
  for (const exposedPath of [
    adapterPaths.snapshotDir,
    adapterPaths.stateDir,
    adapterPaths.enginePath,
  ]) {
    const relative = path.relative(fixture.snapshotDir, exposedPath);
    assert.equal(
      relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
      false,
    );
  }
  assert.equal(viewClosed, true);
  await assert.rejects(
    () => fs.access(adapterPaths.snapshotDir),
    { code: 'ENOENT' },
  );
});

test('adapter writes are isolated to the working copy and fail closed', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'legacy-lesson-working-copy-isolation-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createProvenanceSnapshotFixture(root);
  const originalBytes = await fs.readFile(fixture.originalStateFile);
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixture.snapshotDir,
    openReadOnlyWorkingCopy: async (input) => {
      await fs.writeFile(
        path.join(input.stateDir, 'mem%3Alessons.bin'),
        'adapter-mutated-working-copy',
      );
      const view = readView();
      view.capabilities.snapshotHash = input.snapshot.snapshot_hash;
      view.capabilities.stateTreeHash = input.snapshot.state_tree_hash;
      view.capabilities.engineHash = input.snapshot.engine.sha256;
      return view;
    },
  });
  await assert.rejects(
    () => verifier({
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: 3,
      input_summary_hash: hashRecoveryValue(fixture.durableEvents),
      units: [unitId],
    }),
    /offline_snapshot_content_drifted/,
  );
  assert.deepEqual(await fs.readFile(fixture.originalStateFile), originalBytes);
  await verifyOfflineStateKvSnapshot({ snapshotDir: fixture.snapshotDir });
});

test('verifier rejects any mutation of the original snapshot after adapter close', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'legacy-lesson-original-snapshot-drift-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createProvenanceSnapshotFixture(root);
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixture.snapshotDir,
    openReadOnlyWorkingCopy: async (input) => {
      await fs.writeFile(fixture.originalStateFile, 'original-snapshot-mutated');
      const view = readView();
      view.capabilities.snapshotHash = input.snapshot.snapshot_hash;
      view.capabilities.stateTreeHash = input.snapshot.state_tree_hash;
      view.capabilities.engineHash = input.snapshot.engine.sha256;
      return view;
    },
  });
  await assert.rejects(
    () => verifier({
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: 3,
      input_summary_hash: hashRecoveryValue(fixture.durableEvents),
      units: [unitId],
    }),
    /offline_snapshot_content_drifted/,
  );
});
