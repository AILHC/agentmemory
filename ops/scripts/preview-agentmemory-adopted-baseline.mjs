import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADOPTED_BASELINE_PLAN_SCHEMA = 'agentmemory-adopted-baseline-plan/v1';
export const ADOPTED_BASELINE_PREVIEW_SCHEMA = 'agentmemory-adopted-baseline-preview/v1';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function coverageDigest(records) {
  return hash(records.map((record) => [
    record.stage,
    record.stageContractVersion,
    record.sessionId,
    record.normalizedContentHash,
  ]).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right), 'en')));
}

export function lessonSeedDigest(records) {
  return hash(records.map((record) => [
    record.lessonId,
    record.sourceVersionKey,
    record.normalizedContentHash,
  ]).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right), 'en')));
}

export function adoptedBaselinePreviewHash(preview) {
  const { preview_hash: _previewHash, ...payload } = preview;
  return hash(payload);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') options.baseUrl = argv[++index];
    else if (argument === '--plan') options.planPath = argv[++index];
    else if (argument === '--output') options.outputPath = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
    throw new Error('--base-url must be an HTTP URL');
  }
  for (const [flag, value] of [['--plan', options.planPath], ['--output', options.outputPath]]) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be absolute`);
  }
  return options;
}

function exactStringArray(value, name) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !item.trim())
    || new Set(value).size !== value.length
  ) throw new Error(`${name} must be a unique non-empty string array`);
  return value;
}

export function validatePlan(plan) {
  if (
    !plan
    || plan.schema !== ADOPTED_BASELINE_PLAN_SCHEMA
    || typeof plan.baseline_id !== 'string'
    || typeof plan.source_run_id !== 'string'
    || typeof plan.decision_ref !== 'string'
  ) throw new Error('adopted baseline plan is invalid');
  const historicalSessionIds = exactStringArray(plan.historical_session_ids, 'historical_session_ids');
  const currentSessionIds = exactStringArray(plan.current_session_ids, 'current_session_ids');
  const currentLessonIds = exactStringArray(plan.current_lesson_ids, 'current_lesson_ids');
  const retiredRunIds = exactStringArray(plan.retired_run_ids, 'retired_run_ids');
  if (!retiredRunIds.includes(plan.source_run_id)) {
    throw new Error('source_run_id must be retired');
  }
  if (historicalSessionIds.some((sessionId) => currentSessionIds.includes(sessionId))) {
    throw new Error('historical and current session sets must be disjoint');
  }
  return {
    baselineId: plan.baseline_id,
    sourceRunId: plan.source_run_id,
    retiredRunIds,
    decisionRef: plan.decision_ref,
    historicalSessionIds,
    currentSessionIds,
    currentLessonIds,
  };
}

async function request(baseUrl, secret, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/agentmemory/full/extraction-baseline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(360_000),
  });
  const result = await response.json();
  if (!response.ok || result?.success !== true) {
    throw new Error(result?.error || `HTTP ${response.status}`);
  }
  return result;
}

async function previewRecords(baseUrl, secret, baselineId, stage, sessionIds) {
  const records = [];
  for (let offset = 0; offset < sessionIds.length; offset += 100) {
    const page = sessionIds.slice(offset, offset + 100);
    const result = await request(baseUrl, secret, {
      action: 'preview_coverage',
      baselineId,
      stage,
      sessionIds: page,
    });
    records.push(...result.records);
  }
  return records;
}

async function previewLessonSeeds(baseUrl, secret, baselineId, lessonIds) {
  const records = [];
  for (let offset = 0; offset < lessonIds.length; offset += 100) {
    const page = lessonIds.slice(offset, offset + 100);
    const result = await request(baseUrl, secret, {
      action: 'preview_lesson_seed',
      baselineId,
      lessonIds: page,
    });
    records.push(...result.records);
  }
  return records;
}

export async function buildPreview({ baseUrl, secret, plan }) {
  const validated = validatePlan(plan);
  const allSessions = [...validated.historicalSessionIds, ...validated.currentSessionIds];
  const sessionSets = {
    summary: allSessions,
    lessons: allSessions,
    memory_consolidate: allSessions,
    semantic_rollup: validated.historicalSessionIds,
    skill_extract: validated.historicalSessionIds,
  };
  const coverage = {};
  for (const [stage, sessionIds] of Object.entries(sessionSets)) {
    const records = await previewRecords(
      baseUrl,
      secret,
      validated.baselineId,
      stage,
      sessionIds,
    );
    coverage[stage] = {
      stage_contract_version: records[0]?.stageContractVersion ?? null,
      count: records.length,
      digest: coverageDigest(records),
      records,
    };
  }
  const lessonSeeds = await previewLessonSeeds(
    baseUrl,
    secret,
    validated.baselineId,
    validated.currentLessonIds,
  );
  const preview = {
    schema: ADOPTED_BASELINE_PREVIEW_SCHEMA,
    baseline_id: validated.baselineId,
    source_run_id: validated.sourceRunId,
    retired_run_ids: validated.retiredRunIds,
    decision_ref: validated.decisionRef,
    historical_session_count: validated.historicalSessionIds.length,
    current_session_count: validated.currentSessionIds.length,
    current_lesson_count: validated.currentLessonIds.length,
    coverage,
    lesson_seed: {
      count: lessonSeeds.length,
      digest: lessonSeedDigest(lessonSeeds),
      records: lessonSeeds,
    },
    created_at: new Date().toISOString(),
  };
  return { ...preview, preview_hash: adoptedBaselinePreviewHash(preview) };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!secret) throw new Error('AGENTMEMORY_SECRET is required');
  const plan = JSON.parse(await fs.readFile(options.planPath, 'utf8'));
  const preview = await buildPreview({ baseUrl: options.baseUrl, secret, plan });
  await fs.writeFile(options.outputPath, `${JSON.stringify(preview, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`${JSON.stringify({
    baseline_id: preview.baseline_id,
    preview_hash: preview.preview_hash,
    output: options.outputPath,
  })}\n`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
