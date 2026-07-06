import { createHash } from "node:crypto";
import type {
  Lesson,
  LessonExtractionChunkRun,
  LessonExtractionRun,
  LessonExtractionRunStatus,
  MemoryProvider,
  RawObservation,
  Session,
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { resolveStageModel, resolveStageModelMetadata } from "../config.js";

export interface LlmLessonExtractionRuntimeConfig {
  providerName: string;
  textLimit: number;
  saveLimit: number;
  chunkSize: number;
  chunkConcurrency: number;
  timeoutMs: number;
  model?: string;
  modelSource?: string;
}

export interface EnqueueLlmLessonExtractionRunInput {
  kv: StateKV;
  sessionId: string;
  missingOnly?: boolean;
  retryFailed?: boolean;
  force?: boolean;
  config: LlmLessonExtractionRuntimeConfig;
}

export interface ProcessLlmLessonExtractionRunInput {
  kv: StateKV;
  provider: MemoryProvider;
  runId: string;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const orderedKeys = Object.keys(value).sort();
  const pairs = orderedKeys.map((key) => {
    const v = stableStringify((value as Record<string, unknown>)[key]);
    return `${JSON.stringify(key)}:${v}`;
  });
  return `{${pairs.join(",")}}`;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function computeLessonExtractionInputHash(
  observations: Array<
    Pick<RawObservation, "sessionId" | "id" | "sourceEventIndex"> &
      Partial<Pick<RawObservation, "sourceEventId" | "sourceFileHash" | "importKey" | "timestamp">>
  >,
): string {
  const normalized = observations
    .map((obs) => ({
      sessionId: obs.sessionId,
      sourceEventIndex: obs.sourceEventIndex ?? -1,
      id: obs.id,
      sourceFileHash: obs.sourceFileHash,
      sourceEventId: obs.sourceEventId,
      importKey: obs.importKey,
      updatedAt: obs.timestamp,
    }))
    .sort((a, b) =>
      `${a.sessionId}:${a.sourceEventIndex}:${a.id}`.localeCompare(
        `${b.sessionId}:${b.sourceEventIndex}:${b.id}`,
      ),
    );

  return stableHash(normalized);
}

export function computeLessonExtractionConfigHash(
  config: LlmLessonExtractionRuntimeConfig,
): string {
  return stableHash(config);
}

export function runIdForSession(
  sessionId: string,
  inputHash: string,
  configHash: string,
): string {
  return fingerprintId("lex", `${sessionId}:${inputHash}:${configHash}`);
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value) > 0 ? Math.trunc(value) : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  }
  return fallback;
}

function supportsStageModelOverride(providerName: string): boolean {
  return providerName === "pi-agent-sdk" || providerName === "resilient(pi-agent-sdk)";
}

export function resolveLlmLessonExtractionRuntimeConfig(
  provider: MemoryProvider,
  rawConfig: Record<string, unknown> = {},
): LlmLessonExtractionRuntimeConfig {
  const providerName = provider.name;
  const defaultConcurrency = providerName === "pi-agent-sdk" || providerName === "resilient(pi-agent-sdk)"
    ? 1
    : 3;
  const stageModel = supportsStageModelOverride(providerName)
    ? resolveStageModel(
        "lesson",
        typeof rawConfig.model === "string" ? rawConfig.model : undefined,
      )
    : undefined;

  return {
    providerName,
    textLimit: parsePositiveInt(rawConfig.textLimit, 1200),
    saveLimit: parsePositiveInt(rawConfig.saveLimit, 50),
    chunkSize: parsePositiveInt(rawConfig.chunkSize, 20),
    chunkConcurrency: parsePositiveInt(rawConfig.chunkConcurrency, defaultConcurrency),
    timeoutMs: parsePositiveInt(rawConfig.timeoutMs, 60000),
    ...(stageModel?.model
      ? { model: stageModel.model, modelSource: stageModel.source }
      : {}),
  };
}

