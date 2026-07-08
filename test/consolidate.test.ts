import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  planConsolidateObservationWindows,
  runConsolidateObservationWindow,
} from "../src/functions/consolidate.js";
import {
  getMemoryConsolidateCompressTimeoutMs,
  getWorkerInvocationTimeoutMs,
} from "../src/config.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, Session } from "../src/types.js";

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

function session(id: string): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo",
    startedAt: "2026-07-01T00:00:00.000Z",
    status: "completed",
    observationCount: 12,
  };
}

function observation(id: string, importance: number): CompressedObservation {
  return {
    id,
    sessionId: "ses-a",
    timestamp: "2026-07-01T00:00:00.000Z",
    type: "decision",
    title: `Observation ${id}`,
    facts: [],
    narrative: `Narrative ${id}`,
    concepts: ["windows"],
    files: [`file-${id}.ts`],
    importance,
  };
}

describe("consolidate full window helpers", () => {
  afterEach(() => {
    delete process.env.AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("plans all eligible concept windows", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    for (let i = 0; i < 4; i++) {
      const obs = observation(`obs-${i}`, 6);
      await kv.set(KV.observations("ses-a"), obs.id, obs);
    }

    const result = await planConsolidateObservationWindows({
      kv: kv as never,
      minObservations: 3,
    });

    expect(result.success).toBe(true);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({
      concept: "windows",
      observationCount: 4,
    });
  });

  it("bounds AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS config", () => {
    expect(getMemoryConsolidateCompressTimeoutMs({
      AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS: "not-a-number",
    })).toBe(30_000);
    expect(getMemoryConsolidateCompressTimeoutMs({
      AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS: "0",
    })).toBe(30_000);
    expect(getMemoryConsolidateCompressTimeoutMs({
      AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS: "999999",
    })).toBe(300_000);
  });

  it("bounds AGENTMEMORY_WORKER_INVOCATION_TIMEOUT_MS config", () => {
    expect(getWorkerInvocationTimeoutMs({
      AGENTMEMORY_WORKER_INVOCATION_TIMEOUT_MS: "not-a-number",
    })).toBe(3_600_000);
    expect(getWorkerInvocationTimeoutMs({
      AGENTMEMORY_WORKER_INVOCATION_TIMEOUT_MS: "0",
    })).toBe(3_600_000);
    expect(getWorkerInvocationTimeoutMs({
      AGENTMEMORY_WORKER_INVOCATION_TIMEOUT_MS: "180000",
    })).toBe(180_000);
    expect(getWorkerInvocationTimeoutMs({
      AGENTMEMORY_WORKER_INVOCATION_TIMEOUT_MS: "99999999",
    })).toBe(7_200_000);
  });

  it("splits concept observations into stable windows without dropping eligible observations", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    for (let i = 0; i < 7; i++) {
      const obs = observation(`obs-${i}`, 20 - i);
      await kv.set(KV.observations("ses-a"), obs.id, obs);
    }

    const result = await planConsolidateObservationWindows({
      kv: kv as never,
      minObservations: 3,
      maxObservationsPerWindow: 3,
    });

    expect(result.success).toBe(true);
    expect(result.windows.map((window) => window.windowId)).toEqual([
      "memory-consolidate:windows:1",
      "memory-consolidate:windows:2",
      "memory-consolidate:windows:3",
    ]);
    expect(result.windows.map((window) => window.observationCount)).toEqual([3, 3, 1]);
    expect(result.windows.flatMap((window) => window.observationIds)).toEqual([
      "obs-0",
      "obs-1",
      "obs-2",
      "obs-3",
      "obs-4",
      "obs-5",
      "obs-6",
    ]);
  });

  it("applies charBudget when planning concept windows", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    for (let i = 0; i < 5; i++) {
      const obs = {
        ...observation(`obs-${i}`, 20 - i),
        narrative: `Narrative ${i} ${"x".repeat(90)}`,
      };
      await kv.set(KV.observations("ses-a"), obs.id, obs);
    }

    const result = await planConsolidateObservationWindows({
      kv: kv as never,
      minObservations: 3,
      charBudget: 250,
    });

    expect(result.success).toBe(true);
    expect(result.charBudget).toBe(250);
    expect(result.budgetApplied).toBe(true);
    expect(result.windows.length).toBeGreaterThan(1);
    for (const window of result.windows) {
      expect(window.observationEstimatedChars).toBeTruthy();
      if (window.observationCount > 1) {
        expect(window.estimatedChars).toBeLessThanOrEqual(250);
      }
    }
    expect(result.maxWindowEstimatedChars).toBeLessThanOrEqual(250);
    expect(result.overBudgetWindowCount).toBe(0);
  });

  it("marks a single oversized observation without recursively splitting it", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    const huge = {
      ...observation("huge", 10),
      narrative: "x".repeat(400),
    };
    await kv.set(KV.observations("ses-a"), huge.id, huge);

    const result = await planConsolidateObservationWindows({
      kv: kv as never,
      minObservations: 1,
      charBudget: 120,
    });

    expect(result.success).toBe(true);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({
      observationIds: ["huge"],
      overBudget: true,
      overBudgetReason: "single_observation",
      charBudget: 120,
      budgetApplied: true,
    });
    expect(result.overBudgetWindowCount).toBe(1);
  });

  it("plans remaining eligible observations that do not meet concept frequency", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    const observations = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `major-${i}`, concepts: ["major"] })),
      { id: "rare-1", concepts: ["rare"] },
      { id: "rare-2", concepts: ["other-rare"] },
      { id: "empty-1", concepts: [] },
      { id: "empty-2", concepts: [] },
    ];
    for (const item of observations) {
      const obs = { ...observation(item.id, 6), concepts: item.concepts };
      await kv.set(KV.observations("ses-a"), obs.id, obs);
    }

    const result = await planConsolidateObservationWindows({
      kv: kv as never,
      minObservations: 3,
      maxObservationsPerWindow: 3,
    });

    expect(result.success).toBe(true);
    const plannedIds = result.windows.flatMap((window) => window.sourceObservationIds);
    expect(new Set(plannedIds)).toEqual(new Set(observations.map((item) => item.id)));
    expect(result.windows.some((window) => window.concept === "remaining-observations")).toBe(true);
  });

  it("runs a full window without the regular top-8 observation limit", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    for (let i = 0; i < 12; i++) {
      const obs = observation(`obs-${i}`, 20 - i);
      await kv.set(KV.observations("ses-a"), obs.id, obs);
    }
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      summarize: vi.fn(),
      compress: vi.fn().mockResolvedValue(`
<memory>
  <type>pattern</type>
  <title>Window Pattern</title>
  <content>Full window content.</content>
  <concepts><concept>windows</concept></concepts>
  <files><file>file.ts</file></files>
  <strength>8</strength>
</memory>`),
    };

    const result = await runConsolidateObservationWindow({
      kv: kv as never,
      provider,
      concept: "windows",
      minObservations: 3,
      model: "memory-model",
    });

    expect(result.success).toBe(true);
    expect(result.consolidated).toBe(1);
    expect(result.memoryIds).toEqual([expect.stringMatching(/^mem_/)]);
    expect(result).toMatchObject({
      stage: "memory_consolidate",
      model: "memory-model",
      modelSource: "explicitModel",
      provider: "pi-agent-sdk",
      modelApplied: true,
      parseFailures: 0,
    });
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(provider.compress).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Observation obs-11"),
      expect.objectContaining({ model: "memory-model" }),
    );
    const stored = await kv.list(KV.memories);
    expect(stored).toHaveLength(1);
  });

  it("uses AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS for full window compress timeout", async () => {
    vi.useFakeTimers();
    process.env.AGENTMEMORY_MEMORY_CONSOLIDATE_COMPRESS_TIMEOUT_MS = "1";
    const kv = mockKV();
    await kv.set(KV.sessions, "ses-a", session("ses-a"));
    for (let i = 0; i < 3; i++) {
      const obs = observation(`obs-${i}`, 20 - i);
      await kv.set(KV.observations("ses-a"), obs.id, obs);
    }
    const provider: MemoryProvider = {
      name: "test",
      summarize: vi.fn(),
      compress: vi.fn(() => new Promise<string>(() => {})),
    };

    const pending = runConsolidateObservationWindow({
      kv: kv as never,
      provider,
      concept: "windows",
      minObservations: 3,
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await Promise.race([
      pending,
      Promise.resolve(null),
    ]);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("compress timeout"),
    });
    expect((result as Record<string, unknown>).durationMs).toBeGreaterThanOrEqual(0);
  });
});
