import { ProxyAgent, setGlobalDispatcher } from "undici";
import type {
  MemoryProvider,
  MemoryProviderCallOptions,
  ModelCapabilities,
  ProviderCallMetadata,
  ProviderErrorCode,
  ProviderFailureDiagnostics,
  ProviderCallResult,
} from "../types.js";
import { getEnvVar } from "../config.js";
import { ProviderCallError } from "./provider-call-result.js";

type OpenAICodexResponsesModule = typeof import("@earendil-works/pi-ai/compat");
type PiAiCoreModule = typeof import("@earendil-works/pi-ai");
type PiAiModule = typeof import("@earendil-works/pi-ai/providers/all");
type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

type ModuleBundle = {
  codex: OpenAICodexResponsesModule;
  core: PiAiCoreModule;
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
  sessionId: string;
  timeoutMs?: number;
  onResponse?: (
    response: { status: number; headers: Record<string, string> },
    model: unknown,
  ) => void | Promise<void>;
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function providerErrorCode(error: unknown, statusCode?: number): ProviderErrorCode {
  const detail = isObject(error) ? error : {};
  const message = error instanceof Error
    ? error.message
    : typeof detail["errorMessage"] === "string"
      ? detail["errorMessage"]
      : "";
  if (/model not found/i.test(message)) return "model_not_found";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 401 || statusCode === 403) return "auth_failed";
  if (statusCode !== undefined && statusCode >= 500) return "server_error";
  if (statusCode !== undefined && statusCode >= 400) return "provider_rejected";
  if (/rate limit|too many requests/i.test(message)) return "rate_limited";
  if (/timed out|timeout|request was aborted/i.test(message)) return "timeout";
  if (/fetch failed|network|econnreset|socket|connection/i.test(message)) {
    return "network_error";
  }
  if (/rejected|unsupported|forbidden|not available|invalid request/i.test(message)) {
    return "provider_rejected";
  }
  return "unknown";
}

function safeInteger(value: unknown, minimum = 0): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= minimum
    ? Number(value)
    : undefined;
}

