import { createHash } from "node:crypto";
import type { HookType } from "../types.js";
import { fingerprintId } from "../state/schema.js";

export type ReplaySourceFormat = "codex" | "claude-code" | "unknown";
export type ReplayLineageKind = "top-level" | "child" | "sidechain";

export interface ReplayImportContext {
  sourceFormat: ReplaySourceFormat;
  sourceFileHash: string;
}

export interface ReplaySourceIdentity {
  sourceFormat: ReplaySourceFormat;
  sourceFileHash: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceEventId: string;
  sourceEventIndex: number;
  importKey: string;
  observationId: string;
}

export interface ReplayLineageInfo {
  lineage: ReplayLineageKind;
  parentSessionId?: string;
}

interface ResolveSessionInput {
  context: ReplayImportContext;
  sourceSessionId?: string;
  targetSessionId?: string;
}

interface ObservationImportKeyInput {
  sourceFormat: ReplaySourceFormat;
  sourceFileHash: string;
  sourceSessionId: string;
  sourceEventId: string;
  sourceEventIndex: number;
  hookType: HookType | string;
}

interface BuildSourceIdentityInput {
  context: ReplayImportContext;
  sourceSessionId?: string;
  targetSessionId?: string;
  sourceEventId: string;
  sourceEventIndex: number;
  hookType: HookType | string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeSourceFileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stableFallbackSessionId(context: ReplayImportContext): string {
  return fingerprintId(
    "sess",
    `${context.sourceFormat}:${context.sourceFileHash}`,
  );
}

export function resolveSourceSessionId(
  input: ResolveSessionInput,
): { sourceSessionId: string; targetSessionId: string } {
  const sourceSessionId =
    input.sourceSessionId && input.sourceSessionId.trim().length > 0
      ? input.sourceSessionId
      : stableFallbackSessionId(input.context);
  return {
    sourceSessionId,
    targetSessionId:
      input.targetSessionId && input.targetSessionId.trim().length > 0
        ? input.targetSessionId
        : sourceSessionId,
  };
}

export function buildObservationImportKey(
  input: ObservationImportKeyInput,
): string {
  return fingerprintId(
    "obs",
    canonicalJson({
      sourceFormat: input.sourceFormat,
      sourceSessionId: input.sourceSessionId,
      sourceEventId: input.sourceEventId,
      sourceEventIndex: input.sourceEventIndex,
      hookType: input.hookType,
    }),
  );
}

export function buildReplaySourceIdentity(
  input: BuildSourceIdentityInput,
): ReplaySourceIdentity {
  const { sourceSessionId, targetSessionId } = resolveSourceSessionId({
    context: input.context,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
  });
  const importKey = buildObservationImportKey({
    sourceFormat: input.context.sourceFormat,
    sourceFileHash: input.context.sourceFileHash,
    sourceSessionId,
    sourceEventId: input.sourceEventId,
    sourceEventIndex: input.sourceEventIndex,
    hookType: input.hookType,
  });
  return {
    sourceFormat: input.context.sourceFormat,
    sourceFileHash: input.context.sourceFileHash,
    sourceSessionId,
    targetSessionId,
    sourceEventId: input.sourceEventId,
    sourceEventIndex: input.sourceEventIndex,
    importKey,
    observationId: importKey,
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

export function classifyCodexLineage(row: unknown): ReplayLineageInfo {
  const record =
    row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : record;
  const meta =
    payload.meta && typeof payload.meta === "object"
      ? (payload.meta as Record<string, unknown>)
      : {};
  const parentSessionId =
    pickString(payload.parent_thread_id) ?? pickString(meta.parent_thread_id);
  if (parentSessionId) return { lineage: "child", parentSessionId };
  return { lineage: "top-level" };
}

export function classifyClaudeLineage(row: unknown): ReplayLineageInfo {
  const record =
    row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const parentSessionId =
    pickString(record.parentSessionId) ??
    pickString(record.parent_session_id) ??
    pickString(record.sidechainParentSessionId);
  if (record.isSidechain === true) {
    return { lineage: "sidechain", parentSessionId };
  }
  return { lineage: "top-level" };
}
