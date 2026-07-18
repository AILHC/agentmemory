import type {
  CompressedObservation,
  Lesson,
  MemoryProvider,
  MemoryProviderCallOptions,
  RawObservation,
  LessonFailureDiagnostics,
  LessonParseErrorCode,
} from "../types.js";
import { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import { validateOutput } from "../eval/validator.js";
import { LessonExtractionOutputSchema } from "../eval/schemas.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import { resolveOutputLanguage } from "../prompts/output-language.js";
import {
  LESSON_EXTRACTION_SYSTEM,
  LESSON_EXTRACTION_OUTPUT_CONTRACT,
  type LessonPromptItem,
  buildLessonExtractionPrompt,
  parseLessonExtractionXmlWithRootRecovery,
  truncateForLessonPrompt,
} from "../prompts/lesson-extraction.js";
import { stripPrivateData } from "./privacy.js";
import { logger } from "../logger.js";
import type { LlmLessonExtractionRuntimeConfig } from "./lesson-extraction-runs.js";
import { resolveStageModelCallOptions } from "../config.js";
import { ProviderCallError } from "../providers/provider-call-result.js";
import {
  sanitizeLessonFailureDiagnostics,
  sanitizeStageFailureDiagnostics,
} from "./summarize.js";

export interface ReplayLessonExtractionConfig {
  enabled: boolean;
  textLimit: number;
  matchLimit: number;
  saveLimit: number;
  additionalHeuristicTerms: string[];
  allowUnbounded: boolean;
}

export interface ExtractedLessonCandidate {
  content: string;
  context: string;
  confidence: number;
  importance: number;
  tags: string[];
  evidence: string;
  source: "heuristic" | "llm";
}

export interface HeuristicExtractionInput {
  rawObservations: RawObservation[];
  config: ReplayLessonExtractionConfig;
  firstPrompt?: string;
  project: string;
}

export interface LlmExtractionInput {
  rawObservations: RawObservation[];
  compressedObservations: CompressedObservation[];
  config: {
    textLimit: number;
    chunkSize?: number;
    chunkConcurrency?: number;
    timeoutMs?: number;
    saveLimit?: number;
    model?: string;
    modelSource?: string;
  };
  project: string;
  firstPrompt?: string;
  sessionId: string;
  provider: MemoryProvider;
}

export interface ExtractLlmLessonsInput {
  kv: StateKV;
  provider: MemoryProvider;
  sessionId: string;
  project: string;
  rawObservations: RawObservation[];
  compressedObservations: CompressedObservation[];
  firstPrompt?: string;
  config: LlmLessonExtractionRuntimeConfig;
  sourceRunId: string;
}

export interface ExtractLlmLessonsResult {
  lessonIds: string[];
  created: number;
  reinforced: number;
  skipped: number;
  errors: string[];
  promptChars?: number;
  parseFailures?: number;
  failureDiagnostics?: LessonFailureDiagnostics;
}

export interface ExtractLessonsInput {
  kv: StateKV;
  sessionId: string;
  project: string;
  rawObservations: RawObservation[];
  firstPrompt?: string;
  config: ReplayLessonExtractionConfig;
}

export interface ExtractLessonsResult {
  lessonIds: string[];
  created: number;
  reinforced: number;
  skipped: number;
  errors: string[];
}

export const DEFAULT_REPLAY_LESSON_TEXT_LIMIT = 200;
export const DEFAULT_REPLAY_LESSON_MATCH_LIMIT = 40;
export const DEFAULT_REPLAY_LESSON_SAVE_LIMIT = 20;
export const DEFAULT_REPLAY_LESSON_LLM_TEXT_LIMIT = 1200;
export const DEFAULT_REPLAY_LESSON_LLM_SAVE_LIMIT = 50;
export const DEFAULT_REPLAY_LESSON_LLM_CHUNK_SIZE = 120;
export const DEFAULT_REPLAY_LESSON_LLM_CHUNK_CONCURRENCY = 3;

const DEFAULT_CHINESE_HEURISTIC_TERMS = [
  "记住",
  "不要",
  "不要再",
  "避免",
  "必须",
  "不应该",
  "经验是",
  "原则是",
  "约束是",
  "教训是",
  "禁止",
  "务必",
  "不得",
  "不能",
  "别",
  "先不要",
  "保持默认",
  "必须先",
];

export const DEFAULT_REPLAY_LESSON_CONFIG: ReplayLessonExtractionConfig = {
  enabled: true,
  textLimit: DEFAULT_REPLAY_LESSON_TEXT_LIMIT,
  matchLimit: DEFAULT_REPLAY_LESSON_MATCH_LIMIT,
  saveLimit: DEFAULT_REPLAY_LESSON_SAVE_LIMIT,
  additionalHeuristicTerms: [],
  allowUnbounded: false,
};

const LEARNING_PATTERNS = [
  /\b(always|never|don'?t|do not|make sure|remember to|note:|caveat:|warning:)\b[^.\n]{10,200}[.!\n]/gi,
  /\b(prefer|avoid)\s[^.\n]{10,200}[.!\n]/gi,
];

const MAX_LESSON_EVIDENCE_CHARS = 500;
const DEFAULT_LESSON_EXTRACT_TIMEOUT_MS = 30_000;

function toInt(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
  }
  return Number.NaN;
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed = toInt(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LESSON_EXTRACT_TIMEOUT_MS;
  return parsed;
}

async function callWithTimeout(
  fn: () => Promise<string>,
  timeoutMs: number,
): Promise<string> {
  const task = fn();
  task.catch(() => {});
  if (timeoutMs <= 0) return task;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("network_error"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function compressWithOptions(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  callOptions?: MemoryProviderCallOptions,
): Promise<string> {
  return callOptions
    ? provider.compress(systemPrompt, userPrompt, callOptions)
    : provider.compress(systemPrompt, userPrompt);
}

function getEvidenceLabel(): string {
  return resolveOutputLanguage() === "zh-CN" ? "证据:" : "Evidence:";
}

function sanitizeEvidence(raw?: string): string {
  const sanitized = normalizeText(stripPrivateData(raw ?? ""));
  if (!sanitized) return "";
  return sanitized.slice(0, MAX_LESSON_EVIDENCE_CHARS);
}

function appendEvidenceToContext(context: string, evidence: string): string {
  if (!evidence) return context;
  const label = getEvidenceLabel();
  if (context.includes("Evidence:") || context.includes("证据:")) return context;
  return context ? `${context}\n${label} ${evidence}` : `${label} ${evidence}`;
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeContent(input: string): string {
  return normalizeText(input).toLowerCase();
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return fallback;
  const lower = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;
  return fallback;
}

function parseIntFromUnknown(
  raw: unknown,
  fallback: number,
  allowUnbounded: boolean,
  zeroMeansUnlimited: boolean,
): number {
  const parsed = typeof raw === "number"
    ? Math.trunc(raw)
    : typeof raw === "string"
      ? Number.parseInt(raw.trim(), 10)
      : Number.NaN;

  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0) {
    return allowUnbounded && zeroMeansUnlimited ? 0 : fallback;
  }
  return parsed;
}

function resolveLimit(raw: number): number {
  return raw <= 0 ? Number.POSITIVE_INFINITY : raw;
}

function parseAdditionalTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAdditionalTermsFromEnv(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return parseAdditionalTerms(parsed);
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const next = normalizeText(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

function sanitizePersistentText(input: string): string {
  return normalizeText(stripPrivateData(input));
}

function sanitizePersistentTags(tags: string[]): string[] {
  return uniqueStrings(tags.map(sanitizePersistentText));
}

function sanitizeCandidate(candidate: ExtractedLessonCandidate): ExtractedLessonCandidate | null {
  const content = sanitizePersistentText(candidate.content);
  if (!content) return null;
  const evidence = sanitizeEvidence(candidate.evidence);
  const context = appendEvidenceToContext(
    sanitizePersistentText(candidate.context),
    evidence,
  );

  return {
    ...candidate,
    content,
    context,
    evidence,
    tags: sanitizePersistentTags(candidate.tags),
  };
}

export function resolveReplayLessonExtractionConfig(
  env: Record<string, string | undefined> = process.env,
  payload: Record<string, unknown> = {},
): ReplayLessonExtractionConfig {
  const base = { ...DEFAULT_REPLAY_LESSON_CONFIG };
  const allowUnbounded = parseBoolean(
    payload.allowUnbounded ?? env.AGENTMEMORY_REPLAY_LESSON_ALLOW_UNBOUNDED,
    base.allowUnbounded,
  );

  return {
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : base.enabled,
    textLimit: parseIntFromUnknown(
      payload.textLimit ?? env.AGENTMEMORY_REPLAY_LESSON_TEXT_LIMIT,
      DEFAULT_REPLAY_LESSON_TEXT_LIMIT,
      allowUnbounded,
      true,
    ),
    matchLimit: parseIntFromUnknown(
      payload.matchLimit ?? env.AGENTMEMORY_REPLAY_LESSON_MATCH_LIMIT,
      base.matchLimit,
      allowUnbounded,
      true,
    ),
    saveLimit: parseIntFromUnknown(
      payload.saveLimit ?? env.AGENTMEMORY_REPLAY_LESSON_SAVE_LIMIT,
      DEFAULT_REPLAY_LESSON_SAVE_LIMIT,
      true,
      true,
    ),
    additionalHeuristicTerms: uniqueStrings([
      ...parseAdditionalTermsFromEnv(env.AGENTMEMORY_REPLAY_LESSON_ADDITIONAL_TERMS_JSON),
      ...parseAdditionalTerms(payload.additionalHeuristicTerms),
    ]),
    allowUnbounded,
  };
}

interface HeuristicSentenceItem {
  text: string;
  kind: "user_prompt" | "assistant_response";
}

function collectLessonTexts(rawObservations: RawObservation[]): HeuristicSentenceItem[] {
  const out: HeuristicSentenceItem[] = [];
  for (const obs of rawObservations) {
    if (typeof obs.userPrompt === "string" && obs.userPrompt.trim()) {
      out.push({ kind: "user_prompt", text: obs.userPrompt });
    }
    if (typeof obs.assistantResponse === "string" && obs.assistantResponse.trim()) {
      out.push({ kind: "assistant_response", text: obs.assistantResponse });
    }
  }
  return out;
}

function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\r/g, "");
  const pieces = normalized.split(/[。！？.!?\n]/);
  return pieces.map((piece) => normalizeText(piece)).filter(Boolean);
}

function addCandidate(
  sourceSet: Map<string, ExtractedLessonCandidate>,
  content: string,
  context: string,
  confidence: number,
  importance: number,
  source: "heuristic" | "llm",
  tags: string[],
  matchLimit: number,
  evidence = "",
): void {
  const sanitizedContent = sanitizePersistentText(content);
  const normalized = normalizeContent(sanitizedContent);
  if (!normalized || sourceSet.has(normalized) || sourceSet.size >= matchLimit) return;
  sourceSet.set(normalized, {
    content: sanitizedContent,
    context: sanitizePersistentText(context),
    confidence,
    importance,
    tags: sanitizePersistentTags(tags),
    source,
    evidence: sanitizeEvidence(evidence),
  });
}

function extractHeuristicFromText(
  text: string,
  sourceSet: Map<string, ExtractedLessonCandidate>,
  context: string,
  matchLimit: number,
  additionalHeuristicTerms: string[],
): void {
  const terms = uniqueStrings([...DEFAULT_CHINESE_HEURISTIC_TERMS, ...additionalHeuristicTerms]);
  const lowerTerms = terms.map((term) => term.toLowerCase());

  for (const pattern of LEARNING_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const snippet = normalizeText(match[0]);
      if (!snippet || snippet.length < 20 || snippet.length > 220) continue;
      addCandidate(
        sourceSet,
        snippet,
        context,
        0.4,
        0.4,
        "heuristic",
        ["auto-import", "heuristic"],
        matchLimit,
      );
      if (sourceSet.size >= matchLimit) return;
    }
  }

  for (const sentence of splitIntoSentences(text)) {
    if (sourceSet.size >= matchLimit) return;
    if (sentence.length < 8 || sentence.length > 260) continue;
    const lower = sentence.toLowerCase();
    if (!lowerTerms.some((term) => lower.includes(term))) continue;
    addCandidate(
      sourceSet,
      sentence,
      context,
      0.4,
      0.4,
      "heuristic",
      ["auto-import", "heuristic"],
      matchLimit,
    );
  }
}

export function extractHeuristicLessonCandidates(
  input: HeuristicExtractionInput,
): ExtractedLessonCandidate[] {
  const context = input.firstPrompt || input.project;
  const candidates = new Map<string, ExtractedLessonCandidate>();
  const textLimit = resolveLimit(input.config.textLimit);
  const matchLimit = resolveLimit(input.config.matchLimit);
  const entries = collectLessonTexts(input.rawObservations).slice(0, textLimit);

  for (const entry of entries) {
    extractHeuristicFromText(
      entry.text,
      candidates,
      context,
      matchLimit,
      input.config.additionalHeuristicTerms,
    );
    if (candidates.size >= matchLimit) break;
  }

  return Array.from(candidates.values()).slice(0, matchLimit);
}

function collectLlmPromptItems(
  rawObservations: RawObservation[],
  compressedObservations: CompressedObservation[],
  textLimit: number,
  firstPrompt?: string,
): LessonPromptItem[] {
  const itemTextLimit = resolveLimit(textLimit);
  const truncateItem = (value: string): string => {
    const normalized = normalizeText(value);
    if (!normalized || !Number.isFinite(itemTextLimit)) return normalized;
    return truncateForLessonPrompt(normalized, itemTextLimit);
  };
  const items: LessonPromptItem[] = [];
  let index = 1;

  for (const obs of rawObservations) {
    if (typeof obs.userPrompt === "string" && obs.userPrompt.trim()) {
      const text = truncateItem(obs.userPrompt);
      if (text) {
        items.push({
          index,
          kind: "user_prompt",
          text,
          timestamp: obs.timestamp,
          files: undefined,
        });
        index += 1;
      }
    }
    if (typeof obs.assistantResponse === "string" && obs.assistantResponse.trim()) {
      const text = truncateItem(obs.assistantResponse);
      if (text) {
        items.push({
          index,
          kind: "assistant_response",
          text,
          timestamp: obs.timestamp,
          files: undefined,
        });
        index += 1;
      }
    }
  }

  const compressedItems = compressedObservations
    .filter((obs) =>
      obs.importance >= 5 || obs.type === "error" || obs.type === "decision" || obs.type === "discovery",
    );

  for (const obs of compressedItems) {
    const parts = [obs.title, obs.narrative].filter(Boolean);
    const text = truncateItem(parts.join(" "));
    if (!text) continue;
    items.push({
      index,
      kind: "observation",
      text,
      timestamp: obs.timestamp,
      type: obs.type,
      title: obs.title,
      files: obs.files,
    });
    index += 1;
  }

  items.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : Number.NaN;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : Number.NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) && !Number.isFinite(tb)) return -1;
    if (!Number.isFinite(ta) && Number.isFinite(tb)) return 1;
    return a.index - b.index;
  });

  if (firstPrompt) {
    items.unshift({
      index: 0,
      kind: "assistant_response",
      text: truncateItem(firstPrompt),
    });
  }

  return items;
}

