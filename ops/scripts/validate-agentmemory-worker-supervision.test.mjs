import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateWorkerSupervisionConfig,
} from './validate-agentmemory-worker-supervision.mjs';

const yamlModuleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const validConfig = `workers:
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: ./data/state_store.db
  - name: iii-stream
    config:
      port: 3112
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: ./data/stream_store
  - name: iii-exec
    config:
      exec:
        - node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs
`;

async function createFixture(context, config = validConfig) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'am-supervision-validator-'));
  const configPath = path.join(root, 'iii-config.yaml');
  const appDir = path.join(root, 'app');
  await fs.mkdir(path.join(appDir, 'dist'), { recursive: true });
  await Promise.all([
    fs.writeFile(configPath, config),
    fs.writeFile(path.join(appDir, 'dist', 'worker-supervisor.mjs'), ''),
    fs.writeFile(path.join(appDir, 'dist', 'index.mjs'), ''),
  ]);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, configPath, appDir };
}

async function validateFixture(context, config = validConfig, overrides = {}) {
  const fixture = await createFixture(context, config);
  return validateWorkerSupervisionConfig({
    configPath: fixture.configPath,
    appDir: fixture.appDir,
    expectedInstanceId: 'formal',
    expectedStatePath: './data/state_store.db',
    expectedStreamPath: './data/stream_store',
    yamlModuleRoot,
    ...overrides,
  });
}

test('接受唯一 supervisor 命令并返回非目标配置哈希', async (context) => {
  const result = await validateFixture(context);

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.match(result.nonTargetSha256, /^[a-f0-9]{64}$/);
});

test('拒绝多个 iii-exec worker', async (context) => {
  const config = `${validConfig}\n  - name: iii-exec\n    config:\n      exec:\n        - node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs\n`;
  const result = await validateFixture(context, config);

  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('iii_exec_count'));
});

test('扫描所有 iii-exec 并拒绝第二个 block 中的直接 worker 命令', async (context) => {
  const config = `${validConfig}\n  - name: iii-exec\n    config:\n      exec:\n        - node dist/index.mjs\n`;
  const result = await validateFixture(context, config);

  assert.ok(result.problems.includes('iii_exec_count'));
  assert.ok(result.problems.includes('direct_worker_command'));
});

test('拒绝 exec 数组多项和任意直接 worker 命令', async (context) => {
  const config = validConfig.replace(
    '        - node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs',
    '        - node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs\n        - node dist/index.mjs',
  );
  const result = await validateFixture(context, config);

  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('exec_command_count'));
  assert.ok(result.problems.includes('direct_worker_command'));
});

test('拒绝正式配置中的 watch', async (context) => {
  const config = validConfig.replace(
    '    config:\n      exec:',
    '    config:\n      watch:\n        - src/**/*.ts\n      exec:',
  );
  const result = await validateFixture(context, config);

  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('watch_present'));
});

test('拒绝 inline watch 配置', async (context) => {
  const config = validConfig.replace(
    '    config:\n      exec:',
    '    config:\n      watch: [src/**/*.ts]\n      exec:',
  );
  const result = await validateFixture(context, config);

  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('watch_present'));
});

test('拒绝 shell 元字符和 supervisor 额外参数', async (context) => {
  const injected = validConfig.replace(
    ' --instance-id formal',
    ' --debug ; calc.exe --instance-id formal',
  );
  const extra = validConfig.replace(
    ' --worker-entry dist/index.mjs',
    ' --worker-entry dist/index.mjs --unexpected value',
  );

  const injectedResult = await validateFixture(context, injected);
  const extraResult = await validateFixture(context, extra);
  assert.ok(injectedResult.problems.includes('supervisor_command_mismatch'));
  assert.ok(injectedResult.problems.includes('shell_metacharacter'));
  assert.ok(extraResult.problems.includes('supervisor_command_mismatch'));
});

test('拒绝 supervisor 和 worker entry 指向其他 app 或路径穿越', async (context) => {
  const fixture = await createFixture(context);
  const foreignRoot = path.join(fixture.root, 'foreign-app');
  const foreignConfig = validConfig.replace(
    'node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs',
    `node ${path.join(foreignRoot, 'dist', 'worker-supervisor.mjs')} --instance-id formal --worker-entry ${path.join(foreignRoot, 'dist', 'index.mjs')}`,
  );
  await fs.writeFile(fixture.configPath, foreignConfig);
  let result = await validateWorkerSupervisionConfig({
    configPath: fixture.configPath,
    appDir: fixture.appDir,
    expectedInstanceId: 'formal',
    expectedStatePath: './data/state_store.db',
    expectedStreamPath: './data/stream_store',
    yamlModuleRoot,
  });
  assert.ok(result.problems.includes('supervisor_command_mismatch'));

  await fs.writeFile(
    fixture.configPath,
    validConfig.replace('dist/worker-supervisor.mjs', 'dist/../other/worker-supervisor.mjs'),
  );
  result = await validateWorkerSupervisionConfig({
    configPath: fixture.configPath,
    appDir: fixture.appDir,
    expectedInstanceId: 'formal',
    expectedStatePath: './data/state_store.db',
    expectedStreamPath: './data/stream_store',
    yamlModuleRoot,
  });
  assert.ok(result.problems.includes('supervisor_command_mismatch'));
});

