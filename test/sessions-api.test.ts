import { describe, expect, it, vi } from "vitest";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async () => ({ success: true }),
    getFunction: (id: string): Function => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler;
    },
  };
}

describe("api::sessions", () => {
  it("joins summaries with two bulk lists and no per-session reads", async () => {
    const sessions = [
      { id: "s1", agentId: "agent", project: "one" },
      { id: "s2", agentId: "agent", project: "two" },
    ];
    const summaries = [
      {
        sessionId: "s1",
        project: "one",
        createdAt: "2026-07-12T00:00:00.000Z",
        title: "title",
        narrative: "narrative",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 1,
      },
    ];
    const kv = {
      list: vi.fn(async (scope: string) => {
        if (scope === KV.sessions) return sessions;
        if (scope === KV.summaries) return summaries;
        return [];
      }),
      get: vi.fn(async () => {
        throw new Error("sessions API must not issue per-session summary reads");
      }),
    };
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::sessions")({
      headers: {},
      query_params: { agentId: "*" },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toEqual({
      sessions: [
        { ...sessions[0], summary: summaries[0] },
        sessions[1],
      ],
    });
    expect(kv.list).toHaveBeenNthCalledWith(1, KV.sessions);
    expect(kv.list).toHaveBeenNthCalledWith(2, KV.summaries);
    expect(kv.get).not.toHaveBeenCalled();
  });
});
