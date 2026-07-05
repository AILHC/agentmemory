import type { ISdk } from "iii-sdk";
import type {
  ExtractionRunIndex,
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
  summarySessionId?: unknown;
  lessonRunId?: unknown;
  semanticWindowId?: unknown;
  corpusWindowId?: unknown;
}

const statuses = new Set<ExtractionRunStatus>([
  "running",
  "succeeded",
  "failed",
  "partial",
]);

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function addUnique(values: string[], value: string | null): string[] {
  if (!value || values.includes(value)) return values;
  return [...values, value];
}

export function registerExtractionRunIndexFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::extraction-run-record", async (data: ExtractionRunRecordInput) => {
    const runId = asTrimmedString(data?.runId);
    const mark = asTrimmedString(data?.mark);
    const status = data?.status;
    if (!runId || !mark) {
      return { success: false, error: "runId and mark are required" };
    }
    if (status !== undefined && !statuses.has(status as ExtractionRunStatus)) {
      return { success: false, error: "status must be running, succeeded, failed, or partial" };
    }

    return withKeyedLock(`extraction-run:${runId}`, async () => {
      const now = new Date().toISOString();
      const existing = await kv.get<ExtractionRunIndex>(KV.extractionRuns, runId);
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
        corpusWindowIds: addUnique(
          existing?.corpusWindowIds ?? [],
          asTrimmedString(data.corpusWindowId),
        ),
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
          corpusWindowId: asTrimmedString(data.corpusWindowId),
        },
      );

      return { success: true, run: next };
    });
  });
}
