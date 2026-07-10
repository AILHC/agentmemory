import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  authCalls: 0,
  registryCalls: 0,
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
  missingModel: false,
  modelFallback: null as unknown,
  getCredentialsThrows: false,
}));

vi.mock("@earendil-works/pi-ai/openai-codex-responses", () => ({
  streamSimpleOpenAICodexResponses: vi.fn(
    async function* (_model: unknown, context: unknown, options: unknown) {
      state.codexCalls.push({ model: _model, context, options });
      if (state.throwStream) {
        throw new Error("network failed");
      }
      for (const event of state.textEvents) {
        yield event as never;
      }
    },
  ),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn((provider: string, model: string) => {
    state.getModelCalls.push([provider, model]);
    return state.modelFallback;
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => {
      state.authCalls++;
      return { authCreated: true };
    }),
  },
  ModelRegistry: {
    create: vi.fn(() => ({
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
    })),
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

  beforeEach(() => {
    state.authCalls = 0;
    state.registryCalls = 0;
    state.modelFindCalls.length = 0;
    state.getModelCalls.length = 0;
    state.codexCalls.length = 0;
    state.textEvents = [{ type: "text_delta", text_delta: "result" }];
    state.credentialConfigured = true;
    state.credentialOk = true;
    state.apiKey = "pi-key";
    state.credentialsHeaders = { "x-test": "1" };
    state.throwStream = false;
    state.missingModel = false;
    state.modelFallback = null;
    state.getCredentialsThrows = false;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    process.env.NODE_USE_ENV_PROXY = "0";
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("HTTPS_PROXY", originalHttpsProxy);
    restoreEnv("HTTP_PROXY", originalHttpProxy);
    restoreEnv("ALL_PROXY", originalAllProxy);
    restoreEnv("NODE_USE_ENV_PROXY", originalNodeUseEnvProxy);
    restoreEnv("PI_AGENT_MODEL", originalPiAgentModel);
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
    });
    expect((call.options as Record<string, unknown>).reasoning).toBeUndefined();
    expect((call.context as Record<string, unknown>).sessionId).toBeUndefined();
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
});
