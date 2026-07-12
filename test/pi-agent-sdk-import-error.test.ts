import { describe, it, expect, vi } from "vitest";

describe("pi-agent-sdk import failure", () => {
  it("masks dynamic-import failures as pi_sdk_import_failed", async () => {
    vi.resetModules();

    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      AuthStorage: { create: vi.fn() },
      ModelRegistry: {
        create: vi.fn(),
      },
    }));
    vi.doMock("@earendil-works/pi-ai/providers/all", () => ({
      getBuiltinModel: vi.fn(),
    }));
    vi.doMock("@earendil-works/pi-ai/compat", () => {
      throw new Error("real import failure should be hidden");
    });

    const { PiAgentSDKProvider } = await import(
      "../src/providers/pi-agent-sdk.js"
    );
    const provider = new PiAgentSDKProvider("gpt-5.4");

    const err = await provider.summarize("system prompt", "user prompt").catch(
      (error) => error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("pi_sdk_import_failed");
    expect((err as Error).message).not.toBe("real import failure should be hidden");
  });
});
