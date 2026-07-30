import { createHash } from "node:crypto";
import type {
  ApplySessionLessonDelta,
  Lesson,
  LessonCommitPlan,
  LessonCommitReceipt,
  LessonExtractionCandidateStaging,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { stableStringify } from "./lesson-extraction-runs.js";

export const LESSON_COMMIT_RECOVERY_POLICY_VERSION = "effect-state-recovery/v1";

export class LessonCommitConflictError extends Error {
  constructor(message = "lesson_commit_conflict") { super(message); this.name = "LessonCommitConflictError"; }
}

function hash(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
export function normalizeLessonIdentityContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}
export function lessonIdForContent(content: string): string {
  return fingerprintId("lesson", normalizeLessonIdentityContent(content));
}
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

interface LessonCommitIdentity {
  id: string;
  runId: string;
  sessionId: string;
  unitId: string;
  attemptId: string;
  generation: number;
  inputHash: string;
  configHash: string;
  operationIdentityHash: string;
  recoveryPolicyVersion: string;
  stagingId: string;
  stagingCandidateHash: string;
}

function planIdentity(staging: LessonExtractionCandidateStaging, recoveryPolicyVersion: string): LessonCommitIdentity {
  const fields = {
    runId: staging.runId, sessionId: staging.sessionId, unitId: staging.unitId,
    attemptId: staging.attemptId, generation: staging.generation, inputHash: staging.inputHash,
    configHash: staging.configHash, operationIdentityHash: staging.operationIdentityHash,
    recoveryPolicyVersion, stagingId: staging.id, stagingCandidateHash: staging.candidateHash,
  };
  return { id: `lcp_${hash({ ...fields, stagingCandidateHash: undefined }).slice(0, 32)}`, ...fields };
}

function mutationId(stagingId: string, delta: ApplySessionLessonDelta): string {
  return hash({ stagingId, delta: { ...delta, mutationId: undefined } });
}

function planIntegrity(plan: LessonCommitPlan, identity?: LessonCommitIdentity): void {
  const expectedId = identity?.id ?? `lcp_${hash({
    runId: plan.runId, sessionId: plan.sessionId, unitId: plan.unitId, attemptId: plan.attemptId,
    generation: plan.generation, inputHash: plan.inputHash, configHash: plan.configHash,
    operationIdentityHash: plan.operationIdentityHash, recoveryPolicyVersion: plan.recoveryPolicyVersion,
    stagingId: plan.stagingId, stagingCandidateHash: undefined,
  }).slice(0, 32)}`;
  if (plan.id !== expectedId || !Array.isArray(plan.deltas)
    || new Set(plan.deltas.map((delta) => delta.lessonId)).size !== plan.deltas.length
    || plan.deltas.some((delta, index) => delta.mutationId !== mutationId(plan.stagingId, delta)
      || (index > 0 && plan.deltas[index - 1].lessonId.localeCompare(delta.lessonId) > 0))
    || plan.effectHash !== hash(plan.deltas)) {
    throw new LessonCommitConflictError("commit_plan_conflict");
  }
  if (identity && (plan.runId !== identity.runId || plan.sessionId !== identity.sessionId
    || plan.unitId !== identity.unitId || plan.attemptId !== identity.attemptId
    || plan.generation !== identity.generation || plan.inputHash !== identity.inputHash
    || plan.configHash !== identity.configHash || plan.operationIdentityHash !== identity.operationIdentityHash
    || plan.recoveryPolicyVersion !== identity.recoveryPolicyVersion || plan.stagingId !== identity.stagingId
    || plan.stagingCandidateHash !== identity.stagingCandidateHash)) {
    throw new LessonCommitConflictError("commit_plan_conflict");
  }
}

export function withLessonKeyLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(`lesson:${id}`, fn);
}