test('拒绝 supervisor 或 worker 构建文件缺失', async (context) => {
  const fixture = await createFixture(context);
  await fs.rm(path.join(fixture.appDir, 'dist', 'worker-supervisor.mjs'));
  let result = await validateWorkerSupervisionConfig({
    configPath: fixture.configPath,
    appDir: fixture.appDir,
    expectedInstanceId: 'formal',
    expectedStatePath: './data/state_store.db',
    expectedStreamPath: './data/stream_store',
    yamlModuleRoot,
  });
  assert.ok(result.problems.includes('supervisor_build_missing'));

  await fs.writeFile(path.join(fixture.appDir, 'dist', 'worker-supervisor.mjs'), '');
  await fs.rm(path.join(fixture.appDir, 'dist', 'index.mjs'));
  result = await validateWorkerSupervisionConfig({
    configPath: fixture.configPath,
    appDir: fixture.appDir,
    expectedInstanceId: 'formal',
    expectedStatePath: './data/state_store.db',
    expectedStreamPath: './data/stream_store',
    yamlModuleRoot,
  });
  assert.ok(result.problems.includes('worker_build_missing'));
});

test('拒绝 state 和 stream 路径漂移', async (context) => {
  const config = validConfig
    .replace('./data/state_store.db', './other/state_store.db')
    .replace('./data/stream_store', './other/stream_store');
  const result = await validateFixture(context, config);

  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('state_path_drift'));
  assert.ok(result.problems.includes('stream_path_drift'));
});

test('拒绝重复 state worker 和重复 file_path 覆盖', async (context) => {
  const duplicateWorker = `${validConfig}\n  - name: iii-state\n    config:\n      adapter:\n        config:\n          file_path: ./other/state_store.db\n`;
  const duplicatePath = validConfig.replace(
    '          file_path: ./data/state_store.db',
    '          file_path: ./data/state_store.db\n          file_path: ./other/state_store.db',
  );

  const workerResult = await validateFixture(context, duplicateWorker);
  const pathResult = await validateFixture(context, duplicatePath);
  assert.ok(workerResult.problems.includes('state_worker_count'));
  assert.ok(pathResult.problems.includes('state_path_count'));
});

test('结构化解析识别 quoted 重复 worker，并拒绝 anchor、alias 和 merge key', async (context) => {
  const quotedDuplicate = `${validConfig}\n  - name: 'iii-exec'\n    config:\n      exec:\n        - node dist/index.mjs\n`;
  const anchored = `x-hidden-exec: &hidden_exec\n  name: iii-exec\n  config:\n    exec:\n      - node dist/index.mjs\n${validConfig.replace('  - name: iii-stream', '  - *hidden_exec\n  - name: iii-stream')}`;
  const merged = validConfig.replace(
    '  - name: iii-exec\n    config:',
    '  - name: iii-exec\n    <<: *hidden_exec\n    config:',
  );

  const duplicateResult = await validateFixture(context, quotedDuplicate);
  assert.ok(duplicateResult.problems.includes('iii_exec_count'));
  assert.ok(duplicateResult.problems.includes('direct_worker_command'));

  for (const config of [anchored, merged]) {
    const result = await validateFixture(context, config);
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes('unsupported_yaml_feature'));
  }
});

test('结构化解析拒绝 flow mapping 隐藏 exec 和重复顶层 workers', async (context) => {
  const hiddenFlowExec = validConfig.replace(
    '  - name: iii-exec\n    config:\n      exec:\n        - node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs',
    '  - { name: iii-exec, config: { exec: [node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs], hidden: node dist/index.mjs } }',
  );
  const duplicateTopLevel = `${validConfig}\nworkers: []\n`;

  const flowResult = await validateFixture(context, hiddenFlowExec);
  assert.ok(flowResult.problems.includes('iii_exec_structure'));

  const duplicateResult = await validateFixture(context, duplicateTopLevel);
  assert.ok(duplicateResult.problems.includes('yaml_parse_error'));
});

test('非目标配置哈希忽略 iii-exec 内容但捕获其他 worker 漂移', async (context) => {
  const first = await validateFixture(context);
  const changedExec = validConfig.replace(
    'node dist/worker-supervisor.mjs --instance-id formal --worker-entry dist/index.mjs',
    'node X:/release/dist/worker-supervisor.mjs --instance-id formal --worker-entry X:/release/dist/index.mjs',
  );
  const second = await validateFixture(context, changedExec);
  const changedStateWorker = validConfig.replace('port: 3112', 'port: 3999');
  const third = await validateFixture(context, changedStateWorker);

  assert.equal(first.nonTargetSha256, second.nonTargetSha256);
  assert.notEqual(first.nonTargetSha256, third.nonTargetSha256);
});

test('非目标配置哈希覆盖 worker 列表以外的顶层配置', async (context) => {
  const first = await validateFixture(context, `schema_version: 1\n${validConfig}`);
  const second = await validateFixture(context, `schema_version: 2\n${validConfig}`);

  assert.notEqual(first.nonTargetSha256, second.nonTargetSha256);
});
