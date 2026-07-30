import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { KV } from "../src/state/schema.js";
import { mainForTest, stableHash } from "../ops/scripts/run-agentmemory-full-extraction.mjs";
import { projectSafeRecoveryStatus } from "../ops/scripts/lib/recovery-status-projection-v1.mjs";

type Boundary =
  | "generation registry"
  | "generation run binding"
  | "candidate staging"
  | "candidate run binding"
  | "commit plan"
  | "formal lesson watermark"
  | "initial committing receipt"
  | "first progress receipt"
  | "committed receipt"
  | "extraction operation receipt";

interface StateKvFault {
  name: Boundary;
  expectedOutcome: "completed" | "conservative";
  expectedProviderCalls: number;
  expectedCrashLessonCount: number;
  expectedCrashCommitReceiptStatuses: Array<"committing" | "committed">;
}

interface RuntimeSnapshot {
  scopes: Record<string, Record<string, any>>;
  metadata: { providerCalls: number; faultBoundary?: Boundary };
}

interface ChildRuntime {
  child: ChildProcess;
  baseUrl: string;
  port: number;
  stateDir: string;
  durableBoundaries: Boundary[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const fixturePath = fileURLToPath(new URL("./fixtures/lesson-runtime-subprocess.ts", import.meta.url));
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function summaryResponse({ attemptId, inputHash }: { attemptId: string; inputHash: string }) {
  const title = "temporary runtime summary";
  const resumableRunId = stableHash({ attemptId, inputHash, source: "temporary-runtime" });
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

function errorWithCode(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

async function startRuntime({ stateDir, fault, port }: { stateDir: string; fault?: Boundary; port?: number }): Promise<ChildRuntime> {
  const durableBoundaries: Boundary[] = [];
  const child = fork(fixturePath, [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      AGENTMEMORY_TEST_RUNTIME_STATE_DIR: stateDir,
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
      const timeout = setTimeout(() => reject(new Error("test_runtime_start_timeout")), 10_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.once("error", fail);
      child.stderr?.once("data", (chunk) => fail(new Error(`test_runtime_start_failed:${chunk.toString()}`)));
      child.on("message", (message: any) => {
        if (message?.type === "fault-durable") durableBoundaries.push(message.boundary);
        if (message?.type !== "ready") return;
        clearTimeout(timeout);
        resolve(message.baseUrl);
      });
      exit.then(({ code, signal }) => fail(new Error(`test_runtime_exited_before_ready:${code ?? signal}`)));
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    throw error;
  }
  return { child, baseUrl, port: Number(new URL(baseUrl).port), stateDir, durableBoundaries, exit };
}

async function stopRuntime(runtime: ChildRuntime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  runtime.child.send({ type: "shutdown" });
  await Promise.race([
    runtime.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("test_runtime_shutdown_timeout")), 10_000)),
  ]);
}

async function readRuntimeSnapshot(runtime: ChildRuntime): Promise<RuntimeSnapshot> {
  const response = await fetch(`${runtime.baseUrl}/__test/state`);
  if (!response.ok) throw new Error(`test_runtime_state_http_${response.status}`);
  return response.json() as Promise<RuntimeSnapshot>;
}

async function readPersistedRuntimeSnapshot(stateDir: string): Promise<RuntimeSnapshot> {
  return deserialize(await readFile(join(stateDir, "statekv-substitute.bin"))) as RuntimeSnapshot;
}

function values<T = any>(snapshot: RuntimeSnapshot, scope: string) {
  return Object.values(snapshot.scopes[scope] ?? {}) as T[];
}

function testDependencies(fsApi?: typeof fs) {
  return {
    fsApi,
    v2RemainingStages: false,
    v2SummaryRemote: { advance: summaryResponse, record: async () => {} },
  };
}

async function invokeRunner(argv: string[], dependencies = testDependencies()) {
  return mainForTest(argv, dependencies);
}

async function runFaultScenario(fault?: StateKvFault) {
  process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
  process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
  const stateDir = await mkdtemp(join(tmpdir(), "agentmemory-lessons-runtime-e2e-"));
  const runtimeStateDir = join(stateDir, "persistent-statekv-substitute");
  const runId = "runtime-e2e-matrix";
  let runtime: ChildRuntime | null = null;
  const exitCodes: number[] = [];
  let initialError: unknown = null;
  let crashedExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let crashSnapshot: RuntimeSnapshot | null = null;
  try {
    runtime = await startRuntime({ stateDir: runtimeStateDir, fault: fault?.name });
    const argv = ["--base-url", runtime.baseUrl, "--state-dir", stateDir, "--run-id", runId, "--mark", runId, "--run-state-format", "v2"];
    try {
      exitCodes.push(await invokeRunner(argv));
    } catch (error) {
      initialError = error;
    }
    if (fault) {
      crashedExit = await runtime.exit;
      expect(crashedExit).toEqual({ code: 86, signal: null });
      expect(runtime.durableBoundaries).toEqual([fault.name]);
      crashSnapshot = await readPersistedRuntimeSnapshot(runtimeStateDir);
      runtime = await startRuntime({ stateDir: runtimeStateDir, port: runtime.port });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const code = await invokeRunner([...argv, "--resume"]);
        exitCodes.push(code);
        if (code !== 75) break;
      }
    }
    const snapshot = await readRuntimeSnapshot(runtime);
    const lessons = values(snapshot, KV.lessons);
    const runs = values(snapshot, KV.lessonExtractionRuns);
    const registry = snapshot.scopes[KV.lessonExtractionGeneration("temporary-runtime-session")]?.["temporary-runtime-session"];
    const receiptScope = Object.keys(snapshot.scopes).find((scope) => scope.startsWith("mem:lesson-commit:receipts:"));
    const receipts = receiptScope ? values(snapshot, receiptScope) : [];
    const journal = (await readFile(join(stateDir, `${runId}.v2`, "lessons.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const control = (await readFile(join(stateDir, `${runId}.v2`, "control.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const safeStatus = projectSafeRecoveryStatus({ runId, controlEvents: control, stageEvents: { lessons: journal }, requiredStages: ["lessons"] });
    return {
      stateDir, runtimeStateDir, exitCodes, initialError, crashedExit, crashSnapshot, durableBoundaries: runtime.durableBoundaries,
      snapshot, providerCalls: snapshot.metadata.providerCalls, lessons, runs, registry, receipts, journal, safeStatus,
      sessionId: "temporary-runtime-session",
    };
  } finally {
    try {
      if (runtime) await stopRuntime(runtime);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
}

function faultingJournalFs(kind: "write" | "sync" | "rename") {
  let injected = false;
  const fsApi = {
    ...fs,
    open: async (filePath: string, flags: string, ...args: any[]) => {
      const handle = await fs.open(filePath, flags as any, ...args);
      if (!String(filePath).endsWith(".jsonl") || flags !== "a") return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "writeFile") return async (...writeArgs: any[]) => {
            if (!injected && kind === "write") {
              injected = true;
              throw errorWithCode("injected_journal_append_enospc", "ENOSPC");
            }
            return target.writeFile(...writeArgs);
          };
          if (property === "sync") return async () => {
            if (!injected && kind === "sync") {
              injected = true;
              throw errorWithCode("injected_journal_sync_eio", "EIO");
            }
            return target.sync();
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    rename: async (source: string, target: string) => {
      if (!injected && kind === "rename" && String(target).endsWith("status.json")) {
        injected = true;
        throw errorWithCode("injected_journal_status_rename_eio", "EIO");
      }
      return fs.rename(source, target);
    },
  } as typeof fs;
  return { fsApi, injected: () => injected };
}

describe("Lessons persistent StateKV substitute recovery seam", () => {
  it.each<StateKvFault>([
    { name: "generation registry", expectedOutcome: "conservative", expectedProviderCalls: 0, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: [] },
    { name: "generation run binding", expectedOutcome: "conservative", expectedProviderCalls: 0, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: [] },
    { name: "candidate staging", expectedOutcome: "conservative", expectedProviderCalls: 1, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: [] },
    { name: "candidate run binding", expectedOutcome: "completed", expectedProviderCalls: 1, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: [] },
    { name: "commit plan", expectedOutcome: "completed", expectedProviderCalls: 1, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: [] },
    { name: "formal lesson watermark", expectedOutcome: "completed", expectedProviderCalls: 1, expectedCrashLessonCount: 1, expectedCrashCommitReceiptStatuses: ["committing"] },
    { name: "initial committing receipt", expectedOutcome: "completed", expectedProviderCalls: 1, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: ["committing"] },
    { name: "first progress receipt", expectedOutcome: "completed", expectedProviderCalls: 1, expectedCrashLessonCount: 1, expectedCrashCommitReceiptStatuses: ["committing"] },
    { name: "committed receipt", expectedOutcome: "completed", expectedProviderCalls: 1, expectedCrashLessonCount: 2, expectedCrashCommitReceiptStatuses: ["committed"] },
    { name: "extraction operation receipt", expectedOutcome: "conservative", expectedProviderCalls: 0, expectedCrashLessonCount: 0, expectedCrashCommitReceiptStatuses: [] },
  ])("restarts after a durable %s StateKV boundary without duplicate formal effects", async (fault) => {
    const baseline = await runFaultScenario();
    const recovered = await runFaultScenario(fault);

    expect(baseline.exitCodes.at(-1)).toBe(0);
    expect(recovered.crashedExit).toEqual({ code: 86, signal: null });
    expect(recovered.snapshot.metadata.faultBoundary).toBe(fault.name);
    expect(recovered.initialError ?? recovered.exitCodes[0]).not.toBe(0);
    expect(recovered.providerCalls).toBe(fault.expectedProviderCalls);
    expect(recovered.crashSnapshot).not.toBeNull();
    const crashSnapshot = recovered.crashSnapshot!;
    const crashLessons = values(crashSnapshot, KV.lessons);
    const crashReceiptScope = Object.keys(crashSnapshot.scopes).find((scope) => scope.startsWith("mem:lesson-commit:receipts:"));
    const crashReceipts = crashReceiptScope ? values(crashSnapshot, crashReceiptScope) : [];
    expect(crashLessons).toHaveLength(fault.expectedCrashLessonCount);
    expect(crashReceipts.map((receipt: any) => receipt.status)).toEqual(fault.expectedCrashCommitReceiptStatuses);
    expect(crashLessons.length).toBeLessThanOrEqual(2);
    expect(crashReceipts.length).toBeLessThanOrEqual(1);
    expect(new Set(Object.values(recovered.registry?.bindings ?? {}).map((binding: any) => binding.generation)).size)
      .toBe(Object.keys(recovered.registry?.bindings ?? {}).length);
    expect(recovered.lessons.length).toBeLessThanOrEqual(2);
    expect(recovered.receipts.length).toBeLessThanOrEqual(1);
    expect(recovered.journal.some((event: any) => event.type === "unit_terminal" && event.payload?.status === "failed")).toBe(false);
    if (fault.expectedOutcome === "conservative") {
      expect(recovered.exitCodes.at(-1)).not.toBe(0);
      expect(recovered.safeStatus.run_status).not.toBe("completed");
      expect(recovered.lessons).toHaveLength(0);
      expect(recovered.receipts).toHaveLength(0);
      return;
    }
    expect(recovered.exitCodes.at(-1)).toBe(0);
    const project = (result: typeof baseline) => result.lessons.map((lesson: any) => ({
      id: lesson.id,
      confidence: lesson.confidence,
      sourceIds: lesson.sourceIds,
      tags: lesson.tags,
      watermarkGenerations: Object.fromEntries(
        Object.entries(lesson.sourceWatermarks ?? {}).map(([sessionId, watermark]: [string, any]) => [sessionId, watermark.generation]),
      ),
    }));
    expect(project(recovered)).toEqual(project(baseline));
    expect(recovered.receipts).toHaveLength(1);
    expect(recovered.receipts[0]).toMatchObject({
      status: "committed",
      appliedLessonIds: expect.arrayContaining(recovered.lessons.map((lesson: any) => lesson.id)),
    });
    expect(recovered.receipts[0].appliedLessonIds).toHaveLength(recovered.lessons.length);
    expect(recovered.safeStatus).toMatchObject({ run_status: "completed", counts: { succeeded: 1 } });
  }, 20_000);

  it.each(["write", "sync", "rename"] as const)("keeps Journal V2 conservative after a real temporary-file %s failure", async (kind) => {
    process.env.AGENTMEMORY_SECRET = "temporary-test-secret";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const stateDir = await mkdtemp(join(tmpdir(), "agentmemory-lessons-runtime-journal-fault-"));
    let runtime: ChildRuntime | null = null;
    const runId = `runtime-journal-${kind}`;
    const fault = faultingJournalFs(kind);
    try {
      runtime = await startRuntime({ stateDir: join(stateDir, "persistent-statekv-substitute") });
      const argv = ["--base-url", runtime.baseUrl, "--state-dir", stateDir, "--run-id", runId, "--mark", runId, "--run-state-format", "v2"];
      await expect(invokeRunner(argv, testDependencies(fault.fsApi))).rejects.toThrow(kind === "write"
        ? /injected_journal_append_enospc/
        : kind === "sync"
          ? /injected_journal_sync_eio/
          : /injected_journal_status_rename_eio/);
      expect(fault.injected()).toBe(true);

      const statusPath = join(stateDir, `${runId}.v2`, "status.json");
      const failedStatus = await readFile(statusPath, "utf8").then(JSON.parse).catch((error: any) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      expect(failedStatus?.status).not.toBe("completed");
      expect(failedStatus?.status).not.toBe("failed");

      expect(await invokeRunner([...argv, "--resume"])).toBe(0);
      const journal = (await readFile(join(stateDir, `${runId}.v2`, "lessons.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      const control = (await readFile(join(stateDir, `${runId}.v2`, "control.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      const safeStatus = projectSafeRecoveryStatus({ runId, controlEvents: control, stageEvents: { lessons: journal }, requiredStages: ["lessons"] });
      expect(safeStatus).toMatchObject({ run_status: "completed", counts: { succeeded: 1 } });
      expect(journal.some((event: any) => event.type === "unit_terminal" && event.payload?.status === "failed")).toBe(false);
    } finally {
      try {
        if (runtime) await stopRuntime(runtime);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  });
});
