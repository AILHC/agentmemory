import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  planConsolidateObservationWindows,
  runConsolidateObservationWindow,
} from "../src/functions/consolidate.js";
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
      name: "test",
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
    });

    expect(result.success).toBe(true);
    expect(result.consolidated).toBe(1);
    expect(result.memoryIds).toEqual([expect.stringMatching(/^mem_/)]);
    expect(provider.compress).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Observation obs-11"),
    );
    const stored = await kv.list(KV.memories);
    expect(stored).toHaveLength(1);
  });
});