interface LessonChunkResult {
  chunkIndex: number;
  candidates: ExtractedLessonCandidate[];
  errors: string[];
  promptChars: number;
  parseFailures: number;
  transportFailed?: boolean;
  failureDiagnostics?: LessonFailureDiagnostics;
}

function safeProviderFailureCause(error: unknown): string {
  if (error instanceof Error) {
    for (const cause of [
      "pi_auth_missing",
      "pi_auth_failed",
      "pi_model_not_found",
      "pi_sdk_import_failed",
      "circuit_breaker_open",
      "pi_stream_failed",
      "network_error",
    ]) {
      if (error.message.includes(cause)) return cause;
    }
  }
  return "provider_failure";
}

function safeLessonResponseError(error: unknown): LessonParseErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "Missing <lessons> root") return "lesson_missing_root";
  if (/No <lesson> blocks/i.test(message)) return "lesson_no_blocks";
  if (message === "No valid lessons found") return "lesson_no_valid_items";
  if (message === "empty LLM response") return "empty_response";
  if (message.startsWith("lesson extraction invalid payload:")) return "lesson_validation_failed";
  return "lesson_parse_failed";
}

function lessonParseFailureDiagnostics(
  parseErrorCode: LessonParseErrorCode,
  chunkIndex: number,
  attempt: number,
  responseChars: number,
): LessonFailureDiagnostics {
  return {
    requestPhase: "chunk",
    parseErrorCode,
    chunkIndex,
    attempt,
    responseChars,
  };
}

