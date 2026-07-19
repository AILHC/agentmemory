import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = [
  '用法: node ops/scripts/run-agentmemory-cli-import-batch.mjs --record <record_json> --agentmemory-cli <cli_path> --env-file <env_file> [options]',
  '',
  '--record              Selector 输出记录文件（对象或数组）。',
  '--agentmemory-cli     AgentMemory CLI 可执行 JS 路径。',
  '--env-file            传递给 Node 的环境文件，需包含 AGENTMEMORY_SECRET。',
  '--import-timeout-ms   import-jsonl HTTP 超时毫秒数，默认 3600000。',
  '--force-import        即使记录已有 import_cli.exit_code=0，也重新导入。',
  '--transient-retries   livez 404 / Invocation stopped 等短暂不可用重试次数，默认 20。',
  '--transient-retry-delay-ms 短暂不可用重试间隔毫秒数，默认 15000。',
  '--doctor-script       readiness doctor 脚本，默认 formal console doctor。',
  '--doctor-ok           期望 diagnosis 行，默认 OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS。',
  '--help                显示帮助。',
].join('\n');

const REQUIRED_REST_PORT = '3111';
const SUCCESS_EXIT_CODE = 0;
export const DEFAULT_IMPORT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_TRANSIENT_RETRIES = 20;
export const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 15_000;
export const DEFAULT_DOCTOR_SCRIPT = fileURLToPath(
  new URL('./doctor-agentmemory-console.ps1', import.meta.url),
);
export const DEFAULT_DOCTOR_OK = 'diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS';

function printHelp() {
  console.log(HELP_TEXT);
}
export function parseArgs(argv) {
  const result = {
    recordPath: '',
    cliPath: '',
    envFile: '',
    importTimeoutMs: DEFAULT_IMPORT_TIMEOUT_MS,
    forceImport: false,
    transientRetries: DEFAULT_TRANSIENT_RETRIES,
    transientRetryDelayMs: DEFAULT_TRANSIENT_RETRY_DELAY_MS,
    doctorScript: DEFAULT_DOCTOR_SCRIPT,
    doctorOk: DEFAULT_DOCTOR_OK,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--record') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --record 的参数值');
      }
      result.recordPath = value;
      i += 1;
      continue;
    }

    if (arg === '--agentmemory-cli') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --agentmemory-cli 的参数值');
      }
      result.cliPath = value;
      i += 1;
      continue;
    }

    if (arg === '--env-file') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --env-file 的参数值');
      }
      result.envFile = value;
      i += 1;
      continue;
    }

    if (arg === '--import-timeout-ms') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1000) {
        throw new Error('--import-timeout-ms 必须是 >= 1000 的整数');
      }
      result.importTimeoutMs = parsed;
      i += 1;
      continue;
    }

    if (arg === '--force-import') {
      result.forceImport = true;
      continue;
    }

    if (arg === '--doctor-script') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --doctor-script 的参数值');
      }
      result.doctorScript = value;
      i += 1;
      continue;
    }

    if (arg === '--transient-retries') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--transient-retries 必须是 >= 0 的整数');
      }
      result.transientRetries = parsed;
      i += 1;
      continue;
    }

    if (arg === '--transient-retry-delay-ms') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--transient-retry-delay-ms 必须是 >= 0 的整数');
      }
      result.transientRetryDelayMs = parsed;
      i += 1;
      continue;
    }

    if (arg === '--doctor-ok') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('缺少 --doctor-ok 的参数值');
      }
      result.doctorOk = value;
      i += 1;
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
  }

  if (result.help) {
    return result;
  }

  if (!result.recordPath) {
    throw new Error('缺少 --record');
  }

  if (!result.cliPath) {
    throw new Error('缺少 --agentmemory-cli');
  }

  if (!result.envFile) {
    throw new Error('缺少 --env-file');
  }

  return result;
}

function isSuccessfulImport(record) {
  return !!(record && record.import_cli && record.import_cli.exit_code === SUCCESS_EXIT_CODE);
}

export function shouldImportRecord(record, forceImport = false) {
  return forceImport || !isSuccessfulImport(record);
}

