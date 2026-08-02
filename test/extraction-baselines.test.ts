import { describe, expect, it } from "vitest";
import type {
  AdoptedBaselineCoverageRecord,
  AdoptedBaselineLessonSeedRecord,
} from "../src/types.js";
import type { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  appendAdoptedBaselineCoverage,
  appendAdoptedBaselineLessonSeeds,
  digestAdoptedBaselineCoverage,
  digestAdoptedBaselineLessonSeeds,
  inspectAdoptedBaselineRun,
  partitionAdoptedBaselineSessions,
  prepareAdoptedBaseline,
  sealAdoptedBaseline,
} from "../src/functions/extraction-baselines.js";

class MemoryKV {
  private readonly scopes = new Map<string, Map<string, unknown>>();

  async get<T>(scope: string, key: string): Promise<T | null> {
    return (this.scopes.get(scope)?.get(key) as T | undefined) ?? null;
  }

  async set<T>(scope: string, key: string, value: T): Promise<T> {
    let entries = this.scopes.get(scope);
    if (!entries) {
      entries = new Map();
      this.scopes.set(scope, entries);
    }
    entries.set(key, value);
    return value;
  }

  async delete(scope: string, key: string): Promise<void> {
    this.scopes.get(scope)?.delete(key);
  }

  async list<T>(scope: string): Promise<T[]> {
    return [...(this.scopes.get(scope)?.values() ?? [])] as T[];
  }
}

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

function expectedCoverage(
  summaryRecords: AdoptedBaselineCoverageRecord[],
) {
  const empty = digestAdoptedBaselineCoverage([]);
  return {
    summary: {
      stageContractVersion: "summary/v1",
      count: summaryRecords.length,
      digest: digestAdoptedBaselineCoverage(summaryRecords),
    },
    lessons: { stageContractVersion: "lessons/v1", count: 0, digest: empty },
    memory_consolidate: {
      stageContractVersion: "memory_consolidate/v1",
      count: 0,
      digest: empty,
    },
    semantic_rollup: {
      stageContractVersion: "semantic-rollup/v1",
      count: 0,
      digest: empty,
    },
    skill_extract: { stageContractVersion: "skill_extract/v1", count: 0, digest: empty },
  };
}

function coverage(baselineId = "baseline-1"): AdoptedBaselineCoverageRecord[] {
  return [
    {
      baselineId,
      stage: "summary",
      stageContractVersion: "summary/v1",
      sessionId: "session-old",
      normalizedContentHash: H1,
    },
    {
      baselineId,
      stage: "summary",
      stageContractVersion: "summary/v1",
      sessionId: "session-current",
      normalizedContentHash: H2,
    },
  ];
}

function lessonSeeds(baselineId = "baseline-1"): AdoptedBaselineLessonSeedRecord[] {
  return [{
    baselineId,
    lessonId: "lesson-current",
    sourceVersionKey: `reflect_insight|lesson|lesson-current|${H3}`,
    normalizedContentHash: H3,
  }];
}