function lessonExtractionRequest(prompt: string, attempt: number): {
  system: string;
  prompt: string;
} {
  if (attempt === 1) {
    return {
      system: LESSON_EXTRACTION_SYSTEM,
      prompt,
    };
  }
  return {
    system: `${LESSON_EXTRACTION_SYSTEM}

FORMAT REPAIR ONLY: Regenerate the answer from the same extraction input. Keep the lesson selection rules unchanged and return only XML that satisfies the output contract.`,
    prompt: `Format-repair retry. Use the same source material and selection rules; emit only a valid <lessons> XML document.

${prompt}`,
  };
}

export function buildTurnAwareLessonChunks(
  items: LessonPromptItem[],
  chunkSize: number,
): LessonPromptItem[][] {
  if (chunkSize <= 0) return [items];

  if (!items.some((item) => item.kind === "user_prompt")) {
    const fixedChunks: LessonPromptItem[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      fixedChunks.push(items.slice(i, i + chunkSize));
    }
    return fixedChunks;
  }

  const segments: LessonPromptItem[][] = [];
  let currentSegment: LessonPromptItem[] = [];
  for (const item of items) {
    if (item.kind === "user_prompt" && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
    currentSegment.push(item);
  }
  if (currentSegment.length > 0) segments.push(currentSegment);

  const chunks: LessonPromptItem[][] = [];
  let currentChunk: LessonPromptItem[] = [];
  const flushCurrentChunk = () => {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  };

  for (const segment of segments) {
    if (segment.length > chunkSize) {
      flushCurrentChunk();
      for (let i = 0; i < segment.length; i += chunkSize) {
        chunks.push(segment.slice(i, i + chunkSize));
      }
      continue;
    }
    if (currentChunk.length > 0 && currentChunk.length + segment.length > chunkSize) {
      flushCurrentChunk();
    }
    currentChunk.push(...segment);
  }
  flushCurrentChunk();

  return chunks;
}

async function extractLlmChunkWithRetry(
  provider: MemoryProvider,
  prompt: string,
  chunkIndex: number,
  sessionId: string,
  timeoutMs: number,
  callOptions?: MemoryProviderCallOptions,
): Promise<LessonChunkResult> {
  let parseFailures = 0;
  const safePrompt = stripPrivateData(prompt);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let xml: string;
    try {
      const request = lessonExtractionRequest(safePrompt, attempt);
      xml = await callWithTimeout(
        () =>
          compressWithOptions(
            provider,
            withOutputLanguagePolicy(
              request.system,
              undefined,
              LESSON_EXTRACTION_OUTPUT_CONTRACT,
            ),
            request.prompt,
            callOptions,
          ),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "pi_empty_response") {
        const safeError = "empty_response";
        logger.warn("Lesson extraction response invalid", {
          sessionId,
          chunk: chunkIndex,
          attempt,
          error: safeError,
        });
        parseFailures++;
        if (attempt === 2) {
          return {
            chunkIndex,
            candidates: [],
            errors: [safeError],
            promptChars: prompt.length,
            parseFailures,
            failureDiagnostics: lessonParseFailureDiagnostics(
              safeError,
              chunkIndex,
              attempt,
              0,
            ),
          };
        }
        continue;
      }
      const failureCause = safeProviderFailureCause(error);
      const failureDiagnostics = error instanceof ProviderCallError
        ? sanitizeStageFailureDiagnostics(error.metadata, "chunk")
        : undefined;
      logger.warn("Lesson extraction provider call failed", {
        sessionId,
        chunk: chunkIndex,
        attempt,
        error: failureCause,
      });
      return {
        chunkIndex,
        candidates: [],
        errors: [failureCause],
        promptChars: prompt.length,
        parseFailures,
        transportFailed: true,
        ...(failureDiagnostics ? { failureDiagnostics } : {}),
      };
    }

    try {
      if (!xml || !xml.trim()) throw new Error("empty LLM response");
      const parsed = parseLessonExtractionXmlWithRootRecovery(xml);
      const validation = validateOutput(
        LessonExtractionOutputSchema,
        parsed,
        "mem::replay::lesson-extract",
      );
      if (!validation.valid) {
        throw new Error(`lesson extraction invalid payload: ${validation.result.errors.join(",")}`);
      }

        return {
          chunkIndex,
          promptChars: prompt.length,
          parseFailures,
          candidates: validation.data.lessons
            .map((lesson) =>
              sanitizeCandidate({
                content: lesson.content,
                context: lesson.context || "",
                confidence: lesson.confidence,
                importance: lesson.importance ?? 0.4,
                evidence: lesson.evidence ?? "",
                tags: lesson.tags,
                source: "llm",
              }),
            )
            .filter((candidate): candidate is ExtractedLessonCandidate => candidate !== null),
          errors: [],
      };
    } catch (error) {
      const safeError = safeLessonResponseError(error);
      logger.warn("Lesson extraction response invalid", {
        sessionId,
        chunk: chunkIndex,
        attempt,
        error: safeError,
      });
      parseFailures++;
      if (attempt === 2) {
        return {
          chunkIndex,
          candidates: [],
          errors: [safeError],
          promptChars: prompt.length,
          parseFailures,
          failureDiagnostics: lessonParseFailureDiagnostics(
            safeError,
            chunkIndex,
            attempt,
            xml.length,
          ),
        };
      }
    }
  }
  return { chunkIndex, candidates: [], errors: [], promptChars: prompt.length, parseFailures };
}

