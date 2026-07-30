import { describe, expect, it } from "vitest";
import {
  LessonCommitConflictError,
  executeLessonCommitPlan,
  freezeLessonCommitPlan,
  reconcileLessonCommit,
} from "../src/functions/lesson-commit.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

function staging(candidates: any[], attemptId = "attempt") {
  return {
    id: `lcs_run_${attemptId}`, runId: "run", sessionId: "session", unitId: "session", attemptId,
    generation: 2, inputHash: "a".repeat(64), configHash: "b".repeat(64),
    operationIdentityHash: "c".repeat(64), candidateHash: "d".repeat(64), candidates,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as any;
}

function failAfterSet(kv: ReturnType<typeof mockKV>, scope: string, onCall = 1) {
  let calls = 0;
  return {
    ...kv,
    set: async <T>(actualScope: string, key: string, value: T): Promise<T> => {
      const result = await kv.set(actualScope, key, value);
      if (actualScope === scope && ++calls === onCall) throw new Error("response_lost");
      return result;
    },
  };
}

function failBeforeSet(kv: ReturnType<typeof mockKV>, scope: string, onCall = 1) {
  let calls = 0;
  return {
    ...kv,
    set: async <T>(actualScope: string, key: string, value: T): Promise<T> => {
      if (actualScope === scope && ++calls === onCall) throw new Error("request_not_applied");
      return kv.set(actualScope, key, value);
    },
  };
}

async function planFor(kv: ReturnType<typeof mockKV>, candidates = ["one", "two"]) {
  return freezeLessonCommitPlan(kv as never, {
    staging: staging(candidates.map((content) => ({
      content, context: "", confidence: .8, importance: .8, tags: [content], evidence: "", source: "llm",
    }))),
    appliedAt: "2026-02-03T04:05:06.000Z",
  });
}

async function persistedLessonEffects(
  kv: ReturnType<typeof mockKV>,
  plan: Awaited<ReturnType<typeof planFor>>,
) {
  return Promise.all(plan.deltas.map(async (delta) => {
    const lesson: any = await kv.get(KV.lessons, delta.lessonId);
    return {
      id: lesson?.id,
      confidence: lesson?.confidence,
      reinforcements: lesson?.reinforcements,
      sourceIds: lesson?.sourceIds,
      tags: lesson?.tags,
      deleted: lesson?.deleted,
      sourceWatermarks: lesson?.sourceWatermarks,
    };
  }));
}

function deterministicOrder(length: number, seed = 0x5eed) {
  const order = Array.from({ length }, (_, index) => index);
  let state = seed;
  for (let index = order.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

describe("lesson commit recovery", () => {
  it("freezes one deterministic plan under concurrent duplicate requests", async () => {
    const kv = mockKV();
    const input = staging([{ content:"candidate", context:"", confidence:.8, importance:.8, tags:[], evidence:"", source:"llm" }]);

    const [first, repeated] = await Promise.all([
      freezeLessonCommitPlan(kv as never, {
        staging: input,
        appliedAt: "2026-01-01T00:00:00.000Z",
      }),
      freezeLessonCommitPlan(kv as never, {
        staging: input,
        appliedAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);

    expect(repeated).toEqual(first);
  });

  it("preserves plan integrity through JSON persistence when project is absent", async () => {
    const kv = mockKV();
    const jsonKv = {
      ...kv,
      set: async <T>(scope: string, key: string, value: T): Promise<T> => (
        kv.set(scope, key, JSON.parse(JSON.stringify(value)) as T)
      ),
    };
    const input = staging([{
      content:"candidate", context:"", confidence:.8, importance:.8, tags:[], evidence:"", source:"llm",
    }]);

    const frozen = await freezeLessonCommitPlan(jsonKv as never, {
      staging: input,
      appliedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(frozen.deltas[0]).not.toHaveProperty("project");
    await expect(freezeLessonCommitPlan(jsonKv as never, {
      staging: input,
      appliedAt: "2099-01-01T00:00:00.000Z",
    })).resolves.toEqual(frozen);
  });

  it("returns an already frozen plan without rebuilding it from later time or live heuristics", async () => {
    const kv = mockKV();
    const input = staging([{ content:"candidate", context:"", confidence:.8, importance:.8, tags:[], evidence:"", source:"llm" }]);
    const frozen = await freezeLessonCommitPlan(kv as never, { staging: input, appliedAt:"2026-01-01T00:00:00.000Z" });
    await kv.set(KV.lessons, "heuristic", {
      id:"heuristic", content:"heuristic", context:"", confidence:.5, reinforcements:0,
      source:"heuristic", origin:"replay-import-heuristic", sourceIds:["session"], tags:[],
      createdAt:"2026-01-01T00:00:00.000Z", updatedAt:"2026-01-01T00:00:00.000Z", decayRate:.05,
    });

    const recovered = await freezeLessonCommitPlan(kv as never, { staging: input, appliedAt:"2099-01-01T00:00:00.000Z" });
    expect(recovered).toEqual(frozen);
    await expect(freezeLessonCommitPlan(kv as never, {
      staging: { ...input, candidateHash: "e".repeat(64) },
    })).rejects.toBeInstanceOf(LessonCommitConflictError);
  });

  it("recovers after the plan write response is lost and rejects a corrupted frozen plan", async () => {
    const kv = mockKV();
    const flaky = failAfterSet(kv, KV.lessonCommitPlans("run"));
    const input = staging([{ content:"candidate", context:"", confidence:.8, importance:.8, tags:[], evidence:"", source:"llm" }]);
    await expect(freezeLessonCommitPlan(flaky as never, { staging: input })).rejects.toThrow("response_lost");
    const frozen = await freezeLessonCommitPlan(flaky as never, { staging: input, appliedAt:"2099-01-01T00:00:00.000Z" });
    const corrupted: any = await kv.get(KV.lessonCommitPlans("run"), frozen.id);
    corrupted.deltas[0].mutationId = "corrupt";
    await kv.set(KV.lessonCommitPlans("run"), frozen.id, corrupted);
    await expect(freezeLessonCommitPlan(kv as never, { staging: input })).rejects.toBeInstanceOf(LessonCommitConflictError);
  });

  it.each([
    ["initial receipt", KV.lessonCommitReceipts("run"), 1],
    ["lesson", KV.lessons, 1],
    ["progress receipt", KV.lessonCommitReceipts("run"), 2],
    ["committed receipt", KV.lessonCommitReceipts("run"), 4],
  ])("resumes when the %s write response is lost", async (_name, scope, onCall) => {
    const kv = mockKV();
    const plan = await planFor(kv);
    const flaky = failAfterSet(kv, scope, onCall);
    await expect(executeLessonCommitPlan(flaky as never, plan)).rejects.toThrow("response_lost");
    const committed = await executeLessonCommitPlan(flaky as never, plan);
    expect(committed.status).toBe("committed");
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("committed");
  });

  it("rejects an unpersisted plan and a supplied plan that differs from the frozen record", async () => {
    const persistedKv = mockKV();
    const plan = await planFor(persistedKv);
    await expect(executeLessonCommitPlan(mockKV() as never, plan)).rejects.toBeInstanceOf(LessonCommitConflictError);
    await expect(executeLessonCommitPlan(persistedKv as never, { ...plan, createdAt:"2099-01-01T00:00:00.000Z" })).rejects.toBeInstanceOf(LessonCommitConflictError);
  });

  it("classifies receipt corruption, partial effects and formal facts strictly", async () => {
    const kv = mockKV();
    const plan = await planFor(kv);
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("not_committed");
    const receipt = await executeLessonCommitPlan(kv as never, plan);
    await kv.set(KV.lessonCommitReceipts(plan.runId), receipt.key, { ...receipt, status:"committing" as const });
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("resume_commit");
    await executeLessonCommitPlan(kv as never, plan);
    const first = plan.deltas[0];
    await kv.delete(KV.lessons, first.lessonId);
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("resume_commit");
    expect((await executeLessonCommitPlan(kv as never, plan)).status).toBe("committed");

    const partiallyPersisted: any = await kv.get(KV.lessons, first.lessonId);
    partiallyPersisted.sourceWatermarks = {};
    await kv.set(KV.lessons, first.lessonId, partiallyPersisted);
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("resume_commit");
    await executeLessonCommitPlan(kv as never, plan);
    expect((await kv.get<any>(KV.lessons, first.lessonId))?.sourceWatermarks?.session).toMatchObject({
      generation: first.generation,
      mutationId: first.mutationId,
    });

    const leading = { ...receipt, status:"committing" as const, appliedLessonIds:[first.lessonId] };
    await kv.set(KV.lessonCommitReceipts(plan.runId), receipt.key, leading);
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("resume_commit");
    await executeLessonCommitPlan(kv as never, plan);

    const restored: any = await kv.get(KV.lessons, first.lessonId);
    restored.sourceWatermarks.session.mutationId = "different";
    await kv.set(KV.lessons, first.lessonId, restored);
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("conflict");

    await kv.set(KV.lessonCommitReceipts(plan.runId), receipt.key, { ...receipt, appliedLessonIds:[first.lessonId] });
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("conflict");
  });

  it("does not turn backend read failures into a business conflict", async () => {
    const kv = mockKV();
    const plan = await planFor(kv);
    const failing = { ...kv, get: async () => { throw new Error("backend_down"); } };
    await expect(reconcileLessonCommit(failing as never, plan)).rejects.toThrow("backend_down");
  });

  it("matches the uninterrupted external effects across a deterministic fault-location matrix", async () => {
    const baselineKv = mockKV();
    const baselinePlan = await planFor(baselineKv);
    await executeLessonCommitPlan(baselineKv as never, baselinePlan);
    const baseline = await persistedLessonEffects(baselineKv, baselinePlan);
    const boundaries = [
      { name: "plan persisted", scope: KV.lessonCommitPlans("run"), onCall: 1, phase: "freeze", timing: "after" },
      { name: "initial receipt persisted", scope: KV.lessonCommitReceipts("run"), onCall: 1, phase: "execute", timing: "after" },
      { name: "before first business effect", scope: KV.lessons, onCall: 1, phase: "execute", timing: "before" },
      { name: "first business effect persisted", scope: KV.lessons, onCall: 1, phase: "execute", timing: "after" },
      { name: "before second business effect", scope: KV.lessons, onCall: 2, phase: "execute", timing: "before" },
      { name: "all business effects persisted", scope: KV.lessons, onCall: 2, phase: "execute", timing: "after" },
      { name: "progress receipt persisted", scope: KV.lessonCommitReceipts("run"), onCall: 2, phase: "execute", timing: "after" },
      { name: "committed receipt persisted", scope: KV.lessonCommitReceipts("run"), onCall: 4, phase: "execute", timing: "after" },
    ] as const;

    for (const index of deterministicOrder(boundaries.length)) {
      const boundary = boundaries[index];
      const kv = mockKV();
      const flaky = boundary.timing === "before"
        ? failBeforeSet(kv, boundary.scope, boundary.onCall)
        : failAfterSet(kv, boundary.scope, boundary.onCall);
      let plan: Awaited<ReturnType<typeof planFor>>;
      if (boundary.phase === "freeze") {
        await expect(planFor(flaky)).rejects.toThrow("response_lost");
        plan = await planFor(flaky);
      } else {
        plan = await planFor(kv);
        await expect(executeLessonCommitPlan(flaky as never, plan)).rejects.toThrow(
          boundary.timing === "before" ? "request_not_applied" : "response_lost",
        );
      }

      const recovered = await executeLessonCommitPlan(flaky as never, plan);
      expect(recovered.status, boundary.name).toBe("committed");
      expect(await reconcileLessonCommit(kv as never, plan), boundary.name).toBe("committed");
      expect(await persistedLessonEffects(kv, plan), boundary.name).toEqual(baseline);
    }
  });
});
