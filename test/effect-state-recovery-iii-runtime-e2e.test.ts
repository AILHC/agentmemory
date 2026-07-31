import { createHash } from "node:crypto";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerWorker } from "iii-sdk";
import { mainForTest } from "../ops/scripts/run-agentmemory-full-extraction.mjs";
import {
  assertPinnedIiiVersionOutput,
  PINNED_III_ENGINE_SHA256,
} from "../ops/scripts/lib/iii-state-read-only-adapter-v1.mjs";
import {
  EFFECT_STATE_RECOVERY_STAGES,
} from "../ops/scripts/lib/effect-state-recovery-release-gate-v2.mjs";
import { reduceRecoveryJournal } from "../ops/scripts/lib/recovery-journal-reducer-v1.mjs";
import { projectSafeRecoveryStatus } from "../ops/scripts/lib/recovery-status-projection-v1.mjs";
import { StateKV } from "../src/state/kv.js";
import { fingerprintId, KV } from "../src/state/schema.js";

type Stage =
  | "summary"
  | "lessons"
  | "memory_consolidate"
  | "semantic_rollup"
  | "skill_extract"
  | "crystal"
  | "consolidation_procedural"
  | "reflect_insight";

interface AcknowledgedEffect {
  stage: Stage;
  scope: string;
  key: string;
  value: unknown;
}

