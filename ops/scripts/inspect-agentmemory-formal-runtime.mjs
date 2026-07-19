import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STATE_DIR = 'F:\\ai-runtime\\agentmemory\\home\\data\\state_store.db';
const FORBIDDEN_SESSION_SOURCE_ROOT = 'F:\\ai-runtime\\session-source';
const KEY_FILE_EXTENSION = '.bin';
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const HELP_TEXT = [
  '用法: node ops/scripts/inspect-agentmemory-formal-runtime.mjs [options]',
  '',
  '--state-dir <path>  StateKV（状态键值存储）目录；默认使用正式状态目录。',
  '--out <path>        可选 JSON（结构化数据）报告路径；未提供时输出到 stdout（标准输出）。',
  '--expected-empty    期望受管状态为空；发现受管键文件时返回非零退出码。',
  '--help              显示帮助。',
  '',
  '脚本只读取目录项和文件元数据，不读取 StateKV 值、JSONL（逐行 JSON）正文或凭据文件。',
].join('\n');

const SHARED_SCOPE_CATEGORIES = [
  ['summaries', 'mem:summaries', 'summary（总结）'],
  ['lessons', 'mem:lessons', 'lesson（经验）'],
  ['semantic', 'mem:semantic', 'semantic（语义记忆）'],
  ['procedural', 'mem:procedural', 'procedural（程序性记忆）'],
  ['crystals', 'mem:crystals', 'crystal（结晶）'],
  ['insights', 'mem:insights', 'insight（洞察）'],
];

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`缺少 ${option} 的参数值`);
  }
  return value;
}

function isDriveAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function comparisonPath(value) {
  if (isDriveAbsolute(value)) {
    return path.win32.resolve(value).replaceAll('/', '\\').toLowerCase();
  }
  return path.resolve(value).toLowerCase();
}

