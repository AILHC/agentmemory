import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  authCalls: 0,
  registryCalls: 0,
  registryCreateArgs: [] as unknown[][],
  modelFindCalls: [] as Array<[string, string]>,
  getModelCalls: [] as Array<[string, string]>,
  codexCalls: [] as Array<{
    model: unknown;
    context: unknown;
    options: unknown;
  }>,
  textEvents: [{ type: "text_delta", text_delta: "result" }] as unknown[],
  credentialConfigured: true,
  credentialOk: true,
  apiKey: "pi-key",
  credentialsHeaders: { "x-test": "1" },
  throwStream: false,
  streamError: null as Error | null,
  providerResponses: [] as Array<{ status: number; headers: Record<string, string> }>,
  missingModel: false,
  modelFallback: null as unknown,
  getCredentialsThrows: false,
  streamForPrompt: null as ((context: unknown) => unknown[]) | null,
  cleanupCalls: [] as string[],
  sessionCounter: 0,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  cleanupSessionResources: vi.fn((sessionId: string) => {
    state.cleanupCalls.push(sessionId);
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: vi.fn(
    async function* (_model: unknown, context: unknown, options: unknown) {
      state.codexCalls.push({ model: _model, context, options });
      const onResponse = (options as {
        onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => unknown;
      }).onResponse;
      for (const response of state.providerResponses) {
        await onResponse?.(response, _model);
      }
      if (state.streamError) throw state.streamError;
      if (state.throwStream) {
        throw new Error("network failed");
      }
      const events = state.streamForPrompt?.(context) ?? state.textEvents;
      for (const event of events) {
        yield event as never;
      }
    },
  ),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: vi.fn((provider: string, model: string) => {
    state.getModelCalls.push([provider, model]);
    return state.modelFallback;
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: vi.fn(() => {
      state.sessionCounter += 1;
      const suffix = String(state.sessionCounter).padStart(12, "0");
      return { getSessionId: () => `019f5a00-0000-7000-8000-${suffix}` };
    }),
  },
  AuthStorage: {
    create: vi.fn(() => {
      state.authCalls++;
      return { authCreated: true };
    }),
  },
  ModelRegistry: {
    create: vi.fn((...args: unknown[]) => {
      state.registryCreateArgs.push(args);
      return {
      find: vi.fn((provider: string, model: string) => {
        state.modelFindCalls.push([provider, model]);
        if (state.missingModel) return undefined;
        return { provider, model };
      }),
      getApiKeyAndHeaders: vi.fn(() => {
        if (state.getCredentialsThrows) {
          throw new Error("auth backend unavailable");
        }
        if (!state.credentialConfigured || !state.credentialOk) {
          return { configured: false, ok: false };
        }
        if (!state.apiKey) {
          return { configured: true, ok: true };
        }
        return {
          configured: true,
          ok: true,
          apiKey: state.apiKey,
          headers: state.credentialsHeaders,
        };
      }),
      };
    }),
  },
}));

vi.mock("undici", () => ({
  setGlobalDispatcher: vi.fn(),
  ProxyAgent: vi.fn(function (url: string) {
    return { url };
  }),
}));

import { PiAgentSDKProvider } from "../src/providers/pi-agent-sdk.js";

