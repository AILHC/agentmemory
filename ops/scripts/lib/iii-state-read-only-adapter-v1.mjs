import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { registerWorker } from 'iii-sdk';

export const III_STATE_READ_ONLY_ADAPTER_SCHEMA = 'iii-state-read-only-working-copy/v1';
export const PINNED_III_ENGINE_VERSION = '0.11.2';
export const PINNED_III_ENGINE_SHA256 =
  '2447bc21906a6b5be270868da7e74a1c744a4644cf3bd4b37a228ba4e55478ca';

const HASH = /^[0-9a-f]{64}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:%-]{0,511}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 10_000;
const INVOCATION_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = INVOCATION_TIMEOUT_MS + 250;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isExactChild(candidate, parent, name) {
  return path.resolve(candidate) === path.join(path.resolve(parent), name);
}

async function assertRegularFile(filePath, code) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(code);
}

async function assertDirectory(directoryPath, code) {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(code);
}

function assertSnapshotBinding({ snapshot, snapshotDir, stateDir, enginePath }) {
  if (
    snapshot?.schema !== 'agentmemory-recovery-evidence-snapshot/v1'
    || !HASH.test(String(snapshot?.snapshot_hash || ''))
    || !HASH.test(String(snapshot?.state_tree_hash || ''))
    || !HASH.test(String(snapshot?.engine?.sha256 || ''))
    || !path.isAbsolute(snapshotDir)
    || !isExactChild(stateDir, snapshotDir, 'state')
    || !isExactChild(enginePath, snapshotDir, 'engine.bin')
  ) {
    throw new Error('iii_state_read_only_adapter_snapshot_binding_invalid');
  }
}

async function reserveLoopbackPort(requestedPort) {
  if (
    requestedPort !== undefined
    && (
      !Number.isSafeInteger(requestedPort)
      || requestedPort < 1
      || requestedPort > 65_535
    )
  ) {
    throw new Error('iii_state_read_only_adapter_port_invalid');
  }
  const server = net.createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort ?? 0, LOOPBACK_HOST, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('iii_state_read_only_adapter_port_unavailable');
    }
    return address.port;
  } catch (error) {
    throw new Error('iii_state_read_only_adapter_port_unavailable', {
      cause: error,
    });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function stateOnlyConfig({ port, stateDir }) {
  const filePath = stateDir.replaceAll('\\', '/');
  return [
    'workers:',
    '  - name: iii-worker-manager',
    '    config:',
    `      host: ${LOOPBACK_HOST}`,
    `      port: ${port}`,
    '  - name: iii-state',
    '    config:',
    '      adapter:',
    '        name: kv',
    '        config:',
    '          store_method: file_based',
    `          file_path: ${JSON.stringify(filePath)}`,
    '',
  ].join('\n');
}

export function assertPinnedIiiVersionOutput(output) {
  const normalized = String(output || '').trim();
  if (
    normalized !== PINNED_III_ENGINE_VERSION
    && normalized !== `iii ${PINNED_III_ENGINE_VERSION}`
    && normalized !== `iii-engine ${PINNED_III_ENGINE_VERSION}`
  ) {
    throw new Error('iii_state_read_only_adapter_engine_version_mismatch');
  }
  return PINNED_III_ENGINE_VERSION;
}

async function verifyAndCopyEngine({ enginePath, runtimeEnginePath, snapshot }) {
  await assertRegularFile(
    enginePath,
    'iii_state_read_only_adapter_engine_not_regular',
  );
  const sourceHash = sha256(await fs.readFile(enginePath));
  if (
    sourceHash !== snapshot.engine.sha256
    || sourceHash !== PINNED_III_ENGINE_SHA256
  ) {
    throw new Error('iii_state_read_only_adapter_engine_hash_mismatch');
  }
  await fs.copyFile(
    enginePath,
    runtimeEnginePath,
    fsConstants.constants.COPYFILE_EXCL,
  );
  await assertRegularFile(
    runtimeEnginePath,
    'iii_state_read_only_adapter_runtime_engine_not_regular',
  );
  if (sha256(await fs.readFile(runtimeEnginePath)) !== sourceHash) {
    throw new Error('iii_state_read_only_adapter_engine_copy_drifted');
  }
  let result;
  try {
    result = await execFileAsync(
      runtimeEnginePath,
      ['--no-update-check', '--version'],
      {
        cwd: path.dirname(runtimeEnginePath),
        env: safeChildEnvironment(),
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 16 * 1024,
        encoding: 'utf8',
      },
    );
  } catch (error) {
    throw new Error(
      'iii_state_read_only_adapter_engine_version_check_failed',
      { cause: error },
    );
  }
  assertPinnedIiiVersionOutput(`${result.stdout || ''}${result.stderr || ''}`);
}

function waitForExit(child, milliseconds = SHUTDOWN_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return withTimeout(
    new Promise((resolve) => {
      const onExit = (code, signal) => resolve({ code, signal });
      child.once('exit', onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off('exit', onExit);
        resolve({
          code: child.exitCode,
          signal: child.signalCode,
        });
      }
    }),
    milliseconds,
    'iii_state_read_only_adapter_engine_exit_timeout',
  );
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  try {
    await waitForExit(child);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child);
    throw error;
  }
}

