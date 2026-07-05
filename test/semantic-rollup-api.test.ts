import { describe, expect, it, vi } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  const trigger = vi.fn(async (input: { function_id: string; payload: unknown }) => ({
    success: true,
    functionId: input.function_id,
    payload: input.payload,
  }));
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

describe("semantic rollup REST wrappers", () => {
  it("rejects unsupported semantic-rollup fields", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::semantic-rollup");

    const response = await handler({
      headers: {},
      body: {
        runId: "run-1",
        windowId: "win-1",
        mark: "full",
        kind: "window",
        sessionIds: ["ses-a"],
        rawBody: { shouldNotPass: true },
      },
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("validates and sends only sanitized semantic-rollup payload fields", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::semantic-rollup");

    const response = await handler({
      headers: {},
      body: {
        runId: " run-1 ",
        windowId: " win-1 ",
        mark: " full ",
        kind: "window",
        sessionIds: [" ses-a ", "ses-b", ""],
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::semantic-rollup",
      payload: {
        runId: "run-1",
        windowId: "win-1",
        mark: "full",
        kind: "window",
        sessionIds: ["ses-a", "ses-b"],
      },
    });
  });

  it("rejects corpus semantic-rollup requests", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::semantic-rollup");

    const response = await handler({
      headers: {},
      body: {
        runId: "run-1",
        windowId: "corpus-1",
        mark: "full",
        kind: "corpus",
        semanticMemoryIds: ["sem-a"],
      },
    });

    expect(response.status_code).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: expect.stringContaining("corpus"),
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects unsupported extraction-run-record fields", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::extraction-run-record");

    const response = await handler({
      headers: {},
      body: {
        runId: "run-1",
        mark: "full",
        status: "running",
        summarySessionId: "ses-a",
        rawBody: true,
      },
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("sends only sanitized extraction-run-record payload fields", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::extraction-run-record");

    const response = await handler({
      headers: {},
      body: {
        runId: " run-1 ",
        mark: " full ",
        status: "succeeded",
        summarySessionId: " ses-a ",
        lessonRunId: " lesson-a ",
        semanticWindowId: " win-a ",
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::extraction-run-record",
      payload: {
        runId: "run-1",
        mark: "full",
        status: "succeeded",
        summarySessionId: "ses-a",
        lessonRunId: "lesson-a",
        semanticWindowId: "win-a",
      },
    });
  });

  it("rejects extraction-run-record corpusWindowId", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::extraction-run-record");

    const response = await handler({
      headers: {},
      body: {
        runId: "run-1",
        mark: "full",
        corpusWindowId: "corpus-a",
      },
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects extraction-run-record optional fields that are present but not non-empty strings", async () => {
    for (const body of [
      { runId: "run-1", mark: "full", status: "" },
      { runId: "run-1", mark: "full", status: 1 },
      { runId: "run-1", mark: "full", summarySessionId: "" },
      { runId: "run-1", mark: "full", lessonRunId: 1 },
      { runId: "run-1", mark: "full", semanticWindowId: null },
    ]) {
      const sdk = mockSdk();
      registerApiTriggers(sdk as never, {} as never, "");
      const handler = sdk.getFunction("api::extraction-run-record");

      const response = await handler({ headers: {}, body });

      expect(response.status_code).toBe(400);
      expect(sdk.trigger).not.toHaveBeenCalled();
    }
  });

  it("rejects extraction-run-record status outside the allowed set", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::extraction-run-record");

    const response = await handler({
      headers: {},
      body: {
        runId: "run-1",
        mark: "full",
        status: "done",
      },
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("allows extraction-run-record calls without status", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "");
    const handler = sdk.getFunction("api::extraction-run-record");

    const response = await handler({
      headers: {},
      body: {
        runId: " run-1 ",
        mark: " full ",
        summarySessionId: " ses-a ",
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::extraction-run-record",
      payload: {
        runId: "run-1",
        mark: "full",
        summarySessionId: "ses-a",
      },
    });
  });
});
