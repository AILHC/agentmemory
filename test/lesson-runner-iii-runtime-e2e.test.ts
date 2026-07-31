import { createHash } from "node:crypto";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { registerWorker } from "iii-sdk";
import { mainForTest, stableHash } from "../ops/scripts/run-agentmemory-full-extraction.mjs";
import {
  assertPinnedIiiVersionOutput,
  PINNED_III_ENGINE_SHA256,
} from "../ops/scripts/lib/iii-state-read-only-adapter-v1.mjs";
import { projectSafeRecoveryStatus } from "../ops/scripts/lib/recovery-status-projection-v1.mjs";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";

type Boundary =
  | "extraction run pending"
  | "generation registry"
  | "generation run binding"
  | "extraction run running"
  | "extraction operation receipt running"
  | "candidate staging"
  | "candidate run binding"
  | "commit plan"
  | "initial committing receipt"
  | "first formal lesson watermark"
  | "first progress receipt"
  | "second formal lesson watermark"
  | "second progress receipt"
  | "formal lesson watermark"
  | "committed receipt"
  | "extraction operation receipt succeeded";

interface FaultCase {
  name: Boundary;
  expectedOutcome: "completed" | "conservative";
  expectedOperationStatus?: "running" | "succeeded";
  expectedProviderCalls: number;
}

interface AcknowledgedBoundary {
  boundary: string;
  scope: string;
  key: string;
  value: unknown;
}

interface RuntimeSnapshot {
  scopes: Record<string, Record<string, any>>;
  metadata: { providerCalls: number; faultBoundary?: Boundary };
}

interface ChildRuntime {
  child: ChildProcess;
  baseUrl: string;
  port: number;
  acknowledgedBoundaries: AcknowledgedBoundary[];
  acknowledgedBoundary: Promise<AcknowledgedBoundary>;
  faultReady: Promise<AcknowledgedBoundary>;
  continueFault: () => Promise<void>;
  providerCalls: () => number;
  apiResponses: () => any[];
  stateWrites: () => ObservedStateWrite[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface ObservedStateWrite {
  index: number;
  scope: string;
  key: string;
  boundaries: Boundary[];
}

interface EngineRuntime {
  child: ChildProcess;
  port: number;
  url: string;
  stateDir: string;
  saveIntervalMs: number;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("./fixtures/lesson-iii-runtime-subprocess.ts", import.meta.url));
const enginePath = process.env.AGENTMEMORY_TEST_III_BIN;
const realDescribe = enginePath ? describe : describe.skip;
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function safeEngineEnvironment() {
  return {
    ...Object.fromEntries(
      ["SystemRoot", "WINDIR", "TEMP", "TMP"]
        .flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []),
    ),
    III_TELEMETRY_ENABLED: "false",
    OTEL_ENABLED: "false",
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_iii_free_port_missing");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function engineConfig(port: number, stateDir: string, saveIntervalMs: number) {
  return [
    "workers:",
    "  - name: iii-worker-manager",
    "    config:",
    "      host: 127.0.0.1",
    `      port: ${port}`,
    "  - name: iii-state",
    "    config:",
    "      adapter:",
    "        name: kv",
    "        config:",
    "          store_method: file_based",
    `          file_path: ${JSON.stringify(stateDir.replaceAll("\\", "/"))}`,
    `          save_interval_ms: ${saveIntervalMs}`,
    "",
  ].join("\n");
}

async function startEngine(
  root: string,
  requestedPort?: number,
  saveIntervalMs = 10,
): Promise<EngineRuntime> {
  if (!enginePath) throw new Error("test_iii_engine_path_missing");
  const port = requestedPort ?? await freePort();
  const stateDir = join(root, "iii-state");
  const configPath = join(root, "iii-config.yaml");
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, engineConfig(port, stateDir, saveIntervalMs), "utf8");
  const child = spawn(enginePath, ["--no-update-check", "--config", configPath], {
    cwd: root,
    env: safeEngineEnvironment(),
    windowsHide: true,
    stdio: "ignore",
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    port,
    url: `ws://127.0.0.1:${port}`,
    stateDir,
    saveIntervalMs,
    exit,
  };
}

async function seedEngine(engine: EngineRuntime) {
  const sdk = registerWorker(engine.url, {
    workerName: `agentmemory-lesson-iii-seed-${process.pid}-${engine.port}`,
    enableMetricsReporting: false,
    invocationTimeoutMs: 5_000,
    reconnectionConfig: {
      maxRetries: 5,
      initialDelay: 50,
      maxDelay: 250,
    },
    otel: { enabled: false },
  });
  const kv = new StateKV(sdk);
  try {
    await within(
      "seed-readiness",
      (async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 160; attempt += 1) {
          try {
            await kv.get("test:lesson-iii-runtime:metadata", "readiness");
            return;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        throw new Error("test_iii_seed_not_ready", { cause: lastError });
      })(),
      10_000,
    );
    const sessionId = "temporary-real-iii-runtime-session";
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "/tmp/temporary-real-iii-runtime",
      cwd: "/tmp/temporary-real-iii-runtime",
      startedAt: "2026-07-30T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set(KV.observations(sessionId), "obs-1", {
      id: "obs-1",
      sessionId,
      sourceEventIndex: 1,
      timestamp: "2026-07-30T00:00:00.000Z",
      hookType: "prompt_submit",
      raw: {},
      userPrompt: "Recover the real iii durable lesson commit.",
    });
    expect(await kv.get(KV.sessions, sessionId)).not.toBeNull();
    await within(
      "seed-files",
      (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await readdir(engine.stateDir)).length >= 2) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("test_iii_seed_files_missing");
      })(),
      10_000,
    );
  } finally {
    await sdk.shutdown().catch(() => {});
  }
}

