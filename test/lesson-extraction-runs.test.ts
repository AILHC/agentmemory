import { describe, expect, it, vi } from "vitest";
import type { Lesson, LessonExtractionRun, MemoryProvider, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import {
  enqueueLlmLessonExtractionRun,
  computeLessonExtractionConfigHash,
  computeLessonExtractionInputHash,
  processLlmLessonExtractionRun,
  resolveLlmLessonExtractionRuntimeConfig,
  listRunnableRuns,
  replaceSessionHeuristicLessons,
  stableHash,
} from "../src/functions/lesson-extraction-runs.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    id: overrides.id ?? "lesson-1",
    content: overrides.content ?? "never run shell commands in production",
    context: overrides.context ?? "test",
    confidence: overrides.confidence ?? 0.8,
    reinforcements: overrides.reinforcements ?? 0,
    source: overrides.source ?? "heuristic",
    origin: overrides.origin,
    sourceIds: overrides.sourceIds ?? [],
    sourceRunId: overrides.sourceRunId,
    project: overrides.project,
    tags: overrides.tags ?? ["tag"],
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-01T00:00:00.000Z",
    decayRate: overrides.decayRate ?? 0.05,
    deleted: overrides.deleted,
    ...(overrides.lastReinforcedAt ? { lastReinforcedAt: overrides.lastReinforcedAt } : {}),
    ...(overrides.lastDecayedAt ? { lastDecayedAt: overrides.lastDecayedAt } : {}),
  };
}

function rawObservation(overrides: {
  sessionId: string;
  id: string;
  sourceEventIndex: number;
} & Record<string, unknown>) {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    sourceEventIndex: overrides.sourceEventIndex,
    timestamp: "2026-01-01T00:00:00.000Z",
    hookType: "prompt_submit" as const,
    raw: {},
    ...overrides,
  };
}

function session(overrides: Partial<Session>): Session {
  return {
    id: overrides.id ?? "session-1",
    project: overrides.project ?? "/repo",
    cwd: overrides.cwd ?? "/repo",
    startedAt: overrides.startedAt ?? "2026-06-01T00:00:00.000Z",
    status: overrides.status ?? "active",
    observationCount: overrides.observationCount ?? 1,
    ...overrides,
  };
}