async function waitForStateReady({ sdk, child }) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('iii_state_read_only_adapter_engine_exited_early');
    }
    try {
      await withTimeout(
        sdk.trigger({
          function_id: 'state::get',
          payload: {
            scope: 'agentmemory:recovery-readiness',
            key: 'missing',
          },
        }),
        PROBE_TIMEOUT_MS,
        'iii_state_read_only_adapter_readiness_attempt_timeout',
      );
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('iii_state_read_only_adapter_engine_exited_early');
  }
  throw new Error('iii_state_read_only_adapter_readiness_timeout', {
    cause: lastError,
  });
}

async function confirmEngineStayedReady({ sdk, child }) {
  await delay(200);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('iii_state_read_only_adapter_engine_exited_early');
  }
  await withTimeout(
    sdk.trigger({
      function_id: 'state::get',
      payload: {
        scope: 'agentmemory:recovery-readiness',
        key: 'ownership-confirmation-missing',
      },
    }),
    PROBE_TIMEOUT_MS,
    'iii_state_read_only_adapter_readiness_confirmation_failed',
  );
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('iii_state_read_only_adapter_engine_exited_early');
  }
}

async function assertEngineLoadedState({ stdoutPath, stderrPath }) {
  const startupOutput = `${await fs.readFile(stdoutPath, 'utf8')}\n${
    await fs.readFile(stderrPath, 'utf8')
  }`;
  if (/failed to (?:parse|read) index file/i.test(startupOutput)) {
    throw new Error('iii_state_read_only_adapter_state_corrupt');
  }
}

function assertScope(scope) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) {
    throw new Error('iii_state_read_only_adapter_scope_invalid');
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new Error('iii_state_read_only_adapter_key_invalid');
  }
}

