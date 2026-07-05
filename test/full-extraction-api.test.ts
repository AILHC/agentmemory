import { describe, expect, it, vi } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";

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

function mockSdk(triggerImpl?: (input: { function_id: string; payload: unknown }) => Promise<unknown>) {
  const functions = new Map<string, Function>();
  const trigger = vi.fn(triggerImpl ?? (async (input: { function_id: string; payload: unknown }) => ({
    success: true,
    functionId: input.function_id,
    payload: input.payload,
  })));
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger,
    getFunction: (id: string): Function => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn;
    },
  };
}

describe("full extraction REST wrappers", () => {
  it("full skill-extract sends only sessionId to mem::skill-extract", async () => {
    const sdk = mockSdk(async () => ({ success: true, skill: { id: "proc-a" } }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-skill-extract");

    const response = await handler({
      headers: {},
      body: { sessionId: " ses-a " },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-extract",
      payload: { sessionId: "ses-a" },
    });
    expect(response.body).toMatchObject({
      success: true,
      proceduralMemoryIds: ["proc-a"],
    });
  });

  it("full extraction wrappers trigger mem::full functions without reading KV directly", async () => {
    const sdk = mockSdk();
    const kv = {
      get: vi.fn(async () => {
        throw new Error("REST wrapper must not read KV");
      }),
      set: vi.fn(async () => {
        throw new Error("REST wrapper must not write KV");
      }),
      list: vi.fn(async () => {
        throw new Error("REST wrapper must not list KV");
      }),
    };
    registerApiTriggers(sdk as never, kv as never, "");

    const cases = [
      {
        api: "api::full-memory-consolidate-windows-plan",
        body: { project: " repo ", minObservations: 3, maxObservationsPerWindow: 5 },
        function_id: "mem::full-memory-consolidate-windows-plan",
        payload: { project: "repo", minObservationsPerConcept: 3, maxObservationsPerWindow: 5 },
      },
      {
        api: "api::full-memory-consolidate-window",
        body: { project: " repo ", concept: " Full ", sourceObservationIds: [" obs-a ", ""] },
        function_id: "mem::full-memory-consolidate-window",
        payload: { project: "repo", concept: "Full", observationIds: ["obs-a"] },
      },
      {
        api: "api::full-consolidation-procedural-windows-plan",
        body: { project: " repo ", maxItemsPerWindow: 4 },
        function_id: "mem::full-consolidation-procedural-windows-plan",
        payload: { project: "repo", maxItemsPerWindow: 4 },
      },
      {
        api: "api::full-consolidation-procedural-window",
        body: { project: " repo ", memoryIds: [" mem-a ", ""] },
        function_id: "mem::full-consolidation-procedural-window",
        payload: { project: "repo", memoryIds: ["mem-a"] },
      },
      {
        api: "api::full-reflect-insight-windows-plan",
        body: { project: " repo ", useGraph: false, maxItemsPerWindow: 5 },
        function_id: "mem::full-reflect-insight-windows-plan",
        payload: { project: "repo", useGraph: false, maxItemsPerWindow: 5 },
      },
      {
        api: "api::full-reflect-insight-window",
        body: { project: " repo ", semanticMemoryIds: [" sem-a "], lessonIds: [" lsn-a "], crystalIds: [" crys-a "] },
        function_id: "mem::full-reflect-insight-window",
        payload: { project: "repo", useGraph: false, semanticMemoryIds: ["sem-a"], lessonIds: ["lsn-a"], crystalIds: ["crys-a"] },
      },
      {
        api: "api::full-crystals-auto",
        body: { project: " repo ", olderThanDays: 7, dryRun: true },
        function_id: "mem::full-crystals-auto",
        payload: { project: "repo", olderThanDays: 7, dryRun: true },
      },
    ];

    for (const entry of cases) {
      sdk.trigger.mockClear();
      const handler = sdk.getFunction(entry.api);
      const response = await handler({ headers: {}, body: entry.body });

      expect(response.status_code).toBe(200);
      expect(sdk.trigger).toHaveBeenCalledWith({
        function_id: entry.function_id,
        payload: entry.payload,
      });
    }

    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.set).not.toHaveBeenCalled();
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("full reflect insight wrappers reject useGraph true with a 400 response", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");

    for (const functionId of [
      "api::full-reflect-insight-windows-plan",
      "api::full-reflect-insight-window",
    ]) {
      const handler = sdk.getFunction(functionId);
      const response = await handler({
        headers: {},
        body: { useGraph: true },
      });

      expect(response.status_code).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining("useGraph:true"),
      });
    }
  });

  it("full crystals auto delegates the whole run to mem::full-crystals-auto", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-crystals-auto");

    const response = await handler({
      headers: {},
      body: { dryRun: true },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::full-crystals-auto",
      payload: { dryRun: true },
    });
  });
});