async function stopEngine(engine: EngineRuntime) {
  if (engine.child.exitCode === null && engine.child.signalCode === null) engine.child.kill();
  await Promise.race([
    engine.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("test_iii_engine_shutdown_timeout")), 10_000)),
  ]);
}

async function forceStopEngine(engine: EngineRuntime) {
  if (engine.child.exitCode === null && engine.child.signalCode === null) {
    engine.child.kill("SIGKILL");
  }
  await within("engine-forced-shutdown", engine.exit, 10_000);
}

async function startRuntime({
  engine,
  fault,
  faultIndex,
  port,
  pauseBeforeFault = false,
}: {
  engine: EngineRuntime;
  fault?: Boundary;
  faultIndex?: number;
  port?: number;
  pauseBeforeFault?: boolean;
}): Promise<ChildRuntime> {
  const acknowledgedBoundaries: AcknowledgedBoundary[] = [];
  let resolveAcknowledgedBoundary!: (boundary: AcknowledgedBoundary) => void;
  let resolveFaultReady!: (boundary: AcknowledgedBoundary) => void;
  const acknowledgedBoundary = new Promise<AcknowledgedBoundary>((resolve) => {
    resolveAcknowledgedBoundary = resolve;
  });
  const faultReady = new Promise<AcknowledgedBoundary>((resolve) => {
    resolveFaultReady = resolve;
  });
  let providerCallCount = 0;
  const apiResponses: any[] = [];
  const stateWrites: ObservedStateWrite[] = [];
  const child = fork(fixturePath, [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      AGENTMEMORY_TEST_III_ENGINE_URL: engine.url,
      AGENTMEMORY_TEST_RUNTIME_SECRET: "temporary-test-secret",
      ...(port ? { AGENTMEMORY_TEST_RUNTIME_PORT: String(port) } : {}),
      ...(fault ? { AGENTMEMORY_TEST_RUNTIME_FAULT: fault } : {}),
      ...(faultIndex === undefined
        ? {}
        : { AGENTMEMORY_TEST_RUNTIME_FAULT_INDEX: String(faultIndex) }),
      ...(pauseBeforeFault
        ? { AGENTMEMORY_TEST_RUNTIME_PAUSE_BEFORE_FAULT: "1" }
        : {}),
    },
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let baseUrl: string;
  try {
    baseUrl = await new Promise<string>((resolve, reject) => {
      const stderr: string[] = [];
      const timeout = setTimeout(
        () => reject(new Error(`test_iii_runtime_start_timeout:${stderr.join("").slice(-1_000)}`)),
        15_000,
      );
      child.once("error", reject);
      child.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
      child.on("message", (message: any) => {
        if (message?.type === "fault-acknowledged") {
          const boundary = {
            boundary: message.boundary,
            scope: message.scope,
            key: message.key,
            value: message.value,
          };
          acknowledgedBoundaries.push(boundary);
          resolveAcknowledgedBoundary(boundary);
        }
        if (message?.type === "fault-ready") {
          resolveFaultReady({
            boundary: message.boundary,
            scope: message.scope,
            key: message.key,
            value: message.value,
          });
        }
        if (message?.type === "provider-call") providerCallCount += 1;
        if (message?.type === "state-set-observed") {
          stateWrites.push({
            index: message.index,
            scope: message.scope,
            key: message.key,
            boundaries: message.boundaries,
          });
        }
        if (message?.type === "api-response" || message?.type === "api-error") {
          apiResponses.push(message);
        }
        if (message?.type !== "ready") return;
        clearTimeout(timeout);
        resolve(message.baseUrl);
      });
      exit.then(({ code, signal }) => {
        clearTimeout(timeout);
        reject(new Error(`test_iii_runtime_exited_before_ready:${code ?? signal}:${stderr.join("").slice(-1_000)}`));
      });
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    throw error;
  }
  return {
    child,
    baseUrl,
    port: Number(new URL(baseUrl).port),
    acknowledgedBoundaries,
    acknowledgedBoundary,
    faultReady,
    continueFault: async () => {
      await new Promise<void>((resolve, reject) => {
        child.send(
          { type: "continue-fault" },
          (error) => error ? reject(error) : resolve(),
        );
      });
    },
    providerCalls: () => providerCallCount,
    apiResponses: () => [...apiResponses],
    stateWrites: () => structuredClone(stateWrites),
    exit,
  };
}

async function stopRuntime(runtime: ChildRuntime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  try {
    runtime.child.send({ type: "shutdown" });
    await within("runtime-shutdown", runtime.exit, 10_000);
  } catch (error) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill();
    await within("runtime-forced-shutdown", runtime.exit, 5_000).catch(() => {});
    throw error;
  }
}

async function forceStopRuntime(runtime: ChildRuntime) {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill("SIGKILL");
  }
  await within("runtime-forced-shutdown", runtime.exit, 10_000);
}

async function within<T>(phase: string, promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`test_iii_phase_timeout:${phase}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readRuntimeSnapshot(runtime: ChildRuntime): Promise<RuntimeSnapshot> {
  const response = await fetch(`${runtime.baseUrl}/__test/state`);
  if (!response.ok) throw new Error(`test_iii_runtime_state_http_${response.status}`);
  return response.json() as Promise<RuntimeSnapshot>;
}

async function readRuntimeValue(runtime: ChildRuntime, scope: string, key: string) {
  const url = new URL("/__test/value", runtime.baseUrl);
  url.searchParams.set("scope", scope);
  url.searchParams.set("key", key);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`test_iii_runtime_value_http_${response.status}`);
  return (await response.json() as { value: unknown }).value;
}

async function deleteRuntimeValue(runtime: ChildRuntime, scope: string, key: string) {
  const url = new URL("/__test/value", runtime.baseUrl);
  url.searchParams.set("scope", scope);
  url.searchParams.set("key", key);
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) throw new Error(`test_iii_runtime_delete_http_${response.status}`);
}

function values<T = any>(snapshot: RuntimeSnapshot, scope: string) {
  return Object.values(snapshot.scopes[scope] ?? {}) as T[];
}

function encodeStateScope(scope: string) {
  return [...Buffer.from(scope, "utf8")]
    .map((byte) => (
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d
      || byte === 0x5f
      || byte === 0x2e
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    ))
    .join("");
}

async function stateFileDigest(engine: EngineRuntime, scope: string) {
  const path = join(engine.stateDir, `${encodeStateScope(scope)}.bin`);
  return readFile(path)
    .then((contents) => createHash("sha256").update(contents).digest("hex"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
}

async function waitForScopePersistence(
  engine: EngineRuntime,
  scope: string,
) {
  let previousDigest: string | null = null;
  let stablePolls = 0;
  await within(
    "scope-persistence",
    (async () => {
      while (true) {
        const digest = await stateFileDigest(engine, scope);
        if (digest) {
          stablePolls = digest === previousDigest ? stablePolls + 1 : 0;
          if (stablePolls >= 5) return;
        } else {
          stablePolls = 0;
        }
        previousDigest = digest;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    10_000,
  );
}

async function waitForStateDirectoryStable(engine: EngineRuntime) {
  let previousDigest: string | null = null;
  let stablePolls = 0;
  await within(
    "state-directory-stable",
    (async () => {
      while (true) {
        const names = (await readdir(engine.stateDir))
          .filter((name) => name.endsWith(".bin"))
          .sort();
        const digest = createHash("sha256");
        for (const name of names) {
          digest.update(name);
          digest.update(await readFile(join(engine.stateDir, name)));
        }
        const currentDigest = digest.digest("hex");
        stablePolls = currentDigest === previousDigest ? stablePolls + 1 : 0;
        if (names.length > 0 && stablePolls >= 10) return;
        previousDigest = currentDigest;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    10_000,
  );
}

function summaryResponse({ attemptId, inputHash }: { attemptId: string; inputHash: string }) {
  const title = "temporary real iii runtime summary";
  const resumableRunId = stableHash({ attemptId, inputHash, source: "temporary-real-iii-runtime" });
  return {
    ok: true,
    data: {
      status: "succeeded",
      attemptId,
      runnerInputHash: inputHash,
      serviceInputHash: stableHash({ attemptId, inputHash, source: "summary-service" }),
      resumableRunId,
      summary: { title },
      recoveryEvidence: {
        kind: "committed",
        receiptKey: `xop_${stableHash({ attemptId, inputHash }).slice(0, 32)}`,
        receiptVersion: 1,
        resultRef: `mem:summary-resumable:runs:${resumableRunId}`,
        effectHash: stableHash({ title, narrative: "", keyDecisions: [], filesModified: [], concepts: [] }),
      },
    },
  };
}

function testDependencies() {
  return {
    v2RemainingStages: false,
    v2SummaryRemote: { advance: summaryResponse, record: async () => {} },
  };
}

const DURABILITY_SAVE_INTERVAL_MS = 2_000;
const CRITICAL_STATEKV_BOUNDARIES = [
  "extraction run pending",
  "generation registry",
  "generation run binding",
  "extraction run running",
  "extraction operation receipt running",
  "candidate staging",
  "candidate run binding",
  "commit plan",
  "initial committing receipt",
  "first formal lesson watermark",
  "first progress receipt",
  "second formal lesson watermark",
  "second progress receipt",
  "committed receipt",
  "extraction operation receipt succeeded",
] as const satisfies readonly Boundary[];

interface DurabilityScenarioResult {
  boundary: string;
  acknowledged: AcknowledgedBoundary;
  persistedAfterCrash: unknown;
  providerCalls: number;
  exitCode: number;
  snapshot: RuntimeSnapshot;
  journal: any[];
  control: any[];
  acknowledgedWrites: ObservedStateWrite[];
  safeStatus: ReturnType<typeof projectSafeRecoveryStatus>;
}

async function assertRealIiiBinary() {
  if (!enginePath) throw new Error("test_iii_engine_path_missing");
  assertPinnedIiiVersionOutput(
    (await execFileAsync(enginePath, ["--version"], { windowsHide: true })).stdout,
  );
  expect(createHash("sha256").update(await readFile(enginePath)).digest("hex"))
    .toBe(PINNED_III_ENGINE_SHA256);
}

async function runDurabilityScenario(
  target: Boundary | { index: number },
  { recover = true }: { recover?: boolean } = {},
): Promise<DurabilityScenarioResult> {
  const boundary = typeof target === "string"
    ? target
    : `state set #${target.index}`;
  await assertRealIiiBinary();
  process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
  process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
  const root = await mkdtemp(join(tmpdir(), "agentmemory-lessons-real-iii-durability-"));
  const runnerStateDir = join(root, "runner-state");
  const runId = `real-iii-durability-${boundary.replaceAll(" ", "-")}`;
  const sessionId = "temporary-real-iii-runtime-session";
  const argv = [
    "--base-url",
    "placeholder",
    "--state-dir",
    runnerStateDir,
    "--run-id",
    runId,
    "--mark",
    runId,
    "--run-state-format",
    "v2",
  ];
  let engine: EngineRuntime | null = null;
  let runtime: ChildRuntime | null = null;
  let providerCalls = 0;
  try {
    engine = await startEngine(root);
    await seedEngine(engine);
    const enginePort = engine.port;
    await stopEngine(engine);
    engine = await startEngine(root, enginePort, DURABILITY_SAVE_INTERVAL_MS);
    runtime = await startRuntime({
      engine,
      ...(typeof target === "string"
        ? { fault: target }
        : { faultIndex: target.index }),
      pauseBeforeFault: true,
    });
    const runtimePort = runtime.port;
    argv[1] = runtime.baseUrl;
    const faultRun = within(
      `durability-fault-run:${boundary}`,
      mainForTest(argv, testDependencies()),
      30_000,
    ).then(
      (exitCode) => ({ exitCode, error: undefined }),
      (error) => ({ exitCode: undefined, error }),
    );
    const ready = await within(
      `durability-fault-ready:${boundary}`,
      runtime.faultReady,
      30_000,
    );
    expect(ready.boundary).toBe(boundary);
    await new Promise((resolve) =>
      setTimeout(resolve, DURABILITY_SAVE_INTERVAL_MS + 500));
    await waitForStateDirectoryStable(engine);
    await runtime.continueFault();
    const acknowledged = await within(
      `durability-fault-acknowledged:${boundary}`,
      runtime.acknowledgedBoundary,
      10_000,
    );
    expect(acknowledged.boundary).toBe(boundary);
    const acknowledgedWrites = runtime.stateWrites();
    providerCalls += runtime.providerCalls();
    await Promise.all([
      forceStopRuntime(runtime),
      forceStopEngine(engine),
    ]);
    await faultRun;

    engine = await startEngine(root, enginePort);
    runtime = await startRuntime({ engine, port: runtimePort });
    argv[1] = runtime.baseUrl;
    const persistedAfterCrash = await readRuntimeValue(
      runtime,
      acknowledged.scope,
      acknowledged.key,
    );
    let exitCode = 75;
    if (recover) {
      for (let attempt = 0; attempt < 8 && exitCode === 75; attempt += 1) {
        exitCode = await within(
          `durability-resume:${boundary}:${attempt}`,
          mainForTest([...argv, "--resume"], testDependencies()),
          30_000,
        );
        if (exitCode === 75 && attempt < 7) {
          providerCalls += runtime.providerCalls();
          await stopRuntime(runtime);
          runtime = await startRuntime({ engine, port: runtimePort });
          argv[1] = runtime.baseUrl;
        }
      }
    }
    providerCalls += runtime.providerCalls();
    const snapshot = await readRuntimeSnapshot(runtime);
    const journal = (await readFile(
      join(runnerStateDir, `${runId}.v2`, "lessons.jsonl"),
      "utf8",
    )).trim().split("\n").filter(Boolean).map(JSON.parse);
    const control = (await readFile(
      join(runnerStateDir, `${runId}.v2`, "control.jsonl"),
      "utf8",
    )).trim().split("\n").filter(Boolean).map(JSON.parse);
    return {
      boundary,
      acknowledged,
      persistedAfterCrash,
      providerCalls,
      exitCode,
      snapshot,
      journal,
      control,
      acknowledgedWrites,
      safeStatus: projectSafeRecoveryStatus({
        runId,
        controlEvents: control,
        stageEvents: { lessons: journal },
        requiredStages: ["lessons"],
      }),
    };
  } finally {
    try {
      if (runtime) await stopRuntime(runtime).catch(() => {});
    } finally {
      try {
        if (engine) await stopEngine(engine).catch(() => {});
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

async function observeSuccessfulStateWrites(): Promise<ObservedStateWrite[]> {
  await assertRealIiiBinary();
  process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
  process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
  const root = await mkdtemp(join(
    tmpdir(),
    "agentmemory-lessons-real-iii-write-inventory-",
  ));
  const runnerStateDir = join(root, "runner-state");
  const runId = "real-iii-state-write-inventory";
  const argv = [
    "--base-url",
    "placeholder",
    "--state-dir",
    runnerStateDir,
    "--run-id",
    runId,
    "--mark",
    runId,
    "--run-state-format",
    "v2",
  ];
  let engine: EngineRuntime | null = null;
  let runtime: ChildRuntime | null = null;
  try {
    engine = await startEngine(root);
    await seedEngine(engine);
    const enginePort = engine.port;
    await stopEngine(engine);
    engine = await startEngine(root, enginePort);
    runtime = await startRuntime({ engine });
    argv[1] = runtime.baseUrl;
    expect(await within(
      "state-write-inventory-run",
      mainForTest(argv, testDependencies()),
      30_000,
    )).toBe(0);
    return runtime.stateWrites();
  } finally {
    try {
      if (runtime) await stopRuntime(runtime).catch(() => {});
    } finally {
      try {
        if (engine) await stopEngine(engine).catch(() => {});
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

function observedStateWriteKind(write: Pick<ObservedStateWrite, "scope">) {
  for (const prefix of [
    "mem:extraction-operation-receipt:",
    "mem:lesson-extraction:generation:",
    "mem:lesson-extraction:candidates:",
    "mem:lesson-commit:plans:",
    "mem:lesson-commit:receipts:",
    "mem:extraction-run-metadata:",
    "mem:extraction-run-manifest:",
    "mem:extraction-run-record:",
    "mem:extraction-run-audit-event:",
  ]) {
    if (write.scope.startsWith(prefix)) return prefix;
  }
  return write.scope;
}

realDescribe("Lessons real iii file_based recovery seam", () => {
  it.each<FaultCase>([
    { name: "generation registry", expectedOutcome: "conservative", expectedProviderCalls: 0 },
    { name: "generation run binding", expectedOutcome: "conservative", expectedProviderCalls: 0 },
    {
      name: "candidate staging",
      expectedOutcome: "conservative",
      expectedOperationStatus: "running",
      expectedProviderCalls: 1,
    },
    {
      name: "candidate run binding",
      expectedOutcome: "completed",
      expectedOperationStatus: "running",
      expectedProviderCalls: 1,
    },
    {
      name: "formal lesson watermark",
      expectedOutcome: "completed",
      expectedOperationStatus: "succeeded",
      expectedProviderCalls: 1,
    },
    {
      name: "committed receipt",
      expectedOutcome: "completed",
      expectedOperationStatus: "succeeded",
      expectedProviderCalls: 1,
    },
  ])("recovers an acknowledged %s boundary through the formal Runner API", async (fault) => {
    if (!enginePath) throw new Error("test_iii_engine_path_missing");
    assertPinnedIiiVersionOutput((await execFileAsync(enginePath, ["--version"], { windowsHide: true })).stdout);
    expect(createHash("sha256").update(await readFile(enginePath)).digest("hex")).toBe(PINNED_III_ENGINE_SHA256);

    process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const root = await mkdtemp(join(tmpdir(), "agentmemory-lessons-real-iii-"));
    const runnerStateDir = join(root, "runner-state");
    const runId = `real-iii-${fault.name.replaceAll(" ", "-")}`;
    const sessionId = "temporary-real-iii-runtime-session";
    const attemptId = stableHash({
      run_id: runId,
      stage: "lessons",
      unit_id: sessionId,
    });
    const operationKey = buildExtractionOperationKey({
      runId: attemptId,
      stage: "lessons",
      unitId: sessionId,
    });
    const operationScope = KV.extractionOperationReceipt(operationKey);
    const argv = [
      "--base-url",
      "placeholder",
      "--state-dir",
      runnerStateDir,
      "--run-id",
      runId,
      "--mark",
      runId,
      "--run-state-format",
      "v2",
    ];
    let engine: EngineRuntime | null = null;
    let runtime: ChildRuntime | null = null;
    try {
      engine = await startEngine(root);
      await seedEngine(engine);
      const enginePort = engine.port;
      await stopEngine(engine);
      engine = await startEngine(root, enginePort);
      runtime = await startRuntime({ engine, fault: fault.name });
      const runtimePort = runtime.port;
      let providerCalls = 0;
      const apiResponses: any[] = [];
      const currentRuntime = () => {
        if (!runtime) throw new Error("test_iii_runtime_missing");
        return runtime;
      };
      const restartRuntime = async (nextFault?: Boundary) => {
        const previous = currentRuntime();
        providerCalls += previous.providerCalls();
        apiResponses.push(...previous.apiResponses());
        await stopRuntime(previous);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        runtime = await startRuntime({
          engine: engine!,
          fault: nextFault,
          port: runtimePort,
        });
        argv[1] = runtime.baseUrl;
      };
      const restartEngineAndRuntime = async () => {
        const previous = currentRuntime();
        providerCalls += previous.providerCalls();
        apiResponses.push(...previous.apiResponses());
        await stopRuntime(previous);
        await stopEngine(engine!);
        engine = await startEngine(root, enginePort);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        runtime = await startRuntime({
          engine,
          port: runtimePort,
        });
        argv[1] = runtime.baseUrl;
      };
      argv[1] = currentRuntime().baseUrl;
      let faultObserved = false;
      let acknowledgedBoundary: AcknowledgedBoundary | null = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const args = attempt === 0 ? argv : [...argv, "--resume"];
        let exitCode: number | undefined;
        let runnerError: unknown;
        try {
          exitCode = await within(
            `fault-run-${attempt}`,
            mainForTest(args, testDependencies()),
            15_000,
          );
        } catch (error) {
          runnerError = error;
        }
        const faultingRuntime = currentRuntime();
        if (faultingRuntime.acknowledgedBoundaries.length > 0) {
          expect(await within("fault-exit", faultingRuntime.exit, 5_000))
            .toEqual({ code: 86, signal: null });
          expect(faultingRuntime.acknowledgedBoundaries).toHaveLength(1);
          const acknowledged = faultingRuntime.acknowledgedBoundaries[0];
          expect(acknowledged.boundary).toBe(fault.name);
          await waitForScopePersistence(engine, acknowledged.scope);
          if (fault.expectedProviderCalls > 0) {
            await waitForScopePersistence(engine, operationScope);
          }
          await waitForStateDirectoryStable(engine);
          acknowledgedBoundary = acknowledged;
          faultObserved = true;
          break;
        }
        if (runnerError) throw runnerError;
        expect(exitCode).toBe(75);
        await restartRuntime(fault.name);
      }
      if (!faultObserved) {
        const diagnostic = await readRuntimeSnapshot(currentRuntime());
        const receiptScope = Object.keys(diagnostic.scopes)
          .find((scope) => scope.startsWith("mem:lesson-commit:receipts:"));
        throw new Error(`test_iii_fault_not_reached:${
          JSON.stringify({
            lessons: values(diagnostic, KV.lessons).length,
            receipts: receiptScope
              ? values(diagnostic, receiptScope).map((receipt: any) => ({
                status: receipt.status,
                applied: receipt.appliedLessonIds?.length,
              }))
              : [],
            runs: values(diagnostic, KV.lessonExtractionRuns).map((run: any) => ({
              status: run.status,
              generation: run.extractionGeneration,
              staging: Boolean(run.candidateStagingId),
            })),
          })
        }`);
      }

      await restartEngineAndRuntime();
      const persistedSnapshot = await readRuntimeSnapshot(currentRuntime());
      expect(persistedSnapshot.scopes[acknowledgedBoundary!.scope]?.[acknowledgedBoundary!.key])
        .toEqual(acknowledgedBoundary!.value);
      if (fault.expectedProviderCalls > 0) {
        expect(await readRuntimeValue(currentRuntime(), operationScope, operationKey))
          .toMatchObject({ status: fault.expectedOperationStatus });
        for (const run of values<any>(persistedSnapshot, KV.lessonExtractionRuns)) {
          if (!run.candidateStagingId) continue;
          expect(
            persistedSnapshot.scopes[KV.lessonExtractionCandidates(run.id)]
              ?.[run.candidateStagingId],
          ).toBeDefined();
        }
      }
      let exitCode = 75;
      for (let attempt = 0; attempt < 6 && exitCode === 75; attempt += 1) {
        exitCode = await within(
          `resume-${attempt}`,
          mainForTest([...argv, "--resume"], testDependencies()),
          15_000,
        );
        if (exitCode === 75) await restartRuntime();
      }
      await restartRuntime();

      const snapshot = await readRuntimeSnapshot(currentRuntime());
      const lessons = values(snapshot, KV.lessons);
      const runs = values(snapshot, KV.lessonExtractionRuns);
      const receiptScope = Object.keys(snapshot.scopes)
        .find((scope) => scope.startsWith("mem:lesson-commit:receipts:"));
      const receipts = receiptScope ? values(snapshot, receiptScope) : [];
      expect(providerCalls).toBe(fault.expectedProviderCalls);
      expect(new Set(runs.map((run: any) => run.extractionGeneration).filter(Boolean)).size)
        .toBe(runs.filter((run: any) => run.extractionGeneration).length);
      expect(receipts.length).toBeLessThanOrEqual(1);

      const journal = (await readFile(join(runnerStateDir, `${runId}.v2`, "lessons.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
      const control = (await readFile(join(runnerStateDir, `${runId}.v2`, "control.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
      const safeStatus = projectSafeRecoveryStatus({
        runId,
        controlEvents: control,
        stageEvents: { lessons: journal },
        requiredStages: ["lessons"],
      });
      if (fault.expectedOutcome === "conservative") {
        expect(exitCode).toBe(75);
        expect(safeStatus.run_status).not.toBe("completed");
        expect(lessons).toHaveLength(0);
        expect(receipts).toHaveLength(0);
      } else {
        if (exitCode !== 0) {
          throw new Error(`test_iii_completed_recovery_not_reached:${
            JSON.stringify({
              exitCode,
              journal: journal.slice(-8),
              control: control.slice(-8),
              runs,
              receipts,
              apiResponses: apiResponses.slice(-8),
            })
          }`);
        }
        expect(exitCode).toBe(0);
        expect(lessons).toHaveLength(2);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          status: "committed",
          appliedLessonIds: expect.arrayContaining(lessons.map((lesson: any) => lesson.id)),
        });
        expect(receipts[0].appliedLessonIds).toHaveLength(2);
        expect(safeStatus).toMatchObject({ run_status: "completed", counts: { succeeded: 1 } });
      }
    } finally {
      try {
        if (runtime) await stopRuntime(runtime);
      } finally {
        try {
          if (engine) await stopEngine(engine);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 180_000);

  it("proves a StateKV acknowledgement is not durability proof", async () => {
    const result = await runDurabilityScenario("generation registry", {
      recover: false,
    });
    expect(result.acknowledged.value).toBeDefined();
    expect(result.persistedAfterCrash).not.toEqual(result.acknowledged.value);
    expect(result.providerCalls).toBe(0);
  }, 180_000);

  it("recovers or requests exact reconciliation at every observed StateKV write acknowledgement boundary", async () => {
    const inventory = await observeSuccessfulStateWrites();
    expect(inventory.map((write) => write.index))
      .toEqual(inventory.map((_, index) => index));
    expect(inventory.length).toBeGreaterThan(CRITICAL_STATEKV_BOUNDARIES.length);
    for (const expectedWrite of inventory) {
      const label = `${expectedWrite.index}:${expectedWrite.scope}:${expectedWrite.boundaries.join(",") || "unclassified"}`;
      const result = await runDurabilityScenario({
        index: expectedWrite.index,
      });
      expect(result.acknowledged, label).toMatchObject({
        boundary: `state set #${expectedWrite.index}`,
      });
      expect(observedStateWriteKind(result.acknowledged), label)
        .toBe(observedStateWriteKind(expectedWrite));
      expect(result.providerCalls, label).toBeLessThanOrEqual(1);
      const lessons = values<any>(result.snapshot, KV.lessons);
      const receiptScope = Object.keys(result.snapshot.scopes)
        .find((scope) => scope.startsWith("mem:lesson-commit:receipts:"));
      const receipts = receiptScope
        ? values<any>(result.snapshot, receiptScope)
        : [];
      expect(receipts.length, label).toBeLessThanOrEqual(1);
      const terminalEvent = result.journal.at(-1);
      expect({
        index: result.acknowledgedWrites.at(-1)?.index,
        kind: observedStateWriteKind(result.acknowledgedWrites.at(-1)!),
        boundaries: result.acknowledgedWrites.at(-1)?.boundaries,
      }, label).toEqual({
        index: expectedWrite.index,
        kind: observedStateWriteKind(expectedWrite),
        boundaries: expectedWrite.boundaries,
      });
      expect(
        result.journal.some((event) => (
          event.type === "unit_terminal"
          && event.payload?.status === "failed"
        )),
        label,
      ).toBe(false);
      if (result.exitCode === 75) {
        expect(result.safeStatus.run_status, label).toBe("waiting");
        expect(terminalEvent?.type, label)
          .toBe("unit_reconciliation_requested");
        expect(terminalEvent?.payload?.decision?.action, label)
          .toBe("reconcile");
        expect(terminalEvent?.payload, label).toMatchObject({
          receipt_key: expect.any(String),
          receipt_input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          receipt_started_at: expect.any(String),
        });
        continue;
      }
      expect(result.exitCode, label).toBe(0);
      expect(lessons, label).toHaveLength(2);
      expect(receipts, label).toHaveLength(1);
      expect(receipts[0], label).toMatchObject({
        status: "committed",
        appliedLessonIds: expect.arrayContaining(
          lessons.map((lesson) => lesson.id),
        ),
      });
      for (const lesson of lessons) {
        expect(lesson.reinforcements, label).toBe(0);
        expect(
          lesson.sourceWatermarks?.["temporary-real-iii-runtime-session"],
          label,
        ).toBeDefined();
      }
      expect(result.safeStatus, label).toMatchObject({
        run_status: "completed",
        counts: { succeeded: 1 },
      });
    }
  }, 900_000);

  it("resumes a committed receipt with a missing formal watermark without repeating provider or effects", async () => {
    await assertRealIiiBinary();
    process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const root = await mkdtemp(join(
      tmpdir(),
      "agentmemory-lessons-real-iii-missing-watermark-",
    ));
    const runnerStateDir = join(root, "runner-state");
    const runId = "real-iii-committed-receipt-missing-watermark";
    const argv = [
      "--base-url",
      "placeholder",
      "--state-dir",
      runnerStateDir,
      "--run-id",
      runId,
      "--mark",
      runId,
      "--run-state-format",
      "v2",
    ];
    let engine: EngineRuntime | null = null;
    let runtime: ChildRuntime | null = null;
    let providerCalls = 0;
    try {
      engine = await startEngine(root);
      await seedEngine(engine);
      const enginePort = engine.port;
      await stopEngine(engine);
      engine = await startEngine(root, enginePort);
      runtime = await startRuntime({
        engine,
        fault: "committed receipt",
        pauseBeforeFault: true,
      });
      const runtimePort = runtime.port;
      argv[1] = runtime.baseUrl;
      const faultRun = within(
        "missing-watermark-fault-run",
        mainForTest(argv, testDependencies()),
        30_000,
      ).then(
        (exitCode) => ({ exitCode, error: undefined }),
        (error) => ({ exitCode: undefined, error }),
      );
      const ready = await within(
        "missing-watermark-committed-ready",
        runtime.faultReady,
        30_000,
      );
      expect(ready.boundary).toBe("committed receipt");
      providerCalls += runtime.providerCalls();
      expect(providerCalls).toBe(1);
      const baseline = await readRuntimeSnapshot(runtime);
      const lessons = values<any>(baseline, KV.lessons);
      expect(lessons).toHaveLength(2);
      const removed = lessons[0];
      await deleteRuntimeValue(runtime, KV.lessons, removed.id);
      expect(await readRuntimeValue(runtime, KV.lessons, removed.id)).toBeUndefined();
      await waitForScopePersistence(engine, KV.lessons);
      await waitForStateDirectoryStable(engine);
      await runtime.continueFault();
      const acknowledged = await within(
        "missing-watermark-committed-acknowledged",
        runtime.acknowledgedBoundary,
        10_000,
      );
      expect(acknowledged.boundary).toBe("committed receipt");
      expect(await within("missing-watermark-runtime-exit", runtime.exit, 5_000))
        .toEqual({ code: 86, signal: null });
      await waitForScopePersistence(engine, acknowledged.scope);
      await waitForStateDirectoryStable(engine);
      await faultRun;
      await stopEngine(engine);

      engine = await startEngine(root, enginePort);
      runtime = await startRuntime({ engine, port: runtimePort });
      argv[1] = runtime.baseUrl;
      expect(await readRuntimeValue(runtime, KV.lessons, removed.id)).toBeUndefined();
      expect(await readRuntimeValue(
        runtime,
        acknowledged.scope,
        acknowledged.key,
      ))
        .toMatchObject({ status: "committed" });
      const recoveryProviderCallsBefore = providerCalls;
      const recoveryWriteOffset = runtime.stateWrites().length;
      let exitCode = 75;
      for (let attempt = 0; attempt < 8 && exitCode === 75; attempt += 1) {
        exitCode = await within(
          `missing-watermark-resume:${attempt}`,
          mainForTest([...argv, "--resume"], testDependencies()),
          30_000,
        );
        if (exitCode === 75 && attempt < 7) {
          providerCalls += runtime.providerCalls();
          await stopRuntime(runtime);
          runtime = await startRuntime({ engine, port: runtimePort });
          argv[1] = runtime.baseUrl;
        }
      }
      providerCalls += runtime.providerCalls();
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(recoveryProviderCallsBefore);
      const recoveryWrites = runtime.stateWrites().slice(recoveryWriteOffset);
      expect(recoveryWrites
        .filter((write) => write.scope === KV.lessons)
        .map(({ scope, key, boundaries }) => ({ scope, key, boundaries })))
        .toEqual([{
          scope: KV.lessons,
          key: removed.id,
          boundaries: ["first formal lesson watermark"],
        }]);
      const recoveryReceiptWrites = recoveryWrites.filter((write) =>
        write.scope.startsWith("mem:lesson-commit:receipts:"));
      expect(recoveryReceiptWrites.length).toBeGreaterThan(0);
      expect(new Set(recoveryReceiptWrites.map((write) => write.key)).size)
        .toBe(1);
      expect(recoveryReceiptWrites.every((write) =>
        write.key === acknowledged.key)).toBe(true);
      const recovered = await readRuntimeSnapshot(runtime);
      const recoveredLessons = values<any>(recovered, KV.lessons);
      expect(recoveredLessons).toHaveLength(2);
      expect(recoveredLessons.map((lesson) => lesson.id))
        .toEqual(expect.arrayContaining(lessons.map((lesson) => lesson.id)));
      expect(await readRuntimeValue(
        runtime,
        acknowledged.scope,
        acknowledged.key,
      ))
        .toMatchObject({
          status: "committed",
          appliedLessonIds: expect.arrayContaining(
            recoveredLessons.map((lesson) => lesson.id),
          ),
        });
      for (const lesson of recoveredLessons) {
        expect(lesson.reinforcements).toBe(0);
        expect(
          lesson.sourceWatermarks?.["temporary-real-iii-runtime-session"],
        ).toBeDefined();
      }
    } finally {
      try {
        if (runtime) await stopRuntime(runtime).catch(() => {});
      } finally {
        try {
          if (engine) await stopEngine(engine).catch(() => {});
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 300_000);

});
