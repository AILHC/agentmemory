import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  runSinglePhaseStage,
  runTwoPhaseStage,
  validateSinglePhaseStage,
  validateTwoPhaseStage,
} from './lib/recoverable-stage-v2.mjs';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';

const STAGES = [
  { name: 'summary', mode: 'single' },
  { name: 'lessons', mode: 'single' },
  { name: 'memory_consolidate', mode: 'two_phase' },
  { name: 'semantic_rollup', mode: 'single' },
  { name: 'skill_extract', mode: 'two_phase' },
  { name: 'crystal', mode: 'single' },
  { name: 'consolidation_procedural', mode: 'single' },
  { name: 'reflect_insight', mode: 'single' },
];
const V1_STATE_FILES = new Set([
  'run.json',
  'run.journal.jsonl',
  'run.status.json',
  'run.json.lock',
]);
const RECEIPT_FILE = 'service-receipts.jsonl';
const FIXED_TIME = '2026-07-24T00:00:00.000Z';

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function receiptKey(identity) {
  return `xop_${stableHash([identity.runId, identity.stage, identity.unitId]).slice(0, 32)}`;
}

function unitId(stage, index) {
  return `${stage}-${String(index + 1).padStart(8, '0')}`;
}

function resultResponse(stage, id) {
  const resultId = `result_${stableHash([stage, id]).slice(0, 24)}`;
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

function planFor(stage, units) {
  return Array.from({ length: units }, (_, index) => {
    const id = unitId(stage, index);
    return {
      unit_id: id,
      input_hash: stableHash({ stage, id, source: `source-${String(index + 1).padStart(8, '0')}` }),
      source_count: 1,
    };
  });
}

class SerializedReceiptLedger {
  constructor(filePath) {
    this.filePath = filePath;
    this.handle = null;
    this.count = 0;
  }

  async open() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fs.open(this.filePath, 'w');
  }

  async append(identity, response) {
    const receipt = {
      ...identity,
      key: receiptKey(identity),
      status: 'succeeded',
      startedAt: FIXED_TIME,
      completedAt: FIXED_TIME,
      response,
    };
    await this.handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await this.handle.sync();
    this.count += 1;
  }

  async close() {
    await this.handle?.close();
    this.handle = null;
  }
}