export async function findLatestRunForSession(
  kv: StateKV,
  sessionId: string,
  inputHash: string,
  configHash: string,
): Promise<LessonExtractionRun | null> {
  const runs = await kv.list<LessonExtractionRun>(KV.lessonExtractionRuns);
  const matched = runs
    .filter(
      (run) =>
        run.sessionId === sessionId &&
        run.inputHash === inputHash &&
        run.configHash === configHash,
    )
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return matched[0] ?? null;
}

export async function listRunnableRuns(
  kv: StateKV,
  limit = 1,
  now = new Date(),
): Promise<LessonExtractionRun[]> {
  const runs = await kv.list<LessonExtractionRun>(KV.lessonExtractionRuns);
  const nowMs = now.getTime();

  return runs
    .filter((run) => {
      if (run.status === "pending" || run.status === "retryable") return true;
      if (run.status !== "running" || !run.runningLeaseUntil) return false;
      return new Date(run.runningLeaseUntil).getTime() <= nowMs;
    })
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
    .slice(0, Math.max(1, limit));
}

export async function saveRunStatus(
  kv: StateKV,
  run: LessonExtractionRun,
  status: LessonExtractionRunStatus,
  patch: Partial<LessonExtractionRun> = {},
): Promise<LessonExtractionRun> {
  const now = new Date().toISOString();
  const isFinalState =
    status === "succeeded" ||
    status === "failed" ||
    status === "retryable" ||
    status === "skipped";

  const next: LessonExtractionRun = {
    ...run,
    ...patch,
    status,
    updatedAt: now,
    runningLeaseUntil:
      status === "running"
        ? patch.runningLeaseUntil ?? run.runningLeaseUntil
        : undefined,
    finishedAt: isFinalState ? now : run.finishedAt,
  };

  await kv.set(KV.lessonExtractionRuns, next.id, next);
  return next;
}

