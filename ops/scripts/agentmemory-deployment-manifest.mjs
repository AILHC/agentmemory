import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'DEPLOYMENT.json';
const ALLOWED_TOP_LEVEL = new Set([
  'dist',
  'node_modules',
  'scripts',
  'config-template',
  'package.json',
  'package-lock.json',
  MANIFEST_NAME,
]);
const REQUIRED_TOP_LEVEL = [
  'dist',
  'node_modules',
  'scripts',
  'config-template',
  'package.json',
  'package-lock.json',
];
const KEY_FILE_PATHS = [
  'dist/index.mjs',
  'dist/worker-supervisor.mjs',
  'scripts/_agentmemory-local-common.ps1',
  'scripts/agentmemory-deployment-manifest.mjs',
  'scripts/doctor-agentmemory-console.ps1',
  'scripts/doctor-agentmemory.ps1',
  'scripts/lib/adaptive-provider-limiter.mjs',
  'scripts/lib/full-extraction-stage-adapters-v2.mjs',
  'scripts/lib/recoverable-stage-v2.mjs',
  'scripts/lib/run-state-journal-v2.mjs',
  'scripts/lib/run-state-store.mjs',
  'scripts/lib/stage-pipeline.mjs',
  'scripts/lib/v2-release-gate.mjs',
  'scripts/run-agentmemory-full-extraction.mjs',
  'scripts/start-agentmemory-console.ps1',
  'scripts/start-agentmemory.ps1',
  'scripts/stop-agentmemory-console.ps1',
  'scripts/stop-agentmemory-service-hook.ps1',
  'scripts/stop-agentmemory.ps1',
  'scripts/validate-agentmemory-worker-supervision.mjs',
];
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function assertCommit(name, value) {
  if (!COMMIT_PATTERN.test(value || '')) {
    throw new Error(`${name} must be a full 40-character Git commit`);
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function collectPath(root, relativePath, files) {
  const absolutePath = path.join(root, relativePath);
  const stat = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic link or junction is not allowed: ${normalizeRelativePath(relativePath)}`);
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath);
    entries.sort((left, right) => left.localeCompare(right, 'en'));
    for (const entry of entries) {
      await collectPath(root, path.join(relativePath, entry), files);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported deployment entry type: ${normalizeRelativePath(relativePath)}`);
  }
  files.push({
    path: normalizeRelativePath(relativePath),
    size: stat.size,
    sha256: await hashFile(absolutePath),
  });
}

export async function collectDeploymentFiles(rootPath) {
  const root = path.resolve(rootPath);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('deployment root must be a real directory');
  }

  const topLevelEntries = await fs.readdir(root);
  topLevelEntries.sort((left, right) => left.localeCompare(right, 'en'));
  for (const entry of topLevelEntries) {
    if (!ALLOWED_TOP_LEVEL.has(entry)) {
      throw new Error(`unexpected top-level entry: ${entry}`);
    }
  }
  for (const required of REQUIRED_TOP_LEVEL) {
    if (!topLevelEntries.includes(required)) {
      throw new Error(`required deployment entry is missing: ${required}`);
    }
  }

  const files = [];
  for (const entry of topLevelEntries) {
    if (entry !== MANIFEST_NAME) {
      await collectPath(root, entry, files);
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return files;
}

async function readPackageVersion(root) {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json version is missing');
  }
  return packageJson.version;
}

