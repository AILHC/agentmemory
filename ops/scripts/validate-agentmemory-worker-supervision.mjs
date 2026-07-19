import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ARGUMENTS = new Set([
  '--config',
  '--app-dir',
  '--expected-instance-id',
  '--expected-state-path',
  '--expected-stream-path',
]);

function loadYaml(moduleRoot) {
  const require = createRequire(path.join(moduleRoot, 'package.json'));
  return require('yaml');
}

function normalizeConfiguredPath(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/$/, '');
}

function normalizeCommandPath(value) {
  return value.replaceAll('\\', '/').replace(/\/$/, '');
}

function isExpectedEntry(value, appDir, relativePath) {
  const normalized = normalizeCommandPath(value);
  const expectedRelative = normalizeCommandPath(relativePath);
  const expectedAbsolute = normalizeCommandPath(path.resolve(appDir, relativePath));
  return normalized === expectedRelative || normalized.toLowerCase() === expectedAbsolute.toLowerCase();
}

function isDirectWorkerCommand(command) {
  return /^node(?:\.exe)?\s+(?:"[^"]*dist[\\/]index\.mjs"|'[^']*dist[\\/]index\.mjs'|\S*dist[\\/]index\.mjs)(?:\s|$)/i.test(command.trim());
}

function isSupervisorCommand(command, options) {
  if (/[;&|<>^`$()%!"']/.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  return tokens.length === 6
    && tokens[0] === 'node'
    && isExpectedEntry(tokens[1], options.appDir, 'dist/worker-supervisor.mjs')
    && tokens[2] === '--instance-id'
    && tokens[3] === options.expectedInstanceId
    && tokens[4] === '--worker-entry'
    && isExpectedEntry(tokens[5], options.appDir, 'dist/index.mjs');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function nonTargetHash(documentValue, rawText) {
  if (!isPlainObject(documentValue) || !Array.isArray(documentValue.workers)) {
    return crypto.createHash('sha256').update(`invalid\n${rawText.replace(/\r\n/g, '\n')}`, 'utf8').digest('hex');
  }
  const normalized = {
    ...documentValue,
    workers: documentValue.workers.filter((worker) => !isPlainObject(worker) || worker.name !== 'iii-exec'),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(normalized)), 'utf8').digest('hex');
}

function inspectUnsupportedYaml(document, visit) {
  let unsupported = false;
  visit(document, {
    Node(_key, node) {
      if (node?.constructor?.name === 'Alias' || node?.anchor || node?.tag) {
        unsupported = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return unsupported;
}

function workerCommands(worker) {
  const exec = worker?.config?.exec;
  return Array.isArray(exec) ? exec.filter((value) => typeof value === 'string') : [];
}

function hasStrictExecStructure(worker) {
  return hasExactKeys(worker, ['name', 'config'])
    && worker.name === 'iii-exec'
    && hasExactKeys(worker.config, ['exec'])
    && Array.isArray(worker.config.exec)
    && worker.config.exec.length === 1
    && typeof worker.config.exec[0] === 'string';
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function validateWorkerSupervisionConfig(options) {
  const text = await fs.readFile(options.configPath, 'utf8');
  const problems = [];
  let document;
  let value = null;

  try {
    const { parseDocument, visit } = loadYaml(options.yamlModuleRoot ?? options.appDir);
    document = parseDocument(text, {
      merge: false,
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      problems.push('yaml_parse_error');
    }
    if (inspectUnsupportedYaml(document, visit)) problems.push('unsupported_yaml_feature');
    if (problems.length === 0) value = document.toJS({ maxAliasCount: 0 });
  } catch {
    problems.push('yaml_parse_error');
  }

  if (!isPlainObject(value) || !Array.isArray(value.workers)) {
    problems.push('workers_structure');
  }
  const workers = Array.isArray(value?.workers)
    ? value.workers.filter(isPlainObject)
    : [];
  const execWorkers = workers.filter((worker) => worker.name === 'iii-exec');
  const commands = execWorkers.flatMap(workerCommands);

  if (execWorkers.length !== 1) problems.push('iii_exec_count');
  if (commands.length !== 1) problems.push('exec_command_count');
  if (commands.some(isDirectWorkerCommand)) problems.push('direct_worker_command');
  if (execWorkers.some((worker) => isPlainObject(worker.config) && Object.hasOwn(worker.config, 'watch'))) {
    problems.push('watch_present');
  }
  if (execWorkers.length === 1 && !hasStrictExecStructure(execWorkers[0])) {
    problems.push('iii_exec_structure');
  }
  if (commands.some((command) => /[;&|<>^`$()%!"']/.test(command))) problems.push('shell_metacharacter');
  if (commands.length === 1 && !isSupervisorCommand(commands[0], options)) {
    problems.push('supervisor_command_mismatch');
  }

  const stateWorkers = workers.filter((worker) => worker.name === 'iii-state');
  const streamWorkers = workers.filter((worker) => worker.name === 'iii-stream');
  const statePath = stateWorkers[0]?.config?.adapter?.config?.file_path;
  const streamPath = streamWorkers[0]?.config?.adapter?.config?.file_path;
  if (stateWorkers.length !== 1) problems.push('state_worker_count');
  if (streamWorkers.length !== 1) problems.push('stream_worker_count');
  if (typeof statePath !== 'string') problems.push('state_path_count');
  if (typeof streamPath !== 'string') problems.push('stream_path_count');
  if (normalizeConfiguredPath(statePath) !== normalizeConfiguredPath(options.expectedStatePath)) {
    problems.push('state_path_drift');
  }
  if (normalizeConfiguredPath(streamPath) !== normalizeConfiguredPath(options.expectedStreamPath)) {
    problems.push('stream_path_drift');
  }

  if (!(await isFile(path.join(options.appDir, 'dist', 'worker-supervisor.mjs')))) {
    problems.push('supervisor_build_missing');
  }
  if (!(await isFile(path.join(options.appDir, 'dist', 'index.mjs')))) {
    problems.push('worker_build_missing');
  }

  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    nonTargetSha256: nonTargetHash(value, text),
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!ARGUMENTS.has(name) || value === undefined) throw new Error('invalid_arguments');
    values[name] = value;
  }
  for (const required of ARGUMENTS) {
    if (!values[required]) throw new Error('missing_arguments');
  }
  return {
    configPath: path.resolve(values['--config']),
    appDir: path.resolve(values['--app-dir']),
    expectedInstanceId: values['--expected-instance-id'],
    expectedStatePath: values['--expected-state-path'],
    expectedStreamPath: values['--expected-stream-path'],
  };
}

async function main() {
  try {
    const result = await validateWorkerSupervisionConfig(parseArgs(process.argv.slice(2)));
    console.log(`validation.status=${result.ok ? 'ok' : 'bad'}`);
    console.log(`validation.nonTargetSha256=${result.nonTargetSha256}`);
    result.problems.forEach((problem, index) => console.log(`validation.problem.${index + 1}=${problem}`));
    process.exitCode = result.ok ? 0 : 2;
  } catch {
    console.error('validation.status=error');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
