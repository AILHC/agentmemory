import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type {
  Lesson,
  LessonExtractionChunkRun,
  LessonExtractionRun,
  MemoryProvider,
} from "../types.js";
import {
  enqueueLlmLessonExtractionRun,
  listRunnableRuns,
  processLlmLessonExtractionRun,
  resolveLlmLessonExtractionRuntimeConfig,
} from "./lesson-extraction-runs.js";
import { recordAudit } from "./audit.js";

function reinforceLesson(lesson: Lesson): void {
  const now = new Date().toISOString();
  lesson.reinforcements++;
  lesson.confidence = Math.min(
    1.0,
    lesson.confidence + 0.1 * (1 - lesson.confidence),
  );
  lesson.lastReinforcedAt = now;
  lesson.updatedAt = now;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function parseLessonExtractionStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  const trimmed = status.trim();
  if (trimmed.length === 0) return undefined;

  const allowed = new Set([
    "pending",
    "running",
    "succeeded",
    "failed",
    "retryable",
    "skipped",
  ]);
  return allowed.has(trimmed) ? trimmed : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function isExpiredRunningRun(run: LessonExtractionRun, now = new Date()): boolean {
  if (run.status !== "running") return false;
  if (!run.runningLeaseUntil) return false;
  return new Date(run.runningLeaseUntil).getTime() <= now.getTime();
}

export function registerLessonsFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider?: MemoryProvider,
): void {
  sdk.registerFunction("mem::lesson-save", 
    async (data: {
      content: string;
      context?: string;
      confidence?: number;
      project?: string;
      tags?: string[];
      source?: "crystal" | "manual" | "consolidation" | "heuristic" | "llm";
      origin?: Lesson["origin"];
      sourceIds?: string[];
      sourceRunId?: string;
    }) => {
      if (!data.content?.trim()) {
        return { success: false, error: "content is required" };
      }

      const fp = fingerprintId("lsn", data.content.trim().toLowerCase());
      const existing = await kv.get<Lesson>(KV.lessons, fp);

      if (existing && !existing.deleted) {
        reinforceLesson(existing);
        if (data.context && !existing.context) {
          existing.context = data.context;
        }
        await kv.set(KV.lessons, existing.id, existing);

        try {
          await recordAudit(kv, "lesson_strengthen", "mem::lesson-save", [
            existing.id,
          ]);
        } catch {}

        return {
          success: true,
          action: "strengthened",
          lesson: existing,
        };
      }

      const confidence =
        typeof data.confidence === "number" &&
        data.confidence >= 0 &&
        data.confidence <= 1
          ? data.confidence
          : 0.5;

      const now = new Date().toISOString();
      const lesson: Lesson = {
        id: fp,
        content: data.content.trim(),
        context: data.context?.trim() || "",
        confidence,
        reinforcements: 0,
        source: data.source || "manual",
        origin: data.origin,
        sourceRunId: data.sourceRunId,
        sourceIds: data.sourceIds || [],
        project: data.project,
        tags: data.tags || [],
        createdAt: now,
        updatedAt: now,
        decayRate: 0.05,
      };

      await kv.set(KV.lessons, lesson.id, lesson);

      try {
        await recordAudit(kv, "lesson_save", "mem::lesson-save", [lesson.id]);
      } catch {}

      return { success: true, action: "created", lesson };
    },
  );

  sdk.registerFunction("mem::lessons::extract-llm",
    async (data: {
      sessionIds?: string[];
      missingOnly?: unknown;
      retryFailed?: unknown;
      force?: unknown;
      textLimit?: unknown;
      saveLimit?: unknown;
      chunkSize?: unknown;
      chunkConcurrency?: unknown;
      timeoutMs?: unknown;
    }) => {
      if (!provider) {
        return { success: false, error: "provider is required for lesson extraction" };
      }

      const sessionIds = parseStringArray(data.sessionIds);
      if (!sessionIds || sessionIds.length === 0) {
        return { success: false, error: "sessionIds is required and must be a non-empty string array" };
      }

      const missingOnly = parseBoolean(data.missingOnly);
      const retryFailed = parseBoolean(data.retryFailed);
      const force = parseBoolean(data.force);
      const config = resolveLlmLessonExtractionRuntimeConfig(provider, {
        textLimit: data.textLimit,
        saveLimit: data.saveLimit,
        chunkSize: data.chunkSize,
        chunkConcurrency: data.chunkConcurrency,
        timeoutMs: data.timeoutMs,
      });

      const runs: LessonExtractionRun[] = [];
      const now = new Date();

      for (const sessionId of sessionIds) {
        const baseRun = await enqueueLlmLessonExtractionRun({
          kv,
          sessionId,
          missingOnly: missingOnly ?? true,
          retryFailed: retryFailed ?? true,
          force: force ?? false,
          config,
        });

        if (
          baseRun.status === "pending" ||
          baseRun.status === "retryable" ||
          isExpiredRunningRun(baseRun, now)
        ) {
          runs.push(await processLlmLessonExtractionRun({ kv, provider, runId: baseRun.id }));
        } else {
          runs.push(baseRun);
        }
      }

      return { success: true, runs };
    },
  );

  sdk.registerFunction("mem::lessons::extract-process",
    async (data: { limit?: unknown }) => {
      if (!provider) {
        return { success: false, error: "provider is required for lesson extraction" };
      }

      const rawLimit = parsePositiveInteger(data.limit);
      if (typeof data.limit !== "undefined" && rawLimit === undefined) {
        return { success: false, error: "limit must be a positive integer" };
      }
      const limit = rawLimit ?? 1;
      const runs = await listRunnableRuns(kv, limit);
      const out: LessonExtractionRun[] = [];

      for (const run of runs) {
        out.push(await processLlmLessonExtractionRun({ kv, provider, runId: run.id }));
      }

      return { success: true, runs };
    },
  );

  sdk.registerFunction("mem::lessons::extract-runs",
    async (data: { sessionId?: unknown; status?: unknown; limit?: unknown }) => {
      const rawLimit = parsePositiveInteger(data.limit);
      if (typeof data.limit !== "undefined" && (rawLimit === undefined || rawLimit > 500)) {
        return { success: false, error: "limit must be between 1 and 500" };
      }
      const limit = rawLimit ?? 50;

      const status = parseLessonExtractionStatus(data.status);
      if (typeof data.status === "string" && !status) {
        return { success: false, error: "invalid status" };
      }

      const sessionId =
        typeof data.sessionId === "string" && data.sessionId.trim().length > 0
          ? data.sessionId.trim()
          : undefined;

      const runs = await kv.list<LessonExtractionRun>(KV.lessonExtractionRuns);
      const filtered = runs
        .filter((run) => (sessionId ? run.sessionId === sessionId : true))
        .filter((run) => (status ? run.status === status : true))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
      return { success: true, runs: filtered };
    },
  );

  sdk.registerFunction("mem::lessons::extract-run-get",
    async (data: { runId?: unknown }) => {
      if (typeof data.runId !== "string" || !data.runId.trim()) {
        return { success: false, error: "runId is required" };
      }

      const runId = data.runId.trim();
      const run = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, runId);
      if (!run) {
        return { success: false, error: "run not found" };
      }

      const chunks = await kv.list<LessonExtractionChunkRun>(
        KV.lessonExtractionChunks(run.id),
      );
      const sortedChunks = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      return { success: true, run, chunks: sortedChunks };
    },
  );

  sdk.registerFunction("mem::lesson-recall", 
    async (data: {
      query: string;
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      if (!data.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const query = data.query.toLowerCase();
      const minConfidence = data.minConfidence ?? 0.1;
      const limit = data.limit ?? 10;

      let lessons = await kv.list<Lesson>(KV.lessons);

      lessons = lessons.filter(
        (l) => !l.deleted && l.confidence >= minConfidence,
      );

      if (data.project) {
        lessons = lessons.filter((l) => l.project === data.project);
      }

      const scored = lessons
        .map((l) => {
          const text = `${l.content} ${l.context} ${l.tags.join(" ")}`.toLowerCase();
          const terms = query.split(/\s+/).filter((t) => t.length > 1);
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;

          const relevance = matchCount / terms.length;
          const daysSinceReinforced = l.lastReinforcedAt
            ? (Date.now() - new Date(l.lastReinforcedAt).getTime()) /
              (1000 * 60 * 60 * 24)
            : (Date.now() - new Date(l.createdAt).getTime()) /
              (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSinceReinforced * 0.01);
          const score = l.confidence * relevance * recencyBoost;

          return { lesson: l, score };
        })
        .filter(Boolean) as Array<{ lesson: Lesson; score: number }>;

      scored.sort((a, b) => b.score - a.score);

      try {
        await recordAudit(kv, "lesson_recall", "mem::lesson-recall", [], {
          query: data.query,
          resultCount: scored.length,
        });
      } catch {}

      return {
        success: true,
        lessons: scored.slice(0, limit).map((s) => ({
          ...s.lesson,
          score: Math.round(s.score * 1000) / 1000,
        })),
      };
    },
  );

  sdk.registerFunction("mem::lesson-list", 
    async (data: {
      project?: string;
      source?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      const limit = data.limit ?? 50;
      const minConfidence = data.minConfidence ?? 0;
      let lessons = await kv.list<Lesson>(KV.lessons);

      lessons = lessons.filter(
        (l) => !l.deleted && l.confidence >= minConfidence,
      );

      if (data.project) {
        lessons = lessons.filter((l) => l.project === data.project);
      }
      if (data.source) {
        lessons = lessons.filter((l) => l.source === data.source);
      }

      lessons.sort((a, b) => b.confidence - a.confidence);

      return { success: true, lessons: lessons.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::lesson-strengthen", 
    async (data: { lessonId: string }) => {
      if (!data.lessonId) {
        return { success: false, error: "lessonId is required" };
      }

      const lesson = await kv.get<Lesson>(KV.lessons, data.lessonId);
      if (!lesson || lesson.deleted) {
        return { success: false, error: "lesson not found" };
      }

      reinforceLesson(lesson);

      await kv.set(KV.lessons, lesson.id, lesson);

      try {
        await recordAudit(kv, "lesson_strengthen", "mem::lesson-strengthen", [
          lesson.id,
        ]);
      } catch {}

      return { success: true, lesson };
    },
  );

  sdk.registerFunction("mem::lesson-decay-sweep", 
    async () => {
      const lessons = await kv.list<Lesson>(KV.lessons);
      let decayed = 0;
      let softDeleted = 0;
      const now = Date.now();
      const timestamp = new Date().toISOString();
      const dirty: Lesson[] = [];
      const auditEvents: Array<{
        id: string;
        action: "decay" | "soft-delete";
        beforeConfidence: number;
        afterConfidence: number;
        beforeDeleted: boolean;
        afterDeleted: boolean;
      }> = [];

      for (const lesson of lessons) {
        if (lesson.deleted) continue;

        const baseline = lesson.lastDecayedAt || lesson.lastReinforcedAt || lesson.createdAt;
        const weeksSinceBaseline =
          (now - new Date(baseline).getTime()) / (1000 * 60 * 60 * 24 * 7);

        if (weeksSinceBaseline < 1) continue;

        const decay = lesson.decayRate * weeksSinceBaseline;
        const newConfidence = Math.max(0.05, lesson.confidence - decay);

        if (newConfidence !== lesson.confidence) {
          const beforeConfidence = lesson.confidence;
          const beforeDeleted = !!lesson.deleted;
          lesson.confidence = Math.round(newConfidence * 1000) / 1000;
          lesson.lastDecayedAt = timestamp;
          lesson.updatedAt = timestamp;

          if (lesson.confidence <= 0.1 && lesson.reinforcements === 0) {
            lesson.deleted = true;
            softDeleted++;
          } else {
            decayed++;
          }

          dirty.push(lesson);
          auditEvents.push({
            id: lesson.id,
            action: lesson.deleted ? "soft-delete" : "decay",
            beforeConfidence,
            afterConfidence: lesson.confidence,
            beforeDeleted,
            afterDeleted: !!lesson.deleted,
          });
        }
      }

      await Promise.all(dirty.map((l) => kv.set(KV.lessons, l.id, l)));
      await Promise.all(
        auditEvents.map((event) =>
          recordAudit(kv, "lesson_strengthen", "mem::lesson-decay-sweep", [event.id], {
            action: event.action,
            actor: "system",
            reason: "decay-sweep",
            before: {
              confidence: event.beforeConfidence,
              deleted: event.beforeDeleted,
            },
            after: {
              confidence: event.afterConfidence,
              deleted: event.afterDeleted,
            },
          }),
        ),
      );

      return { success: true, decayed, softDeleted, total: lessons.length };
    },
  );
}
