import { describe, expect, it, vi } from "vitest";
import { bindLessonExtractionGeneration } from "../src/functions/lesson-extraction-generation.js";
import { LessonExtractionGenerationConflictError } from "../src/functions/lesson-extraction-generation.js";
import { lessonCandidateOperationIdentityHash, stageLessonCandidates } from "../src/functions/lesson-candidate-staging.js";
import { applySessionLessonDelta } from "../src/functions/lesson-commit.js";
import { proveLegacyLessonNoBlocksZeroEffect } from "../src/functions/legacy-lesson-zero-effect-proof.js";
import { KV } from "../src/state/schema.js";
import type { LessonExtractionRun, MemoryProvider } from "../src/types.js";
import { enqueueLlmLessonExtractionRun, processLlmLessonExtractionRun, resolveLlmLessonExtractionRuntimeConfig } from "../src/functions/lesson-extraction-runs.js";
import { mockKV } from "./helpers/mocks.js";

function run(id: string, sessionId = "session-1"): LessonExtractionRun {
  return {
    id,
    sessionId,
    project: "/repo",
    strategy: "llm",
    status: "pending",
    inputHash: "a".repeat(64),
    configHash: "b".repeat(64),
    providerName: "mock",
    config: { textLimit: 1, saveLimit: 1, chunkSize: 1, chunkConcurrency: 1, timeoutMs: 1 },
    attempts: 0,
    createdLessonIds: [],
    replacedLessonIds: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

describe("lesson extraction recovery state", () => {
  it("allocates immutable session generations and reconstructs a missing registry without reuse", async () => {
    const kv = mockKV();
    const first = run("run-1");
    await kv.set(KV.lessonExtractionRuns, first.id, first);
    const boundFirst = await bindLessonExtractionGeneration(kv, first);
    expect(boundFirst.extractionGeneration).toBe(1);

    await kv.delete(KV.lessonExtractionGeneration(first.sessionId), first.sessionId);
    const second = run("run-2");
    await kv.set(KV.lessonExtractionRuns, second.id, second);
    const boundSecond = await bindLessonExtractionGeneration(kv, second);
    expect(boundSecond.extractionGeneration).toBe(2);
    expect((await bindLessonExtractionGeneration(kv, boundFirst)).extractionGeneration).toBe(1);
  });

  it("uses only the target session watermark when allocating a generation", async () => {
    const kv = mockKV();
    await kv.set(KV.lessons, "shared", {
      id: "shared", content: "redacted", context: "redacted", confidence: 0.5, reinforcements: 0,
      source: "llm", sourceIds: ["session-1", "session-2"], tags: [], createdAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z", decayRate: 0.05,
      sourceWatermarks: { "session-1": { generation: 2, mutationId: "m1" }, "session-2": { generation: 99, mutationId: "m2" } },
    });
    const target = run("run-watermark");
    await kv.set(KV.lessonExtractionRuns, target.id, target);
    expect((await bindLessonExtractionGeneration(kv, target)).extractionGeneration).toBe(3);
  });

  it("serializes run binding with watermark commits so a generation is never reused", async () => {
    const kv = mockKV();
    const target = run("run-concurrent-watermark");
    await kv.set(KV.lessonExtractionRuns, target.id, target);
    let releaseWatermarkWrite!: () => void;
    const watermarkWriteReleased = new Promise<void>((resolve) => {
      releaseWatermarkWrite = resolve;
    });
    let watermarkWriteStarted!: () => void;
    const watermarkWriteObserved = new Promise<void>((resolve) => {
      watermarkWriteStarted = resolve;
    });
    let pauseWatermarkWrite = true;
    const controlledKV = {
      ...kv,
      set: async <T>(scope: string, key: string, value: T): Promise<T> => {
        if (pauseWatermarkWrite && scope === KV.lessons && key === "lesson-concurrent-watermark") {
          pauseWatermarkWrite = false;
          watermarkWriteStarted();
          await watermarkWriteReleased;
        }
        return kv.set(scope, key, value);
      },
    };
    const delta = {
      lessonId: "lesson-concurrent-watermark",
      sessionId: target.sessionId,
      generation: 1,
      mutationId: "mutation-concurrent-watermark",
      sourceRunId: "prior-run",
      appliedAt: "2026-07-29T00:00:00.000Z",
      fallbackContext: "",
      removeHeuristicSource: false,
      candidate: {
        content: "concurrent watermark",
        context: "",
        confidence: 0.8,
        importance: 0.8,
        tags: [],
        evidence: "",
        source: "llm" as const,
      },
    };

    const watermarkCommit = applySessionLessonDelta(controlledKV, delta);
    await watermarkWriteObserved;
    const binding = bindLessonExtractionGeneration(controlledKV, target);
    releaseWatermarkWrite();

    expect(await watermarkCommit).toBe("applied");
    expect((await binding).extractionGeneration).toBe(2);
  });

  it("rejects an old watermark commit after the generation was bound to another run", async () => {
    const kv = mockKV();
    const target = run("run-bound-before-old-commit");
    await kv.set(KV.lessonExtractionRuns, target.id, target);
    const bound = await bindLessonExtractionGeneration(kv, target);
    expect(bound.extractionGeneration).toBe(1);
    const delta = {
      lessonId: "lesson-old-generation",
      sessionId: target.sessionId,
      generation: 1,
      mutationId: "mutation-old-generation",
      sourceRunId: "superseded-run",
      appliedAt: "2026-07-29T00:00:00.000Z",
      fallbackContext: "",
      removeHeuristicSource: false,
      candidate: {
        content: "old generation",
        context: "",
        confidence: 0.8,
        importance: 0.8,
        tags: [],
        evidence: "",
        source: "llm" as const,
      },
    };

    await expect(applySessionLessonDelta(kv, delta))
      .rejects.toBeInstanceOf(LessonExtractionGenerationConflictError);
    expect(await kv.get(KV.lessons, delta.lessonId)).toBeNull();
    expect(await applySessionLessonDelta(kv, {
      ...delta,
      sourceRunId: bound.id,
    })).toBe("applied");
  });

  it("fails closed when one generation is bound to two lesson runs", async () => {
    const kv = mockKV();
    const first = { ...run("run-1"), extractionGeneration: 1 };
    const second = { ...run("run-2"), extractionGeneration: 1 };
    await kv.set(KV.lessonExtractionRuns, first.id, first);
    await kv.set(KV.lessonExtractionRuns, second.id, second);
    await expect(bindLessonExtractionGeneration(kv, first)).rejects.toBeInstanceOf(
      LessonExtractionGenerationConflictError,
    );
  });

  it("fails closed on mutation and registry identity conflicts", async () => {
    const kv = mockKV();
    const delta = {
      lessonId: "lesson-conflict",
      sessionId: "session-1",
      generation: 1,
      mutationId: "mutation-1",
      sourceRunId: "run-1",
      appliedAt: "2026-07-29T00:00:00.000Z",
      fallbackContext: "",
      removeHeuristicSource: false,
      candidate: {
        content: "identity conflict",
        context: "",
        confidence: 0.8,
        importance: 0.8,
        tags: [],
        evidence: "",
        source: "llm" as const,
      },
    };
    expect(await applySessionLessonDelta(kv, delta)).toBe("applied");
    await expect(applySessionLessonDelta(kv, {
      ...delta,
      mutationId: "mutation-2",
    })).rejects.toThrow("lesson_watermark_conflict");

    const first = { ...run("registry-run-1"), extractionGeneration: 2 };
    const second = { ...run("registry-run-2"), extractionGeneration: 2 };
    await kv.set(KV.lessonExtractionRuns, first.id, first);
    await kv.set(KV.lessonExtractionRuns, second.id, second);
    await expect(bindLessonExtractionGeneration(kv, first)).rejects.toBeInstanceOf(
      LessonExtractionGenerationConflictError,
    );
  });

  it("keeps the allocated generation across registry and run-binding response losses", async () => {
    const kv = mockKV();
    const registryWriteRun = run("registry-write");
    await kv.set(KV.lessonExtractionRuns, registryWriteRun.id, registryWriteRun);
    let loseRegistryResponse = true;
    const loseRegistryWriteResponse = {
      ...kv,
      set: async <T>(scope: string, key: string, value: T): Promise<T> => {
        const persisted = await kv.set(scope, key, value);
        if (loseRegistryResponse && scope === KV.lessonExtractionGeneration(registryWriteRun.sessionId)) {
          loseRegistryResponse = false;
          throw new Error("response_lost_after_registry_write");
        }
        return persisted;
      },
    };
    await expect(bindLessonExtractionGeneration(loseRegistryWriteResponse as never, registryWriteRun)).rejects.toThrow(
      "response_lost_after_registry_write",
    );
    expect((await bindLessonExtractionGeneration(loseRegistryWriteResponse as never, registryWriteRun)).extractionGeneration).toBe(1);

    const runWriteRun = run("run-write");
    await kv.set(KV.lessonExtractionRuns, runWriteRun.id, runWriteRun);
    let loseRunResponse = true;
    const loseRunWriteResponse = {
      ...kv,
      set: async <T>(scope: string, key: string, value: T): Promise<T> => {
        const persisted = await kv.set(scope, key, value);
        if (loseRunResponse && scope === KV.lessonExtractionRuns && key === runWriteRun.id) {
          loseRunResponse = false;
          throw new Error("response_lost_after_run_binding_write");
        }
        return persisted;
      },
    };
    await expect(bindLessonExtractionGeneration(loseRunWriteResponse as never, runWriteRun)).rejects.toThrow(
      "response_lost_after_run_binding_write",
    );
    const persistedRun = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, runWriteRun.id);
    expect(persistedRun?.extractionGeneration).toBe(2);

    await kv.delete(KV.lessonExtractionGeneration(runWriteRun.sessionId), runWriteRun.sessionId);
    const successor = run("successor");
    await kv.set(KV.lessonExtractionRuns, successor.id, successor);
    expect((await bindLessonExtractionGeneration(kv, successor)).extractionGeneration).toBe(3);
  });

  it("rejects a supplied run that forges a generation over the persisted run", async () => {
    const kv = mockKV();
    const persisted = run("run-forged");
    await kv.set(KV.lessonExtractionRuns, persisted.id, persisted);
    await expect(bindLessonExtractionGeneration(kv, { ...persisted, extractionGeneration: 9 })).rejects.toBeInstanceOf(
      LessonExtractionGenerationConflictError,
    );
  });

  it("stages candidate payloads idempotently and rejects changed candidate effects", async () => {
    const kv = mockKV();
    const baseInput = {
      runId: "run-1", sessionId: "session-1", generation: 1,
      inputHash: "a".repeat(64), configHash: "b".repeat(64), unitId: "session-1",
      attemptId: "attempt-1",
    };
    const input = {
      ...baseInput,
      operationIdentityHash: lessonCandidateOperationIdentityHash(baseInput),
      candidates: [{ content: "stage before commit", context: "test", confidence: 0.8, importance: 0.8, tags: [], evidence: "", source: "llm" as const }],
    };
    const [first, repeated] = await Promise.all([
      stageLessonCandidates(kv, input),
      stageLessonCandidates(kv, input),
    ]);
    expect(repeated).toEqual(first);
    await expect(stageLessonCandidates(kv, { ...input, candidates: [] })).rejects.toThrow(
      "lesson_candidate_staging_conflict",
    );
    const secondBase = { ...baseInput, attemptId: "attempt-2" };
    const secondAttempt = await stageLessonCandidates(kv, { ...input, ...secondBase, operationIdentityHash: lessonCandidateOperationIdentityHash(secondBase) });
    expect(secondAttempt.id).not.toBe(first.id);
  });

  it("proves lesson_no_blocks only from closed zero-effect facts without leaking content", () => {
    const result = proveLegacyLessonNoBlocksZeroEffect({
      lessonRun: { ...run("run-1"), status: "retryable", finishedAt: "2026-07-29T00:01:00.000Z" },
      receipt: { key: "receipt-1", runId: "attempt-1", stage: "lessons", unitId: "session-1", inputHash: "c".repeat(64), status: "failed", startedAt: "2026-07-29T00:00:00.000Z", failure: { class: "unit", cause: "lesson_no_blocks" } },
      chunks: [], formalLessons: [],
      expected: { lessonRunId: "run-1", receiptKey: "receipt-1", sessionId: "session-1", runInputHash: "a".repeat(64), receiptInputHash: "c".repeat(64), configHash: "b".repeat(64) },
    });
    expect(result.proof).toMatchObject({ kind: "legacy_lessons_zero_effect", chunkLessonCount: 0 });
    expect(JSON.stringify(result)).not.toContain("content");
    expect(proveLegacyLessonNoBlocksZeroEffect({
      lessonRun: { ...run("run-1"), finishedAt: "2026-07-29T00:01:00.000Z", createdLessonIds: ["lesson-1"] },
      receipt: { key: "receipt-1", runId: "attempt-1", stage: "lessons", unitId: "session-1", inputHash: "c".repeat(64), status: "failed", startedAt: "2026-07-29T00:00:00.000Z", failure: { class: "unit", cause: "lesson_no_blocks" } },
      chunks: [], formalLessons: [],
      expected: { lessonRunId: "run-1", receiptKey: "receipt-1", sessionId: "session-1", runInputHash: "a".repeat(64), receiptInputHash: "c".repeat(64), configHash: "b".repeat(64) },
    }).proof).toBeUndefined();
  });

  it("recovers an already persisted candidate staging without another provider call", async () => {
    const base = mockKV();
    const sessionId = "session-staging-recovery";
    await base.set(KV.sessions, sessionId, { id: sessionId, project: "/repo", cwd: "/repo", startedAt: "2026-07-29T00:00:00.000Z", status: "active", observationCount: 1 });
    await base.set(KV.observations(sessionId), "obs-1", { id: "obs-1", sessionId, sourceEventIndex: 1, timestamp: "2026-07-29T00:00:00.000Z", hookType: "prompt_submit", raw: {}, userPrompt: "Remember this staging recovery test." });
    const provider: MemoryProvider = { name: "mock", compress: vi.fn(async () => "<lessons><lesson confidence=\"0.8\"><content>stage before commit</content><context>test</context></lesson></lessons>"), summarize: vi.fn(async () => "") };
    const config = resolveLlmLessonExtractionRuntimeConfig(provider, {});
    const pending = await enqueueLlmLessonExtractionRun({ kv: base, sessionId, config });
    let loseStagingResponse = true;
    const kv = {
      ...base,
      set: async <T>(scope: string, key: string, value: T): Promise<T> => {
        const result = await base.set(scope, key, value);
        if (loseStagingResponse && scope === KV.lessonExtractionCandidates(pending.id)) {
          loseStagingResponse = false;
          throw new Error("response_lost_after_staging_set");
        }
        return result;
      },
    };
    await expect(processLlmLessonExtractionRun({ kv: kv as never, provider, runId: pending.id, attemptId: "attempt-staging" })).rejects.toThrow("response_lost_after_staging_set");
    const recovered = await processLlmLessonExtractionRun({ kv: kv as never, provider, runId: pending.id, attemptId: "attempt-staging" });
    expect(recovered.candidateStagingId).toBeDefined();
    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(await base.list(KV.lessons)).toEqual([]);
  });
});
