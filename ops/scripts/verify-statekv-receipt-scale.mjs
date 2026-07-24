import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { registerWorker } from 'iii-sdk';

const RECEIPT_OPERATIONS = [
  ['summary', 'execute'],
  ['lessons', 'execute'],
  ['memory_consolidate', 'prepare'],
  ['memory_consolidate', 'commit'],
  ['semantic_rollup', 'execute'],
  ['skill_extract', 'prepare'],
  ['skill_extract', 'commit'],
  ['crystal', 'execute'],
  ['consolidation_procedural', 'execute'],
  ['reflect_insight', 'execute'],
];
const FIXED_TIME = '2026-07-24T00:00:00.000Z';

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing_value:${option}`);
  return value;
}

function assertAbsolute(value, option) {
  if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${option}_must_be_absolute`);
  }
}

export function scopeFilePath(stateDir, scope) {
  return path.join(path.resolve(stateDir), `${encodeURIComponent(scope)}.bin`);
}

function resultResponse(stage, unitId) {
  const resultId = `result_${stableHash([stage, unitId]).slice(0, 24)}`;
  if (stage === 'summary') {
    return { success: true, status: 'succeeded', resultRef: { scope: 'summary', key: resultId } };
  }
  if (stage === 'lessons') {
    return {
      success: true,
      status: 'succeeded',
      runs: [{ id: resultId, status: 'succeeded', createdLessonIds: [resultId] }],
    };
  }
  if (stage === 'memory_consolidate') return { success: true, status: 'succeeded', memoryIds: [resultId] };
  if (stage === 'semantic_rollup') return { success: true, status: 'succeeded', semanticMemoryIds: [resultId] };
  if (stage === 'skill_extract') return { success: true, status: 'succeeded', skillIds: [resultId] };
  if (stage === 'crystal') return { success: true, status: 'succeeded', crystalIds: [resultId] };
  if (stage === 'consolidation_procedural') {
    return { success: true, status: 'succeeded', proceduralMemoryIds: [resultId] };
  }
  return { success: true, status: 'succeeded', insightIds: [resultId] };
}

