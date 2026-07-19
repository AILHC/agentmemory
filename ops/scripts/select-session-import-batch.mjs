import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const CODEX = 'codex';
const CLAUDE_CODE = 'claude-code';
const ALLOWED_TOOLS = new Set([CODEX, CLAUDE_CODE]);
const TOOL_ORDER = [CODEX, CLAUDE_CODE];
const TOOL_PRIORITY = Object.fromEntries(TOOL_ORDER.map((item, index) => [item, index]));
const ROLLOUT_RE = /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/;

const HELP_TEXT = [
  '用法: node ops/scripts/select-session-import-batch.mjs --state-dir <state_dir> --out <out_json> [--codex <N>] [--claude-code <N>] [--codex-child <N>] [--codex-parents-from <child_record_json>] [--all] [--exclude-record <json>]',
  '',
  '--state-dir     会话源状态目录。',
  '--out           输出文件路径。',
  '--codex         Codex 取最早 N 个（默认 20）。',
  '--claude-code   Claude Code 取最早 N 个（默认 20）。',
  '--codex-child   只取真实 Codex child 记录，最多 N 个（默认 0）；启用时要求 --codex 0 --claude-code 0。',
  '--codex-parents-from 从 child selector 输出识别并选择真实 Codex parent；要求所有计数为 0，且不得与 --all 共用。',
  '--all           选择去重后的全部 Codex 和 Claude Code 记录。',
  '--exclude-record 从另一个 selector 输出中按 source_tool + raw_hash 排除记录，可重复传。',
  '--help          显示帮助。',
].join('\n');

const TIMESTAMP_KEYS = [
  'timestamp',
  'time',
  'created_at',
  'createdAt',
  'event_time',
  'eventTime',
  'started_at',
  'startedAt',
  'date',
  'datetime',
  'ts',
  'unix_ts',
  'unixTs',
];

function printHelp() {
  console.log(HELP_TEXT);
}

function parseNumber(value, name) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} 必须是非负整数`);
  }
  return n;
}

function parseNonNegativeInteger(value, name) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} 必须是非负整数`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`--${name} 必须是非负整数`);
  }
  return n;
}

function parseArgs(argv) {
  const result = {
    codex: 20,
    claudeCode: 20,
    codexChild: 0,
    codexParentsFrom: '',
    stateDir: '',
    out: '',
    all: false,
    excludeRecords: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--state-dir') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --state-dir 的参数值');
      }
      result.stateDir = value;
      i += 1;
      continue;
    }

    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --out 的参数值');
      }
      result.out = value;
      i += 1;
      continue;
    }

    if (arg === '--codex') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --codex 的参数值');
      }
      result.codex = parseNumber(value, 'codex');
      i += 1;
      continue;
    }

    if (arg === '--claude-code') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --claude-code 的参数值');
      }
      result.claudeCode = parseNumber(value, 'claude-code');
      i += 1;
      continue;
    }

    if (arg === '--codex-child') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --codex-child 的参数值');
      }
      result.codexChild = parseNonNegativeInteger(value, 'codex-child');
      i += 1;
      continue;
    }

    if (arg === '--codex-parents-from') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --codex-parents-from 的参数值');
      }
      result.codexParentsFrom = value;
      i += 1;
      continue;
    }

    if (arg === '--all') {
      result.all = true;
      continue;
    }

    if (arg === '--exclude-record') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --exclude-record 的参数值');
      }
      result.excludeRecords.push(value);
      i += 1;
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
  }

  if (result.help) {
    return result;
  }

  if (!result.stateDir) {
    throw new Error('缺少 --state-dir');
  }

  if (!result.out) {
    throw new Error('缺少 --out');
  }

  if (result.codexChild > 0) {
    if (result.all) {
      throw new Error('--codex-child > 0 时不得与 --all 同时使用');
    }
    if (result.codex !== 0 || result.claudeCode !== 0) {
      throw new Error('--codex-child > 0 是独立选择模式，必须同时指定 --codex 0 和 --claude-code 0');
    }
  }

  if (result.codexParentsFrom) {
    if (result.all) {
      throw new Error('--codex-parents-from 不得与 --all 同时使用');
    }
    if (result.codex !== 0 || result.claudeCode !== 0 || result.codexChild !== 0) {
      throw new Error('--codex-parents-from 是独立选择模式，必须同时指定 --codex 0、--claude-code 0 和 --codex-child 0');
    }
  }

  return result;
}

