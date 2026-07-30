import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerWorker } from 'iii-sdk';
import YAML from 'yaml';
import {
  assertPinnedIiiVersionOutput,
  openIiiStateReadOnlyWorkingCopy,
  PINNED_III_ENGINE_SHA256,
  PINNED_III_ENGINE_VERSION,
} from './iii-state-read-only-adapter-v1.mjs';
import {
  createLegacyLessonEvidenceProvenanceVerifier,
} from './legacy-lesson-safe-facts-collector-v1.mjs';
import {
  createOfflineStateKvSnapshot,
  verifyOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';
import { hashRecoveryValue } from './recovery-migration-contract-v1.mjs';

const OFFICIAL_ENGINE_PATH = process.env.AGENTMEMORY_TEST_III_BIN;
const realTest = OFFICIAL_ENGINE_PATH ? test : test.skip;
const UNIT_ID = 'session-1';
const ATTEMPT_ID = 'attempt-1';
const RUNNER_INPUT_HASH = 'a'.repeat(64);
const RUN_INPUT_HASH = 'b'.repeat(64);
const CONFIG_HASH = 'c'.repeat(64);
const RECEIPT_INPUT_HASH = hashRecoveryValue({
  configHash: CONFIG_HASH,
  runnerInputHash: RUNNER_INPUT_HASH,
  serviceInputHash: RUN_INPUT_HASH,
});
const RECEIPT_KEY = `xop_${createHash('sha256')
  .update(JSON.stringify([ATTEMPT_ID, 'lessons', UNIT_ID]))
  .digest('hex')
  .slice(0, 32)}`;
const BODY_SENTINELS = [
  'receipt body sentinel',
  'run body sentinel',
  'chunk body sentinel',
  'lesson body sentinel',
  'lesson context sentinel',
  'lesson tag sentinel',
];

function safeChildEnvironment() {
  return {
    ...Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
        .flatMap((name) => (
          typeof process.env[name] === 'string'
            ? [[name, process.env[name]]]
            : []
        )),
    ),
    III_TELEMETRY_ENABLED: 'false',
    OTEL_ENABLED: 'false',
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function assertPortReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) return;
    await delay(50);
  }
  throw new Error(`test_engine_process_did_not_exit:${pid}`);
}

