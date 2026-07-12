import type {
  ContextPreflightPolicy,
  MemoryProvider,
  MemoryProviderCallOptions,
  ProviderCallResult,
} from "../types.js";

export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly metadata?: ProviderCallResult["metadata"],
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export class ProviderPreflightError extends Error {
  constructor(readonly telemetry: ProviderCallTelemetry) {
    super(telemetry.reason || "provider_preflight_blocked");
    this.name = "ProviderPreflightError";
  }
}

export type ProviderPreflightStatus = "infeasible" | "preflight_unavailable";

export function isProviderPreflightError(error: unknown): error is ProviderPreflightError {
  return error instanceof ProviderPreflightError;
}

export function providerPreflightStatus(error: ProviderPreflightError): ProviderPreflightStatus {
  return error.telemetry.reason === "context_window_exceeded"
    || error.telemetry.reason === "output_limit_exceeds_model_max_tokens"
    ? "infeasible"
    : "preflight_unavailable";
}

type DetailedCall = (
  systemPrompt: string,
  userPrompt: string,
  callOptions?: MemoryProviderCallOptions,
) => Promise<ProviderCallResult>;

function findDetailedCall(
  provider: MemoryProvider,
  operation: ProviderCallOperation,
): DetailedCall | null {
  const methodName = operation === "summarize"
    ? "summarizeWithMetadata"
    : "compressWithMetadata";
  const direct = provider[methodName];
  if (direct) return direct.bind(provider);

  const wrapped = provider as MemoryProvider & {
    inner?: MemoryProvider;
    call?: (fn: () => Promise<ProviderCallResult>) => Promise<ProviderCallResult>;
  };
  if (!wrapped.inner) return null;
  const innerCall = findDetailedCall(wrapped.inner, operation);
  if (!innerCall) return null;
  if (wrapped.call) {
    return (systemPrompt, userPrompt, callOptions) =>
      wrapped.call!(() => innerCall(systemPrompt, userPrompt, callOptions));
  }
  return innerCall;
}

export type ProviderCallOperation = "summarize" | "compress";
export type ProviderCallRole = "single" | "map" | "reduce" | "window";
export type ProviderCallIndex = number | string;

export interface ProviderCallTelemetry {
  operation: ProviderCallOperation;
  callRole: ProviderCallRole;
  callIndex: ProviderCallIndex;
  durationMs: number;
  metadataStatus: "supported" | "unsupported";
  metadata?: ProviderCallResult["metadata"];
  providerInvoked?: boolean;
  preflightBlocked?: boolean;
  reason?: string;
  promptChars?: number;
  estimatedInputTokens?: number;
  totalRequestedTokens?: number;
  contextWindow?: number;
  modelMaxTokens?: number;
  calibrationHash?: string;
}

function recordTelemetry(
  telemetry: ProviderCallTelemetry[],
  record: ProviderCallTelemetry,
): void {
  if (!telemetry.some((item) => item.callIndex === record.callIndex)) {
    telemetry.push(record);
  }
}

