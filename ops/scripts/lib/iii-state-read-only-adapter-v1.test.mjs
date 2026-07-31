import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  assertPinnedIiiVersionOutput,
  III_STATE_READ_ONLY_RUNTIME_LIMITS,
  openIiiStateReadOnlyWorkingCopy,
  PINNED_III_ENGINE_SHA256,
  PINNED_III_ENGINE_VERSION,
} from './iii-state-read-only-adapter-v1.mjs';
import {
  createLegacyLessonEvidenceProvenanceVerifier,
} from './legacy-lesson-safe-facts-collector-v1.mjs';
import {
  verifyOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';
import {
  createRealLegacyLessonSnapshotFixture,
  readFileTreeBytes,
  REAL_LEGACY_LESSON_BODY_SENTINELS as BODY_SENTINELS,
  REAL_LEGACY_LESSON_UNIT_ID as UNIT_ID,
} from './iii-state-read-only-test-fixture-v1.mjs';

const OFFICIAL_ENGINE_PATH = process.env.AGENTMEMORY_TEST_III_BIN;
const realTest = OFFICIAL_ENGINE_PATH ? test : test.skip;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

test('read-only III runtime uses bounded large-state limits and SDK reconnection fields', () => {
  assert.deepEqual(III_STATE_READ_ONLY_RUNTIME_LIMITS, {
    startupTimeoutMs: 300_000,
    invocationTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
    reconnection: {
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      backoffMultiplier: 1.5,
      jitterFactor: 0.1,
      maxRetries: 300,
    },
  });
  assert.equal(
    Object.hasOwn(III_STATE_READ_ONLY_RUNTIME_LIMITS.reconnection, 'initialDelay'),
    false,
  );
  assert.equal(
    Object.hasOwn(III_STATE_READ_ONLY_RUNTIME_LIMITS.reconnection, 'maxDelay'),
    false,
  );
});

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) return;
    await delay(50);
  }
  throw new Error(`test_engine_process_did_not_exit:${pid}`);
}

async function createRealSnapshotFixture(
  root,
  snapshotEnginePath = OFFICIAL_ENGINE_PATH,
) {
  return createRealLegacyLessonSnapshotFixture({
    root,
    enginePath: OFFICIAL_ENGINE_PATH,
    snapshotEnginePath,
  });
}

async function adapterRuntimeDirectories(root) {
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => (
      entry.isDirectory()
      && entry.name.startsWith('.iii-state-read-only-runtime-')
    ))
    .map((entry) => path.join(root, entry.name));
}

async function stateBytes(snapshotDir) {
  return readFileTreeBytes(path.join(snapshotDir, 'state'));
}

