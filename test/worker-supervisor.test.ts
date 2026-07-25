import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  RestartCircuit,
  acquireSupervisorPidLock,
  parseSupervisorCli,
  requestSupervisorShutdown,
  runWorkerSupervisor,
  sleepForSupervisor,
  waitForSupervisorAbort,
  type SupervisorDependencies,
  type SupervisorEvent,
  type WorkerProcess,
} from "../src/worker-supervisor";
import {
  acquireWorkerLifecycleLock,
  createWorkerShutdownCoordinator,
  readOptionalWorkerLifecycleIdentity,
  readWorkerLifecycleIdentity,
  resolveWorkerLifecycleIdentity,
} from "../src/worker-lifecycle-lock";
import {
  buildProcessChainSnapshotCommand,
  encodePowerShellCommand,
  parseProcessChain,
} from "../src/platform/powershell-runner";

class FakeWorker extends EventEmitter implements WorkerProcess {
  readonly pid: number;
  connected = true;
  readonly send = vi.fn((message: unknown, callback?: (error?: Error | null) => void) => {
    void message;
    callback?.(null);
  });
  readonly kill = vi.fn(() => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

function baseDependencies(overrides: Partial<SupervisorDependencies> = {}): SupervisorDependencies {
  return {
    spawnWorker: vi.fn(),
    sleep: vi.fn(async (_ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw signal.reason;
    }),
    now: vi.fn(() => 1_000),
    appendEvent: vi.fn(async () => undefined),
    isProcessAlive: vi.fn(() => true),
    verifyProcessChain: vi.fn(async () => true),
    acquireSupervisorLock: vi.fn(() => ({ release: vi.fn() })),
    readShutdownRequest: vi.fn(() => false),
    ...overrides,
  };
}

describe("worker supervisor restart policy", () => {
  it("uses four bounded backoffs and opens the circuit on the fifth failure", () => {
    const circuit = new RestartCircuit();
    expect([0, 1, 2, 3].map((index) => circuit.recordFailure(index * 1_000))).toEqual([
      { kind: "backoff", delayMs: 1_000 },
      { kind: "backoff", delayMs: 5_000 },
      { kind: "backoff", delayMs: 15_000 },
      { kind: "backoff", delayMs: 30_000 },
    ]);
    expect(circuit.recordFailure(4_000)).toEqual({ kind: "open", delayMs: 300_000 });
    expect(circuit.state).toBe("OPEN");
  });

  it("reopens immediately after a half-open failure and resets only after ten stable minutes", () => {
    const circuit = new RestartCircuit();
    for (let index = 0; index < 5; index++) circuit.recordFailure(index * 1_000);
    circuit.beginHalfOpen();
    expect(circuit.state).toBe("HALF_OPEN");
    expect(circuit.recordFailure(5_000)).toEqual({ kind: "open", delayMs: 300_000 });
    circuit.beginHalfOpen();
    circuit.recordStable();
    expect(circuit.state).toBe("CLOSED");
    expect(circuit.recordFailure(700_000)).toEqual({ kind: "backoff", delayMs: 1_000 });
  });
});

describe("worker supervisor process lifecycle", () => {
  it("keeps abort listeners bounded after normal sleep and cancelled abort waits", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let activeListeners = 0;
    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      activeListeners++;
      return originalAdd(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      activeListeners--;
      return originalRemove(...args);
    }) as AbortSignal["removeEventListener"];

    for (let index = 0; index < 25; index++) await sleepForSupervisor(0, signal);
    for (let index = 0; index < 25; index++) {
      const waiter = waitForSupervisorAbort(signal);
      waiter.cancel();
    }

    expect(activeListeners).toBe(0);
  });

  it.each([
    { code: 17, signal: null },
    { code: 0, signal: null },
    { code: null, signal: "SIGBREAK" },
  ])("treats an unexpected $code/$signal close as a retryable exit", async (exit) => {
    const stop = new AbortController();
    const events: SupervisorEvent[] = [];
    const workers: FakeWorker[] = [];
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        const worker = new FakeWorker(100 + workers.length);
        workers.push(worker);
        queueMicrotask(() => worker.emit("close", exit.code, exit.signal));
        return worker;
      }),
      appendEvent: vi.fn(async (event) => {
        events.push(event);
        if (event.event === "worker_started" && workers.length === 2) stop.abort();
      }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-")), stopSignal: stop.signal, monitorParents: false },
      deps,
    );

    expect(events.map((event) => event.event)).toContain("worker_exited");
    expect(events.map((event) => event.event)).toContain("restart_scheduled");
    expect(workers).toHaveLength(2);
  });

  it("settles an error/close pair once and never overlaps active workers", async () => {
    const stop = new AbortController();
    const workers: FakeWorker[] = [];
    let active = 0;
    let peak = 0;
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        const worker = new FakeWorker(200 + workers.length);
        workers.push(worker);
        active++;
        peak = Math.max(peak, active);
        if (workers.length === 1) {
          queueMicrotask(() => {
            worker.emit("error", new Error("private details must not be logged"));
            active--;
            worker.emit("close", null, null);
          });
        } else {
          queueMicrotask(() => stop.abort());
        }
        return worker;
      }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-")), stopSignal: stop.signal, monitorParents: false },
      deps,
    );

    expect(peak).toBe(1);
    expect(deps.spawnWorker).toHaveBeenCalledTimes(2);
  });

  it("fails closed and records an orphan when a live worker slot is already owned", async () => {
    const home = mkdtempSync(join(tmpdir(), "am-supervisor-orphan-"));
    writeFileSync(join(home, "worker.lock.json"), JSON.stringify({
      schemaVersion: 1,
      workerPid: 777,
      supervisorPid: 776,
      supervisorStartedAt: "2026-01-01T00:00:00.000Z",
      instanceId: "test",
      workerStartedAt: "2026-01-01T00:00:01.000Z",
    }));
    const events: SupervisorEvent[] = [];
    const deps = baseDependencies({
      isProcessAlive: vi.fn((pid) => pid === 777),
      appendEvent: vi.fn(async (event) => { events.push(event); }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home, monitorParents: false },
      deps,
    );

    expect(deps.spawnWorker).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      event: "orphan_worker_detected",
      reason: "WORKER_SLOT_OCCUPIED",
    }));
  });

  it("sends one IPC shutdown and only force-kills after the grace period", async () => {
    const stop = new AbortController();
    const worker = new FakeWorker(301);
    const order: string[] = [];
    worker.send.mockImplementation((_message, callback) => {
      order.push("ipc");
      callback?.(null);
      return true;
    });
    worker.kill.mockImplementation(() => {
      order.push("kill");
      worker.emit("close", null, "SIGTERM");
      return true;
    });
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        queueMicrotask(() => stop.abort());
        return worker;
      }),
      sleep: vi.fn(async (ms) => {
        if (ms === 600_000) return new Promise<void>(() => undefined);
        order.push(`sleep:${ms}`);
      }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-")), stopSignal: stop.signal, monitorParents: false },
      deps,
    );

    expect(order).toEqual(["ipc", "sleep:10000", "kill"]);
    expect(worker.send).toHaveBeenCalledTimes(1);
  });

  it("does not force-kill a worker that acknowledges shutdown by closing", async () => {
    const stop = new AbortController();
    const worker = new FakeWorker(302);
    worker.send.mockImplementation((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => worker.emit("close", 0, null));
      return true;
    });
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        queueMicrotask(() => stop.abort());
        return worker;
      }),
      sleep: vi.fn(() => new Promise<void>(() => undefined)),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-")), stopSignal: stop.signal, monitorParents: false },
      deps,
    );

    expect(worker.kill).not.toHaveBeenCalled();
  });

  it("logs only the fixed event schema", async () => {
    const stop = new AbortController();
    const worker = new FakeWorker(401);
    const events: SupervisorEvent[] = [];
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        queueMicrotask(() => worker.emit("close", 17, null));
        return worker;
      }),
      appendEvent: vi.fn(async (event) => {
        events.push(event);
        if (event.event === "restart_scheduled") stop.abort();
      }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-")), stopSignal: stop.signal, monitorParents: false },
      deps,
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/env|argv|prompt|response|private details|stderr/i);
    for (const event of events) {
      expect(Object.keys(event).every((key) => ["event", "at", "instanceId", "workerPid", "exitCode", "signal", "uptimeMs", "state", "failureCount", "delayMs", "reason", "cmdPid", "iiiPid", "cmdStartedAt", "iiiStartedAt"].includes(key))).toBe(true);
    }
    expect(events.find((event) => event.event === "worker_exited")?.workerPid).toBe(401);
  });

  it("observes a real child close, replaces its PID, and shuts the replacement down by IPC", async () => {
    const fixture = join(process.cwd(), "test", "fixtures", "supervisor-worker.mjs");
    const stop = new AbortController();
    const pids: number[] = [];
    let attempt = 0;
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        const child = spawn(process.execPath, [fixture, attempt++ === 0 ? "exit" : "hold"], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
        });
        if (child.pid) pids.push(child.pid);
        return child;
      }),
      sleep: vi.fn((ms, signal) => {
        if (ms < 600_000) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }),
      appendEvent: vi.fn(async (event) => {
        if (event.event === "worker_started" && pids.length === 2) stop.abort();
      }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: fixture, home: mkdtempSync(join(tmpdir(), "am-supervisor-real-")), stopSignal: stop.signal, monitorParents: false },
      deps,
    );

    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
    expect(() => process.kill(pids[1], 0)).toThrow();
  });

  it("honors a matching control request even when process-chain validation returns no chain object", async () => {
    const fallbackStop = new AbortController();
    const worker = new FakeWorker(501);
    worker.send.mockImplementation((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => worker.emit("close", 0, null));
      return true;
    });
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => worker),
      verifyProcessChain: vi.fn(async () => true),
      readShutdownRequest: vi.fn(() => true),
      sleep: vi.fn((ms, signal) => {
        if (ms === 1_000) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }),
    });
    const fallback = setTimeout(() => fallbackStop.abort(), 50);

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-control-")), stopSignal: fallbackStop.signal },
      deps,
    );
    clearTimeout(fallback);

    expect(deps.readShutdownRequest).toHaveBeenCalled();
    expect(worker.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the parent monitor throws while reading the shutdown request", async () => {
    const fallbackStop = new AbortController();
    const worker = new FakeWorker(504);
    const events: SupervisorEvent[] = [];
    worker.send.mockImplementation((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => worker.emit("close", 0, null));
      return true;
    });
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => worker),
      verifyProcessChain: vi.fn(async () => true),
      readShutdownRequest: vi.fn(() => { throw new Error("control file raced"); }),
      appendEvent: vi.fn(async (event) => { events.push(event); }),
      sleep: vi.fn((ms, signal) => {
        if (ms === 1_000) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }),
    });
    const fallback = setTimeout(() => fallbackStop.abort(), 50);

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-monitor-failure-")), stopSignal: fallbackStop.signal },
      deps,
    );
    clearTimeout(fallback);

    expect(fallbackStop.signal.aborted).toBe(false);
    expect(worker.send).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ event: "parent_check_failed", reason: "PARENT_MONITOR_FAILED" }));
  });

  it("freezes the initial spawn until one failed process-chain check succeeds on the five-second retry", async () => {
    const stop = new AbortController();
    const worker = new FakeWorker(502);
    worker.send.mockImplementation((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => worker.emit("close", 0, null));
      return true;
    });
    const verifyProcessChain = vi.fn()
      .mockRejectedValueOnce(new Error("transient CIM failure"))
      .mockResolvedValueOnce(true);
    const sleeps: number[] = [];
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        queueMicrotask(() => stop.abort());
        return worker;
      }),
      verifyProcessChain,
      sleep: vi.fn((ms, signal) => {
        sleeps.push(ms);
        if (ms === 5_000) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-chain-")), stopSignal: stop.signal },
      deps,
    );

    expect(verifyProcessChain).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBe(5_000);
    expect(deps.spawnWorker).toHaveBeenCalledTimes(1);
  });

  it("records the validated cmd and iii identities without logging their command lines", async () => {
    const stop = new AbortController();
    const worker = new FakeWorker(503);
    worker.send.mockImplementation((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => worker.emit("close", 0, null));
      return true;
    });
    const events: SupervisorEvent[] = [];
    const deps = baseDependencies({
      spawnWorker: vi.fn(() => {
        queueMicrotask(() => stop.abort());
        return worker;
      }),
      verifyProcessChain: vi.fn(async () => ({ supervisorPid: process.pid, cmdPid: 12, iiiPid: 11, cmdStartedAt: "cmd-created", iiiStartedAt: "iii-created" })),
      appendEvent: vi.fn(async (event) => { events.push(event); }),
      sleep: vi.fn((_ms, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))),
    });

    await runWorkerSupervisor(
      { instanceId: "test", workerEntry: "worker.mjs", home: mkdtempSync(join(tmpdir(), "am-supervisor-identities-")), stopSignal: stop.signal },
      deps,
    );

    expect(events.find((event) => event.event === "supervisor_started")).toMatchObject({ cmdPid: 12, iiiPid: 11, cmdStartedAt: "cmd-created", iiiStartedAt: "iii-created" });
    expect(JSON.stringify(events)).not.toContain("CommandLine");
  });
});