export function newChunkRun(
  runId: string,
  sessionId: string,
  chunkIndex: number,
): LessonExtractionChunkRun {
  const now = new Date().toISOString();
  return {
    id: `${runId}:chunk:${chunkIndex}`,
    runId,
    sessionId,
    chunkIndex,
    status: "pending",
    attempts: 0,
    lessonIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function replaceSessionHeuristicLessons(
  kv: StateKV,
  sessionId: string,
): Promise<string[]> {
  const lessons = await kv.list<Lesson>(KV.lessons);
  const replacedLessonIds: string[] = [];
  const now = new Date().toISOString();

  for (const lesson of lessons) {
    if (lesson.source !== "heuristic") continue;
    if (lesson.origin !== "replay-import-heuristic") continue;
    if (!lesson.sourceIds.includes(sessionId)) continue;

    const sourceIds = lesson.sourceIds.filter((id) => id !== sessionId);
    if (sourceIds.length === lesson.sourceIds.length) continue;

    const next: Lesson = {
      ...lesson,
      sourceIds,
      updatedAt: now,
    };

    if (sourceIds.length === 0) {
      next.deleted = true;
    }

    await kv.set(KV.lessons, lesson.id, next);
    replacedLessonIds.push(lesson.id);
  }

  return replacedLessonIds;
}

export async function enqueueLlmLessonExtractionRun(
  input: EnqueueLlmLessonExtractionRunInput,
): Promise<LessonExtractionRun> {
  const { kv, sessionId, missingOnly = false, retryFailed = false, force = false, config } = input;
  const now = new Date().toISOString();
  const session = await kv.get<Session>(KV.sessions, sessionId);
  const observations = await kv.list<RawObservation>(KV.observations(sessionId));
  const inputHash = computeLessonExtractionInputHash(observations);
  const configHash = computeLessonExtractionConfigHash(config);
  const runId = runIdForSession(sessionId, inputHash, configHash);
  const existing = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, runId);

  if (!session) {
    const skipped: LessonExtractionRun = {
      id: runId,
      sessionId,
      project: undefined,
      strategy: "llm",
      status: "skipped",
      inputHash,
      configHash,
      providerName: config.providerName,
      config,
      attempts: 0,
      createdLessonIds: [],
      replacedLessonIds: [],
      skippedReason: `session ${sessionId} not found`,
      lastError: `session ${sessionId} not found`,
      createdAt: now,
      updatedAt: now,
    };
    await kv.set(KV.lessonExtractionRuns, runId, skipped);
    return skipped;
  }

  if (existing && !force) {
    if (existing.status === "succeeded" && missingOnly) return existing;
    if (existing.status === "pending" || existing.status === "running" || existing.status === "retryable") {
      return existing;
    }
    if (existing.status === "failed" && !retryFailed) {
      const skipped: LessonExtractionRun = {
        ...existing,
        status: "skipped",
        skippedReason: "failed run exists and retryFailed is false",
        updatedAt: now,
      };
      await kv.set(KV.lessonExtractionRuns, runId, skipped);
      return skipped;
    }
  }

  const next: LessonExtractionRun = {
    id: runId,
    sessionId,
    project: session.project,
    strategy: "llm",
    status: "pending",
    inputHash,
    configHash,
    providerName: config.providerName,
    config,
    attempts: 0,
    createdLessonIds: [],
    replacedLessonIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await kv.set(KV.lessonExtractionRuns, runId, next);
  return next;
}

export async function processLlmLessonExtractionRun(
  input: ProcessLlmLessonExtractionRunInput,
): Promise<LessonExtractionRun> {
  const { kv, provider, runId } = input;
  const startedMs = Date.now();
  const run = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, runId);
  if (!run) {
    throw new Error(`run ${runId} not found`);
  }

  if (run.status === "succeeded" || run.status === "skipped") {
    return run;
  }

  const now = new Date();
  const runningPatch = await saveRunStatus(kv, run, "running", {
    attempts: run.attempts + 1,
    runningLeaseUntil: new Date(now.getTime() + run.config.timeoutMs).toISOString(),
    startedAt: run.startedAt ?? now.toISOString(),
    lastError: undefined,
  });

  const session = await kv.get<Session>(KV.sessions, run.sessionId);
  if (!session) {
    return saveRunStatus(kv, runningPatch, "retryable", {
      lastError: `session ${run.sessionId} not found`,
      status: "retryable",
    });
  }

  const observations = await kv.list<RawObservation>(KV.observations(run.sessionId));
  const { extractLlmLessonsFromObservations } = await import("./lesson-extract.js");
  const extraction = await extractLlmLessonsFromObservations({
    kv,
    provider,
    sessionId: run.sessionId,
    project: session.project,
    rawObservations: observations,
    compressedObservations: [],
    firstPrompt: session.firstPrompt,
    config: { ...run.config, providerName: run.providerName },
    sourceRunId: run.id,
  });
  const stageMetadata = resolveStageModelMetadata(
    "lesson",
    provider,
    run.config.model,
  );
  const extractionMetadata = {
    provider: stageMetadata.provider,
    ...(stageMetadata.modelApplied && (run.config.model ?? stageMetadata.model)
      ? { model: run.config.model ?? stageMetadata.model }
      : {}),
    ...(stageMetadata.modelApplied && (run.config.modelSource ?? stageMetadata.modelSource)
      ? { modelSource: run.config.modelSource ?? stageMetadata.modelSource }
      : {}),
    promptChars: extraction.promptChars,
    parseFailures: extraction.parseFailures,
    durationMs: Date.now() - startedMs,
    modelApplied: stageMetadata.modelApplied,
    ...(stageMetadata.providerModelOverride
      ? { providerModelOverride: stageMetadata.providerModelOverride }
      : {}),
  };

  if (extraction.errors.length > 0) {
    return saveRunStatus(kv, runningPatch, "retryable", {
      lastError: extraction.errors.join("\n"),
      createdLessonIds: extraction.lessonIds,
      replacedLessonIds: [],
      ...extractionMetadata,
    });
  }

  let replacedLessonIds: string[] = [];
  if (extraction.lessonIds.length > 0) {
    replacedLessonIds = await replaceSessionHeuristicLessons(kv, run.sessionId);
  }

  return saveRunStatus(kv, runningPatch, "succeeded", {
    createdLessonIds: extraction.lessonIds,
    replacedLessonIds,
    ...extractionMetadata,
  });
}
