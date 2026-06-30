import type { CompressedObservation, Lesson, MemoryProvider, RawObservation } from "../types.js";
import { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import { validateOutput } from "../eval/validator.js";
import { LessonExtractionOutputSchema } from "../eval/schemas.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import {
  LESSON_EXTRACTION_SYSTEM,
  type LessonPromptItem,
  buildLessonExtractionPrompt,
  parseLessonExtractionXml,
} from "../prompts/lesson-extraction.js";
import { stripPrivateData } from "./privacy.js";
import { logger } from "../logger.js";

export type LessonExtractionMode = "off" | "heuristic" | "llm" | "hybrid";

export interface ReplayLessonExtractionConfig {
  mode: LessonExtractionMode;
  textLimit: number;
  matchLimit: number;
  saveLimit: number;
  additionalHeuristicTerms: string[];
  allowUnbounded: boolean;
  llmChunkSize: number;
  llmChunkConcurrency: number;
}

export interface ExtractedLessonCandidate {
  content: string;
  context: string;
  confidence: number;
  tags: string[];
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
  config: ReplayLessonExtractionConfig;
  project: string;
  firstPrompt?: string;
  sessionId: string;
  provider: MemoryProvider;
}

export interface ExtractLessonsInput {
  kv: StateKV;
  provider: MemoryProvider;
  sessionId: string;
  project: string;
  rawObservations: RawObservation[];
  compressedObservations: CompressedObservation[];
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
  mode: "heuristic",
  textLimit: DEFAULT_REPLAY_LESSON_TEXT_LIMIT,
  matchLimit: DEFAULT_REPLAY_LESSON_MATCH_LIMIT,
  saveLimit: DEFAULT_REPLAY_LESSON_SAVE_LIMIT,
  additionalHeuristicTerms: [],
  allowUnbounded: false,
  llmChunkSize: DEFAULT_REPLAY_LESSON_LLM_CHUNK_SIZE,
  llmChunkConcurrency: DEFAULT_REPLAY_LESSON_LLM_CHUNK_CONCURRENCY,
};

