import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const modulePath = path.resolve(
  'ops',
  'scripts',
  'agentmemory-deployment-manifest.mjs',
);
const manifestModule = await import(pathToFileURL(modulePath));
const commonScript = path.resolve(
  'ops',
  'scripts',
  '_agentmemory-local-common.ps1',
);

const SOURCE_COMMIT = '1111111111111111111111111111111111111111';

async function createFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-release-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.mkdir(path.join(root, 'dist'), { recursive: true }),
    fs.mkdir(path.join(root, 'node_modules', 'example'), { recursive: true }),
    fs.mkdir(path.join(root, 'scripts'), { recursive: true }),
    fs.mkdir(path.join(root, 'scripts', 'lib'), { recursive: true }),
    fs.mkdir(path.join(root, 'config-template'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'dist', 'index.mjs'), 'export const ready = true;\n'),
    fs.writeFile(path.join(root, 'dist', 'worker-supervisor.mjs'), 'export const supervisor = true;\n'),
    fs.writeFile(path.join(root, 'node_modules', 'example', 'index.js'), 'module.exports = true;\n'),
    fs.writeFile(path.join(root, 'scripts', 'start.ps1'), "Write-Output 'start'\n"),
    fs.writeFile(path.join(root, 'scripts', '_agentmemory-local-common.ps1'), 'function Common-Fixture {}\n'),
    fs.writeFile(path.join(root, 'scripts', 'agentmemory-deployment-manifest.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'doctor-agentmemory-console.ps1'), "Write-Output 'doctor'\n"),
    fs.writeFile(path.join(root, 'scripts', 'doctor-agentmemory.ps1'), "Write-Output 'service doctor'\n"),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'adaptive-provider-limiter.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'full-extraction-stage-adapters-v2.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'recoverable-stage-v2.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'run-state-journal-v2.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'run-state-store.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'stage-pipeline.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'lib', 'v2-release-gate.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'run-agentmemory-full-extraction.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'scripts', 'start-agentmemory-console.ps1'), "Write-Output 'start console'\n"),
    fs.writeFile(path.join(root, 'scripts', 'start-agentmemory.ps1'), "Write-Output 'start service'\n"),
    fs.writeFile(path.join(root, 'scripts', 'stop-agentmemory-console.ps1'), "Write-Output 'stop console'\n"),
    fs.writeFile(path.join(root, 'scripts', 'stop-agentmemory-service-hook.ps1'), "Write-Output 'stop hook'\n"),
    fs.writeFile(path.join(root, 'scripts', 'stop-agentmemory.ps1'), "Write-Output 'stop service'\n"),
    fs.writeFile(path.join(root, 'scripts', 'validate-agentmemory-worker-supervision.mjs'), 'export {};\n'),
    fs.writeFile(path.join(root, 'config-template', 'iii-config.yaml'), 'workers: []\n'),
    fs.writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: '@agentmemory/agentmemory', version: '0.9.27' }, null, 2)}\n`,
    ),
    fs.writeFile(path.join(root, 'package-lock.json'), '{}\n'),
  ]);
  return root;
}

function runPowerShell(body) {
  const script = `
$ErrorActionPreference = 'Stop'
. '${commonScript.replaceAll("'", "''")}'
${body}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('生成清单后可以验证完整 current，且清单不哈希自身', async (context) => {
  const root = await createFixture(context);
  const manifest = await manifestModule.createDeploymentManifest({
    root,
    sourceCommit: SOURCE_COMMIT,
    builtAt: '2026-07-18T00:00:00.000Z',
  });

  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.sourceCommit, SOURCE_COMMIT);
  assert.equal(manifest.packageVersion, '0.9.27');
  assert.equal(manifest.content.fileCount > 0, true);
  assert.match(manifest.content.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    manifest.keyFiles.map((file) => file.path),
    [
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
    ],
  );

  const result = await manifestModule.verifyDeploymentManifest(root);
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, manifest.content.fileCount);
});

test('文件修改、缺失和额外顶层文件都会使验证失败', async (context) => {
  const root = await createFixture(context);
  await manifestModule.createDeploymentManifest({
    root,
    sourceCommit: SOURCE_COMMIT,
  });

  await fs.writeFile(path.join(root, 'dist', 'index.mjs'), 'changed\n');
  await assert.rejects(
    manifestModule.verifyDeploymentManifest(root),
    /content hash mismatch/,
  );

  await fs.writeFile(path.join(root, 'dist', 'index.mjs'), 'export const ready = true;\n');
  await fs.rm(path.join(root, 'scripts', 'start.ps1'));
  await assert.rejects(
    manifestModule.verifyDeploymentManifest(root),
    /content hash mismatch/,
  );

  await fs.writeFile(path.join(root, 'scripts', 'start.ps1'), "Write-Output 'start'\n");
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=not-allowed\n');
  await assert.rejects(
    manifestModule.verifyDeploymentManifest(root),
    /unexpected top-level entry/,
  );
});

test('拒绝 current 中的目录联接', async (context) => {
  const root = await createFixture(context);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-release-external-'));
  context.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, path.join(root, 'scripts', 'linked'), 'junction');

  await assert.rejects(
    manifestModule.createDeploymentManifest({
      root,
      sourceCommit: SOURCE_COMMIT,
    }),
    /symbolic link or junction/,
  );
});

test('拒绝非完整 Git commit', async (context) => {
  const root = await createFixture(context);

  await assert.rejects(
    manifestModule.createDeploymentManifest({
      root,
      sourceCommit: 'main',
    }),
    /sourceCommit/,
  );
});

test('Doctor 快速检查能识别关键脚本漂移', async (context) => {
  const root = await createFixture(context);
  await manifestModule.createDeploymentManifest({
    root,
    sourceCommit: SOURCE_COMMIT,
  });

  const healthy = runPowerShell(`
Write-AmDeploymentManifestSummary -AppDirectory '${root.replaceAll("'", "''")}'
if (-not $script:AmLastDeploymentManifestOk) { throw 'healthy manifest rejected' }
`);
  assert.equal(healthy.status, 0, healthy.stderr || healthy.stdout);

  await fs.writeFile(
    path.join(root, 'scripts', 'doctor-agentmemory-console.ps1'),
    "Write-Output 'tampered'\n",
  );
  const tampered = runPowerShell(`
Write-AmDeploymentManifestSummary -AppDirectory '${root.replaceAll("'", "''")}'
if ($script:AmLastDeploymentManifestOk) { throw 'tampered key file accepted' }
`);
  assert.equal(tampered.status, 0, tampered.stderr || tampered.stdout);
  assert.match(tampered.stdout, /hash_mismatch/);
});