export function buildSessionLessonDeltas(staging: LessonExtractionCandidateStaging, lessons: Lesson[], options: {
  appliedAt: string; project?: string; fallbackContext?: string;
}): ApplySessionLessonDelta[] {
  if (staging.candidates.length === 0) return [];
  const candidateContents = new Set(
    staging.candidates.map((candidate) => normalizeLessonIdentityContent(candidate.content)),
  );
  const existingIdsByContent = new Map<string, string>();
  for (const lesson of lessons) {
    const normalizedContent = normalizeLessonIdentityContent(lesson.content);
    if (!candidateContents.has(normalizedContent)) continue;
    const existingId = existingIdsByContent.get(normalizedContent);
    if (existingId && existingId !== lesson.id) {
      throw new LessonCommitConflictError("lesson_identity_conflict");
    }
    existingIdsByContent.set(normalizedContent, lesson.id);
  }
  const byId = new Map<string, ApplySessionLessonDelta>();
  for (const candidate of staging.candidates) {
    const id = existingIdsByContent.get(normalizeLessonIdentityContent(candidate.content))
      ?? lessonIdForContent(candidate.content);
    byId.set(id, { lessonId: id, sessionId: staging.sessionId, generation: staging.generation,
      mutationId: "", sourceRunId: staging.runId, appliedAt: options.appliedAt, project: options.project,
      fallbackContext: options.fallbackContext ?? candidate.context,
      candidate, removeHeuristicSource: false });
  }
  for (const lesson of lessons) {
    if (lesson.source !== "heuristic" || lesson.origin !== "replay-import-heuristic" || !lesson.sourceIds.includes(staging.sessionId)) continue;
    const current = byId.get(lesson.id);
    if (current) current.removeHeuristicSource = true;
    else byId.set(lesson.id, { lessonId: lesson.id, sessionId: staging.sessionId, generation: staging.generation,
      mutationId: "", sourceRunId: staging.runId, appliedAt: options.appliedAt, project: options.project,
      fallbackContext: options.fallbackContext ?? "",
      removeHeuristicSource: true });
  }
  return [...byId.values()]
    .map((delta) => ({ ...delta, mutationId: mutationId(staging.id, delta) }))
    .sort((a, b) => a.lessonId.localeCompare(b.lessonId));
}

export async function freezeLessonCommitPlan(kv: StateKV, input: {
  staging: LessonExtractionCandidateStaging; recoveryPolicyVersion?: string; project?: string; fallbackContext?: string; appliedAt?: string;
}): Promise<LessonCommitPlan> {
  const { staging } = input;
  const recoveryPolicyVersion = input.recoveryPolicyVersion ?? LESSON_COMMIT_RECOVERY_POLICY_VERSION;
  const identity = planIdentity(staging, recoveryPolicyVersion);
  return withKeyedLock(`lesson-commit-plan:${identity.id}`, async () => {
    const existing = await kv.get<LessonCommitPlan>(KV.lessonCommitPlans(staging.runId), identity.id);
    if (existing) {
      planIntegrity(existing, identity);
      return existing;
    }
    const createdAt = new Date().toISOString();
    const deltas = buildSessionLessonDeltas(staging, await kv.list<Lesson>(KV.lessons), {
      appliedAt: input.appliedAt ?? createdAt, project: input.project, fallbackContext: input.fallbackContext,
    });
    const effectHash = hash(deltas);
    const plan: LessonCommitPlan = { ...identity, effectHash, deltas, createdAt };
    planIntegrity(plan, identity);
    await kv.set(KV.lessonCommitPlans(staging.runId), identity.id, plan);
    const verified = await kv.get<LessonCommitPlan>(KV.lessonCommitPlans(staging.runId), identity.id);
    if (!verified) throw new Error("lesson_commit_plan_persist_unconfirmed");
    planIntegrity(verified, identity);
    return verified;
  });
}

