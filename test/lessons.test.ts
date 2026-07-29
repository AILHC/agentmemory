import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerLessonsFunctions } from "../src/functions/lessons.js";
import {
  computeLessonExtractionConfigHash,
  computeLessonExtractionInputHash,
  resolveLlmLessonExtractionRuntimeConfig,
  runIdForSession,
  stableHash,
} from "../src/functions/lesson-extraction-runs.js";
import {
  buildExtractionOperationKey,
  registerExtractionOperationReceiptFunctions,
} from "../src/functions/extraction-operation-receipts.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";
import type { Lesson, MemoryProvider } from "../src/types.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("Lessons", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
  });

  describe("mem::lesson-save", () => {
    it("creates a lesson with default confidence 0.5", async () => {
      const result = (await sdk.trigger("mem::lesson-save", {
        content: "Always use execFile instead of exec",
        context: "Security best practice",
        project: "/test",
        tags: ["security"],
      })) as { success: boolean; action: string; lesson: Lesson };

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.lesson.confidence).toBe(0.5);
      expect(result.lesson.content).toBe("Always use execFile instead of exec");
      expect(result.lesson.source).toBe("manual");
      expect(result.lesson.reinforcements).toBe(0);
    });

    it("accepts custom confidence", async () => {
      const result = (await sdk.trigger("mem::lesson-save", {
        content: "Test lesson",
        confidence: 0.8,
      })) as { lesson: Lesson };

      expect(result.lesson.confidence).toBe(0.8);
    });

    it("clamps invalid confidence to default", async () => {
      const result = (await sdk.trigger("mem::lesson-save", {
        content: "Bad confidence",
        confidence: 5.0,
      })) as { lesson: Lesson };

      expect(result.lesson.confidence).toBe(0.5);
    });

    it("strengthens existing lesson on duplicate content", async () => {
      const first = (await sdk.trigger("mem::lesson-save", {
        content: "Duplicate lesson",
      })) as { action: string; lesson: Lesson };

      expect(first.action).toBe("created");
      const originalId = first.lesson.id;

      const second = (await sdk.trigger("mem::lesson-save", {
        content: "Duplicate lesson",
      })) as { action: string; lesson: Lesson };

      expect(second.action).toBe("strengthened");
      expect(second.lesson.id).toBe(originalId);
      expect(second.lesson.reinforcements).toBe(1);
      expect(second.lesson.confidence).toBeGreaterThan(0.5);
    });

    it("rejects empty content", async () => {
      const result = (await sdk.trigger("mem::lesson-save", {
        content: "",
      })) as { success: boolean };

      expect(result.success).toBe(false);
    });

    it("sets crystal source and sourceIds when provided", async () => {
      const result = (await sdk.trigger("mem::lesson-save", {
        content: "Crystal-derived lesson",
        source: "crystal",
        sourceIds: ["crys_123"],
        confidence: 0.6,
      })) as { lesson: Lesson };

      expect(result.lesson.source).toBe("crystal");
      expect(result.lesson.sourceIds).toEqual(["crys_123"]);
      expect(result.lesson.confidence).toBe(0.6);
    });
  });

  describe("mem::lesson-recall", () => {
    beforeEach(async () => {
      await sdk.trigger("mem::lesson-save", {
        content: "Database indexing improves query performance",
        project: "/app",
        tags: ["database"],
        confidence: 0.9,
      });
      await sdk.trigger("mem::lesson-save", {
        content: "Always validate user input at boundaries",
        project: "/app",
        tags: ["security"],
        confidence: 0.3,
      });
      await sdk.trigger("mem::lesson-save", {
        content: "Use TypeScript strict mode for type safety",
        project: "/other",
        tags: ["typescript"],
      });
    });

    it("finds lessons matching query", async () => {
      const result = (await sdk.trigger("mem::lesson-recall", {
        query: "database performance",
      })) as { success: boolean; lessons: Array<Lesson & { score: number }> };

      expect(result.success).toBe(true);
      expect(result.lessons.length).toBeGreaterThan(0);
      expect(result.lessons[0].content).toContain("Database indexing");
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::lesson-recall", {
        query: "type safety typescript",
        project: "/other",
      })) as { lessons: Lesson[] };

      expect(result.lessons.length).toBe(1);
      expect(result.lessons[0].project).toBe("/other");
    });

    it("filters by minConfidence", async () => {
      const result = (await sdk.trigger("mem::lesson-recall", {
        query: "validate input",
        minConfidence: 0.5,
      })) as { lessons: Lesson[] };

      expect(result.lessons.length).toBe(0);
    });

    it("returns empty for no matches", async () => {
      const result = (await sdk.trigger("mem::lesson-recall", {
        query: "xyznonexistent",
      })) as { lessons: Lesson[] };

      expect(result.lessons.length).toBe(0);
    });

    it("rejects empty query", async () => {
      const result = (await sdk.trigger("mem::lesson-recall", {
        query: "",
      })) as { success: boolean };

      expect(result.success).toBe(false);
    });
  });

  describe("mem::lesson-list", () => {
    beforeEach(async () => {
      await sdk.trigger("mem::lesson-save", { content: "Lesson A", confidence: 0.9, project: "/app" });
      await sdk.trigger("mem::lesson-save", { content: "Lesson B", confidence: 0.3, project: "/app" });
      await sdk.trigger("mem::lesson-save", { content: "Lesson C", confidence: 0.7, source: "crystal" });
    });

    it("lists all lessons sorted by confidence", async () => {
      const result = (await sdk.trigger("mem::lesson-list", {})) as { lessons: Lesson[] };

      expect(result.lessons.length).toBe(3);
      expect(result.lessons[0].confidence).toBe(0.9);
      expect(result.lessons[2].confidence).toBe(0.3);
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::lesson-list", { project: "/app" })) as { lessons: Lesson[] };
      expect(result.lessons.length).toBe(2);
    });

    it("filters by source", async () => {
      const result = (await sdk.trigger("mem::lesson-list", { source: "crystal" })) as { lessons: Lesson[] };
      expect(result.lessons.length).toBe(1);
    });

    it("filters by minConfidence", async () => {
      const result = (await sdk.trigger("mem::lesson-list", { minConfidence: 0.5 })) as { lessons: Lesson[] };
      expect(result.lessons.length).toBe(2);
    });

    it("respects limit", async () => {
      const result = (await sdk.trigger("mem::lesson-list", { limit: 1 })) as { lessons: Lesson[] };
      expect(result.lessons.length).toBe(1);
    });
  });

  describe("mem::lesson-strengthen", () => {
    it("increases confidence with diminishing returns", async () => {
      const saved = (await sdk.trigger("mem::lesson-save", {
        content: "Strengthen me",
        confidence: 0.5,
      })) as { lesson: Lesson };

      const result = (await sdk.trigger("mem::lesson-strengthen", {
        lessonId: saved.lesson.id,
      })) as { success: boolean; lesson: Lesson };

      expect(result.success).toBe(true);
      expect(result.lesson.reinforcements).toBe(1);
      expect(result.lesson.confidence).toBeCloseTo(0.55, 2);
      expect(result.lesson.lastReinforcedAt).toBeDefined();
    });

    it("caps confidence at 1.0", async () => {
      const saved = (await sdk.trigger("mem::lesson-save", {
        content: "High confidence",
        confidence: 0.95,
      })) as { lesson: Lesson };

      const result = (await sdk.trigger("mem::lesson-strengthen", {
        lessonId: saved.lesson.id,
      })) as { lesson: Lesson };

      expect(result.lesson.confidence).toBeLessThanOrEqual(1.0);
    });

    it("fails for missing lessonId", async () => {
      const result = (await sdk.trigger("mem::lesson-strengthen", {
        lessonId: "nonexistent",
      })) as { success: boolean };

      expect(result.success).toBe(false);
    });
  });

  describe("mem::lesson-decay-sweep", () => {
    it("decays old lessons incrementally", async () => {
      const saved = (await sdk.trigger("mem::lesson-save", {
        content: "Old lesson",
        confidence: 0.8,
      })) as { lesson: Lesson };

      const lessons = await kv.list<Lesson>("mem:lessons");
      const lesson = lessons[0];
      lesson.createdAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      await kv.set("mem:lessons", lesson.id, lesson);

      const result = (await sdk.trigger("mem::lesson-decay-sweep", {})) as {
        decayed: number;
        softDeleted: number;
      };

      expect(result.decayed).toBe(1);

      const after = await kv.get<Lesson>("mem:lessons", lesson.id);
      expect(after!.confidence).toBeLessThan(0.8);
      expect(after!.lastDecayedAt).toBeDefined();
    });

    it("does not decay lessons less than 1 week old", async () => {
      await sdk.trigger("mem::lesson-save", {
        content: "Recent lesson",
        confidence: 0.5,
      });

      const result = (await sdk.trigger("mem::lesson-decay-sweep", {})) as {
        decayed: number;
      };

      expect(result.decayed).toBe(0);
    });

    it("soft-deletes low-confidence unreinforced lessons", async () => {
      const saved = (await sdk.trigger("mem::lesson-save", {
        content: "Weak lesson",
        confidence: 0.12,
      })) as { lesson: Lesson };

      const lesson = await kv.get<Lesson>("mem:lessons", saved.lesson.id);
      lesson!.createdAt = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
      await kv.set("mem:lessons", lesson!.id, lesson!);

      const result = (await sdk.trigger("mem::lesson-decay-sweep", {})) as {
        softDeleted: number;
      };

      expect(result.softDeleted).toBe(1);

      const after = await kv.get<Lesson>("mem:lessons", saved.lesson.id);
      expect(after!.deleted).toBe(true);
    });

    it("uses lastDecayedAt for incremental delta (not full age)", async () => {
      const saved = (await sdk.trigger("mem::lesson-save", {
        content: "Incremental decay",
        confidence: 0.8,
      })) as { lesson: Lesson };

      const lesson = await kv.get<Lesson>("mem:lessons", saved.lesson.id);
      lesson!.createdAt = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
      lesson!.lastDecayedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      lesson!.confidence = 0.6;
      await kv.set("mem:lessons", lesson!.id, lesson!);

      await sdk.trigger("mem::lesson-decay-sweep", {});

      const after = await kv.get<Lesson>("mem:lessons", saved.lesson.id);
      expect(after!.confidence).toBeCloseTo(0.55, 2);
      expect(after!.confidence).toBeGreaterThan(0.4);
    });
  });

  describe("mem::lessons::extract-llm", () => {
    it("fails when provider is missing", async () => {
      const result = (await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-1"],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/provider is required/);
    });

    it("supports extract-runs and extract-run-get with active provider", async () => {
      const provider: MemoryProvider = {
        name: "mock-llm",
        compress: vi.fn(async () => ""),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);

      await kv.set(KV.sessions, "session-1", {
        id: "session-1",
        project: "project",
        cwd: "/tmp/project",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        observationCount: 0,
      });

      const extractResult = (await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-1"],
      })) as { success: boolean; runs: Array<{ id: string }> };
      expect(extractResult.success).toBe(true);
      expect(extractResult.runs).toHaveLength(1);

      const runsResult = (await sdk.trigger("mem::lessons::extract-runs", {})) as {
        success: boolean;
        runs: Array<{ id: string; status: string }>;
      };
      expect(runsResult.success).toBe(true);
      expect(runsResult.runs.length).toBe(1);
      expect(runsResult.runs[0].id).toBe(extractResult.runs[0].id);

      const runResult = (await sdk.trigger("mem::lessons::extract-run-get", {
        runId: extractResult.runs[0].id,
      })) as {
        success: boolean;
        run: { id: string };
        chunks: unknown[];
      };
      expect(runResult.success).toBe(true);
      expect(runResult.run.id).toBe(extractResult.runs[0].id);
      expect(Array.isArray(runResult.chunks)).toBe(true);
      expect(runResult.chunks).toHaveLength(0);
    });

    it("binds a v2 receipt to actual observations and replays without another model call", async () => {
      const xml = `
<lessons>
  <lesson confidence="0.8">
    <content>Bind the receipt to actual lesson inputs.</content>
    <context>v2 recovery</context>
    <tags><tag>receipt</tag></tags>
  </lesson>
</lessons>`;
      const provider: MemoryProvider = {
        name: "mock-llm",
        compress: vi.fn(async () => xml),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);
      await kv.set(KV.sessions, "session-v2", {
        id: "session-v2",
        project: "project",
        cwd: "/tmp/project",
        startedAt: "2026-07-24T00:00:00.000Z",
        status: "active",
        observationCount: 1,
      });
      await kv.set(KV.observations("session-v2"), "obs-1", {
        id: "obs-1",
        sessionId: "session-v2",
        timestamp: "2026-07-24T00:00:01.000Z",
        hookType: "user",
        userPrompt: "Keep the receipt bound to the actual observation inventory.",
        raw: {},
        sourceEventIndex: 1,
      });
      const request = {
        sessionIds: ["session-v2"],
        attemptId: "attempt-v2",
        inputHash: "runner-session-freshness",
      };

      const first = await sdk.trigger("mem::lessons::extract-llm", request) as {
        success: boolean;
        runs: Array<{ status: string }>;
      };
      const replay = await sdk.trigger("mem::lessons::extract-llm", request);

      expect(first).toMatchObject({ success: true, runs: [{ status: "succeeded" }] });
      expect(replay).toEqual(first);
      expect(provider.compress).toHaveBeenCalledTimes(1);

      await kv.set(KV.observations("session-v2"), "obs-2", {
        id: "obs-2",
        sessionId: "session-v2",
        timestamp: "2026-07-24T00:00:02.000Z",
        hookType: "user",
        userPrompt: "This changes the actual service input.",
        raw: {},
        sourceEventIndex: 2,
      });
      const drift = await sdk.trigger("mem::lessons::extract-llm", request);
      expect(drift).toMatchObject({
        success: false,
        failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
      });
      expect(provider.compress).toHaveBeenCalledTimes(1);
    });

    it("blocks an orphaned v2 receipt and reconciles it only from a persisted terminal run", async () => {
      const xml = `
<lessons>
  <lesson confidence="0.8">
    <content>Reconcile only from durable lesson results.</content>
    <context>v2 recovery</context>
    <tags><tag>receipt</tag></tags>
  </lesson>
</lessons>`;
      const provider: MemoryProvider = {
        name: "mock-llm",
        compress: vi.fn(async () => xml),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);
      const observation = {
        id: "obs-1",
        sessionId: "session-orphan",
        timestamp: "2026-07-24T00:00:01.000Z",
        hookType: "user",
        userPrompt: "Do not repeat an uncertain model call.",
        raw: {},
        sourceEventIndex: 1,
      };
      await kv.set(KV.sessions, "session-orphan", {
        id: "session-orphan",
        project: "project",
        cwd: "/tmp/project",
        startedAt: "2026-07-24T00:00:00.000Z",
        status: "active",
        observationCount: 1,
      });
      await kv.set(KV.observations("session-orphan"), observation.id, observation);
      const runnerInputHash = "runner-session-freshness";
      const config = resolveLlmLessonExtractionRuntimeConfig(provider);
      const identity = {
        runId: "attempt-orphan",
        stage: "lessons" as const,
        unitId: "session-orphan",
        inputHash: stableHash({
          runnerInputHash,
          serviceInputHash: computeLessonExtractionInputHash([observation]),
          configHash: computeLessonExtractionConfigHash(config),
        }),
      };
      const receiptKey = buildExtractionOperationKey(identity);
      await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
        ...identity,
        key: receiptKey,
        status: "running",
        startedAt: "2026-07-24T00:00:00.000Z",
      });
      const request = {
        sessionIds: ["session-orphan"],
        attemptId: identity.runId,
        inputHash: runnerInputHash,
      };

      const blocked = await sdk.trigger("mem::lessons::extract-llm", request);
      expect(blocked).toMatchObject({
        success: false,
        failure: {
          class: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
        },
      });
      expect(provider.compress).not.toHaveBeenCalled();

      const legacyResult = await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-orphan"],
      }) as { runs: Array<{ status: string }> };
      expect(legacyResult.runs[0].status).toBe("succeeded");
      expect(provider.compress).toHaveBeenCalledTimes(1);

      const reconciled = await sdk.trigger("mem::lessons::extract-llm", request);
      expect(reconciled).toMatchObject({
        success: true,
        runs: [{ status: "succeeded" }],
      });
      expect(provider.compress).toHaveBeenCalledTimes(1);
      expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey)).toMatchObject({
        status: "succeeded",
      });
    });

    it("blocks a recovered v2 attempt whose receipt is missing", async () => {
      const provider: MemoryProvider = {
        name: "mock-llm",
        compress: vi.fn(async () => "<lessons></lessons>"),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);
      await kv.set(KV.sessions, "session-missing-receipt", {
        id: "session-missing-receipt",
        project: "project",
        cwd: "/tmp/project",
        startedAt: "2026-07-24T00:00:00.000Z",
        status: "active",
        observationCount: 1,
      });
      await kv.set(KV.observations("session-missing-receipt"), "obs-1", {
        id: "obs-1",
        sessionId: "session-missing-receipt",
        timestamp: "2026-07-24T00:00:01.000Z",
        hookType: "user",
        userPrompt: "A recovered attempt must not create a replacement receipt.",
        raw: {},
        sourceEventIndex: 1,
      });

      const result = await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-missing-receipt"],
        attemptId: "attempt-missing-receipt",
        inputHash: "runner-session-freshness",
        requireExistingReceipt: true,
      });

      expect(result).toMatchObject({
        success: false,
        failure: {
          class: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
        },
      });
      expect(provider.compress).not.toHaveBeenCalled();
    });

    it("marks retryable provider failures as receipt-safe while keeping deterministic failures terminal", async () => {
      const providerFailure = new ProviderCallError("pi_stream_failed", {
        providerErrorCode: "timeout",
        statusCode: 200,
        elapsedMs: 60_000,
        inputChars: 120,
        maxOutputTokens: 4096,
        responseStarted: true,
        stopReason: "error",
      });
      const provider: MemoryProvider = {
        name: "mock-llm",
        compress: vi.fn()
          .mockRejectedValueOnce(providerFailure)
          .mockResolvedValueOnce(`
<lessons>
  <lesson confidence="0.8">
    <content>Retry only a receipt-safe provider failure.</content>
    <context>v2 lesson recovery</context>
    <tags><tag>retry</tag></tags>
  </lesson>
</lessons>`)
          .mockResolvedValue("<not-lessons />"),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);
      registerExtractionOperationReceiptFunctions(sdk as never, kv as never);
      for (const sessionId of ["session-provider-retry", "session-parse-failure"]) {
        await kv.set(KV.sessions, sessionId, {
          id: sessionId,
          project: "project",
          cwd: "/tmp/project",
          startedAt: "2026-07-28T00:00:00.000Z",
          status: "active",
          observationCount: 1,
        });
        await kv.set(KV.observations(sessionId), "obs-1", {
          id: "obs-1",
          sessionId,
          timestamp: "2026-07-28T00:00:01.000Z",
          hookType: "user",
          userPrompt: "Operational test input.",
          raw: {},
          sourceEventIndex: 1,
        });
      }

      const retryable = await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-provider-retry"],
        attemptId: "attempt-provider-retry",
        inputHash: "runner-provider-retry",
      });
      expect(retryable).toMatchObject({
        success: false,
        failure: {
          class: "transient_provider",
          cause: "timeout",
          phase: "provider_call",
        },
      });
      const retryReceipt = await sdk.trigger("mem::extraction-operation-receipt-get", {
        runId: "attempt-provider-retry",
        stage: "lessons",
        unitId: "session-provider-retry",
      });
      expect(retryReceipt).toMatchObject({
        receipt: {
          status: "failed",
          retry: {
            epoch: 0,
            lastSafeFailure: {
              errorClass: "transient_provider",
              cause: "timeout",
              phase: "provider_call",
            },
          },
        },
      });
      const resumed = await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-provider-retry"],
        attemptId: "attempt-provider-retry",
        inputHash: "runner-provider-retry",
        requireExistingReceipt: true,
      });
      expect(resumed).toMatchObject({
        success: true,
        runs: [{ status: "succeeded" }],
      });

      const deterministic = await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-parse-failure"],
        attemptId: "attempt-parse-failure",
        inputHash: "runner-parse-failure",
      });
      expect(deterministic).toMatchObject({
        success: false,
        failure: {
          class: "unit",
          cause: "lesson_missing_root",
        },
      });
      expect(deterministic).not.toHaveProperty("retryableReceiptFailure");
    });

    it("reopens a legacy failed receipt only with matching zero-result lesson evidence", async () => {
      const xml = `
<lessons>
  <lesson confidence="0.8">
    <content>Resume only from verified zero-result evidence.</content>
    <context>v2 lesson recovery</context>
    <tags><tag>receipt</tag></tags>
  </lesson>
</lessons>`;
      const provider: MemoryProvider = {
        name: "mock-llm",
        compress: vi.fn(async () => xml),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);
      registerExtractionOperationReceiptFunctions(sdk as never, kv as never);
      const sessionId = "session-legacy-retry";
      const attemptId = "f".repeat(64);
      const runnerInputHash = "a".repeat(64);
      const failedAt = "2026-07-28T16:23:40.115Z";
      const observation = {
        id: "obs-1",
        sessionId,
        timestamp: "2026-07-28T16:22:00.000Z",
        hookType: "user",
        userPrompt: "Operational test input.",
        raw: {},
        sourceEventIndex: 1,
      };
      await kv.set(KV.sessions, sessionId, {
        id: sessionId,
        project: "project",
        cwd: "/tmp/project",
        startedAt: "2026-07-28T16:22:00.000Z",
        status: "active",
        observationCount: 1,
      });
      await kv.set(KV.observations(sessionId), observation.id, observation);
      const config = resolveLlmLessonExtractionRuntimeConfig(provider);
      const serviceInputHash = computeLessonExtractionInputHash([observation]);
      const configHash = computeLessonExtractionConfigHash(config);
      const runId = runIdForSession(sessionId, serviceInputHash, configHash);
      await kv.set(KV.lessonExtractionRuns, runId, {
        id: runId,
        sessionId,
        project: "project",
        strategy: "llm",
        status: "retryable",
        inputHash: serviceInputHash,
        configHash,
        providerName: provider.name,
        config,
        attempts: 1,
        createdLessonIds: [],
        replacedLessonIds: [],
        failureDiagnostics: {
          requestPhase: "chunk",
          providerErrorCode: "timeout",
          statusCode: 200,
          elapsedMs: 60_002,
          inputChars: 120,
          maxOutputTokens: 4096,
          responseStarted: true,
          stopReason: "error",
        },
        createdAt: "2026-07-28T16:22:40.093Z",
        updatedAt: failedAt,
        startedAt: "2026-07-28T16:22:40.100Z",
        finishedAt: failedAt,
      });
      const receiptIdentity = {
        runId: attemptId,
        stage: "lessons" as const,
        unitId: sessionId,
        inputHash: stableHash({
          runnerInputHash,
          serviceInputHash,
          configHash,
        }),
      };
      const receiptKey = buildExtractionOperationKey(receiptIdentity);
      await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
        ...receiptIdentity,
        key: receiptKey,
        status: "failed",
        startedAt: "2026-07-28T16:22:40.100Z",
        completedAt: "2026-07-28T16:23:40.116Z",
        failure: {
          class: "transient_provider",
          cause: "lesson_extraction_failed",
        },
      });
      const authorization = {
        receiptInputHash: receiptIdentity.inputHash,
        retryEpoch: 0,
        failureClass: "transient_provider",
        failureCause: "lesson_extraction_failed",
        failurePhase: "provider_call",
        lastSafeFailure: {
          errorClass: "transient_provider",
          cause: "lesson_extraction_failed",
          phase: "provider_call",
          timestamp: failedAt,
        },
      };
      const lessonRunEvidence = {
        status: "retryable",
        inputHash: serviceInputHash,
        configHash,
        failureCause: "timeout",
        failurePhase: "provider_call",
        failedAt,
        createdLessonCount: 0,
        replacedLessonCount: 0,
        chunkLessonCount: 0,
      };

      const resumed = await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: [sessionId],
        attemptId,
        inputHash: runnerInputHash,
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization: authorization,
        failedLessonRunEvidence: lessonRunEvidence,
      });

      expect(resumed).toMatchObject({
        success: true,
        runs: [{ status: "succeeded" }],
      });
      expect(provider.compress).toHaveBeenCalledTimes(1);
      expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey)).toMatchObject({
        status: "succeeded",
        retry: { epoch: 1 },
      });
    });

    it("uses explicit model in lesson runtime config and provider call options", async () => {
      const xml = `
<lessons>
  <lesson confidence=\"0.72\">
    <content>Always validate stage model routing before recording extraction state.</content>
    <context>full extraction lesson model override</context>
    <tags><tag>agentmemory</tag></tags>
  </lesson>
</lessons>`;
      const provider: MemoryProvider = {
        name: "pi-agent-sdk",
        compress: vi.fn(async () => xml),
        summarize: vi.fn(async () => ""),
      };
      registerLessonsFunctions(sdk as never, kv as never, provider);

      await kv.set(KV.sessions, "session-model", {
        id: "session-model",
        project: "project",
        cwd: "/tmp/project",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        observationCount: 1,
      });
      await kv.set(KV.observations("session-model"), "obs-1", {
        id: "obs-1",
        sessionId: "session-model",
        timestamp: "2026-01-01T00:00:01.000Z",
        hookType: "user",
        userPrompt: "Remember to verify the actual lesson provider call, not only state metadata.",
        raw: {},
        sourceEventIndex: 1,
      });

      const result = (await sdk.trigger("mem::lessons::extract-llm", {
        sessionIds: ["session-model"],
        force: true,
        model: " lesson-model ",
        textLimit: 1200,
        saveLimit: 10,
        chunkSize: 20,
        chunkConcurrency: 1,
        timeoutMs: 1000,
      })) as {
        success: boolean;
        runs: Array<{
          status: string;
          config: { model?: string; modelSource?: string };
        }>;
      };

      expect(result.success).toBe(true);
      expect(result.runs[0].status).toBe("succeeded");
      expect(result.runs[0].config.model).toBe("lesson-model");
      expect(result.runs[0].config.modelSource).toBe("explicitModel");
      expect(provider.compress).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          model: "lesson-model",
          modelSource: "explicitModel",
        }),
      );
    });
  });
});
