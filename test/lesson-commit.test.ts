import { describe, expect, it, vi } from "vitest";
import { applySessionLessonDelta, buildSessionLessonDeltas, executeLessonCommitPlan, freezeLessonCommitPlan, reconcileLessonCommit } from "../src/functions/lesson-commit.js";
import { replaceSessionHeuristicLessons } from "../src/functions/lesson-extraction-runs.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { KV, fingerprintId } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function staging(candidates: any[] = []) {
  return { id: "lcs_run_1", runId: "run", sessionId: "session", unitId: "session", attemptId: "attempt", generation: 2,
    inputHash: "a".repeat(64), configHash: "b".repeat(64), operationIdentityHash: "c".repeat(64), candidateHash: "d".repeat(64), candidates, createdAt: "2026-01-01T00:00:00.000Z" } as any;
}
describe("lesson commit", () => {
  it("does not remove heuristics for an empty candidate staging", () => {
    expect(buildSessionLessonDeltas(staging(), [{ id:"x", content:"x", context:"", confidence:.4, reinforcements:0, source:"heuristic", origin:"replay-import-heuristic", sourceIds:["session"], tags:[], createdAt:"",updatedAt:"",decayRate:.05 } as any], { appliedAt: "2026-01-01T00:00:00.000Z" })).toEqual([]);
  });
  it("targets an existing legacy manual lesson with the same normalized content", () => {
    const legacyId = fingerprintId("lsn", "shared lesson");
    const deltas = buildSessionLessonDeltas(
      staging([{ content:"Shared   Lesson", context:"", confidence:.8, importance:.8, tags:[], evidence:"", source:"llm" }]),
      [{
        id:legacyId, content:"Shared Lesson", context:"", confidence:.4, reinforcements:0,
        source:"manual", sourceIds:[], tags:[], createdAt:"", updatedAt:"", decayRate:.05,
      }],
      { appliedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0].lessonId).toBe(legacyId);
  });
  it("rejects duplicate identities for the same normalized content", () => {
    const duplicate = (id: string) => ({
      id, content:"Same Lesson", context:"", confidence:.4, reinforcements:0,
      source:"manual" as const, sourceIds:[], tags:[], createdAt:"", updatedAt:"", decayRate:.05,
    });
    expect(() => buildSessionLessonDeltas(
      staging([{ content:"same   lesson", context:"", confidence:.8, importance:.8, tags:[], evidence:"", source:"llm" }]),
      [duplicate("lesson-a"), duplicate("lesson-b")],
      { appliedAt: "2026-01-01T00:00:00.000Z" },
    )).toThrow("lesson_identity_conflict");
  });
  it("applies, replays and rejects conflicting watermarks", async () => {
    const kv = mockKV();
    const delta: any = { lessonId:"lesson", sessionId:"session", generation:2, mutationId:"mutation", sourceRunId:"run", appliedAt:"2026-01-01T00:00:00.000Z", fallbackContext:"", removeHeuristicSource:false, candidate:{content:"lesson",context:"",confidence:.8,importance:.8,tags:["x"],evidence:"",source:"llm"} };
    expect(await applySessionLessonDelta(kv as never, delta)).toBe("applied");
    expect(await applySessionLessonDelta(kv as never, delta)).toBe("replayed");
    await expect(applySessionLessonDelta(kv as never, { ...delta, mutationId:"other" })).rejects.toThrow("lesson_watermark_conflict");
  });
  it("uses the frozen time, project and fallback context when creating a lesson", async () => {
    const kv = mockKV();
    const plan = await freezeLessonCommitPlan(kv as never, {
      staging: staging([{ content:"lesson", context:"", confidence:.8, importance:.8, tags:["x"], evidence:"", source:"llm" }]),
      appliedAt: "2026-02-03T04:05:06.000Z",
      project: "project-a",
      fallbackContext: "fallback context",
    });

    await executeLessonCommitPlan(kv as never, plan);

    const lesson: any = await kv.get(KV.lessons, plan.deltas[0].lessonId);
    expect(lesson).toMatchObject({
      context: "fallback context",
      project: "project-a",
      createdAt: "2026-02-03T04:05:06.000Z",
      updatedAt: "2026-02-03T04:05:06.000Z",
      sourceRunId: "run",
    });
  });
  it("upserts a same-lesson candidate before removing its heuristic source", async () => {
    const kv = mockKV();
    const content = "lesson shared by heuristic and llm";
    const id = fingerprintId("lesson", content);
    await kv.set(KV.lessons, id, {
      id, content, context:"old", confidence:.4, reinforcements:0,
      source:"heuristic", origin:"replay-import-heuristic", sourceIds:["session"], tags:["old"],
      project:"old-project", createdAt:"2025-01-01T00:00:00.000Z", updatedAt:"2025-01-01T00:00:00.000Z", decayRate:.05,
    });
    const plan = await freezeLessonCommitPlan(kv as never, {
      staging: staging([{ content, context:"new", confidence:.9, importance:.9, tags:["new"], evidence:"", source:"llm" }]),
      appliedAt: "2026-02-03T04:05:06.000Z", project: "project-a",
    });
    expect(plan.deltas).toHaveLength(1);
    expect(plan.deltas[0].removeHeuristicSource).toBe(true);

    await executeLessonCommitPlan(kv as never, plan);

    const lesson: any = await kv.get(KV.lessons, id);
    expect(lesson).toMatchObject({
      confidence: .9,
      reinforcements: 0,
      sourceIds: [],
      tags: ["old", "new"],
      project: "project-a",
      sourceRunId: "run",
      deleted: true,
      updatedAt: "2026-02-03T04:05:06.000Z",
    });
  });
  it("preserves a soft-deleted lesson and only applies an old delta once", async () => {
    const kv = mockKV();
    const initial: any = {
      id:"lesson", content:"lesson", context:"", confidence:.4, reinforcements:3,
      source:"manual", sourceIds:[], tags:["old"], project:"old-project", deleted:true,
      createdAt:"2025-01-01T00:00:00.000Z", updatedAt:"2025-01-01T00:00:00.000Z", decayRate:.05,
    };
    await kv.set(KV.lessons, initial.id, initial);
    const delta: any = { lessonId:"lesson", sessionId:"session", generation:2, mutationId:"mutation", sourceRunId:"run", appliedAt:"2026-01-01T00:00:00.000Z", project:"project-a", fallbackContext:"fallback", removeHeuristicSource:false, candidate:{content:"lesson",context:"",confidence:.8,importance:.8,tags:["new"],evidence:"",source:"llm"} };
    expect(await applySessionLessonDelta(kv as never, delta)).toBe("applied");
    const after: any = await kv.get(KV.lessons, "lesson");
    expect(after).toMatchObject({ deleted:true, confidence:.8, reinforcements:4, project:"project-a", context:"fallback", sourceRunId:"run" });

    after.context = "manual edit";
    after.confidence = .95;
    await kv.set(KV.lessons, after.id, after);
    expect(await applySessionLessonDelta(kv as never, delta)).toBe("replayed");
    expect(await kv.get(KV.lessons, after.id)).toMatchObject({ context:"manual edit", confidence:.95 });
  });
  it("serializes simultaneous candidate updates for the same lesson", async () => {
    const kv = mockKV();
    const base: any = { lessonId:"lesson", generation:2, sourceRunId:"run", appliedAt:"2026-01-01T00:00:00.000Z", fallbackContext:"", removeHeuristicSource:false };
    await Promise.all([
      applySessionLessonDelta(kv as never, { ...base, sessionId:"session-a", mutationId:"a", candidate:{content:"lesson",context:"",confidence:.6,importance:.6,tags:["a"],evidence:"",source:"llm"} }),
      applySessionLessonDelta(kv as never, { ...base, sessionId:"session-b", mutationId:"b", candidate:{content:"lesson",context:"",confidence:.9,importance:.9,tags:["b"],evidence:"",source:"llm"} }),
    ]);

    expect(await kv.get(KV.lessons, "lesson")).toMatchObject({
      confidence: .9,
      reinforcements: 1,
      sourceIds: expect.arrayContaining(["session-a", "session-b"]),
      tags: expect.arrayContaining(["a", "b"]),
    });
  });
  it("preserves the extraction watermark when manual, strengthen, decay and heuristic replacement share a lesson", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerLessonsFunctions(sdk as never, kv as never);
    const content = "Concurrent shared lesson";
    const id = fingerprintId("lesson", content.toLowerCase());
    await kv.set(KV.lessons, id, {
      id, content, context:"", confidence:.5, reinforcements:0,
      source:"heuristic", origin:"replay-import-heuristic", sourceIds:["session"], tags:[],
      createdAt:"2020-01-01T00:00:00.000Z", updatedAt:"2020-01-01T00:00:00.000Z", decayRate:.05,
    });
    const delta: any = {
      lessonId:id, sessionId:"session", generation:2, mutationId:"extraction-mutation", sourceRunId:"run",
      appliedAt:"2026-01-01T00:00:00.000Z", fallbackContext:"", removeHeuristicSource:true,
      candidate:{ content, context:"", confidence:.8, importance:.8, tags:["extracted"], evidence:"", source:"llm" },
    };

    const [manual, strengthened, decayed, replaced, applied] = await Promise.all([
      sdk.trigger("mem::lesson-save", { content }),
      sdk.trigger("mem::lesson-strengthen", { lessonId:id }),
      sdk.trigger("mem::lesson-decay-sweep", {}),
      replaceSessionHeuristicLessons(kv as never, "session"),
      applySessionLessonDelta(kv as never, delta),
    ]) as any[];

    expect(manual.success).toBe(true);
    expect(strengthened.success).toBe(true);
    expect(decayed.success).toBe(true);
    expect(Array.isArray(replaced)).toBe(true);
    expect(applied).toBe("applied");
    expect(await kv.get<any>(KV.lessons, id)).toMatchObject({
      tags:expect.arrayContaining(["extracted"]),
      sourceWatermarks:{ session:{ generation:2, mutationId:"extraction-mutation" } },
    });
  });
  it("resumes a frozen plan and accepts a higher watermark", async () => {
    const kv = mockKV();
    const plan = await freezeLessonCommitPlan(kv as never, { staging: staging([{content:"lesson",context:"",confidence:.8,importance:.8,tags:[],evidence:"",source:"llm"}]) });
    const receipt = await executeLessonCommitPlan(kv as never, plan);
    expect(receipt.status).toBe("committed");
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("committed");
    const lesson: any = await kv.get(KV.lessons, plan.deltas[0].lessonId);
    lesson.sourceWatermarks.session = { generation: 3, mutationId: "later" };
    await kv.set(KV.lessons, lesson.id, lesson);
    expect(await reconcileLessonCommit(kv as never, plan)).toBe("committed");
  });
});
