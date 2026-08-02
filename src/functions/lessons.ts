import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type {
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
  Lesson,
  LessonCommitPlan,
  LessonExtractionChunkRun,
  LessonExtractionRun,
  LessonExtractionCandidateStaging,
  MemoryProvider,
} from "../types.js";
import {
  enqueueLlmLessonExtractionRun,
  inspectLlmLessonExtractionRun,
  listRunnableRuns,
  processLlmLessonExtractionRun,
  resolveLlmLessonExtractionRuntimeConfig,
  stableHash as stableLessonOperationHash,
} from "./lesson-extraction-runs.js";
import { recordAudit } from "./audit.js";
import {
  completeModelOperationFromVerifiedResult,
  normalizeFailedExtractionOperationRetryAuthorization,
  projectExtractionOperationReceiptAbsence,
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
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
} from "./extraction-contributions.js";
import { partitionAdoptedBaselineSessions } from "./extraction-baselines.js";

const RETRYABLE_LESSON_PROVIDER_CODES = new Set([
  "rate_limited",
  "timeout",
  "network_error",
  "server_error",
]);
const HARD_LESSON_PROVIDER_CODES = new Set(["auth_failed", "model_not_found"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const LESSONS_CONTRIBUTION_CONTRACT = "lessons/v1";

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

async function reconcileCommittedLessonContribution(
  kv: StateKV,
  input: {
    contributionId: string;
    sourceVersionKey: string;
    run: LessonExtractionRun;
  },
): Promise<Record<string, unknown> | null> {
  if (input.run.status !== "succeeded" || !input.run.candidateStagingId) return null;
  const staging = await kv.get<LessonExtractionCandidateStaging>(
    KV.lessonExtractionCandidates(input.run.id), input.run.candidateStagingId,
  );
  if (!staging) throw new Error("lesson_candidate_staging_missing");
  const plan = await freezeLessonCommitPlan(kv, { staging });
  if (await reconcileLessonCommit(kv, plan) === "conflict") {
    throw new Error("lesson_commit_conflict");
  }
  const receipt = await executeLessonCommitPlan(kv, plan);
  if (receipt.status !== "committed") throw new Error("lesson_commit_receipt_missing");
  const operationReceiptRef = {
    scope: KV.lessonCommitReceipts(input.run.id),
    key: receipt.key,
    effectHash: plan.effectHash,
  };
  if (plan.deltas.length === 0) {
    await markClaimedBatchNoEffect(kv, {
      stage: "lessons",
      stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
      contributionId: input.contributionId,
      sourceVersionKeys: [input.sourceVersionKey],
      operationReceiptRef,
      receiptKey: receipt.key,
      reasonCode: "no_novel_lessons",
    });
    return {
      kind: "no_effect",
      runId: input.run.id,
      stagingId: staging.id,
      planId: plan.id,
      receiptKey: receipt.key,
      effectHash: plan.effectHash,
      receiptVersion: receipt.version,
      reasonCode: "no_novel_lessons",
    };
  }
  await commitClaimedBatch(kv, {
    stage: "lessons",
    stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
    contributionId: input.contributionId,
    sourceVersionKeys: [input.sourceVersionKey],
    operationReceiptRef,
    effectRefs: plan.deltas.map((delta) => ({
      scope: KV.lessons,
      key: delta.lessonId,
      effectHash: plan.effectHash,
    })),
  });
  return {
    kind: "committed",
    runId: input.run.id,
    stagingId: staging.id,
    planId: plan.id,
    receiptKey: receipt.key,
    effectHash: plan.effectHash,
    receiptVersion: receipt.version,
    resultRef: `lesson-commit-plans:${plan.id}`,
  };
}

async function verifyCommittedLessonContribution(
  kv: StateKV,
  input: {
    sourceVersionKey: string;
    run: LessonExtractionRun | null;
    proof: { operationReceiptRef?: { scope: string; key: string; effectHash?: string }; effectRefs?: Array<{ scope: string; key: string; effectHash?: string }> };
  },
): Promise<Record<string, unknown> | null> {
  if (!input.run || input.run.status !== "succeeded" || !input.run.candidateStagingId) return null;
  const receiptRef = input.proof.operationReceiptRef;
  if (!receiptRef || receiptRef.scope !== KV.lessonCommitReceipts(input.run.id)) return null;
  const receipt = await kv.get<{ status?: unknown; planId?: unknown; effectHash?: unknown; key?: unknown; version?: unknown }>(
    receiptRef.scope, receiptRef.key,
  );
  if (!receipt || receipt.status !== "committed" || receipt.key !== receiptRef.key || receipt.effectHash !== receiptRef.effectHash || typeof receipt.planId !== "string") return null;
  const plan = await kv.get<LessonCommitPlan>(KV.lessonCommitPlans(input.run.id), receipt.planId);
  if (!plan || plan.effectHash !== receipt.effectHash || (await reconcileLessonCommit(kv, plan)) !== "committed") return null;
  const expectedRefs = plan.deltas.map((delta) => ({ scope: KV.lessons, key: delta.lessonId, effectHash: plan.effectHash }));
  if (JSON.stringify(input.proof.effectRefs ?? []) !== JSON.stringify(expectedRefs)) return null;
  return {
    kind: "committed", runId: input.run.id, stagingId: input.run.candidateStagingId,
    planId: plan.id, receiptKey: receiptRef.key, effectHash: plan.effectHash,
    receiptVersion: receipt.version, resultRef: `lesson-commit-plans:${plan.id}`,
  };
}

async function verifyNoEffectLessonContribution(
  kv: StateKV,
  input: {
    sessionId: string;
    run: LessonExtractionRun | null;
    proof: {
      operationReceiptRef?: { scope: string; key: string };
      noEffectProof?: { kind?: string; receiptKey?: string; reasonCode?: string };
      effectRefs?: unknown[];
    };
  },
): Promise<boolean> {
  const receiptRef = input.proof.operationReceiptRef;
  const noEffectProof = input.proof.noEffectProof;
  if (
    input.run?.status === "succeeded"
    && Boolean(input.run.candidateStagingId)
    && receiptRef?.scope === KV.lessonCommitReceipts(input.run.id)
    && noEffectProof?.kind === "strict_legal_empty"
    && noEffectProof.receiptKey === receiptRef.key
    && noEffectProof.reasonCode === "no_novel_lessons"
    && (input.proof.effectRefs?.length ?? 0) === 0
  ) {
    const receipt = await kv.get<{
      status?: unknown;
      planId?: unknown;
      effectHash?: unknown;
      key?: unknown;
    }>(receiptRef.scope, receiptRef.key);
    if (
      !receipt
      || receipt.status !== "committed"
      || receipt.key !== receiptRef.key
      || receipt.effectHash !== receiptRef.effectHash
      || typeof receipt.planId !== "string"
    ) return false;
    const plan = await kv.get<LessonCommitPlan>(
      KV.lessonCommitPlans(input.run.id),
      receipt.planId,
    );
    return Boolean(
      plan
      && plan.effectHash === receipt.effectHash
      && plan.deltas.length === 0
      && await reconcileLessonCommit(kv, plan) === "committed"
    );
  }
  if (
    !input.run || input.run.status !== "skipped"
    || !receiptRef || receiptRef.scope !== KV.extractionOperationReceipt(receiptRef.key)
    || !noEffectProof || noEffectProof.kind !== "strict_legal_empty"
    || noEffectProof.receiptKey !== receiptRef.key
    || noEffectProof.reasonCode !== "lesson_run_skipped"
    || (input.proof.effectRefs?.length ?? 0) !== 0
  ) return false;
  const receipt = await kv.get<ExtractionOperationReceipt<{ status?: unknown; runs?: unknown[] }>>(
    receiptRef.scope, receiptRef.key,
  );
  return receipt?.status === "succeeded"
    && receipt.stage === "lessons"
    && receipt.unitId === input.sessionId
    && receipt.response?.status === "skipped";
}

async function releaseLessonClaimIfUnstaged(
  kv: StateKV,
  input: { contributionId: string; sourceVersionKey: string; runId: string },
): Promise<void> {
  const run = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, input.runId);
  if (run?.candidateStagingId) return;
  await releaseClaimedBatch(kv, {
    stage: "lessons", stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
    contributionId: input.contributionId, sourceVersionKeys: [input.sourceVersionKey],
  });
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

export type LessonOperationResultState = "absent" | "present" | "drifted";

export async function verifyLessonOperationResultState(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  runnerInputHash: string,
  now = new Date(),
): Promise<LessonOperationResultState> {
  const matchingRuns = (await kv.list<LessonExtractionRun>(KV.lessonExtractionRuns))
    .filter((run) => (
      run.sessionId === identity.unitId
      && stableLessonOperationHash({
        runnerInputHash,
        serviceInputHash: run.inputHash,
        configHash: run.configHash,
      }) === identity.inputHash
    ));
  if (matchingRuns.length !== 1) return "drifted";

  const run = matchingRuns[0];
  const [stagedCandidates, commitPlans] = await Promise.all([
    kv.list<LessonExtractionCandidateStaging>(KV.lessonExtractionCandidates(run.id)),
    kv.list<LessonCommitPlan>(KV.lessonCommitPlans(run.id)),
  ]);
  if (
    stagedCandidates.length > 0
    || commitPlans.length > 0
    || Boolean(run.candidateStagingId)
    || run.createdLessonIds.length > 0
    || run.replacedLessonIds.length > 0
    || run.status === "succeeded"
    || run.status === "skipped"
  ) {
    return "present";
  }
  if (
    !Number.isSafeInteger(run.extractionGeneration)
    || (run.extractionGeneration ?? 0) <= 0
  ) {
    return "drifted";
  }
  if (run.status === "running") {
    return run.runningLeaseUntil && isExpiredRunningRun(run, now) ? "absent" : "drifted";
  }
  return ["pending", "retryable", "failed"].includes(run.status) ? "absent" : "drifted";
}

function lessonOperationReceiptProjection(
  receipt: ExtractionOperationReceipt | undefined,
  runnerInputHash: string,
): Record<string, unknown> | undefined {
  if (!receipt) return undefined;
  return {
    key: receipt.key,
    version: receipt.version,
    status: receipt.status,
    runId: receipt.runId,
    stage: receipt.stage,
    unitId: receipt.unitId,
    inputHash: receipt.inputHash,
    runnerInputHash,
    startedAt: receipt.startedAt,
  };
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
      sourceMutationId?: string;
      sourceMutationPrecondition?: {
        lessonId: string;
        baselineKind: "absent" | "active" | "deleted";
        baselineStateHash?: string;
        predecessorMutationId?: string;
      };
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
      const sourceMutationId = data.sourceMutationId?.trim();
      const sourceMutationAlreadyApplied = Boolean(
        sourceMutationId
        && existing?.sourceWatermarks?.[sourceMutationId]?.mutationId === sourceMutationId,
      );

      if (existing && sourceMutationAlreadyApplied) {
        return {
          success: true,
          action: "replayed",
          lesson: existing,
        };
      }

      const precondition = data.sourceMutationPrecondition;
      if (precondition) {
        const validPrecondition = Boolean(
          sourceMutationId
          && precondition.lessonId === fp
          && ["absent", "active", "deleted"].includes(precondition.baselineKind)
          && (
            precondition.baselineKind === "absent"
              ? precondition.baselineStateHash === undefined
              : typeof precondition.baselineStateHash === "string"
                && SHA256_HEX.test(precondition.baselineStateHash)
          )
          && (
            precondition.predecessorMutationId === undefined
            || (
              typeof precondition.predecessorMutationId === "string"
              && precondition.predecessorMutationId.length > 0
            )
          )
        );
        if (!validPrecondition) {
          return { success: false, error: "lesson source mutation precondition invalid" };
        }
        if (precondition.predecessorMutationId) {
          if (
            !existing
            || existing.deleted
            || existing.sourceWatermarks?.[precondition.predecessorMutationId]?.mutationId
              !== precondition.predecessorMutationId
          ) {
            return { success: false, error: "lesson source mutation precondition conflict" };
          }
        } else if (precondition.baselineKind === "absent") {
          if (existing) {
            return { success: false, error: "lesson source mutation precondition conflict" };
          }
        } else if (
          !existing
          || stableLessonOperationHash(existing) !== precondition.baselineStateHash
          || (precondition.baselineKind === "active" && existing.deleted)
          || (precondition.baselineKind === "deleted" && !existing.deleted)
        ) {
          return { success: false, error: "lesson source mutation precondition conflict" };
        }
      }

      if (existing && !existing.deleted) {
        reinforceLesson(existing);
        if (data.context && !existing.context) {
          existing.context = data.context;
        }
        existing.sourceIds = [
          ...new Set([...(existing.sourceIds ?? []), ...(data.sourceIds ?? [])]),
        ];
        if (sourceMutationId) {
          existing.sourceWatermarks = {
            ...(existing.sourceWatermarks ?? {}),
            [sourceMutationId]: {
              generation: 1,
              mutationId: sourceMutationId,
            },
          };
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
        sourceWatermarks: sourceMutationId
          ? {
              ...(existing?.sourceWatermarks ?? {}),
              [sourceMutationId]: {
                generation: 1,
                mutationId: sourceMutationId,
              },
            }
          : existing?.sourceWatermarks,
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
      expectedReceiptInputHash?: unknown;
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
      const expectedReceiptInputHash = data.expectedReceiptInputHash === undefined
        ? undefined
        : typeof data.expectedReceiptInputHash === "string"
          && /^[0-9a-f]{64}$/.test(data.expectedReceiptInputHash)
          ? data.expectedReceiptInputHash
          : null;
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
      if (
        expectedReceiptInputHash === null
        || (
          expectedReceiptInputHash !== undefined
          && (data.requireExistingReceipt === true || !attemptId)
        )
      ) {
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
      const baseline = await partitionAdoptedBaselineSessions(kv, {
        stage: "lessons",
        stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
        sessionIds,
      });
      if (baseline.openSessionIds.length === 0) {
        return {
          success: true,
          runs: [],
          lessonEvidence: [],
          baselineId: baseline.baselineId,
          adoptedBaselineSessionIds: baseline.adoptedSessionIds,
        };
      }

      const runs: LessonExtractionRun[] = [];
      const lessonEvidence: Array<Record<string, unknown>> = [];
      const now = new Date();
      const legacyContributionAttemptId = attemptId || generateId("lesson-attempt");

      for (const sessionId of baseline.openSessionIds) {
        const inspection = await inspectLlmLessonExtractionRun({
          kv,
          sessionId,
          config,
        });

        if (!attemptId) {
          const sourceVersionKey = buildSourceVersionKey(
            "lessons",
            "session_experience",
            sessionId,
            inspection.inputHash,
          );
          const contribution = await claimBatch(kv, {
            stage: "lessons",
            stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
            runId: legacyContributionAttemptId,
            unitId: sessionId,
            sourceVersionKeys: [sourceVersionKey],
          });
          if (contribution.status === "contract_migration_required") {
            return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_contribution_contract_migration_required" } };
          }
          if (contribution.status === "claimed_by_other") {
            return { success: false, status: "failed", failure: { class: "unit", cause: "lesson_contribution_reconciliation_required" } };
          }
          if (contribution.status === "already_committed" && contribution.records[0]?.state === "no_effect") {
            if (!await verifyNoEffectLessonContribution(kv, {
              sessionId, run: inspection.existing, proof: contribution.records[0]!,
            })) {
              return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_contribution_effect_unverifiable" } };
            }
            runs.push(inspection.existing);
            continue;
          }
          if (contribution.status === "already_committed" && !inspection.existing) {
            return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_contribution_effect_unverifiable" } };
          }
          if (contribution.status === "already_committed" && inspection.existing) {
            try {
              const evidence = await verifyCommittedLessonContribution(kv, {
                sourceVersionKey,
                run: inspection.existing,
                proof: contribution.records[0]!,
              });
              if (!evidence) throw new Error("lesson_contribution_effect_unverifiable");
              lessonEvidence.push(evidence);
              runs.push(inspection.existing);
              continue;
            } catch (error) {
              return {
                success: false,
                status: "failed",
                failure: { class: "hard", cause: error instanceof Error ? error.message : "lesson_contribution_effect_unverifiable" },
              };
            }
          }
          const baseRun = await enqueueLlmLessonExtractionRun({
            kv,
            sessionId,
            missingOnly: missingOnly ?? true,
            retryFailed: retryFailed ?? true,
            force: force ?? false,
            config,
            inspection,
          });
          const completedRun = (
            baseRun.status === "pending" ||
            baseRun.status === "retryable" ||
            isExpiredRunningRun(baseRun, now)
          )
            ? await processLlmLessonExtractionRun({ kv, provider, runId: baseRun.id })
            : baseRun;
          if (completedRun.status === "retryable" || completedRun.status === "failed") {
            await releaseLessonClaimIfUnstaged(kv, {
              contributionId: contribution.records[0]!.contributionId,
              sourceVersionKey,
              runId: completedRun.id,
            });
          }
          if (completedRun.status === "succeeded" && completedRun.candidateStagingId) {
            try {
              const evidence = await reconcileCommittedLessonContribution(kv, {
                contributionId: contribution.records[0]!.contributionId,
                sourceVersionKey,
                run: completedRun,
              });
              if (!evidence) throw new Error("lesson_commit_receipt_missing");
              lessonEvidence.push(evidence);
            } catch (error) {
              return {
                success: false,
                status: "failed",
                failure: { class: "hard", cause: error instanceof Error ? error.message : "lesson_commit_receipt_missing" },
              };
            }
          }
          runs.push(completedRun);
          continue;
        }

        const receiptIdentity = {
          runId: attemptId,
          stage: "lessons" as const,
          unitId: sessionId,
          inputHash: stableLessonOperationHash({
            runnerInputHash,
            serviceInputHash: inspection.inputHash,
            configHash: inspection.configHash,
          }),
        };
        if (
          expectedReceiptInputHash !== undefined
          && expectedReceiptInputHash !== receiptIdentity.inputHash
        ) {
          return {
            success: false,
            status: "failed",
            failure: {
              class: "hard",
              cause: "extraction_operation_input_hash_drifted_after_absence",
            },
          };
        }
        const sourceVersionKey = buildSourceVersionKey(
          "lessons",
          "session_experience",
          sessionId,
          inspection.inputHash,
        );
        const contribution = await claimBatch(kv, {
          stage: "lessons",
          stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
          runId: attemptId,
          unitId: sessionId,
          sourceVersionKeys: [sourceVersionKey],
        });
        if (contribution.status === "contract_migration_required") {
          return {
            success: false,
            status: "failed",
            failure: { class: "hard", cause: "lesson_contribution_contract_migration_required" },
          };
        }
        if (contribution.status === "claimed_by_other") {
          return {
            success: false,
            status: "failed",
            failure: { class: "unit", cause: "lesson_contribution_reconciliation_required" },
          };
        }
        if (contribution.status === "already_committed") {
          const proof = contribution.records[0]!;
          const evidence = proof.state === "committed"
            ? await verifyCommittedLessonContribution(kv, {
              sourceVersionKey, run: inspection.existing, proof,
            })
            : await verifyNoEffectLessonContribution(kv, {
              sessionId, run: inspection.existing, proof,
            })
              ? { kind: "no_effect", runId: inspection.existing?.id }
              : null;
          if (!evidence) {
            return {
              success: false,
              status: "failed",
              failure: { class: "hard", cause: "lesson_contribution_effect_unverifiable" },
            };
          }
          const operation = await completeModelOperationFromVerifiedResult(
            kv,
            receiptIdentity,
            { success: true, status: inspection.existing!.status, runs: [inspection.existing] },
            { allowMissing: true },
          );
          if (operation.failure) return { success: false, status: "failed", failure: operation.failure };
          const persistedResponse = operation.response as { runs?: LessonExtractionRun[] } | undefined;
          runs.push(persistedResponse?.runs?.[0] ?? inspection.existing!);
          if (proof.state === "committed") lessonEvidence.push(evidence);
          return { success: true, runs, lessonEvidence };
        }
        const legacyRetryAuthorized = failedReceiptRetryAuthorization
          && failedLessonRunEvidence
          && inspection.existing
          ? await legacyLessonRetryEvidenceMatches(
            kv,
            inspection.existing,
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
          const baseRun = await enqueueLlmLessonExtractionRun({
            kv,
            sessionId,
            missingOnly: missingOnly ?? true,
            retryFailed: retryFailed ?? true,
            force: force ?? false,
            config,
            inspection,
          });
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
            ...(expectedReceiptInputHash
              ? { expectedInputHash: expectedReceiptInputHash }
              : {}),
            retryFailed: true,
            ...(failedReceiptRetryAuthorization
              ? { failedRetryAuthorization: failedReceiptRetryAuthorization }
              : {}),
            ...(legacyRetryAuthorized ? { allowLegacyLessonFailedRetry: true } : {}),
          },
        );
        if (
          operation.failure?.cause === "extraction_operation_reconciliation_required"
          && (
            inspection.existing?.status === "succeeded"
            || inspection.existing?.status === "skipped"
          )
        ) {
          operation = await completeModelOperationFromVerifiedResult(
            kv,
            receiptIdentity,
            {
              success: true,
              status: inspection.existing.status,
              runs: [inspection.existing],
            },
            { allowMissing: true },
          );
        }
        if (operation.failure) {
          if (contribution.status === "claimed") {
            await releaseLessonClaimIfUnstaged(kv, {
              contributionId: contribution.records[0]!.contributionId,
              sourceVersionKey,
              runId: inspection.runId,
            });
          }
          const operationReceipt = lessonOperationReceiptProjection(
            operation.receipt,
            runnerInputHash,
          );
          const operationReceiptAbsence = projectExtractionOperationReceiptAbsence(
            operation.receiptAbsence,
            runnerInputHash,
          );
          return {
            success: false,
            status: "failed",
            failure: operation.failure,
            ...(operationReceipt ? { operationReceipt } : {}),
            ...(operationReceiptAbsence ? { operationReceiptAbsence } : {}),
          };
        }
        const response = operation.response as { runs?: LessonExtractionRun[] } | undefined;
        const responseRun = response?.runs?.[0];
        const completedRun = await kv.get<LessonExtractionRun>(
          KV.lessonExtractionRuns,
          responseRun?.id ?? inspection.runId,
        );
        if (!completedRun) {
          return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_run_missing" } };
        }
        if (responseRun?.id && responseRun.id !== completedRun.id) {
          return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_run_identity_conflict" } };
        }
        if (completedRun.status === "succeeded" && completedRun.candidateStagingId) {
          try {
            const evidence = await reconcileCommittedLessonContribution(kv, {
              contributionId: contribution.records[0]!.contributionId,
              sourceVersionKey,
              run: completedRun,
            });
            if (!evidence) {
              return { success: false, status: "failed", failure: { class: "hard", cause: "lesson_commit_receipt_missing" } };
            }
            lessonEvidence.push(evidence);
          } catch (error) {
            const cause = error instanceof Error ? error.message : "lesson_commit_receipt_missing";
            return { success: false, status: "failed", failure: { class: "hard", cause } };
          }
          runs.push(responseRun ?? completedRun);
          continue;
        }
        if (completedRun.status === "skipped" && operation.receipt?.status === "succeeded") {
          await markClaimedBatchNoEffect(kv, {
            stage: "lessons",
            stageContractVersion: LESSONS_CONTRIBUTION_CONTRACT,
            contributionId: contribution.records[0]!.contributionId,
            sourceVersionKeys: [sourceVersionKey],
            operationReceiptRef: {
              scope: KV.extractionOperationReceipt(operation.receipt.key),
              key: operation.receipt.key,
            },
            receiptKey: operation.receipt.key,
            reasonCode: "lesson_run_skipped",
          });
        }
        runs.push(responseRun ?? completedRun);
      }

      return {
        success: true,
        runs,
        lessonEvidence,
        ...(baseline.adoptedSessionIds.length > 0
          ? {
              baselineId: baseline.baselineId,
              adoptedBaselineSessionIds: baseline.adoptedSessionIds,
            }
          : {}),
      };
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
