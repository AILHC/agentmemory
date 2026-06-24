import type { HookType, RawObservation } from "../types.js";
import { fingerprintId, generateId } from "../state/schema.js";
import {
  buildReplaySourceIdentity,
  classifyClaudeLineage,
  resolveSourceSessionId,
  type ReplayImportContext,
  type ReplayLineageKind,
  type ReplaySourceFormat,
} from "./import-identity.js";

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
  [k: string]: unknown;
}

export interface ParsedTranscript {
  sessionId: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  observations: RawObservation[];
  sourceFormat?: ReplaySourceFormat;
  sourceFileHash?: string;
  sourceSessionId?: string;
  targetSessionId?: string;
  lineage?: ReplayLineageKind;
  parentSessionId?: string;
}

function deriveProject(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

function extractToolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_use") {
      out.push({
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "unknown",
        input: entry.input,
      });
    }
  }
  return out;
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; output: unknown; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; output: unknown; isError: boolean }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_result") {
      out.push({
        toolUseId: typeof entry.tool_use_id === "string" ? entry.tool_use_id : "",
        output: entry.content,
        isError: entry.is_error === true,
      });
    }
  }
  return out;
}

function claudeSourceEventId(raw: unknown, index: number): string {
  const wrapper =
    raw && typeof raw === "object" && "entry" in raw
      ? (raw as { entry?: unknown }).entry
      : raw;
  const entry =
    wrapper && typeof wrapper === "object"
      ? (wrapper as Record<string, unknown>)
      : {};
  const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
  if (uuid) return uuid;
  const parentUuid =
    typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
  const type = typeof entry.type === "string" ? entry.type : "unknown";
  const timestamp =
    typeof entry.timestamp === "string" ? entry.timestamp : "unknown";
  if (parentUuid) return `${parentUuid}:${type}:${timestamp}`;
  return `line:${index}:${timestamp}:${type}`;
}

export function parseJsonlText(
  text: string,
  fallbackSessionId?: string,
  context?: ReplayImportContext,
): ParsedTranscript {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as JsonlEntry);
    } catch {
      // skip malformed lines
    }
  }

  let sessionId = "";
  let cwd = "";
  let firstTs = "";
  let lastTs = "";

  const observations: RawObservation[] = [];

  for (const entry of entries) {
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (entry.cwd && !cwd) cwd = entry.cwd;
    const entryLineage = classifyClaudeLineage(entry);
    const ts = entry.timestamp || new Date().toISOString();
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    const role = entry.message?.role;
    const content = entry.message?.content;

    if (entry.type === "user" && role === "user") {
      const toolResults = extractToolResults(content);
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          observations.push({
            id: "",
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: (result.isError ? "post_tool_failure" : "post_tool_use") as HookType,
            toolName: undefined,
            toolInput: { toolUseId: result.toolUseId },
            toolOutput: result.output,
            raw: entry,
            lineage: entryLineage.lineage,
            parentSessionId: entryLineage.parentSessionId,
          });
        }
      } else {
        const text = toText(content);
        if (text.trim().length > 0) {
          observations.push({
            id: "",
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: "prompt_submit" as HookType,
            userPrompt: text,
            raw: entry,
            lineage: entryLineage.lineage,
            parentSessionId: entryLineage.parentSessionId,
          });
        }
      }
    } else if (entry.type === "assistant" && role === "assistant") {
      const text = toText(content);
      const tools = extractToolUses(content);
      if (text.trim().length > 0) {
        observations.push({
          id: "",
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "stop" as HookType,
          assistantResponse: text,
          raw: entry,
          lineage: entryLineage.lineage,
          parentSessionId: entryLineage.parentSessionId,
        });
      }
      for (const tool of tools) {
        observations.push({
          id: "",
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use" as HookType,
          toolName: tool.name,
          toolInput: tool.input,
          raw: { toolUseId: tool.id, entry },
          lineage: entryLineage.lineage,
          parentSessionId: entryLineage.parentSessionId,
        });
      }
    } else if (entry.type === "summary" || entry.type === "system") {
      // ignore meta entries
    }
  }

  const hasTopLevelObservation = observations.some(
    (obs) => obs.lineage !== "sidechain",
  );
  const transcriptLineage: ReplayLineageKind =
    observations.length > 0 && !hasTopLevelObservation ? "sidechain" : "top-level";
  const transcriptParentSessionId =
    transcriptLineage === "sidechain"
      ? observations.find((obs) => obs.parentSessionId)?.parentSessionId
      : undefined;

  const generatedSessionId = sessionId || fallbackSessionId || generateId("sess");
  const resolved = context
    ? resolveSourceSessionId({ context, sourceSessionId: sessionId || fallbackSessionId })
    : {
        sourceSessionId: generatedSessionId,
        targetSessionId: generatedSessionId,
      };
  const effectiveSessionId = resolved.targetSessionId;
  for (let index = 0; index < observations.length; index++) {
    const obs = observations[index];
    if (obs.sessionId === "imported") obs.sessionId = effectiveSessionId;
    obs.lineage = obs.lineage ?? transcriptLineage;
    obs.parentSessionId = obs.parentSessionId ?? transcriptParentSessionId;
    const sourceEventIndex = index;
    if (context) {
      const identity = buildReplaySourceIdentity({
        context,
        sourceSessionId: resolved.sourceSessionId,
        targetSessionId: resolved.targetSessionId,
        sourceEventId: claudeSourceEventId(obs.raw, sourceEventIndex),
        sourceEventIndex,
        hookType: obs.hookType,
      });
      obs.id = identity.observationId;
      obs.sessionId = identity.targetSessionId;
      obs.sourceFormat = identity.sourceFormat;
      obs.sourceFileHash = identity.sourceFileHash;
      obs.sourceSessionId = identity.sourceSessionId;
      obs.sourceEventId = identity.sourceEventId;
      obs.sourceEventIndex = identity.sourceEventIndex;
      obs.importKey = identity.importKey;
    } else {
      obs.id = fingerprintId(
        "obs",
        `claude-code:${resolved.sourceSessionId}:${claudeSourceEventId(obs.raw, sourceEventIndex)}:${sourceEventIndex}:${obs.hookType}`,
      );
    }
  }

  const nowIso = new Date().toISOString();
  return {
    sessionId: effectiveSessionId,
    project: deriveProject(cwd),
    cwd: cwd || process.cwd(),
    startedAt: firstTs || nowIso,
    endedAt: lastTs || nowIso,
    observations,
    sourceFormat: context?.sourceFormat,
    sourceFileHash: context?.sourceFileHash,
    sourceSessionId: context ? resolved.sourceSessionId : undefined,
    targetSessionId: context ? resolved.targetSessionId : undefined,
    lineage: transcriptLineage,
    parentSessionId: transcriptParentSessionId,
  };
}