export async function extractLlmLessonCandidates(
  input: LlmExtractionInput,
): Promise<{
  candidates: ExtractedLessonCandidate[];
  errors: string[];
  promptChars: number;
  parseFailures: number;
  failureDiagnostics?: LessonFailureDiagnostics;
}> {
  const {
    provider,
    rawObservations,
    compressedObservations,
    firstPrompt,
    project,
    sessionId,
    config,
  } = input;
  const textLimit = resolveLimit(config.textLimit);
  const items = collectLlmPromptItems(
    rawObservations,
    compressedObservations,
    textLimit,
    firstPrompt,
  );
  if (items.length === 0) return { candidates: [], errors: [], promptChars: 0, parseFailures: 0 };

  const chunkSize = Math.max(
    1,
    config.chunkSize ?? DEFAULT_REPLAY_LESSON_LLM_CHUNK_SIZE,
  );
  const concurrency = Math.max(
    1,
    config.chunkConcurrency ?? DEFAULT_REPLAY_LESSON_LLM_CHUNK_CONCURRENCY,
  );
  const timeoutMs = normalizeTimeoutMs(config.timeoutMs);
  const callOptions = config.model
    ? { model: config.model, modelSource: config.modelSource }
    : resolveStageModelCallOptions("lesson");
  const chunks = buildTurnAwareLessonChunks(items, chunkSize);

  const chunkResults: Array<LessonChunkResult | null> = new Array(chunks.length).fill(null);
  const errors: string[] = [];
  let promptChars = 0;
  let parseFailures = 0;
  let transportFailed = false;
  let failureDiagnostics: LessonFailureDiagnostics | undefined;

  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (_, localIndex) => {
        const chunkIndex = batchStart + localIndex;
        const chunkText = buildLessonExtractionPrompt({
          sessionId,
          project,
          firstPrompt,
          items: chunks[chunkIndex],
        });
        promptChars += chunkText.length;
        const result = await extractLlmChunkWithRetry(
          provider,
          chunkText,
          chunkIndex,
          sessionId,
          timeoutMs,
          callOptions,
        );
        chunkResults[chunkIndex] = result;
        if (result.transportFailed) transportFailed = true;
      }),
    );
    if (transportFailed) break;
  }

  const ordered = chunkResults
    .filter((value): value is LessonChunkResult => value !== null)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
  const candidates: ExtractedLessonCandidate[] = [];

  for (const result of ordered) {
    parseFailures += result.parseFailures;
    if (result.errors.length > 0) {
      failureDiagnostics ??= sanitizeLessonFailureDiagnostics(result.failureDiagnostics);
      errors.push(...result.errors);
      continue;
    }
    candidates.push(...result.candidates);
  }

  return {
    candidates,
    errors,
    promptChars,
    parseFailures,
    ...(failureDiagnostics ? { failureDiagnostics } : {}),
  };
}