async function listFiles(rootDir) {
  const files = [];
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function fileBytes(filePath) {
  return (await fs.stat(filePath)).size;
}

function ratioFromBaseline(baseline, first, second) {
  const firstGrowth = first - baseline;
  const secondGrowth = second - baseline;
  return firstGrowth > 0 ? secondGrowth / firstGrowth : null;
}

function phaseIdentity(runId, stage, unit, phase) {
  const phaseUnitId = phase ? `${unit.unit_id}:${phase}` : unit.unit_id;
  return {
    runId,
    stage,
    unitId: phaseUnitId,
    inputHash: stableHash([unit.input_hash, phase || 'execute']),
  };
}

async function appendSingleStage({ journal, ledger, runId, stage, units, trackHeap }) {
  const plan = planFor(stage, units);
  const result = await runSinglePhaseStage({
    events: await journal.readStage(stage),
    plan,
    planMetadata: { benchmark: true },
    append: (type, payload) => journal.appendStage(stage, type, payload),
    attemptIdForUnit: (unit) => `attempt_${stableHash([runId, stage, unit.unit_id]).slice(0, 32)}`,
    execute: async ({ unit }) => {
      const identity = phaseIdentity(runId, stage, unit);
      const response = resultResponse(stage, unit.unit_id);
      await ledger.append(identity, response);
      trackHeap();
      return { status: 'succeeded', payload: { result_ids: responseIds(response) } };
    },
    record: async () => {
      trackHeap();
    },
  });
  if (result.status !== 'completed') throw new Error(`v2_scale_stage_not_completed:${stage}`);
}

function responseIds(response) {
  return [
    response?.resultRef?.key,
    ...(response?.runs?.flatMap((run) => run.createdLessonIds || []) || []),
    ...(response?.memoryIds || []),
    ...(response?.semanticMemoryIds || []),
    ...(response?.skillIds || []),
    ...(response?.crystalIds || []),
    ...(response?.proceduralMemoryIds || []),
    ...(response?.insightIds || []),
  ].filter(Boolean);
}

async function appendTwoPhaseStage({ journal, ledger, runId, stage, units, trackHeap }) {
  const plan = planFor(stage, units);
  const result = await runTwoPhaseStage({
    events: await journal.readStage(stage),
    plan,
    planMetadata: { benchmark: true },
    append: (type, payload) => journal.appendStage(stage, type, payload),
    prepareAttemptIdForUnit: (unit) => `prepare_${stableHash([runId, stage, unit.unit_id]).slice(0, 32)}`,
    commitAttemptIdForUnit: ({ unit, prepared }) =>
      `commit_${stableHash([runId, stage, unit.unit_id, prepared.proposal_hash]).slice(0, 32)}`,
    prepare: async ({ unit }) => {
      const identity = phaseIdentity(runId, stage, unit, 'prepare');
      const proposalHash = stableHash([stage, unit.unit_id, 'proposal']);
      const response = {
        success: true,
        status: 'succeeded',
        preparedHandle: `prepared_${stableHash([stage, unit.unit_id]).slice(0, 24)}`,
        proposalHash,
      };
      await ledger.append(identity, response);
      trackHeap();
      return {
        status: 'prepared',
        prepared: {
          prepared_handle: response.preparedHandle,
          proposal_hash: proposalHash,
        },
      };
    },
    commit: async ({ unit }) => {
      const identity = phaseIdentity(runId, stage, unit, 'commit');
      const response = resultResponse(stage, unit.unit_id);
      await ledger.append(identity, response);
      trackHeap();
      return { status: 'succeeded', payload: { result_ids: responseIds(response) } };
    },
    record: async () => {
      trackHeap();
    },
  });
  if (result.status !== 'completed') throw new Error(`v2_scale_stage_not_completed:${stage}`);
}

async function recoverAndValidate(rootDir, runId, trackHeap) {
  const started = performance.now();
  const journal = new RunStateJournalV2({ rootDir, runId });
  const control = await journal.open();
  if (control.at(-1)?.type !== 'run_completed') throw new Error('v2_scale_control_not_completed');
  const eventCounts = {};
  for (const stage of STAGES) {
    const events = await journal.readStage(stage.name);
    if (stage.mode === 'single') validateSinglePhaseStage(events);
    else validateTwoPhaseStage(events);
    eventCounts[stage.name] = events.length;
    trackHeap();
  }
  return {
    duration_ms: Number((performance.now() - started).toFixed(3)),
    control_event_count: control.length,
    stage_event_counts: eventCounts,
  };
}

async function runSample({ rootDir, runId, units }) {
  await fs.mkdir(rootDir);
  const journal = new RunStateJournalV2({ rootDir, runId });
  const ledger = new SerializedReceiptLedger(path.join(rootDir, RECEIPT_FILE));
  const baselineHeap = process.memoryUsage().heapUsed;
  let peakHeap = baselineHeap;
  const trackHeap = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };

  await journal.acquireLock();
  await journal.open();
  await ledger.open();
  try {
    await journal.appendControl('run_started', { format: 'v2', benchmark: 'isolated_eight_stage' });
    for (const stage of STAGES) {
      await journal.writeStatus({
        state: 'running',
        current_stage: stage.name,
        processed_units: units,
        total_units: units,
      });
      if (stage.mode === 'single') {
        await appendSingleStage({ journal, ledger, runId, stage: stage.name, units, trackHeap });
      } else {
        await appendTwoPhaseStage({ journal, ledger, runId, stage: stage.name, units, trackHeap });
      }
      trackHeap();
    }
    await journal.appendControl('run_completed', { stage_count: STAGES.length });
    await journal.writeStatus({
      state: 'completed',
      current_stage: null,
      completed_stage_count: STAGES.length,
    });
  } finally {
    await ledger.close();
    await journal.releaseLock();
  }

  const recovery = await recoverAndValidate(rootDir, runId, trackHeap);
  const files = await listFiles(rootDir);
  const receiptPath = path.join(rootDir, RECEIPT_FILE);
  const runnerFiles = files.filter((filePath) => path.basename(filePath) !== RECEIPT_FILE);
  const runnerBytes = (await Promise.all(runnerFiles.map(fileBytes))).reduce((sum, size) => sum + size, 0);
  const v1Files = files.filter((filePath) => V1_STATE_FILES.has(path.basename(filePath)));
  const receiptText = await fs.readFile(receiptPath, 'utf8');
  return {
    units_per_stage: units,
    stage_count: STAGES.length,
    runner_bytes: runnerBytes,
    runner_file_count: runnerFiles.length,
    status_bytes: await fileBytes(journal.statusPath),
    serialized_service_receipt_bytes: await fileBytes(receiptPath),
    service_receipt_count: ledger.count,
    peak_heap_bytes: peakHeap,
    peak_heap_delta_bytes: Math.max(0, peakHeap - baselineHeap),
    recovery,
    v1_snapshot_files: v1Files.map((filePath) => path.relative(rootDir, filePath)),
    receipt_projection_contains_narrative: /"narrative"\s*:/.test(receiptText),
  };
}

