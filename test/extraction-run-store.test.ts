import { describe, expect, it } from "vitest";

import { ExtractionRunStore } from "../src/functions/extraction-run-store.js";
import { KV } from "../src/state/schema.js";
import type { ExtractionRunIndex, ExtractionRunStageRecord } from "../src/types.js";

interface Operation {
  kind: "get" | "set" | "delete" | "list";
  scope: string;
  key?: string;
}

function trackingKV() {
  const data = new Map<string, Map<string, unknown>>();
  const operations: Operation[] = [];
  let failNextSet: ((scope: string, key: string) => boolean) | null = null;
  let failNextDelete: ((scope: string, key: string) => boolean) | null = null;

  return {
    operations,
    scopeSizes(): Map<string, number> {
      return new Map(Array.from(data, ([scope, entries]) => [scope, entries.size]));
    },
    failOnceOnSet(predicate: (scope: string, key: string) => boolean): void {
      failNextSet = predicate;
    },
    failOnceOnDelete(predicate: (scope: string, key: string) => boolean): void {
      failNextDelete = predicate;
    },
    seed<T>(scope: string, key: string, value: T): void {
      if (!data.has(scope)) data.set(scope, new Map());
      data.get(scope)!.set(key, value);
    },
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      operations.push({ kind: "get", scope, key });
      return (data.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      operations.push({ kind: "set", scope, key });
      if (failNextSet?.(scope, key)) {
        failNextSet = null;
        throw new Error("injected set failure");
      }
      if (!data.has(scope)) data.set(scope, new Map());
      data.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      operations.push({ kind: "delete", scope, key });
      if (failNextDelete?.(scope, key)) {
        failNextDelete = null;
        throw new Error("injected delete failure");
      }
      data.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      operations.push({ kind: "list", scope });
      return Array.from(data.get(scope)?.values() ?? []) as T[];
    },
  };
}

function stageRecord(unitId: string): ExtractionRunStageRecord {
  return {
    stage: "memory_consolidate",
    unitId,
    sourceIds: [`source-${unitId}`],
    resultIds: [`result-${unitId}`],
    resultType: "memory",
    updatedAt: "2026-07-19T01:00:00.000Z",
  };
}

