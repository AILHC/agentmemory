import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { registerWorker } from 'iii-sdk';
import {
  createOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';
import { hashRecoveryValue } from './recovery-migration-contract-v1.mjs';

export const REAL_LEGACY_LESSON_UNIT_ID = 'session-1';
export const REAL_LEGACY_LESSON_BODY_SENTINELS = Object.freeze([
  'receipt body sentinel',
  'run body sentinel',
  'chunk body sentinel',
  'lesson body sentinel',
  'lesson context sentinel',
  'lesson tag sentinel',
]);

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
  .update(JSON.stringify([
    ATTEMPT_ID,
    'lessons',
    REAL_LEGACY_LESSON_UNIT_ID,
  ]))
  .digest('hex')
  .slice(0, 32)}`;

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
    if (entries.length >= expectedCount) return;
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

async function seedSyntheticState(root, enginePath) {
  const stateDir = path.join(root, 'state-source');
  const configPath = path.join(root, 'seed-config.yaml');
  await fs.mkdir(stateDir);
  const port = await freePort();
  await fs.writeFile(configPath, seedConfig({ port, stateDir }));
  const child = spawn(enginePath, [
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
          unitId: REAL_LEGACY_LESSON_UNIT_ID,
          stage: 'lessons',
          inputHash: RECEIPT_INPUT_HASH,
          status: 'failed',
          startedAt: '2026-07-30T00:00:00.000Z',
          completedAt: '2026-07-30T00:00:01.000Z',
          failure: { class: 'unit', cause: 'lesson_no_blocks' },
          response: { content: REAL_LEGACY_LESSON_BODY_SENTINELS[0] },
        },
      ],
      [
        'mem:lesson-extraction:runs',
        'lex-run-1',
        {
          id: 'lex-run-1',
          sessionId: REAL_LEGACY_LESSON_UNIT_ID,
          status: 'failed',
          inputHash: RUN_INPUT_HASH,
          configHash: CONFIG_HASH,
          extractionGeneration: 2,
          createdLessonIds: [],
          replacedLessonIds: [],
          finishedAt: '2026-07-30T00:00:01.000Z',
          lastError: REAL_LEGACY_LESSON_BODY_SENTINELS[1],
        },
      ],
      [
        'mem:lesson-extraction:chunks:lex-run-1',
        'chunk-1',
        {
          id: 'chunk-1',
          runId: 'lex-run-1',
          sessionId: REAL_LEGACY_LESSON_UNIT_ID,
          chunkIndex: 0,
          status: 'failed',
          lessonIds: [],
          lastError: REAL_LEGACY_LESSON_BODY_SENTINELS[2],
        },
      ],
      [
        'mem:lessons',
        'existing-lesson',
        {
          id: 'existing-lesson',
          content: REAL_LEGACY_LESSON_BODY_SENTINELS[3],
          context: REAL_LEGACY_LESSON_BODY_SENTINELS[4],
          tags: [REAL_LEGACY_LESSON_BODY_SENTINELS[5]],
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

function durableJournalEvents() {
  const events = [
    {
      seq: 0,
      type: 'unit_planned',
      payload: {
        unit_id: REAL_LEGACY_LESSON_UNIT_ID,
        input_hash: RUNNER_INPUT_HASH,
      },
    },
    {
      seq: 1,
      type: 'stage_plan_completed',
      payload: { unit_count: 1 },
    },
    {
      seq: 2,
      type: 'unit_started',
      payload: {
        unit_id: REAL_LEGACY_LESSON_UNIT_ID,
        attempt_id: ATTEMPT_ID,
      },
    },
    {
      seq: 3,
      type: 'unit_terminal',
      payload: {
        unit_id: REAL_LEGACY_LESSON_UNIT_ID,
        attempt_id: ATTEMPT_ID,
        status: 'failed',
        error: 'lesson_no_blocks',
      },
    },
  ];
  return events.map((event) => {
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

export async function createRealLegacyLessonSnapshotFixture({
  root,
  enginePath,
  snapshotEnginePath = enginePath,
}) {
  const stateDir = await seedSyntheticState(root, enginePath);
  const journalPath = path.join(root, 'lessons.jsonl');
  const snapshotDir = path.join(root, 'snapshot');
  const events = durableJournalEvents();
  const request = {
    run_id: 'migration-run',
    stage: 'lessons',
    journal_seq: events.at(-1).seq,
    input_summary_hash: hashRecoveryValue(events),
    units: [REAL_LEGACY_LESSON_UNIT_ID],
  };
  await fs.writeFile(
    journalPath,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  const manifest = await createOfflineStateKvSnapshot({
    stateDir,
    journalPath,
    enginePath: snapshotEnginePath,
    destinationDir: snapshotDir,
    capturedAt: '2026-07-30T00:00:04.000Z',
    expectedJournal: {
      run_id: request.run_id,
      stage: request.stage,
      journal_seq: request.journal_seq,
      input_summary_hash: request.input_summary_hash,
    },
  });
  return {
    events,
    journalPath,
    manifest,
    request,
    snapshotDir,
    stateDir,
    scopes: {
      businessRecords: 'mem:lessons',
      receipt: `mem:extraction-operation-receipt:${RECEIPT_KEY}`,
    },
  };
}

export async function readFileTreeBytes(rootDir) {
  const result = [];
  async function visit(directory, prefix) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = prefix
        ? `${prefix}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: relativePath, type: 'directory' });
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        result.push({
          path: relativePath,
          type: 'file',
          bytes: await fs.readFile(absolutePath),
        });
      } else {
        throw new Error(`test_fixture_unsupported_tree_entry:${relativePath}`);
      }
    }
  }
  await visit(path.resolve(rootDir), '');
  return result;
}
