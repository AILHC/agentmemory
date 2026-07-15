import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { queryAndValidateProcessChain, type ProcessChain } from "./platform/powershell-runner";
import { assertWorkerSlotAvailable, isProcessAlive as defaultIsProcessAlive } from "./worker-lifecycle-lock";

export type SupervisorState = "CLOSED" | "OPEN" | "HALF_OPEN" | "STOPPING";

export interface SupervisorEvent {
  event: "supervisor_started" | "worker_started" | "worker_exited" | "spawn_failed" | "restart_scheduled" | "circuit_open" | "circuit_half_open" | "circuit_closed" | "stopping" | "parent_check_failed" | "orphan_worker_detected";
  at: string;
  instanceId: string;
  workerPid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  uptimeMs?: number;
  state?: SupervisorState;
  failureCount?: number;
  delayMs?: number;
  reason?: string;
  cmdPid?: number;
  iiiPid?: number;
  cmdStartedAt?: string;
  iiiStartedAt?: string;
}

export interface WorkerProcess {
  pid?: number;
  connected?: boolean;
  send(message: unknown, callback?: (error?: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface WorkerSupervisorOptions {
  instanceId: string;
  workerEntry: string;
  home: string;
  supervisorStartedAt?: string;
  stopSignal?: AbortSignal;
  expectedInstallHome?: string;
  expectedConfig?: string;
  monitorParents?: boolean;
  shutdownTimeoutMs?: number;
  stableAfterMs?: number;
}

export interface SupervisorDependencies {
  spawnWorker: (entry: string, lifecycle: { instanceId: string; supervisorStartedAt: string }) => WorkerProcess;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  appendEvent: (event: SupervisorEvent) => Promise<void> | void;
  isProcessAlive: (pid: number) => boolean;
  verifyProcessChain: () => Promise<ProcessChain | boolean>;
  acquireSupervisorLock: (home: string, instanceId: string, startedAt: string, isAlive: (pid: number) => boolean) => { release(): void };
  readShutdownRequest: (home: string, instanceId: string, supervisorPid: number, startedAt: string) => boolean;
}

export type SupervisorCli =
  | { mode: "run"; instanceId: string; workerEntry: string }
  | { mode: "request"; instanceId: string; home: string };

const BACKOFFS = [1_000, 5_000, 15_000, 30_000] as const;
const FAILURE_WINDOW_MS = 600_000;
const COOLDOWN_MS = 300_000;

export class RestartCircuit {
  state: SupervisorState = "CLOSED";
  private failures: number[] = [];

  get failureCount(): number {
    return this.failures.length;
  }

  recordFailure(now: number): { kind: "backoff" | "open"; delayMs: number } {
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      return { kind: "open", delayMs: COOLDOWN_MS };
    }
    this.failures = this.failures.filter((failureAt) => now - failureAt < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= 5) {
      this.state = "OPEN";
      return { kind: "open", delayMs: COOLDOWN_MS };
    }
    return { kind: "backoff", delayMs: BACKOFFS[this.failures.length - 1] };
  }

  beginHalfOpen(): void {
    this.state = "HALF_OPEN";
  }

  recordStable(): void {
    this.failures = [];
    this.state = "CLOSED";
  }

  stop(): void {
    this.state = "STOPPING";
  }
}

function abortError(reason = "STOPPING"): Error {
  return new Error(reason);
}

export function sleepForSupervisor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
  });
}

function appendSupervisorEvent(logPath: string, event: SupervisorEvent): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    console.error("[agentmemory-supervisor] EVENT_LOG_WRITE_FAILED");
  }
}

interface SupervisorPidRecord {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  instanceId: string;
}

function readSupervisorPid(path: string): SupervisorPidRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as SupervisorPidRecord;
    return record.schemaVersion === 1 && Number.isSafeInteger(record.pid) ? record : null;
  } catch {
    return null;
  }
}

