import { describe, it, expect } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";

describe("api::replay::import lessonExtraction validation", () => {
  it("forwards valid lessonExtraction to mem::replay::import-jsonl", async () => {
    const replayPayloads: Array<{ function_id: string; payload: unknown }> = [];
    const kv = {} as any;
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::import") {
          sdk.apiReplayImport = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload: unknown }) => {
        replayPayloads.push(input);
        return { success: true };
      },
      apiReplayImport: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: Function) => void;
      registerTrigger: () => void;
      trigger: (input: { function_id: string; payload: unknown }) => Promise<unknown>;
      apiReplayImport?: Function;
    };

    registerApiTriggers(sdk as any, kv, "");

    const response = await sdk.apiReplayImport!({
      body: {
        path: "/tmp/session",
        maxFiles: 5,
        indexMode: "manual",
        lessonExtraction: {
          enabled: false,
          textLimit: 120,
          additionalHeuristicTerms: ["务必"],
          allowUnbounded: true,
        },
      },
    } as any);

    expect(response.status_code).toBe(202);
    expect(replayPayloads).toHaveLength(1);
    expect(replayPayloads[0].function_id).toBe("mem::replay::import-jsonl");
    expect(replayPayloads[0].payload).toEqual({
      path: "/tmp/session",
      maxFiles: 5,
      indexMode: "manual",
      lessonExtraction: {
        enabled: false,
        textLimit: 120,
        additionalHeuristicTerms: ["务必"],
        allowUnbounded: true,
      },
    });
  });

  it("rejects unknown lessonExtraction fields", async () => {
    const kv = {} as any;
    let caught: unknown;
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::import") {
          sdk.apiReplayImport = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async () => ({ success: true }),
      apiReplayImport: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: Function) => void;
      registerTrigger: () => void;
      trigger: () => Promise<unknown>;
      apiReplayImport?: Function;
    };

    registerApiTriggers(sdk as any, kv, "");

    caught = await sdk.apiReplayImport!({
      body: {
        path: "/tmp/session",
        lessonExtraction: {
          unexpected: "bad",
          enabled: true,
        },
      },
    } as any);

    expect(caught).toMatchObject({
      status_code: 400,
      body: { error: expect.stringContaining("invalid lessonExtraction") },
    });
  });

  it("rejects invalid lessonExtraction types", async () => {
    const kv = {} as any;
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::import") {
          sdk.apiReplayImport = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async () => ({ success: true }),
      apiReplayImport: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: Function) => void;
      registerTrigger: () => void;
      trigger: () => Promise<unknown>;
      apiReplayImport?: Function;
    };

    registerApiTriggers(sdk as any, kv, "");

    const badMode = await sdk.apiReplayImport!({
      body: {
        lessonExtraction: { mode: "unsafe" },
      },
    } as any);
    const badType = await sdk.apiReplayImport!({
      body: {
        lessonExtraction: { textLimit: "40" },
      },
    } as any);
    const badLlmChunkSize = await sdk.apiReplayImport!({
      body: {
        lessonExtraction: { llmChunkSize: 32 },
      },
    } as any);
    const badLlmChunkConcurrency = await sdk.apiReplayImport!({
      body: {
        lessonExtraction: { llmChunkConcurrency: 4 },
      },
    } as any);

    expect(badMode.status_code).toBe(400);
    expect(badMode.body).toMatchObject({ error: expect.stringContaining("invalid lessonExtraction") });
    expect(badType.status_code).toBe(400);
    expect(badType.body).toMatchObject({ error: expect.stringContaining("invalid lessonExtraction") });
    expect(badLlmChunkSize.status_code).toBe(400);
    expect(badLlmChunkSize.body).toMatchObject({ error: expect.stringContaining("invalid lessonExtraction") });
    expect(badLlmChunkConcurrency.status_code).toBe(400);
    expect(badLlmChunkConcurrency.body).toMatchObject({ error: expect.stringContaining("invalid lessonExtraction") });
  });

  it("rejects invalid replay import index controls", async () => {
    const kv = {} as any;
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::import") {
          sdk.apiReplayImport = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async () => ({ success: true }),
      apiReplayImport: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: Function) => void;
      registerTrigger: () => void;
      trigger: () => Promise<unknown>;
      apiReplayImport?: Function;
    };

    registerApiTriggers(sdk as any, kv, "");

    const badIndexMode = await sdk.apiReplayImport!({
      body: {
        path: "/tmp/session",
        indexMode: "later",
      },
    } as any);
    expect(badIndexMode).toMatchObject({
      status_code: 400,
      body: { error: "indexMode must be 'session' or 'manual'" },
    });
  });

  it("omits indexMode and lessonExtraction when they are not provided", async () => {
    const replayPayloads: Array<{ function_id: string; payload: unknown }> = [];
    const kv = {} as any;
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::import") {
          sdk.apiReplayImport = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload: unknown }) => {
        replayPayloads.push(input);
        return { success: true };
      },
      apiReplayImport: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: Function) => void;
      registerTrigger: () => void;
      trigger: (input: { function_id: string; payload: unknown }) => Promise<unknown>;
      apiReplayImport?: Function;
    };

    registerApiTriggers(sdk as any, kv, "");

    const response = await sdk.apiReplayImport!({
      body: { path: "/tmp/session" },
    } as any);

    expect(response.status_code).toBe(202);
    expect(replayPayloads[0].payload).toEqual({ path: "/tmp/session" });
  });

  it("exposes a REST wrapper for deferred replay index finalization", async () => {
    const calls: Array<{ function_id: string; payload: unknown }> = [];
    const kv = {} as any;
    const sdk = {
      registerFunction: (_id: string, handler: Function) => {
        if (_id === "api::replay::finalize-deferred-index") {
          sdk.apiReplayFinalize = handler;
        }
      },
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        return { success: true, rebuilt: 12, dirtyCleared: true };
      },
      apiReplayFinalize: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: Function) => void;
      registerTrigger: () => void;
      trigger: (input: { function_id: string; payload: unknown }) => Promise<unknown>;
      apiReplayFinalize?: Function;
    };

    registerApiTriggers(sdk as any, kv, "secret");

    const denied = await sdk.apiReplayFinalize!({ body: {} } as any);
    expect(denied).toEqual({
      status_code: 401,
      body: { error: "unauthorized" },
    });

    const response = await sdk.apiReplayFinalize!({
      headers: { authorization: "Bearer secret" },
      body: {},
    } as any);

    expect(response).toEqual({
      status_code: 202,
      body: { success: true, rebuilt: 12, dirtyCleared: true },
    });
    expect(calls).toEqual([
      { function_id: "mem::replay::finalize-deferred-index", payload: {} },
    ]);
  });
});
