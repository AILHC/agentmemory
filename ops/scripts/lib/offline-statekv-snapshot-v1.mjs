import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const OFFLINE_STATEKV_SNAPSHOT_SCHEMA = 'agentmemory-recovery-evidence-snapshot/v1';

const TEMPORARY_NAME = /(?:^|[._-])(?:tmp|temp|partial|lock)(?:$|[._-])/i;
const STATE_FILE = /^[A-Za-z0-9%._-]+\.bin$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(
      (key) => [key, canonical(value[key])],
    ));
  }
  return value;
}

function snapshotHash(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function normalizeExpectedJournal(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'input_summary_hash,journal_seq,run_id,stage'
    || !/^[A-Za-z0-9._-]+$/.test(String(value.run_id || ''))
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(String(value.stage || ''))
    || !Number.isSafeInteger(value.journal_seq)
    || value.journal_seq < -1
    || !/^[0-9a-f]{64}$/.test(String(value.input_summary_hash || ''))
  ) {
    throw new Error('offline_snapshot_expected_journal_invalid');
  }
  return {
    run_id: value.run_id,
    stage: value.stage,
    journal_seq: value.journal_seq,
    input_summary_hash: value.input_summary_hash,
  };
}

function assertPathOutside(candidate, root, code) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(code);
  }
}

async function assertNoSymbolicLinkAncestor(candidate, fsApi) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsApi.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('offline_snapshot_symbolic_link_ancestor_rejected');
    }
  }
}

async function hashFile(filePath, fsApi) {
  return sha256(await fsApi.readFile(filePath));
}

