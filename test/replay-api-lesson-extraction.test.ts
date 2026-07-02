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

  it("omits lessonExtraction when it is not provided", async () => {
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
});
