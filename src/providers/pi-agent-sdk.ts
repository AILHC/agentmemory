import { ProxyAgent, setGlobalDispatcher } from "undici";
import type { MemoryProvider } from "../types.js";
import { getEnvVar } from "../config.js";

type OpenAICodexResponsesModule = typeof import("@earendil-works/pi-ai/openai-codex-responses");
type PiAiModule = typeof import("@earendil-works/pi-ai");
type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

type ModuleBundle = {
  codex: OpenAICodexResponsesModule;
  ai: PiAiModule;
  codingAgent: PiCodingAgentModule;
};

type Credentials = {
  ok?: boolean;
  configured?: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
};

type StreamContext = {
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
  tools: Array<string>;
};

type StreamOptions = {
  apiKey: string;
  headers?: Record<string, string>;
  env: NodeJS.ProcessEnv;
  maxTokens: number;
  transport: "sse";
  timeoutMs?: number;
};

type CodexEvent = Record<string, unknown>;

function getTimeoutMs(): number | undefined {
  const raw = getEnvVar("PI_AGENT_TIMEOUT_MS") || getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS");
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getEventText(event: CodexEvent): string {
  const maybeText = event["text_delta"] ?? event["text"];
  if (typeof maybeText === "string") return maybeText;
  const deltaValue = event["delta"];
  if (typeof deltaValue === "string") return deltaValue;
  if (
    deltaValue &&
    typeof deltaValue === "object" &&
    "text" in deltaValue &&
    typeof (deltaValue as { text?: unknown }).text === "string"
  ) {
    return (deltaValue as { text?: string }).text || "";
  }
  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mapAuthError(error: unknown): Error {
  if (error instanceof Error) {
    if (
      error.message === "pi_auth_missing" ||
      error.message === "pi_auth_failed" ||
      error.message === "pi_model_not_found"
    ) {
      return error;
    }
  }
  return new Error("pi_auth_failed");
}

function mapStreamError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message === "pi_empty_response") return error;
  }
  return new Error("pi_stream_failed");
}

export class PiAgentSDKProvider implements MemoryProvider {
  name = "pi-agent-sdk";
  private modulesPromise: Promise<ModuleBundle> | null = null;
  private model: string;
  private maxTokens: number;

  constructor(model?: string, maxTokens = 4096) {
    this.model = model || "gpt-5.4";
    this.maxTokens = maxTokens;
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.summarize(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      return await this.call(systemPrompt, userPrompt);
    } catch (err) {
      if (err instanceof Error) {
        const message = err.message;
        if (
          message === "pi_model_not_found" ||
          message === "pi_sdk_import_failed" ||
          message === "pi_auth_missing" ||
          message === "pi_auth_failed" ||
          message === "pi_stream_failed" ||
          message === "pi_empty_response"
        ) {
          return Promise.reject(err);
        }
      }
      return Promise.reject(mapStreamError(err));
    }
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const modules = await this.loadModules();
    const { AuthStorage, ModelRegistry } = modules.codingAgent as {
      AuthStorage: { create: () => unknown };
      ModelRegistry: { create: (auth: unknown) => { find: (provider: string, modelName: string) => unknown; getApiKeyAndHeaders: (model: unknown) => Credentials | Promise<Credentials> }; };
    };
    const registry = ModelRegistry.create(AuthStorage.create());
    const model =
      registry.find("openai-codex", this.model) ??
      modules.ai.getModel("openai-codex", this.model);
    if (!model) {
      throw new Error("pi_model_not_found");
    }

    this.configureProxy();

    const credentials = await this.loadCredentials(registry, model);
    const context: StreamContext = {
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [],
    };
    const options: StreamOptions = {
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      env: process.env,
      maxTokens: this.maxTokens,
      transport: "sse",
      timeoutMs: getTimeoutMs(),
    };

    let output = "";
    try {
      const stream = await modules.codex.streamSimpleOpenAICodexResponses(model, context, options);
      for await (const rawEvent of stream as AsyncIterable<unknown>) {
        if (!isObject(rawEvent)) continue;
        if (rawEvent["type"] === "error") {
          throw new Error("pi_stream_failed");
        }
        output += getEventText(rawEvent as CodexEvent);
      }
    } catch (err) {
      throw mapStreamError(err);
    }
    if (!output.trim()) {
      throw new Error("pi_empty_response");
    }
    return output;
  }

  private configureProxy(): void {
    process.env.NODE_USE_ENV_PROXY = "1";
    const proxyUrl =
      process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"] || process.env["ALL_PROXY"];
    if (proxyUrl) {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }
  }

  private async loadModules(): Promise<ModuleBundle> {
    if (this.modulesPromise) return this.modulesPromise;
    this.modulesPromise = (async () => {
      try {
        const [ai, codex, codingAgent] = await Promise.all([
          import("@earendil-works/pi-ai"),
          import("@earendil-works/pi-ai/openai-codex-responses"),
          import("@earendil-works/pi-coding-agent"),
        ]);
        return { ai, codex, codingAgent };
      } catch {
        throw new Error("pi_sdk_import_failed");
      }
    })();
    return this.modulesPromise;
  }

  private async loadCredentials(
    registry: {
      getApiKeyAndHeaders: (model: unknown) => Credentials | Promise<Credentials>;
    },
    model: unknown,
  ): Promise<{ apiKey: string; headers: Record<string, string> }> {
    let credentialsRaw: Credentials;
    try {
      credentialsRaw = await registry.getApiKeyAndHeaders(model);
    } catch (err) {
      throw mapAuthError(err);
    }
    if (!credentialsRaw || typeof credentialsRaw !== "object") {
      throw new Error("pi_auth_missing");
    }

    if (credentialsRaw.configured === false || credentialsRaw.ok === false) {
      throw new Error("pi_auth_missing");
    }

    const apiKey = credentialsRaw.apiKey;
    const headers = credentialsRaw.headers;
    if (!apiKey) {
      throw new Error("pi_auth_failed");
    }
    return {
      apiKey,
      headers: headers || {},
    };
  }
}
