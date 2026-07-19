import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordAudit, recordExtractionRunAudit, queryAudit } from "../src/functions/audit.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const operations: Array<{ kind: string; scope: string }> = [];
  let failNextSet: ((scope: string, key: string) => boolean) | null = null;
  return {
    operations,
    scopeSizes: () =>
      new Map(Array.from(store, ([scope, entries]) => [scope, entries.size])),
    failOnceOnSet(predicate: (scope: string, key: string) => boolean): void {
      failNextSet = predicate;
    },
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      operations.push({ kind: "get", scope });
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      operations.push({ kind: "set", scope });
      if (failNextSet?.(scope, key)) {
        failNextSet = null;
        throw new Error("injected set failure");
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      operations.push({ kind: "delete", scope });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      operations.push({ kind: "list", scope });
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

describe("Audit Functions", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("recordAudit creates an entry with proper fields", async () => {
    const entry = await recordAudit(
      kv as never,
      "observe",
      "mem::compress",
      ["obs_1", "obs_2"],
      { count: 2 },
      0.85,
      "user-1",
    );

    expect(entry.id).toMatch(/^aud_/);
    expect(entry.timestamp).toBeDefined();
    expect(entry.operation).toBe("observe");
    expect(entry.functionId).toBe("mem::compress");
    expect(entry.targetIds).toEqual(["obs_1", "obs_2"]);
    expect(entry.details).toEqual({ count: 2 });
    expect(entry.qualityScore).toBe(0.85);
    expect(entry.userId).toBe("user-1");
  });

  it("queryAudit returns entries sorted by timestamp desc", async () => {
    await recordAudit(kv as never, "observe", "fn1", ["a"], {});
    await new Promise((r) => setTimeout(r, 10));
    await recordAudit(kv as never, "delete", "fn2", ["b"], {});

    const entries = await queryAudit(kv as never);
    expect(entries.length).toBe(2);
    expect(
      new Date(entries[0].timestamp).getTime(),
    ).toBeGreaterThanOrEqual(new Date(entries[1].timestamp).getTime());
  });

  it("queryAudit filters by operation", async () => {
    await recordAudit(kv as never, "observe", "fn1", [], {});
    await recordAudit(kv as never, "delete", "fn2", [], {});
    await recordAudit(kv as never, "observe", "fn3", [], {});

    const entries = await queryAudit(kv as never, { operation: "observe" });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.operation === "observe")).toBe(true);
  });

  it("queryAudit filters by dateFrom/dateTo", async () => {
    const early = await recordAudit(kv as never, "observe", "fn1", [], {});
    await new Promise((r) => setTimeout(r, 20));
    const late = await recordAudit(kv as never, "delete", "fn2", [], {});

    const entries = await queryAudit(kv as never, {
      dateFrom: late.timestamp,
    });
    expect(entries.length).toBe(1);
    expect(entries[0].operation).toBe("delete");

    const entriesBefore = await queryAudit(kv as never, {
      dateTo: early.timestamp,
    });
    expect(entriesBefore.length).toBe(1);
    expect(entriesBefore[0].operation).toBe("observe");
  });

  it("queryAudit respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await recordAudit(kv as never, "observe", `fn${i}`, [], {});
    }

    const entries = await queryAudit(kv as never, { limit: 3 });
    expect(entries.length).toBe(3);
  });

  it("stores extraction audit events deterministically without reading run snapshots", async () => {
    const details = { mark: "full-v1", status: "succeeded" };
    await recordExtractionRunAudit(kv as never, "run-1", details);
    kv.operations.length = 0;
    await recordExtractionRunAudit(kv as never, "run-1", details);
    expect(kv.operations.some(
      (operation) =>
        operation.kind === "list"
        && operation.scope.startsWith("mem:extraction-run-audit-manifest:"),
    )).toBe(false);

    const entries = await queryAudit(kv as never, {
      operation: "extraction_run_record",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operation: "extraction_run_record",
      targetIds: ["run-1"],
      details,
    });
  });

  it("includes legacy extraction events when filtering the combined audit", async () => {
    await recordAudit(
      kv as never,
      "extraction_run_record",
      "mem::extraction-run-record",
      ["legacy-run"],
      { mark: "legacy" },
    );
    await recordExtractionRunAudit(kv as never, "modern-run", {
      mark: "modern",
    });

    const entries = await queryAudit(kv as never, {
      operation: "extraction_run_record",
    });

    expect(entries.map((entry) => entry.targetIds[0]).sort()).toEqual([
      "legacy-run",
      "modern-run",
    ]);
  });

  it("repairs an extraction audit manifest after a partial write", async () => {
    const details = { mark: "full-v1", status: "succeeded" };
    kv.failOnceOnSet((scope) =>
      scope.startsWith("mem:extraction-run-audit-manifest:"));

    await expect(
      recordExtractionRunAudit(kv as never, "run-partial", details),
    ).rejects.toThrow("injected set failure");
    await recordExtractionRunAudit(kv as never, "run-partial", details);

    const entries = await queryAudit(kv as never, {
      operation: "extraction_run_record",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].targetIds).toEqual(["run-partial"]);
  });

  it("paginates extraction audit events before a scope exceeds 128 entries", async () => {
    for (let index = 0; index < 129; index++) {
      await recordExtractionRunAudit(kv as never, `run-${index}`, {
        mark: "full-v1",
        status: "running",
      });
    }

    const entries = await queryAudit(kv as never, {
      operation: "extraction_run_record",
      limit: 200,
    });
    expect(entries).toHaveLength(129);
    const pageSizes = Array.from(kv.scopeSizes())
      .filter(([scope]) =>
        scope.startsWith("mem:extraction-run-audit-manifest:"))
      .map(([, size]) => size);
    expect(pageSizes).toEqual([128, 1]);
  });
});