async function waitForState(sdk, child) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('test_seed_engine_exited_early');
    }
    try {
      await sdk.trigger({
        function_id: 'state::get',
        payload: { scope: 'test:readiness', key: 'missing' },
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw new Error('test_seed_engine_not_ready', { cause: lastError });
}

async function waitForStateFiles(stateDir, expectedCount) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await fs.readdir(stateDir);
    if (entries.length >= expectedCount) return entries;
    await delay(50);
  }
  throw new Error('test_seed_state_files_missing');
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

function seedConfig({ port, stateDir }) {
  return [
    'workers:',
    '  - name: iii-worker-manager',
    '    config:',
    '      host: 127.0.0.1',
    `      port: ${port}`,
    '  - name: iii-state',
    '    config:',
    '      adapter:',
    '        name: kv',
    '        config:',
    '          store_method: file_based',
    `          file_path: ${JSON.stringify(stateDir.replaceAll('\\', '/'))}`,
    '',
  ].join('\n');
}

async function seedSyntheticState(root) {
  const stateDir = path.join(root, 'state-source');
  const configPath = path.join(root, 'seed-config.yaml');
  await fs.mkdir(stateDir);
  const port = await freePort();
  await fs.writeFile(configPath, seedConfig({ port, stateDir }));
  const child = spawn(OFFICIAL_ENGINE_PATH, [
    '--no-update-check',
    '--config',
    configPath,
  ], {
    cwd: root,
    env: safeChildEnvironment(),
    windowsHide: true,
    stdio: 'ignore',
  });
  const sdk = registerWorker(`ws://127.0.0.1:${port}`, {
    workerName: `iii-state-read-only-seed-${process.pid}-${port}`,
    enableMetricsReporting: false,
    invocationTimeoutMs: 3_000,
    reconnectionConfig: {
      maxRetries: 3,
      initialDelay: 50,
      maxDelay: 250,
    },
    otel: { enabled: false },
  });
  try {
    await waitForState(sdk, child);
    const values = [
      [
        `mem:extraction-operation-receipt:${RECEIPT_KEY}`,
        RECEIPT_KEY,
        {
          key: RECEIPT_KEY,
          runId: ATTEMPT_ID,
          unitId: UNIT_ID,
          stage: 'lessons',
          inputHash: RECEIPT_INPUT_HASH,
          status: 'failed',
          startedAt: '2026-07-30T00:00:00.000Z',
          completedAt: '2026-07-30T00:00:01.000Z',
          failure: { class: 'unit', cause: 'lesson_no_blocks' },
          response: { content: BODY_SENTINELS[0] },
        },
      ],
      [
        'mem:lesson-extraction:runs',
        'lex-run-1',
        {
          id: 'lex-run-1',
          sessionId: UNIT_ID,
          status: 'failed',
          inputHash: RUN_INPUT_HASH,
          configHash: CONFIG_HASH,
          extractionGeneration: 2,
          createdLessonIds: [],
          replacedLessonIds: [],
          finishedAt: '2026-07-30T00:00:01.000Z',
          lastError: BODY_SENTINELS[1],
        },
      ],
      [
        'mem:lesson-extraction:chunks:lex-run-1',
        'chunk-1',
        {
          id: 'chunk-1',
          runId: 'lex-run-1',
          sessionId: UNIT_ID,
          chunkIndex: 0,
          status: 'failed',
          lessonIds: [],
          lastError: BODY_SENTINELS[2],
        },
      ],
      [
        'mem:lessons',
        'existing-lesson',
        {
          id: 'existing-lesson',
          content: BODY_SENTINELS[3],
          context: BODY_SENTINELS[4],
          tags: [BODY_SENTINELS[5]],
          deleted: true,
          sourceRunId: 'old-run',
          sourceWatermarks: {
            'other-session': {
              generation: 1,
              mutationId: 'old-mutation',
            },
          },
        },
      ],
    ];
    for (const [scope, key, value] of values) {
      await sdk.trigger({
        function_id: 'state::set',
        payload: { scope, key, value },
      });
    }
    await waitForStateFiles(stateDir, values.length);
  } finally {
    await sdk.shutdown().catch(() => {});
    child.kill();
    await waitForChildExit(child);
  }
  await assertPortReleased(port);
  return stateDir;
}

function journalEvents() {
  return [
    {
      seq: 0,
      type: 'unit_planned',
      payload: { unit_id: UNIT_ID, input_hash: RUNNER_INPUT_HASH },
    },
    {
      seq: 1,
      type: 'stage_plan_completed',
      payload: { unit_count: 1 },
    },
    {
      seq: 2,
      type: 'unit_started',
      payload: { unit_id: UNIT_ID, attempt_id: ATTEMPT_ID },
    },
    {
      seq: 3,
      type: 'unit_terminal',
      payload: {
        unit_id: UNIT_ID,
        attempt_id: ATTEMPT_ID,
        status: 'failed',
        error: 'lesson_no_blocks',
      },
    },
  ];
}

function durableJournalEvents() {
  return journalEvents().map((event) => {
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
}

async function createRealSnapshotFixture(root) {
  const stateDir = await seedSyntheticState(root);
  const journalPath = path.join(root, 'lessons.jsonl');
  const snapshotDir = path.join(root, 'snapshot');
  const events = durableJournalEvents();
  await fs.writeFile(
    journalPath,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  const manifest = await createOfflineStateKvSnapshot({
    stateDir,
    journalPath,
    enginePath: OFFICIAL_ENGINE_PATH,
    destinationDir: snapshotDir,
    capturedAt: '2026-07-30T00:00:04.000Z',
    expectedJournal: {
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: events.at(-1).seq,
      input_summary_hash: hashRecoveryValue(events),
    },
  });
  return { events, manifest, snapshotDir };
}

async function stateBytes(snapshotDir) {
  const stateDir = path.join(snapshotDir, 'state');
  const entries = (await fs.readdir(stateDir)).sort();
  return Object.fromEntries(await Promise.all(entries.map(async (name) => [
    name,
    createHash('sha256')
      .update(await fs.readFile(path.join(stateDir, name)))
      .digest('hex'),
  ])));
}

async function directAdapterInput(root, engineHash = PINNED_III_ENGINE_SHA256) {
  const snapshotDir = path.join(root, 'snapshot');
  const stateDir = path.join(snapshotDir, 'state');
  const enginePath = path.join(snapshotDir, 'engine.bin');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.copyFile(OFFICIAL_ENGINE_PATH, enginePath);
  return {
    snapshot: {
      schema: 'agentmemory-recovery-evidence-snapshot/v1',
      snapshot_hash: 'd'.repeat(64),
      state_tree_hash: 'e'.repeat(64),
      engine: { sha256: engineHash },
    },
    snapshotDir,
    stateDir,
    enginePath,
  };
}

realTest('real 0.11.2 state-only engine reads a verified working snapshot without mutation', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-real-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(path.isAbsolute(OFFICIAL_ENGINE_PATH), true);
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(OFFICIAL_ENGINE_PATH))
      .digest('hex'),
    PINNED_III_ENGINE_SHA256,
  );
  const fixture = await createRealSnapshotFixture(root);
  const beforeManifest = await verifyOfflineStateKvSnapshot({
    snapshotDir: fixture.snapshotDir,
  });
  const beforeBytes = await stateBytes(fixture.snapshotDir);
  let runtime;
  let runtimeConfig;
  let workingRoot;
  let closeEvidence;
  let deletedLessonVisible = false;
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixture.snapshotDir,
    openReadOnlyWorkingCopy: async (input) => {
      workingRoot = path.dirname(input.snapshotDir);
      const view = await openIiiStateReadOnlyWorkingCopy(input);
      runtime = view.runtime;
      deletedLessonVisible = (await view.list('mem:lessons')).some(
        (lesson) => (
          lesson?.id === 'existing-lesson'
          && lesson.deleted === true
        ),
      );
      runtimeConfig = YAML.parse(await fs.readFile(
        view.runtime.configPath,
        'utf8',
      ));
      const close = view.close;
      return {
        ...view,
        async close() {
          await close();
          closeEvidence = {
            processReleased: !processExists(runtime.pid),
            runtimeRemoved: await fs.access(runtime.directory)
              .then(() => false, (error) => error?.code === 'ENOENT'),
          };
        },
      };
    },
  });
  const result = await verifier({
    run_id: 'migration-run',
    stage: 'lessons',
    journal_seq: fixture.events.at(-1).seq,
    input_summary_hash: hashRecoveryValue(fixture.events),
    units: [UNIT_ID],
  });
  assert.deepEqual(
    runtimeConfig.workers.map((worker) => worker.name),
    ['iii-worker-manager', 'iii-state'],
  );
  assert.equal(runtimeConfig.workers[0].config.host, '127.0.0.1');
  assert.equal(runtimeConfig.workers[0].config.port, runtime.port);
  assert.equal(
    path.resolve(runtimeConfig.workers[1].config.adapter.config.file_path),
    path.join(workingRoot, 'snapshot', 'state'),
  );
  assert.equal(runtimeConfig.workers[1].config.adapter.name, 'kv');
  assert.equal(
    runtimeConfig.workers[1].config.adapter.config.store_method,
    'file_based',
  );
  assert.equal(result.source_type, 'trusted_read_only_collector');
  assert.equal(deletedLessonVisible, true);
  assert.equal(
    result.safeEvidenceByUnit[UNIT_ID].safe_facts.collection.scope_proofs
      .find((proof) => proof.scope === 'mem:lessons')
      .exact_count,
    1,
  );
  const serialized = JSON.stringify(result);
  for (const sentinel of BODY_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false);
  }
  assert.deepEqual(closeEvidence, {
    processReleased: true,
    runtimeRemoved: true,
  });
  assert.equal(processExists(runtime.pid), false);
  await assertPortReleased(runtime.port);
  await assert.rejects(
    () => fs.access(workingRoot),
    { code: 'ENOENT' },
  );
  const afterManifest = await verifyOfflineStateKvSnapshot({
    snapshotDir: fixture.snapshotDir,
  });
  assert.equal(afterManifest.snapshot_hash, beforeManifest.snapshot_hash);
  assert.deepEqual(await stateBytes(fixture.snapshotDir), beforeBytes);
  await fs.rm(root, { recursive: true, force: true });
  await assert.rejects(() => fs.access(root), { code: 'ENOENT' });
});

