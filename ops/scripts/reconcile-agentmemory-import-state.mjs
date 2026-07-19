import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEFAULT_ENGINE_URL = 'ws://localhost:49134';
const DEFAULT_SESSION_SCOPE = 'mem:sessions';
const DEFAULT_SDK_PATH = '../../node_modules/iii-sdk/dist/index.mjs';

const HELP_TEXT = [
  '用法: node ops/scripts/reconcile-agentmemory-import-state.mjs --record <record_json> --out <missing_json> [options]',
  '',
  '--record       Selector 输出记录文件，例如 agentmemory-full-remaining.json。',
  '--out          输出缺失记录 JSON，可直接交给 run-agentmemory-cli-import-batch.mjs 补导。',
  '--engine-url   iii worker manager WebSocket 地址，默认 ws://localhost:49134。',
  '--session-scope AgentMemory session KV scope（键值存储分组），默认 mem:sessions。',
  '--batch-size   额外按 N 条切分缺失记录。',
  '--batch-dir    batch 输出目录；配合 --batch-size 使用。',
  '--sdk-path     iii-sdk dist/index.mjs 路径；默认使用 AgentMemory 仓库的本地依赖。',
  '--help         显示帮助。',
].join('\n');

function printHelp() {
  console.log(HELP_TEXT);
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`缺少 ${name} 的参数值`);
  }
  return value;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const result = {
    recordPath: '',
    outPath: '',
    engineUrl: DEFAULT_ENGINE_URL,
    sessionScope: DEFAULT_SESSION_SCOPE,
    batchSize: 0,
    batchDir: '',
    sdkPath: DEFAULT_SDK_PATH,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--record') {
      result.recordPath = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--out') {
      result.outPath = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--engine-url') {
      result.engineUrl = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--session-scope') {
      result.sessionScope = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--batch-size') {
      result.batchSize = parsePositiveInt(requireValue(argv, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--batch-dir') {
      result.batchDir = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--sdk-path') {
      result.sdkPath = requireValue(argv, i, arg);
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  if (result.help) return result;
  if (!result.recordPath) throw new Error('缺少 --record');
  if (!result.outPath) throw new Error('缺少 --out');
  if (result.batchDir && result.batchSize === 0) {
    throw new Error('--batch-dir 必须配合 --batch-size 使用');
  }
  return result;
}

function normalizeSelectorState(parsed) {
  if (Array.isArray(parsed)) {
    return {
      generated_at: new Date().toISOString(),
      records: parsed,
    };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
    throw new Error('记录文件必须是 JSON 数组或包含 records 数组的 JSON 对象');
  }
  return parsed;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function recordSessionId(record) {
  return nonEmptyString(record?.derived_session_id)
    || nonEmptyString(record?.session_id)
    || nonEmptyString(record?.sessionId);
}

function recordExpectedSessionId(record) {
  return nonEmptyString(record?.import_target_session_id)
    || nonEmptyString(record?.target_session_id)
    || recordSessionId(record);
}

function sessionId(session) {
  return nonEmptyString(session?.id)
    || nonEmptyString(session?.session_id)
    || nonEmptyString(session?.sessionId);
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function isNoSessionReplayImport(record) {
  if (record?.import_observation_candidates === 0) return true;

  const importCli = record?.import_cli;
  if (!importCli || importCli.exit_code !== 0) return false;

  if (importCli.result && typeof importCli.result === 'object') {
    const observations = Number(importCli.result.observations ?? 0);
    const sessionIds = Array.isArray(importCli.result.sessionIds) ? importCli.result.sessionIds : [];
    if (observations === 0 && sessionIds.length === 0) return true;
  }

  return /0 observation\(s\) across 0 session\(s\)/.test(importCli.stdout || '');
}

export function reconcileRecords(records, sessions) {
  const warnings = [];
  const recordIds = [];
  const expectedIds = [];
  const duplicateRecordIds = new Map();
  const missingRecordIdRecords = [];
  const recordIdCounts = new Map();
  const noSessionRecords = [];

  for (const record of records) {
    if (isNoSessionReplayImport(record)) {
      noSessionRecords.push(record);
      continue;
    }

    const id = recordSessionId(record);
    if (!id) {
      missingRecordIdRecords.push(record);
      continue;
    }
    recordIds.push(id);
    increment(recordIdCounts, id);

    const expectedId = recordExpectedSessionId(record);
    if (expectedId) expectedIds.push(expectedId);
  }

  for (const [id, count] of recordIdCounts.entries()) {
    if (count > 1) duplicateRecordIds.set(id, count);
  }

  const stateSessionIds = new Set();
  const duplicateStateIds = new Map();
  const stateIdCounts = new Map();
  for (const session of sessions) {
    const id = sessionId(session);
    if (!id) continue;
    increment(stateIdCounts, id);
    stateSessionIds.add(id);
  }
  for (const [id, count] of stateIdCounts.entries()) {
    if (count > 1) duplicateStateIds.set(id, count);
  }

  const distinctRecordIds = new Set(recordIds);
  const distinctExpectedIds = new Set(expectedIds);
  const missingIds = [...distinctExpectedIds].filter((id) => !stateSessionIds.has(id)).sort();
  const missingIdSet = new Set(missingIds);
  const matchedIds = [...distinctExpectedIds].filter((id) => stateSessionIds.has(id));
  const extraStateIds = [...stateSessionIds].filter((id) => !distinctExpectedIds.has(id)).sort();
  const missingRecords = records.filter((record) => {
    if (isNoSessionReplayImport(record)) return false;
    const id = recordExpectedSessionId(record);
    return id && missingIdSet.has(id);
  });

  if (missingRecordIdRecords.length > 0) {
    warnings.push({
      type: 'record_missing_session_id',
      count: missingRecordIdRecords.length,
      message: '部分记录缺少 derived_session_id/sessionId，无法参与 session 对账。',
    });
  }
  if (duplicateRecordIds.size > 0) {
    warnings.push({
      type: 'duplicate_record_session_ids',
      count: duplicateRecordIds.size,
      examples: [...duplicateRecordIds.entries()].slice(0, 10).map(([id, count]) => ({ id, count })),
    });
  }
  if (duplicateStateIds.size > 0) {
    warnings.push({
      type: 'duplicate_state_session_ids',
      count: duplicateStateIds.size,
      examples: [...duplicateStateIds.entries()].slice(0, 10).map(([id, count]) => ({ id, count })),
    });
  }

  return {
    missingRecords,
    warnings,
    summary: {
      record_count: records.length,
      distinct_record_session_ids: distinctRecordIds.size,
      distinct_expected_session_ids: distinctExpectedIds.size,
      agentmemory_session_count: sessions.length,
      distinct_agentmemory_session_ids: stateSessionIds.size,
      matched_record_session_ids: matchedIds.length,
      missing_record_session_ids: missingIds.length,
      missing_records: missingRecords.length,
      records_without_session_id: missingRecordIdRecords.length,
      skipped_no_session_records: noSessionRecords.length,
      duplicate_record_session_ids: duplicateRecordIds.size,
      duplicate_agentmemory_session_ids: duplicateStateIds.size,
      extra_agentmemory_session_ids: extraStateIds.length,
      first_missing_session_ids: missingIds.slice(0, 20),
      first_extra_agentmemory_session_ids: extraStateIds.slice(0, 20),
    },
  };
}

async function readJsonlObjects(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function countCodexReplayObservationCandidates(rows) {
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};

    if (row.type === 'response_item') {
      if ([
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
        'web_search_call',
        'tool_search_call',
        'tool_search_output',
      ].includes(payload.type)) count += 1;
      continue;
    }

    if (row.type !== 'event_msg') continue;
    if ([
      'exec_command_end',
      'patch_apply_end',
      'mcp_tool_call_end',
      'web_search_end',
      'error',
    ].includes(payload.type)) {
      count += 1;
      continue;
    }
    if (payload.type === 'user_message' && hasText(payload.message)) count += 1;
    if (payload.type === 'agent_message' && hasText(payload.message)) count += 1;
  }
  return count;
}

function countClaudeReplayObservationCandidates(rows) {
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const content = row.message && typeof row.message === 'object'
      ? row.message.content
      : undefined;
    if (typeof content === 'string' && content.trim()) {
      count += 1;
      continue;
    }
    if (Array.isArray(content) && content.some((item) => {
      if (typeof item === 'string') return item.trim().length > 0;
      return item && typeof item === 'object' && hasText(item.text);
    })) {
      count += 1;
    }
  }
  return count;
}

function countReplayObservationCandidates(rows) {
  return countCodexReplayObservationCandidates(rows)
    + countClaudeReplayObservationCandidates(rows);
}

export async function withImportTargetSession(record) {
  if (!record || typeof record !== 'object') return record;
  const filePath = nonEmptyString(record.absolute_path);
  if (!filePath) return record;

  const rows = await readJsonlObjects(filePath);
  const sessionMetaRow = rows.find((row) => row && typeof row === 'object' && row.type === 'session_meta');
  const claudeSessionRow = rows.find((row) =>
    row &&
    typeof row === 'object' &&
    nonEmptyString(row.sessionId)
  );
  if (!sessionMetaRow && !claudeSessionRow && rows.length === 0) return record;

  const payload =
    sessionMetaRow?.payload && typeof sessionMetaRow.payload === 'object'
      ? sessionMetaRow.payload
      : {};
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const sourceSessionId =
    nonEmptyString(payload.id) ||
    nonEmptyString(meta.id) ||
    nonEmptyString(claudeSessionRow?.sessionId) ||
    recordSessionId(record);
  const parentSessionId =
    nonEmptyString(payload.parent_thread_id) ||
    nonEmptyString(meta.parent_thread_id) ||
    (claudeSessionRow?.isSidechain === true
      ? nonEmptyString(claudeSessionRow.parentSessionId) || nonEmptyString(claudeSessionRow.parent_session_id)
      : undefined);
  const targetSessionId = sourceSessionId;
  if (!targetSessionId) return record;
  const lineage = parentSessionId
    ? (claudeSessionRow?.isSidechain === true && !sessionMetaRow ? 'sidechain' : 'child')
    : 'top-level';

  return {
    ...record,
    import_source_session_id: sourceSessionId,
    import_target_session_id: targetSessionId,
    import_parent_session_id: parentSessionId,
    import_lineage: lineage,
    import_observation_candidates: countReplayObservationCandidates(rows),
  };
}

export function chunkRecords(records, batchSize) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) return [];
  const chunks = [];
  for (let i = 0; i < records.length; i += batchSize) {
    chunks.push(records.slice(i, i + batchSize));
  }
  return chunks;
}