async function inspectRegularFile(filePath, relativePath, fsApi) {
  const stat = await fsApi.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`offline_snapshot_symbolic_link_rejected:${relativePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`offline_snapshot_non_regular_file_rejected:${relativePath}`);
  }
  return {
    path: relativePath.replaceAll('\\', '/'),
    size: stat.size,
    sha256: await hashFile(filePath, fsApi),
  };
}

async function inventoryStateDirectory(stateDir, fsApi) {
  const rootStat = await fsApi.lstat(stateDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('offline_snapshot_state_directory_invalid');
  }
  const entries = await fsApi.readdir(stateDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (
      entry.isSymbolicLink()
      || entry.isDirectory()
      || !entry.isFile()
    ) {
      throw new Error(`offline_snapshot_state_entry_invalid:${entry.name}`);
    }
    if (TEMPORARY_NAME.test(entry.name)) {
      throw new Error(`offline_snapshot_temporary_file_rejected:${entry.name}`);
    }
    if (!STATE_FILE.test(entry.name)) {
      throw new Error(`offline_snapshot_unknown_state_file_rejected:${entry.name}`);
    }
    files.push(await inspectRegularFile(
      path.join(stateDir, entry.name),
      `state/${entry.name}`,
      fsApi,
    ));
  }
  if (files.length === 0) throw new Error('offline_snapshot_state_empty');
  return files;
}

async function sourceInventory({ stateDir, journalPath, enginePath, fsApi }) {
  const stateFiles = await inventoryStateDirectory(stateDir, fsApi);
  const journal = await inspectRegularFile(journalPath, 'journal.jsonl', fsApi);
  const engine = await inspectRegularFile(enginePath, 'engine.bin', fsApi);
  return {
    state_files: stateFiles,
    journal,
    engine,
    state_tree_hash: snapshotHash(stateFiles),
  };
}

function sameInventory(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function copyInventory(first, sources, tempDir, fsApi) {
  await fsApi.mkdir(path.join(tempDir, 'state'), { recursive: true });
  for (const file of first.state_files) {
    const name = path.basename(file.path);
    await fsApi.copyFile(
      path.join(sources.stateDir, name),
      path.join(tempDir, file.path),
    );
  }
  await fsApi.copyFile(sources.journalPath, path.join(tempDir, 'journal.jsonl'));
  await fsApi.copyFile(sources.enginePath, path.join(tempDir, 'engine.bin'));
}

async function verifyCopiedInventory(first, tempDir, fsApi) {
  const copied = {
    state_files: await inventoryStateDirectory(path.join(tempDir, 'state'), fsApi),
    journal: await inspectRegularFile(
      path.join(tempDir, 'journal.jsonl'),
      'journal.jsonl',
      fsApi,
    ),
    engine: await inspectRegularFile(
      path.join(tempDir, 'engine.bin'),
      'engine.bin',
      fsApi,
    ),
  };
  copied.state_tree_hash = snapshotHash(copied.state_files);
  if (!sameInventory(first, copied)) {
    throw new Error('offline_snapshot_copy_integrity_failed');
  }
}

async function verifySnapshotLayout(snapshotDir, fsApi) {
  const rootStat = await fsApi.lstat(snapshotDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('offline_snapshot_directory_invalid');
  }
  const expected = new Map([
    ['engine.bin', 'file'],
    ['journal.jsonl', 'file'],
    ['snapshot-manifest.json', 'file'],
    ['state', 'directory'],
  ]);
  const entries = await fsApi.readdir(snapshotDir, { withFileTypes: true });
  if (entries.length !== expected.size) {
    throw new Error('offline_snapshot_layout_invalid');
  }
  for (const entry of entries) {
    const kind = expected.get(entry.name);
    if (
      !kind
      || entry.isSymbolicLink()
      || (kind === 'file' && !entry.isFile())
      || (kind === 'directory' && !entry.isDirectory())
    ) {
      throw new Error('offline_snapshot_layout_invalid');
    }
  }
}

export async function verifyOfflineStateKvSnapshot({
  snapshotDir,
  fsApi = fs,
}) {
  const absoluteSnapshotDir = path.resolve(snapshotDir);
  await assertNoSymbolicLinkAncestor(absoluteSnapshotDir, fsApi);
  await verifySnapshotLayout(absoluteSnapshotDir, fsApi);
  const manifestPath = path.join(absoluteSnapshotDir, 'snapshot-manifest.json');
  const raw = JSON.parse(await fsApi.readFile(manifestPath, 'utf8'));
  if (
    raw?.schema !== OFFLINE_STATEKV_SNAPSHOT_SCHEMA
    || raw?.completeness?.two_pass_source_match !== true
    || raw?.completeness?.destination_hash_match !== true
    || !Array.isArray(raw.state_files)
    || raw.state_files.length === 0
  ) {
    throw new Error('offline_snapshot_manifest_invalid');
  }
  const { snapshot_hash: claimedHash, ...core } = raw;
  if (!/^[0-9a-f]{64}$/.test(String(claimedHash || ''))
    || snapshotHash(core) !== claimedHash) {
    throw new Error('offline_snapshot_manifest_hash_mismatch');
  }
  const actual = {
    state_files: await inventoryStateDirectory(
      path.join(snapshotDir, 'state'),
      fsApi,
    ),
    journal: await inspectRegularFile(
      path.join(snapshotDir, 'journal.jsonl'),
      'journal.jsonl',
      fsApi,
    ),
    engine: await inspectRegularFile(
      path.join(snapshotDir, 'engine.bin'),
      'engine.bin',
      fsApi,
    ),
  };
  actual.state_tree_hash = snapshotHash(actual.state_files);
  if (!sameInventory({
    state_files: raw.state_files,
    journal: raw.journal,
    engine: raw.engine,
    state_tree_hash: raw.state_tree_hash,
  }, actual)) {
    throw new Error('offline_snapshot_content_drifted');
  }
  return raw;
}

export async function createOfflineStateKvSnapshot({
  stateDir,
  journalPath,
  enginePath,
  destinationDir,
  capturedAt = new Date().toISOString(),
  expectedJournal = null,
  afterFirstInventory,
  fsApi = fs,
}) {
  const sources = {
    stateDir: path.resolve(stateDir),
    journalPath: path.resolve(journalPath),
    enginePath: path.resolve(enginePath),
  };
  const destination = path.resolve(destinationDir);
  assertPathOutside(destination, sources.stateDir, 'offline_snapshot_destination_inside_state');
  assertPathOutside(sources.stateDir, destination, 'offline_snapshot_state_inside_destination');
  await Promise.all([
    assertNoSymbolicLinkAncestor(sources.stateDir, fsApi),
    assertNoSymbolicLinkAncestor(sources.journalPath, fsApi),
    assertNoSymbolicLinkAncestor(sources.enginePath, fsApi),
    assertNoSymbolicLinkAncestor(path.dirname(destination), fsApi),
  ]);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt)) {
    throw new Error('offline_snapshot_capture_time_invalid');
  }
  const safeExpectedJournal = normalizeExpectedJournal(expectedJournal);
  const first = await sourceInventory({ ...sources, fsApi });
  await afterFirstInventory?.(structuredClone(first));
  const parent = path.dirname(destination);
  await fsApi.mkdir(parent, { recursive: true });
  const tempDir = await fsApi.mkdtemp(path.join(parent, '.recovery-snapshot-tmp-'));
  try {
    await copyInventory(first, sources, tempDir, fsApi);
    const second = await sourceInventory({ ...sources, fsApi });
    if (!sameInventory(first, second)) {
      throw new Error('offline_snapshot_source_drifted');
    }
    await verifyCopiedInventory(first, tempDir, fsApi);
    const core = {
      schema: OFFLINE_STATEKV_SNAPSHOT_SCHEMA,
      captured_at: capturedAt,
      state_files: first.state_files,
      state_tree_hash: first.state_tree_hash,
      journal: first.journal,
      engine: first.engine,
      expected_journal: safeExpectedJournal,
      completeness: {
        source_entry_count: first.state_files.length,
        two_pass_source_match: true,
        destination_hash_match: true,
        temporary_entries_rejected: true,
        symbolic_links_rejected: true,
      },
    };
    const manifest = { ...core, snapshot_hash: snapshotHash(core) };
    await fsApi.writeFile(
      path.join(tempDir, 'snapshot-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await fsApi.rename(tempDir, destination);
    await verifyOfflineStateKvSnapshot({ snapshotDir: destination, fsApi });
    return manifest;
  } catch (error) {
    await fsApi.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