export async function applySessionLessonDelta(kv: StateKV, delta: ApplySessionLessonDelta): Promise<"applied" | "replayed"> {
  return withLessonKeyLock(delta.lessonId, async () => {
    const current = await kv.get<Lesson>(KV.lessons, delta.lessonId);
    const watermark = current?.sourceWatermarks?.[delta.sessionId];
    if (watermark) {
      if (watermark.generation > delta.generation) return "replayed";
      if (watermark.generation === delta.generation) {
        if (watermark.mutationId === delta.mutationId) return "replayed";
        throw new LessonCommitConflictError("lesson_watermark_conflict");
      }
    }
    const now = delta.appliedAt;
    let next: Lesson;
    if (!current) {
      if (!delta.candidate) throw new LessonCommitConflictError("lesson_remove_target_missing");
      next = { id: delta.lessonId, content: delta.candidate.content, context: delta.candidate.context || delta.fallbackContext,
        confidence: delta.candidate.confidence, reinforcements: 0, source: "llm", origin: "llm-session-extraction",
        sourceIds: [delta.sessionId], sourceRunId: delta.sourceRunId, tags: unique(delta.candidate.tags),
        project: delta.project, createdAt: now, updatedAt: now, decayRate: 0.05, sourceWatermarks: {} };
    } else {
      next = { ...current, sourceIds: [...current.sourceIds], tags: [...current.tags], sourceWatermarks: { ...current.sourceWatermarks } };
      if (delta.candidate) {
        next.tags = unique([...next.tags, ...delta.candidate.tags]);
        next.confidence = Math.max(next.confidence, delta.candidate.confidence);
        if (delta.project !== undefined) next.project = delta.project;
        if (!next.sourceIds.includes(delta.sessionId)) {
          next.sourceIds.push(delta.sessionId);
          next.reinforcements += 1;
          next.lastReinforcedAt = now;
        }
        if (!next.context && (delta.candidate.context || delta.fallbackContext)) next.context = delta.candidate.context || delta.fallbackContext;
        next.sourceRunId = delta.sourceRunId;
      }
      if (delta.removeHeuristicSource && current.source === "heuristic" && current.origin === "replay-import-heuristic") {
        next.sourceIds = next.sourceIds.filter((id) => id !== delta.sessionId);
        if (next.sourceIds.length === 0) next.deleted = true;
      }
      next.updatedAt = now;
    }
    next.sourceWatermarks = { ...next.sourceWatermarks, [delta.sessionId]: { generation: delta.generation, mutationId: delta.mutationId } };
    await kv.set(KV.lessons, next.id, next);
    return "applied";
  });
}

function receiptKey(plan: LessonCommitPlan): string {
  return `lcr_${hash({ version: 1, planId: plan.id, runId: plan.runId, stage: "lessons", unitId: plan.unitId, inputHash: plan.inputHash, configHash: plan.configHash, recoveryPolicyVersion: plan.recoveryPolicyVersion }).slice(0, 32)}`;
}

function receiptIntegrity(receipt: LessonCommitReceipt, plan: LessonCommitPlan): void {
  const ids = plan.deltas.map((delta) => delta.lessonId);
  if (receipt.version !== 1 || receipt.stage !== "lessons" || receipt.key !== receiptKey(plan) || receipt.planId !== plan.id || receipt.runId !== plan.runId
    || receipt.unitId !== plan.unitId || receipt.inputHash !== plan.inputHash
    || receipt.configHash !== plan.configHash || receipt.recoveryPolicyVersion !== plan.recoveryPolicyVersion
    || receipt.effectHash !== plan.effectHash || (receipt.status !== "committing" && receipt.status !== "committed")
    || !Array.isArray(receipt.appliedLessonIds)
    || receipt.appliedLessonIds.some((id, index) => id !== ids[index])
    || (receipt.status === "committed" && receipt.appliedLessonIds.length !== ids.length)) {
    throw new LessonCommitConflictError("commit_plan_conflict");
  }
}

