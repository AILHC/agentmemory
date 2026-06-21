import { describe, expect, it, vi } from "vitest";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { parseReplayLoadPageParam, registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => fns.set(id, handler),
    registerTrigger: () => {},
    trigger: async (id: string, payload?: unknown) => {
      const fn = fns.get(id);
      if (!fn) return { success: false, error: `missing function: ${id}` };
      return fn(payload);
    },
  } as any;
}

describe("parseReplayLoadPageParam", () => {
  it("parses non-negative integer query parameters and rejects decimals", () => {
    expect(parseReplayLoadPageParam("25")).toBe(25);
    expect(parseReplayLoadPageParam("0")).toBe(0);
    expect(parseReplayLoadPageParam("1.9")).toBeUndefined();
    expect(parseReplayLoadPageParam("-1")).toBeUndefined();
    expect(parseReplayLoadPageParam("abc")).toBeUndefined();
    expect(parseReplayLoadPageParam(undefined)).toBeUndefined();
  });
});

async function seedObservations(kv: ReturnType<typeof mockKV>, sessionId: string, count: number) {
  await kv.set(KV.sessions, sessionId, {
    id: sessionId,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:20:00.000Z",
    project: "project",
    cwd: "/workspace/project",
    observationCount: count,
  });
  for (let index = 0; index < count; index++) {
    await kv.set(KV.observations(sessionId), `obs-${index}`, {
      id: `obs-${index}`,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      hookType: index % 2 === 0 ? "prompt_submit" : "stop",
      userPrompt: index % 2 === 0 ? `Prompt ${index}` : undefined,
      assistantResponse: index % 2 === 1 ? `Response ${index}` : undefined,
      raw: {},
    });
  }
}

describe("mem::replay::load pagination", () => {
  it("returns the first bounded page by default", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerReplayFunctions(sdk, kv as any);
    await seedObservations(kv, "sess-large", 1200);

    const result = await sdk.trigger("mem::replay::load", { sessionId: "sess-large" });

    expect(result.success).toBe(true);
    expect(result.timeline.eventCount).toBe(1200);
    expect(result.timeline.events).toHaveLength(500);
    expect(result.timeline.page).toEqual({
      offset: 0,
      limit: 500,
      returned: 500,
      hasMore: true,
      nextOffset: 500,
    });
  });

  it("returns the requested page and clamps limit to the maximum", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerReplayFunctions(sdk, kv as any);
    await seedObservations(kv, "sess-large", 1200);

    const result = await sdk.trigger("mem::replay::load", {
      sessionId: "sess-large",
      offset: 1000,
      limit: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.timeline.events).toHaveLength(200);
    expect(result.timeline.events[0].id).toBe("obs-1000");
    expect(result.timeline.page).toEqual({
      offset: 1000,
      limit: 1000,
      returned: 200,
      hasMore: false,
      nextOffset: null,
    });
  });

  it("keeps default replay load payload bounded even when event fields are huge", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerReplayFunctions(sdk, kv as any);
    await kv.set(KV.sessions, "sess-huge-payload", {
      id: "sess-huge-payload",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:20:00.000Z",
      project: "project",
      cwd: "/workspace/project",
      observationCount: 500,
    });
    const hugeOutput = "x".repeat(50_000);
    for (let index = 0; index < 500; index++) {
      await kv.set(KV.observations("sess-huge-payload"), `obs-${index}`, {
        id: `obs-${index}`,
        sessionId: "sess-huge-payload",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        hookType: "post_tool_use",
        toolName: "Bash",
        toolInput: { command: `echo ${index}`, context: hugeOutput },
        toolOutput: hugeOutput,
        raw: {},
      });
    }

    const result = await sdk.trigger("mem::replay::load", { sessionId: "sess-huge-payload" });

    expect(result.success).toBe(true);
    expect(result.timeline.events).toHaveLength(500);
    expect(result.timeline.events[0].truncated.toolInput).toBe(true);
    expect(result.timeline.events[0].truncated.toolOutput).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(1_000_000);
  });

  it("keeps a 15000 observation replay load response bounded by bytes", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerReplayFunctions(sdk, kv as any);
    await kv.set(KV.sessions, "sess-huge", {
      id: "sess-huge",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T04:10:00.000Z",
      project: "project",
      cwd: "/workspace/project",
      observationCount: 15000,
    });
    const hugeOutput = "x".repeat(50_000);
    for (let index = 0; index < 15000; index++) {
      await kv.set(KV.observations("sess-huge"), `obs-${index}`, {
        id: `obs-${index}`,
        sessionId: "sess-huge",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        hookType: "post_tool_use",
        toolName: "Bash",
        toolInput: { command: `echo ${index}`, context: hugeOutput },
        toolOutput: hugeOutput,
        raw: {},
      });
    }

    const result = await sdk.trigger("mem::replay::load", { sessionId: "sess-huge" });
    const serialized = JSON.stringify(result);

    expect(result.success).toBe(true);
    expect(result.timeline.eventCount).toBe(15000);
    expect(result.timeline.events).toHaveLength(500);
    expect(result.timeline.events[0].truncated.toolInput).toBe(true);
    expect(result.timeline.events[0].truncated.toolOutput).toBe(true);
    expect(serialized.length).toBeLessThan(1_000_000);
    expect(serialized).not.toContain("x".repeat(10_000));
    expect(result.timeline.page.hasMore).toBe(true);
  });
});

describe("api::replay::load pagination passthrough", () => {
  it("passes replay load pagination query params to mem::replay::load", async () => {
    const triggerCalls: unknown[] = [];
    const kv = mockKV();
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::load") {
          sdk.apiReplayLoad = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async (input: unknown) => {
        triggerCalls.push(input);
        return { success: true, timeline: { events: [], eventCount: 0 } };
      },
      apiReplayLoad: undefined as undefined | Function,
    };

    registerApiTriggers(sdk as any, kv as any, "");

    const response = await sdk.apiReplayLoad!({
      query_params: {
        sessionId: "sess-1",
        offset: "25",
        limit: "50",
      },
      headers: {},
    });

    expect(response.status_code).toBe(200);
    expect(triggerCalls[0]).toEqual({
      function_id: "mem::replay::load",
      payload: { sessionId: "sess-1", offset: 25, limit: 50 },
    });
  });
});