function isSameOrDescendant(candidate, root) {
  const normalizedCandidate = comparisonPath(candidate);
  const normalizedRoot = comparisonPath(root);
  const separator = isDriveAbsolute(root) ? '\\' : path.sep;
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${separator}`)
  );
}

function requireAbsolutePath(value, option) {
  if (!path.isAbsolute(value) && !isDriveAbsolute(value)) {
    throw new Error(`${option} 必须是绝对路径`);
  }
}

export function parseArgs(argv) {
  const result = {
    stateDir: DEFAULT_STATE_DIR,
    outPath: '',
    expectedEmpty: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--state-dir') {
      result.stateDir = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--out') {
      result.outPath = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--expected-empty') {
      result.expectedEmpty = true;
      continue;
    }
    throw new Error(`未知参数: ${argument}`);
  }

  if (result.help) return result;
  requireAbsolutePath(result.stateDir, '--state-dir');
  if (result.outPath) {
    requireAbsolutePath(result.outPath, '--out');
    result.outPath = isDriveAbsolute(result.outPath)
      ? path.win32.resolve(result.outPath)
      : path.resolve(result.outPath);
  }
  return result;
}

function decodeStateKeyFileName(fileName) {
  if (!fileName.endsWith(KEY_FILE_EXTENSION)) return null;
  const encoded = fileName.slice(0, -KEY_FILE_EXTENSION.length);
  const bytes = [];

  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === '%') {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const code = encoded.charCodeAt(index);
    if (code > 0x7f) return null;
    bytes.push(code);
  }

  try {
    return utf8Decoder.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function isClassifiedManagedKey(key) {
  if (key === 'mem:sessions') return true;
  if (key.startsWith('mem:obs:')) return true;
  if (SHARED_SCOPE_CATEGORIES.some(([, scope]) => key === scope)) return true;
  return key === 'mem:index:bm25' || key.startsWith('mem:index:bm25:');
}

function isManagedKey(key) {
  return key.startsWith('mem:');
}

function detailedCategoryForKey(key) {
  if (key === 'mem:sessions') return 'sessions';
  if (key.startsWith('mem:obs:')) return 'observationBuckets';
  const shared = SHARED_SCOPE_CATEGORIES.find(([, scope]) => key === scope);
  if (shared) return shared[0];
  if (key === 'mem:index:bm25' || key.startsWith('mem:index:bm25:')) {
    return 'bm25Chunks';
  }
  return null;
}

async function realPathIfPresent(value) {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function resolveThroughExistingAncestor(value) {
  const pathApi = isDriveAbsolute(value) ? path.win32 : path;
  let current = pathApi.resolve(value);
  const missingSegments = [];

  while (true) {
    try {
      const resolvedAncestor = await fs.realpath(current);
      return pathApi.join(resolvedAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = pathApi.dirname(current);
      if (parent === current) return pathApi.resolve(value);
      missingSegments.push(pathApi.basename(current));
      current = parent;
    }
  }
}

export async function validateOutputPath(outPath, stateDir) {
  requireAbsolutePath(outPath, '--out');
  if (isSameOrDescendant(outPath, FORBIDDEN_SESSION_SOURCE_ROOT)) {
    throw new Error('拒绝把 --out 写入 F:\\ai-runtime\\session-source 及其子路径');
  }
  if (isSameOrDescendant(outPath, stateDir)) {
    throw new Error('--out 不得位于被盘点的 StateKV 目录内');
  }

  const [resolvedOutPath, realForbiddenRoot, realStateDir] = await Promise.all([
    resolveThroughExistingAncestor(outPath),
    realPathIfPresent(FORBIDDEN_SESSION_SOURCE_ROOT),
    realPathIfPresent(stateDir),
  ]);
  if (realForbiddenRoot && isSameOrDescendant(resolvedOutPath, realForbiddenRoot)) {
    throw new Error('拒绝通过符号链接或目录联接把 --out 写入 session-source');
  }
  if (realStateDir && isSameOrDescendant(resolvedOutPath, realStateDir)) {
    throw new Error('--out 解析符号链接后不得位于被盘点的 StateKV 目录内');
  }
}

async function validateStatePath(stateDir) {
  requireAbsolutePath(stateDir, '--state-dir');
  if (isSameOrDescendant(stateDir, FORBIDDEN_SESSION_SOURCE_ROOT)) {
    throw new Error('拒绝盘点 F:\\ai-runtime\\session-source 及其子路径');
  }

  const [realStateDir, realForbiddenRoot] = await Promise.all([
    realPathIfPresent(stateDir),
    realPathIfPresent(FORBIDDEN_SESSION_SOURCE_ROOT),
  ]);
  if (realStateDir && realForbiddenRoot && isSameOrDescendant(realStateDir, realForbiddenRoot)) {
    throw new Error('拒绝通过链接盘点 session-source 及其子路径');
  }
}

async function collectFiles(rootDir) {
  const files = [];
  const stack = [{ absolutePath: rootDir, depth: 0 }];
  let skippedEntryCount = 0;
  let nestedDirectoryCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (entry.isDirectory()) {
        nestedDirectoryCount += 1;
        stack.push({ absolutePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) {
        skippedEntryCount += 1;
        continue;
      }
      const stat = await fs.stat(absolutePath);
      files.push({
        fileName: entry.name,
        bytes: stat.size,
        nested: current.depth > 0,
      });
    }
  }

  return { files, skippedEntryCount, nestedDirectoryCount };
}

function sumBytes(files) {
  return files.reduce((total, file) => total + file.bytes, 0);
}

function missingCategory(category, scope, label, warnings) {
  warnings.push({
    code: 'scope_file_missing',
    category,
    message: `未发现 ${label} 的 StateKV 键文件；持久化文件数量按 0 统计。`,
  });
  return {
    count: 0,
    exact: true,
    unit: 'items',
    scopeFileCount: 0,
    bytes: 0,
    source: scope,
  };
}

function sharedScopeCategory(category, scope, label, keyFiles, warnings) {
  const files = keyFiles.filter((file) => file.key === scope);
  if (files.length === 0) {
    return missingCategory(category, scope, label, warnings);
  }

  warnings.push({
    code: 'item_count_unavailable',
    category,
    message: `${label} 的条目数封装在二进制 StateKV 值中；只读键名盘点不能确定精确数量。`,
  });
  return {
    count: null,
    exact: false,
    unit: 'items',
    scopeFileCount: files.length,
    bytes: sumBytes(files),
    source: scope,
  };
}

function emptyCounts() {
  return {
    sessions: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      observationBucketCount: 0,
      bytes: 0,
      source: 'mem:sessions',
    },
    observationBuckets: {
      count: 0,
      exact: true,
      unit: 'buckets',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:obs:*',
    },
    summaries: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:summaries',
    },
    lessons: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:lessons',
    },
    semantic: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:semantic',
    },
    procedural: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:procedural',
    },
    crystals: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:crystals',
    },
    insights: {
      count: 0,
      exact: true,
      unit: 'items',
      scopeFileCount: 0,
      bytes: 0,
      source: 'mem:insights',
    },
    bm25Chunks: {
      count: 0,
      exact: true,
      unit: 'chunks',
      scopeFileCount: 0,
      indexFamilyFileCount: 0,
      bytes: 0,
      source: 'mem:index:bm25:bm25:*',
    },
  };
}

function missingDirectoryWarnings() {
  return [
    {
      code: 'state_dir_missing',
      message: '目标 StateKV 目录不存在；按空状态处理，但无法证明该目录曾完成初始化。',
    },
  ];
}

export async function inspectStateDirectory(stateDir, options = {}) {
  await validateStatePath(stateDir);
  const expectedEmpty = options.expectedEmpty === true;
  const resolvedStateDir = isDriveAbsolute(stateDir)
    ? path.win32.resolve(stateDir)
    : path.resolve(stateDir);
  let rootStat;

  try {
    rootStat = await fs.stat(resolvedStateDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const counts = emptyCounts();
    return {
      schemaVersion: 1,
      inspectedAt: new Date().toISOString(),
      stateDir: resolvedStateDir,
      exists: false,
      isDirectory: false,
      totals: {
        fileCount: 0,
        byteCount: 0,
        stateKeyFileCount: 0,
        temporaryStateKeyFileCount: 0,
        indeterminateKeyFileCount: 0,
        stateKeyBytes: 0,
        managedFileCount: 0,
        managedBytes: 0,
        unclassifiedManagedFileCount: 0,
        unmanagedFileCount: 0,
        unmanagedBytes: 0,
      },
      stateKeys: [],
      managedKeys: [],
      counts,
      managedDataPresent: false,
      expectedEmpty: { requested: expectedEmpty, satisfied: true },
      warnings: missingDirectoryWarnings(),
    };
  }

  if (!rootStat.isDirectory()) {
    throw new Error('目标 state-dir 不是目录；本脚本只兼容目录型 StateKV');
  }

  const warnings = [];
  const { files, skippedEntryCount, nestedDirectoryCount } = await collectFiles(resolvedStateDir);
  if (nestedDirectoryCount > 0) {
    warnings.push({
      code: 'nested_layout_detected',
      count: nestedDirectoryCount,
      message: '发现嵌套目录；已递归统计文件，但正式 StateKV 键文件通常位于目录根层。',
    });
  }
  if (skippedEntryCount > 0) {
    warnings.push({
      code: 'non_regular_entries_skipped',
      count: skippedEntryCount,
      message: '发现符号链接或其他非普通目录项；为避免越界读取已跳过。',
    });
  }

  const keyFiles = [];
  const temporaryKeyFiles = [];
  let invalidKeyFileCount = 0;
  for (const file of files) {
    if (file.fileName.endsWith(`${KEY_FILE_EXTENSION}.tmp`)) {
      const key = decodeStateKeyFileName(file.fileName.slice(0, -'.tmp'.length));
      if (key === null) {
        invalidKeyFileCount += 1;
      } else {
        temporaryKeyFiles.push({ ...file, key, managed: isManagedKey(key), temporary: true });
      }
      continue;
    }
    const key = decodeStateKeyFileName(file.fileName);
    if (key === null) {
      if (file.fileName.endsWith(KEY_FILE_EXTENSION)) invalidKeyFileCount += 1;
      continue;
    }
    keyFiles.push({ ...file, key, managed: isManagedKey(key) });
  }
  if (temporaryKeyFiles.length > 0) {
    warnings.push({
      code: 'temporary_state_key_files',
      count: temporaryKeyFiles.length,
      message:
        '发现 StateKV 临时键文件；产物细分类不计入临时文件，但 expected-empty 会保守视为非空。',
    });
  }
  if (invalidKeyFileCount > 0) {
    warnings.push({
      code: 'invalid_state_key_file_names',
      count: invalidKeyFileCount,
      message: '部分 .bin 文件名不能按 StateKV 百分号编码解码；未输出这些文件名。',
    });
  }

  const observationFiles = keyFiles.filter((file) => file.key.startsWith('mem:obs:'));
  const sessionFiles = keyFiles.filter((file) => file.key === 'mem:sessions');
  let sessions;
  if (sessionFiles.length === 0 && observationFiles.length === 0) {
    sessions = missingCategory('sessions', 'mem:sessions', 'session（会话）', warnings);
    sessions.observationBucketCount = 0;
  } else if (sessionFiles.length === 0) {
    warnings.push({
      code: 'session_scope_missing_with_observation_buckets',
      category: 'sessions',
      message: '未发现 session 键文件但存在 observation bucket；不能推断精确 session 数量。',
    });
    sessions = {
      count: null,
      exact: false,
      unit: 'items',
      scopeFileCount: 0,
      observationBucketCount: observationFiles.length,
      bytes: 0,
      source: 'mem:sessions',
    };
  } else {
    warnings.push({
      code: 'item_count_unavailable',
      category: 'sessions',
      message: 'session 条目数封装在二进制 StateKV 值中；只读键名盘点不能确定精确数量。',
    });
    sessions = {
      count: null,
      exact: false,
      unit: 'items',
      scopeFileCount: sessionFiles.length,
      observationBucketCount: observationFiles.length,
      bytes: sumBytes(sessionFiles),
      source: 'mem:sessions',
    };
  }

  const counts = {
    sessions,
    observationBuckets:
      observationFiles.length === 0
        ? missingCategory(
            'observationBuckets',
            'mem:obs:*',
            'observation bucket（观察桶）',
            warnings
          )
        : {
            count: observationFiles.length,
            exact: true,
            unit: 'buckets',
            scopeFileCount: observationFiles.length,
            bytes: sumBytes(observationFiles),
            source: 'mem:obs:*',
          },
  };

  for (const [category, scope, label] of SHARED_SCOPE_CATEGORIES) {
    counts[category] = sharedScopeCategory(category, scope, label, keyFiles, warnings);
  }

  const bm25FamilyFiles = keyFiles.filter(
    (file) => file.key === 'mem:index:bm25' || file.key.startsWith('mem:index:bm25:')
  );
  const bm25ChunkFiles = keyFiles.filter((file) => file.key.startsWith('mem:index:bm25:bm25:'));
  if (bm25FamilyFiles.length === 0) {
    warnings.push({
      code: 'scope_file_missing',
      category: 'bm25Chunks',
      message: '未发现 BM25（关键词检索）索引键文件；chunk（分片）数量按 0 统计。',
    });
  } else if (bm25ChunkFiles.length === 0) {
    warnings.push({
      code: 'bm25_chunk_files_missing',
      category: 'bm25Chunks',
      message: '发现 BM25 索引族键文件，但未发现可由键名确定的 BM25 chunk。',
    });
  }
  counts.bm25Chunks = {
    count: bm25ChunkFiles.length,
    exact: true,
    unit: 'chunks',
    scopeFileCount: bm25ChunkFiles.length,
    indexFamilyFileCount: bm25FamilyFiles.length,
    bytes: sumBytes(bm25ChunkFiles),
    source: 'mem:index:bm25:bm25:*',
  };

  const temporaryCategories = new Set(
    temporaryKeyFiles.map((file) => detailedCategoryForKey(file.key)).filter(Boolean)
  );
  for (const categoryName of temporaryCategories) {
    const category = counts[categoryName];
    if (category.exact) {
      category.knownCount = category.count;
      category.count = null;
      category.exact = false;
    }
    category.uncertainty = 'temporary_state_key_files';
  }

  if (invalidKeyFileCount > 0) {
    for (const category of Object.values(counts)) {
      if (category.exact) {
        category.knownCount = category.count;
        category.count = null;
        category.exact = false;
      }
      category.uncertainty = 'indeterminate_key_files';
    }
  }

  const allKeyFiles = [...keyFiles, ...temporaryKeyFiles];
  const managedFiles = allKeyFiles.filter((file) => file.managed);
  const unclassifiedManagedFiles = managedFiles.filter((file) => !isClassifiedManagedKey(file.key));
  if (unclassifiedManagedFiles.length > 0) {
    warnings.push({
      code: 'unclassified_managed_keys',
      count: unclassifiedManagedFiles.length,
      message: '发现未纳入产物细分类的 mem: 受管键文件；expected-empty 仍将其视为非空状态。',
    });
  }
  const stateKeyBytes = sumBytes(allKeyFiles);
  const managedBytes = sumBytes(managedFiles);
  const byteCount = sumBytes(files);
  const uniqueStateKeys = [...new Set(allKeyFiles.map((file) => file.key))].sort();
  const uniqueManagedKeys = [...new Set(managedFiles.map((file) => file.key))].sort();
  const managedDataPresent = managedFiles.length > 0;

  return {
    schemaVersion: 1,
    inspectedAt: new Date().toISOString(),
    stateDir: resolvedStateDir,
    exists: true,
    isDirectory: true,
    totals: {
      fileCount: files.length,
      byteCount,
      stateKeyFileCount: allKeyFiles.length,
      temporaryStateKeyFileCount: temporaryKeyFiles.length,
      indeterminateKeyFileCount: invalidKeyFileCount,
      stateKeyBytes,
      managedFileCount: managedFiles.length,
      managedBytes,
      unclassifiedManagedFileCount: unclassifiedManagedFiles.length,
      unmanagedFileCount: files.length - managedFiles.length,
      unmanagedBytes: byteCount - managedBytes,
    },
    stateKeys: uniqueStateKeys,
    managedKeys: uniqueManagedKeys,
    counts,
    managedDataPresent,
    expectedEmpty: {
      requested: expectedEmpty,
      satisfied: !managedDataPresent && invalidKeyFileCount === 0,
    },
    warnings,
  };
}

function countText(category) {
  return category.exact ? String(category.count) : '未知';
}

function printSummary(report) {
  console.error(
    `盘点完成: 文件=${report.totals.fileCount}, 字节=${report.totals.byteCount}, ` +
      `受管键文件=${report.totals.managedFileCount}`
  );
  console.error(
    `产物统计: session=${countText(report.counts.sessions)}, ` +
      `observation bucket=${countText(report.counts.observationBuckets)}, ` +
      `summary=${countText(report.counts.summaries)}, lesson=${countText(report.counts.lessons)}, ` +
      `semantic=${countText(report.counts.semantic)}, procedural=${countText(report.counts.procedural)}, ` +
      `crystal=${countText(report.counts.crystals)}, insight=${countText(report.counts.insights)}, ` +
      `BM25 chunk=${countText(report.counts.bm25Chunks)}`
  );
  if (report.warnings.length > 0) {
    console.error(`警告=${report.warnings.length}；精确性以 JSON 报告中的 exact 字段为准。`);
  }
}

async function writeReport(outPath, stateDir, report) {
  await validateOutputPath(outPath, stateDir);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await validateOutputPath(outPath, stateDir);
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const report = await inspectStateDirectory(options.stateDir, {
    expectedEmpty: options.expectedEmpty,
  });
  if (options.outPath) {
    await writeReport(options.outPath, report.stateDir, report);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  printSummary(report);

  if (!report.exists && !options.expectedEmpty) {
    console.error('目标 StateKV 目录不存在；普通盘点不能视为验收成功。');
    return 3;
  }
  if (options.expectedEmpty && !report.expectedEmpty.satisfied) {
    console.error(
      `expected-empty（期望为空）失败: 受管键文件=${report.totals.managedFileCount}, ` +
        `无法判定的键文件=${report.totals.indeterminateKeyFileCount}, ` +
        `受管字节=${report.totals.managedBytes}。`
    );
    return 2;
  }
  return 0;
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (comparisonPath(currentFile) === comparisonPath(invokedFile)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(`错误: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}