export async function callProviderWithTelemetry(options: {
  provider: MemoryProvider;
  operation: ProviderCallOperation;
  callRole: ProviderCallRole;
  callIndex: ProviderCallIndex;
  systemPrompt: string;
  userPrompt: string;
  callOptions?: MemoryProviderCallOptions;
  telemetry: ProviderCallTelemetry[];
}): Promise<string> {
  let policy: ContextPreflightPolicy | undefined;
  let policyError: string | undefined;
  try {
    policy = readPolicy();
  } catch (error) {
    policyError = error instanceof Error ? error.message : "policy_invalid";
  }
  if (policyError) {
    const record: ProviderCallTelemetry = {
      operation: options.operation,
      callRole: options.callRole,
      callIndex: options.callIndex,
      durationMs: 0,
      metadataStatus: "unsupported",
      providerInvoked: false,
      preflightBlocked: true,
      reason: policyError,
      promptChars: options.systemPrompt.length + options.userPrompt.length,
    };
    recordTelemetry(options.telemetry, record);
    throw new ProviderPreflightError(record);
  }
  if (policy) {
    const preflight = evaluatePreflight(policy, options.provider, options.systemPrompt, options.userPrompt, options.callOptions);
    if (!preflight.ok) {
      const record: ProviderCallTelemetry = {
        operation: options.operation,
        callRole: options.callRole,
        callIndex: options.callIndex,
        durationMs: 0,
        metadataStatus: "unsupported",
        providerInvoked: false,
        preflightBlocked: true,
        reason: preflight.reason,
        promptChars: preflight.promptChars,
        ...(preflight.estimatedInputTokens !== undefined ? { estimatedInputTokens: preflight.estimatedInputTokens } : {}),
        ...(preflight.totalRequestedTokens !== undefined ? { totalRequestedTokens: preflight.totalRequestedTokens } : {}),
        ...(preflight.contextWindow !== undefined ? { contextWindow: preflight.contextWindow } : {}),
        ...(preflight.modelMaxTokens !== undefined ? { modelMaxTokens: preflight.modelMaxTokens } : {}),
        ...(policy.calibrationHash ? { calibrationHash: policy.calibrationHash } : {}),
      };
      recordTelemetry(options.telemetry, record);
      throw new ProviderPreflightError(record);
    }
  }
  const promptChars = options.systemPrompt.length + options.userPrompt.length;
  const startMs = Date.now();
  try {
    const result = options.operation === "summarize"
      ? await summarizeForStage(
          options.provider,
          options.systemPrompt,
          options.userPrompt,
          options.callOptions,
        )
      : await compressForStage(
          options.provider,
          options.systemPrompt,
          options.userPrompt,
          options.callOptions,
        );
    recordTelemetry(options.telemetry, {
      operation: options.operation,
      callRole: options.callRole,
      callIndex: options.callIndex,
      durationMs: Date.now() - startMs,
      promptChars,
      metadataStatus: result.metadata ? "supported" : "unsupported",
      ...(result.metadata ? { metadata: result.metadata } : {}),
      providerInvoked: true,
      ...(policy ? { preflightBlocked: false } : {}),
    });
    return result.text;
  } catch (error) {
    const metadata = error instanceof ProviderCallError
      ? error.metadata
      : undefined;
    recordTelemetry(options.telemetry, {
      operation: options.operation,
      callRole: options.callRole,
      callIndex: options.callIndex,
      durationMs: Date.now() - startMs,
      promptChars,
      metadataStatus: metadata ? "supported" : "unsupported",
      ...(metadata ? { metadata } : {}),
      providerInvoked: true,
      ...(policy ? { preflightBlocked: false } : {}),
    });
    throw error;
  }
}

function readPolicy(): ContextPreflightPolicy | undefined {
  if (process.env.AGENTMEMORY_EVALUATION_MODE !== "context-strategy") return undefined;
  const raw = process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
  if (!raw) throw new Error("policy_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("policy_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("policy_invalid");
  const value = parsed as Record<string, unknown>;
  const integerFields = [
    "fixedTokens",
    "contextWindow",
    "modelMaxTokens",
    "maxOutputTokens",
    "reasoningReserve",
    "safetyMargin",
  ];
  if (value.schemaVersion !== 1 || value.expectedProvider !== "pi-agent-sdk"
    || typeof value.expectedModel !== "string" || value.expectedModel.length === 0
    || typeof value.calibrationHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.calibrationHash)
    || typeof value.worstTokensPerChar !== "number" || !Number.isFinite(value.worstTokensPerChar) || value.worstTokensPerChar <= 0
    || typeof value.proportionalReserve !== "number" || !Number.isFinite(value.proportionalReserve)
    || value.proportionalReserve < 0 || value.proportionalReserve > 1) throw new Error("policy_invalid");
  for (const field of integerFields) {
    const number = value[field];
    if (!Number.isSafeInteger(number) || number < 0 || (field !== "reasoningReserve" && field !== "safetyMargin" && number <= 0)) {
      throw new Error("policy_invalid");
    }
  }
  return value as ContextPreflightPolicy;
}