function responseHeader(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function retryAfterMs(headers: Record<string, string>): number | undefined {
  const direct = responseHeader(headers, "retry-after-ms");
  if (direct !== undefined) {
    const parsed = Number(direct);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  const retryAfter = responseHeader(headers, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return safeInteger(seconds * 1000);
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? safeInteger(Math.max(0, date - Date.now())) : undefined;
}

function responseModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(normalized)
    ? normalized
    : undefined;
}

function providerStopReason(value: unknown): ProviderFailureDiagnostics["stopReason"] {
  if (value === "length") return "max_tokens";
  if (value === "toolUse") return "tool_use";
  if (["stop", "error", "aborted"].includes(String(value))) {
    return value as ProviderFailureDiagnostics["stopReason"];
  }
  return undefined;
}

type ResponseEvidence = {
  statusCode?: number;
  retryAfterMs?: number;
};

function failureDiagnostics(options: {
  error: unknown;
  evidence: ResponseEvidence;
  startedAt: number;
  inputChars: number;
  maxOutputTokens: number;
  responseStarted: boolean;
  responseModel?: unknown;
  stopReason?: unknown;
}): ProviderFailureDiagnostics {
  const statusCode = safeInteger(options.evidence.statusCode);
  const retryMs = safeInteger(options.evidence.retryAfterMs);
  const model = responseModel(options.responseModel);
  const stopReason = providerStopReason(options.stopReason);
  return {
    providerErrorCode: providerErrorCode(options.error, statusCode),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryMs === undefined ? {} : { retryAfterMs: retryMs }),
    elapsedMs: Math.max(0, Date.now() - options.startedAt),
    inputChars: options.inputChars,
    maxOutputTokens: options.maxOutputTokens,
    responseStarted: options.responseStarted,
    ...(model ? { responseModel: model } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function modelCapabilities(model: unknown): ModelCapabilities {
  if (!isObject(model)) return {};
  return {
    contextWindow: optionalNumber(model["contextWindow"]),
    modelMaxTokens: optionalNumber(model["maxTokens"]),
  };
}

function eventMetadata(
  event: CodexEvent,
  model: unknown,
  maxOutputTokens: number,
): ProviderCallMetadata {
  const message = isObject(event["message"])
    ? event["message"]
    : isObject(event["error"])
      ? event["error"]
      : {};
  const usage = isObject(message["usage"]) ? message["usage"] : {};
  const inputUncachedTokens = optionalNumber(usage["input"]);
  const cacheReadTokens = optionalNumber(usage["cacheRead"]);
  const cacheWriteTokens = optionalNumber(usage["cacheWrite"]);
  const outputTokens = optionalNumber(usage["output"]);
  const inputTokens = inputUncachedTokens === undefined
    ? undefined
    : inputUncachedTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const totalTokens = inputTokens === undefined || outputTokens === undefined
    ? undefined
    : inputTokens + outputTokens;
  const responseModel = typeof message["responseModel"] === "string"
    ? message["responseModel"]
    : typeof message["model"] === "string"
      ? message["model"]
      : undefined;
  const reason = event["reason"] ?? message["stopReason"];
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(inputUncachedTokens === undefined ? {} : { inputUncachedTokens }),
    ...(cacheReadTokens === undefined && inputUncachedTokens === undefined
      ? {}
      : { cacheReadTokens: cacheReadTokens ?? 0 }),
    ...(cacheWriteTokens === undefined && inputUncachedTokens === undefined
      ? {}
      : { cacheWriteTokens: cacheWriteTokens ?? 0 }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    maxOutputTokens,
    stopReason: reason === "length"
      ? "max_tokens"
      : reason === "toolUse"
        ? "tool_use"
        : reason === "stop"
          ? "stop"
          : reason === "error"
            ? "error"
            : reason === "aborted"
              ? "aborted"
          : undefined,
    responseModel,
    ...modelCapabilities(model),
  };
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
  if (error instanceof ProviderCallError) return error;
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
  private proxyAgent: ProxyAgent | null = null;
  private proxyAgentUrl: string | null = null;

  constructor(model?: string, maxTokens = 4096) {
    this.model = model || "gpt-5.4";
    this.maxTokens = maxTokens;
  }

  async compress(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<string> {
    return (await this.compressWithMetadata(systemPrompt, userPrompt, options)).text;
  }

  async compressWithMetadata(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<ProviderCallResult> {
    return this.summarizeWithMetadata(systemPrompt, userPrompt, options);
  }

  async summarize(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<string> {
    try {
      return (await this.call(systemPrompt, userPrompt, options)).text;
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

  async summarizeWithMetadata(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<ProviderCallResult> {
    try {
      return await this.call(systemPrompt, userPrompt, options);
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

  async resolveModelCapabilities(
    options?: MemoryProviderCallOptions,
  ): Promise<ModelCapabilities> {
    const modules = await this.loadModules();
    const { AuthStorage, ModelRegistry } = modules.codingAgent as {
      AuthStorage: { create: () => unknown };
      ModelRegistry: { create: (auth: unknown, modelsPath?: string) => { find: (provider: string, modelName: string) => unknown } };
    };
    const modelName = options?.model?.trim() || this.model;
    const registry = ModelRegistry.create(
      AuthStorage.create(),
      getEnvVar("PI_AGENT_MODELS_FILE") || undefined,
    );
    const model = registry.find("openai-codex", modelName) ??
      modules.ai.getBuiltinModel("openai-codex", modelName as never);
    if (!model) throw new Error("pi_model_not_found");
    return modelCapabilities(model);
  }

  private async call(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<ProviderCallResult> {
    const modules = await this.loadModules();
    const { AuthStorage, ModelRegistry, SessionManager } = modules.codingAgent as {
      AuthStorage: { create: () => unknown };
      ModelRegistry: { create: (auth: unknown, modelsPath?: string) => { find: (provider: string, modelName: string) => unknown; getApiKeyAndHeaders: (model: unknown) => Credentials | Promise<Credentials> }; };
      SessionManager: { inMemory: () => { getSessionId: () => string } };
    };
    const registry = ModelRegistry.create(
      AuthStorage.create(),
      getEnvVar("PI_AGENT_MODELS_FILE") || undefined,
    );
    const modelName = options?.model?.trim() || this.model;
    const maxTokens = options?.maxTokens ?? this.maxTokens;
    const model =
      registry.find("openai-codex", modelName) ??
      modules.ai.getBuiltinModel("openai-codex", modelName as never);
    if (!model) {
      throw new Error("pi_model_not_found");
    }

    this.configureProxy();

    const credentials = await this.loadCredentials(registry, model);
    const sessionId = SessionManager.inMemory().getSessionId();
    const context: StreamContext = {
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [],
    };
    const streamOptions: StreamOptions = {
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      env: process.env,
      maxTokens,
      transport: "sse",
      sessionId,
      timeoutMs: getTimeoutMs(),
    };

    try {
      let output = "";
      let metadata: ProviderCallMetadata | undefined;
      let responseStarted = false;
      const inputChars = systemPrompt.length + userPrompt.length;
      const startedAt = Date.now();
      const evidence: ResponseEvidence = {};
      streamOptions.onResponse = (response) => {
        const statusCode = safeInteger(response.status);
        evidence.statusCode = statusCode;
        evidence.retryAfterMs = retryAfterMs(response.headers);
      };
      try {
        const stream = await modules.codex.streamSimple(
          model,
          context,
          streamOptions,
        );
        for await (const rawEvent of stream as AsyncIterable<unknown>) {
          if (!isObject(rawEvent)) continue;
          if (rawEvent["type"] === "error") {
            const message = isObject(rawEvent["error"])
              ? rawEvent["error"]
              : isObject(rawEvent["message"])
                ? rawEvent["message"]
                : {};
            throw new ProviderCallError(
              "pi_stream_failed",
              failureDiagnostics({
                error: message,
                evidence,
                startedAt,
                inputChars,
                maxOutputTokens: maxTokens,
                responseStarted,
                responseModel: message["responseModel"] ?? message["model"],
                stopReason: rawEvent["reason"] ?? message["stopReason"],
              }),
            );
          }
          if (rawEvent["type"] === "done") {
            metadata = eventMetadata(rawEvent, model, maxTokens);
          }
          const text = getEventText(rawEvent as CodexEvent);
          if (text.length > 0) responseStarted = true;
          output += text;
        }
      } catch (err) {
        if (err instanceof ProviderCallError) throw err;
        throw new ProviderCallError(
          "pi_stream_failed",
          failureDiagnostics({
            error: err,
            evidence,
            startedAt,
            inputChars,
            maxOutputTokens: maxTokens,
            responseStarted,
          }),
        );
      }
      if (!output.trim()) {
        throw new Error("pi_empty_response");
      }
      return metadata ? { text: output, metadata } : { text: output };
    } finally {
      modules.core.cleanupSessionResources(sessionId);
    }
  }

  private configureProxy(): void {
    process.env.NODE_USE_ENV_PROXY = "1";
    const proxyUrl =
      process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"] || process.env["ALL_PROXY"];
    if (proxyUrl) {
      if (!this.proxyAgent || this.proxyAgentUrl !== proxyUrl) {
        this.proxyAgent = new ProxyAgent(proxyUrl);
        this.proxyAgentUrl = proxyUrl;
        setGlobalDispatcher(this.proxyAgent);
      }
    }
  }

  private async loadModules(): Promise<ModuleBundle> {
    if (this.modulesPromise) return this.modulesPromise;
    this.modulesPromise = (async () => {
      try {
        const [core, ai, codex, codingAgent] = await Promise.all([
          import("@earendil-works/pi-ai"),
          import("@earendil-works/pi-ai/providers/all"),
          import("@earendil-works/pi-ai/compat"),
          import("@earendil-works/pi-coding-agent"),
        ]);
        return { core, ai, codex, codingAgent };
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