test('adapter exposes no writer and validates the pinned engine version output', () => {
  assert.equal(assertPinnedIiiVersionOutput('0.11.2\n'), PINNED_III_ENGINE_VERSION);
  assert.throws(
    () => assertPinnedIiiVersionOutput('0.11.3'),
    /iii_state_read_only_adapter_engine_version_mismatch/,
  );
});

realTest('engine hash mismatch fails before any runtime remains', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-hash-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root, '0'.repeat(64));
  await assert.rejects(
    () => openIiiStateReadOnlyWorkingCopy(input),
    /iii_state_read_only_adapter_engine_hash_mismatch/,
  );
  await assert.rejects(
    () => fs.access(path.join(root, 'runtime')),
    { code: 'ENOENT' },
  );
});

realTest('occupied loopback port fails closed and removes its runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-port-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(
      () => openIiiStateReadOnlyWorkingCopy({
        ...input,
        port: address.port,
      }),
      /iii_state_read_only_adapter_port_unavailable/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(
    () => fs.access(path.join(root, 'runtime')),
    { code: 'ENOENT' },
  );
});

realTest('a pre-existing runtime directory is preserved when startup is refused', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-existing-runtime-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  const runtimeDir = path.join(root, 'runtime');
  const sentinelPath = path.join(runtimeDir, 'owner-sentinel.txt');
  await fs.mkdir(runtimeDir);
  await fs.writeFile(sentinelPath, 'belongs to another owner');
  await assert.rejects(
    () => openIiiStateReadOnlyWorkingCopy(input),
    { code: 'EEXIST' },
  );
  assert.equal(
    await fs.readFile(sentinelPath, 'utf8'),
    'belongs to another owner',
  );
});

