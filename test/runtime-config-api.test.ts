import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadRegisterApiTriggers() {
  const mod = await import("../src/triggers/api.js");
  return mod.registerApiTriggers;
}

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
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("returns safe runtime config fields only", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "25";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "2";
    process.env.OPENAI_API_KEY = "do-not-return";
    process.env.OPENAI_BASE_URL = "https://do-not-return.example";
    const registerApiTriggers = await loadRegisterApiTriggers();
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

  it("reads summarize runtime limits from AGENTMEMORY_HOME .env", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentmemory-runtime-config-"));
    try {
      writeFileSync(
        join(home, ".env"),
        [
          "SUMMARIZE_CHUNK_SIZE=123",
          "SUMMARIZE_CHUNK_CONCURRENCY=1",
          "OPENAI_API_KEY=do-not-return-from-env-file",
          "",
        ].join("\n"),
      );
      process.env.AGENTMEMORY_HOME = home;
      vi.resetModules();

      const registerApiTriggers = await loadRegisterApiTriggers();
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
      expect(response.body.runtime.summarizeChunkConcurrency).toBe(1);
      expect(response.body.runtime.summarizeChunkSize).toBe(123);
      expect(JSON.stringify(response.body)).not.toContain("do-not-return-from-env-file");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lets process.env override AGENTMEMORY_HOME .env for runtime limits", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentmemory-runtime-config-override-"));
    try {
      writeFileSync(
        join(home, ".env"),
        [
          "SUMMARIZE_CHUNK_SIZE=123",
          "SUMMARIZE_CHUNK_CONCURRENCY=1",
          "",
        ].join("\n"),
      );
      process.env.AGENTMEMORY_HOME = home;
      process.env.SUMMARIZE_CHUNK_SIZE = "25";
      process.env.SUMMARIZE_CHUNK_CONCURRENCY = "2";
      vi.resetModules();

      const registerApiTriggers = await loadRegisterApiTriggers();
      const sdk = mockSdk();
      registerApiTriggers(sdk as never, {} as never, "", undefined, undefined);
      const handler = sdk.getFunction("api::runtime-config");

      const response = await handler({ headers: {}, query_params: {} });

      expect(response.status_code).toBe(200);
      expect(response.body.runtime.summarizeChunkConcurrency).toBe(2);
      expect(response.body.runtime.summarizeChunkSize).toBe(25);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to defaults for invalid summarize runtime limit values", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "400.5";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "0";
    vi.resetModules();

    const registerApiTriggers = await loadRegisterApiTriggers();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "", undefined, undefined);
    const handler = sdk.getFunction("api::runtime-config");

    const response = await handler({ headers: {}, query_params: {} });

    expect(response.status_code).toBe(200);
    expect(response.body.runtime.summarizeChunkConcurrency).toBe(6);
    expect(response.body.runtime.summarizeChunkSize).toBe(400);
  });

  it("falls back to defaults for unsafe integer summarize runtime limits", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "9007199254740992";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "9007199254740992";
    vi.resetModules();

    const registerApiTriggers = await loadRegisterApiTriggers();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "", undefined, undefined);
    const handler = sdk.getFunction("api::runtime-config");

    const response = await handler({ headers: {}, query_params: {} });

    expect(response.status_code).toBe(200);
    expect(response.body.runtime.summarizeChunkConcurrency).toBe(6);
    expect(response.body.runtime.summarizeChunkSize).toBe(400);
  });

  it("falls back to the default when summarize chunk concurrency exceeds its max", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "401";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "257";
    vi.resetModules();

    const registerApiTriggers = await loadRegisterApiTriggers();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, {} as never, "", undefined, undefined);
    const handler = sdk.getFunction("api::runtime-config");

    const response = await handler({ headers: {}, query_params: {} });

    expect(response.status_code).toBe(200);
    expect(response.body.runtime.summarizeChunkConcurrency).toBe(6);
    expect(response.body.runtime.summarizeChunkSize).toBe(401);
  });
});