interface EngineRuntime {
  child: ChildProcess;
  port: number;
  httpPort: number;
  url: string;
  baseUrl: string;
  stateDir: string;
  logs: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface ApiRuntime {
  child: ChildProcess;
  baseUrl: string;
  port: number;
  acknowledgedEffects: AcknowledgedEffect[];
  errors: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface RuntimeSnapshot {
  scopes: Record<string, Record<string, any>>;
  faultStage?: Stage;
}

interface HttpExchange {
  path: string;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
}

const stages = [...EFFECT_STATE_RECOVERY_STAGES] as Stage[];
const sessionId = "temporary-eight-stage-real-iii-session";
const fixturePath = fileURLToPath(
  new URL("./effect-state-recovery-iii-runtime-fixture.ts", import.meta.url),
);
const enginePath = process.env.AGENTMEMORY_TEST_III_BIN;
const requireRealIii = process.env.AGENTMEMORY_REQUIRE_REAL_III === "1";
const execFileAsync = promisify(execFile);
const originalEnv = { ...process.env };

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("effect-state recovery real III release matrix prerequisites", () => {
  it("fails closed when the release gate requires a real III binary", () => {
    if (requireRealIii) {
      expect(
        enginePath,
        "AGENTMEMORY_REQUIRE_REAL_III=1 requires AGENTMEMORY_TEST_III_BIN",
      ).toBeTruthy();
    }
  });
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

function engineConfig(workerPort: number, httpPort: number, stateDir: string) {
  return [
    "workers:",
    "  - name: iii-worker-manager",
    "    config:",
    "      host: 127.0.0.1",
    `      port: ${workerPort}`,
    "  - name: iii-http",
    "    config:",
    "      host: 127.0.0.1",
    `      port: ${httpPort}`,
    "      default_timeout: 60000",
    "  - name: iii-state",
    "    config:",
    "      adapter:",
    "        name: kv",
    "        config:",
    "          store_method: file_based",
    `          file_path: ${JSON.stringify(stateDir.replaceAll("\\", "/"))}`,
    "          save_interval_ms: 10",
    "",
  ].join("\n");
}

async function startEngine(
  root: string,
  requestedPorts?: { worker: number; http: number },
): Promise<EngineRuntime> {
  if (!enginePath) throw new Error("test_iii_engine_path_missing");
  const port = requestedPorts?.worker ?? await freePort();
  let httpPort = requestedPorts?.http ?? await freePort();
  while (httpPort === port) httpPort = await freePort();
  const stateDir = join(root, "iii-state");
  const configPath = join(root, "iii-config.yaml");
  const logs: string[] = [];
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, engineConfig(port, httpPort, stateDir), "utf8");
  const child = spawn(enginePath, ["--no-update-check", "--config", configPath], {
    cwd: root,
    env: safeEngineEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => logs.push(chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    port,
    httpPort,
    url: `ws://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${httpPort}`,
    stateDir,
    logs,
    exit,
  };
}

async function stopEngine(engine: EngineRuntime) {
  if (engine.child.exitCode === null && engine.child.signalCode === null) engine.child.kill();
  await within("engine-shutdown", engine.exit, 10_000);
}

async function connectState(engine: EngineRuntime, workerName: string) {
  const sdk = registerWorker(engine.url, {
    workerName,
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
  await within(
    "state-readiness",
    (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
          await kv.get("test:effect-state-recovery-iii-runtime:metadata", "readiness");
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error("test_iii_state_not_ready", { cause: lastError });
    })(),
    10_000,
  );
  return { sdk, kv };
}

async function seedEngine(engine: EngineRuntime) {
  const { sdk, kv } = await connectState(
    engine,
    `agentmemory-eight-stage-seed-${process.pid}-${engine.port}`,
  );
  const now = "2026-07-30T00:00:00.000Z";
  const old = "2026-06-01T00:00:00.000Z";
  try {
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "/tmp/temporary-eight-stage-real-iii",
      cwd: "/tmp/temporary-eight-stage-real-iii",
      startedAt: now,
      endedAt: now,
      status: "completed",
      observationCount: 12,
    });
    for (let index = 0; index < 12; index += 1) {
      const id = `obs-${String(index + 1).padStart(2, "0")}`;
      await kv.set(KV.observations(sessionId), id, {
        id,
        sessionId,
        sourceEventIndex: index + 1,
        timestamp: now,
        hookType: index === 0 ? "prompt_submit" : "post_tool_use",
        type: "file_edit",
        title: `Recovery edit ${index + 1}`,
        narrative: `Applied durable recovery step ${index + 1}.`,
        facts: [`Recovery fact ${index + 1}`],
        concepts: ["recovery", "durability"],
        files: ["src/recovery.ts"],
        importance: 8,
        raw: {},
        ...(index === 0
          ? { userPrompt: "Verify and recover every durable effect exactly once." }
          : {}),
      });
    }
    for (const index of [1, 2]) {
      const id = `seed-pattern-${index}`;
      await kv.set(KV.memories, id, {
        id,
        type: "pattern",
        title: `Seed recovery pattern ${index}`,
        content: `Recurring recovery workflow ${index}.`,
        concepts: ["recovery"],
        files: ["src/recovery.ts"],
        strength: 0.8,
        sessionIds: ["seed-a", "seed-b"],
        sourceObservationIds: [],
        project: "/tmp/temporary-eight-stage-real-iii",
        version: 1,
        isLatest: true,
        createdAt: old,
        updatedAt: old,
      });
    }
    await kv.set(KV.actions, "seed-completed-action", {
      id: "seed-completed-action",
      title: "Verify durable recovery",
      description: "Exercise the formal effect boundary.",
      status: "done",
      priority: 5,
      project: "/tmp/temporary-eight-stage-real-iii",
      createdAt: old,
      updatedAt: old,
      createdBy: "real-iii-test",
      tags: ["recovery"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    expect(await kv.get(KV.sessions, sessionId)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await sdk.shutdown().catch(() => {});
  }
}

async function startRuntime({
  engine,
  faultStage,
}: {
  engine: EngineRuntime;
  faultStage?: Stage;
}): Promise<ApiRuntime> {
  const acknowledgedEffects: AcknowledgedEffect[] = [];
  const errors: string[] = [];
  const child = fork(fixturePath, [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      AGENTMEMORY_TEST_III_ENGINE_URL: engine.url,
      AGENTMEMORY_TEST_RUNTIME_SECRET: "temporary-test-secret",
      AGENTMEMORY_TEST_RUNTIME_HTTP_PORT: String(engine.httpPort),
      ...(faultStage ? { AGENTMEMORY_TEST_RUNTIME_FAULT_STAGE: faultStage } : {}),
    },
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let baseUrl: string;
  try {
    baseUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`test_iii_runtime_start_timeout:${errors.join("").slice(-2_000)}`)),
        20_000,
      );
      child.once("error", reject);
      child.stderr?.on("data", (chunk) => errors.push(chunk.toString()));
      child.on("message", (message: any) => {
        if (message?.type === "effect-acknowledged") {
          acknowledgedEffects.push({
            stage: message.stage,
            scope: message.scope,
            key: message.key,
            value: message.value,
          });
        }
        if (message?.type !== "ready") return;
        clearTimeout(timeout);
        resolve(message.baseUrl);
      });
      exit.then(({ code, signal }) => {
        clearTimeout(timeout);
        reject(new Error(
          `test_iii_runtime_exited_before_ready:${code ?? signal}:${errors.join("").slice(-2_000)}`,
        ));
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
    acknowledgedEffects,
    errors,
    exit,
  };
}

async function stopRuntime(runtime: ApiRuntime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  runtime.child.send({ type: "shutdown" });
  await within("runtime-shutdown", runtime.exit, 10_000);
}

async function readSnapshot(runtime: ApiRuntime): Promise<RuntimeSnapshot> {
  const response = await fetch(`${runtime.baseUrl}/__test/state`);
  if (!response.ok) throw new Error(`test_iii_runtime_state_http_${response.status}`);
  return response.json() as Promise<RuntimeSnapshot>;
}

async function readRuntimeValue(runtime: ApiRuntime, scope: string, key: string) {
  const url = new URL("/__test/value", runtime.baseUrl);
  url.searchParams.set("scope", scope);
  url.searchParams.set("key", key);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`test_iii_runtime_value_http_${response.status}`);
  return (await response.json() as { value: unknown }).value;
}

function values(snapshot: RuntimeSnapshot, scope: string) {
  return Object.values(snapshot.scopes[scope] ?? {}) as any[];
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

async function readJournal(runRoot: string, stage: Stage) {
  return (await readFile(join(runRoot, `${stage}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

async function faultNotReachedDiagnostics(
  engine: EngineRuntime,
  runtime: ApiRuntime,
  runRoot: string,
  runnerOutcome: unknown,
  httpExchanges: HttpExchange[] = [],
) {
  const status = await readFile(join(runRoot, "status.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const journals = Object.fromEntries(await Promise.all(stages.map(async (stage) => {
    const events = await readJournal(runRoot, stage).catch(() => []);
    return [stage, events.slice(-6)];
  })));
  const snapshot = await readSnapshot(runtime).catch(() => null);
  const receiptKeys = collectReceiptKeys({ journals, httpExchanges });
  const operationReceipts = Object.fromEntries(await Promise.all(
    [...receiptKeys].map(async (key) => [
      key,
      await readRuntimeValue(runtime, KV.extractionOperationReceipt(key), key).catch(() => null),
    ]),
  ));
  const lessonReceipts = Object.fromEntries(await Promise.all(
    [...collectLessonReceiptBindings(journals).values()].map(async ({ receiptKey, runId }) => [
      receiptKey,
      await readRuntimeValue(runtime, KV.lessonCommitReceipts(runId), receiptKey)
        .catch(() => null),
    ]),
  ));
  const memoryPrepare = (journals.memory_consolidate ?? []).find(
    (event: any) => event.type === "unit_prepare_started",
  );
  const memoryProposal = memoryPrepare
    ? await (async () => {
        const identity = [
          memoryPrepare.payload.attempt_id,
          "memory_consolidate",
          memoryPrepare.payload.unit_id,
        ];
        const key = fingerprintId("mcp", JSON.stringify(identity));
        const proposal = await readRuntimeValue(
          runtime,
          KV.memoryConsolidationProposal(key),
          key,
        ).catch(() => null) as any;
        const recomputedHash = proposal
          ? createHash("sha256")
              .update(stableStringify([
                proposal.parsed,
                proposal.sourceObservationIds,
                proposal.project,
                proposal.concept,
              ]))
              .digest("hex")
          : null;
        return {
          key,
          storedHash: proposal?.proposalHash ?? null,
          recomputedHash,
          proposal,
        };
      })()
    : null;
  return {
    runnerOutcome: runnerOutcome instanceof Error
      ? { name: runnerOutcome.name, message: runnerOutcome.message }
      : runnerOutcome,
    journalOutcomes: Object.fromEntries(Object.entries(journals).map(
      ([stage, events]: [string, any]) => [
        stage,
        events.map((event: any) => ({
          type: event.type,
          status: event.payload?.status,
          failure_class: event.payload?.failure_class,
          reason: event.payload?.reason
            ?? event.payload?.error
            ?? event.payload?.reason_code,
        })),
      ],
    )),
    engineLogs: engine.logs.slice(-20),
    runtimeErrors: runtime.errors.slice(-10),
    status,
    journals,
    operationReceipts,
    lessonReceipts,
    memoryProposal,
    httpExchanges: httpExchanges.slice(-40),
    snapshot,
  };
}

async function withHttpCapture<T>(
  exchanges: HttpExchange[],
  action: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.pathname.startsWith("/agentmemory/")) {
      const requestText = typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : "";
      const responseText = await response.clone().text();
      const requestBody = requestText ? JSON.parse(requestText) : null;
      const responseBody = responseText ? JSON.parse(responseText) : null;
      const exchange: HttpExchange = {
        path: url.pathname,
        requestBody,
        status: response.status,
        responseBody,
      };
      exchanges.push(exchange);
    }
    return response;
  };
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function collectReceiptKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^xop_[0-9a-f]{32}$/.test(value)) found.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectReceiptKeys(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReceiptKeys(item, found);
  }
  return found;
}

function collectLessonReceiptBindings(
  value: unknown,
  found = new Map<string, { receiptKey: string; runId: string }>(),
) {
  if (Array.isArray(value)) {
    for (const item of value) collectLessonReceiptBindings(item, found);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.receiptKey === "string"
      && /^lcr_[0-9a-f]{32}$/.test(record.receiptKey)
      && typeof record.runId === "string"
      && record.runId
    ) {
      found.set(record.receiptKey, {
        receiptKey: record.receiptKey,
        runId: record.runId,
      });
    }
    for (const item of Object.values(record)) collectLessonReceiptBindings(item, found);
  }
  return found;
}

function assertFormalBusinessEffects(snapshot: RuntimeSnapshot) {
  expect(values(snapshot, KV.summaries)).toHaveLength(1);
  expect(values(snapshot, KV.lessons)).toHaveLength(2);
  expect(values(snapshot, KV.memories).filter(
    (memory) => memory.title === "Eight-stage durable memory" && memory.isLatest,
  )).toHaveLength(1);
  expect(values(snapshot, KV.semantic)).toHaveLength(1);
  expect(values(snapshot, KV.procedural).filter(
    (memory) => memory.name === "Verify durable recovery",
  )).toHaveLength(1);
  expect(values(snapshot, KV.procedural).filter(
    (memory) => memory.name === "Recover a durable effect",
  )).toHaveLength(1);
  expect(values(snapshot, KV.crystals)).toHaveLength(1);
  expect(values(snapshot, KV.insights)).toHaveLength(1);
}

describe.skipIf(!enginePath)("effect-state recovery through real III file_based StateKV", () => {
  beforeAll(async () => {
    if (!enginePath) throw new Error("test_iii_engine_path_missing");
    assertPinnedIiiVersionOutput(
      (await execFileAsync(enginePath, ["--version"], { windowsHide: true })).stdout,
    );
    expect(createHash("sha256").update(await readFile(enginePath)).digest("hex"))
      .toBe(PINNED_III_ENGINE_SHA256);
  });

  it.each(stages)(
    "recovers after III acknowledged the %s formal business effect",
    async (faultStage) => {
      if (!enginePath) throw new Error("test_iii_engine_path_missing");
      process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
      process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
      process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "en";
      const root = await mkdtemp(join(tmpdir(), `agentmemory-eight-stage-${faultStage}-`));
      const runnerStateDir = join(root, "runner-state");
      const runId = `real-iii-eight-stage-${faultStage}`;
      const runRoot = join(runnerStateDir, `${runId}.v2`);
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
        "--delay-ms",
        "0",
        "--request-timeout-ms",
        "10000",
      ];
      const httpExchanges: HttpExchange[] = [];
      let engine: EngineRuntime | null = null;
      let runtime: ApiRuntime | null = null;
      try {
        engine = await startEngine(root);
        await seedEngine(engine);
        const enginePorts = { worker: engine.port, http: engine.httpPort };
        await waitForStateDirectoryStable(engine);
        await stopEngine(engine);
        engine = await startEngine(root, enginePorts);
        runtime = await startRuntime({ engine, faultStage });
        argv[1] = runtime.baseUrl;

        let firstRunOutcome: unknown;
        try {
          firstRunOutcome = await withHttpCapture(
            httpExchanges,
            () => within("faulting-run", mainForTest(argv), 60_000),
          );
        } catch (error) {
          if (
            error instanceof Error
            && error.message === "test_iii_phase_timeout:faulting-run"
          ) {
            throw error;
          }
          firstRunOutcome = error;
        }
        if (runtime.acknowledgedEffects.length === 0) {
          throw new Error(`test_iii_fault_not_reached:${
            JSON.stringify(await faultNotReachedDiagnostics(
              engine,
              runtime,
              runRoot,
              firstRunOutcome,
              httpExchanges,
            ))
          }`);
        }
        expect(await within("faulting-runtime-exit", runtime.exit, 10_000))
          .toEqual({ code: 86, signal: null });
        expect(runtime.acknowledgedEffects).toHaveLength(1);
        const acknowledgedEffect = runtime.acknowledgedEffects[0];
        expect(acknowledgedEffect).toMatchObject({ stage: faultStage });
        await waitForStateDirectoryStable(engine);
        await stopEngine(engine);

        engine = await startEngine(root, enginePorts);
        runtime = await startRuntime({ engine });
        argv[1] = runtime.baseUrl;
        expect(await readRuntimeValue(
          runtime,
          acknowledgedEffect.scope,
          acknowledgedEffect.key,
        )).toEqual(acknowledgedEffect.value);

        let exitCode = 75;
        for (let attempt = 0; attempt < 8 && exitCode === 75; attempt += 1) {
          exitCode = await withHttpCapture(
            httpExchanges,
            () => within(
              `resume-${attempt}`,
              mainForTest([...argv, "--resume"]),
              60_000,
            ),
          );
        }
        if (exitCode !== 0) {
          throw new Error(`test_iii_recovery_not_completed:${
            JSON.stringify(await faultNotReachedDiagnostics(
              engine,
              runtime,
              runRoot,
              exitCode,
              httpExchanges,
            ))
          }`);
        }

        await stopRuntime(runtime);
        runtime = await startRuntime({ engine });
        const snapshot = await readSnapshot(runtime);
        assertFormalBusinessEffects(snapshot);

        const stageEvents = Object.fromEntries(
          await Promise.all(stages.map(async (stage) => [stage, await readJournal(runRoot, stage)])),
        ) as Record<Stage, any[]>;
        for (const stage of stages) {
          const eventTypes = stageEvents[stage].map((event) => event.type);
          expect(eventTypes).toContain("unit_planned");
          expect(eventTypes).toContain("unit_operation_started");
          expect(eventTypes).toContain("unit_outcome_observed");
          expect(
            eventTypes.includes("unit_terminal") || eventTypes.includes("unit_resolution"),
          ).toBe(true);
          expect(eventTypes).toContain("unit_recorded");
          expect(eventTypes.at(-1)).toBe("stage_completed");
          const reduced = reduceRecoveryJournal(stageEvents[stage]);
          expect(reduced.run.acceptance_ready).toBe(true);
          expect([...reduced.units.values()].every((unit: any) =>
            ["succeeded", "skipped"].includes(unit.terminal)
            && unit.recorded === true,
          )).toBe(true);

          const receiptKeys = collectReceiptKeys(stageEvents[stage]);
          const receipts = await Promise.all([...receiptKeys].map((key) =>
            readRuntimeValue(runtime!, KV.extractionOperationReceipt(key), key)));
          const operationReceiptAccepted = receipts.some((receipt: any) =>
            receipt?.status === "succeeded"
            && receipt?.stage === stage);
          const lessonReceiptBindings = collectLessonReceiptBindings(stageEvents[stage]);
          const lessonReceipts = await Promise.all(
            [...lessonReceiptBindings.values()].map(({ receiptKey, runId }) =>
              readRuntimeValue(runtime!, KV.lessonCommitReceipts(runId), receiptKey)),
          );
          const lessonReceiptAccepted = lessonReceipts.some((receipt: any) =>
            receipt?.status === "committed"
            && receipt?.stage === stage);
          expect(
            operationReceiptAccepted || lessonReceiptAccepted,
            `${stage} journal must bind a committed formal receipt`,
          ).toBe(true);
        }

        const control = (await readFile(join(runRoot, "control.jsonl"), "utf8"))
          .trim().split("\n").filter(Boolean).map(JSON.parse);
        const status = JSON.parse(await readFile(join(runRoot, "status.json"), "utf8"));
        expect(control.at(-1)).toMatchObject({
          type: "run_completed",
          payload: { run_id: runId, stage_count: 8 },
        });
        expect(status).toMatchObject({
          run_id: runId,
          status: "completed",
          current_stage: null,
          stage_count: 8,
        });
        expect(projectSafeRecoveryStatus({
          runId,
          controlEvents: control,
          stageEvents,
          requiredStages: stages,
        })).toMatchObject({
          run_status: "completed",
          acceptance_ready: true,
          counts: {
            blocked: 0,
            system_blocked: 0,
            isolated: 0,
            dependency_blocked: 0,
          },
        });
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
    },
    240_000,
  );
});
