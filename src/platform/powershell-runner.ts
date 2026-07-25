import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let cachedPowerShellExecutable: string | null = null;

export interface WindowsProcessRecord {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  ExecutablePath: string;
  CommandLine: string;
  CreationDate?: string;
}

export interface ProcessChain {
  supervisorPid: number;
  cmdPid: number;
  iiiPid: number;
  cmdStartedAt?: string;
  iiiStartedAt?: string;
}

export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function resolvePowerShellExecutable(): string {
  if (cachedPowerShellExecutable) return cachedPowerShellExecutable;
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    const located = spawnSync("where.exe", [candidate], {
      encoding: "utf8",
      windowsHide: true,
    });
    const executable = located.status === 0
      ? located.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
      : undefined;
    if (executable) {
      cachedPowerShellExecutable = executable;
      return executable;
    }
  }
  throw new Error("POWERSHELL_UNAVAILABLE");
}

export async function runPowerShellEncoded(
  command: string,
  timeoutMs = 5_000,
): Promise<string> {
  const executable = resolvePowerShellExecutable();
  const encodedCommand = [
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    command,
  ].join("\n");
  const { stdout } = await execFileAsync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(encodedCommand)],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

function normalizedPath(value: string): string {
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

function commandLineArguments(commandLine: string): string[] {
  const argumentsList: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/gu;
  for (const match of commandLine.matchAll(pattern)) {
    argumentsList.push(match[1] ?? match[2]);
  }
  return argumentsList;
}

function configArgument(commandLine: string): string | null {
  const argumentsList = commandLineArguments(commandLine);
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument.toLowerCase() === "--config") return argumentsList[index + 1] ?? null;
    if (argument.toLowerCase().startsWith("--config=")) return argument.slice("--config=".length);
  }
  return null;
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function resolveProcessSnapshotScript(supervisorEntry = process.argv[1] ?? ""): string {
  if (!supervisorEntry) throw new Error("PROCESS_SNAPSHOT_SCRIPT_MISSING");
  const appRoot = resolve(dirname(supervisorEntry), "..");
  const candidates = [
    join(appRoot, "scripts", "_agentmemory-local-common.ps1"),
    join(appRoot, "ops", "scripts", "_agentmemory-local-common.ps1"),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) throw new Error("PROCESS_SNAPSHOT_SCRIPT_MISSING");
  return script;
}

export function buildProcessChainSnapshotCommand(snapshotScript: string, supervisorPid: number): string {
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) {
    throw new Error("SUPERVISOR_PID_INVALID");
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    `. ${powerShellLiteral(snapshotScript)}`,
    `$supervisorPid = ${supervisorPid}`,
    "$all = @(Get-AmProcesses)",
    "$supervisor = Get-AmProcessById -ProcessId $supervisorPid -AllProcesses $all",
    "if (-not $supervisor) { throw 'SUPERVISOR_PROCESS_MISSING' }",
    "$cmd = Get-AmProcessById -ProcessId ([int]$supervisor.ParentProcessId) -AllProcesses $all",
    "if (-not $cmd) { throw 'SUPERVISOR_PARENT_MISSING' }",
    "$iii = Get-AmProcessById -ProcessId ([int]$cmd.ParentProcessId) -AllProcesses $all",
    "if (-not $iii) { throw 'SUPERVISOR_ANCESTOR_MISSING' }",
    "@($supervisor, $cmd, $iii) | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress",
  ].join("\n");
}

export function parseProcessChain(
  serialized: string,
  expected: {
    supervisorPid: number;
    expectedInstallHome: string;
    expectedConfig: string;
  },
): ProcessChain {
  const parsed = JSON.parse(serialized) as WindowsProcessRecord | WindowsProcessRecord[];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const byPid = new Map(records.map((record) => [Number(record.ProcessId), record]));
  const supervisor = byPid.get(expected.supervisorPid);
  if (!supervisor) throw new Error("SUPERVISOR_PROCESS_MISSING");
  const cmd = byPid.get(Number(supervisor.ParentProcessId));
  if (!cmd || cmd.Name.toLowerCase() !== "cmd.exe") throw new Error("SUPERVISOR_PARENT_INVALID");
  const iii = byPid.get(Number(cmd.ParentProcessId));
  if (!iii || iii.Name.toLowerCase() !== "iii.exe") throw new Error("SUPERVISOR_ANCESTOR_INVALID");

  const expectedIii = normalizedPath(resolve(expected.expectedInstallHome, "bin", "iii.exe"));
  if (normalizedPath(iii.ExecutablePath) !== expectedIii) throw new Error("III_EXECUTABLE_MISMATCH");
  const expectedConfig = normalizedPath(expected.expectedConfig);
  const configuredPath = configArgument(iii.CommandLine);
  if (!configuredPath || normalizedPath(configuredPath) !== expectedConfig) throw new Error("III_CONFIG_MISMATCH");

  return {
    supervisorPid: expected.supervisorPid,
    cmdPid: cmd.ProcessId,
    iiiPid: iii.ProcessId,
    cmdStartedAt: cmd.CreationDate,
    iiiStartedAt: iii.CreationDate,
  };
}

export async function queryAndValidateProcessChain(expected: {
  supervisorPid: number;
  expectedInstallHome: string;
  expectedConfig: string;
}): Promise<ProcessChain> {
  const snapshotScript = resolveProcessSnapshotScript();
  const command = buildProcessChainSnapshotCommand(snapshotScript, expected.supervisorPid);
  return parseProcessChain(await runPowerShellEncoded(command, 10_000), expected);
}