function outputState({ sourceState, sourceRecordPath, engineUrl, sessionScope, reconciliation, records, batch }) {
  const state = {
    generated_at: new Date().toISOString(),
    source_record: path.resolve(sourceRecordPath),
    engine_url: engineUrl,
    session_scope: sessionScope,
    reconciliation: reconciliation.summary,
    records,
    warnings: reconciliation.warnings,
  };
  if (sourceState.selection) state.source_selection = sourceState.selection;
  if (batch) state.batch = batch;
  return state;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readAgentMemorySessions({ engineUrl, sessionScope, sdkPath }) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedSdkPath = path.isAbsolute(sdkPath)
    ? sdkPath
    : path.resolve(scriptDir, sdkPath);
  const { registerWorker } = await import(pathToFileURL(resolvedSdkPath).href);
  const sdk = registerWorker(engineUrl, {
    workerName: 'agentmemory-import-reconcile',
    invocationTimeoutMs: 30_000,
    otel: { enabled: false },
  });
  const sessions = await sdk.trigger({
    function_id: 'state::list',
    payload: { scope: sessionScope },
    timeoutMs: 30_000,
  });
  if (!Array.isArray(sessions)) {
    throw new Error(`state::list ${sessionScope} 没有返回 session 数组`);
  }
  return sessions;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const recordPath = path.resolve(options.recordPath);
  const sourceState = normalizeSelectorState(JSON.parse(await fs.readFile(recordPath, 'utf8')));
  const records = await Promise.all(sourceState.records.map((record) => withImportTargetSession(record)));
  const sessions = await readAgentMemorySessions(options);
  const reconciliation = reconcileRecords(records, sessions);

  const outPath = path.resolve(options.outPath);
  await writeJson(outPath, outputState({
    sourceState,
    sourceRecordPath: recordPath,
    engineUrl: options.engineUrl,
    sessionScope: options.sessionScope,
    reconciliation,
    records: reconciliation.missingRecords,
  }));

  const batchFiles = [];
  if (options.batchSize > 0) {
    const batchDir = path.resolve(options.batchDir || `${outPath.replace(/\.json$/i, '')}-batches`);
    const chunks = chunkRecords(reconciliation.missingRecords, options.batchSize);
    for (let i = 0; i < chunks.length; i += 1) {
      const batchPath = path.join(batchDir, `missing-batch-${String(i + 1).padStart(3, '0')}.json`);
      await writeJson(batchPath, outputState({
        sourceState,
        sourceRecordPath: recordPath,
        engineUrl: options.engineUrl,
        sessionScope: options.sessionScope,
        reconciliation,
        records: chunks[i],
        batch: {
          index: i + 1,
          total: chunks.length,
          size: chunks[i].length,
          batch_size: options.batchSize,
        },
      }));
      batchFiles.push(batchPath);
    }
  }

  console.log(JSON.stringify({
    out: outPath,
    batch_files: batchFiles,
    summary: reconciliation.summary,
    warnings: reconciliation.warnings,
  }, null, 2));
  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