export function acquireSupervisorPidLock(
  home: string,
  instanceId: string,
  startedAt: string,
  isAlive: (pid: number) => boolean,
): { release(): void } {
  mkdirSync(home, { recursive: true });
  const path = join(home, "supervisor.pid");
  const existing = readSupervisorPid(path);
  if (!existing && existsSync(path)) throw new Error("SUPERVISOR_LOCK_INVALID");
  if (existing && isAlive(existing.pid)) throw new Error("SUPERVISOR_ALREADY_RUNNING");
  if (existsSync(path)) renameSync(path, `${path}.stale-${Date.now()}`);
  const record: SupervisorPidRecord = { schemaVersion: 1, pid: process.pid, startedAt, instanceId };
  const descriptor = openSync(path, "wx");
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return {
    release() {
      const current = readSupervisorPid(path);
      if (current?.pid === record.pid && current.startedAt === record.startedAt && current.instanceId === record.instanceId) {
        try { unlinkSync(path); } catch {}
      }
    },
  };
}

interface ShutdownRequest {
  schemaVersion: 1;
  instanceId: string;
  targetSupervisorPid: number;
  targetStartedAt: string;
  requestId: string;
  requestedAt: string;
}

function readMatchingShutdownRequest(home: string, instanceId: string, supervisorPid: number, startedAt: string): boolean {
  const path = join(home, "supervisor.shutdown.json");
  try {
    if (!existsSync(path)) return false;
    const request = JSON.parse(readFileSync(path, "utf8")) as ShutdownRequest;
    if (request.schemaVersion === 1 && request.instanceId === instanceId && request.targetSupervisorPid === supervisorPid && request.targetStartedAt === startedAt) {
      try { unlinkSync(path); } catch {}
      return true;
    }
    try { renameSync(path, `${path}.stale-${Date.now()}`); } catch {}
  } catch {
    try {
      if (existsSync(path)) renameSync(path, `${path}.stale-${Date.now()}`);
    } catch {}
  }
  return false;
}

function defaultSpawnWorker(entry: string, lifecycle: { instanceId: string; supervisorStartedAt: string }): ChildProcess {
  return spawn(process.execPath, [resolve(entry)], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTMEMORY_SUPERVISOR_PID: String(process.pid),
      AGENTMEMORY_SUPERVISOR_STARTED_AT: lifecycle.supervisorStartedAt,
      AGENTMEMORY_INSTANCE_ID: lifecycle.instanceId,
    },
  });
}

function defaultDependencies(options: WorkerSupervisorOptions): SupervisorDependencies {
  const installHome = options.expectedInstallHome ?? process.env.AGENTMEMORY_INSTALL_HOME ?? "";
  const config = options.expectedConfig ?? process.env.AGENTMEMORY_III_CONFIG ?? "";
  const configuredLog = process.env.AGENTMEMORY_WORKER_SUPERVISOR_LOG;
  const logPath = configuredLog && isAbsolute(configuredLog)
    ? configuredLog
    : join(dirname(options.home), "logs", "worker-supervisor.jsonl");
  return {
    spawnWorker: defaultSpawnWorker,
    sleep: sleepForSupervisor,
    now: Date.now,
    appendEvent: (event) => appendSupervisorEvent(logPath, event),
    isProcessAlive: defaultIsProcessAlive,
    verifyProcessChain: async () => {
      if (process.platform !== "win32") return true;
      if (!installHome || !config) throw new Error("PROCESS_CHAIN_CONFIG_MISSING");
      return queryAndValidateProcessChain({ supervisorPid: process.pid, expectedInstallHome: installHome, expectedConfig: config });
    },
    acquireSupervisorLock: acquireSupervisorPidLock,
    readShutdownRequest: readMatchingShutdownRequest,
  };
}

function combineDependencies(options: WorkerSupervisorOptions, supplied?: SupervisorDependencies): SupervisorDependencies {
  return supplied ?? defaultDependencies(options);
}

function waitForWorkerClose(worker: WorkerProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: boolean }> {
  return new Promise((resolveClose) => {
    let errorSeen = false;
    const onError = () => {
      errorSeen = true;
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      worker.removeListener("error", onError);
      resolveClose({ code, signal, spawnError: errorSeen });
    };
    worker.once("error", onError);
    worker.once("close", onClose);
  });
}

