import type { ExtractionOperationReceipt, Lesson, LessonExtractionChunkRun, LessonExtractionRun } from "../types.js";

export interface LegacyLessonZeroEffectProof {
  kind: "legacy_lessons_zero_effect";
  lessonRunId: string;
  receiptKey: string;
  inputHash: string;
  configHash: string;
  createdLessonCount: 0;
  replacedLessonCount: 0;
  chunkLessonCount: 0;
  finishedAt: string;
}

export interface LegacyLessonZeroEffectProofResult {
  proof?: LegacyLessonZeroEffectProof;
  reasonCode: "legacy_lessons_zero_effect" | "legacy_lessons_effect_unknown";
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** 只读取安全操作事实；提示词、模型响应、经验正文均不参与 proof 或诊断。 */
export function proveLegacyLessonNoBlocksZeroEffect(input: {
  lessonRun: LessonExtractionRun | null | undefined;
  receipt: ExtractionOperationReceipt | null | undefined;
  chunks: LessonExtractionChunkRun[];
  formalLessons: Lesson[];
  expected: {
    lessonRunId: string;
    receiptKey: string;
    sessionId: string;
    runInputHash: string;
    receiptInputHash: string;
    configHash: string;
  };
}): LegacyLessonZeroEffectProofResult {
  const { lessonRun: run, receipt, chunks, formalLessons, expected } = input;
  const chunkLessonCount = chunks.reduce((count, chunk) => count + chunk.lessonIds.length, 0);
  const validFailure = receipt?.status === "failed"
    && receipt.failure?.class === "unit"
    && receipt.failure.cause === "lesson_no_blocks";
  const noFormalWrite = !formalLessons.some((lesson) => lesson.sourceRunId === expected.lessonRunId);
  if (
    !run || !receipt || !safeHash(expected.runInputHash) || !safeHash(expected.receiptInputHash) || !safeHash(expected.configHash)
    || run.id !== expected.lessonRunId || receipt.key !== expected.receiptKey
    || run.sessionId !== expected.sessionId || receipt.unitId !== expected.sessionId
    || receipt.stage !== "lessons" || receipt.inputHash !== expected.receiptInputHash
    || run.inputHash !== expected.runInputHash || run.configHash !== expected.configHash
    || !validFailure || !run.finishedAt || run.createdLessonIds.length !== 0
    || run.replacedLessonIds.length !== 0 || chunkLessonCount !== 0 || !noFormalWrite
    || chunks.some((chunk) => chunk.runId !== expected.lessonRunId || chunk.sessionId !== expected.sessionId)
  ) return { reasonCode: "legacy_lessons_effect_unknown" };
  return {
    proof: {
      kind: "legacy_lessons_zero_effect",
      lessonRunId: run.id,
      receiptKey: receipt.key,
      inputHash: run.inputHash,
      configHash: run.configHash,
      createdLessonCount: 0,
      replacedLessonCount: 0,
      chunkLessonCount: 0,
      finishedAt: run.finishedAt,
    },
    reasonCode: "legacy_lessons_zero_effect",
  };
}
