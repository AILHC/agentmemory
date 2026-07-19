import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = [
  '用法: node --env-file=<agentmemory.env> ops/scripts/run-agentmemory-extraction-batch.mjs --record <record_json> --base-url <url>',
  '',
  '--record       Task 8 执行记录 JSON。',
  '--base-url     AgentMemory REST 地址，例如 http://127.0.0.1:3111。',
  '--help         显示帮助。',
].join('\n');

const SUCCESS = 'success';
const MAX_GRAPH_PROCESS_ROUNDS = 50;

function parseArgs(argv) {
  const result = { recordPath: '', baseUrl: '', help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--record') {
      result.recordPath = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg === '--base-url') {
      result.baseUrl = argv[i + 1] || '';
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  if (result.help) return result;
  if (!result.recordPath) throw new Error('缺少 --record');
  if (!result.baseUrl) throw new Error('缺少 --base-url');
  return result;
}

function printHelp() {
  console.log(HELP_TEXT);
}

function redactSensitiveText(value) {
  if (value === undefined || value === null) return value;
  return String(value)
    .replace(/(AGENTMEMORY_SECRET\s*=\s*)[^\s"'`]+/gi, '$1<redacted>')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1<redacted>')
    .replace(/((?:access_)?token\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>')
    .replace(/(secret\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>');
}

function redactJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactJson);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]));
}

function compactResponse(value) {
  const redacted = redactJson(value);
  const text = JSON.stringify(redacted);
  if (text.length <= 12000) return redacted;
  return {
    truncated: true,
    preview: text.slice(0, 12000),
  };
}

async function writeStateAtomically(filePath, state) {
  const tempPath = `${filePath}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('记录文件必须是包含 records 数组的 JSON 对象');
  }
  if (!Array.isArray(parsed.records)) {
    throw new Error('记录文件缺少 records 数组');
  }
  return parsed;
}

function requireSecret() {
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!secret) {
    throw new Error('缺少 AGENTMEMORY_SECRET；请用 node --env-file=F:\\ai-runtime\\agentmemory\\home\\.env 运行本脚本');
  }
  return secret;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

async function requestJson(baseUrl, secret, method, apiPath, body) {
  const url = `${baseUrl}${apiPath}`;
  const startedAt = new Date().toISOString();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const rawText = await response.text();
  const endedAt = new Date().toISOString();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = { raw: redactSensitiveText(rawText) };
  }

  const result = {
    api_path: apiPath,
    method,
    status_code: response.status,
    ok: response.ok && parsed?.success !== false,
    started_at: startedAt,
    ended_at: endedAt,
    response: compactResponse(parsed),
  };

  if (!response.ok) {
    result.error = `HTTP ${response.status}`;
  } else if (parsed?.success === false) {
    result.error = redactSensitiveText(parsed?.error || 'application reported success=false');
  }

  Object.defineProperty(result, 'data', {
    value: parsed,
    enumerable: false,
  });

  return result;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function readFirstSessionIdFromJsonl(filePath, sourceTool) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;

    if (sourceTool === 'codex' && row.type === 'session_meta') {
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
      return firstString(payload.id, meta.id);
    }

    if (sourceTool === 'claude-code') {
      const sessionId = firstString(row.sessionId);
      if (sessionId) return sessionId;
    }
  }

  return '';
}

function detectTranscriptFormat(text, sourceTool) {
  if (sourceTool === 'codex' || sourceTool === 'claude-code') return sourceTool;
  let parsedRows = 0;
  let hasCodexMeta = false;
  let hasCodexEventOrItem = false;
  let hasClaudeShape = false;
  for (const line of text.split(/\r?\n/)) {
    if (parsedRows >= 20) break;
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
      parsedRows += 1;
    } catch {
      continue;
    }
    const type = typeof row?.type === 'string' ? row.type : null;
    if (type === 'session_meta') hasCodexMeta = true;
    if (type === 'event_msg' || type === 'response_item') hasCodexEventOrItem = true;
    if (type && ['user', 'assistant', 'summary', 'system'].includes(type) && typeof row?.message?.role === 'string') {
      hasClaudeShape = true;
    }
  }
  if (hasCodexMeta && hasCodexEventOrItem) return 'codex';
  if (hasClaudeShape) return 'claude-code';
  return 'unknown';
}

async function fallbackSessionId(filePath, sourceTool) {
  const text = await fs.readFile(filePath, 'utf8');
  const sourceFormat = detectTranscriptFormat(text, sourceTool);
  const sourceFileHash = createHash('sha256').update(text).digest('hex');
  return `sess_${createHash('sha256').update(`${sourceFormat}:${sourceFileHash}`).digest('hex').slice(0, 16)}`;
}

async function resolveSessionId(record, sessionIds) {
  const parsed = await readFirstSessionIdFromJsonl(record.absolute_path, record.source_tool);
  if (parsed && sessionIds.has(parsed)) {
    return { session_id: parsed, source: 'internal_jsonl_session_id' };
  }
  const fallback = await fallbackSessionId(record.absolute_path, record.source_tool);
  if (sessionIds.has(fallback)) {
    return { session_id: fallback, source: 'agentmemory_fallback_hash' };
  }
  return {
    session_id: parsed || fallback,
    source: parsed ? 'internal_jsonl_session_id_unverified' : 'agentmemory_fallback_hash_unverified',
    error: 'sessionId not found in /agentmemory/replay/sessions',
  };
}

function isStepSuccess(step) {
  return step?.status === SUCCESS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordStepResult(target, key, result) {
  target.extraction ??= {};
  target.extraction[key] = result;
}

function successStep(extra = {}) {
  return {
    status: SUCCESS,
    completed_at: new Date().toISOString(),
    ...extra,
  };
}

function failedStep(error, extra = {}) {
  return {
    ...extra,
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
  };
}

async function summarizeSessions(state, recordPath, baseUrl, secret) {
  let failed = 0;
  for (const item of state.records) {
    if (!item?.import_cli || item.import_cli.exit_code !== 0) continue;
    if (isStepSuccess(item.extraction?.summarize)) continue;
    try {
      const response = await requestJson(baseUrl, secret, 'POST', '/agentmemory/summarize', {
        sessionId: item.session_id,
      });
      if (!response.ok) throw new Error(response.error || 'summarize failed');
      recordStepResult(item, 'summarize', successStep({ request: { sessionId: item.session_id }, response }));
    } catch (error) {
      failed += 1;
      recordStepResult(item, 'summarize', failedStep(error, { request: { sessionId: item.session_id } }));
    }
    await writeStateAtomically(recordPath, state);
  }
  return failed;
}

async function runBatchStep(state, recordPath, key, baseUrl, secret, apiPath, body) {
  state.extraction ??= {};
  if (isStepSuccess(state.extraction[key])) return 0;

  try {
    const response = await requestJson(baseUrl, secret, 'POST', apiPath, body);
    if (!response.ok) throw new Error(response.error || `${key} failed`);
    state.extraction[key] = successStep({ request: body, response });
    await writeStateAtomically(recordPath, state);
    return 0;
  } catch (error) {
    state.extraction[key] = failedStep(error, { request: body });
    await writeStateAtomically(recordPath, state);
    return 1;
  }
}

function summarizeRunStatuses(runs) {
  const counts = {};
  for (const run of runs || []) {
    const status = typeof run?.status === 'string' ? run.status : 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function hasOnlyCompletedLessonRuns(runs) {
  return Array.isArray(runs) && runs.length > 0
    && runs.every((run) => run?.status === 'succeeded' || run?.status === 'skipped');
}

async function runLessonsExtract(state, recordPath, baseUrl, secret, sessionIds) {
  state.extraction ??= {};
  const existing = state.extraction.lessons_extract;
  if (isStepSuccess(existing) && existing.run_status_counts) return 0;

  const body = {
    sessionIds,
    missingOnly: true,
    retryFailed: true,
    force: false,
    timeoutMs: 120000,
    chunkSize: 20,
    chunkConcurrency: 1,
    textLimit: 1200,
    saveLimit: 50,
  };

  try {
    const response = await requestJson(baseUrl, secret, 'POST', '/agentmemory/lessons/extract', body);
    if (!response.ok) throw new Error(response.error || 'lessons extract failed');
    const runs = response.data?.runs || [];
    const runStatusCounts = summarizeRunStatuses(runs);
    if (!hasOnlyCompletedLessonRuns(runs)) {
      state.extraction.lessons_extract = failedStep('lesson extraction did not complete all runs', {
        request: body,
        response,
        run_status_counts: runStatusCounts,
      });
      await writeStateAtomically(recordPath, state);
      return 1;
    }
    state.extraction.lessons_extract = successStep({
      request: body,
      response,
      run_status_counts: runStatusCounts,
    });
    await writeStateAtomically(recordPath, state);
    return 0;
  } catch (error) {
    state.extraction.lessons_extract = failedStep(error, { request: body });
    await writeStateAtomically(recordPath, state);
    return 1;
  }
}

function extractTaskId(response) {
  const body = response?.data ?? response?.response;
  return firstString(body?.taskId, body?.task?.id, body?.task?.taskId, body?.id);
}

function isGraphTaskComplete(response) {
  const body = response?.data ?? response?.response;
  const status = firstString(body?.status, body?.task?.status).toLowerCase();
  if (['complete', 'completed', 'done', 'success', 'succeeded'].includes(status)) return true;
  if (body?.complete === true || body?.completed === true || body?.done === true) return true;
  if (body?.task?.completedAt || body?.task?.finishedAt) return true;
  return false;
}

function graphTaskFromResponse(response) {
  return response?.data?.task || response?.response?.task;
}

function graphResponseHasCircuitBreakerFailure(response) {
  const task = graphTaskFromResponse(response);
  const lastError = String(task?.lastError || response?.data?.lastError || response?.response?.lastError || '');
  const failedBatches = Number(response?.data?.failedBatches ?? response?.response?.failedBatches ?? 0);
  return failedBatches > 0 && /circuit_breaker_open/i.test(lastError);
}

async function waitForGraphLease(task) {
  const leaseUntil = Date.parse(task?.leaseUntil || '');
  if (!Number.isFinite(leaseUntil)) return;
  const waitMs = Math.min(Math.max(0, leaseUntil - Date.now() + 500), 65000);
  if (waitMs > 0) await sleep(waitMs);
}

async function runGraphBuild(state, recordPath, baseUrl, secret) {
  state.extraction ??= {};
  if (isStepSuccess(state.extraction.graph_build)) return 0;

  const graph = state.extraction.graph_build || {};
  try {
    let createResponse = graph.create_response;
    let taskId = graph.task_id;
    if (!taskId) {
      createResponse = await requestJson(baseUrl, secret, 'POST', '/agentmemory/graph/build', {});
      if (!createResponse.ok) throw new Error(createResponse.error || 'graph build create failed');
      taskId = extractTaskId(createResponse);
      graph.create_response = createResponse;
      graph.task_id = taskId;
      graph.status = taskId ? 'processing' : SUCCESS;
      state.extraction.graph_build = graph;
      await writeStateAtomically(recordPath, state);
    }

    if (!taskId) {
      state.extraction.graph_build = successStep({ create_response: createResponse });
      await writeStateAtomically(recordPath, state);
      return 0;
    }

    graph.process_responses ??= [];
    for (let round = graph.process_responses.length; round < MAX_GRAPH_PROCESS_ROUNDS; round += 1) {
      const response = await requestJson(baseUrl, secret, 'POST', '/agentmemory/graph/build/process', {
        taskId,
        maxBatches: 20,
      });
      graph.process_responses.push(response);
      graph.updated_at = new Date().toISOString();
      state.extraction.graph_build = graph;
      await writeStateAtomically(recordPath, state);
      if (response.status_code === 409 && response.data?.error === 'task is already running') {
        await waitForGraphLease(graphTaskFromResponse(response));
        continue;
      }
      if (!response.ok) throw new Error(response.error || 'graph build process failed');
      if (graphResponseHasCircuitBreakerFailure(response)) {
        throw new Error('graph build failed: circuit_breaker_open');
      }
      if (isGraphTaskComplete(response)) {
        state.extraction.graph_build = successStep({
          task_id: taskId,
          create_response: graph.create_response,
          process_responses: graph.process_responses,
        });
        await writeStateAtomically(recordPath, state);
        return 0;
      }
      await waitForGraphLease(graphTaskFromResponse(response));
    }

    state.extraction.graph_build = {
      ...graph,
      status: 'pending',
      error: `graph build task not complete after ${MAX_GRAPH_PROCESS_ROUNDS} process rounds`,
    };
    await writeStateAtomically(recordPath, state);
    return 1;
  } catch (error) {
    state.extraction.graph_build = failedStep(error, graph);
    await writeStateAtomically(recordPath, state);
    return 1;
  }
}

async function resolveAllSessionIds(state, recordPath, baseUrl, secret) {
  state.extraction ??= {};
  if (isStepSuccess(state.extraction.resolve_session_ids)) return 0;

  const response = await requestJson(baseUrl, secret, 'GET', '/agentmemory/replay/sessions');
  if (!response.ok) {
    state.extraction.resolve_session_ids = failedStep(response.error || 'session query failed', { response });
    await writeStateAtomically(recordPath, state);
    return 1;
  }

  const sessions = response.data?.sessions || response.response?.sessions || [];
  const sessionIds = new Set(sessions.map((session) => session?.id).filter((id) => typeof id === 'string' && id));
  let failed = 0;
  for (const item of state.records) {
    if (!item?.import_cli || item.import_cli.exit_code !== 0) continue;
    const resolved = await resolveSessionId(item, sessionIds);
    item.session_id = resolved.session_id;
    item.session_id_source = resolved.source;
    if (resolved.error) {
      failed += 1;
      item.session_id_error = resolved.error;
    } else {
      delete item.session_id_error;
    }
  }

  state.extraction.resolve_session_ids = failed === 0
    ? successStep({ session_count: sessionIds.size })
    : failedStep(`${failed} sessionIds were not verified`, { session_count: sessionIds.size });
  await writeStateAtomically(recordPath, state);
  return failed;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const secret = requireSecret();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const recordPath = path.resolve(options.recordPath);
  const state = normalizeState(JSON.parse(await fs.readFile(recordPath, 'utf8')));
  let failed = 0;

  failed += await resolveAllSessionIds(state, recordPath, baseUrl, secret);
  if (failed > 0) throw new Error('sessionIds 解析失败，未进入提炼阶段');

  failed += await summarizeSessions(state, recordPath, baseUrl, secret);

  const sessionIds = state.records
    .filter((item) => item?.import_cli?.exit_code === 0 && typeof item.session_id === 'string' && item.session_id)
    .map((item) => item.session_id);

  failed += await runLessonsExtract(state, recordPath, baseUrl, secret, sessionIds);

  failed += await runBatchStep(state, recordPath, 'consolidate', baseUrl, secret, '/agentmemory/consolidate', {});
  failed += await runBatchStep(state, recordPath, 'consolidate_pipeline', baseUrl, secret, '/agentmemory/consolidate-pipeline', {});
  failed += await runGraphBuild(state, recordPath, baseUrl, secret);

  state.extraction ??= {};
  state.extraction.last_completed_at = new Date().toISOString();
  await writeStateAtomically(recordPath, state);

  if (failed > 0) {
    throw new Error(`提炼批处理存在 ${failed} 个失败项，已写入执行记录，可修复后重跑。`);
  }

  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(redactSensitiveText(error.message || String(error)));
    process.exitCode = 1;
  });
}