type PreflightResult = {
  ok: true;
} | {
  ok: false;
  reason: string;
  promptChars: number;
  estimatedInputTokens?: number;
  totalRequestedTokens?: number;
  contextWindow?: number;
  modelMaxTokens?: number;
};

function providerName(provider: MemoryProvider): string {
  const name = provider.name || "";
  const resilient = name.match(/^resilient\((.*)\)$/);
  return resilient?.[1] ?? name;
}

function providerModel(provider: MemoryProvider): string | undefined {
  const candidate = provider as MemoryProvider & { model?: string; inner?: MemoryProvider };
  if (typeof candidate.model === "string" && candidate.model.length > 0) return candidate.model;
  return candidate.inner ? providerModel(candidate.inner) : undefined;
}

function evaluatePreflight(
  policy: ContextPreflightPolicy,
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  callOptions?: MemoryProviderCallOptions,
): PreflightResult {
  const promptChars = systemPrompt.length + userPrompt.length;
  if (providerName(provider) !== policy.expectedProvider) return { ok: false, reason: "provider_drift", promptChars };
  const actualModel = callOptions?.model ?? providerModel(provider);
  if (!actualModel) return { ok: false, reason: "model_unavailable", promptChars };
  if (actualModel !== policy.expectedModel) return { ok: false, reason: "model_drift", promptChars };
  const maxOutputTokens = callOptions?.maxTokens ?? policy.maxOutputTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) return { ok: false, reason: "max_output_tokens_invalid", promptChars };
  const estimatedInputTokens = Math.ceil(
    promptChars * policy.worstTokensPerChar * (1 + policy.proportionalReserve) + policy.fixedTokens,
  );
  const totalRequestedTokens = estimatedInputTokens + maxOutputTokens + policy.reasoningReserve + policy.safetyMargin;
  const details = {
    promptChars,
    estimatedInputTokens,
    totalRequestedTokens,
    contextWindow: policy.contextWindow,
    modelMaxTokens: policy.modelMaxTokens,
  };
  if (maxOutputTokens > policy.modelMaxTokens) return { ok: false, reason: "output_limit_exceeds_model_max_tokens", ...details };
  if (totalRequestedTokens > policy.contextWindow) return { ok: false, reason: "context_window_exceeded", ...details };
  return { ok: true };
}

export function sortProviderCallTelemetry(
  telemetry: ProviderCallTelemetry[],
): ProviderCallTelemetry[] {
  return [...telemetry].sort((a, b) => {
    if (typeof a.callIndex === "number" && typeof b.callIndex === "number") {
      return a.callIndex - b.callIndex;
    }
    return String(a.callIndex).localeCompare(String(b.callIndex));
  });
}

export async function summarizeForStage(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  options?: MemoryProviderCallOptions,
): Promise<ProviderCallResult> {
  const detailedCall = findDetailedCall(provider, "summarize");
  if (detailedCall) {
    return detailedCall(systemPrompt, userPrompt, options);
  }
  return options === undefined
    ? { text: await provider.summarize(systemPrompt, userPrompt) }
    : { text: await provider.summarize(systemPrompt, userPrompt, options) };
}

export async function compressForStage(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  options?: MemoryProviderCallOptions,
): Promise<ProviderCallResult> {
  const detailedCall = findDetailedCall(provider, "compress");
  if (detailedCall) {
    return detailedCall(systemPrompt, userPrompt, options);
  }
  return options === undefined
    ? { text: await provider.compress(systemPrompt, userPrompt) }
    : { text: await provider.compress(systemPrompt, userPrompt, options) };
}