async function ensureFile(label, filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} 不是文件: ${filePath}`);
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`${label} 不存在: ${filePath}`);
    }
    throw error;
  }
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('记录文件必须是 JSON 对象或 JSON 数组');
  }

  if (Array.isArray(parsed)) {
    return {
      generated_at: new Date().toISOString(),
      records: parsed,
    };
  }

  if (!Array.isArray(parsed.records)) {
    throw new Error('记录文件缺少 records 数组');
  }

  return { ...parsed };
}

export function buildImportArgs(cliPath, absolutePath, importTimeoutMs = DEFAULT_IMPORT_TIMEOUT_MS) {
  return [
    cliPath,
    'import-jsonl',
    absolutePath,
    '--max-files',
    '1',
    '--manual-index',
    '--no-lesson-extraction',
    '--timeout-ms',
    String(importTimeoutMs),
  ];
}

export function buildFinalizeArgs(cliPath) {
  return [cliPath, 'finalize-replay-index'];
}

export function parseCommandText(cliPath, absolutePath, envFile, importTimeoutMs = DEFAULT_IMPORT_TIMEOUT_MS) {
  const quote = (value) => (value.includes(' ') ? `"${value}"` : value);
  return `node --env-file=${quote(envFile)} ${buildImportArgs(quote(cliPath), quote(absolutePath), importTimeoutMs).join(' ')}`;
}

function isUnauthorizedText(text) {
  return /unauthorized|access denied|access.*token|invalid token|missing token|401|403|AGENTMEMORY_SECRET|token/i.test(text || '');
}

export function isTransientServiceText(text) {
  return /Invocation stopped|livez probe failed|reachable but unhealthy|HTTP 404|router .*not found|temporarily unavailable/i.test(text || '');
}

export function classifyImportError(exitCode, stdout, stderr, processError = null) {
  if (exitCode === SUCCESS_EXIT_CODE) {
    return null;
  }

  const combined = `${stdout || ''}\n${stderr || ''}`;
  if (isTransientServiceText(combined)) {
    return '服务短暂不可用';
  }
  if (isUnauthorizedText(combined)) {
    return '服务鉴权失败';
  }
  if (processError) {
    return processError;
  }
  return 'import-jsonl 执行失败';
}

function redactSensitiveText(text) {
  if (!text) {
    return text;
  }

  return String(text)
    .replace(/(AGENTMEMORY_SECRET\s*=\s*)[^\s"'`]+/gi, '$1<redacted>')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1<redacted>')
    .replace(/((?:access_)?token\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>')
    .replace(/(secret\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>');
}

function runProcess(command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.once('error', (error) => {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        error: String(error.message || error),
      });
    });

    child.once('close', (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

function sleep(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runDoctor(doctorPath, expectedDiagnosis) {
  const startedAt = new Date().toISOString();
  const proc = await runProcess('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    doctorPath,
  ]);
  const endedAt = new Date().toISOString();

  const diagnosis = `${proc.stdout}\n${proc.stderr}`
    .split(/\r?\n/)
    .find((line) => line.startsWith('diagnosis='));

  if (diagnosis === expectedDiagnosis) {
    return {
      ok: true,
      diagnosis,
      startedAt,
      endedAt,
      stdout: redactSensitiveText(proc.stdout),
      stderr: redactSensitiveText(proc.stderr),
      exitCode: proc.exitCode,
    };
  }

  const error = new Error('doctor_not_ready');
  error.doctor = {
    expectedDiagnosis,
    diagnosis: diagnosis || null,
    exitCode: proc.exitCode,
    stdout: redactSensitiveText(proc.stdout),
    stderr: redactSensitiveText(proc.stderr),
  };
  throw error;
}

async function importOne(record, cliPath, envFile, importTimeoutMs, transientRetries, transientRetryDelayMs) {
  const startedAt = new Date().toISOString();
  const args = [
    `--env-file=${envFile}`,
    ...buildImportArgs(cliPath, record.absolute_path, importTimeoutMs),
  ];

  let result = null;
  let rawStderr = '';
  let rawStdout = '';
  let errorText = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= transientRetries; attempt += 1) {
    attempts = attempt + 1;
    result = await runProcess('node', args, {
      III_REST_PORT: REQUIRED_REST_PORT,
    });
    rawStderr = result.stderr || '';
    rawStdout = result.stdout || '';
    errorText = classifyImportError(result.exitCode, rawStdout, rawStderr, result.error);
    if (errorText !== '服务短暂不可用' || attempt >= transientRetries) {
      break;
    }
    await sleep(transientRetryDelayMs);
  }

  const endedAt = new Date().toISOString();
  const unauthorized = errorText === '服务鉴权失败';

  return {
    command: parseCommandText(cliPath, record.absolute_path, envFile, importTimeoutMs),
    exit_code: result.exitCode,
    stdout: unauthorized ? '' : redactSensitiveText(rawStdout),
    stderr: unauthorized ? '' : redactSensitiveText(rawStderr),
    started_at: startedAt,
    ended_at: endedAt,
    attempts,
    error: redactSensitiveText(errorText),
  };
}

async function finalizeReplayIndex(cliPath, envFile) {
  const startedAt = new Date().toISOString();
  const quote = (value) => (value.includes(' ') ? `"${value}"` : value);
  const args = [
    `--env-file=${envFile}`,
    ...buildFinalizeArgs(cliPath),
  ];
  const result = await runProcess('node', args, {
    III_REST_PORT: REQUIRED_REST_PORT,
  });
  const endedAt = new Date().toISOString();
  return {
    command: `node --env-file=${quote(envFile)} ${buildFinalizeArgs(quote(cliPath)).join(' ')}`,
    exit_code: result.exitCode,
    stdout: redactSensitiveText(result.stdout || ''),
    stderr: redactSensitiveText(result.stderr || ''),
    started_at: startedAt,
    ended_at: endedAt,
    error: result.exitCode === SUCCESS_EXIT_CODE ? null : 'finalize-replay-index 执行失败',
  };
}

async function writeStateAtomically(filePath, state) {
  const tempPath = `${filePath}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, payload, 'utf8');

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      await fs.unlink(filePath).catch(() => {});
      await fs.rename(tempPath, filePath);
      return;
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return 0;
  }

  const recordPath = path.resolve(options.recordPath);
  const cliPath = path.resolve(options.cliPath);
  const envFile = path.resolve(options.envFile);
  const doctorScript = path.resolve(options.doctorScript);

  await ensureFile('record', recordPath);
  await ensureFile('agentmemory cli', cliPath);
  await ensureFile('env file', envFile);
  await ensureFile('doctor script', doctorScript);

  const doctor = await runDoctor(doctorScript, options.doctorOk);

  const raw = await fs.readFile(recordPath, 'utf8');
  const parsed = JSON.parse(raw);
  const state = normalizeState(parsed);
  const records = state.records;

  state.import_summary = state.import_summary || {};
  state.import_summary.doctor = doctor;
  state.import_summary.import_timeout_ms = options.importTimeoutMs;
  state.import_summary.force_import = options.forceImport;
  state.import_summary.transient_retries = options.transientRetries;
  state.import_summary.transient_retry_delay_ms = options.transientRetryDelayMs;
  let failedCount = 0;

  for (const item of records) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const absolutePath = typeof item.absolute_path === 'string' ? item.absolute_path.trim() : '';
    if (!absolutePath) {
      failedCount += 1;
      item.import_cli = {
        command: parseCommandText(cliPath, '', envFile),
        exit_code: 2,
        stdout: '',
        stderr: '',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: 'records 中缺少 absolute_path',
      };
      await writeStateAtomically(recordPath, state);
      continue;
    }

    if (!shouldImportRecord(item, options.forceImport)) {
      continue;
    }

    const result = await importOne(
      item,
      cliPath,
      envFile,
      options.importTimeoutMs,
      options.transientRetries,
      options.transientRetryDelayMs,
    );
    item.import_cli = result;
    await writeStateAtomically(recordPath, state);

    if (result.exit_code !== SUCCESS_EXIT_CODE) {
      failedCount += 1;
    }

    if (result.exit_code !== SUCCESS_EXIT_CODE && result.error === '服务鉴权失败') {
      throw new Error('服务鉴权失败，请检查 --env-file 是否提供且 token 有效。');
    }
  }

  state.generated_at = state.generated_at || new Date().toISOString();
  state.import_summary.last_completed_at = new Date().toISOString();
  if (failedCount > 0) {
    await writeStateAtomically(recordPath, state);
    throw new Error(`存在 ${failedCount} 个文件导入失败，已写入执行记录，可修复后重跑。`);
  }

  state.import_summary.finalize_replay_index = await finalizeReplayIndex(cliPath, envFile);
  await writeStateAtomically(recordPath, state);
  if (state.import_summary.finalize_replay_index.exit_code !== SUCCESS_EXIT_CODE) {
    throw new Error('finalize-replay-index 执行失败，已写入执行记录。');
  }

  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    if (error && /doctor_not_ready/.test(String(error.message || ''))) {
      const doctor = error.doctor || {};
      console.error(`Doctor 检查未通过：期望 ${doctor.expectedDiagnosis || DEFAULT_DOCTOR_OK}，实际 ${doctor.diagnosis || '无 diagnosis'}。`);
    } else if (error && /缺少 --env-file|服务鉴权失败/.test(String(error.message || ''))) {
      console.error(error.message);
    } else {
      console.error(error.message || String(error));
    }
    process.exitCode = 1;
  });
}
