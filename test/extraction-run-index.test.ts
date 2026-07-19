import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExtractionRunIndexFunction } from "../src/functions/extraction-run-index.js";
import { KV } from "../src/state/schema.js";
import type { ExtractionRunIndex } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("mem::extraction-run-record", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerExtractionRunIndexFunction(sdk as never, kv as never);
  });

  it("returns a bounded acknowledgement for a large existing run index", async () => {
    const runId = "run-large-response";
    const timestamp = "2026-07-19T00:00:00.000Z";
    await kv.set<ExtractionRunIndex>(KV.extractionRuns, runId, {
      id: runId,
      mark: "full-v1",
      status: "running",
      summarySessionIds: [],
      lessonRunIds: [],
      semanticWindowIds: [],
      stageRecords: [{
        stage: "memory_consolidate",
        unitId: "existing-unit",
        sourceIds: ["x".repeat(2 * 1024 * 1024)],
        resultIds: ["existing-result"],
        resultType: "memory",
        updatedAt: timestamp,
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const result = await sdk.trigger("mem::extraction-run-record", {
      runId,
      mark: "full-v1",
      status: "succeeded",
      stage: "memory_consolidate",
      unitId: "next-unit",
      sourceIds: ["next-source"],
      resultIds: ["next-result"],
      resultType: "memory",
    });

    expect(JSON.stringify(result).length).toBeLessThan(2048);
    expect(result).toMatchObject({
      success: true,
      run: {
        id: runId,
        mark: "full-v1",
        status: "succeeded",
      },
    });
    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, runId);
    expect(stored?.stageRecords).toHaveLength(2);
  });

  it("keeps legacy summary lesson and semantic fields while writing stage records", async () => {
    await sdk.trigger("mem::extraction-run-record", {
      runId: "run-1",
      mark: "full-2026-07",
      status: "running",
      summarySessionId: "ses-a",
      lessonRunId: "lesson-a",
      semanticWindowId: "win-a",
    });
    const result = (await sdk.trigger("mem::extraction-run-record", {
      runId: "run-1",
      mark: "full-2026-07",
      status: "partial",
      summarySessionId: "ses-a",
      lessonRunId: "lesson-a",
      semanticWindowId: "win-a",
    })) as { success: boolean; run: Pick<ExtractionRunIndex, "id" | "mark" | "status"> };

    expect(result.success).toBe(true);
    expect(result.run).toMatchObject({
      id: "run-1",
      mark: "full-2026-07",
      status: "partial",
    });

    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-1");
    expect(stored).toMatchObject({
      summarySessionIds: ["ses-a"],
      lessonRunIds: ["lesson-a"],
      semanticWindowIds: ["win-a"],
    });
    expect(stored).not.toHaveProperty("corpusWindowIds");
    expect(stored?.stageRecords).toMatchObject([
      {
        stage: "summary",
        unitId: "ses-a",
        sourceIds: ["ses-a"],
        resultIds: ["ses-a"],
        resultType: "summary",
      },
      {
        stage: "lessons",
        unitId: "lesson-a",
        sourceIds: [],
        resultIds: ["lesson-a"],
        resultType: "lesson",
      },
      {
        stage: "semantic_rollup",
        unitId: "win-a",
        sourceIds: [],
        resultIds: ["win-a"],
        resultType: "semantic",
      },
    ]);

    const audits = await kv.list<{ operation: string; targetIds: string[] }>(KV.audit);
    expect(audits.map((entry) => entry.operation)).toEqual([
      "extraction_run_record",
      "extraction_run_record",
    ]);
    expect(audits[1].targetIds).toEqual(["run-1"]);
  });

  it("serializes concurrent legacy updates for the same run id without corpus fields", async () => {
    await Promise.all([
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        summarySessionId: "ses-a",
      }),
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        lessonRunId: "lesson-a",
      }),
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        semanticWindowId: "win-a",
      }),
    ]);

    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-concurrent");
    expect(stored).toMatchObject({
      id: "run-concurrent",
      summarySessionIds: ["ses-a"],
      lessonRunIds: ["lesson-a"],
      semanticWindowIds: ["win-a"],
    });
    expect(stored).not.toHaveProperty("corpusWindowIds");
    expect(stored?.stageRecords.map((record) => record.stage).sort()).toEqual([
      "lessons",
      "semantic_rollup",
      "summary",
    ]);
  });

  it("rejects legacy corpusWindowId", async () => {
    await expect(
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-corpus",
        mark: "full-v1",
        corpusWindowId: "corpus-a",
      }),
    ).resolves.toEqual({
      success: false,
      error: "unsupported extraction run record field: corpusWindowId",
    });

    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-corpus");
    expect(stored).toBeNull();
  });

  it("ignores iii runtime metadata fields injected into trigger payloads", async () => {
    const result = (await sdk.trigger("mem::extraction-run-record", {
      runId: "run-runtime-meta",
      mark: "full-v1",
      summarySessionId: "ses-a",
      _caller_worker_id: "worker-a",
    })) as { success: boolean; run: Pick<ExtractionRunIndex, "id" | "mark" | "status"> };

    expect(result.success).toBe(true);
    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-runtime-meta");
    expect(stored?.summarySessionIds).toEqual(["ses-a"]);
  });

  it("accumulates generic stage records with deduplicated source and result ids", async () => {
    await sdk.trigger("mem::extraction-run-record", {
      runId: "run-stages",
      mark: "full-v1",
      stage: "memory_consolidate",
      unitId: "mem-unit-1",
      sourceIds: ["obs-a", "obs-b", "obs-a", ""],
      resultIds: ["mem-a"],
      resultType: "memory",
    });

    const result = (await sdk.trigger("mem::extraction-run-record", {
      runId: "run-stages",
      mark: "full-v1",
      stage: "memory_consolidate",
      unitId: "mem-unit-1",
      sourceIds: ["obs-b", "obs-c"],
      resultIds: ["mem-a", "mem-b"],
      resultType: "memory",
    })) as { success: boolean; run: Pick<ExtractionRunIndex, "id" | "mark" | "status"> };

    expect(result.success).toBe(true);
    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-stages");
    expect(stored?.stageRecords).toHaveLength(1);
    expect(stored?.stageRecords[0]).toMatchObject({
      stage: "memory_consolidate",
      unitId: "mem-unit-1",
      sourceIds: ["obs-a", "obs-b", "obs-c"],
      resultIds: ["mem-a", "mem-b"],
      resultType: "memory",
    });
  });

  it("rejects invalid generic stage fields", async () => {
    await expect(
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-invalid",
        mark: "full-v1",
        stage: "corpus_rollup",
      }),
    ).resolves.toEqual({ success: false, error: "stage is invalid" });

    await expect(
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-invalid",
        mark: "full-v1",
        stage: "summary",
        resultType: "corpus",
      }),
    ).resolves.toEqual({ success: false, error: "resultType is invalid" });
  });
});