describe("ExtractionRunStore", () => {
  it("writes a new record without reading or rewriting the legacy aggregate", async () => {
    const kv = trackingKV();
    const runId = "full-formal-run";
    const legacy: ExtractionRunIndex = {
      id: runId,
      mark: "full-v1",
      status: "running",
      summarySessionIds: [],
      lessonRunIds: [],
      semanticWindowIds: [],
      stageRecords: [{
        ...stageRecord("legacy-unit"),
        sourceIds: ["x".repeat(2 * 1024 * 1024)],
      }],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    kv.seed(KV.extractionRuns, runId, legacy);
    const store = new ExtractionRunStore(kv);

    await store.record({
      runId,
      mark: "full-v1",
      status: "running",
      records: [stageRecord("new-unit")],
      updatedAt: "2026-07-19T01:00:00.000Z",
    });

    expect(kv.operations.some((op) => op.scope === KV.extractionRuns)).toBe(false);

    kv.operations.length = 0;
    const read = await store.get(runId);
    expect(read?.stageRecords.map((record) => record.unitId)).toEqual([
      "legacy-unit",
      "new-unit",
    ]);
  });

  it("prefers a modern record over a legacy record with the same identity", async () => {
    const kv = trackingKV();
    const runId = "run-modern-wins";
    kv.seed(KV.extractionRuns, runId, {
      id: runId,
      mark: "full-v1",
      status: "running",
      summarySessionIds: [],
      lessonRunIds: [],
      semanticWindowIds: [],
      stageRecords: [{
        ...stageRecord("unit-a"),
        sourceIds: ["legacy-source"],
        resultIds: ["legacy-result"],
      }],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    } satisfies ExtractionRunIndex);
    const store = new ExtractionRunStore(kv);

    await store.record({
      runId,
      mark: "full-v1",
      records: [{
        ...stageRecord("unit-a"),
        sourceIds: ["modern-source"],
        resultIds: ["modern-result"],
      }],
    });

    expect((await store.get(runId))?.stageRecords).toEqual([{
      ...stageRecord("unit-a"),
      sourceIds: ["modern-source"],
      resultIds: ["modern-result"],
    }]);
  });

  it("rolls manifest pages before a scope exceeds 128 records", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    const records = Array.from({ length: 129 }, (_, index) =>
      stageRecord(`unit-${index}`));

    await store.record({
      runId: "run-page-rollover",
      mark: "full-v1",
      records,
      updatedAt: "2026-07-19T01:00:00.000Z",
    });

    const manifestSizes = Array.from(kv.scopeSizes())
      .filter(([scope]) => scope.startsWith("mem:extraction-run-manifest:"))
      .map(([, size]) => size);
    expect(manifestSizes).toEqual([128, 1]);
    expect((await store.get("run-page-rollover"))?.stageRecords).toHaveLength(129);
  });

  it("repairs a missing manifest locator on retry without duplicating the record", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    const input = {
      runId: "run-retry",
      mark: "full-v1",
      records: [stageRecord("unit-a")],
      updatedAt: "2026-07-19T01:00:00.000Z",
    };
    kv.failOnceOnSet((scope) =>
      scope.startsWith("mem:extraction-run-manifest:"));

    await expect(store.record(input)).rejects.toThrow("injected set failure");
    await store.record(input);

    const read = await store.get(input.runId);
    expect(read?.stageRecords).toHaveLength(1);
    expect(read?.stageRecords[0].unitId).toBe("unit-a");
  });

  it("recovers when metadata creation fails after the catalog entry is durable", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    const input = {
      runId: "run-metadata-retry",
      mark: "full-v1",
      records: [stageRecord("unit-a")],
      updatedAt: "2026-07-19T01:00:00.000Z",
    };
    kv.failOnceOnSet((scope, key) =>
      scope.startsWith("mem:extraction-run-metadata:") && key === "metadata");

    await expect(store.record(input)).rejects.toThrow("injected set failure");
    await store.record(input);

    expect((await store.get(input.runId))?.stageRecords).toHaveLength(1);
    const catalogSizes = Array.from(kv.scopeSizes())
      .filter(([scope]) => scope.startsWith("mem:extraction-run-catalog:"))
      .map(([, size]) => size);
    expect(catalogSizes).toEqual([1]);
  });

  it("rolls catalog pages before a scope exceeds 128 runs", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    for (let index = 0; index < 129; index++) {
      await store.record({
        runId: `run-${index}`,
        mark: "full-v1",
        records: [],
        updatedAt: "2026-07-19T01:00:00.000Z",
      });
    }

    const catalogSizes = Array.from(kv.scopeSizes())
      .filter(([scope]) => scope.startsWith("mem:extraction-run-catalog:"))
      .map(([, size]) => size);
    expect(catalogSizes).toEqual([128, 1]);
    expect(await store.list()).toHaveLength(129);
  });

  it("preserves legacy compatibility ids independently from stage results", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    await store.replace({
      id: "run-compatibility",
      mark: "full-v1",
      status: "succeeded",
      summarySessionIds: ["session-a"],
      lessonRunIds: [],
      semanticWindowIds: [],
      stageRecords: [{
        stage: "summary",
        unitId: "session-a",
        sourceIds: ["session-a"],
        resultIds: ["summary-result-a"],
        resultType: "summary",
        updatedAt: "2026-07-19T01:00:00.000Z",
      }],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T01:00:00.000Z",
    });

    const read = await store.get("run-compatibility");
    expect(read?.summarySessionIds).toEqual(["session-a"]);
    expect(read?.stageRecords[0].resultIds).toEqual(["summary-result-a"]);
  });

  it("fails closed when a manifest locator points to a missing record", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    await store.record({
      runId: "run-missing-record",
      mark: "full-v1",
      records: [stageRecord("unit-a")],
    });
    const recordScope = kv.operations.find(
      (operation) =>
        operation.kind === "set"
        && operation.scope.startsWith("mem:extraction-run-record:"),
    )?.scope;
    expect(recordScope).toBeDefined();
    await kv.delete(recordScope!, "record");

    await expect(store.get("run-missing-record")).rejects.toThrow(
      "manifest references missing record",
    );
  });

  it("rejects a conflicting mark for an existing modern run", async () => {
    const store = new ExtractionRunStore(trackingKV());
    await store.record({
      runId: "run-mark",
      mark: "full-v1",
      records: [],
    });

    await expect(store.record({
      runId: "run-mark",
      mark: "full-v2",
      records: [],
    })).rejects.toThrow("mark mismatch");
  });

  it("rejects a merge that would exceed the persisted record limit", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    const almostLimit = "x".repeat(1024 * 1024 - 400);
    await store.record({
      runId: "run-record-limit",
      mark: "full-v1",
      records: [{
        ...stageRecord("unit-a"),
        sourceIds: [almostLimit],
      }],
    });

    await expect(store.record({
      runId: "run-record-limit",
      mark: "full-v1",
      records: [{
        ...stageRecord("unit-a"),
        resultIds: [almostLimit],
      }],
    })).rejects.toThrow("extraction run record exceeds 1048576 bytes");
  });

  it("does not interleave replace with record for the same run", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    const replacement: ExtractionRunIndex = {
      id: "run-replace",
      mark: "full-v1",
      status: "succeeded",
      summarySessionIds: [],
      lessonRunIds: [],
      semanticWindowIds: [],
      stageRecords: [stageRecord("replacement")],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T01:00:00.000Z",
    };

    await Promise.all([
      store.replace(replacement),
      store.record({
        runId: replacement.id,
        mark: replacement.mark,
        records: [stageRecord("concurrent")],
      }),
    ]);

    const read = await store.get(replacement.id);
    expect(read?.stageRecords.map((record) => record.unitId).sort()).toEqual(
      ["concurrent", "replacement"],
    );
  });

  it("converges when deletion fails after a run is discoverable", async () => {
    const kv = trackingKV();
    const store = new ExtractionRunStore(kv);
    await store.record({
      runId: "run-delete-retry",
      mark: "full-v1",
      records: [stageRecord("unit-a")],
    });
    kv.failOnceOnDelete((scope) =>
      scope.startsWith("mem:extraction-run-record:"));

    await expect(store.delete("run-delete-retry")).rejects.toThrow(
      "injected delete failure",
    );
    await store.delete("run-delete-retry");

    expect(await store.get("run-delete-retry")).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