const LEARNING_PATTERNS = [
  /\b(always|never|don'?t|do not|make sure|remember to|note:|caveat:|warning:)\b[^.\n]{10,200}[.!\n]/gi,
  /\b(prefer|avoid)\s[^.\n]{10,200}[.!\n]/gi,
];

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

function parseMode(raw: unknown, fallback: LessonExtractionMode): LessonExtractionMode {
  if (raw === "off" || raw === "heuristic" || raw === "llm" || raw === "hybrid") return raw;
  return fallback;
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
  return {
    ...candidate,
    content,
    context: sanitizePersistentText(candidate.context),
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
    mode: parseMode(payload.mode ?? env.AGENTMEMORY_REPLAY_LESSON_EXTRACT_MODE, base.mode),
    textLimit: parseIntFromUnknown(
      payload.textLimit ?? env.AGENTMEMORY_REPLAY_LESSON_TEXT_LIMIT,
      base.textLimit,
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
      base.saveLimit,
      allowUnbounded,
      true,
    ),
    additionalHeuristicTerms: uniqueStrings([
      ...parseAdditionalTermsFromEnv(env.AGENTMEMORY_REPLAY_LESSON_ADDITIONAL_TERMS_JSON),
      ...parseAdditionalTerms(payload.additionalHeuristicTerms),
    ]),
    allowUnbounded,
    llmChunkSize: Math.max(1, parseIntFromUnknown(payload.llmChunkSize ?? env.AGENTMEMORY_REPLAY_LESSON_LLM_CHUNK_SIZE, base.llmChunkSize, true, false)),
    llmChunkConcurrency: Math.max(
      1,
      parseIntFromUnknown(
        payload.llmChunkConcurrency ?? env.AGENTMEMORY_REPLAY_LESSON_LLM_CHUNK_CONCURRENCY,
        base.llmChunkConcurrency,
        true,
        false,
      ),
    ),
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
  source: "heuristic" | "llm",
  tags: string[],
  matchLimit: number,
): void {
  const sanitizedContent = sanitizePersistentText(content);
  const normalized = normalizeContent(sanitizedContent);
  if (!normalized || sourceSet.has(normalized) || sourceSet.size >= matchLimit) return;
  sourceSet.set(normalized, {
    content: sanitizedContent,
    context: sanitizePersistentText(context),
    confidence,
    tags: sanitizePersistentTags(tags),
    source,
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
      addCandidate(sourceSet, snippet, context, 0.4, "heuristic", ["auto-import", "heuristic"], matchLimit);
      if (sourceSet.size >= matchLimit) return;
    }
  }

  for (const sentence of splitIntoSentences(text)) {
    if (sourceSet.size >= matchLimit) return;
    if (sentence.length < 8 || sentence.length > 260) continue;
    const lower = sentence.toLowerCase();
    if (!lowerTerms.some((term) => lower.includes(term))) continue;
    addCandidate(sourceSet, sentence, context, 0.4, "heuristic", ["auto-import", "heuristic"], matchLimit);
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
  const resolvedTextLimit = resolveLimit(textLimit);
  const items: LessonPromptItem[] = [];
  let index = 1;

  const rawItems = collectLessonTexts(rawObservations).slice(0, resolvedTextLimit);
  for (const entry of rawItems) {
    items.push({
      index,
      kind: entry.kind,
      text: normalizeText(entry.text),
      files: undefined,
    });
    index += 1;
  }

  const compressedItems = compressedObservations
    .filter((obs) =>
      obs.importance >= 5 || obs.type === "error" || obs.type === "decision" || obs.type === "discovery",
    )
    .slice(0, resolvedTextLimit);

  for (const obs of compressedItems) {
    const parts = [obs.title, obs.narrative].filter(Boolean);
    const text = normalizeText(parts.join(" "));
    if (!text) continue;
    if (items.length >= resolvedTextLimit * 2) break;
    items.push({
      index,
      kind: "observation",
      text,
      type: obs.type,
      title: obs.title,
      files: obs.files,
    });
    index += 1;
  }

  if (firstPrompt) {
    items.unshift({
      index: 0,
      kind: "assistant_response",
      text: normalizeText(firstPrompt),
    });
  }

  return items.slice(0, resolvedTextLimit);
}

interface LessonChunkResult {
  chunkIndex: number;
  candidates: ExtractedLessonCandidate[];
  errors: string[];
}

async function extractLlmChunkWithRetry(
  provider: MemoryProvider,
  prompt: string,
  chunkIndex: number,
  sessionId: string,
): Promise<LessonChunkResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await provider.compress(
        withOutputLanguagePolicy(LESSON_EXTRACTION_SYSTEM),
        stripPrivateData(prompt),
      );
      if (!xml || !xml.trim()) throw new Error("empty LLM response");
      const parsed = parseLessonExtractionXml(xml);
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
        candidates: validation.data.lessons
          .map((lesson) =>
            sanitizeCandidate({
              content: lesson.content,
              context: lesson.context || "",
              confidence: lesson.confidence,
              tags: lesson.tags,
              source: "llm",
            }),
          )
          .filter((candidate): candidate is ExtractedLessonCandidate => candidate !== null),
        errors: [],
      };
    } catch (err) {
      logger.warn("Lesson extraction chunk failed", {
        sessionId,
        chunk: chunkIndex,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt === 2) {
        return {
          chunkIndex,
          candidates: [],
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    }
  }
  return { chunkIndex, candidates: [], errors: [] };
}

export async function extractLlmLessonCandidates(
  input: LlmExtractionInput,
): Promise<{ candidates: ExtractedLessonCandidate[]; errors: string[] }> {
  const { provider, rawObservations, compressedObservations, firstPrompt, project, sessionId, config } =
    input;
  const textLimit = resolveLimit(config.textLimit);
  const items = collectLlmPromptItems(
    rawObservations,
    compressedObservations,
    textLimit,
    firstPrompt,
  );
  if (items.length === 0) return { candidates: [], errors: [] };

  const chunkSize = Math.max(1, config.llmChunkSize);
  const concurrency = Math.max(1, config.llmChunkConcurrency);
  const chunks: LessonPromptItem[][] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  const chunkResults: Array<LessonChunkResult | null> = new Array(chunks.length).fill(null);
  const errors: string[] = [];

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
        chunkResults[chunkIndex] = await extractLlmChunkWithRetry(
          provider,
          chunkText,
          chunkIndex,
          sessionId,
        );
      }),
    );
  }

  const ordered = chunkResults
    .filter((value): value is LessonChunkResult => value !== null)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
  const candidates: ExtractedLessonCandidate[] = [];

  for (const result of ordered) {
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    candidates.push(...result.candidates);
  }

  return { candidates, errors };
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
    existing.tags = uniqueStrings([...existing.tags, ...candidate.tags]);
    if (!existing.context && candidate.context) {
      existing.context = candidate.context;
    }
    if (existing.source === "heuristic" && candidate.source === "llm") {
      existing.source = "llm";
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
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
    provider,
    sessionId,
    project,
    rawObservations,
    compressedObservations,
    firstPrompt,
    config,
  } = input;
  const context = firstPrompt || project;
  const fallbackContext = sanitizePersistentText(context);

  if (rawObservations.length === 0) {
    return { lessonIds: [], created: 0, reinforced: 0, skipped: 0, errors: [] };
  }

  if (config.mode === "off") {
    return { lessonIds: [], created: 0, reinforced: 0, skipped: 0, errors: [] };
  }

  let allCandidates: ExtractedLessonCandidate[] = [];
  const errors: string[] = [];

  if (config.mode === "heuristic" || config.mode === "hybrid") {
    allCandidates = allCandidates.concat(
      extractHeuristicLessonCandidates({
        rawObservations,
        config,
        firstPrompt,
        project,
      }),
    );
  }

  if (config.mode === "llm" || config.mode === "hybrid") {
    if (isNoopProvider(provider)) {
      errors.push("LLM lesson extraction skipped (noop provider)");
    } else {
      const llmResult = await extractLlmLessonCandidates({
        provider,
        rawObservations,
        compressedObservations,
        config,
        firstPrompt,
        project,
        sessionId,
      });
      allCandidates = allCandidates.concat(llmResult.candidates);
      errors.push(...llmResult.errors);
    }
  }

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
        source: "consolidation",
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