export function waitForSupervisorAbort(signal: AbortSignal): {
  promise: Promise<"stop">;
  cancel(): void;
} {
  if (signal.aborted) return { promise: Promise.resolve("stop"), cancel() {} };
  let active = true;
  let resolveStop!: (value: "stop") => void;
  const onAbort = () => {
    if (!active) return;
    active = false;
    signal.removeEventListener("abort", onAbort);
    resolveStop("stop");
  };
  const promise = new Promise<"stop">((resolve) => {
    resolveStop = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel() {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

async function stopWorker(worker: WorkerProcess, close: Promise<unknown>, deps: SupervisorDependencies, timeoutMs: number): Promise<void> {
  try {
    if (worker.connected !== false) worker.send({ type: "agentmemory:shutdown" }, () => undefined);
  } catch {}
  const grace = new AbortController();
  const winner = await Promise.race([
    close.then(() => "closed" as const),
    deps.sleep(timeoutMs, grace.signal).then(() => "timeout" as const),
  ]).catch(() => "timeout" as const);
  grace.abort();
  if (winner === "timeout") {
    try { worker.kill("SIGTERM"); } catch {}
  }
}

function eventBase(options: WorkerSupervisorOptions, deps: SupervisorDependencies): Pick<SupervisorEvent, "at" | "instanceId"> {
  return { at: new Date(deps.now()).toISOString(), instanceId: options.instanceId };
}

async function startParentMonitor(
  options: WorkerSupervisorOptions,
  deps: SupervisorDependencies,
  chain: ProcessChain | null,
  stop: AbortController,
  spawnGate: { allowed: boolean },
): Promise<void> {
  if (options.monitorParents === false) return;
  let nextIdentityCheckAt = deps.now() + 60_000;
  let identityFailures = 0;
  while (!stop.signal.aborted) {
    try {
      await deps.sleep(1_000, stop.signal);
    } catch {
      return;
    }
    if (chain && (!deps.isProcessAlive(chain.cmdPid) || !deps.isProcessAlive(chain.iiiPid))) {
      stop.abort(abortError("PARENT_PROCESS_MISSING"));
      return;
    }
    if (deps.readShutdownRequest(options.home, options.instanceId, process.pid, options.supervisorStartedAt!)) {
      stop.abort(abortError("CONTROL_FILE_REQUEST"));
      return;
    }
    if (deps.now() < nextIdentityCheckAt) continue;
    try {
      const verified = await deps.verifyProcessChain();
      if (verified !== true) {
        if (
          chain &&
          (verified.cmdPid !== chain.cmdPid ||
            verified.iiiPid !== chain.iiiPid ||
            verified.cmdStartedAt !== chain.cmdStartedAt ||
            verified.iiiStartedAt !== chain.iiiStartedAt)
        ) {
          throw new Error("PROCESS_CHAIN_IDENTITY_CHANGED");
        }
        chain = verified;
      }
      spawnGate.allowed = true;
      identityFailures = 0;
      nextIdentityCheckAt = deps.now() + 60_000;
    } catch {
      spawnGate.allowed = false;
      identityFailures++;
      await deps.appendEvent({ ...eventBase(options, deps), event: "parent_check_failed", state: "STOPPING", failureCount: identityFailures, reason: "PROCESS_CHAIN_RECHECK_FAILED" });
      if (identityFailures >= 2) {
        stop.abort(abortError("PROCESS_CHAIN_RECHECK_FAILED"));
        return;
      }
      try { await deps.sleep(5_000, stop.signal); } catch { return; }
      nextIdentityCheckAt = deps.now();
    }
  }
}

async function verifyInitialProcessChain(
  options: WorkerSupervisorOptions,
  deps: SupervisorDependencies,
  stop: AbortController,
): Promise<ProcessChain | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const verified = await deps.verifyProcessChain();
      return verified === true ? null : verified;
    } catch {
      await deps.appendEvent({
        ...eventBase(options, deps),
        event: "parent_check_failed",
        state: "CLOSED",
        failureCount: attempt,
        reason: "PROCESS_CHAIN_STARTUP_FAILED",
      });
      if (attempt === 2) throw new Error("PROCESS_CHAIN_STARTUP_FAILED");
      await deps.sleep(5_000, stop.signal);
    }
  }
  throw new Error("PROCESS_CHAIN_STARTUP_FAILED");
}

export async function runWorkerSupervisor(
  rawOptions: WorkerSupervisorOptions,
  suppliedDependencies?: SupervisorDependencies,
): Promise<void> {
  const options: WorkerSupervisorOptions = {
    ...rawOptions,
    supervisorStartedAt: rawOptions.supervisorStartedAt ?? new Date().toISOString(),
  };
  const deps = combineDependencies(options, suppliedDependencies);
  const lock = deps.acquireSupervisorLock(options.home, options.instanceId, options.supervisorStartedAt!, deps.isProcessAlive);
  const stop = new AbortController();
  const circuit = new RestartCircuit();
  let activeWorker: WorkerProcess | null = null;
  let activeClose: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: boolean }> | null = null;
  let parentMonitor: Promise<void> = Promise.resolve();
  const spawnGate = { allowed: true };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const requestStop = () => stop.abort(abortError());

  if (options.stopSignal) {
    if (options.stopSignal.aborted) requestStop();
    else options.stopSignal.addEventListener("abort", requestStop, { once: true });
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as NodeJS.Signals[]) {
    const handler = () => requestStop();
    try {
      process.on(signal, handler);
      signalHandlers.set(signal, handler);
    } catch {}
  }

  try {
    let chain: ProcessChain | null = null;
    if (options.monitorParents !== false) {
      chain = await verifyInitialProcessChain(options, deps, stop);
    }
    await deps.appendEvent({
      ...eventBase(options, deps),
      event: "supervisor_started",
      state: circuit.state,
      cmdPid: chain?.cmdPid,
      iiiPid: chain?.iiiPid,
      cmdStartedAt: chain?.cmdStartedAt,
      iiiStartedAt: chain?.iiiStartedAt,
    });
    parentMonitor = startParentMonitor(options, deps, chain, stop, spawnGate).catch(async () => {
      spawnGate.allowed = false;
      stop.abort(abortError("PARENT_MONITOR_FAILED"));
      try {
        await deps.appendEvent({
          ...eventBase(options, deps),
          event: "parent_check_failed",
          state: "STOPPING",
          reason: "PARENT_MONITOR_FAILED",
        });
      } catch {}
    });

    while (!stop.signal.aborted) {
      while (!spawnGate.allowed && !stop.signal.aborted) {
        try { await deps.sleep(100, stop.signal); } catch { break; }
      }
      if (stop.signal.aborted) break;
      try {
        assertWorkerSlotAvailable(options.home, deps.isProcessAlive);
      } catch {
        await deps.appendEvent({
          ...eventBase(options, deps),
          event: "orphan_worker_detected",
          state: "STOPPING",
          reason: "WORKER_SLOT_OCCUPIED",
        });
        stop.abort(abortError("WORKER_SLOT_OCCUPIED"));
        break;
      }
      const startedAt = deps.now();
      try {
        activeWorker = deps.spawnWorker(options.workerEntry, { instanceId: options.instanceId, supervisorStartedAt: options.supervisorStartedAt! });
      } catch {
        activeWorker = null;
        activeClose = null;
        await deps.appendEvent({ ...eventBase(options, deps), event: "spawn_failed", state: circuit.state, failureCount: circuit.failureCount + 1, reason: "SPAWN_THROWN" });
        const decision = circuit.recordFailure(deps.now());
        const event = decision.kind === "open" ? "circuit_open" : "restart_scheduled";
        await deps.appendEvent({ ...eventBase(options, deps), event, state: circuit.state, failureCount: circuit.failureCount, delayMs: decision.delayMs });
        try { await deps.sleep(decision.delayMs, stop.signal); } catch { break; }
        if (decision.kind === "open") {
          circuit.beginHalfOpen();
          await deps.appendEvent({ ...eventBase(options, deps), event: "circuit_half_open", state: circuit.state });
        }
        continue;
      }

      activeClose = waitForWorkerClose(activeWorker);
      await deps.appendEvent({ ...eventBase(options, deps), event: "worker_started", workerPid: activeWorker.pid, state: circuit.state, failureCount: circuit.failureCount });
      const stableController = new AbortController();
      const workerResult = activeClose.then((outcome) => ({ kind: "closed" as const, outcome }));
      const stableResult = deps.sleep(options.stableAfterMs ?? 600_000, stableController.signal)
        .then(() => ({ kind: "stable" as const }))
        .catch(() => ({ kind: "cancelled" as const }));
      const stopWaiter = waitForSupervisorAbort(stop.signal);
      const stopResult = stopWaiter.promise.then(() => ({ kind: "stop" as const }));
      let result = await Promise.race([workerResult, stableResult, stopResult]);

      if (result.kind === "stable") {
        circuit.recordStable();
        await deps.appendEvent({ ...eventBase(options, deps), event: "circuit_closed", workerPid: activeWorker.pid, state: circuit.state, failureCount: 0 });
        result = await Promise.race([workerResult, stopResult]);
      }
      stableController.abort();
      stopWaiter.cancel();
      if (result.kind === "stop" || result.kind === "cancelled") break;

      const outcome = result.outcome;
      const exitedWorkerPid = activeWorker.pid;
      activeWorker = null;
      activeClose = null;
      await deps.appendEvent({
        ...eventBase(options, deps),
        event: outcome.spawnError ? "spawn_failed" : "worker_exited",
        workerPid: exitedWorkerPid,
        exitCode: outcome.code,
        signal: outcome.signal,
        uptimeMs: Math.max(0, deps.now() - startedAt),
        state: circuit.state,
        failureCount: circuit.failureCount + 1,
        reason: outcome.spawnError ? "SPAWN_ERROR" : "UNEXPECTED_EXIT",
      });
      const decision = circuit.recordFailure(deps.now());
      const event = decision.kind === "open" ? "circuit_open" : "restart_scheduled";
      await deps.appendEvent({ ...eventBase(options, deps), event, state: circuit.state, failureCount: circuit.failureCount, delayMs: decision.delayMs });
      try { await deps.sleep(decision.delayMs, stop.signal); } catch { break; }
      if (decision.kind === "open") {
        circuit.beginHalfOpen();
        await deps.appendEvent({ ...eventBase(options, deps), event: "circuit_half_open", state: circuit.state });
      }
    }
  } finally {
    circuit.stop();
    await deps.appendEvent({ ...eventBase(options, deps), event: "stopping", state: circuit.state, reason: "STOP_REQUESTED" });
    if (activeWorker && activeClose) await stopWorker(activeWorker, activeClose, deps, options.shutdownTimeoutMs ?? 10_000);
    stop.abort();
    await parentMonitor;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (options.stopSignal) options.stopSignal.removeEventListener("abort", requestStop);
    lock.release();
  }
}

