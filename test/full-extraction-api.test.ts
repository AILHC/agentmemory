import { describe, expect, it, vi } from "vitest";

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
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
  it("allows only structured summary failure diagnostics through the REST boundary", async () => {
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: "transient_provider",
        cause: "pi_stream_failed",
        diagnostics: {
          requestPhase: "chunk",
          providerErrorCode: "rate_limited",
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 12,
          inputChars: 345,
          maxOutputTokens: 4096,
          responseStarted: false,
          responseModel: "safe-model",
          stopReason: "error",
          prompt: "prompt-marker",
          rawError: "raw-error-marker",
          headers: { authorization: "credential-marker" },
          token: "token-marker",
        },
      },
    }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: { sessionId: "session-1" },
    });

    expect(response.body).toEqual({
      success: false,
      status: "failed",
      failure: {
        class: "transient_provider",
        cause: "pi_stream_failed",
        diagnostics: {
          requestPhase: "chunk",
          providerErrorCode: "rate_limited",
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 12,
          inputChars: 345,
          maxOutputTokens: 4096,
          responseStarted: false,
          responseModel: "safe-model",
          stopReason: "error",
        },
      },
    });
    const serialized = JSON.stringify(response.body);
    for (const marker of ["prompt-marker", "raw-error-marker", "credential-marker", "token-marker"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("drops an invalid summary failure object instead of passing unsafe diagnostics through", async () => {
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: 42,
        cause: "pi_stream_failed",
        diagnostics: {
          prompt: "prompt-marker",
          rawError: "raw-error-marker",
          headers: { authorization: "credential-marker" },
          token: "token-marker",
        },
      },
    }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: { sessionId: "session-1" },
    });

    expect(response.body).toEqual({ success: false, status: "failed" });
    const serialized = JSON.stringify(response.body);
    for (const marker of ["prompt-marker", "raw-error-marker", "credential-marker", "token-marker"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("replays each formal write endpoint from a succeeded operation receipt", async () => {
    const sdk = mockSdk(async (input) => ({
      success: true,
      functionId: input.function_id,
      memoryIds: ["result-1"],
    }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const cases = [
      {
        api: "api::full-memory-consolidate-window",
        body: {
          runId: "formal-run",
          stage: "memory_consolidate",
          unitId: "mcw-1",
          inputHash: "input-1",
          concept: "retries",
          sourceObservationIds: ["obs-1"],
        },
        functionId: "mem::full-memory-consolidate-window",
      },
      {
        api: "api::semantic-rollup",
        body: {
          runId: "formal-run",
          stage: "semantic_rollup",
          unitId: "w0001",
          inputHash: "input-1",
          windowId: "w0001",
          mark: "full",
          kind: "window",
          sessionIds: ["ses-1"],
        },
        functionId: "mem::semantic-rollup",
      },
      {
        api: "api::full-skill-extract",
        body: {
          runId: "formal-run",
          stage: "skill_extract",
          unitId: "ses-1",
          inputHash: "input-1",
          sessionId: "ses-1",
        },
        functionId: "mem::skill-extract",
      },
      {
        api: "api::full-crystals-auto",
        body: {
          runId: "formal-run",
          stage: "crystal",
          unitId: "auto",
          inputHash: "input-1",
          dryRun: false,
        },
        functionId: "mem::full-crystals-auto",
      },
      {
        api: "api::full-consolidation-procedural-window",
        body: {
          runId: "formal-run",
          stage: "consolidation_procedural",
          unitId: "cpw-1",
          inputHash: "input-1",
          memoryIds: ["mem-1"],
        },
        functionId: "mem::full-consolidation-procedural-window",
      },
      {
        api: "api::full-reflect-insight-window",
        body: {
          runId: "formal-run",
          stage: "reflect_insight",
          unitId: "riw-1",
          inputHash: "input-1",
          useGraph: false,
          semanticMemoryIds: ["sem-1"],
        },
        functionId: "mem::full-reflect-insight-window",
      },
    ];

    for (const entry of cases) {
      sdk.trigger.mockClear();
      const handler = sdk.getFunction(entry.api);
      const first = await handler({ headers: {}, body: entry.body });
      const replay = await handler({ headers: {}, body: entry.body });

      expect(first.status_code).toBe(200);
      expect(replay.status_code).toBe(200);
      expect(sdk.trigger).toHaveBeenCalledTimes(1);
      expect(sdk.trigger).toHaveBeenCalledWith(expect.objectContaining({
        function_id: entry.functionId,
      }));
      expect(replay.body).toEqual(first.body);
    }
  });

  it("full skill-extract sends only sessionId to mem::skill-extract", async () => {
    const sdk = mockSdk(async () => ({ success: true, skill: { id: "proc-a" } }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-skill-extract");

    const response = await handler({
      headers: {},
      body: {
        runId: "formal-run",
        stage: "skill_extract",
        unitId: "ses-a",
        inputHash: "input-a",
        sessionId: " ses-a ",
      },
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

  it("full skill-extract whitelist error names operation identity fields", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, "");
    const response = await sdk.getFunction("api::full-skill-extract")({
      headers: {},
      body: { sessionId: "ses-a", unexpected: true },
    });

    expect(response).toEqual({
      status_code: 400,
      body: {
        error: "Only runId, stage, unitId, inputHash, sessionId, and model are accepted",
      },
    });
  });

  it("full extraction wrappers send only business fields to mem::full functions", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
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
        body: {
          runId: "formal-run",
          stage: "memory_consolidate",
          unitId: "mcw-1",
          inputHash: "input-1",
          project: " repo ",
          concept: " Full ",
          sourceObservationIds: [" obs-a ", ""],
          observationSessionIds: { "obs-a": " ses-a " },
        },
        function_id: "mem::full-memory-consolidate-window",
        payload: {
          project: "repo",
          concept: "Full",
          observationIds: ["obs-a"],
          observationSessionIds: { "obs-a": "ses-a" },
        },
      },
      {
        api: "api::full-consolidation-procedural-windows-plan",
        body: { project: " repo ", maxItemsPerWindow: 4 },
        function_id: "mem::full-consolidation-procedural-windows-plan",
        payload: { project: "repo", maxItemsPerWindow: 4 },
      },
      {
        api: "api::full-consolidation-procedural-window",
        body: {
          runId: "formal-run",
          stage: "consolidation_procedural",
          unitId: "cpw-1",
          inputHash: "input-1",
          project: " repo ",
          memoryIds: [" mem-a ", ""],
          model: " memory-model ",
        },
        function_id: "mem::full-consolidation-procedural-window",
        payload: { project: "repo", memoryIds: ["mem-a"], model: "memory-model" },
      },
      {
        api: "api::full-reflect-insight-windows-plan",
        body: { project: " repo ", useGraph: false, maxItemsPerWindow: 5 },
        function_id: "mem::full-reflect-insight-windows-plan",
        payload: { project: "repo", useGraph: false, maxItemsPerWindow: 5 },
      },
      {
        api: "api::full-reflect-insight-window",
        body: {
          runId: "formal-run",
          stage: "reflect_insight",
          unitId: "riw-1",
          inputHash: "input-1",
          project: " repo ",
          semanticMemoryIds: [" sem-a "],
          lessonIds: [" lsn-a "],
          crystalIds: [" crys-a "],
        },
        function_id: "mem::full-reflect-insight-window",
        payload: { project: "repo", useGraph: false, semanticMemoryIds: ["sem-a"], lessonIds: ["lsn-a"], crystalIds: ["crys-a"] },
      },
      {
        api: "api::full-crystals-auto",
        body: { project: " repo ", olderThanDays: 7, dryRun: true, model: " crystal-model " },
        function_id: "mem::full-crystals-auto",
        payload: { project: "repo", olderThanDays: 7, dryRun: true, model: "crystal-model" },
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

  it("full memory consolidate plan endpoint applies charBudget through the service planner", async () => {
    let sdk: ReturnType<typeof mockSdk>;
    sdk = mockSdk(async (input) => sdk.getFunction(input.function_id)(input.payload));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    registerConsolidateFunction(sdk as never, kv as never, {
      name: "test",
      summarize: vi.fn(),
      compress: vi.fn(),
    });

    await kv.set(KV.sessions, "ses-a", {
      id: "ses-a",
      project: "repo",
      cwd: "/repo",
      startedAt: "2026-07-01T00:00:00.000Z",
      status: "completed",
      observationCount: 4,
    });
    for (let i = 0; i < 4; i++) {
      await kv.set(KV.observations("ses-a"), `obs-${i}`, {
        id: `obs-${i}`,
        sessionId: "ses-a",
        timestamp: "2026-07-01T00:00:00.000Z",
        type: "decision",
        title: `Observation ${i}`,
        facts: [],
        narrative: `Narrative ${i} ${"x".repeat(90)}`,
        concepts: ["windows"],
        files: [`file-${i}.ts`],
        importance: 6,
      });
    }

    const handler = sdk.getFunction("api::full-memory-consolidate-windows-plan");
    const response = await handler({
      headers: {},
      body: { project: " repo ", minObservations: 3, charBudget: 250 },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      charBudget: 250,
      budgetApplied: true,
      overBudgetWindowCount: 0,
    });
    expect(response.body.windows.length).toBeGreaterThan(1);
    expect(response.body.maxWindowEstimatedChars).toBeLessThanOrEqual(250);
    for (const window of response.body.windows) {
      if (window.observationCount > 1) {
        expect(window.estimatedChars).toBeLessThanOrEqual(250);
      }
    }
  });

  it("pages compact consolidation descriptors before finalizing a plan", async () => {
    let sdk: ReturnType<typeof mockSdk>;
    sdk = mockSdk(async (input) => sdk.getFunction(input.function_id)(input.payload));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    registerConsolidateFunction(sdk as never, kv as never, {
      name: "test",
      summarize: vi.fn(),
      compress: vi.fn(),
    });
    for (let sessionIndex = 0; sessionIndex < 2; sessionIndex++) {
      const sessionId = `ses-${sessionIndex}`;
      await kv.set(KV.sessions, sessionId, {
        id: sessionId,
        project: "repo",
        cwd: "/repo",
        startedAt: "2026-07-01T00:00:00.000Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set(KV.observations(sessionId), `obs-${sessionIndex}`, {
        id: `obs-${sessionIndex}`,
        sessionId,
        timestamp: "2026-07-01T00:00:00.000Z",
        type: "decision",
        title: `Observation ${sessionIndex}`,
        facts: [],
        narrative: "private narrative must not be returned by the page",
        concepts: ["windows"],
        files: ["file.ts"],
        importance: 6,
      });
    }
    const handler = sdk.getFunction("api::full-memory-consolidate-windows-plan");

    const page = await handler({
      headers: {},
      body: { project: "repo", sessionOffset: 0, sessionLimit: 1 },
    });
    expect(page.status_code).toBe(200);
    expect(page.body).toMatchObject({
      sessionOffset: 0,
      nextSessionOffset: 1,
      totalSessions: 2,
      sessionInventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      descriptors: [{
        id: "obs-0",
        sid: "ses-0",
        concepts: ["windows"],
        importance: 6,
      }],
    });
    expect(JSON.stringify(page.body)).not.toContain("private narrative");

    const finalized = await handler({
      headers: {},
      body: {
        project: "repo",
        minObservations: 1,
        descriptors: page.body.descriptors,
      },
    });
    expect(finalized.status_code).toBe(200);
    expect(finalized.body.windows[0]).toMatchObject({
      sourceObservationIds: ["obs-0"],
      observationSessionIds: { "obs-0": "ses-0" },
    });
  });
});
