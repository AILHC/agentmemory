import { generateId } from "../state/schema.js";
import type { ParsedTranscript } from "./jsonl-parser.js";
import { parseJsonlText } from "./jsonl-parser.js";
import { parseCodexJsonlText } from "./codex-jsonl-parser.js";
import {
  stableFallbackSessionId,
  type ReplayImportContext,
} from "./import-identity.js";

export type TranscriptFormat = "claude-code" | "codex" | "unknown";

interface RawJsonlEntry {
  type?: unknown;
  message?: unknown;
}

export function detectTranscriptFormat(text: string): TranscriptFormat {
  let parsedRows = 0;
  let hasCodexMeta = false;
  let hasCodexEventOrItem = false;
  let hasClaudeShape = false;

  const lines = text.split("\n");
  for (const line of lines) {
    if (parsedRows >= 20) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let row: unknown;
    try {
      row = JSON.parse(trimmed);
      parsedRows += 1;
    } catch {
      continue;
    }

    if (!row || typeof row !== "object") continue;

    const entry = row as RawJsonlEntry;
    const type = typeof entry.type === "string" ? entry.type : null;

    if (type === "session_meta") hasCodexMeta = true;
    if (type === "event_msg" || type === "response_item") hasCodexEventOrItem = true;

    if (
      type !== null &&
      (type === "user" || type === "assistant" || type === "summary" || type === "system")
    ) {
      if (
        entry.message &&
        typeof entry.message === "object" &&
        entry.message !== null &&
        typeof (entry.message as { role?: unknown }).role === "string"
      ) {
        hasClaudeShape = true;
      }
    }
  }

  if (hasCodexMeta && hasCodexEventOrItem) return "codex";
  if (hasClaudeShape) return "claude-code";
  return "unknown";
}

export function parseTranscriptText(
  text: string,
  fallbackSessionId?: string,
  context?: ReplayImportContext,
): ParsedTranscript {
  const format = detectTranscriptFormat(text);

  if (format === "claude-code") {
    return parseJsonlText(text, fallbackSessionId, context);
  }

  if (format === "codex") {
    return parseCodexJsonlText(text, fallbackSessionId, context);
  }

  const nowIso = new Date().toISOString();
  const stableSessionId =
    fallbackSessionId || (context ? stableFallbackSessionId(context) : generateId("sess"));
  return {
    sessionId: stableSessionId,
    project: "unknown",
    cwd: process.cwd(),
    startedAt: nowIso,
    endedAt: nowIso,
    observations: [],
    sourceFormat: context?.sourceFormat,
    sourceFileHash: context?.sourceFileHash,
    sourceSessionId: context ? stableSessionId : undefined,
    targetSessionId: context ? stableSessionId : undefined,
    lineage: "top-level",
  };
}