function sortLlmCandidates(
  candidates: ExtractedLessonCandidate[],
): ExtractedLessonCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return (b.evidence || "").length - (a.evidence || "").length;
  });
}

export async function extractLlmLessonsFromObservations(
  input: ExtractLlmLessonsInput,
): Promise<ExtractLlmLessonsResult> {
  const createdAt = new Date().toISOString();
  const {
    kv,
    provider,
    sessionId,
    project,
    rawObservations,
    compressedObservations,
    firstPrompt,
    config,
    sourceRunId,
  } = input;
  const context = firstPrompt || project;
  const fallbackContext = sanitizePersistentText(context);

  const {
    candidates,
    errors: extractionErrors,
    promptChars,
    parseFailures,
    failureDiagnostics,
  } = await extractLlmLessonCandidates({
    provider,
    rawObservations,
    compressedObservations,
    config,
    firstPrompt,
    project,
    sessionId,
  });
  const errors = [...extractionErrors];

  if (candidates.length === 0) {
    return {
      lessonIds: [],
      created: 0,
      reinforced: 0,
      skipped: errors.length,
      errors,
      promptChars,
      parseFailures,
      ...(failureDiagnostics ? { failureDiagnostics } : {}),
    };
  }

  const sanitizedCandidates = candidates
    .map(sanitizeCandidate)
    .filter((candidate): candidate is ExtractedLessonCandidate => candidate !== null);
  const merged = mergeCandidates(sanitizedCandidates).filter((candidate) =>
    candidate.content && candidate.content.length > 0,
  );
  const prioritized = sortLlmCandidates(merged);
  const limit = config.saveLimit <= 0 ? Number.POSITIVE_INFINITY : config.saveLimit;
  const selected = applyCandidateLimit(prioritized, limit);

  let created = 0;
  let reinforced = 0;
  const lessonIds: string[] = [];

  for (const candidate of selected) {
    const lessonId = fingerprintId("lesson", normalizeContent(candidate.content));
    try {
      const previous = await kv.get<Lesson>(KV.lessons, lessonId);
      if (previous) {
        const existing = { ...previous };
        existing.tags = uniqueStrings([...existing.tags, ...candidate.tags]);
        existing.confidence = Math.max(existing.confidence, candidate.confidence);
        existing.sourceRunId = sourceRunId;
        if (!existing.sourceIds.includes(sessionId)) {
          existing.sourceIds.push(sessionId);
          existing.reinforcements += 1;
          existing.lastReinforcedAt = createdAt;
          reinforced += 1;
        }
        if (!existing.context && candidate.context) {
          existing.context = candidate.context;
        } else if (!existing.context) {
          existing.context = fallbackContext;
        }
        existing.updatedAt = createdAt;
        await kv.set(KV.lessons, lessonId, existing);
        lessonIds.push(lessonId);
        continue;
      }

      const lesson: Lesson = {
        id: lessonId,
        content: candidate.content,
        context: candidate.context || fallbackContext,
        confidence: candidate.confidence,
        reinforcements: 0,
        source: "llm",
        origin: "llm-session-extraction",
        sourceIds: [sessionId],
        sourceRunId,
        project,
        tags: uniqueStrings(candidate.tags),
        createdAt,
        updatedAt: createdAt,
        decayRate: 0.05,
      };
      await kv.set(KV.lessons, lessonId, lesson);
      lessonIds.push(lessonId);
      created += 1;
    } catch {
      errors.push("lesson_persist_failed");
    }
  }

  return {
    lessonIds,
    created,
    reinforced,
    skipped: errors.length,
    errors,
    promptChars,
    parseFailures,
    ...(failureDiagnostics ? { failureDiagnostics } : {}),
  };
}

