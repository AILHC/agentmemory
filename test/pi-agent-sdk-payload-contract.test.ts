import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  payloads: [] as unknown[],
  fakeCodexToken: "",
  model: {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevelMap: {},
  },
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return {
    ...actual,
    streamSimple: (
      model: unknown,
      context: unknown,
      options: Record<string, unknown> = {},
    ) =>
      actual.streamSimple(
        model as never,
        context as never,
        {
          ...options,
          maxRetries: 0,
          transport: "sse",
          onPayload: (payload: unknown) => {
            state.payloads.push(payload);
            throw new Error("stop_after_payload_capture");
          },
        } as never,
      ),
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: vi.fn(() => state.model),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: vi.fn(() => ({ getSessionId: () => "019f5a00-0000-7000-8000-000000000001" })),
  },
  AuthStorage: {
    create: vi.fn(() => ({})),
  },
  ModelRegistry: {
    create: vi.fn(() => ({
      find: vi.fn(() => state.model),
      getApiKeyAndHeaders: vi.fn(() => ({
        configured: true,
        ok: true,
        apiKey: state.fakeCodexToken,
        headers: { "x-test": "1" },
      })),
    })),
  },
}));

import { PiAgentSDKProvider } from "../src/providers/pi-agent-sdk.js";

describe("pi-agent-sdk OpenAI Codex Responses payload contract", () => {
  const originalNodeUseEnvProxy = process.env.NODE_USE_ENV_PROXY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalAllProxy = process.env.ALL_PROXY;

  beforeEach(() => {
    state.payloads.length = 0;
    state.fakeCodexToken = createFakeCodexJwt();
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    process.env.NODE_USE_ENV_PROXY = "0";
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("NODE_USE_ENV_PROXY", originalNodeUseEnvProxy);
    restoreEnv("HTTPS_PROXY", originalHttpsProxy);
    restoreEnv("HTTP_PROXY", originalHttpProxy);
    restoreEnv("ALL_PROXY", originalAllProxy);
  });

  it("captures the real Pi SDK payload with only caller-provided prompt content", async () => {
    const provider = new PiAgentSDKProvider("gpt-5.4", 500);

    await expect(
      provider.summarize("caller system only", "caller user only"),
    ).rejects.toThrow("pi_stream_failed");

    expect(state.payloads).toHaveLength(1);
    const payload = state.payloads[0] as Record<string, unknown>;

    expect(payload.model).toBe("gpt-5.4");
    expect(payload.instructions).toBe("caller system only");
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "caller user only" }],
      },
    ]);
    expect(payload.tools).toBeUndefined();
    expect(payload.reasoning).toBeUndefined();
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.prompt_cache_key).toBe("019f5a00-0000-7000-8000-000000000001");
    expect(payload.sessionId).toBeUndefined();
    expect(payload.session_id).toBeUndefined();

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("timestamp");
    expect(serialized).not.toContain("AgentMemory");
    expect(serialized).not.toContain("pi-agent-sdk");
    expect(serialized).not.toContain("skills");
    expect(serialized).not.toContain("extensions");
    expect(serialized).not.toContain("promptTemplate");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function createFakeCodexJwt(): string {
  const payload = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_test",
    },
  };
  return [
    "test-header",
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    "test-signature",
  ].join(".");
}
