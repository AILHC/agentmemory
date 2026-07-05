import { afterEach, describe, expect, it } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({ success: true }),
    getFunction: (id: string): Function => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn;
    },
  };
}

describe("api::runtime-config", () => {
  afterEach(() => {
    delete process.env.SUMMARIZE_CHUNK_SIZE;
    delete process.env.SUMMARIZE_CHUNK_CONCURRENCY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  it("returns safe runtime config fields only", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "25";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "2";
    process.env.OPENAI_API_KEY = "do-not-return";
    process.env.OPENAI_BASE_URL = "https://do-not-return.example";
    const sdk = mockSdk();
    registerApiTriggers(
      sdk as never,
      {} as never,
      "",
      undefined,
      { name: "safe-provider" } as never,
    );
    const handler = sdk.getFunction("api::runtime-config");

    const response = await handler({ headers: {}, query_params: {} });

    expect(response.status_code).toBe(200);
    expect(response.body).toEqual({
      success: true,
      runtime: {
        summarizeChunkConcurrency: 2,
        summarizeChunkSize: 25,
        providerName: "safe-provider",
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("do-not-return");
    expect(serialized).not.toMatch(/secret|token|apiKey|providerKey|baseURL|env/i);
  });
});
