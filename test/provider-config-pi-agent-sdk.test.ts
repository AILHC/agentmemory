import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type EnvState = Record<string, string | undefined>;

const ENV_KEYS = [
  "AGENTMEMORY_PROVIDER",
  "AGENTMEMORY_ALLOW_PI_AGENT_SDK",
  "AGENTMEMORY_ALLOW_AGENT_SDK",
  "AGENTMEMORY_AUTO_COMPRESS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY_FOR_LLM",
  "FALLBACK_PROVIDERS",
  "PI_AGENT_MODEL",
];

const ORIGINAL_ENV: EnvState = {};

async function freshConfig() {
  vi.resetModules();
  return import("../src/config.js");
}

function setEnv(env: Partial<Record<string, string>>) {
  for (const key of Object.keys(env)) {
    const value = env[key as keyof typeof env];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("provider-config-pi-agent-sdk", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL_ENV[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL_ENV[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = ORIGINAL_ENV[key];
      }
    }
  });

  it("loads pi-agent-sdk when explicit provider and allow flag are both enabled", async () => {
    setEnv({
      AGENTMEMORY_PROVIDER: "pi-agent-sdk",
      AGENTMEMORY_ALLOW_PI_AGENT_SDK: "true",
    });
    const cfg = await freshConfig();
    const provider = cfg.loadConfig().provider;
    expect(provider.provider).toBe("pi-agent-sdk");
    expect(provider.model).toBe("gpt-5.4");
    expect(cfg.detectLlmProviderKind()).toBe("llm");
    expect(cfg.isConsolidationEnabled()).toBe(true);
  });

  it("keeps noop when pi-agent-sdk is explicit but allow flag is missing", async () => {
    setEnv({
      AGENTMEMORY_PROVIDER: "pi-agent-sdk",
      OPENAI_API_KEY: "sk-test-openai",
    });
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("noop");
    expect(cfg.detectLlmProviderKind()).toBe("noop");
    expect(cfg.isConsolidationEnabled()).toBe(false);
  });

  it("does not require OpenAI key for pi-agent-sdk", async () => {
    setEnv({
      AGENTMEMORY_PROVIDER: "pi-agent-sdk",
      AGENTMEMORY_ALLOW_PI_AGENT_SDK: "true",
    });
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("pi-agent-sdk");
    expect(cfg.loadConfig().provider.model).toBe("gpt-5.4");
  });

  it("does not enable agent-sdk when only the pi allow flag is set", async () => {
    setEnv({
      AGENTMEMORY_ALLOW_PI_AGENT_SDK: "true",
    });
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("noop");
    expect(cfg.detectLlmProviderKind()).toBe("noop");
    expect(cfg.isConsolidationEnabled()).toBe(false);
  });

  it("explicit pi-agent-sdk takes precedence over OpenAI env vars and no-openai model fallback", async () => {
    setEnv({
      AGENTMEMORY_PROVIDER: "pi-agent-sdk",
      AGENTMEMORY_ALLOW_PI_AGENT_SDK: "true",
      OPENAI_API_KEY: "sk-test-openai",
      OPENAI_MODEL: "gpt-4o-mini",
      PI_AGENT_MODEL: "gpt-5.4",
    });
    const cfg = await freshConfig();
    const provider = cfg.loadConfig().provider;
    expect(provider.provider).toBe("pi-agent-sdk");
    expect(provider.model).toBe("gpt-5.4");
  });

  it("filters pi-agent-sdk out of FALLBACK_PROVIDERS even with the flag enabled", async () => {
    setEnv({
      AGENTMEMORY_ALLOW_AGENT_SDK: "true",
      AGENTMEMORY_ALLOW_PI_AGENT_SDK: "true",
      FALLBACK_PROVIDERS: "pi-agent-sdk,openai,agent-sdk",
    });
    const cfg = await freshConfig();
    expect(cfg.loadFallbackConfig().providers).toEqual(["openai", "agent-sdk"]);
  });

  it("also keeps pi-agent-sdk out of fallback when the allow flag is missing", async () => {
    setEnv({
      FALLBACK_PROVIDERS: "pi-agent-sdk,openai",
    });
    const cfg = await freshConfig();
    expect(cfg.loadFallbackConfig().providers).toEqual(["openai"]);
  });
});