function summarizeFiles(files) {
  const hash = createHash('sha256');
  let byteCount = 0;
  for (const file of files) {
    byteCount += file.size;
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return {
    fileCount: files.length,
    byteCount,
    sha256: hash.digest('hex'),
  };
}

export async function createDeploymentManifest({
  root: rootPath,
  sourceCommit,
  builtAt = new Date().toISOString(),
}) {
  assertCommit('sourceCommit', sourceCommit);
  const root = path.resolve(rootPath);
  const files = await collectDeploymentFiles(root);
  const entries = new Map(files.map((file) => [file.path, file]));
  const keyFiles = KEY_FILE_PATHS.map((keyPath) => {
    const entry = entries.get(keyPath);
    if (!entry) throw new Error(`required key file is missing: ${keyPath}`);
    return entry;
  });
  const manifest = {
    schemaVersion: 3,
    sourceCommit: sourceCommit.toLowerCase(),
    packageVersion: await readPackageVersion(root),
    builtAt,
    content: summarizeFiles(files),
    keyFiles,
  };
  const targetPath = path.join(root, MANIFEST_NAME);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await fs.rename(temporaryPath, targetPath);
  return manifest;
}

function assertManifestShape(manifest) {
  if (!manifest || manifest.schemaVersion !== 3) {
    throw new Error('unsupported DEPLOYMENT.json schemaVersion');
  }
  assertCommit('sourceCommit', manifest.sourceCommit);
  if (typeof manifest.packageVersion !== 'string' || manifest.packageVersion.length === 0) {
    throw new Error('DEPLOYMENT.json packageVersion is missing');
  }
  if (
    !manifest.content
    || !Number.isInteger(manifest.content.fileCount)
    || !Number.isInteger(manifest.content.byteCount)
    || !/^[0-9a-f]{64}$/.test(manifest.content.sha256 || '')
  ) {
    throw new Error('DEPLOYMENT.json content summary is invalid');
  }
  if (!Array.isArray(manifest.keyFiles)) {
    throw new Error('DEPLOYMENT.json keyFiles must be an array');
  }
}

export async function verifyDeploymentManifest(rootPath) {
  const root = path.resolve(rootPath);
  const manifestPath = path.join(root, MANIFEST_NAME);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assertManifestShape(manifest);
  const actualFiles = await collectDeploymentFiles(root);
  const actualContent = summarizeFiles(actualFiles);
  if (
    manifest.content.fileCount !== actualContent.fileCount
    || manifest.content.byteCount !== actualContent.byteCount
    || manifest.content.sha256 !== actualContent.sha256
  ) {
    throw new Error('deployment content hash mismatch');
  }

  return {
    ok: true,
    schemaVersion: manifest.schemaVersion,
    sourceCommit: manifest.sourceCommit,
    packageVersion: manifest.packageVersion,
    builtAt: manifest.builtAt,
    fileCount: manifest.content.fileCount,
    byteCount: manifest.content.byteCount,
    contentSha256: manifest.content.sha256,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'create' || argument === 'verify' || argument === 'show') {
      if (options.command) throw new Error('only one command is allowed');
      options.command = argument;
      continue;
    }
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--source-commit') options.sourceCommit = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.command) throw new Error('command is required: create, verify, or show');
  if (!options.root || !path.isAbsolute(options.root)) {
    throw new Error('--root must be an absolute path');
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let result;
  if (options.command === 'create') {
    result = await createDeploymentManifest(options);
    result = {
      ok: true,
      schemaVersion: result.schemaVersion,
      sourceCommit: result.sourceCommit,
      packageVersion: result.packageVersion,
      builtAt: result.builtAt,
      fileCount: result.content.fileCount,
      byteCount: result.content.byteCount,
      contentSha256: result.content.sha256,
    };
  } else if (options.command === 'verify') {
    result = await verifyDeploymentManifest(options.root);
  } else {
    const manifest = JSON.parse(
      await fs.readFile(path.join(path.resolve(options.root), MANIFEST_NAME), 'utf8'),
    );
    assertManifestShape(manifest);
    result = {
      schemaVersion: manifest.schemaVersion,
      sourceCommit: manifest.sourceCommit,
      packageVersion: manifest.packageVersion,
      builtAt: manifest.builtAt,
      fileCount: manifest.content.fileCount,
      byteCount: manifest.content.byteCount,
      contentSha256: manifest.content.sha256,
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