describe("worker and supervisor ownership", () => {
  it("makes direct and supervised workers compete for the same exclusive slot", () => {
    const home = mkdtempSync(join(tmpdir(), "am-worker-shared-slot-"));
    const directIdentity = resolveWorkerLifecycleIdentity({}, 600, new Date("2026-01-01T00:00:00.000Z"));
    expect(directIdentity).toMatchObject({ supervisorPid: 600, instanceId: "legacy-direct" });
    const direct = acquireWorkerLifecycleLock({
      home,
      workerPid: 601,
      parentPid: 600,
      identity: directIdentity,
      isProcessAlive: (pid) => pid === 601,
    });
    expect(() => acquireWorkerLifecycleLock({
      home,
      workerPid: 701,
      parentPid: 700,
      identity: { supervisorPid: 700, supervisorStartedAt: "2026-01-01T00:00:01.000Z", instanceId: "formal" },
      isProcessAlive: (pid) => pid === 601,
    })).toThrow("LIVE_WORKER_LOCK_PRESENT");
    direct.release();

    const supervised = acquireWorkerLifecycleLock({
      home,
      workerPid: 701,
      parentPid: 700,
      identity: { supervisorPid: 700, supervisorStartedAt: "2026-01-01T00:00:01.000Z", instanceId: "formal" },
      isProcessAlive: (pid) => pid === 701,
    });
    expect(() => acquireWorkerLifecycleLock({
      home,
      workerPid: 602,
      parentPid: 600,
      identity: resolveWorkerLifecycleIdentity({}, 600, new Date("2026-01-01T00:00:02.000Z")),
      isProcessAlive: (pid) => pid === 701,
    })).toThrow("LIVE_WORKER_LOCK_PRESENT");
    supervised.release();
  });
  it("allows direct launch only when all supervisor metadata is absent", () => {
    expect(readOptionalWorkerLifecycleIdentity({}, 10)).toBeNull();
    expect(() => readOptionalWorkerLifecycleIdentity({ AGENTMEMORY_INSTANCE_ID: "formal" }, 10)).toThrow();
    expect(readOptionalWorkerLifecycleIdentity({
      AGENTMEMORY_SUPERVISOR_PID: "10",
      AGENTMEMORY_SUPERVISOR_STARTED_AT: "2026-01-01T00:00:00.000Z",
      AGENTMEMORY_INSTANCE_ID: "formal",
    }, 10)).toMatchObject({ supervisorPid: 10, instanceId: "formal" });
  });

  it("rejects missing, mismatched, or non-parent worker lifecycle identity", () => {
    expect(() => readWorkerLifecycleIdentity({}, 10)).toThrow();
    expect(() => readWorkerLifecycleIdentity({ AGENTMEMORY_SUPERVISOR_PID: "9", AGENTMEMORY_SUPERVISOR_STARTED_AT: "2026-01-01T00:00:00.000Z", AGENTMEMORY_INSTANCE_ID: "formal" }, 10)).toThrow();
    expect(readWorkerLifecycleIdentity({ AGENTMEMORY_SUPERVISOR_PID: "10", AGENTMEMORY_SUPERVISOR_STARTED_AT: "2026-01-01T00:00:00.000Z", AGENTMEMORY_INSTANCE_ID: "formal" }, 10)).toMatchObject({ supervisorPid: 10, instanceId: "formal" });
  });

  it("fails closed on a live foreign worker lock and archives a dead lock", () => {
    const home = mkdtempSync(join(tmpdir(), "am-worker-lock-"));
    writeFileSync(join(home, "worker.lock.json"), JSON.stringify({ schemaVersion: 1, workerPid: 701, supervisorPid: 700, supervisorStartedAt: "2026-01-01T00:00:00.000Z", instanceId: "formal", workerStartedAt: "2026-01-01T00:00:01.000Z" }));
    expect(() => acquireWorkerLifecycleLock({ home, workerPid: 801, parentPid: 800, identity: { supervisorPid: 800, supervisorStartedAt: "2026-01-02T00:00:00.000Z", instanceId: "formal" }, isProcessAlive: () => true })).toThrow();
    const lock = acquireWorkerLifecycleLock({ home, workerPid: 801, parentPid: 800, identity: { supervisorPid: 800, supervisorStartedAt: "2026-01-02T00:00:00.000Z", instanceId: "formal" }, isProcessAlive: () => false });
    expect(JSON.parse(readFileSync(join(home, "worker.lock.json"), "utf8"))).toMatchObject({ workerPid: 801, supervisorPid: 800 });
    lock.release();
  });

  it("fails closed on a live legacy worker.pid even when the JSON lock is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "am-worker-pid-"));
    writeFileSync(join(home, "worker.pid"), "901\n");
    expect(() => acquireWorkerLifecycleLock({ home, workerPid: 902, parentPid: 900, identity: { supervisorPid: 900, supervisorStartedAt: "2026-01-02T00:00:00.000Z", instanceId: "formal" }, isProcessAlive: (pid) => pid === 901 })).toThrow("LIVE_WORKER_PID_PRESENT");
  });

  it("fails closed when worker or supervisor ownership records are malformed", () => {
    const workerHome = mkdtempSync(join(tmpdir(), "am-worker-malformed-"));
    writeFileSync(join(workerHome, "worker.lock.json"), "{}");
    expect(() => acquireWorkerLifecycleLock({
      home: workerHome,
      workerPid: 911,
      parentPid: 910,
      identity: { supervisorPid: 910, supervisorStartedAt: "2026-01-02T00:00:00.000Z", instanceId: "formal" },
      isProcessAlive: () => false,
    })).toThrow("WORKER_LOCK_INVALID");

    const supervisorHome = mkdtempSync(join(tmpdir(), "am-supervisor-malformed-"));
    writeFileSync(join(supervisorHome, "supervisor.pid"), "{}");
    expect(() => acquireSupervisorPidLock(supervisorHome, "formal", "2026-01-01T00:00:00.000Z", () => false)).toThrow("SUPERVISOR_LOCK_INVALID");
  });

  it("does not delete a supervisor PID lock that no longer belongs to it", () => {
    const home = mkdtempSync(join(tmpdir(), "am-supervisor-pid-"));
    const lock = acquireSupervisorPidLock(home, "formal", "2026-01-01T00:00:00.000Z", () => false);
    writeFileSync(join(home, "supervisor.pid"), JSON.stringify({ schemaVersion: 1, pid: 999, startedAt: "2026-01-02T00:00:00.000Z", instanceId: "formal" }));
    lock.release();
    expect(existsSync(join(home, "supervisor.pid"))).toBe(true);
  });

  it("rejects a second supervisor while the recorded PID is live", () => {
    const home = mkdtempSync(join(tmpdir(), "am-supervisor-live-"));
    const first = acquireSupervisorPidLock(home, "formal", "2026-01-01T00:00:00.000Z", () => false);
    expect(() => acquireSupervisorPidLock(home, "formal", "2026-01-01T00:00:01.000Z", (pid) => pid === process.pid)).toThrow("SUPERVISOR_ALREADY_RUNNING");
    first.release();
  });

  it("runs worker cleanup once when signal and IPC request shutdown together", async () => {
    const cleanup = vi.fn(async () => undefined);
    const coordinator = createWorkerShutdownCoordinator(cleanup);
    await Promise.all([coordinator.request(), coordinator.request(), coordinator.request()]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("PowerShell and CLI boundaries", () => {
  it("uses the native process snapshot instead of CIM for parent-chain validation", () => {
    const command = buildProcessChainSnapshotCommand(
      "F:\\runtime\\agent's scripts\\_agentmemory-local-common.ps1",
      3,
    );
    expect(command).toContain(". 'F:\\runtime\\agent''s scripts\\_agentmemory-local-common.ps1'");
    expect(command).toContain("$all = @(Get-AmProcesses)");
    expect(command).toContain("Get-AmProcessById -ProcessId $supervisorPid -AllProcesses $all");
    expect(command).not.toContain("Get-CimInstance");
  });

  it("encodes PowerShell commands as UTF-16LE base64 and parses a validated process chain", () => {
    expect(Buffer.from(encodePowerShellCommand("Write-Output 'ok'"), "base64").toString("utf16le")).toBe("Write-Output 'ok'");
    expect(parseProcessChain(JSON.stringify([
      { ProcessId: 3, ParentProcessId: 2, Name: "node.exe", ExecutablePath: "F:/runtime/node.exe", CommandLine: "node supervisor" },
      { ProcessId: 2, ParentProcessId: 1, Name: "cmd.exe", ExecutablePath: "C:/Windows/System32/cmd.exe", CommandLine: "cmd /c node supervisor" },
      { ProcessId: 1, ParentProcessId: 0, Name: "iii.exe", ExecutablePath: "F:/runtime/bin/iii.exe", CommandLine: "iii --config F:/runtime/iii-config.yaml" },
    ]), { supervisorPid: 3, expectedInstallHome: "F:/runtime", expectedConfig: "F:/runtime/iii-config.yaml" })).toMatchObject({ cmdPid: 2, iiiPid: 1 });
  });

  it("requires the exact iii --config argument rather than a path substring", () => {
    const records = [
      { ProcessId: 3, ParentProcessId: 2, Name: "node.exe", ExecutablePath: "C:/node.exe", CommandLine: "node supervisor" },
      { ProcessId: 2, ParentProcessId: 1, Name: "cmd.exe", ExecutablePath: "C:/Windows/System32/cmd.exe", CommandLine: "cmd /c node supervisor" },
      { ProcessId: 1, ParentProcessId: 0, Name: "iii.exe", ExecutablePath: "F:/runtime/bin/iii.exe", CommandLine: "iii --config F:/runtime/iii-config.yaml.backup" },
    ];
    expect(() => parseProcessChain(JSON.stringify(records), {
      supervisorPid: 3,
      expectedInstallHome: "F:/runtime",
      expectedConfig: "F:/runtime/iii-config.yaml",
    })).toThrow("III_CONFIG_MISMATCH");
  });

  it("accepts only the two mutually exclusive CLI modes", () => {
    expect(parseSupervisorCli(["--instance-id", "formal", "--worker-entry", "dist/index.mjs"])).toMatchObject({ mode: "run", instanceId: "formal" });
    expect(parseSupervisorCli(["--request-shutdown", "--instance-id", "formal", "--home", "state"])).toMatchObject({ mode: "request", instanceId: "formal" });
    expect(() => parseSupervisorCli(["--request-shutdown", "--instance-id", "formal", "--home", "state", "--worker-entry", "dist/index.mjs"])).toThrow();
    expect(() => parseSupervisorCli(["--unknown"])).toThrow();
  });

  it("writes an identity-bound shutdown request and returns stable request-mode exit codes", () => {
    const missingHome = mkdtempSync(join(tmpdir(), "am-request-missing-"));
    expect(requestSupervisorShutdown(missingHome, "formal")).toBe(2);

    const home = mkdtempSync(join(tmpdir(), "am-request-"));
    const startedAt = "2026-01-01T00:00:00.000Z";
    writeFileSync(join(home, "supervisor.pid"), JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt, instanceId: "formal" }));
    expect(requestSupervisorShutdown(home, "other")).toBe(3);
    expect(requestSupervisorShutdown(home, "formal")).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "supervisor.shutdown.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      instanceId: "formal",
      targetSupervisorPid: process.pid,
      targetStartedAt: startedAt,
    });
  });

  it("installs signal and IPC shutdown through one coordinator before worker registration", () => {
    const source = readFileSync("src/index.ts", "utf8");
    expect(source).toContain("installWorkerShutdownHandlers()");
    expect(source.indexOf("installWorkerShutdownHandlers()")).toBeLessThan(source.indexOf("registerWorker(config.engineUrl"));
    expect(source).toContain('process.on("SIGBREAK"');
    expect(source).toContain('process.on("message"');
    expect(source).toContain("workerShutdownCoordinator.request()");
  });
});