export async function openIiiStateReadOnlyWorkingCopy({
  snapshot,
  snapshotDir,
  stateDir,
  enginePath,
  port: requestedPort,
}) {
  assertSnapshotBinding({ snapshot, snapshotDir, stateDir, enginePath });
  await Promise.all([
    assertDirectory(
      snapshotDir,
      'iii_state_read_only_adapter_snapshot_directory_invalid',
    ),
    assertDirectory(
      stateDir,
      'iii_state_read_only_adapter_state_directory_invalid',
    ),
  ]);

  const workingRoot = path.dirname(snapshotDir);
  const runtimeDir = path.join(workingRoot, 'runtime');
  const runtimeEnginePath = path.join(runtimeDir, 'iii.exe');
  const configPath = path.join(runtimeDir, 'iii-config.yaml');
  const stdoutPath = path.join(runtimeDir, 'iii.stdout.log');
  const stderrPath = path.join(runtimeDir, 'iii.stderr.log');
  let sdk;
  let child;
  let stdoutHandle;
  let stderrHandle;
  let closePromise;
  let runtimeCreated = false;

  try {
    await fs.mkdir(runtimeDir, { recursive: false });
    runtimeCreated = true;
    await verifyAndCopyEngine({
      enginePath,
      runtimeEnginePath,
      snapshot,
    });
    const port = await reserveLoopbackPort(requestedPort);
    await fs.writeFile(
      configPath,
      stateOnlyConfig({ port, stateDir }),
      { encoding: 'utf8', flag: 'wx' },
    );
    stdoutHandle = await fs.open(stdoutPath, 'wx');
    stderrHandle = await fs.open(stderrPath, 'wx');
    child = spawn(runtimeEnginePath, [
      '--no-update-check',
      '--config',
      configPath,
    ], {
      cwd: runtimeDir,
      env: safeChildEnvironment(),
      windowsHide: true,
      stdio: [
        'ignore',
        stdoutHandle.fd,
        stderrHandle.fd,
      ],
    });
    const spawnError = new Promise((_, reject) => {
      child.once('error', () => reject(
        new Error('iii_state_read_only_adapter_engine_spawn_failed'),
      ));
    });
    sdk = registerWorker(`ws://${LOOPBACK_HOST}:${port}`, {
      workerName: `agentmemory-recovery-read-only-${process.pid}-${port}`,
      enableMetricsReporting: false,
      invocationTimeoutMs: INVOCATION_TIMEOUT_MS,
      reconnectionConfig: {
        maxRetries: 3,
        initialDelay: 50,
        maxDelay: 250,
      },
      otel: { enabled: false },
    });
    await Promise.race([
      waitForStateReady({ sdk, child }),
      spawnError,
    ]);
    await Promise.race([
      confirmEngineStayedReady({ sdk, child }),
      spawnError,
    ]);
    await assertEngineLoadedState({ stdoutPath, stderrPath });

    let closed = false;
    const trigger = async (functionId, payload, code) => {
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('iii_state_read_only_adapter_engine_unavailable');
      }
      try {
        return await withTimeout(
          sdk.trigger({ function_id: functionId, payload }),
          INVOCATION_TIMEOUT_MS + 250,
          code,
        );
      } catch (error) {
        throw new Error(code, { cause: error });
      }
    };
    const close = async () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const errors = [];
        if (sdk) {
          try {
            await withTimeout(
              sdk.shutdown(),
              SHUTDOWN_TIMEOUT_MS,
              'iii_state_read_only_adapter_sdk_shutdown_timeout',
            );
          } catch (error) {
            errors.push(error);
          }
          sdk = null;
        }
        try {
          await terminateChild(child);
        } catch (error) {
          errors.push(error);
        }
        for (const handle of [stdoutHandle, stderrHandle]) {
          try {
            await handle?.close();
          } catch (error) {
            errors.push(error);
          }
        }
        stdoutHandle = null;
        stderrHandle = null;
        try {
          await fs.rm(runtimeDir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'iii_state_read_only_adapter_close_failed',
          );
        }
      })();
      return closePromise;
    };

    return Object.freeze({
      capabilities: Object.freeze({
        schema: III_STATE_READ_ONLY_ADAPTER_SCHEMA,
        completeScopeList: true,
        includesDeletedLessons: true,
        workingCopyOnly: true,
        snapshotHash: snapshot.snapshot_hash,
        stateTreeHash: snapshot.state_tree_hash,
        engineHash: snapshot.engine.sha256,
        engineVersion: PINNED_III_ENGINE_VERSION,
      }),
      runtime: Object.freeze({
        pid: child.pid,
        port,
        host: LOOPBACK_HOST,
        directory: runtimeDir,
        configPath,
      }),
      async get(scope, key) {
        assertScope(scope);
        assertKey(key);
        return trigger(
          'state::get',
          { scope, key },
          'iii_state_read_only_adapter_get_failed',
        );
      },
      async list(scope) {
        assertScope(scope);
        const values = await trigger(
          'state::list',
          { scope },
          'iii_state_read_only_adapter_list_failed',
        );
        if (!Array.isArray(values)) {
          throw new Error('iii_state_read_only_adapter_list_incomplete');
        }
        return values;
      },
      close,
    });
  } catch (error) {
    const cleanupErrors = [];
    if (sdk) {
      try {
        await withTimeout(
          sdk.shutdown(),
          SHUTDOWN_TIMEOUT_MS,
          'iii_state_read_only_adapter_sdk_shutdown_timeout',
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await terminateChild(child);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    for (const handle of [stdoutHandle, stderrHandle]) {
      try {
        await handle?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (runtimeCreated) {
      try {
        await fs.rm(runtimeDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'iii_state_read_only_adapter_start_cleanup_failed',
      );
    }
    throw error;
  }
}
