import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type {
  Lesson,
  LessonExtractionChunkRun,
  LessonExtractionRun,
  LessonExtractionCandidateStaging,
  MemoryProvider,
} from "../types.js";
import {
  enqueueLlmLessonExtractionRun,
  listRunnableRuns,
  processLlmLessonExtractionRun,
  resolveLlmLessonExtractionRuntimeConfig,
  stableHash as stableLessonOperationHash,
} from "./lesson-extraction-runs.js";
import { recordAudit } from "./audit.js";
import {
  completeModelOperationFromVerifiedResult,
  normalizeFailedExtractionOperationRetryAuthorization,
  withExtractionOperationReceipt,
  type FailedExtractionOperationRetryAuthorization,
} from "./extraction-operation-receipts.js";
import { sanitizeLessonFailureDiagnostics } from "./summarize.js";
import {
  executeLessonCommitPlan,
  freezeLessonCommitPlan,
  lessonIdForContent,
  normalizeLessonIdentityContent,
  reconcileLessonCommit,
  withLessonKeyLock,
} from "./lesson-commit.js";

const RETRYABLE_LESSON_PROVIDER_CODES = new Set([
  "rate_limited",
  "timeout",
  "network_error",
  "server_error",
]);
const HARD_LESSON_PROVIDER_CODES = new Set(["auth_failed", "model_not_found"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface FailedLessonRunRetryEvidence {
  status: "retryable";
  inputHash: string;
  configHash: string;
  failureCause: string;
  failurePhase: "provider_call";
  failedAt: string;
  createdLessonCount: 0;
  replacedLessonCount: 0;
  chunkLessonCount: 0;
}

export function normalizeFailedLessonRunRetryEvidence(
  value: unknown,
): FailedLessonRunRetryEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  if (
    Object.keys(evidence).sort().join(",")
      !== "chunkLessonCount,configHash,createdLessonCount,failedAt,failureCause,failurePhase,inputHash,replacedLessonCount,status"
    || evidence.status !== "retryable"
    || typeof evidence.inputHash !== "string"
    || !SHA256_HEX.test(evidence.inputHash)
    || typeof evidence.configHash !== "string"
    || !SHA256_HEX.test(evidence.configHash)
    || typeof evidence.failureCause !== "string"
    || !RETRYABLE_LESSON_PROVIDER_CODES.has(evidence.failureCause)
    || evidence.failurePhase !== "provider_call"
    || typeof evidence.failedAt !== "string"
    || !ISO_TIMESTAMP.test(evidence.failedAt)
    || evidence.createdLessonCount !== 0
    || evidence.replacedLessonCount !== 0
    || evidence.chunkLessonCount !== 0
  ) {
    return null;
  }
  return evidence as unknown as FailedLessonRunRetryEvidence;
}

async function legacyLessonRetryEvidenceMatches(
  kv: StateKV,
  run: LessonExtractionRun,
  receiptInputHash: string,
  authorization: FailedExtractionOperationRetryAuthorization,
  evidence: FailedLessonRunRetryEvidence,
): Promise<boolean> {
  const diagnostics = sanitizeLessonFailureDiagnostics(run.failureDiagnostics);
  const chunks = await kv.list<LessonExtractionChunkRun>(
    KV.lessonExtractionChunks(run.id),
  );
  const chunkLessonCount = chunks.reduce(
    (count, chunk) => count + chunk.lessonIds.length,
    0,
  );
  return run.status === "retryable"
    && run.inputHash === evidence.inputHash
    && run.configHash === evidence.configHash
    && run.finishedAt === evidence.failedAt
    && run.createdLessonIds.length === evidence.createdLessonCount
    && run.replacedLessonIds.length === evidence.replacedLessonCount
    && chunkLessonCount === evidence.chunkLessonCount
    && diagnostics !== undefined
    && "providerErrorCode" in diagnostics
    && diagnostics.providerErrorCode === evidence.failureCause
    && diagnostics.requestPhase === "chunk"
    && authorization.receiptInputHash === receiptInputHash
    && authorization.retryEpoch === 0
    && authorization.failureClass === "transient_provider"
    && authorization.failureCause === "lesson_extraction_failed"
    && authorization.failurePhase === evidence.failurePhase
    && authorization.lastSafeFailure.errorClass === authorization.failureClass
    && authorization.lastSafeFailure.cause === authorization.failureCause
    && authorization.lastSafeFailure.phase === authorization.failurePhase
    && authorization.lastSafeFailure.timestamp === evidence.failedAt;
}

function lessonRunFailure(run: LessonExtractionRun): {
  failure: {
    class: "transient_provider" | "unit" | "hard";
    cause: string;
    phase?: "provider_call";
    diagnostics?: NonNullable<LessonExtractionRun["failureDiagnostics"]>;
  };
  retryableReceiptFailure?: true;
} {
  if (run.status !== "retryable") {
    return { failure: { class: "unit", cause: "lesson_extraction_failed" } };
  }
  const diagnostics = sanitizeLessonFailureDiagnostics(run.failureDiagnostics);
  if (diagnostics && "parseErrorCode" in diagnostics) {
    return {
      failure: {
        class: "unit",
        cause: diagnostics.parseErrorCode,
        diagnostics,
      },
    };
  }
  if (diagnostics && "providerErrorCode" in diagnostics) {
    if (RETRYABLE_LESSON_PROVIDER_CODES.has(diagnostics.providerErrorCode)) {
      return {
        failure: {
          class: "transient_provider",
          cause: diagnostics.providerErrorCode,
          phase: "provider_call",
          diagnostics,
        },
        retryableReceiptFailure: true,
      };
    }
    return {
      failure: {
        class: HARD_LESSON_PROVIDER_CODES.has(diagnostics.providerErrorCode) ? "hard" : "unit",
        cause: diagnostics.providerErrorCode,
        diagnostics,
      },
    };
  }
  return { failure: { class: "unit", cause: "lesson_extraction_failed" } };
}

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

      const normalizedContent = normalizeLessonIdentityContent(data.content);
      const canonicalId = lessonIdForContent(normalizedContent);
      const legacyId = fingerprintId("lsn", normalizedContent);
      const canonical = await kv.get<Lesson>(KV.lessons, canonicalId);
      const legacy = await kv.get<Lesson>(KV.lessons, legacyId);
      if (canonical && legacy) {
        return { success: false, error: "lesson identity conflict" };
      }
      const fp = canonical?.id ?? legacy?.id ?? canonicalId;
      return withLessonKeyLock(fp, async () => {
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
        ...(existing ?? {}),
        id: fp,
        content: data.content.trim(),
        context: data.context?.trim() || existing?.context || "",
        confidence: existing ? Math.max(existing.confidence, confidence) : confidence,
        reinforcements: existing?.reinforcements ?? 0,
        source: data.source || "manual",
        origin: data.origin ?? existing?.origin,
        sourceRunId: data.sourceRunId ?? existing?.sourceRunId,
        sourceIds: [...new Set([...(existing?.sourceIds ?? []), ...(data.sourceIds ?? [])])],
        sourceWatermarks: existing?.sourceWatermarks,
        project: data.project ?? existing?.project,
        tags: [...new Set([...(existing?.tags ?? []), ...(data.tags ?? [])])],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        decayRate: 0.05,
        deleted: undefined,
      };

      await kv.set(KV.lessons, lesson.id, lesson);

      try {
        await recordAudit(kv, "lesson_save", "mem::lesson-save", [lesson.id]);
      } catch {}

      return { success: true, action: "created", lesson };
      });
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
      model?: unknown;
      attemptId?: unknown;
      inputHash?: unknown;
      requireExistingReceipt?: unknown;
      failedReceiptRetryAuthorization?: unknown;
      failedLessonRunEvidence?: unknown;
    }) => {
      if (!provider) {
        return { success: false, error: "provider is required for lesson extraction" };
      }

      const sessionIds = parseStringArray(data.sessionIds);
      if (!sessionIds || sessionIds.length === 0) {
        return { success: false, error: "sessionIds is required and must be a non-empty string array" };
      }
      const attemptId = typeof data.attemptId === "string" ? data.attemptId.trim() : "";
      const runnerInputHash = typeof data.inputHash === "string" ? data.inputHash.trim() : "";
      if (Boolean(attemptId) !== Boolean(runnerInputHash)) {
        return {
          success: false,
          status: "failed",
          failure: { class: "hard", cause: "invalid_extraction_operation_identity" },
        };
      }
      if (
        data.requireExistingReceipt !== undefined
        && typeof data.requireExistingReceipt !== "boolean"
      ) {
        return {
          success: false,
          status: "failed",
          failure: { class: "hard", cause: "invalid_extraction_operation_identity" },
        };
      }
      if (data.requireExistingReceipt === true && !attemptId) {
        return {
          success: false,
          status: "failed",
          failure: { class: "hard", cause: "invalid_extraction_operation_identity" },
        };
      }
      const failedReceiptRetryAuthorization =
        data.failedReceiptRetryAuthorization === undefined
          ? undefined
          : normalizeFailedExtractionOperationRetryAuthorization(
            data.failedReceiptRetryAuthorization,
          );
      const failedLessonRunEvidence = data.failedLessonRunEvidence === undefined
        ? undefined
        : normalizeFailedLessonRunRetryEvidence(data.failedLessonRunEvidence);
      if (
        failedReceiptRetryAuthorization === null
        || failedLessonRunEvidence === null
        || Boolean(failedReceiptRetryAuthorization) !== Boolean(failedLessonRunEvidence)
        || (
          failedReceiptRetryAuthorization !== undefined
          && (data.requireExistingReceipt !== true || sessionIds.length !== 1)
        )
      ) {
        return {
          success: false,
          status: "failed",
          failure: {
            class: "hard",
            cause: "invalid_extraction_operation_retry_authorization",
          },
        };
      }
      if (attemptId && sessionIds.length !== 1) {
        return {
          success: false,
          status: "failed",
          failure: { class: "hard", cause: "invalid_extraction_operation_identity" },
        };
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
        model: data.model,
      });

      const runs: LessonExtractionRun[] = [];
      const lessonEvidence: Array<Record<string, unknown>> = [];
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

        if (!attemptId) {
          if (
            baseRun.status === "pending" ||
            baseRun.status === "retryable" ||
            isExpiredRunningRun(baseRun, now)
          ) {
            runs.push(await processLlmLessonExtractionRun({ kv, provider, runId: baseRun.id }));
          } else {
            runs.push(baseRun);
          }
          continue;
        }

        const receiptIdentity = {
          runId: attemptId,
          stage: "lessons" as const,
          unitId: sessionId,
          inputHash: stableLessonOperationHash({
            runnerInputHash,
            serviceInputHash: baseRun.inputHash,
            configHash: baseRun.configHash,
          }),
        };
        const legacyRetryAuthorized = failedReceiptRetryAuthorization
          && failedLessonRunEvidence
          ? await legacyLessonRetryEvidenceMatches(
            kv,
            baseRun,
            receiptIdentity.inputHash,
            failedReceiptRetryAuthorization,
            failedLessonRunEvidence,
          )
          : false;
        if (failedReceiptRetryAuthorization && !legacyRetryAuthorized) {
          return {
            success: false,
            status: "failed",
            failure: {
              class: "hard",
              cause: "invalid_extraction_operation_retry_authorization",
            },
          };
        }
        const execute = async () => {
          if (baseRun.status === "running" && !isExpiredRunningRun(baseRun, now)) {
            throw new Error("lesson extraction is already running");
          }
          const run = (
            baseRun.status === "pending" ||
            baseRun.status === "retryable" ||
            isExpiredRunningRun(baseRun, now)
          )
            ? await processLlmLessonExtractionRun({
              kv,
              provider,
              runId: baseRun.id,
              attemptId,
            })
            : baseRun;
          if (run.status === "retryable" || run.status === "failed") {
            const classified = lessonRunFailure(run);
            return {
              success: false,
              status: "failed",
              ...classified,
              runs: [run],
            };
          }
          return { success: true, status: run.status, runs: [run] };
        };

        let operation = await withExtractionOperationReceipt(
          kv,
          receiptIdentity,
          execute,
          {
            requireExisting: data.requireExistingReceipt === true,
            retryFailed: true,
            ...(failedReceiptRetryAuthorization
              ? { failedRetryAuthorization: failedReceiptRetryAuthorization }
              : {}),
            ...(legacyRetryAuthorized ? { allowLegacyLessonFailedRetry: true } : {}),
          },
        );
        if (
          operation.failure?.cause === "extraction_operation_reconciliation_required"
          && (baseRun.status === "succeeded" || baseRun.status === "skipped")
        ) {
          operation = await completeModelOperationFromVerifiedResult(
            kv,
            receiptIdentity,
            { success: true, status: baseRun.status, runs: [baseRun] },
          );
        }
        if (operation.failure) {
          return { success: false, status: "failed", failure: operation.failure };
        }
        const response = operation.response as { runs?: LessonExtractionRun[] } | undefined;
        const responseRun = response?.runs?.[0];
        const completedRun = await kv.get<LessonExtractionRun>(
          KV.lessonExtractionRuns,
          baseRun.id,
        );
        if (!completedRun) {
          return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_run_missing" } };
        }
        if (responseRun?.id && responseRun.id !== completedRun.id) {
          return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_run_identity_conflict" } };
        }
        if (completedRun.status === "succeeded" && completedRun.candidateStagingId) {
          const staging = await kv.get<LessonExtractionCandidateStaging>(
            KV.lessonExtractionCandidates(completedRun.id),
            completedRun.candidateStagingId,
          );
          if (!staging) {
            return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_candidate_staging_missing" } };
          }
          const plan = await freezeLessonCommitPlan(kv, { staging });
          const reconciliation = await reconcileLessonCommit(kv, plan);
          if (reconciliation === "conflict") {
            return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_commit_conflict" } };
          }
          const receipt = await executeLessonCommitPlan(kv, plan);
          if (!receipt || receipt.status !== "committed") {
            return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_commit_receipt_missing" } };
          }
          lessonEvidence.push({
            kind: "committed",
            runId: completedRun.id,
            stagingId: staging.id,
            planId: plan.id,
            receiptKey: receipt.key,
            effectHash: plan.effectHash,
            receiptVersion: receipt.version,
            resultRef: `lesson-commit-plans:${plan.id}`,
          });
          runs.push(responseRun ?? completedRun);
          continue;
        }
        runs.push(responseRun ?? completedRun);
      }

      return { success: true, runs, lessonEvidence };
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

      return withLessonKeyLock(data.lessonId, async () => {
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
      });
    },
  );

  sdk.registerFunction("mem::lesson-decay-sweep", 
    async () => {
      const lessons = await kv.list<Lesson>(KV.lessons);
      const now = Date.now();
      const timestamp = new Date().toISOString();
      type DecayAuditEvent = {
        id: string;
        action: "decay" | "soft-delete";
        beforeConfidence: number;
        afterConfidence: number;
        beforeDeleted: boolean;
        afterDeleted: boolean;
      };
      const results = await Promise.all(lessons.map(({ id }) => withLessonKeyLock(id, async (): Promise<DecayAuditEvent | null> => {
        const current = await kv.get<Lesson>(KV.lessons, id);
        if (!current || current.deleted) return null;
        const baseline = current.lastDecayedAt || current.lastReinforcedAt || current.createdAt;
        const weeks = (now - new Date(baseline).getTime()) / (1000 * 60 * 60 * 24 * 7);
        if (weeks < 1) return null;
        const confidence = Math.round(Math.max(0.05, current.confidence - current.decayRate * weeks) * 1000) / 1000;
        if (confidence === current.confidence) return null;
        const next = { ...current, confidence, lastDecayedAt: timestamp, updatedAt: timestamp };
        if (confidence <= 0.1 && next.reinforcements === 0) next.deleted = true;
        await kv.set(KV.lessons, next.id, next);
        return {
          id: next.id,
          action: next.deleted ? "soft-delete" : "decay",
          beforeConfidence: current.confidence,
          afterConfidence: next.confidence,
          beforeDeleted: !!current.deleted,
          afterDeleted: !!next.deleted,
        };
      })));
      const auditEvents = results.filter((event): event is DecayAuditEvent => event !== null);
      const decayed = auditEvents.filter((event) => event.action === "decay").length;
      const softDeleted = auditEvents.filter((event) => event.action === "soft-delete").length;
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