function run(overrides: Partial<LessonExtractionRun>): LessonExtractionRun {
  return {
    id: overrides.id ?? "run",
    sessionId: overrides.sessionId ?? "session-1",
    project: overrides.project ?? "/repo",
    strategy: "llm",
    status: overrides.status ?? "pending",
    inputHash: overrides.inputHash ?? "input-hash",
    configHash: overrides.configHash ?? "config-hash",
    providerName: overrides.providerName ?? "pi-agent-sdk",
    config: overrides.config ?? {
      textLimit: 1200,
      saveLimit: 50,
      chunkSize: 20,
      chunkConcurrency: 1,
      timeoutMs: 60000,
    },
    attempts: overrides.attempts ?? 0,
    createdLessonIds: overrides.createdLessonIds ?? [],
    replacedLessonIds: overrides.replacedLessonIds ?? [],
    skippedReason: overrides.skippedReason,
    lastError: overrides.lastError,
    startedAt: overrides.startedAt,
    runningLeaseUntil: overrides.runningLeaseUntil,
    finishedAt: overrides.finishedAt,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("lesson extraction run helpers", () => {
  it("computes stable hash for nested objects", () => {
    const a = stableHash({ b: { y: 2, x: 1 }, a: ["z", "a"] });
    const b = stableHash({ a: ["z", "a"], b: { x: 1, y: 2 } });
    expect(a).toBe(b);
  });

  it("computes config hash independent of object key order", () => {
    const first = computeLessonExtractionConfigHash({
      providerName: "pi-agent-sdk",
      textLimit: 1200,
      saveLimit: 50,
      chunkSize: 20,
      chunkConcurrency: 1,
      timeoutMs: 60000,
    });
    const second = computeLessonExtractionConfigHash({
      timeoutMs: 60000,
      chunkConcurrency: 1,
      chunkSize: 20,
      saveLimit: 50,
      textLimit: 1200,
      providerName: "pi-agent-sdk",
    });
    expect(first).toBe(second);
  });

  it("computes the same input hash regardless of observation list order", () => {
    const first = computeLessonExtractionInputHash([
      rawObservation({ sessionId: "s1", id: "b", sourceEventIndex: 2 }),
      rawObservation({ sessionId: "s1", id: "a", sourceEventIndex: 1 }),
    ]);
    const second = computeLessonExtractionInputHash([
      rawObservation({ sessionId: "s1", id: "a", sourceEventIndex: 1 }),
      rawObservation({ sessionId: "s1", id: "b", sourceEventIndex: 2 }),
    ]);
    expect(first).toBe(second);
  });

  it("lists runnable runs including expired running ones", async () => {
    const kv = mockKV();
    const now = new Date("2026-06-01T00:10:00.000Z");
    await kv.set(KV.lessonExtractionRuns, "run-1", run({
      id: "run-1",
      createdAt: "2026-06-01T00:00:00.000Z",
      status: "running",
      runningLeaseUntil: "2026-06-01T00:05:00.000Z",
    }));
    await kv.set(KV.lessonExtractionRuns, "run-2", run({
      id: "run-2",
      createdAt: "2026-06-01T00:01:00.000Z",
      status: "running",
      runningLeaseUntil: "2026-06-01T00:20:00.000Z",
    }));
    await kv.set(KV.lessonExtractionRuns, "run-3", run({
      id: "run-3",
      createdAt: "2026-06-01T00:02:00.000Z",
      status: "retryable",
    }));
    await kv.set(KV.lessonExtractionRuns, "run-4", run({
      id: "run-4",
      createdAt: "2026-06-01T00:03:00.000Z",
      status: "pending",
    }));
    const runs = await listRunnableRuns(kv, 5, now);
    expect(runs).toHaveLength(3);
    expect(runs.map((item) => item.id)).toEqual(["run-1", "run-3", "run-4"]);
  });

  it("clears stale provider diagnostics when an existing failed run is skipped", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-skipped", session({ id: "session-skipped" }));
    await kv.set(KV.observations("session-skipped"), "obs-1", rawObservation({
      sessionId: "session-skipped",
      id: "obs-1",
      sourceEventIndex: 1,
    }));
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {});
    const pending = await enqueueLlmLessonExtractionRun({
      kv,
      sessionId: "session-skipped",
      config,
    });
    await kv.set(KV.lessonExtractionRuns, pending.id, {
      ...pending,
      status: "failed",
      failureDiagnostics: {
        requestPhase: "chunk",
        providerErrorCode: "timeout",
        elapsedMs: 1,
        inputChars: 2,
        maxOutputTokens: 3,
        responseStarted: false,
      },
    });

    const skipped = await enqueueLlmLessonExtractionRun({
      kv,
      sessionId: "session-skipped",
      retryFailed: false,
      config,
    });

    expect(skipped.status).toBe("skipped");
    expect(Object.hasOwn(skipped, "failureDiagnostics")).toBe(false);
  });

  it("replaces only heuristic lessons created by replay import for a session", async () => {
    const kv = mockKV();
    await kv.set(KV.lessons, "shared", lesson({
      id: "shared",
      sourceIds: ["session-1", "session-2"],
      source: "heuristic",
      origin: "replay-import-heuristic",
      tags: ["import"],
    }));
    await kv.set(KV.lessons, "single", lesson({
      id: "single",
      sourceIds: ["session-1"],
      source: "heuristic",
      origin: "replay-import-heuristic",
      tags: ["import"],
    }));
    await kv.set(KV.lessons, "other-session", lesson({
      id: "other-session",
      sourceIds: ["session-2"],
      source: "heuristic",
      origin: "replay-import-heuristic",
      tags: ["import"],
    }));
    await kv.set(KV.lessons, "other-origin", lesson({
      id: "other-origin",
      sourceIds: ["session-1"],
      source: "heuristic",
      tags: ["import"],
    }));
    await kv.set(KV.lessons, "manual", lesson({
      id: "manual",
      sourceIds: ["session-1"],
      source: "manual",
      tags: ["manual"],
    }));

    const replaced = await replaceSessionHeuristicLessons(kv, "session-1");
    expect(replaced).toContain("shared");
    expect(replaced).toContain("single");

    const lessons = await kv.list<Lesson>(KV.lessons);
    const shared = lessons.find((item) => item.id === "shared");
    const single = lessons.find((item) => item.id === "single");
    const other = lessons.find((item) => item.id === "other-session");
    const otherOrigin = lessons.find((item) => item.id === "other-origin");
    const manual = lessons.find((item) => item.id === "manual");

    expect(shared?.sourceIds).toEqual(["session-2"]);
    expect(shared?.deleted).toBeFalsy();
    expect(single?.deleted).toBe(true);
    expect(single?.sourceIds).toEqual([]);
    expect(other?.sourceIds).toEqual(["session-2"]);
    expect(other?.deleted).toBeUndefined();
    expect(otherOrigin?.sourceIds).toEqual(["session-1"]);
    expect(manual?.sourceIds).toEqual(["session-1"]);
  });

  it("times out and keeps heuristic source_ids when llm extraction fails", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-timeout", session({
      id: "session-timeout",
      project: "/repo",
      firstPrompt: "start",
    }));
    await kv.set(KV.observations("session-timeout"), "obs-1", rawObservation({
      sessionId: "session-timeout",
      id: "obs-1",
      sourceEventIndex: 1,
    }));

    await kv.set(KV.lessons, "heuristic-session", lesson({
      id: "heuristic-session",
      content: "always verify source for external calls",
      source: "heuristic",
      origin: "replay-import-heuristic",
      sourceIds: ["session-timeout"],
      context: "import",
    }));

    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(() =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("<lessons />"), 100);
        }),
      ),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {
      timeoutMs: 1,
      textLimit: 10,
      chunkSize: 1,
      chunkConcurrency: 1,
    });
    const pending = await enqueueLlmLessonExtractionRun({
      kv,
      sessionId: "session-timeout",
      missingOnly: false,
      retryFailed: false,
      force: false,
      config,
    });

    const run = await processLlmLessonExtractionRun({
      kv,
      provider,
      runId: pending.id,
    });
    expect(run.status).toBe("retryable");
    expect(run.lastError).toBe("network_error");
    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(run.failureDiagnostics).toBeUndefined();

    const lessons = await kv.list<Lesson>(KV.lessons);
    const heuristic = lessons.find((item) => item.id === "heuristic-session");
    expect(heuristic?.sourceIds).toEqual(["session-timeout"]);
    expect(heuristic?.deleted).toBeUndefined();
    expect(lessons.filter((item) => item.source === "llm")).toHaveLength(0);
  });

  it("atomically persists sanitized provider diagnostics on a retryable run", async () => {
    const sensitive = "sensitive-run-error-marker";
    const kv = mockKV();
    await kv.set(KV.sessions, "session-provider-failure", session({
      id: "session-provider-failure",
      project: "/repo",
    }));
    await kv.set(KV.observations("session-provider-failure"), "obs-1", rawObservation({
      sessionId: "session-provider-failure",
      id: "obs-1",
      sourceEventIndex: 1,
      userPrompt: "Always validate source before running shell commands.",
    }));
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn().mockRejectedValue(new ProviderCallError(
        `pi_stream_failed ${sensitive}`,
        {
          providerErrorCode: "rate_limited",
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 1200,
          inputChars: 38000,
          maxOutputTokens: 4096,
          responseStarted: false,
          rawError: sensitive,
        } as never,
      )),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {
      textLimit: 1200,
      saveLimit: 10,
      chunkSize: 10,
      chunkConcurrency: 1,
      timeoutMs: 60000,
    });
    const pending = await enqueueLlmLessonExtractionRun({
      kv,
      sessionId: "session-provider-failure",
      config,
    });

    const processed = await processLlmLessonExtractionRun({
      kv,
      provider,
      runId: pending.id,
    });
    const persisted = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, pending.id);

    expect(processed.status).toBe("retryable");
    expect(processed.lastError).toBe("pi_stream_failed");
    expect(processed.failureDiagnostics).toEqual({
      requestPhase: "chunk",
      providerErrorCode: "rate_limited",
      statusCode: 429,
      retryAfterMs: 2500,
      elapsedMs: 1200,
      inputChars: 38000,
      maxOutputTokens: 4096,
      responseStarted: false,
    });
    expect(persisted).toEqual(processed);
    expect(JSON.stringify(persisted)).not.toContain(sensitive);
  });

  it("replaces stale provider diagnostics with safe parse diagnostics", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-parse-failure", session({
      id: "session-parse-failure",
      project: "/repo",
    }));
    await kv.set(KV.observations("session-parse-failure"), "obs-1", rawObservation({
      sessionId: "session-parse-failure",
      id: "obs-1",
      sourceEventIndex: 1,
      userPrompt: "Always validate source before running shell commands.",
    }));
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn().mockResolvedValue("<root />"),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {});
    const pending = await enqueueLlmLessonExtractionRun({
      kv,
      sessionId: "session-parse-failure",
      config,
    });
    await kv.set(KV.lessonExtractionRuns, pending.id, {
      ...pending,
      failureDiagnostics: {
        requestPhase: "chunk",
        providerErrorCode: "timeout",
        elapsedMs: 1,
        inputChars: 2,
        maxOutputTokens: 3,
        responseStarted: false,
      },
    });

    const processed = await processLlmLessonExtractionRun({ kv, provider, runId: pending.id });

    expect(processed.status).toBe("retryable");
    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(processed.failureDiagnostics).toEqual({
      requestPhase: "chunk",
      parseErrorCode: "lesson_missing_root",
      chunkIndex: 0,
      attempt: 2,
      responseChars: 8,
    });
  });

  it("saves llm provenance and replaces only target replay-import-heuristic heuristics on success", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-success", session({
      id: "session-success",
      project: "/repo",
    }));
    await kv.set(KV.observations("session-success"), "obs-1", rawObservation({
      sessionId: "session-success",
      id: "obs-1",
      sourceEventIndex: 1,
      userPrompt: "I must always validate source before running shell commands.",
    }));

    await kv.set(KV.lessons, "shared", lesson({
      id: "shared",
      content: "shared heuristic",
      source: "heuristic",
      origin: "replay-import-heuristic",
      sourceIds: ["session-success", "session-other"],
    }));
    await kv.set(KV.lessons, "single", lesson({
      id: "single",
      content: "single heuristic",
      source: "heuristic",
      origin: "replay-import-heuristic",
      sourceIds: ["session-success"],
    }));
    await kv.set(KV.lessons, "other-origin", lesson({
      id: "other-origin",
      content: "other origin",
      source: "heuristic",
      sourceIds: ["session-success"],
      origin: undefined,
    }));
    await kv.set(KV.lessons, "manual", lesson({
      id: "manual",
      content: "manual lesson",
      source: "manual",
      sourceIds: ["session-success"],
    }));
    await kv.set(KV.lessons, "other-session", lesson({
      id: "other-session",
      content: "other session heuristic",
      source: "heuristic",
      origin: "replay-import-heuristic",
      sourceIds: ["session-other"],
    }));

    const xml = `
<lessons>
  <lesson confidence=\"0.72\">
    <content>always validate source before running shell</content>
    <context>session success context</context>
    <tags><tag>agentmemory</tag></tags>
  </lesson>
</lessons>`;

    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn().mockResolvedValue(xml),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {
      textLimit: 1200,
      saveLimit: 10,
      chunkSize: 10,
      chunkConcurrency: 2,
      timeoutMs: 1000,
    });
    const pending = await enqueueLlmLessonExtractionRun({
      kv,
      sessionId: "session-success",
      missingOnly: false,
      retryFailed: false,
      force: false,
      config,
    });
    const processed = await processLlmLessonExtractionRun({
      kv,
      provider,
      runId: pending.id,
    });
    expect(processed.status).toBe("succeeded");
    expect(processed.createdLessonIds).toHaveLength(1);
    expect(processed.replacedLessonIds).toEqual(expect.arrayContaining(["shared", "single"]));

    const lessons = await kv.list<Lesson>(KV.lessons);
    const sessionSuccess = lessons.find((item) => item.source === "llm");
    expect(sessionSuccess).toBeDefined();
    expect(sessionSuccess?.source).toBe("llm");
    expect(sessionSuccess?.origin).toBe("llm-session-extraction");
    expect(sessionSuccess?.sourceRunId).toBe(processed.id);
    expect(sessionSuccess?.sourceIds).toEqual(["session-success"]);

    const shared = lessons.find((item) => item.id === "shared");
    const single = lessons.find((item) => item.id === "single");
    const otherOrigin = lessons.find((item) => item.id === "other-origin");
    const otherSession = lessons.find((item) => item.id === "other-session");
    const manual = lessons.find((item) => item.id === "manual");

    expect(shared?.sourceIds).toEqual(["session-other"]);
    expect(shared?.deleted).toBeUndefined();
    expect(single?.sourceIds).toEqual([]);
    expect(single?.deleted).toBe(true);
    expect(otherOrigin?.sourceIds).toEqual(["session-success"]);
    expect(otherSession?.sourceIds).toEqual(["session-other"]);
    expect(manual?.sourceIds).toEqual(["session-success"]);
  });

  it("uses 1 concurrency for pi-agent-sdk and 3 for other providers", () => {
    const piProvider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const resilientProvider: MemoryProvider = {
      name: "resilient(pi-agent-sdk)",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const mockProvider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(),
      summarize: vi.fn(),
    };

    const piCfg = resolveLlmLessonExtractionRuntimeConfig(piProvider, {});
    const resilientCfg = resolveLlmLessonExtractionRuntimeConfig(resilientProvider, {});
    const otherCfg = resolveLlmLessonExtractionRuntimeConfig(mockProvider, {});

    expect(piCfg.chunkConcurrency).toBe(1);
    expect(resilientCfg.chunkConcurrency).toBe(1);
    expect(otherCfg.chunkConcurrency).toBe(3);
  });

  it("does not record ignored stage model overrides for unsupported providers", () => {
    const provider: MemoryProvider = {
      name: "openai",
      compress: vi.fn(),
      summarize: vi.fn(),
    };

    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {
      model: "lesson-model",
      textLimit: 1200,
      saveLimit: 50,
      chunkSize: 20,
      chunkConcurrency: 3,
      timeoutMs: 60000,
    });

    expect(config.model).toBeUndefined();
    expect(config.modelSource).toBeUndefined();
    expect(computeLessonExtractionConfigHash(config)).toBe(
      computeLessonExtractionConfigHash({
        providerName: "openai",
        textLimit: 1200,
        saveLimit: 50,
        chunkSize: 20,
        chunkConcurrency: 3,
        timeoutMs: 60000,
      }),
    );
  });
});