export function buildReceiptOperations({ runId, units }) {
  const operations = [];
  for (let unitIndex = 0; unitIndex < units; unitIndex += 1) {
    for (const [stage, phase] of RECEIPT_OPERATIONS) {
      const baseUnitId = `${stage}-${String(unitIndex + 1).padStart(8, '0')}`;
      const operationUnitId = phase === 'execute' ? baseUnitId : `${baseUnitId}:${phase}`;
      const identity = {
        runId,
        stage,
        unitId: operationUnitId,
        inputHash: stableHash([runId, stage, operationUnitId, 'input']),
      };
      operations.push({
        key: `xop_${stableHash([identity.runId, identity.stage, identity.unitId]).slice(0, 32)}`,
        value: {
          ...identity,
          key: `xop_${stableHash([identity.runId, identity.stage, identity.unitId]).slice(0, 32)}`,
          status: 'succeeded',
          startedAt: FIXED_TIME,
          completedAt: FIXED_TIME,
          response: resultResponse(stage, operationUnitId),
        },
      });
    }
  }
  return operations;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForState(sdk, scope) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await sdk.trigger({
        function_id: 'state::get',
        payload: { scope, key: 'readiness-probe' },
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error('statekv_engine_not_ready', { cause: lastError });
}

async function assertScopeAbsent(filePath) {
  try {
    await fs.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`statekv_scale_scope_already_exists:${filePath}`);
}

function operationScope(sampleScope, operationKey) {
  return `${sampleScope}:${operationKey}`;
}

async function waitForScopeFiles(filePaths) {
  const pending = new Set(filePaths);
  const sizes = new Map();
  for (let attempt = 0; attempt < 600 && pending.size > 0; attempt += 1) {
    for (const filePath of [...pending]) {
      try {
        sizes.set(filePath, (await fs.stat(filePath)).size);
        pending.delete(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await delay(25);
  }
  if (pending.size > 0) throw new Error(`statekv_scope_files_missing:${pending.size}`);
  return sizes;
}

async function writeSample({ sdk, stateDir, scope, operations, operationDelayMs, trackRss }) {
  const scopes = operations.map((operation) => operationScope(scope, operation.key));
  const filePaths = scopes.map((operationScopeName) => scopeFilePath(stateDir, operationScopeName));
  await Promise.all(filePaths.map(assertScopeAbsent));
  const started = performance.now();
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const operationScopeName = scopes[index];
    const { completedAt: _completedAt, response: _response, ...runningReceipt } = operation.value;
    await sdk.trigger({
      function_id: 'state::set',
      payload: {
        scope: operationScopeName,
        key: operation.key,
        value: {
          ...runningReceipt,
          status: 'running',
        },
      },
    });
    if (operationDelayMs > 0) await delay(operationDelayMs);
    await sdk.trigger({
      function_id: 'state::set',
      payload: { scope: operationScopeName, key: operation.key, value: operation.value },
    });
    trackRss();
    if (operationDelayMs > 0) await delay(operationDelayMs);
  }
  const durationMs = performance.now() - started;
  const sizes = [...(await waitForScopeFiles(filePaths)).values()];
  const finalStateKvBytes = sizes.reduce((sum, bytes) => sum + bytes, 0);
  const maxScopeBytes = Math.max(...sizes);
  return {
    scope,
    receipt_count: operations.length,
    state_set_count: operations.length * 2,
    scope_file_count: sizes.length,
    final_statekv_bytes: finalStateKvBytes,
    max_scope_file_bytes: maxScopeBytes,
    two_write_rewrite_upper_bound_bytes: finalStateKvBytes * 2,
    write_duration_ms: Number(durationMs.toFixed(3)),
    writes_per_second: durationMs > 0
      ? Number(((operations.length * 2) / (durationMs / 1000)).toFixed(2))
      : null,
  };
}

async function recoverReceipts({ engineUrl, samples, operationsByScope, trackRss }) {
  const sdk = registerWorker(engineUrl, {
    workerName: `agentmemory-v2-statekv-recovery-${process.pid}`,
    enableMetricsReporting: false,
    invocationTimeoutMs: 30_000,
    otel: { enabled: false },
  });
  const started = performance.now();
  let recoveredCount = 0;
  try {
    await waitForState(sdk, samples[0].scope);
    for (const sample of samples) {
      for (const operation of operationsByScope.get(sample.scope)) {
        const value = await sdk.trigger({
          function_id: 'state::get',
          payload: {
            scope: operationScope(sample.scope, operation.key),
            key: operation.key,
          },
        });
        if (
          value?.key !== operation.value.key
          || value?.inputHash !== operation.value.inputHash
          || value?.status !== 'succeeded'
        ) {
          throw new Error(`statekv_receipt_recovery_mismatch:${sample.scope}:${operation.key}`);
        }
        recoveredCount += 1;
        trackRss();
      }
    }
  } finally {
    await sdk.shutdown();
  }
  return {
    recovered_receipt_count: recoveredCount,
    client_reconnect_and_read_ms: Number((performance.now() - started).toFixed(3)),
  };
}

function ratio(first, second) {
  return first > 0 ? second / first : null;
}

export async function runStateKvReceiptScale({
  engineUrl = 'ws://127.0.0.1:49234',
  stateDir,
  scopePrefix,
  units = 100,
  operationDelayMs = 10,
}) {
  if (!stateDir) throw new Error('state_dir_required');
  assertAbsolute(stateDir, 'state_dir');
  if (!scopePrefix || !/^[a-z0-9:_-]+$/i.test(scopePrefix)) throw new Error('scope_prefix_invalid');
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('units_must_be_a_positive_integer');
  if (!Number.isSafeInteger(operationDelayMs) || operationDelayMs < 0 || operationDelayMs > 60_000) {
    throw new Error('operation_delay_ms_invalid');
  }
  const definitions = [
    { label: 'n', runId: 'scale-n1', units, scope: `${scopePrefix}:n` },
    { label: '2n', runId: 'scale-n2', units: units * 2, scope: `${scopePrefix}:2n` },
  ];
  const operationsByScope = new Map(definitions.map((definition) => [
    definition.scope,
    buildReceiptOperations(definition),
  ]));
  let peakRss = process.memoryUsage().rss;
  const trackRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  let sdk = registerWorker(engineUrl, {
    workerName: `agentmemory-v2-statekv-scale-${process.pid}`,
    enableMetricsReporting: false,
    invocationTimeoutMs: 30_000,
    otel: { enabled: false },
  });
  const samples = [];
  try {
    await waitForState(sdk, definitions[0].scope);
    for (const definition of definitions) {
      samples.push({
        label: definition.label,
        units_per_stage: definition.units,
        ...await writeSample({
          sdk,
          stateDir,
          scope: definition.scope,
          operations: operationsByScope.get(definition.scope),
          operationDelayMs,
          trackRss,
        }),
      });
    }
  } finally {
    await sdk.shutdown();
    sdk = null;
  }
  const recovery = await recoverReceipts({
    engineUrl,
    samples,
    operationsByScope,
    trackRss,
  });
  const [first, second] = samples;
  const finalBytesRatio = ratio(first.final_statekv_bytes, second.final_statekv_bytes);
  const accumulatedBytesRatio = ratio(
    first.two_write_rewrite_upper_bound_bytes,
    second.two_write_rewrite_upper_bound_bytes,
  );
  const accumulatedLinear = accumulatedBytesRatio !== null
    && accumulatedBytesRatio >= 1.9
    && accumulatedBytesRatio <= 2.1;
  return {
    schema_version: 1,
    benchmark_scope: 'isolated_managed_iii_statekv_per_operation_receipts',
    measured_at: new Date().toISOString(),
    engine_url: engineUrl,
    state_dir: path.resolve(stateDir),
    scope_prefix: scopePrefix,
    operations_per_unit: RECEIPT_OPERATIONS.length,
    operation_delay_ms: operationDelayMs,
    metrics: {
      final_scope_file_growth_ratio: Number(finalBytesRatio?.toFixed(4)),
      two_write_rewrite_upper_bound_growth_ratio: Number(accumulatedBytesRatio?.toFixed(4)),
      benchmark_worker_peak_rss_bytes: peakRss,
    },
    checks: {
      final_scope_file_growth_linear: finalBytesRatio !== null
        && finalBytesRatio >= 1.9
        && finalBytesRatio <= 2.1,
      two_write_rewrite_upper_bound_growth_linear: accumulatedLinear,
    },
    samples,
    recovery,
    release_decision: {
      default_format: 'v1',
      change_default: false,
      reason: accumulatedLinear
        ? 'managed_agentmemory_worker_and_proposal_scopes_not_measured'
        : 'statekv_per_operation_receipt_growth_not_linear',
    },
    limitations: [
      'two_write_rewrite_upper_bound_bytes assumes one complete small-scope rewrite for running and one for terminal; it is an upper bound derived from the observed final scope files, not device-level write telemetry.',
      'The benchmark client is a real iii-sdk worker, but it does not execute model providers or AgentMemory business adapters.',
      'The isolated engine process is managed separately; this report does not claim production runtime deployment.',
    ],
  };
}

export function parseArguments(argv) {
  const options = {
    engineUrl: 'ws://127.0.0.1:49234',
    stateDir: '',
    scopePrefix: '',
    units: 100,
    operationDelayMs: 10,
    out: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--engine-url') {
      options.engineUrl = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--state-dir') {
      options.stateDir = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--scope-prefix') {
      options.scopePrefix = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--units') {
      options.units = Number(requireValue(argv, index, argument));
      index += 1;
    } else if (argument === '--operation-delay-ms') {
      options.operationDelayMs = Number(requireValue(argv, index, argument));
      index += 1;
    } else if (argument === '--out') {
      options.out = requireValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }
  if (!options.stateDir) throw new Error('state_dir_required');
  if (!options.scopePrefix) throw new Error('scope_prefix_required');
  assertAbsolute(options.stateDir, 'state_dir');
  if (options.out) assertAbsolute(options.out, 'out');
  if (!Number.isSafeInteger(options.units) || options.units <= 0) {
    throw new Error('units_must_be_a_positive_integer');
  }
  if (
    !Number.isSafeInteger(options.operationDelayMs)
    || options.operationDelayMs < 0
    || options.operationDelayMs > 60_000
  ) {
    throw new Error('operation_delay_ms_invalid');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runStateKvReceiptScale(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(path.resolve(options.out), output, 'utf8');
  }
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
