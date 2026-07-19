import type { ISdk } from "iii-sdk";
import type {
  ExtractionRunIndex,
  ExtractionRunResultType,
  ExtractionRunStage,
  ExtractionRunStageRecord,
  ExtractionRunStatus,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit } from "./audit.js";

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

function addUnique(values: string[], value: string | null): string[] {
  if (!value || values.includes(value)) return values;
  return [...values, value];
}

function addUniqueMany(values: string[], next: string[]): string[] {
  let out = values;
  for (const value of next) {
    out = addUnique(out, value);
  }
  return out;
}

function upsertStageRecord(
  records: ExtractionRunStageRecord[],
  record: Omit<ExtractionRunStageRecord, "updatedAt">,
  updatedAt: string,
): ExtractionRunStageRecord[] {
  const unitId = record.unitId ?? "";
  const existingIndex = records.findIndex(
    (entry) => entry.stage === record.stage && (entry.unitId ?? "") === unitId,
  );
  if (existingIndex === -1) {
    return [
      ...records,
      {
        ...record,
        sourceIds: addUniqueMany([], record.sourceIds),
        resultIds: addUniqueMany([], record.resultIds),
        updatedAt,
      },
    ];
  }

  return records.map((entry, index) => {
    if (index !== existingIndex) return entry;
    return {
      ...entry,
      sourceIds: addUniqueMany(entry.sourceIds, record.sourceIds),
      resultIds: addUniqueMany(entry.resultIds, record.resultIds),
      resultType: record.resultType ?? entry.resultType,
      updatedAt,
    };
  });
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
    if (status !== undefined && !statuses.has(status as ExtractionRunStatus)) {
      return { success: false, error: "status must be running, succeeded, skipped, failed, or partial" };
    }
    if (data.stage !== undefined && !stages.has(data.stage as ExtractionRunStage)) {
      return { success: false, error: "stage is invalid" };
    }
    if (data.resultType !== undefined && !resultTypes.has(data.resultType as ExtractionRunResultType)) {
      return { success: false, error: "resultType is invalid" };
    }

    return withKeyedLock(`extraction-run:${runId}`, async () => {
      const now = new Date().toISOString();
      const existing = await kv.get<ExtractionRunIndex>(KV.extractionRuns, runId);
      const stageRecords = buildStageRecords(data).reduce(
        (records, record) => upsertStageRecord(records, record, now),
        existing?.stageRecords ?? [],
      );
      const next: ExtractionRunIndex = {
        id: runId,
        mark,
        status: (status as ExtractionRunStatus | undefined) ?? existing?.status ?? "running",
        summarySessionIds: addUnique(
          existing?.summarySessionIds ?? [],
          asTrimmedString(data.summarySessionId),
        ),
        lessonRunIds: addUnique(
          existing?.lessonRunIds ?? [],
          asTrimmedString(data.lessonRunId),
        ),
        semanticWindowIds: addUnique(
          existing?.semanticWindowIds ?? [],
          asTrimmedString(data.semanticWindowId),
        ),
        stageRecords,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await kv.set(KV.extractionRuns, runId, next);
      await recordAudit(
        kv,
        "extraction_run_record",
        "mem::extraction-run-record",
        [runId],
        {
          mark,
          status: next.status,
          summarySessionId: asTrimmedString(data.summarySessionId),
          lessonRunId: asTrimmedString(data.lessonRunId),
          semanticWindowId: asTrimmedString(data.semanticWindowId),
          stage: stages.has(data.stage as ExtractionRunStage) ? data.stage : undefined,
          unitId: asTrimmedString(data.unitId),
          sourceIds: asTrimmedStringArray(data.sourceIds),
          resultIds: asTrimmedStringArray(data.resultIds),
          resultType: resultTypes.has(data.resultType as ExtractionRunResultType) ? data.resultType : undefined,
        },
      );

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
  });
}