async function readExcludeKeys(recordPaths) {
  const keys = new Set();
  const warnings = [];
  for (const recordPath of recordPaths) {
    try {
      const raw = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      if (!Array.isArray(raw.records)) {
        warnings.push({ type: 'exclude_record_invalid', path: recordPath, message: '缺少 records 数组' });
        continue;
      }
      for (const record of raw.records) {
        const tool = safeString(record?.source_tool);
        const hash = safeString(record?.raw_hash);
        if (tool && hash) keys.add(`${tool}\0${hash}`);
      }
    } catch (error) {
      warnings.push({
        type: 'exclude_record_read_failed',
        path: recordPath,
        message: error?.message || String(error),
      });
    }
  }
  return { keys, warnings };
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function readJsonl(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) {
      return { records: [], warnings: [] };
    }

    const records = [];
    const warnings = [];
    const lines = raw.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        warnings.push({
          source: label,
          index: i + 1,
          message: '非法 JSON 行',
        });
      }
    }

    return { records, warnings };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { records: [], warnings: [] };
    }
    throw error;
  }
}

function normalizeManifestRecord(raw) {
  const sourceTool = safeString(raw?.source_tool);
  if (!ALLOWED_TOOLS.has(sourceTool)) {
    return null;
  }

  const sourceName = safeString(raw.source_name);
  const relativeSourcePath = safeString(raw.relative_source_path);
  const vaultRelpath = safeString(raw.vault_relpath);
  const rawHash = safeString(raw.raw_hash);

  if (!sourceName || !relativeSourcePath || !vaultRelpath || !rawHash) {
    return null;
  }

  const nodeName = safeString(raw.node_name);
  const originNodeName = safeString(raw.origin_node_name);
  if (!nodeName && !originNodeName) {
    return null;
  }

  const normalized = {
    source_tool: sourceTool,
    source_name: sourceName,
    relative_source_path: relativeSourcePath,
    vault_relpath: vaultRelpath,
    raw_hash: rawHash,
  };

  if (nodeName) {
    normalized.node_name = nodeName;
  } else {
    normalized.origin_node_name = originNodeName;
  }

  return normalized;
}

function resolveAbsolutePath(stateDir, vaultRelpath) {
  if (!vaultRelpath || path.isAbsolute(vaultRelpath)) {
    return { ok: false, reason: 'vault_relpath 无效', value: '' };
  }

  const safeParts = vaultRelpath.split(/[\\/]+/).filter(Boolean);
  if (!safeParts.length || (safeParts[0] !== 'vault' && safeParts[0] !== 'remote-vault')) {
    return { ok: false, reason: `vault_relpath 不在 vault/remote-vault 下: ${vaultRelpath}`, value: '' };
  }

  const stateAbsolute = path.resolve(stateDir);
  const absolute = path.resolve(stateAbsolute, vaultRelpath);
  const relativeToState = path.relative(stateAbsolute, absolute);

  if (relativeToState.startsWith('..') || path.isAbsolute(relativeToState)) {
    return { ok: false, reason: `vault_relpath 越界: ${vaultRelpath}`, value: '' };
  }

  return { ok: true, value: absolute };
}

function parseTimeFromFilename(inputPath) {
  const baseName = path.basename(inputPath);
  const match = baseName.match(ROLLOUT_RE);
  if (!match) {
    return null;
  }

  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
  const epoch = Date.parse(iso);
  if (Number.isNaN(epoch)) {
    return null;
  }

  return {
    source: 'filename',
    epoch,
    value: iso,
  };
}

function parseTimestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = value < 1e12 ? value * 1000 : value;
    const date = new Date(epoch);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) {
    return direct;
  }

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    return parseTimestampValue(asNumber);
  }

  return null;
}

function findTimestampEpoch(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 4) {
    return null;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const epoch = findTimestampEpoch(item, depth + 1);
      if (epoch !== null) {
        return epoch;
      }
    }
    return null;
  }

  for (const key of TIMESTAMP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const parsed = parseTimestampValue(data[key]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  const nestedKeys = ['payload', 'message', 'event', 'data', 'metadata', 'body'];
  for (const key of nestedKeys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const parsed = findTimestampEpoch(data[key], depth + 1);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

async function readFirstTimestampFromVault(absolutePath) {
  try {
    const stream = createReadStream(absolutePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        const json = JSON.parse(line);
        const epoch = findTimestampEpoch(json);
        if (epoch !== null) {
          return {
            source: 'vault_jsonl_first_event',
            epoch,
            value: new Date(epoch).toISOString(),
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function readCodexParentSessionId(absolutePath) {
  try {
    const stream = createReadStream(absolutePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        const json = JSON.parse(line);
        const directParent = safeString(json?.payload?.parent_thread_id);
        const metaParent = safeString(json?.payload?.meta?.parent_thread_id);
        if (directParent || metaParent) {
          return directParent || metaParent;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // 调用方只记录计数，避免把路径或 JSONL 内容带入输出。
  }

  return '';
}

async function isCodexChild(absolutePath) {
  return Boolean(await readCodexParentSessionId(absolutePath));
}

async function readCodexSourceSessionId(absolutePath) {
  try {
    const stream = createReadStream(absolutePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        const json = JSON.parse(line);
        if (!json || typeof json !== 'object' || json.type !== 'session_meta') {
          continue;
        }
        const payload = json.payload && typeof json.payload === 'object' ? json.payload : {};
        const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
        return safeString(payload.id) || safeString(meta.id);
      } catch {
        continue;
      }
    }
  } catch {
    // 调用方只记录计数，避免把路径或 JSONL 内容带入输出。
  }

  return '';
}

async function readCodexParentReferences(recordPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  } catch {
    throw new Error('--codex-parents-from 文件无法读取或不是合法 JSON');
  }
  if (!Array.isArray(parsed?.records)) {
    throw new Error('--codex-parents-from 文件缺少 records 数组');
  }

  const parentIds = new Set();
  let identified = 0;
  let childWithoutParent = 0;
  for (const record of parsed.records) {
    const absolutePath = safeString(record?.absolute_path);
    if (safeString(record?.source_tool) !== CODEX || !absolutePath) {
      childWithoutParent += 1;
      continue;
    }
    const parentSessionId = await readCodexParentSessionId(absolutePath);
    if (!parentSessionId) {
      childWithoutParent += 1;
      continue;
    }
    identified += 1;
    parentIds.add(parentSessionId);
  }

  return {
    requested: parsed.records.length,
    identified,
    parentIds,
    duplicateParentReferences: identified - parentIds.size,
    childWithoutParent,
  };
}

async function normalizeRecord(raw, stateDir, sourceIndex) {
  const normalized = normalizeManifestRecord(raw);
  if (!normalized) {
    return null;
  }

  const resolved = resolveAbsolutePath(stateDir, normalized.vault_relpath);
  if (!resolved.ok) {
    return {
      __skipReason: resolved.reason,
      source_tool: normalized.source_tool,
      absolute_path: '',
      __sourceIndex: sourceIndex,
    };
  }

  const fallbackFileNameSource = normalized.relative_source_path || normalized.vault_relpath;
  let sessionStarted = parseTimeFromFilename(fallbackFileNameSource);

  if (normalized.source_tool === CLAUDE_CODE && !sessionStarted) {
    sessionStarted = await readFirstTimestampFromVault(resolved.value);
  }

  const record = {
    source_tool: normalized.source_tool,
    source_name: normalized.source_name,
    raw_hash: normalized.raw_hash,
    vault_relpath: normalized.vault_relpath,
    relative_source_path: normalized.relative_source_path,
    absolute_path: resolved.value,
    session_started_at: sessionStarted?.value || '',
    session_started_at_source: sessionStarted?.source || 'unknown',
    __session_started_at_epoch: sessionStarted?.epoch ?? Number.MAX_SAFE_INTEGER,
    __sourceIndex: sourceIndex,
  };

  if (normalized.node_name) {
    record.node_name = normalized.node_name;
  } else {
    record.origin_node_name = normalized.origin_node_name;
  }

  return record;
}

function comparator(a, b) {
  const aTool = TOOL_PRIORITY[a.source_tool] ?? Number.MAX_SAFE_INTEGER;
  const bTool = TOOL_PRIORITY[b.source_tool] ?? Number.MAX_SAFE_INTEGER;

  if (aTool !== bTool) {
    return aTool - bTool;
  }

  if (a.__session_started_at_epoch !== b.__session_started_at_epoch) {
    return a.__session_started_at_epoch - b.__session_started_at_epoch;
  }

  const pathCompare = a.absolute_path.localeCompare(b.absolute_path, 'en-US');
  if (pathCompare !== 0) {
    return pathCompare;
  }

  return a.__sourceIndex - b.__sourceIndex;
}

function parseSelectionOutput(items, limit) {
  return {
    matched: items.length,
    selected: Math.min(items.length, limit),
  };
}

function dedupeByRawHash(sortedItems) {
  const seen = new Set();
  const deduped = [];
  const duplicates = [];

  for (const item of sortedItems) {
    const key = `${item.source_tool}\0${item.raw_hash}`;
    if (seen.has(key)) {
      duplicates.push(item);
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return { deduped, duplicates };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return 0;
  }

  const stateDir = path.resolve(options.stateDir);
  const childMode = options.codexChild > 0;
  const parentMode = Boolean(options.codexParentsFrom);
  const parentReferences = parentMode
    ? await readCodexParentReferences(path.resolve(options.codexParentsFrom))
    : {
        requested: 0,
        identified: 0,
        parentIds: new Set(),
        duplicateParentReferences: 0,
        childWithoutParent: 0,
      };

  const manifest = await readJsonl(path.join(stateDir, 'manifest.jsonl'), 'manifest.jsonl');
  const remoteManifest = await readJsonl(path.join(stateDir, 'remote-manifest.jsonl'), 'remote-manifest.jsonl');

  const merged = [...manifest.records, ...remoteManifest.records];
  const warnings = [...manifest.warnings, ...remoteManifest.warnings];

  const candidates = [];
  const matchedParentIds = new Set();
  let codexChildScannedRecords = 0;
  for (let i = 0; i < merged.length; i += 1) {
    if ((childMode || parentMode) && safeString(merged[i]?.source_tool) !== CODEX) {
      continue;
    }
    const candidate = await normalizeRecord(merged[i], stateDir, i);
    if (!candidate) {
      continue;
    }
    if (candidate.__skipReason) {
      warnings.push({
        type: 'skip_record',
        source_tool: candidate.source_tool,
        message: candidate.__skipReason,
      });
      continue;
    }
    if (childMode) {
      codexChildScannedRecords += 1;
      if (!await isCodexChild(candidate.absolute_path)) {
        continue;
      }
    }
    if (parentMode) {
      const sourceSessionId = await readCodexSourceSessionId(candidate.absolute_path);
      if (!sourceSessionId || !parentReferences.parentIds.has(sourceSessionId)) {
        continue;
      }
      matchedParentIds.add(sourceSessionId);
    }
    candidates.push(candidate);
  }

  const unmatchedParents = parentMode
    ? parentReferences.parentIds.size - matchedParentIds.size
    : 0;
  if (parentMode && parentReferences.duplicateParentReferences > 0) {
    warnings.push({
      type: 'codex_parent_duplicate_references',
      count: parentReferences.duplicateParentReferences,
    });
  }
  if (parentMode && parentReferences.childWithoutParent > 0) {
    warnings.push({
      type: 'codex_parent_child_without_parent',
      count: parentReferences.childWithoutParent,
    });
  }
  if (parentMode && unmatchedParents > 0) {
    warnings.push({ type: 'codex_parent_unmatched', count: unmatchedParents });
  }

  const codexAll = candidates.filter((item) => item.source_tool === CODEX).sort(comparator);
  const claudeAll = candidates.filter((item) => item.source_tool === CLAUDE_CODE).sort(comparator);
  const codexCandidates = dedupeByRawHash(codexAll);
  const claudeCandidates = dedupeByRawHash(claudeAll);
  const exclude = await readExcludeKeys(options.excludeRecords);
  warnings.push(...exclude.warnings);
  const filterExcluded = (items) => items.filter((item) => !exclude.keys.has(`${item.source_tool}\0${item.raw_hash}`));
  const codexDeduped = filterExcluded(codexCandidates.deduped);
  const claudeDeduped = filterExcluded(claudeCandidates.deduped);
  const codexLimit = parentMode
    ? codexDeduped.length
    : childMode
      ? options.codexChild
      : options.all
        ? codexDeduped.length
        : options.codex;
  const claudeLimit = childMode || parentMode ? 0 : options.all ? claudeDeduped.length : options.claudeCode;
  const selected = [
    ...codexDeduped.slice(0, codexLimit),
    ...claudeDeduped.slice(0, claudeLimit),
  ]
    .sort(comparator);

  const output = {
    generated_at: new Date().toISOString(),
    state_dir: stateDir,
    selection: {
      mode: parentMode ? 'codex_parents' : childMode ? 'codex_child' : 'standard',
      requested: {
        codex: options.codex,
        claude_code: options.claudeCode,
        codex_child: options.codexChild,
      },
      count_by_tool: {
        codex: {
          ...parseSelectionOutput(codexDeduped, codexLimit),
          raw_records: codexAll.length,
          duplicate_raw_hash_records: codexCandidates.duplicates.length,
          excluded_raw_hash_records: codexCandidates.deduped.length - codexDeduped.length,
        },
        claude_code: {
          ...parseSelectionOutput(claudeDeduped, claudeLimit),
          raw_records: claudeAll.length,
          duplicate_raw_hash_records: claudeCandidates.duplicates.length,
          excluded_raw_hash_records: claudeCandidates.deduped.length - claudeDeduped.length,
        },
      },
      codex_child: {
        enabled: childMode,
        requested: options.codexChild,
        scanned_records: childMode ? codexChildScannedRecords : 0,
        identified_records: childMode ? codexCandidates.deduped.length : 0,
        matched: childMode ? codexDeduped.length : 0,
        selected: childMode ? selected.length : 0,
        duplicate_raw_hash_records: childMode ? codexCandidates.duplicates.length : 0,
        excluded_raw_hash_records: childMode ? codexCandidates.deduped.length - codexDeduped.length : 0,
      },
      codex_parents: {
        enabled: parentMode,
        requested: parentMode ? parentReferences.requested : 0,
        identified: parentMode ? parentReferences.identified : 0,
        unique_parents: parentMode ? parentReferences.parentIds.size : 0,
        matched: parentMode ? matchedParentIds.size : 0,
        matched_source_records: parentMode ? codexAll.length : 0,
        selected: parentMode ? selected.length : 0,
        unmatched: unmatchedParents,
        duplicate_parent_references: parentMode ? parentReferences.duplicateParentReferences : 0,
        child_without_parent: parentMode ? parentReferences.childWithoutParent : 0,
        duplicate_raw_hash_records: parentMode ? codexCandidates.duplicates.length : 0,
        excluded_raw_hash_records: parentMode ? codexCandidates.deduped.length - codexDeduped.length : 0,
      },
      total: {
        raw_records: candidates.length,
        selected_records: selected.length,
      },
    },
    records: selected.map((item) => {
      const record = { ...item };
      delete record.__session_started_at_epoch;
      delete record.__sourceIndex;
      return record;
    }),
    warnings,
  };

  const outputPath = path.resolve(options.out);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
