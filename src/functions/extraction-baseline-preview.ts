import type {
  AdoptedBaselineCoverageRecord,
  AdoptedBaselineLessonSeedRecord,
  AdoptedBaselineStage,
  CompressedObservation,
  Lesson,
  RawObservation,
  Session,
  SessionSummary,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  MEMORY_CONSOLIDATE_CONTRACT_VERSION,
  memoryConsolidationSessionSnapshotHash,
} from "./consolidate.js";
import {
  computeLessonExtractionInputHash,
  stableHash,
} from "./lesson-extraction-runs.js";
import { LESSONS_CONTRIBUTION_CONTRACT } from "./lessons.js";
import {
  buildReflectInsightSourceVersion,
  enqueueReflectInsightBacklog,
} from "./reflect.js";
import {
  SEMANTIC_ROLLUP_CONTRIBUTION_CONTRACT,
  summaryContentHash,
} from "./semantic-rollup.js";
import {
  buildSkillExtractionSourceVersion,
  SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
} from "./skill-extract.js";
import {
  resumableSummaryInputHash,
  SUMMARY_CONTRIBUTION_CONTRACT,
} from "./summarize.js";

export const ADOPTED_BASELINE_STAGE_CONTRACTS: Record<AdoptedBaselineStage, string> = {
  summary: SUMMARY_CONTRIBUTION_CONTRACT,
  lessons: LESSONS_CONTRIBUTION_CONTRACT,
  memory_consolidate: MEMORY_CONSOLIDATE_CONTRACT_VERSION,
  semantic_rollup: SEMANTIC_ROLLUP_CONTRIBUTION_CONTRACT,
  skill_extract: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  project: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    results.push(...await Promise.all(items.slice(offset, offset + concurrency).map(project)));
  }
  return results;
}

async function sessionCoverageHash(
  kv: StateKV,
  stage: AdoptedBaselineStage,
  sessionId: string,
): Promise<string> {
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (!session) throw new Error(`adopted_baseline_session_missing:${sessionId}`);
  if (stage === "lessons") {
    const observations = await kv.list<RawObservation>(KV.observations(sessionId));
    return computeLessonExtractionInputHash(observations);
  }
  if (stage === "semantic_rollup") {
    const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
    return stableHash({
      sessionId,
      summaryHash: summary ? summaryContentHash(summary) : null,
    });
  }
  const observations = await kv.list<CompressedObservation>(KV.observations(sessionId));
  if (stage === "summary") return resumableSummaryInputHash(session, observations);
  if (stage === "memory_consolidate") {
    return memoryConsolidationSessionSnapshotHash(observations);
  }
  const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
  return summary
    ? buildSkillExtractionSourceVersion(session, summary, observations).snapshotHash
    : stableHash({
        schema: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
        session,
        summary: null,
        observations,
      });
}

export async function buildAdoptedBaselineCoverageRecords(
  kv: StateKV,
  input: { baselineId: string; stage: AdoptedBaselineStage; sessionIds: string[] },
): Promise<AdoptedBaselineCoverageRecord[]> {
  if (
    input.sessionIds.length === 0
    || input.sessionIds.length > 100
    || new Set(input.sessionIds).size !== input.sessionIds.length
    || input.sessionIds.some((sessionId) => !sessionId.trim())
  ) {
    throw new Error("invalid_adopted_baseline_preview_sessions");
  }
  const hashes = await mapWithConcurrency(
    input.sessionIds,
    8,
    (sessionId) => sessionCoverageHash(kv, input.stage, sessionId),
  );
  return input.sessionIds.map((sessionId, index) => ({
    baselineId: input.baselineId,
    stage: input.stage,
    stageContractVersion: ADOPTED_BASELINE_STAGE_CONTRACTS[input.stage],
    sessionId,
    normalizedContentHash: hashes[index],
  }));
}

export async function buildAdoptedBaselineLessonSeedRecords(
  kv: StateKV,
  input: { baselineId: string; lessonIds: string[] },
): Promise<AdoptedBaselineLessonSeedRecord[]> {
  if (
    input.lessonIds.length === 0
    || input.lessonIds.length > 100
    || new Set(input.lessonIds).size !== input.lessonIds.length
    || input.lessonIds.some((lessonId) => !lessonId.trim())
  ) {
    throw new Error("invalid_adopted_baseline_preview_lessons");
  }
  const lessons = await mapWithConcurrency(
    input.lessonIds,
    32,
    (lessonId) => kv.get<Lesson>(KV.lessons, lessonId),
  );
  return lessons.map((lesson, index) => {
    if (!lesson || lesson.deleted) {
      throw new Error(`adopted_baseline_lesson_missing:${input.lessonIds[index]}`);
    }
    const source = buildReflectInsightSourceVersion({ sourceType: "lesson", value: lesson });
    return {
      baselineId: input.baselineId,
      lessonId: lesson.id,
      sourceVersionKey: source.sourceVersionKey,
      normalizedContentHash: source.snapshotHash,
    };
  });
}

export async function materializeAdoptedBaselineLessonSeeds(
  kv: StateKV,
  records: AdoptedBaselineLessonSeedRecord[],
): Promise<void> {
  for (const record of records) {
    const lesson = await kv.get<Lesson>(KV.lessons, record.lessonId);
    if (!lesson || lesson.deleted) throw new Error("adopted_baseline_lesson_seed_drift");
    const source = buildReflectInsightSourceVersion({ sourceType: "lesson", value: lesson });
    if (
      source.sourceVersionKey !== record.sourceVersionKey
      || source.snapshotHash !== record.normalizedContentHash
    ) {
      throw new Error("adopted_baseline_lesson_seed_drift");
    }
    const handoff = await enqueueReflectInsightBacklog({
      kv,
      lessonIds: [lesson.id],
    });
    if (handoff.ineligible.length > 0 || handoff.enqueued.length + handoff.terminal.length !== 1) {
      throw new Error("adopted_baseline_lesson_seed_materialization_failed");
    }
  }
}
