import { describe, it, expect, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";

describe("api::lesson-extract", () => {
  it("forwards only whitelisted fields to mem::lessons::extract-llm", async () => {
    const payloads: unknown[] = [];
    const kv = {} as never;
    const sdk = {
      registerFunction: (id: string, handler: unknown) => {
        if (id === "api::lesson-extract") {
          sdk.apiLessonExtract = handler;
        }
      },
      registerTrigger: vi.fn(),
      trigger: vi.fn(async (input: { function_id: string; payload: unknown }) => {
        payloads.push(input.payload);
        return { success: true, runs: [] };
      }),
      apiLessonExtract: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: unknown) => void;
      registerTrigger: () => void;
      trigger: (input: { function_id: string; payload: unknown }) => Promise<unknown>;
      apiLessonExtract?: Function;
    };

    registerApiTriggers(sdk as never, kv, "");

    const ok = await sdk.apiLessonExtract!({
      body: {
        sessionIds: [" session-a ", "session-b", "  ", ""],
        missingOnly: false,
        retryFailed: true,
        force: true,
        textLimit: 1200,
        saveLimit: 12,
        chunkSize: 9,
        chunkConcurrency: 3,
        timeoutMs: 30000,
      },
      headers: {},
    });

    expect(ok).toMatchObject({ status_code: 200 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      sessionIds: ["session-a", "session-b"],
      missingOnly: false,
      retryFailed: true,
      force: true,
      textLimit: 1200,
      saveLimit: 12,
      chunkSize: 9,
      chunkConcurrency: 3,
      timeoutMs: 30000,
    });
  });

  it("rejects unknown lesson extract fields", async () => {
    const kv = {} as never;
    const sdk = {
      registerFunction: (id: string, handler: unknown) => {
        if (id === "api::lesson-extract") {
          sdk.apiLessonExtract = handler;
        }
      },
      registerTrigger: vi.fn(),
      trigger: vi.fn(async () => ({ success: true, runs: [] })),
      apiLessonExtract: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: unknown) => void;
      registerTrigger: () => void;
      trigger: () => Promise<unknown>;
      apiLessonExtract?: Function;
    };

    registerApiTriggers(sdk as never, kv, "");

    const response = await sdk.apiLessonExtract!({
      body: {
        sessionIds: ["session-a"],
        invalidField: "nope",
      },
      headers: {},
    });

    expect(response).toMatchObject({
      status_code: 400,
      body: {
        error: expect.stringContaining("only sessionIds, missingOnly, retryFailed, force"),
      },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });
});

describe("api::lesson-extract-runs", () => {
  it("passes through sessionId/status/limit query params", async () => {
    const triggerCalls: Array<{ function_id: string; payload: Record<string, unknown> }> = [];
    const kv = {} as never;
    const sdk = {
      registerFunction: (id: string, handler: unknown) => {
        if (id === "api::lesson-extract-runs") {
          sdk.apiLessonExtractRuns = handler;
        }
      },
      registerTrigger: vi.fn(),
      trigger: async (input: {
        function_id: string;
        payload: Record<string, unknown>;
      }) => {
        triggerCalls.push(input);
        return { success: true, runs: [] };
      },
      apiLessonExtractRuns: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: unknown) => void;
      registerTrigger: () => void;
      trigger: (input: {
        function_id: string;
        payload: Record<string, unknown>;
      }) => Promise<unknown>;
      apiLessonExtractRuns?: Function;
    };

    registerApiTriggers(sdk as never, kv, "");

    const response = await sdk.apiLessonExtractRuns!({
      query_params: {
        sessionId: "session-a",
        status: "succeeded",
        limit: "77",
      },
      headers: {},
    });

    expect(response).toMatchObject({ status_code: 200 });
    expect(triggerCalls[0]).toEqual({
      function_id: "mem::lessons::extract-runs",
      payload: {
        sessionId: "session-a",
        status: "succeeded",
        limit: 77,
      },
    });
  });
});

describe("api::lesson-extract-run-get", () => {
  it("requires runId", async () => {
    const kv = {} as never;
    const sdk = {
      registerFunction: (id: string, handler: unknown) => {
        if (id === "api::lesson-extract-run-get") {
          sdk.apiLessonExtractRunGet = handler;
        }
      },
      registerTrigger: vi.fn(),
      trigger: vi.fn(),
      apiLessonExtractRunGet: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: unknown) => void;
      registerTrigger: () => void;
      trigger: () => Promise<unknown>;
      apiLessonExtractRunGet?: Function;
    };

    registerApiTriggers(sdk as never, kv, "");

    const response = await sdk.apiLessonExtractRunGet!({
      query_params: {},
      headers: {},
    });

    expect(response).toMatchObject({
      status_code: 400,
      body: { error: "runId query param is required" },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("returns 500 on sdk error", async () => {
    const kv = {} as never;
    const sdk = {
      registerFunction: (id: string, handler: unknown) => {
        if (id === "api::lesson-extract-run-get") {
          sdk.apiLessonExtractRunGet = handler;
        }
      },
      registerTrigger: vi.fn(),
      trigger: vi
        .fn()
        .mockRejectedValue(new Error("downstream failure")),
      apiLessonExtractRunGet: undefined as undefined | Function,
    } as {
      registerFunction: (id: string, handler: unknown) => void;
      registerTrigger: () => void;
      trigger: () => Promise<unknown>;
      apiLessonExtractRunGet?: Function;
    };

    registerApiTriggers(sdk as never, kv, "");

    const response = await sdk.apiLessonExtractRunGet!({
      query_params: {
        runId: "run-1",
      },
      headers: {},
    });

    expect(response).toMatchObject({
      status_code: 500,
      body: { error: "downstream failure" },
    });
  });
});