describe("adopted extraction baseline", () => {
  it("seals exact preview sets, retires the old run, and partitions later plans", async () => {
    const kv = new MemoryKV() as unknown as StateKV;
    const records = coverage();
    const seeds = lessonSeeds();
    await prepareAdoptedBaseline(kv, {
      id: "baseline-1",
      sourceRunId: "old-run",
      retiredRunIds: ["old-run"],
      decisionRef: "MYC-122",
      expectedCoverage: expectedCoverage(records),
      expectedLessonSeed: {
        count: seeds.length,
        digest: digestAdoptedBaselineLessonSeeds(seeds),
      },
      naturalBoundaryStages: ["crystal", "consolidation_procedural"],
    });
    expect(await appendAdoptedBaselineCoverage(kv, "baseline-1", records)).toEqual({
      written: 2,
      existing: 0,
    });
    expect(await appendAdoptedBaselineCoverage(kv, "baseline-1", records)).toEqual({
      written: 0,
      existing: 2,
    });
    await appendAdoptedBaselineLessonSeeds(kv, "baseline-1", seeds);
    const materialized: AdoptedBaselineLessonSeedRecord[] = [];
    const manifest = await sealAdoptedBaseline(kv, "baseline-1", async (items) => {
      materialized.push(...items);
    });
    expect(manifest.state).toBe("sealed");
    expect(materialized).toEqual(seeds);
    await expect(inspectAdoptedBaselineRun(kv, "old-run")).resolves.toEqual({
      baselineId: "baseline-1",
      retired: true,
    });
    await expect(partitionAdoptedBaselineSessions(kv, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      sessionIds: ["session-old", "session-new", "session-current"],
    })).resolves.toEqual({
      baselineId: "baseline-1",
      adoptedSessionIds: ["session-old", "session-current"],
      openSessionIds: ["session-new"],
    });
  });

  it("does not activate a partial or drifted baseline", async () => {
    const kv = new MemoryKV() as unknown as StateKV;
    const records = coverage("baseline-partial");
    await prepareAdoptedBaseline(kv, {
      id: "baseline-partial",
      sourceRunId: "old-run",
      retiredRunIds: ["old-run"],
      decisionRef: "MYC-122",
      expectedCoverage: expectedCoverage(records),
      expectedLessonSeed: {
        count: 0,
        digest: digestAdoptedBaselineLessonSeeds([]),
      },
      naturalBoundaryStages: ["consolidation_procedural", "crystal"],
    });
    await appendAdoptedBaselineCoverage(kv, "baseline-partial", records.slice(0, 1));
    await expect(sealAdoptedBaseline(kv, "baseline-partial", async () => {}))
      .rejects.toThrow("adopted_baseline_coverage_mismatch:summary");
    await expect(inspectAdoptedBaselineRun(kv, "old-run")).resolves.toEqual({
      baselineId: null,
      retired: false,
    });
  });

  it("fails closed when an active baseline contract differs from the planner", async () => {
    const kv = new MemoryKV() as unknown as StateKV;
    const records = coverage();
    await prepareAdoptedBaseline(kv, {
      id: "baseline-1",
      sourceRunId: "old-run",
      retiredRunIds: ["old-run"],
      decisionRef: "MYC-122",
      expectedCoverage: expectedCoverage(records),
      expectedLessonSeed: { count: 0, digest: digestAdoptedBaselineLessonSeeds([]) },
      naturalBoundaryStages: ["crystal", "consolidation_procedural"],
    });
    await appendAdoptedBaselineCoverage(kv, "baseline-1", records);
    await sealAdoptedBaseline(kv, "baseline-1", async () => {});
    await expect(partitionAdoptedBaselineSessions(kv, {
      stage: "summary",
      stageContractVersion: "summary/v2",
      sessionIds: ["session-old"],
    })).rejects.toThrow("adopted_baseline_contract_migration_required");
  });

  it("bounds StateKV reads while partitioning a large adopted session set", async () => {
    const rawKv = new MemoryKV();
    const records = Array.from({ length: 130 }, (_, index): AdoptedBaselineCoverageRecord => ({
      baselineId: "baseline-bounded",
      stage: "summary",
      stageContractVersion: "summary/v1",
      sessionId: `session-${index}`,
      normalizedContentHash: H1,
    }));
    const kv = rawKv as unknown as StateKV;
    await prepareAdoptedBaseline(kv, {
      id: "baseline-bounded",
      sourceRunId: "old-run",
      retiredRunIds: ["old-run"],
      decisionRef: "MYC-122",
      expectedCoverage: expectedCoverage(records),
      expectedLessonSeed: { count: 0, digest: digestAdoptedBaselineLessonSeeds([]) },
      naturalBoundaryStages: ["crystal", "consolidation_procedural"],
    });
    await appendAdoptedBaselineCoverage(kv, "baseline-bounded", records.slice(0, 100));
    await appendAdoptedBaselineCoverage(kv, "baseline-bounded", records.slice(100));
    await sealAdoptedBaseline(kv, "baseline-bounded", async () => {});

    let activeReads = 0;
    let maxActiveReads = 0;
    const coverageScope = KV.extractionAdoptedBaselineCoverage("baseline-bounded", "summary");
    const measuredKv = {
      get: async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope !== coverageScope) return rawKv.get<T>(scope, key);
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const value = await rawKv.get<T>(scope, key);
        activeReads -= 1;
        return value;
      },
      set: rawKv.set.bind(rawKv),
      delete: rawKv.delete.bind(rawKv),
      list: rawKv.list.bind(rawKv),
    } as unknown as StateKV;

    const partition = await partitionAdoptedBaselineSessions(measuredKv, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      sessionIds: records.map((record) => record.sessionId),
    });
    expect(partition.adoptedSessionIds).toHaveLength(records.length);
    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(64);
  });
});