export function parseSupervisorCli(args: string[]): SupervisorCli {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith("--") || !["--request-shutdown", "--instance-id", "--worker-entry", "--home"].includes(key)) throw new Error("UNKNOWN_ARGUMENT");
    if (key === "--request-shutdown") {
      values.set(key, true);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("ARGUMENT_VALUE_MISSING");
    values.set(key, value);
  }
  const instanceId = values.get("--instance-id");
  if (typeof instanceId !== "string") throw new Error("INSTANCE_ID_REQUIRED");
  if (values.has("--request-shutdown")) {
    if (values.has("--worker-entry")) throw new Error("CLI_MODE_CONFLICT");
    const home = values.get("--home");
    if (typeof home !== "string") throw new Error("HOME_REQUIRED");
    return { mode: "request", instanceId, home };
  }
  if (values.has("--home")) throw new Error("CLI_MODE_CONFLICT");
  const workerEntry = values.get("--worker-entry");
  if (typeof workerEntry !== "string") throw new Error("WORKER_ENTRY_REQUIRED");
  return { mode: "run", instanceId, workerEntry };
}

export function requestSupervisorShutdown(home: string, instanceId: string): 0 | 2 | 3 {
  const record = readSupervisorPid(join(home, "supervisor.pid"));
  if (!record) return 2;
  if (record.instanceId !== instanceId || !defaultIsProcessAlive(record.pid)) return 3;
  const requestedAt = new Date().toISOString();
  const request: ShutdownRequest = {
    schemaVersion: 1,
    instanceId,
    targetSupervisorPid: record.pid,
    targetStartedAt: record.startedAt,
    requestId: `${process.pid}-${Date.now()}`,
    requestedAt,
  };
  const target = join(home, "supervisor.shutdown.json");
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(request)}\n`, "utf8");
  renameSync(temporary, target);
  return 0;
}

async function main(): Promise<void> {
  const cli = parseSupervisorCli(process.argv.slice(2));
  if (cli.mode === "request") {
    process.exitCode = requestSupervisorShutdown(resolve(cli.home), cli.instanceId);
    return;
  }
  const home = process.env.AGENTMEMORY_HOME?.trim();
  if (!home) throw new Error("AGENTMEMORY_HOME_REQUIRED");
  await runWorkerSupervisor({ instanceId: cli.instanceId, workerEntry: cli.workerEntry, home: resolve(home) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("[agentmemory-supervisor] FATAL");
    process.exitCode = 1;
  });
}