realTest('corrupt StateKV fails closed instead of returning incomplete values', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-corrupt-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  await fs.writeFile(
    path.join(input.stateDir, 'corrupt.bin'),
    Buffer.from([0, 255, 1, 254, 2, 253]),
  );
  await assert.rejects(
    () => openIiiStateReadOnlyWorkingCopy(input),
    /iii_state_read_only_adapter_state_corrupt/,
  );
  await assert.rejects(
    () => fs.access(path.join(root, 'runtime')),
    { code: 'ENOENT' },
  );
});

realTest('an engine process exit makes subsequent reads fail closed and close stays idempotent', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-exit-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  const view = await openIiiStateReadOnlyWorkingCopy(input);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(typeof view.set, 'undefined');
  assert.equal(typeof view.update, 'undefined');
  assert.equal(typeof view.delete, 'undefined');
  assert.throws(() => {
    view.set = async () => {};
  }, TypeError);
  process.kill(view.runtime.pid);
  await waitForProcessExit(view.runtime.pid);
  await assert.rejects(
    () => view.get('mem:lessons', 'existing-lesson'),
    /iii_state_read_only_adapter_(?:engine_unavailable|get_failed)/,
  );
  await view.close();
  await view.close();
  assert.equal(processExists(view.runtime.pid), false);
  await assertPortReleased(view.runtime.port);
  await assert.rejects(
    () => fs.access(view.runtime.directory),
    { code: 'ENOENT' },
  );
});

realTest('verifier rejects injected working-copy state mutation after adapter close', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-post-close-mutation-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createRealSnapshotFixture(root);
  const originalBytes = await stateBytes(fixture.snapshotDir);
  let runtime;
  let workingRoot;
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixture.snapshotDir,
    openReadOnlyWorkingCopy: async (input) => {
      workingRoot = path.dirname(input.snapshotDir);
      const view = await openIiiStateReadOnlyWorkingCopy(input);
      runtime = view.runtime;
      const close = view.close;
      return {
        ...view,
        async close() {
          await close();
          const stateFiles = await fs.readdir(input.stateDir);
          await fs.appendFile(
            path.join(input.stateDir, stateFiles.sort()[0]),
            'injected-working-copy-mutation',
          );
        },
      };
    },
  });
  await assert.rejects(
    () => verifier({
      run_id: 'migration-run',
      stage: 'lessons',
      journal_seq: fixture.events.at(-1).seq,
      input_summary_hash: hashRecoveryValue(fixture.events),
      units: [UNIT_ID],
    }),
    /offline_snapshot_content_drifted/,
  );
  assert.equal(processExists(runtime.pid), false);
  await assertPortReleased(runtime.port);
  await assert.rejects(() => fs.access(workingRoot), { code: 'ENOENT' });
  await verifyOfflineStateKvSnapshot({ snapshotDir: fixture.snapshotDir });
  assert.deepEqual(await stateBytes(fixture.snapshotDir), originalBytes);
});
