import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  MemoryProvider,
  SemanticMemory,
  SessionSummary,
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { parseFactResponse } from "../prompts/facts.js";
import {
  SEMANTIC_MERGE_OUTPUT_CONTRACT,
  SEMANTIC_MERGE_SYSTEM,
} from "../prompts/consolidation.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";

const MAX_ROLLUP_SOURCE_IDS = 100;
const MAX_ROLLUP_PROMPT_CHARS = 24_000;

interface SemanticRollupInput {
  runId?: unknown;
  windowId?: unknown;
  mark?: unknown;
  kind?: unknown;
  sessionIds?: unknown;
  semanticMemoryIds?: unknown;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed && !strings.includes(trimmed)) strings.push(trimmed);
  }
  return strings;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function buildWindowPrompt(summaries: SessionSummary[]): string {
  const input = summaries
    .map((summary, index) =>
      [
        `[Summary ${index + 1}]`,
        `Session: ${summary.sessionId}`,
        `Title: ${summary.title}`,
        `Narrative: ${summary.narrative}`,
        `Key decisions: ${summary.keyDecisions.join("; ")}`,
        `Concepts: ${summary.concepts.join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n");
  return `Extract durable semantic facts from these session summaries:\n\n${input}`;
}

function buildCorpusPrompt(memories: SemanticMemory[]): string {
  const input = memories
    .map((memory, index) =>
      [
        `[Semantic memory ${index + 1}]`,
        `ID: ${memory.id}`,
        `Fact: ${memory.fact}`,
        `Confidence: ${memory.confidence}`,
        `Source sessions: ${memory.sourceSessionIds.join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n");
  return `Consolidate these semantic memories into higher-level durable facts:\n\n${input}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function failureDetails(
  error: string,
  runId: string,
  windowId: string,
  mark: string,
  kind: "window" | "corpus",
  inputHash: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: false,
    error,
    runId,
    windowId,
    mark,
    kind,
    inputHash,
    ...details,
  };
}

export function registerSemanticRollupFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::semantic-rollup", async (data: SemanticRollupInput) => {
    const runId = asTrimmedString(data?.runId);
    const windowId = asTrimmedString(data?.windowId);
    const mark = asTrimmedString(data?.mark);
    const kind = data?.kind === "window" || data?.kind === "corpus" ? data.kind : null;
    if (!runId || !windowId || !mark || !kind) {
      return {
        success: false,
        error: "runId, windowId, mark, and kind are required",
      };
    }

    const sessionIds = parseStringArray(data.sessionIds);
    const semanticMemoryIds = parseStringArray(data.semanticMemoryIds);
    const requestHash = stableHash({
      kind,
      mark,
      windowId,
      sessionIds: kind === "window" ? sessionIds : undefined,
      semanticMemoryIds: kind === "corpus" ? semanticMemoryIds : undefined,
    });
    if (sessionIds === null || semanticMemoryIds === null) {
      return failureDetails(
        "sessionIds and semanticMemoryIds must be string arrays",
        runId,
        windowId,
        mark,
        kind,
        requestHash,
      );
    }
    if (kind === "window" && (!sessionIds || sessionIds.length === 0)) {
      return failureDetails("sessionIds is required for window rollup", runId, windowId, mark, kind, requestHash);
    }
    if (kind === "corpus" && (!semanticMemoryIds || semanticMemoryIds.length === 0)) {
      return failureDetails("semanticMemoryIds is required for corpus rollup", runId, windowId, mark, kind, requestHash);
    }
    const sourceIds = kind === "window" ? sessionIds! : semanticMemoryIds!;
    if (sourceIds.length > MAX_ROLLUP_SOURCE_IDS) {
      return failureDetails("input_too_large", runId, windowId, mark, kind, requestHash, {
        sourceIds: sourceIds.length,
        maxSourceIds: MAX_ROLLUP_SOURCE_IDS,
      });
    }

    const missingSessionIds: string[] = [];
    const missingSemanticMemoryIds: string[] = [];
    let summaries: SessionSummary[] = [];
    let semanticSources: SemanticMemory[] = [];

    if (kind === "window") {
      summaries = await Promise.all(
        sessionIds!.map(async (sessionId) => {
          const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
          if (!summary) missingSessionIds.push(sessionId);
          return summary;
        }),
      ).then((items) => items.filter((item): item is SessionSummary => item !== null));
    } else {
      semanticSources = await Promise.all(
        semanticMemoryIds!.map(async (memoryId) => {
          const memory = await kv.get<SemanticMemory>(KV.semantic, memoryId);
          if (!memory) missingSemanticMemoryIds.push(memoryId);
          return memory;
        }),
      ).then((items) => items.filter((item): item is SemanticMemory => item !== null));
    }

    if (missingSessionIds.length > 0 || missingSemanticMemoryIds.length > 0) {
      return failureDetails("missing_sources", runId, windowId, mark, kind, requestHash, {
        missingSessionIds,
        missingSemanticMemoryIds,
      });
    }

    const inputHash = stableHash({
      kind,
      mark,
      windowId,
      sessionIds: kind === "window" ? sessionIds : undefined,
      semanticMemoryIds: kind === "corpus" ? semanticMemoryIds : undefined,
      summaries: summaries.map((summary) => ({
        sessionId: summary.sessionId,
        title: summary.title,
        narrative: summary.narrative,
        keyDecisions: summary.keyDecisions,
        concepts: summary.concepts,
      })),
      semanticSources: semanticSources.map((memory) => ({
        id: memory.id,
        fact: memory.fact,
        confidence: memory.confidence,
        sourceSessionIds: memory.sourceSessionIds,
      })),
    });

    const prompt = kind === "window"
      ? buildWindowPrompt(summaries)
      : buildCorpusPrompt(semanticSources);
    if (prompt.length > MAX_ROLLUP_PROMPT_CHARS) {
      return failureDetails("input_too_large", runId, windowId, mark, kind, inputHash, {
        promptChars: prompt.length,
        maxPromptChars: MAX_ROLLUP_PROMPT_CHARS,
      });
    }

    const existingMemories = (await kv.list<SemanticMemory>(KV.semantic).catch(() => []))
      .filter((memory) =>
        memory.extractionRunId === runId &&
        memory.extractionWindowId === windowId &&
        memory.extractionMark === mark &&
        memory.extractionKind === kind &&
        memory.extractionInputHash === inputHash,
      );
    if (existingMemories.length > 0) {
      return {
        success: true,
        semanticMemoryIds: existingMemories.map((memory) => memory.id),
        semanticMemoryCharSizes: Object.fromEntries(
          existingMemories.map((memory) => [memory.id, memory.fact.length]),
        ),
        inputHash,
        facts: existingMemories.map((memory) => ({
          fact: memory.fact,
          confidence: memory.confidence,
        })),
        reused: true,
      };
    }

    let response: string;
    try {
      response = await provider.summarize(
        withOutputLanguagePolicy(
          SEMANTIC_MERGE_SYSTEM,
          undefined,
          { semantic: [...(SEMANTIC_MERGE_OUTPUT_CONTRACT.semantic ?? [])] },
        ),
        prompt,
      );
    } catch {
      return failureDetails("provider_error", runId, windowId, mark, kind, inputHash);
    }
    const facts = parseFactResponse(response);
    if (facts.length === 0) {
      return failureDetails("empty_facts", runId, windowId, mark, kind, inputHash);
    }

    const now = new Date().toISOString();
    const sourceSessionIds = kind === "window"
      ? sessionIds!
      : unique(semanticSources.flatMap((memory) => memory.sourceSessionIds));
    const sourceMemoryIds = kind === "corpus" ? semanticMemoryIds! : [];
    const memories: SemanticMemory[] = await Promise.all(
      facts.map(async ({ fact, confidence }) => {
        const id = fingerprintId("sem", stableStringify({
          runId,
          windowId,
          mark,
          kind,
          inputHash,
          fact,
        }));
        const existing = await kv.get<SemanticMemory>(KV.semantic, id);
        return {
          id,
          fact,
          confidence,
          sourceSessionIds,
          sourceMemoryIds,
          extractionRunId: runId,
          extractionWindowId: windowId,
          extractionMark: mark,
          extractionInputHash: inputHash,
          extractionKind: kind,
          accessCount: existing?.accessCount ?? 1,
          lastAccessedAt: existing?.lastAccessedAt ?? now,
          strength: confidence,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
      }),
    );

    await Promise.all(
      memories.map((memory) => kv.set(KV.semantic, memory.id, memory)),
    );
    await recordAudit(
      kv,
      "semantic_rollup",
      "mem::semantic-rollup",
      memories.map((memory) => memory.id),
      {
        runId,
        windowId,
        mark,
        kind,
        inputHash,
        facts: facts.length,
      },
    );

    return {
      success: true,
      semanticMemoryIds: memories.map((memory) => memory.id),
      semanticMemoryCharSizes: Object.fromEntries(
        memories.map((memory) => [memory.id, memory.fact.length]),
      ),
      inputHash,
      facts,
    };
  });
}