export async function runScaleVerification({ workDir, units = 100 } = {}) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('units_must_be_a_positive_integer');
  const artifactRoot = workDir
    ? path.resolve(workDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-scale-'));
  await fs.mkdir(artifactRoot, { recursive: true });
  const samples = [
    await runSample({ rootDir: path.join(artifactRoot, 'b0'), runId: 'scale-b0', units: 0 }),
    await runSample({ rootDir: path.join(artifactRoot, 'n'), runId: 'scale-n1', units }),
    await runSample({ rootDir: path.join(artifactRoot, '2n'), runId: 'scale-n2', units: units * 2 }),
  ];
  const [baseline, first, second] = samples;
  const runnerRatio = ratioFromBaseline(baseline.runner_bytes, first.runner_bytes, second.runner_bytes);
  const receiptRatio = ratioFromBaseline(
    baseline.serialized_service_receipt_bytes,
    first.serialized_service_receipt_bytes,
    second.serialized_service_receipt_bytes,
  );
  const runnerLinear = runnerRatio !== null && runnerRatio >= 1.9 && runnerRatio <= 2.1;
  const receiptsLinear = receiptRatio !== null && receiptRatio >= 1.9 && receiptRatio <= 2.1;
  const statusBounded = samples.every((sample) => sample.status_bytes <= 4096);
  const noV1Snapshots = samples.every((sample) => sample.v1_snapshot_files.length === 0);
  const receiptProjectionBounded = samples.every((sample) => !sample.receipt_projection_contains_narrative);
  return {
    schema_version: 1,
    benchmark_scope: 'isolated_eight_stage_release_candidate',
    measured_at: new Date().toISOString(),
    artifact_root: artifactRoot,
    stages: STAGES,
    sample_units: { n: units, two_n: units * 2 },
    metrics: {
      runner_growth_ratio: Number(runnerRatio?.toFixed(4)),
      serialized_service_receipt_growth_ratio: Number(receiptRatio?.toFixed(4)),
    },
    checks: {
      runner_growth_linear: runnerLinear,
      serialized_service_receipt_growth_linear: receiptsLinear,
      status_bounded_to_4k: statusBounded,
      no_v1_snapshot_files: noV1Snapshots,
      receipt_projection_excludes_summary_narrative: receiptProjectionBounded,
    },
    samples,
    release_decision: {
      default_format: 'v2',
      change_default: false,
      reason: 'default_already_switched_after_managed_canary',
    },
    limitations: [
      'StateKV 仅测量服务收据 JSON 序列化载荷，不代表 iii-engine SQLite、WAL 或页开销。',
      '模型与业务服务由确定性适配器替代；本工具验证恢复协议、事件规模和收据投影，不验证线上延迟。',
      '本工具不单独决定默认格式；默认切换依据还包括受管隔离测量、真实 provider canary 和正式发布门禁。',
    ],
  };
}

export function parseArguments(argv) {
  const options = { units: 100, workDir: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--units') {
      options.units = Number(argv[++index]);
    } else if (argument === '--work-dir') {
      options.workDir = argv[++index];
    } else if (argument === '--out') {
      options.out = argv[++index];
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.units) || options.units <= 0) {
    throw new Error('units_must_be_a_positive_integer');
  }
  if (options.workDir === undefined && argv.includes('--work-dir')) throw new Error('missing_value:--work-dir');
  if (options.out === undefined && argv.includes('--out')) throw new Error('missing_value:--out');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runScaleVerification(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const outputPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, output, 'utf8');
  }
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
