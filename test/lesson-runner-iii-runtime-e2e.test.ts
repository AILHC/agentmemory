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
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";

type Boundary =
  | "generation registry"
  | "generation run binding"
  | "candidate staging"
  | "candidate run binding"
  | "formal lesson watermark"
  | "committed receipt";

interface FaultCase {
  name: Boundary;
  expectedProviderCalls: number;
}

interface RuntimeSnapshot {
  scopes: Record<string, Record<string, any>>;
  metadata: { providerCalls: number; faultBoundary?: Boundary };
}

interface ChildRuntime {
  child: ChildProcess;
  baseUrl: string;
  port: number;
  durableBoundaries: Boundary[];
  providerCalls: () => number;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface EngineRuntime {
  child: ChildProcess;
  port: number;
  url: string;
  stateDir: string;
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

function engineConfig(port: number, stateDir: string) {
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
    "",
  ].join("\n");
}

async function startEngine(root: string, requestedPort?: number): Promise<EngineRuntime> {
  if (!enginePath) throw new Error("test_iii_engine_path_missing");
  const port = requestedPort ?? await freePort();
  const stateDir = join(root, "iii-state");
  const configPath = join(root, "iii-config.yaml");
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, engineConfig(port, stateDir), "utf8");
  const child = spawn(enginePath, ["--no-update-check", "--config", configPath], {
    cwd: root,
    env: safeEngineEnvironment(),
    windowsHide: true,
    stdio: "ignore",
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, port, url: `ws://127.0.0.1:${port}`, stateDir, exit };
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

async function startRuntime({
  engine,
  fault,
  port,
}: {
  engine: EngineRuntime;
  fault?: Boundary;
  port?: number;
}): Promise<ChildRuntime> {
  const durableBoundaries: Boundary[] = [];
  let providerCallCount = 0;
  const child = fork(fixturePath, [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      AGENTMEMORY_TEST_III_ENGINE_URL: engine.url,
      AGENTMEMORY_TEST_RUNTIME_SECRET: "temporary-test-secret",
      ...(port ? { AGENTMEMORY_TEST_RUNTIME_PORT: String(port) } : {}),
      ...(fault ? { AGENTMEMORY_TEST_RUNTIME_FAULT: fault } : {}),
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
        if (message?.type === "fault-durable") durableBoundaries.push(message.boundary);
        if (message?.type === "provider-call") providerCallCount += 1;
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
    durableBoundaries,
    providerCalls: () => providerCallCount,
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

function values<T = any>(snapshot: RuntimeSnapshot, scope: string) {
  return Object.values(snapshot.scopes[scope] ?? {}) as T[];
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
        resultRef: `summary-resumable-runs:${resumableRunId}`,
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

realDescribe("Lessons real iii file_based recovery seam", () => {
  it.each<FaultCase>([
    { name: "generation registry", expectedProviderCalls: 0 },
    { name: "generation run binding", expectedProviderCalls: 0 },
    { name: "candidate staging", expectedProviderCalls: 1 },
    { name: "candidate run binding", expectedProviderCalls: 1 },
  ])("recovers an acknowledged %s boundary through the formal Runner API", async (fault) => {
    if (!enginePath) throw new Error("test_iii_engine_path_missing");
    assertPinnedIiiVersionOutput((await execFileAsync(enginePath, ["--version"], { windowsHide: true })).stdout);
    expect(createHash("sha256").update(await readFile(enginePath)).digest("hex")).toBe(PINNED_III_ENGINE_SHA256);

    process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const root = await mkdtemp(join(tmpdir(), "agentmemory-lessons-real-iii-"));
    const runnerStateDir = join(root, "runner-state");
    const runId = `real-iii-${fault.name.replaceAll(" ", "-")}`;
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
      const currentRuntime = () => {
        if (!runtime) throw new Error("test_iii_runtime_missing");
        return runtime;
      };
      const restartRuntime = async (nextFault?: Boundary) => {
        const previous = currentRuntime();
        providerCalls += previous.providerCalls();
        await stopRuntime(previous);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        runtime = await startRuntime({
          engine: engine!,
          fault: nextFault,
          port: runtimePort,
        });
        argv[1] = runtime.baseUrl;
      };
      argv[1] = currentRuntime().baseUrl;
      let faultObserved = false;
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
        if (faultingRuntime.durableBoundaries.length > 0) {
          expect(await within("fault-exit", faultingRuntime.exit, 5_000))
            .toEqual({ code: 86, signal: null });
          expect(faultingRuntime.durableBoundaries).toEqual([fault.name]);
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

      await restartRuntime();
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
      expect(exitCode).toBe(75);
      expect(safeStatus.run_status).not.toBe("completed");
      expect(lessons).toHaveLength(0);
      expect(receipts).toHaveLength(0);
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
  }, 40_000);

  it.skip.each([
    "formal lesson watermark",
    "committed receipt",
  ] as const)(
    "requires a durable real-engine list refresh before exercising %s recovery",
    () => {},
  );
});