import { setGlobalDispatcher, ProxyAgent } from "undici";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("PiAgentSDKProvider", () => {
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalAllProxy = process.env.ALL_PROXY;
  const originalNodeUseEnvProxy = process.env.NODE_USE_ENV_PROXY;
  const originalPiAgentModel = process.env.PI_AGENT_MODEL;
  const originalPiAgentModelsFile = process.env.PI_AGENT_MODELS_FILE;

  beforeEach(() => {
    state.authCalls = 0;
    state.registryCalls = 0;
    state.registryCreateArgs.length = 0;
    state.modelFindCalls.length = 0;
    state.getModelCalls.length = 0;
    state.codexCalls.length = 0;
    state.textEvents = [{ type: "text_delta", text_delta: "result" }];
    state.credentialConfigured = true;
    state.credentialOk = true;
    state.apiKey = "pi-key";
    state.credentialsHeaders = { "x-test": "1" };
    state.throwStream = false;
    state.streamError = null;
    state.providerResponses = [];
    state.missingModel = false;
    state.modelFallback = null;
    state.getCredentialsThrows = false;
    state.streamForPrompt = null;
    state.cleanupCalls.length = 0;
    state.sessionCounter = 0;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    process.env.NODE_USE_ENV_PROXY = "0";
    delete process.env.PI_AGENT_MODELS_FILE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("HTTPS_PROXY", originalHttpsProxy);
    restoreEnv("HTTP_PROXY", originalHttpProxy);
    restoreEnv("ALL_PROXY", originalAllProxy);
    restoreEnv("NODE_USE_ENV_PROXY", originalNodeUseEnvProxy);
    restoreEnv("PI_AGENT_MODEL", originalPiAgentModel);
    restoreEnv("PI_AGENT_MODELS_FILE", originalPiAgentModelsFile);
  });

  it("loads an explicit experiment model catalog without changing auth storage", async () => {
    process.env.PI_AGENT_MODELS_FILE = "F:/isolated/models.json";
    const provider = new PiAgentSDKProvider("gpt-5.6-luna");

    await provider.resolveModelCapabilities();

    expect(state.registryCreateArgs[0]).toEqual([
      { authCreated: true },
      "F:/isolated/models.json",
    ]);
  });

  it("forwards caller system/user prompts and keeps context payload clean", async () => {
    const provider = new PiAgentSDKProvider("gpt-5.4", 512);
    const out = await provider.summarize("system prompt", "user prompt");
    expect(out).toBe("result");

    const call = state.codexCalls[0];
    expect(call).toBeDefined();
    expect(call.model).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
    expect(call.context).toEqual({
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "user prompt" }],
      tools: [],
    });
    expect(call.options).toMatchObject({
      apiKey: "pi-key",
      headers: { "x-test": "1" },
      maxTokens: 512,
      transport: "sse",
      sessionId: "019f5a00-0000-7000-8000-000000000001",
    });
    expect((call.options as Record<string, unknown>).reasoning).toBeUndefined();
    expect((call.context as Record<string, unknown>).sessionId).toBeUndefined();
    expect(state.cleanupCalls).toEqual(["019f5a00-0000-7000-8000-000000000001"]);
  });

  it("cleans up the independent pi session when streaming fails", async () => {
    state.throwStream = true;
    const provider = new PiAgentSDKProvider("gpt-5.4");

    await expect(provider.summarize("sys", "prompt")).rejects.toThrow("pi_stream_failed");

    expect(state.cleanupCalls).toEqual(["019f5a00-0000-7000-8000-000000000001"]);
  });

  it("reuses the same call flow for compress and summarize", async () => {
    const provider = new PiAgentSDKProvider("gpt-5.4");
    const out1 = await provider.compress("sys", "c prompt");
    state.textEvents = [{ type: "text_delta", text_delta: "A" }];
    const out2 = await provider.summarize("sys", "s prompt");
    expect(out1).toBe("result");
    expect(out2).toBe("A");
    expect(state.codexCalls).toHaveLength(2);
  });

  it("uses the proxy dispatcher and forces env proxy when proxy env is set", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const provider = new PiAgentSDKProvider();
    const out = await provider.summarize("sys", "prompt");
    expect(out).toBe("result");
    expect(process.env.NODE_USE_ENV_PROXY).toBe("1");
    expect(setGlobalDispatcher).toHaveBeenCalledWith(expect.objectContaining({ url: process.env.HTTPS_PROXY }));
    expect(ProxyAgent).toHaveBeenCalledWith(process.env.HTTPS_PROXY);
  });

  it("reuses the proxy dispatcher across repeated calls with the same proxy", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const provider = new PiAgentSDKProvider();

    await provider.summarize("sys", "first prompt");
    await provider.summarize("sys", "second prompt");

    expect(ProxyAgent).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("uses per-call model and maxTokens options without changing defaults or model env", async () => {
    process.env.PI_AGENT_MODEL = "env-model";
    const provider = new PiAgentSDKProvider("gpt-5.4", 512);
    const modelEnvBefore = process.env.PI_AGENT_MODEL;

    await provider.summarize("sys", "override prompt", {
      model: "gpt-5.5-stage",
      maxTokens: 777,
      modelSource: "explicitModel",
    });
    state.textEvents = [{ type: "text_delta", text_delta: "default result" }];
    await provider.summarize("sys", "default prompt");

    expect(state.modelFindCalls[0]).toEqual(["openai-codex", "gpt-5.5-stage"]);
    expect(state.modelFindCalls[1]).toEqual(["openai-codex", "gpt-5.4"]);
    expect(state.codexCalls[0].model).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5-stage",
    });
    expect(state.codexCalls[0].options).toMatchObject({ maxTokens: 777 });
    expect(state.codexCalls[1].model).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(state.codexCalls[1].options).toMatchObject({ maxTokens: 512 });
    expect(process.env.PI_AGENT_MODEL).toBe(modelEnvBefore);
  });

  it("maps model fallback from ModelRegistry.find to pi_model_not_found", async () => {
    state.missingModel = true;
    state.modelFallback = null;
    const provider = new PiAgentSDKProvider();
    await expect(provider.summarize("sys", "prompt")).rejects.toThrow(
      "pi_model_not_found",
    );
  });

  it("maps auth missing when configured is false", async () => {
    state.credentialConfigured = false;
    state.credentialOk = false;
    const provider = new PiAgentSDKProvider();
    await expect(provider.summarize("sys", "prompt")).rejects.toThrow(
      "pi_auth_missing",
    );
  });

  it("maps auth failure when no apiKey is returned", async () => {
    state.apiKey = "";
    const provider = new PiAgentSDKProvider();
    await expect(provider.summarize("sys", "prompt")).rejects.toThrow(
      "pi_auth_failed",
    );
  });

  it("maps stream errors to pi_stream_failed", async () => {
    state.throwStream = true;
    const provider = new PiAgentSDKProvider();
    await expect(provider.summarize("sys", "prompt")).rejects.toThrow(
      "pi_stream_failed",
    );
  });

  it("maps empty stream output to pi_empty_response", async () => {
    state.textEvents = [];
    const provider = new PiAgentSDKProvider();
    await expect(provider.summarize("sys", "prompt")).rejects.toThrow(
      "pi_empty_response",
    );
  });

  it("returns done stop telemetry without changing the string summarize interface", async () => {
    state.textEvents = [
      { type: "text_delta", text_delta: "result" },
      {
        type: "done",
        reason: "stop",
        message: {
          model: "requested-model",
          responseModel: "actual-model",
          usage: { input: 12, output: 4, totalTokens: 16 },
        },
      },
    ];
    const provider = new PiAgentSDKProvider("gpt-5.4", 512);

    await expect(provider.summarize("sys", "prompt")).resolves.toBe("result");
    await expect(provider.summarizeWithMetadata("sys", "prompt")).resolves.toEqual({
      text: "result",
      metadata: {
        inputTokens: 12,
        inputUncachedTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 4,
        totalTokens: 16,
        maxOutputTokens: 512,
        stopReason: "stop",
        responseModel: "actual-model",
        contextWindow: undefined,
        modelMaxTokens: undefined,
      },
    });
  });

  it("normalizes Pi cache usage into comparable total input tokens", async () => {
    state.textEvents = [
      { type: "text_delta", text_delta: "result" },
      {
        type: "done",
        reason: "stop",
        message: {
          model: "gpt-5.4-mini",
          usage: {
            input: 10,
            cacheRead: 100,
            cacheWrite: 7,
            output: 5,
            totalTokens: 999,
          },
        },
      },
    ];
    const provider = new PiAgentSDKProvider();

    await expect(provider.summarizeWithMetadata("sys", "prompt")).resolves.toEqual({
      text: "result",
      metadata: expect.objectContaining({
        inputTokens: 117,
        inputUncachedTokens: 10,
        cacheReadTokens: 100,
        cacheWriteTokens: 7,
        outputTokens: 5,
        totalTokens: 122,
      }),
    });
  });

  it("omits token totals when the event omits every input component", async () => {
    state.textEvents = [
      { type: "text_delta", text_delta: "result" },
      {
        type: "done",
        reason: "stop",
        message: { model: "gpt-5.4-mini", usage: { output: 3 } },
      },
    ];
    const provider = new PiAgentSDKProvider();

    const result = await provider.summarizeWithMetadata("sys", "prompt");
    expect(result.metadata).toMatchObject({ outputTokens: 3 });
    expect(result.metadata).not.toHaveProperty("inputTokens");
    expect(result.metadata).not.toHaveProperty("inputUncachedTokens");
    expect(result.metadata).not.toHaveProperty("cacheReadTokens");
    expect(result.metadata).not.toHaveProperty("cacheWriteTokens");
    expect(result.metadata).not.toHaveProperty("totalTokens");
  });

  it("normalizes done length telemetry and returns registry model capabilities", async () => {
    state.textEvents = [
      { type: "text_delta", text_delta: "partial" },
      {
        type: "done",
        reason: "length",
        message: {
          model: "gpt-5.4",
          usage: { input: 9, output: 512, totalTokens: 521 },
        },
      },
    ];
    state.modelFallback = {
      provider: "openai-codex",
      model: "gpt-5.4",
      contextWindow: 128000,
      maxTokens: 8192,
    };
    state.missingModel = true;
    const provider = new PiAgentSDKProvider();

    await expect(provider.summarizeWithMetadata("sys", "prompt")).resolves.toEqual({
      text: "partial",
      metadata: {
        inputTokens: 9,
        inputUncachedTokens: 9,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 512,
        totalTokens: 521,
        maxOutputTokens: 4096,
        stopReason: "max_tokens",
        responseModel: "gpt-5.4",
        contextWindow: 128000,
        modelMaxTokens: 8192,
      },
    });
    await expect(provider.resolveModelCapabilities()).resolves.toEqual({
      contextWindow: 128000,
      modelMaxTokens: 8192,
    });
  });

  it("keeps concurrent detailed results isolated", async () => {
    state.streamForPrompt = (context) => {
      const prompt = (context as { messages: Array<{ content: string }> }).messages[0].content;
      const route = {
        first: { text: "one", model: "model-one", input: 1, cacheRead: 10, cacheWrite: 100, output: 3 },
        second: { text: "two", model: "model-two", input: 2, cacheRead: 20, cacheWrite: 200, output: 4 },
        third: { text: "three", model: "model-three", input: 3, cacheRead: 30, cacheWrite: 300, output: 5 },
      }[prompt as "first" | "second" | "third"];
      return [
        { type: "text_delta", text_delta: route.text },
        {
          type: "done",
          reason: "stop",
          message: {
            model: route.model,
            usage: {
              input: route.input,
              cacheRead: route.cacheRead,
              cacheWrite: route.cacheWrite,
              output: route.output,
            },
          },
        },
      ];
    };
    const provider = new PiAgentSDKProvider();

    await expect(Promise.all([
      provider.summarizeWithMetadata("sys", "first"),
      provider.summarizeWithMetadata("sys", "second"),
      provider.summarizeWithMetadata("sys", "third"),
    ])).resolves.toEqual([
      {
        text: "one",
        metadata: expect.objectContaining({
          inputTokens: 111,
          cacheReadTokens: 10,
          cacheWriteTokens: 100,
          outputTokens: 3,
          totalTokens: 114,
          responseModel: "model-one",
        }),
      },
      {
        text: "two",
        metadata: expect.objectContaining({
          inputTokens: 222,
          cacheReadTokens: 20,
          cacheWriteTokens: 200,
          outputTokens: 4,
          totalTokens: 226,
          responseModel: "model-two",
        }),
      },
      {
        text: "three",
        metadata: expect.objectContaining({
          inputTokens: 333,
          cacheReadTokens: 30,
          cacheWriteTokens: 300,
          outputTokens: 5,
          totalTokens: 338,
          responseModel: "model-three",
        }),
      },
    ]);
    const sessionIds = state.codexCalls.map((call) => (call.options as { sessionId: string }).sessionId);
    expect(new Set(sessionIds).size).toBe(3);
    expect([...state.cleanupCalls].sort()).toEqual([...sessionIds].sort());
  });

  it("maps error events to the existing stream error while preserving error telemetry", async () => {
    state.textEvents = [
      {
        type: "error",
        reason: "error",
        error: {
          model: "requested-model",
          responseModel: "actual-model",
          usage: {
            input: 1,
            cacheRead: 10,
            cacheWrite: 2,
            output: 0,
            totalTokens: 1,
          },
        },
      },
    ];
    const provider = new PiAgentSDKProvider("gpt-5.4", 256);
    const error = await provider.summarizeWithMetadata("sys", "prompt").catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "pi_stream_failed",
      metadata: {
        providerErrorCode: "unknown",
        maxOutputTokens: 256,
        inputChars: 9,
        responseStarted: false,
        stopReason: "error",
        responseModel: "actual-model",
      },
    });
    await expect(provider.summarize("sys", "prompt")).rejects.toThrow("pi_stream_failed");
  });

  it("classifies a provider model-not-found error without exposing its message", async () => {
    state.textEvents = [
      {
        type: "error",
        reason: "error",
        error: {
          model: "gpt-5.6-luna",
          stopReason: "error",
          errorMessage: "Model not found gpt-5.6-luna",
          usage: { input: 0, output: 0 },
        },
      },
    ];
    const provider = new PiAgentSDKProvider("gpt-5.6-luna");
    const error = await provider.summarizeWithMetadata("sys", "prompt").catch((err) => err);

    expect(error).toMatchObject({
      message: "pi_stream_failed",
      metadata: {
        providerErrorCode: "model_not_found",
        responseModel: "gpt-5.6-luna",
        stopReason: "error",
      },
    });
    expect(JSON.stringify(error.metadata)).not.toContain("Model not found");
  });

  it.each([
    ["Rate limit exceeded", "rate_limited"],
    ["Request timed out", "timeout"],
    ["Request rejected by provider", "provider_rejected"],
    ["Unexpected upstream failure", "unknown"],
  ])("classifies provider error '%s' as %s", async (errorMessage, expectedCode) => {
    state.textEvents = [
      {
        type: "error",
        reason: "error",
        error: {
          model: "requested-model",
          stopReason: "error",
          errorMessage,
          usage: { input: 0, output: 0 },
        },
      },
    ];
    const provider = new PiAgentSDKProvider("requested-model");
    const error = await provider.summarizeWithMetadata("sys", "prompt").catch((err) => err);

    expect(error.metadata?.providerErrorCode).toBe(expectedCode);
    expect(JSON.stringify(error.metadata)).not.toContain(errorMessage);
  });

  it.each([
    {
      name: "rate limit",
      response: {
        status: 429,
        headers: {
          "retry-after-ms": "2500",
          authorization: "credential-marker",
          "x-provider-error": "header-marker",
        },
      },
      errorMessage: "rate limited raw-error-marker prompt-marker",
      expected: { providerErrorCode: "rate_limited", statusCode: 429, retryAfterMs: 2500 },
    },
    {
      name: "upstream server error",
      response: { status: 503, headers: { "retry-after": "2" } },
      errorMessage: "upstream body raw-error-marker",
      expected: { providerErrorCode: "server_error", statusCode: 503, retryAfterMs: 2000 },
    },
    {
      name: "provider rejection",
      response: { status: 400, headers: {} },
      errorMessage: "rejected raw-error-marker",
      expected: { providerErrorCode: "provider_rejected", statusCode: 400 },
    },
  ])("captures allowlisted diagnostics for $name", async ({ response, errorMessage, expected }) => {
    state.providerResponses = [response];
    state.textEvents = [{
      type: "error",
      reason: "error",
      error: {
        model: "requested-model",
        responseModel: "actual-model",
        stopReason: "error",
        errorMessage,
        rawError: "raw-object-marker",
        prompt: "prompt-marker",
        headers: { authorization: "credential-marker" },
      },
    }];
    const provider = new PiAgentSDKProvider("requested-model", 321);

    const error = await provider.summarizeWithMetadata("system", "user-input").catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.metadata).toEqual({
      ...expected,
      elapsedMs: expect.any(Number),
      inputChars: 16,
      maxOutputTokens: 321,
      responseStarted: false,
      responseModel: "actual-model",
      stopReason: "error",
    });
    expect(error.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(error.metadata);
    for (const marker of [
      "raw-error-marker",
      "raw-object-marker",
      "prompt-marker",
      "header-marker",
      "credential-marker",
    ]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it.each([
    [new Error("Request timed out raw-error-marker"), "timeout"],
    [new TypeError("fetch failed credential-marker"), "network_error"],
    [new TypeError("internal invariant failed raw-error-marker"), "unknown"],
    [new Error("unclassified raw-error-marker"), "unknown"],
  ])("normalizes thrown stream errors without retaining their message", async (streamError, providerErrorCode) => {
    state.streamError = streamError;
    const provider = new PiAgentSDKProvider("requested-model", 222);

    const error = await provider.summarizeWithMetadata("system", "user-input").catch((caught) => caught);

    expect(error).toMatchObject({
      message: "pi_stream_failed",
      metadata: {
        providerErrorCode,
        elapsedMs: expect.any(Number),
        inputChars: 16,
        maxOutputTokens: 222,
        responseStarted: false,
      },
    });
    expect(JSON.stringify(error.metadata)).not.toContain(streamError.message);
  });

  it("marks responseStarted after partial text without retaining the interrupted response", async () => {
    state.providerResponses = [{ status: 200, headers: { "x-secret": "header-marker" } }];
    state.textEvents = [
      { type: "text_delta", text_delta: "partial prompt-marker" },
      {
        type: "error",
        reason: "error",
        error: {
          responseModel: "actual-model",
          stopReason: "error",
          errorMessage: "stream ended raw-error-marker",
        },
      },
    ];
    const provider = new PiAgentSDKProvider("requested-model", 333);

    const error = await provider.summarizeWithMetadata("system", "user-input").catch((caught) => caught);

    expect(error.metadata).toEqual({
      providerErrorCode: "unknown",
      statusCode: 200,
      elapsedMs: expect.any(Number),
      inputChars: 16,
      maxOutputTokens: 333,
      responseStarted: true,
      responseModel: "actual-model",
      stopReason: "error",
    });
    expect(JSON.stringify(error.metadata)).not.toContain("partial prompt-marker");
    expect(JSON.stringify(error.metadata)).not.toContain("raw-error-marker");
    expect(JSON.stringify(error.metadata)).not.toContain("header-marker");
  });

  it("maps aborted error events with a message stopReason fallback", async () => {
    state.textEvents = [
      {
        type: "error",
        error: {
          model: "gpt-5.4",
          stopReason: "aborted",
          usage: { input: 5, output: 2, totalTokens: 7 },
        },
      },
    ];
    const provider = new PiAgentSDKProvider();
    const error = await provider.summarizeWithMetadata("sys", "prompt", { maxTokens: 99 }).catch((err) => err);

    expect(error).toMatchObject({
      message: "pi_stream_failed",
      metadata: {
        providerErrorCode: "unknown",
        elapsedMs: expect.any(Number),
        inputChars: 9,
        maxOutputTokens: 99,
        responseStarted: false,
        stopReason: "aborted",
        responseModel: "gpt-5.4",
      },
    });
  });
});