function watermarkState(lesson: Lesson | null, delta: ApplySessionLessonDelta): "missing" | "lower" | "satisfied" | "conflict" {
  const watermark = lesson?.sourceWatermarks?.[delta.sessionId];
  if (!watermark) return "missing";
  if (watermark.generation > delta.generation) return "satisfied";
  if (watermark.generation < delta.generation) return "lower";
  return watermark.mutationId === delta.mutationId ? "satisfied" : "conflict";
}

export async function executeLessonCommitPlan(kv: StateKV, plan: LessonCommitPlan): Promise<LessonCommitReceipt> {
  planIntegrity(plan);
  const key = receiptKey(plan);
  return withKeyedLock(`lesson-commit:${key}`, async () => {
  const persistedPlan = await kv.get<LessonCommitPlan>(KV.lessonCommitPlans(plan.runId), plan.id);
  if (!persistedPlan) throw new LessonCommitConflictError("commit_plan_not_persisted");
  planIntegrity(persistedPlan);
  if (stableStringify(persistedPlan) !== stableStringify(plan)) {
    throw new LessonCommitConflictError("commit_plan_conflict");
  }
  let receipt = await kv.get<LessonCommitReceipt>(KV.lessonCommitReceipts(plan.runId), key);
  if (receipt) receiptIntegrity(receipt, plan);
  receipt ??= { version: 1, stage: "lessons", key, planId: plan.id, runId: plan.runId, unitId: plan.unitId, inputHash: plan.inputHash, configHash: plan.configHash,
    recoveryPolicyVersion: plan.recoveryPolicyVersion, effectHash: plan.effectHash, appliedLessonIds: [], status: "committing", updatedAt: new Date().toISOString() };
  await kv.set(KV.lessonCommitReceipts(plan.runId), key, receipt);
  for (const delta of plan.deltas) {
    const before = await kv.get<Lesson>(KV.lessons, delta.lessonId);
    const state = watermarkState(before, delta);
    if (state === "conflict") throw new LessonCommitConflictError("lesson_watermark_conflict");
    if (state !== "satisfied") await applySessionLessonDelta(kv, delta);
    if (!receipt.appliedLessonIds.includes(delta.lessonId)) {
      receipt = { ...receipt, appliedLessonIds: [...receipt.appliedLessonIds, delta.lessonId], updatedAt: new Date().toISOString() };
      await kv.set(KV.lessonCommitReceipts(plan.runId), key, receipt);
    }
  }
  for (const delta of plan.deltas) {
    const lesson = await kv.get<Lesson>(KV.lessons, delta.lessonId);
    const state = watermarkState(lesson, delta);
    if (state === "conflict" || state === "missing" || state === "lower") {
      throw new LessonCommitConflictError("lesson_commit_reconciliation_required");
    }
  }
  const committed = { ...receipt, status: "committed" as const, updatedAt: new Date().toISOString() };
  await kv.set(KV.lessonCommitReceipts(plan.runId), key, committed);
  return committed;
  });
}

export async function reconcileLessonCommit(kv: StateKV, plan: LessonCommitPlan): Promise<"committed" | "resume_commit" | "not_committed" | "conflict"> {
  try { planIntegrity(plan); } catch (error) {
    if (error instanceof LessonCommitConflictError) return "conflict";
    throw error;
  }
  const receipt = await kv.get<LessonCommitReceipt>(KV.lessonCommitReceipts(plan.runId), receiptKey(plan));
  if (!receipt) return "not_committed";
  try { receiptIntegrity(receipt, plan); } catch (error) {
    if (error instanceof LessonCommitConflictError) return "conflict";
    throw error;
  }
  for (const delta of plan.deltas) {
    const state = watermarkState(await kv.get<Lesson>(KV.lessons, delta.lessonId), delta);
    if (state === "conflict") return "conflict";
    if (state !== "satisfied") return "resume_commit";
  }
  return receipt.status === "committed" ? "committed" : "resume_commit";
}
