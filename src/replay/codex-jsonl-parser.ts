import type { RawObservation } from "../types.js";
import type { ParsedTranscript } from "./jsonl-parser.js";
import { generateId } from "../state/schema.js";

type CodexPayload = Record<string, unknown>;

interface CodexJsonlEntry {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    message?: unknown;
    meta?: {
      id?: string;
      cwd?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

function deriveProject(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}

function toPromptText(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

function isFailureStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error");
}

function safeErrorOutput(payload: CodexPayload): Record<string, unknown> {
  const out: CodexPayload = {};
  if (typeof payload.message === "string") out.message = payload.message;
  if (payload.codex_error_info !== undefined) {
    out.codex_error_info = payload.codex_error_info;
  }
  if ("status" in payload && typeof payload.status === "string") {
    out.status = payload.status;
  }
  return out;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseCodexJsonlText(
  text: string,
  fallbackSessionId?: string,
): ParsedTranscript {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  let sessionId = "";
  let cwd = "";
  let firstTs = "";
  let lastTs = "";

  const observations: RawObservation[] = [];
  const nowIso = new Date().toISOString();

  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;

    const entry = row as CodexJsonlEntry;
    const payload = entry.payload || {};
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : nowIso;

    if (!firstTs) firstTs = ts;
    lastTs = ts;

    if (entry.type === "session_meta") {
      if (typeof payload.id === "string" && !sessionId) sessionId = payload.id;
      if (typeof payload.cwd === "string" && !cwd) cwd = payload.cwd;
      if (typeof payload.meta === "object" && payload.meta !== null && !sessionId && typeof payload.meta.id === "string") {
        sessionId = payload.meta.id;
      }
      if (typeof payload.meta === "object" && payload.meta !== null && !cwd && typeof payload.meta.cwd === "string") {
        cwd = payload.meta.cwd;
      }
      continue;
    }

    if (entry.type === "response_item") {
      if (payload.type === "function_call") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use",
          toolName: typeof payload.name === "string" ? payload.name : "function_call",
          toolInput: payload.arguments,
          raw: row,
        });
      }

      if (payload.type === "function_call_output") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "post_tool_use",
          toolName: undefined,
          toolInput: { toolUseId: payload.call_id },
          toolOutput: payload.output,
          raw: row,
        });
      }

      if (payload.type === "custom_tool_call") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use",
          toolName:
            typeof payload.name === "string" ? payload.name : "custom_tool_call",
          toolInput: payload.input,
          raw: row,
        });
      }

      if (payload.type === "custom_tool_call_output") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "post_tool_use",
          toolName: undefined,
          toolInput: { toolUseId: payload.call_id },
          toolOutput: payload.output,
          raw: row,
        });
      }

      if (payload.type === "web_search_call") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use",
          toolName: "web_search",
          toolInput: payload.action,
          raw: row,
        });
      }

      if (payload.type === "tool_search_call") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use",
          toolName: "tool_search",
          toolInput: payload.arguments ?? payload.execution,
          raw: row,
        });
      }

      if (payload.type === "tool_search_output") {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "post_tool_use",
          toolName: undefined,
          toolInput: { toolUseId: payload.call_id },
          toolOutput: payload.tools ?? payload.execution,
          raw: row,
        });
      }

      continue;
    }

    if (entry.type !== "event_msg") continue;
    if (typeof payload.type !== "string") continue;

    if (payload.type === "exec_command_end") {
      const exitCode = toNumber(payload.exit_code);
      const statusText = typeof payload.status === "string" ? payload.status : "";
      const isFailed = isFailureStatus(statusText) || ((exitCode ?? 0) !== 0);
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: isFailed ? "post_tool_failure" : "post_tool_use",
        toolName: "exec_command",
        toolInput: {
          toolUseId: payload.call_id,
          command: payload.command,
          cwd: payload.cwd,
        },
        toolOutput: {
          stdout: payload.stdout,
          stderr: payload.stderr,
          aggregated_output: payload.aggregated_output,
          formatted_output: payload.formatted_output,
          exit_code: exitCode,
          duration: payload.duration,
          status: payload.status,
        },
        raw: row,
      });
    }

    if (payload.type === "patch_apply_end") {
      const statusText = typeof payload.status === "string" ? payload.status : "";
      const successText = typeof payload.success === "boolean" ? payload.success : undefined;
      const isFailed = isFailureStatus(statusText) || successText === false;
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: isFailed ? "post_tool_failure" : "post_tool_use",
        toolName: "apply_patch",
        toolInput: { toolUseId: payload.call_id },
        toolOutput: {
          stdout: payload.stdout,
          stderr: payload.stderr,
          changes: payload.changes,
          status: payload.status,
          success: payload.success,
        },
        raw: row,
      });
    }

    if (payload.type === "mcp_tool_call_end") {
      const invocation = payload.invocation as { name?: unknown };
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "post_tool_use",
        toolName:
          typeof invocation === "object" && invocation !== null && typeof invocation.name === "string"
            ? invocation.name
            : "mcp_tool_call",
        toolInput: {
          toolUseId: payload.call_id,
          invocation: payload.invocation,
        },
        toolOutput: payload.result,
        raw: row,
      });
    }

    if (payload.type === "web_search_end") {
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "post_tool_use",
        toolName: "web_search",
        toolInput: { toolUseId: payload.call_id, query: payload.query },
        toolOutput: payload.action,
        raw: row,
      });
    }

    if (payload.type === "error") {
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "post_tool_failure",
        toolName: "codex",
        toolOutput: safeErrorOutput(payload),
        raw: row,
      });
    }

    if (payload.type === "user_message") {
      const userPrompt = toPromptText(payload.message);
      if (!userPrompt) continue;
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "prompt_submit",
        userPrompt,
        raw: row,
      });
      continue;
    }

    if (payload.type === "agent_message") {
      const assistantResponse = toPromptText(payload.message);
      if (!assistantResponse) continue;
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "stop",
        assistantResponse,
        raw: row,
      });
    }
  }

  const effectiveSessionId = sessionId || fallbackSessionId || generateId("sess");
  for (const obs of observations) {
    if (obs.sessionId === "imported") obs.sessionId = effectiveSessionId;
  }

  return {
    sessionId: effectiveSessionId,
    project: deriveProject(cwd),
    cwd: cwd || process.cwd(),
    startedAt: firstTs || nowIso,
    endedAt: lastTs || nowIso,
    observations,
  };
}