function applyCandidateLimit<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return items;
  return items.slice(0, limit);
}

function mergeCandidates(
  candidates: ExtractedLessonCandidate[],
): Array<ExtractedLessonCandidate & { normalized: string; order: number }> {
  const merged = new Map<string, ExtractedLessonCandidate & { normalized: string; order: number }>();
  let order = 0;

  for (const candidate of candidates) {
    const normalized = normalizeContent(candidate.content);
    if (!normalized) continue;
    const existing = merged.get(normalized);
    if (!existing) {
      merged.set(normalized, {
        ...candidate,
        normalized,
        order,
      });
      order += 1;
      continue;
    }

    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    existing.importance = Math.max(existing.importance, candidate.importance);
    existing.tags = uniqueStrings([...existing.tags, ...candidate.tags]);
    if (!existing.context && candidate.context) {
      existing.context = candidate.context;
    }
    if (!existing.evidence && candidate.evidence) {
      existing.evidence = candidate.evidence;
    }
    if (existing.source === "heuristic" && candidate.source === "llm") {
      existing.source = "llm";
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return a.order - b.order;
  });
}

export function isNoopProvider(provider: MemoryProvider): boolean {
  return provider.name === "noop" || provider.name === "resilient(noop)";
}

export async function extractLessonsFromReplay(
  input: ExtractLessonsInput,
): Promise<ExtractLessonsResult> {
  const createdAt = new Date().toISOString();
  const {
    kv,
    sessionId,
    project,
    rawObservations,
    firstPrompt,
    config,
  } = input;
  const context = firstPrompt || project;
  const fallbackContext = sanitizePersistentText(context);

  if (rawObservations.length === 0) {
    return { lessonIds: [], created: 0, reinforced: 0, skipped: 0, errors: [] };
  }

  if (!config.enabled) {
    return { lessonIds: [], created: 0, reinforced: 0, skipped: 0, errors: [] };
  }

  const allCandidates = extractHeuristicLessonCandidates({
    rawObservations,
    config,
    firstPrompt,
    project,
  });
  const errors: string[] = [];

  const sanitizedCandidates = allCandidates
    .map(sanitizeCandidate)
    .filter((candidate): candidate is ExtractedLessonCandidate => candidate !== null);

  const merged = mergeCandidates(sanitizedCandidates).filter((candidate) =>
    candidate.content && candidate.content.length > 0,
  );

  const matchedCandidates = applyCandidateLimit(
      merged,
      config.matchLimit === 0 ? Number.POSITIVE_INFINITY : config.matchLimit,
  );

  const candidates = applyCandidateLimit(
    matchedCandidates,
    config.saveLimit === 0 ? Number.POSITIVE_INFINITY : config.saveLimit,
  );

  let created = 0;
  let reinforced = 0;
  const lessonIds: string[] = [];

  for (const candidate of candidates) {
    const lessonId = fingerprintId("lesson", normalizeContent(candidate.content));
    try {
      const previous = await kv.get<Lesson>(KV.lessons, lessonId);
      if (previous) {
        const existing = { ...previous };
        existing.tags = uniqueStrings([...existing.tags, ...candidate.tags, "auto-import"]);
        if (!existing.context && candidate.context) {
          existing.context = candidate.context;
        } else if (!existing.context) {
          existing.context = fallbackContext;
        }
        existing.confidence = Math.max(existing.confidence, candidate.confidence);
        if (!existing.sourceIds.includes(sessionId)) {
          existing.sourceIds.push(sessionId);
          existing.reinforcements += 1;
          existing.lastReinforcedAt = createdAt;
          reinforced += 1;
        }
        existing.updatedAt = createdAt;
        await kv.set(KV.lessons, lessonId, existing);
        lessonIds.push(lessonId);
        continue;
      }

      const lesson: Lesson = {
        id: lessonId,
        content: candidate.content,
        context: candidate.context || fallbackContext,
        confidence: candidate.confidence,
        reinforcements: 0,
        source: "heuristic",
        origin: "replay-import-heuristic",
        sourceIds: [sessionId],
        project,
        tags: uniqueStrings([...candidate.tags, "auto-import"]),
        createdAt,
        updatedAt: createdAt,
        decayRate: 0.05,
      };
      await kv.set(KV.lessons, lessonId, lesson);
      lessonIds.push(lessonId);
      created += 1;
    } catch (err) {
      errors.push(
        err instanceof Error ? err.message : `failed to save lesson candidate: ${String(err)}`,
      );
    }
  }

  return {
    lessonIds,
    created,
    reinforced,
    skipped: errors.length,
    errors,
  };
}