async function directAdapterInput(
  root,
  snapshotEnginePath = OFFICIAL_ENGINE_PATH,
) {
  const fixture = await createRealSnapshotFixture(root, snapshotEnginePath);
  const snapshotDir = fixture.snapshotDir;
  return {
    snapshot: fixture.manifest,
    snapshotDir,
    stateDir: path.join(snapshotDir, 'state'),
    enginePath: path.join(snapshotDir, 'engine.bin'),
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
  let sourceWorkingStateDir;
  let closeEvidence;
  let deletedLessonVisible = false;
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixture.snapshotDir,
    openReadOnlyWorkingCopy: async (input) => {
      workingRoot = path.dirname(input.snapshotDir);
      sourceWorkingStateDir = input.stateDir;
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
  const result = await verifier(fixture.request);
  assert.deepEqual(
    runtimeConfig.workers.map((worker) => worker.name),
    ['iii-worker-manager', 'iii-state'],
  );
  assert.equal(runtimeConfig.workers[0].config.host, '127.0.0.1');
  assert.equal(runtimeConfig.workers[0].config.port, runtime.port);
  assert.equal(
    path.resolve(runtimeConfig.workers[1].config.adapter.config.file_path),
    path.join(runtime.directory, 'engine-input-snapshot', 'state'),
  );
  assert.notEqual(
    path.resolve(runtimeConfig.workers[1].config.adapter.config.file_path),
    path.resolve(sourceWorkingStateDir),
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

realTest('forged state tree hash is rejected before the engine starts', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-forged-tree-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  await assert.rejects(
    () => openIiiStateReadOnlyWorkingCopy({
      ...input,
      snapshot: {
        ...input.snapshot,
        state_tree_hash: '0'.repeat(64),
      },
    }),
    /iii_state_read_only_adapter_snapshot_binding_invalid/,
  );
  assert.deepEqual(await adapterRuntimeDirectories(root), []);
  await verifyOfflineStateKvSnapshot({ snapshotDir: input.snapshotDir });
});

realTest('engine hash mismatch fails before any runtime remains', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-hash-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const wrongEnginePath = path.join(root, 'wrong-engine.bin');
  await fs.writeFile(wrongEnginePath, 'not the pinned iii engine');
  const input = await directAdapterInput(root, wrongEnginePath);
  await assert.rejects(
    () => openIiiStateReadOnlyWorkingCopy(input),
    /iii_state_read_only_adapter_engine_hash_mismatch/,
  );
  assert.deepEqual(await adapterRuntimeDirectories(root), []);
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
  assert.deepEqual(await adapterRuntimeDirectories(root), []);
});

realTest('a pre-existing legacy runtime directory is preserved and isolated', async (context) => {
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
  const view = await openIiiStateReadOnlyWorkingCopy(input);
  assert.notEqual(
    path.resolve(view.runtime.directory),
    path.resolve(runtimeDir),
  );
  await view.close();
  assert.equal(
    await fs.readFile(sentinelPath, 'utf8'),
    'belongs to another owner',
  );
  assert.deepEqual(await adapterRuntimeDirectories(root), []);
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
    /offline_snapshot_content_drifted/,
  );
  assert.deepEqual(await adapterRuntimeDirectories(root), []);
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

realTest('runtime state drift fails close without mutating the input snapshot', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-runtime-drift-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  const originalBytes = await stateBytes(input.snapshotDir);
  const view = await openIiiStateReadOnlyWorkingCopy(input);
  const runtimeConfig = YAML.parse(await fs.readFile(
    view.runtime.configPath,
    'utf8',
  ));
  const runtimeStateDir =
    runtimeConfig.workers[1].config.adapter.config.file_path;
  const runtimeStateFiles = (await fs.readdir(runtimeStateDir)).sort();
  await fs.appendFile(
    path.join(runtimeStateDir, runtimeStateFiles[0]),
    'injected-runtime-state-drift',
  );
  await assert.rejects(
    () => view.close(),
    /iii_state_read_only_adapter_close_failed/,
  );
  assert.deepEqual(await adapterRuntimeDirectories(root), []);
  await verifyOfflineStateKvSnapshot({ snapshotDir: input.snapshotDir });
  assert.deepEqual(await stateBytes(input.snapshotDir), originalBytes);
});

realTest('runtime ownership drift refuses recursive cleanup', async (context) => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'iii-state-read-only-runtime-owner-',
  ));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = await directAdapterInput(root);
  const view = await openIiiStateReadOnlyWorkingCopy(input);
  const ownerPath = path.join(
    view.runtime.directory,
    '.agentmemory-recovery-runtime-owner',
  );
  await fs.writeFile(ownerPath, 'belongs to a different owner\n');
  await assert.rejects(
    () => view.close(),
    /iii_state_read_only_adapter_close_failed/,
  );
  assert.equal(processExists(view.runtime.pid), false);
  await assertPortReleased(view.runtime.port);
  assert.equal(
    await fs.readFile(ownerPath, 'utf8'),
    'belongs to a different owner\n',
  );
  await verifyOfflineStateKvSnapshot({ snapshotDir: input.snapshotDir });
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
    () => verifier(fixture.request),
    /offline_snapshot_content_drifted/,
  );
  assert.equal(processExists(runtime.pid), false);
  await assertPortReleased(runtime.port);
  await assert.rejects(() => fs.access(workingRoot), { code: 'ENOENT' });
  await verifyOfflineStateKvSnapshot({ snapshotDir: fixture.snapshotDir });
  assert.deepEqual(await stateBytes(fixture.snapshotDir), originalBytes);
});
