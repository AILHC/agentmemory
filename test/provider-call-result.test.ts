import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: vi.fn(async function* () {
    throw new Error("network failed");
  }),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: vi.fn(() => ({
    provider: "openai-codex",
    model: "gpt-5.4",
    contextWindow: 128000,
    maxTokens: 8192,
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: vi.fn(() => ({ getSessionId: () => "019f5a00-0000-7000-8000-000000000001" })),
  },
  AuthStorage: { create: vi.fn(() => ({})) },
  ModelRegistry: {
    create: vi.fn(() => ({
      find: vi.fn(() => ({
        provider: "openai-codex",
        model: "gpt-5.4",
        contextWindow: 128000,
        maxTokens: 8192,
      })),
      getApiKeyAndHeaders: vi.fn(() => ({
        configured: true,
        ok: true,
        apiKey: "pi-key",
      })),
    })),
  },
}));
import {
  compressForStage,
  ProviderCallError,
  ProviderPreflightError,
  summarizeForStage,
} from "../src/providers/provider-call-result.js";
import type { MemoryProvider } from "../src/types.js";
import { createProvider } from "../src/providers/index.js";
import { callProviderWithTelemetry } from "../src/providers/provider-call-result.js";

describe("provider call results", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function policy(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      expectedProvider: "pi-agent-sdk",
      expectedModel: "gpt-5.4",
      worstTokensPerChar: 0.5,
      fixedTokens: 10,
      proportionalReserve: 0,
      contextWindow: 100,
      modelMaxTokens: 50,
      maxOutputTokens: 20,
      reasoningReserve: 10,
      safetyMargin: 10,
      calibrationHash: `sha256:${"a".repeat(64)}`,
      ...overrides,
    };
  }

  function enablePolicy(overrides: Record<string, unknown> = {}) {
    vi.stubEnv("AGENTMEMORY_EVALUATION_MODE", "context-strategy");
    vi.stubEnv("AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY", JSON.stringify(policy(overrides)));
  }

  it("wraps legacy summarize and compress strings without metadata", async () => {
    const provider: MemoryProvider = {
      name: "legacy",
      summarize: async () => "summary",
      compress: async () => "compressed",
    };

    await expect(summarizeForStage(provider, "system", "user")).resolves.toEqual({
      text: "summary",
    });
    await expect(compressForStage(provider, "system", "user")).resolves.toEqual({
      text: "compressed",
    });
  });

  it("uses the provider detailed result as a single per-call value", async () => {
    const provider: MemoryProvider = {
      name: "detailed",
      summarize: async () => "legacy summary",
      compress: async () => "legacy compression",
      summarizeWithMetadata: async () => ({
        text: "summary",
        metadata: { inputTokens: 11, stopReason: "stop" },
      }),
      compressWithMetadata: async () => ({
        text: "compressed",
        metadata: { outputTokens: 7, stopReason: "max_tokens" },
      }),
    };

    await expect(summarizeForStage(provider, "system", "user")).resolves.toEqual({
      text: "summary",
      metadata: { inputTokens: 11, stopReason: "stop" },
    });
    await expect(compressForStage(provider, "system", "user")).resolves.toEqual({
      text: "compressed",
      metadata: { outputTokens: 7, stopReason: "max_tokens" },
    });
  });

  it("records actual promptChars on a successful real call without policy", async () => {
    const provider: MemoryProvider = {
      name: "detailed",
      summarize: async () => "legacy",
      compress: async () => "legacy",
      summarizeWithMetadata: vi.fn(async () => ({
        text: "summary body must not be recorded",
        metadata: { inputTokens: 3, outputTokens: 2, totalTokens: 5, stopReason: "stop" as const },
      })),
    };
    const telemetry: any[] = [];

    await expect(callProviderWithTelemetry({
      provider,
      operation: "summarize",
      callRole: "single",
      callIndex: 0,
      systemPrompt: "system",
      userPrompt: "user prompt",
      telemetry,
    })).resolves.toBe("summary body must not be recorded");

    expect(telemetry).toEqual([
      expect.objectContaining({
        providerInvoked: true,
        promptChars: "system".length + "user prompt".length,
      }),
    ]);
    expect(telemetry[0]).not.toHaveProperty("preflightBlocked");
    expect(JSON.stringify(telemetry)).not.toContain("summary body must not be recorded");
  });

  it("records actual promptChars on a real provider error without policy", async () => {
    const metadata = {
      inputTokens: 4,
      outputTokens: 0,
      totalTokens: 4,
      stopReason: "error" as const,
      responseModel: "error-model",
    };
    const provider: MemoryProvider = {
      name: "detailed",
      summarize: async () => "legacy",
      compress: async () => "legacy",
      summarizeWithMetadata: vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed", metadata);
      }),
    };
    const telemetry: any[] = [];

    await expect(callProviderWithTelemetry({
      provider,
      operation: "summarize",
      callRole: "single",
      callIndex: 1,
      systemPrompt: "sys",
      userPrompt: "usr",
      telemetry,
    })).rejects.toThrow("pi_stream_failed");

    expect(telemetry).toEqual([
      expect.objectContaining({
        providerInvoked: true,
        promptChars: 6,
        metadataStatus: "supported",
        metadata,
      }),
    ]);
    expect(telemetry[0]).not.toHaveProperty("preflightBlocked");
    expect(JSON.stringify(telemetry)).not.toContain("pi_stream_failed");
  });

  it("keeps detailed Pi calls inside the ResilientProvider circuit breaker", async () => {
    const provider = createProvider({
      provider: "pi-agent-sdk",
      model: "gpt-5.4",
      maxTokens: 100,
    });
    const telemetry: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 3; i++) {
      await expect(
        callProviderWithTelemetry({
          provider,
          operation: "summarize",
          callRole: "single",
          callIndex: i,
          systemPrompt: "system",
          userPrompt: "user",
          telemetry: telemetry as never,
        }),
      ).rejects.toThrow("pi_stream_failed");
    }

    await expect(
      callProviderWithTelemetry({
        provider,
        operation: "summarize",
        callRole: "single",
        callIndex: 3,
        systemPrompt: "system",
        userPrompt: "user",
        telemetry: telemetry as never,
      }),
    ).rejects.toThrow("circuit_breaker_open");
    expect(telemetry).toHaveLength(4);
    expect(telemetry[3]).toMatchObject({ metadataStatus: "unsupported" });
  });

  it("blocks before Resilient/provider and returns redacted preflight telemetry", async () => {
    enablePolicy();
    const provider: MemoryProvider = {
      name: "resilient(pi-agent-sdk)",
      summarize: vi.fn(async () => "unexpected"),
      compress: vi.fn(async () => "unexpected"),
      summarizeWithMetadata: vi.fn(async () => ({ text: "unexpected" })),
    };
    const telemetry: any[] = [];

    await expect(callProviderWithTelemetry({
      provider,
      operation: "summarize",
      callRole: "map",
      callIndex: 0,
      systemPrompt: "s".repeat(100),
      userPrompt: "u".repeat(100),
      callOptions: { model: "gpt-5.4", maxTokens: 20 },
      telemetry,
    })).rejects.toBeInstanceOf(ProviderPreflightError);

    expect(provider.summarizeWithMetadata).not.toHaveBeenCalled();
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      providerInvoked: false,
      preflightBlocked: true,
      reason: "context_window_exceeded",
      promptChars: 200,
      contextWindow: 100,
      modelMaxTokens: 50,
      calibrationHash: `sha256:${"a".repeat(64)}`,
    });
    expect(telemetry[0]).not.toHaveProperty("inputTokens");
    expect(telemetry[0]).not.toHaveProperty("outputTokens");
    expect(telemetry[0]).not.toHaveProperty("totalTokens");
  });

  it("uses the actual call maxTokens at the boundary and records provider invocation", async () => {
    enablePolicy({ contextWindow: 200, maxOutputTokens: 40 });
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      summarize: vi.fn(async () => "legacy should not run"),
      compress: vi.fn(async () => "unused"),
      summarizeWithMetadata: vi.fn(async () => ({
        text: "ok",
        metadata: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      })),
    };
    const telemetry: any[] = [];

    await expect(callProviderWithTelemetry({
      provider,
      operation: "summarize",
      callRole: "reduce",
      callIndex: 1,
      systemPrompt: "system",
      userPrompt: "user",
      callOptions: { model: "gpt-5.4", maxTokens: 20 },
      telemetry,
    })).resolves.toBe("ok");

    expect(provider.summarizeWithMetadata).toHaveBeenCalledTimes(1);
    expect(telemetry[0]).toMatchObject({ providerInvoked: true, preflightBlocked: false });
    expect(telemetry[0].metadata).toEqual({ inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  });

  it("fails closed for missing/invalid policy and model drift without touching provider", async () => {
    vi.stubEnv("AGENTMEMORY_EVALUATION_MODE", "context-strategy");
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      summarize: vi.fn(async () => "unexpected"),
      compress: vi.fn(async () => "unexpected"),
    };
    const telemetry: any[] = [];

    await expect(callProviderWithTelemetry({
      provider,
      operation: "summarize",
      callRole: "single",
      callIndex: 0,
      systemPrompt: "system",
      userPrompt: "user",
      callOptions: { model: "gpt-5.4", maxTokens: 20 },
      telemetry,
    })).rejects.toMatchObject({ telemetry: { reason: "policy_missing" } });

    enablePolicy({ expectedModel: "other-model" });
    await expect(callProviderWithTelemetry({
      provider,
      operation: "summarize",
      callRole: "single",
      callIndex: 1,
      systemPrompt: "system",
      userPrompt: "user",
      callOptions: { model: "gpt-5.4", maxTokens: 20 },
      telemetry,
    })).rejects.toMatchObject({ telemetry: { reason: "model_drift" } });
    expect(provider.summarize).not.toHaveBeenCalled();
  });
});
