import { describe, expect, it, vi } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: vi.fn(async () => ({ success: true })),
    getFunction: (id: string): Function => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn;
    },
  };
}

describe("model API field validation", () => {
  it("rejects empty or non-string model body values", async () => {
    const cases = [
      {
        functionId: "api::semantic-rollup",
        body: {
          runId: "run-1",
          windowId: "w1",
          mark: "full",
          kind: "window",
          sessionIds: ["s1"],
        },
      },
      {
        functionId: "api::full-skill-extract",
        body: { sessionId: "s1" },
      },
      {
        functionId: "api::full-memory-consolidate-window",
        body: {},
      },
      {
        functionId: "api::full-consolidation-procedural-window",
        body: {},
      },
      {
        functionId: "api::full-reflect-insight-window",
        body: {},
      },
      {
        functionId: "api::summarize",
        body: { sessionId: "s1" },
      },
      {
        functionId: "api::lesson-extract",
        body: { sessionIds: ["s1"] },
      },
    ];

    for (const entry of cases) {
      for (const invalidModel of ["", "   ", 123]) {
        const sdk = mockSdk();
        registerApiTriggers(sdk as never, {} as never, "");
        const handler = sdk.getFunction(entry.functionId);

        const response = await handler({
          headers: {},
          body: { ...entry.body, model: invalidModel },
        });

        expect(response).toMatchObject({
          status_code: 400,
          body: { error: "model must be a non-empty string" },
        });
        expect(sdk.trigger).not.toHaveBeenCalled();
      }
    }
  });
});
