import { createHash } from "node:crypto";
import type { LessonExtractionCandidateStaging } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { stableStringify } from "./lesson-extraction-runs.js";

export type StagedLessonCandidate = LessonExtractionCandidateStaging["candidates"][number];

export class LessonCandidateStagingConflictError extends Error {
  constructor() {
    super("lesson_candidate_staging_conflict");
    this.name = "LessonCandidateStagingConflictError";
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function lessonCandidateOperationIdentityHash(input: Pick<
  LessonExtractionCandidateStaging,
  "runId" | "sessionId" | "unitId" | "attemptId" | "generation" | "inputHash" | "configHash"
>): string {
  return hash({
    runId: input.runId,
    stage: "lessons",
    sessionId: input.sessionId,
    unitId: input.unitId,
    attemptId: input.attemptId,
    generation: input.generation,
    inputHash: input.inputHash,
    configHash: input.configHash,
  });
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validCandidate(value: unknown): value is StagedLessonCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.content === "string" && typeof item.context === "string"
    && typeof item.confidence === "number" && Number.isFinite(item.confidence)
    && typeof item.importance === "number" && Number.isFinite(item.importance)
    && Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string")
    && typeof item.evidence === "string"
    && (item.source === "heuristic" || item.source === "llm");
}

function validStaging(value: unknown): value is LessonExtractionCandidateStaging {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as LessonExtractionCandidateStaging;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.runId === "string" && item.runId.length > 0
    && typeof item.sessionId === "string" && item.sessionId.length > 0
    && item.unitId === item.sessionId
    && typeof item.attemptId === "string" && item.attemptId.length > 0
    && Number.isSafeInteger(item.generation) && item.generation > 0
    && validHash(item.inputHash) && validHash(item.configHash) && validHash(item.operationIdentityHash)
    && validHash(item.candidateHash) && Array.isArray(item.candidates)
    && item.candidates.every(validCandidate) && typeof item.createdAt === "string";
}

function stagingId(input: Pick<LessonExtractionCandidateStaging, "runId" | "attemptId">): string {
  return `lcs_${input.runId}_${hash(input.attemptId).slice(0, 16)}`;
}

function matchesExpected(
  staging: LessonExtractionCandidateStaging,
  expected: Omit<LessonExtractionCandidateStaging, "id" | "candidateHash" | "candidates" | "createdAt">,
): boolean {
  return validStaging(staging)
    && staging.id === stagingId(expected)
    && staging.runId === expected.runId && staging.sessionId === expected.sessionId
    && staging.unitId === expected.unitId && staging.attemptId === expected.attemptId
    && staging.generation === expected.generation && staging.inputHash === expected.inputHash
    && staging.configHash === expected.configHash
    && staging.operationIdentityHash === lessonCandidateOperationIdentityHash(expected)
    && hash(staging.candidates) === staging.candidateHash;
}

export async function readStagedLessonCandidates(
  kv: StateKV,
  expected: Omit<LessonExtractionCandidateStaging, "id" | "candidateHash" | "candidates" | "createdAt">,
): Promise<LessonExtractionCandidateStaging | null> {
  if (expected.operationIdentityHash !== lessonCandidateOperationIdentityHash(expected)) {
    throw new LessonCandidateStagingConflictError();
  }
  const existing = await kv.get<LessonExtractionCandidateStaging>(
    KV.lessonExtractionCandidates(expected.runId),
    stagingId(expected),
  );
  if (!existing) return null;
  if (!matchesExpected(existing, expected)) throw new LessonCandidateStagingConflictError();
  return existing;
}

export async function stageLessonCandidates(
  kv: StateKV,
  input: Omit<LessonExtractionCandidateStaging, "id" | "candidateHash" | "createdAt">,
): Promise<LessonExtractionCandidateStaging> {
  if (!validStaging({ ...input, id: "candidate", candidateHash: hash(input.candidates), createdAt: "1970-01-01T00:00:00.000Z" })
    || input.operationIdentityHash !== lessonCandidateOperationIdentityHash(input)) {
    throw new LessonCandidateStagingConflictError();
  }
  const id = stagingId(input);
  return withKeyedLock(`lesson-candidate-staging:${id}`, async () => {
    const candidateHash = hash(input.candidates);
    const existing = await readStagedLessonCandidates(kv, input);
    if (existing) {
      if (existing.candidateHash !== candidateHash) throw new LessonCandidateStagingConflictError();
      return existing;
    }
    const next: LessonExtractionCandidateStaging = {
      ...input,
      id,
      candidateHash,
      createdAt: new Date().toISOString(),
    };
    await kv.set(KV.lessonExtractionCandidates(input.runId), id, next);
    const persisted = await kv.get<LessonExtractionCandidateStaging>(
      KV.lessonExtractionCandidates(input.runId),
      id,
    );
    if (!persisted || !matchesExpected(persisted, input)
      || hash(persisted.candidates) !== persisted.candidateHash
      || stableStringify(persisted) !== stableStringify(next)) {
      throw new LessonCandidateStagingConflictError();
    }
    return persisted;
  });
}
