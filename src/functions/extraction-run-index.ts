import type { ISdk } from "iii-sdk";
import type {
  ExtractionRunResultType,
  ExtractionRunStage,
  ExtractionRunStageRecord,
  ExtractionRunStatus,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import {
  EXTRACTION_RUN_MAX_ID_BYTES,
  EXTRACTION_RUN_MAX_MARK_BYTES,
  ExtractionRunStore,
} from "./extraction-run-store.js";
import { recordExtractionRunAudit } from "./audit.js";

interface ExtractionRunRecordInput {
  runId?: unknown;
  mark?: unknown;
  status?: unknown;
  stage?: unknown;
  unitId?: unknown;
  sourceIds?: unknown;
  resultIds?: unknown;
  resultType?: unknown;
  summarySessionId?: unknown;
  lessonRunId?: unknown;
  semanticWindowId?: unknown;
}

const allowedRecordInputKeys = new Set([
  "runId",
  "mark",
  "status",
  "stage",
  "unitId",
  "sourceIds",
  "resultIds",
  "resultType",
  "summarySessionId",
  "lessonRunId",
  "semanticWindowId",
]);

const statuses = new Set<ExtractionRunStatus>([
  "running",
  "succeeded",
  "skipped",
  "failed",
  "partial",
]);

const stages = new Set<ExtractionRunStage>([
  "summary",
  "lessons",
  "memory_consolidate",
  "semantic_rollup",
  "skill_extract",
  "crystal",
  "consolidation_procedural",
  "reflect_insight",
]);

const resultTypes = new Set<ExtractionRunResultType>([
  "summary",
  "lesson",
  "memory",
  "semantic",
  "procedural",
  "crystal",
  "insight",
]);

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asTrimmedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const trimmed = asTrimmedString(item);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function buildStageRecords(data: ExtractionRunRecordInput): Array<Omit<ExtractionRunStageRecord, "updatedAt">> {
  const records: Array<Omit<ExtractionRunStageRecord, "updatedAt">> = [];
  const stage = data.stage as ExtractionRunStage | undefined;
  if (stage) {
    records.push({
      stage,
      unitId: asTrimmedString(data.unitId) ?? undefined,
      sourceIds: asTrimmedStringArray(data.sourceIds),
      resultIds: asTrimmedStringArray(data.resultIds),
      resultType: data.resultType as ExtractionRunResultType | undefined,
    });
  }

  const summarySessionId = asTrimmedString(data.summarySessionId);
  if (summarySessionId) {
    records.push({
      stage: "summary",
      unitId: summarySessionId,
      sourceIds: [summarySessionId],
      resultIds: [summarySessionId],
      resultType: "summary",
    });
  }

  const lessonRunId = asTrimmedString(data.lessonRunId);
  if (lessonRunId) {
    records.push({
      stage: "lessons",
      unitId: lessonRunId,
      sourceIds: [],
      resultIds: [lessonRunId],
      resultType: "lesson",
    });
  }

  const semanticWindowId = asTrimmedString(data.semanticWindowId);
  if (semanticWindowId) {
    records.push({
      stage: "semantic_rollup",
      unitId: semanticWindowId,
      sourceIds: [],
      resultIds: [semanticWindowId],
      resultType: "semantic",
    });
  }

  return records;
}

export function registerExtractionRunIndexFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  const store = new ExtractionRunStore(kv);
  sdk.registerFunction("mem::extraction-run-record", async (data: ExtractionRunRecordInput) => {
    const rawData = (data ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(rawData)) {
      if (key.startsWith("_")) continue;
      if (!allowedRecordInputKeys.has(key)) {
        return { success: false, error: `unsupported extraction run record field: ${key}` };
      }
    }
    const runId = asTrimmedString(data?.runId);
    const mark = asTrimmedString(data?.mark);
    const status = data?.status;
    if (!runId || !mark) {
      return { success: false, error: "runId and mark are required" };
    }
    if (Buffer.byteLength(runId) > EXTRACTION_RUN_MAX_ID_BYTES) {
      return {
        success: false,
        error: `runId exceeds ${EXTRACTION_RUN_MAX_ID_BYTES} bytes`,
      };
    }
    if (Buffer.byteLength(mark) > EXTRACTION_RUN_MAX_MARK_BYTES) {
      return {
        success: false,
        error: `mark exceeds ${EXTRACTION_RUN_MAX_MARK_BYTES} bytes`,
      };
    }
    if (status !== undefined && !statuses.has(status as ExtractionRunStatus)) {
      return { success: false, error: "status must be running, succeeded, skipped, failed, or partial" };
    }
    if (data.stage !== undefined && !stages.has(data.stage as ExtractionRunStage)) {
      return { success: false, error: "stage is invalid" };
    }
    if (data.resultType !== undefined && !resultTypes.has(data.resultType as ExtractionRunResultType)) {
      return { success: false, error: "resultType is invalid" };
    }

    const now = new Date().toISOString();
    const records = buildStageRecords(data).map((record) => ({
      ...record,
      updatedAt: now,
    }));
    const summarySessionId = asTrimmedString(data.summarySessionId);
    const lessonRunId = asTrimmedString(data.lessonRunId);
    const semanticWindowId = asTrimmedString(data.semanticWindowId);
    let next;
    try {
      next = await store.record({
        runId,
        mark,
        status: status as ExtractionRunStatus | undefined,
        records,
        summarySessionIds: summarySessionId ? [summarySessionId] : [],
        lessonRunIds: lessonRunId ? [lessonRunId] : [],
        semanticWindowIds: semanticWindowId ? [semanticWindowId] : [],
        updatedAt: now,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const auditDetails = {
      mark,
      status: next.status,
      stage: records.length === 1 ? records[0].stage : undefined,
      unitId: records.length === 1 ? records[0].unitId : undefined,
      recordCount: records.length,
    };
    try {
      await recordExtractionRunAudit(kv, runId, auditDetails, {
        mark,
        requestedStatus: status ?? null,
        records: records.map(({ updatedAt: _updatedAt, ...record }) => record),
        summarySessionId,
        lessonRunId,
        semanticWindowId,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      success: true,
      run: {
        id: next.id,
        mark: next.mark,
        status: next.status,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      },
    };
  });
}
