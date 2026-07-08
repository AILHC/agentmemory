import { homedir } from "node:os";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Crystal,
  RawObservation,
  Session,
  MemoryProvider,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import { detectTranscriptFormat, parseTranscriptText } from "../replay/format.js";
import {
  computeSourceFileHash,
  stableFallbackSessionId,
  type ReplayImportContext,
} from "../replay/import-identity.js";
import { projectTimeline, type Timeline } from "../replay/timeline.js";
import { safeAudit } from "./audit.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import {
  flushIndexSaveStrict,
  getSearchIndex,
  reindexSessions,
} from "./search.js";
import { logger } from "../logger.js";
import {
  extractLessonsFromReplay,
  type ExtractLessonsResult,
  resolveReplayLessonExtractionConfig,
  type ReplayLessonExtractionConfig,
} from "./lesson-extract.js";

export const MAX_FILES_DEFAULT = 200;
export const MAX_FILES_UPPER_BOUND = 1000;
export const DEFAULT_REPLAY_LOAD_LIMIT = 500;
export const MAX_REPLAY_LOAD_LIMIT = 1000;
export const DEFAULT_REPLAY_EVENT_PAYLOAD_CHARS = 1200;
export const MAX_REPLAY_EVENT_PAYLOAD_CHARS = 5000;
const REPLAY_LIST_DEDUP_OBSERVATION_LIMIT = 2_000;
const SEARCH_INDEX_DIRTY_KEY = "search-index-dirty";
const SEARCH_INDEX_DIRTY_RUN_KEY_PREFIX = `${SEARCH_INDEX_DIRTY_KEY}:`;
const REPLAY_DIRTY_MARKER_STALE_MS = 5 * 60 * 1000;
const activeReplayImportRunIds = new Set<string>();

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/_.-])secret([\\/_.-]|s?$)/i,
  /(^|[\\/_.-])credentials?([\\/_.-]|$)/i,
  /(^|[\\/_.-])private[_-]?key([\\/_.-]|$)/i,
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /(^|[\\/_.-])id_rsa([\\/_.-]|$)/i,
  /(^|[\\/])auth[_-]?token([\\/_.-]|$)/i,
  /(^|[\\/])bearer[_-]?token([\\/_.-]|$)/i,
  /(^|[\\/])access[_-]?token([\\/_.-]|$)/i,
  /(^|[\\/])api[_-]?token([\\/_.-]|$)/i,
];

export function isSensitive(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

type ReplayStoredObservation = CompressedObservation &
  Partial<
    Pick<
      RawObservation,
      | "hookType"
      | "userPrompt"
      | "assistantResponse"
      | "toolName"
      | "toolInput"
      | "toolOutput"
      | "modality"
      | "imageData"
      | "agentId"
      | "sourceFormat"
      | "sourceFileHash"
      | "sourceSessionId"
      | "sourceEventId"
      | "sourceEventIndex"
      | "importKey"
      | "lineage"
      | "parentSessionId"
    >
  >;

type ReplayImportIndexMode = "session" | "manual";

type SearchIndexDirtyMarker = {
  dirty: boolean;
  reason: "replay-import-deferred";
  updatedAt: string;
  importRunId: string;
  sessionIds: string[];
  inProgress: boolean;
  ownerPid?: number;
};

function replaySearchIndexDirtyRunKey(importRunId: string): string {
  return `${SEARCH_INDEX_DIRTY_RUN_KEY_PREFIX}${importRunId}`;
}

function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function replayImportMarkerHasActiveOwner(
  marker: SearchIndexDirtyMarker,
): boolean {
  if (
    marker.ownerPid === process.pid &&
    activeReplayImportRunIds.has(marker.importRunId)
  ) {
    return true;
  }
  return !!(
    marker.ownerPid &&
    marker.ownerPid !== process.pid &&
    isProcessAlive(marker.ownerPid)
  );
}

function legacyReplayImportMarkerIsFresh(
  marker: SearchIndexDirtyMarker,
  now = Date.now(),
): boolean {
  if (marker.ownerPid) return false;
  const updatedAt = Date.parse(marker.updatedAt);
  return (
    !Number.isFinite(updatedAt) ||
    now - updatedAt < REPLAY_DIRTY_MARKER_STALE_MS
  );
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

function inferHookTypeFromStoredObservation(
  obs: ReplayStoredObservation,
): RawObservation["hookType"] {
  if (obs.hookType) return obs.hookType;
  if (obs.type === "error") return "post_tool_failure";
  if (typeof obs.assistantResponse === "string" && !obs.userPrompt) {
    return "stop";
  }
  if (typeof obs.userPrompt === "string" && !obs.assistantResponse) {
    return "prompt_submit";
  }
  if (obs.type === "conversation" && typeof obs.narrative === "string") {
    if (typeof obs.assistantResponse === "string") return "stop";
    return "prompt_submit";
  }
  return "post_tool_use";
}

function rawFromCompressed(obs: ReplayStoredObservation): RawObservation {
  const hookType = inferHookTypeFromStoredObservation(obs);
  const syntheticRaw = { title: obs.title, narrative: obs.narrative, facts: obs.facts };
  if (obs.hookType) {
    return {
      id: obs.id,
      sessionId: obs.sessionId,
      timestamp: obs.timestamp,
      hookType,
      toolName: obs.toolName,
      toolInput: obs.toolInput,
      toolOutput: obs.toolOutput,
      userPrompt: obs.userPrompt,
      assistantResponse: obs.assistantResponse,
      raw: syntheticRaw,
      modality: obs.modality,
      imageData: obs.imageData,
      agentId: obs.agentId,
      sourceFormat: obs.sourceFormat,
      sourceFileHash: obs.sourceFileHash,
      sourceSessionId: obs.sourceSessionId,
      sourceEventId: obs.sourceEventId,
      sourceEventIndex: obs.sourceEventIndex,
      importKey: obs.importKey,
      lineage: obs.lineage,
      parentSessionId: obs.parentSessionId,
    };
  }

  return {
    id: obs.id,
    sessionId: obs.sessionId,
    timestamp: obs.timestamp,
    hookType,
    toolName: obs.toolName,
    toolInput: obs.toolInput,
    toolOutput: obs.toolOutput,
    userPrompt: obs.userPrompt ?? (obs.type === "conversation" ? obs.narrative : undefined),
    assistantResponse: obs.assistantResponse,
    raw: syntheticRaw,
    sourceFormat: obs.sourceFormat,
    sourceFileHash: obs.sourceFileHash,
    sourceSessionId: obs.sourceSessionId,
    sourceEventId: obs.sourceEventId,
    sourceEventIndex: obs.sourceEventIndex,
    importKey: obs.importKey,
    lineage: obs.lineage,
    parentSessionId: obs.parentSessionId,
  };
}

function shouldIndexReplayObservation(obs: CompressedObservation): boolean {
  const replayObs = obs as ReplayStoredObservation;
  if (!obs.title || !obs.narrative) return false;

  const hookType = replayObs.hookType;
  if (hookType === "prompt_submit" || hookType === "stop") return true;
  if (hookType === "post_tool_failure") return true;
  if (hookType === "pre_tool_use" || hookType === "post_tool_use") {
    return false;
  }

  if (obs.type === "conversation" || obs.type === "error") return true;

  const title = obs.title.toLowerCase();
  if (title === "prompt_submit" || title === "stop") return true;
  if (
    title === "post_tool_use" ||
    title === "pre_tool_use" ||
    title === "shell_command" ||
    title === "exec_command" ||
    title === "apply_patch" ||
    title === "mcp_tool_call"
  ) {
    return false;
  }

  return false;
}

function normalizeReplayLoadLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_REPLAY_LOAD_LIMIT;
  }
  return Math.max(1, Math.min(MAX_REPLAY_LOAD_LIMIT, Math.trunc(value)));
}

function normalizeReplayLoadOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeReplayEventPayloadChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_REPLAY_EVENT_PAYLOAD_CHARS;
  }
  return Math.max(200, Math.min(MAX_REPLAY_EVENT_PAYLOAD_CHARS, Math.trunc(value)));
}

function summarizeLessonExtractionSessions(
  sessions: Record<string, ExtractLessonsResult>,
  enabled: boolean,
) {
  const sessionsSummary = Object.fromEntries(
    Object.entries(sessions).map(([sessionId, result]) => [
      sessionId,
      {
        lessonIds: result.lessonIds,
        created: result.created,
        reinforced: result.reinforced,
        skipped: result.skipped,
        errors: result.errors,
      },
    ]),
  );

  return {
    enabled,
    sessions: sessionsSummary,
    created: Object.values(sessions).reduce((sum, result) => sum + result.created, 0),
    reinforced: Object.values(sessions).reduce((sum, result) => sum + result.reinforced, 0),
    skipped: Object.values(sessions).reduce((sum, result) => sum + result.skipped, 0),
    errors: Object.values(sessions).flatMap((result) => result.errors),
  };
}

function validateReplayLessonExtractionPayload(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "lessonExtraction must be an object";
  }
  const payload = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "enabled",
    "textLimit",
    "matchLimit",
    "saveLimit",
    "additionalHeuristicTerms",
    "allowUnbounded",
  ]);
  const unknownKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length === 0) return null;
  return `invalid lessonExtraction. Allowed fields: ${Array.from(allowedKeys).join(", ")}`;
}

function addTag(tags: string[] | undefined, tag: string): string[] {
  const next = tags ? [...tags] : [];
  if (!next.includes(tag)) next.push(tag);
  return next;
}

function removeTag(tags: string[] | undefined, tag: string): string[] | undefined {
  const next = (tags || []).filter((item) => item !== tag);
  return next.length > 0 ? next : undefined;
}

function isStateSetTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "TIMEOUT" ||
    (/state::set/i.test(message) &&
      /timeout|timed out|Invocation timeout/i.test(message))
  );
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sanitizeLoneSurrogates(input: string): string {
  let out = "";
  let changed = false;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i += 1;
      } else {
        out += "\ufffd";
        changed = true;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\ufffd";
      changed = true;
      continue;
    }
    out += input[i];
  }
  return changed ? out : input;
}

function sanitizeReplayJsonValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeLoneSurrogates(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReplayJsonValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[sanitizeLoneSurrogates(key)] = sanitizeReplayJsonValue(item);
    }
    return out as T;
  }
  return value;
}

async function setWithCommitProbe<T>(
  kv: StateKV,
  scope: string,
  key: string,
  value: T,
): Promise<T> {
  try {
    return await kv.set(scope, key, value);
  } catch (err) {
    if (!isStateSetTimeout(err)) throw err;
    const committed = await kv.get<T>(scope, key).catch(() => null);
    if (committed !== null && valuesEqual(committed, value)) return committed;
    throw err;
  }
}

async function readReplaySearchIndexDirty(
  kv: StateKV,
): Promise<SearchIndexDirtyMarker | null> {
  return kv.get<SearchIndexDirtyMarker>(KV.state, SEARCH_INDEX_DIRTY_KEY);
}

async function markReplaySearchIndexDirty(
  kv: StateKV,
  patch: Omit<SearchIndexDirtyMarker, "dirty" | "updatedAt">,
): Promise<void> {
  const existing = await readReplaySearchIndexDirty(kv);
  const sessionIds = Array.from(
    new Set([...(existing?.sessionIds || []), ...patch.sessionIds]),
  );
  const globalMarker: SearchIndexDirtyMarker = {
    ...patch,
    dirty: true,
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
    sessionIds,
  };
  const runMarker: SearchIndexDirtyMarker = {
    ...globalMarker,
    sessionIds: Array.from(new Set(patch.sessionIds)),
  };
  await setWithCommitProbe(kv, KV.state, SEARCH_INDEX_DIRTY_KEY, globalMarker);
  await setWithCommitProbe(
    kv,
    KV.state,
    replaySearchIndexDirtyRunKey(patch.importRunId),
    runMarker,
  );
}

async function markerSessionsAreImportComplete(
  kv: StateKV,
  marker: SearchIndexDirtyMarker,
): Promise<boolean> {
  for (const sessionId of marker.sessionIds) {
    const session = await kv.get<Session>(KV.sessions, sessionId);
    if (session?.tags?.includes("jsonl-importing")) return false;
  }
  return true;
}

async function dirtySessionsAreCoveredByLoadedSearchIndex(
  kv: StateKV,
  sessionIds: string[],
): Promise<boolean> {
  const idx = getSearchIndex();
  let sawIndexableObservation = false;
  for (const sessionId of Array.from(new Set(sessionIds.filter(Boolean)))) {
    let observations: CompressedObservation[];
    try {
      observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
    } catch {
      return false;
    }
    for (const obs of observations) {
      if (shouldIndexReplayObservation(obs)) {
        sawIndexableObservation = true;
        if (!idx.has(obs.id)) return false;
      } else if (idx.has(obs.id)) {
        return false;
      }
    }
  }
  return sawIndexableObservation;
}

async function releaseInactiveReplaySearchIndexDirtyRuns(
  kv: StateKV,
): Promise<void> {
  const now = Date.now();
  const globalMarker = await readReplaySearchIndexDirty(kv);
  if (!globalMarker?.inProgress) return;
  if (replayImportMarkerHasActiveOwner(globalMarker)) return;
  if (legacyReplayImportMarkerIsFresh(globalMarker, now)) return;
  if (!(await markerSessionsAreImportComplete(kv, globalMarker))) return;

  const releasedMarker = {
    ...globalMarker,
    inProgress: false,
    updatedAt: new Date().toISOString(),
  };
  await setWithCommitProbe(
    kv,
    KV.state,
    replaySearchIndexDirtyRunKey(globalMarker.importRunId),
    {
      ...releasedMarker,
      sessionIds: [],
    },
  );
  await setWithCommitProbe(kv, KV.state, SEARCH_INDEX_DIRTY_KEY, releasedMarker);
}

async function loadExistingObservationIds(
  kv: StateKV,
  session: Session | null,
  sessionId: string,
  usePointLookups = false,
): Promise<Set<string> | null> {
  if (!session) return new Set();
  const importing = session.tags?.includes("jsonl-importing") ?? false;
  if (
    usePointLookups ||
    importing ||
    session.observationCount > REPLAY_LIST_DEDUP_OBSERVATION_LIMIT
  ) {
    return null;
  }
  const existing = await kv.list<ReplayStoredObservation>(KV.observations(sessionId));
  return new Set(existing.map((obs) => obs.id));
}

async function deriveCrystal(
  kv: StateKV,
  sessionId: string,
  project: string,
  rawObs: RawObservation[],
  compressed: CompressedObservation[],
  firstPrompt: string | undefined,
  lessonIds: string[],
): Promise<void> {
  if (rawObs.length === 0) return;
  const createdAt = new Date().toISOString();

  const files = new Set<string>();
  const tools = new Set<string>();
  for (const c of compressed) {
    for (const f of c.files || []) files.add(f);
    if (c.type && c.type !== "conversation" && c.title) tools.add(c.title);
  }

  // Content-addressed on sessionId so re-importing the same session
  // upserts the crystal in place instead of creating a new one.
  const crystalId = fingerprintId("crystal", sessionId);
  const narrativePreview = firstPrompt
    ? firstPrompt.slice(0, 300)
    : compressed
        .slice(0, 5)
        .map((c) => c.narrative || c.title)
        .filter(Boolean)
        .join(" · ")
        .slice(0, 300);

  try {
    const existingCrystal = await kv.get<Crystal>(KV.crystals, crystalId);
    const newKeyOutcomes = Array.from(tools).slice(0, 8);
    const newFilesAffected = Array.from(files).slice(0, 20);
    const mergedKeyOutcomes = Array.from(
      new Set([...(existingCrystal?.keyOutcomes ?? []), ...newKeyOutcomes]),
    ).slice(0, 8);
    const mergedFilesAffected = Array.from(
      new Set([...(existingCrystal?.filesAffected ?? []), ...newFilesAffected]),
    ).slice(0, 20);
    const mergedLessonIds = Array.from(
      new Set([...(existingCrystal?.lessons ?? []), ...lessonIds]),
    );
    const crystal: Crystal = {
      id: crystalId,
      narrative:
        narrativePreview ||
        existingCrystal?.narrative ||
        `Session ${sessionId.slice(0, 12)} (${rawObs.length} observations)`,
      keyOutcomes: mergedKeyOutcomes,
      filesAffected: mergedFilesAffected,
      lessons: mergedLessonIds,
      sourceActionIds: existingCrystal?.sourceActionIds ?? [],
      sessionId,
      project,
      createdAt: existingCrystal?.createdAt ?? createdAt,
    };
    await kv.set(KV.crystals, crystalId, crystal);
  } catch {}
}

function isRawShape(o: unknown): o is ReplayStoredObservation {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.hookType === "string";
}

async function loadObservations(
  kv: StateKV,
  sessionId: string,
): Promise<RawObservation[]> {
  const rows = await kv.list<RawObservation | ReplayStoredObservation>(
    KV.observations(sessionId),
  );
  return rows.map((r) => {
    if (isRawShape(r)) {
      return {
        id: r.id,
        sessionId: r.sessionId,
        timestamp: r.timestamp,
        hookType: r.hookType,
        toolName: r.toolName,
        toolInput: r.toolInput,
        toolOutput: r.toolOutput,
        userPrompt: r.userPrompt,
        assistantResponse: r.assistantResponse,
        raw: r.raw ?? { title: r.title, narrative: r.narrative, facts: r.facts },
        modality: r.modality,
        imageData: r.imageData,
        agentId: r.agentId,
        sourceFormat: r.sourceFormat,
        sourceFileHash: r.sourceFileHash,
        sourceSessionId: r.sourceSessionId,
        sourceEventId: r.sourceEventId,
        sourceEventIndex: r.sourceEventIndex,
        importKey: r.importKey,
        lineage: r.lineage,
        parentSessionId: r.parentSessionId,
      };
    }
    return rawFromCompressed(r);
  });
}

async function findJsonlFiles(
  root: string,
  limit = 200,
): Promise<{
  files: string[];
  truncated: boolean;
  discovered: number;
  traversalCapped: boolean;
}> {
  const out: string[] = [];
  let discovered = 0;
  let walked = 0;
  // Hard bound on entries visited (regardless of extension) so trees
  // dominated by non-jsonl files (node_modules, lockfiles, etc.) cannot
  // lock the 30s function timeout. `discovered` may underrepresent the
  // true count when traversalCapped fires — callers should surface that
  // distinction to the user.
  const traversalCap = Math.max(limit * 50, 50_000);
  async function walk(dir: string) {
    if (walked >= traversalCap) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (walked >= traversalCap) return;
      walked++;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile() && name.endsWith(".jsonl")) {
        discovered++;
        if (out.length < limit) out.push(full);
      }
    }
  }
  await walk(root);
  const traversalCapped = walked >= traversalCap;
  return {
    files: out,
    truncated: discovered > out.length || traversalCapped,
    discovered,
    traversalCapped,
  };
}

export function registerReplayFunctions(
  sdk: ISdk,
  kv: StateKV,
  _provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::replay::load",
    async (data: {
      sessionId: string;
      offset?: number;
      limit?: number;
      maxEventPayloadChars?: number;
    }): Promise<
      | { success: true; timeline: Timeline; session: Session | null }
      | { success: false; error: string }
    > => {
      if (!data?.sessionId || typeof data.sessionId !== "string") {
        return { success: false, error: "sessionId is required" };
      }
      const offset = normalizeReplayLoadOffset(data.offset);
      const limit = normalizeReplayLoadLimit(data.limit);
      const maxEventPayloadChars = normalizeReplayEventPayloadChars(
        data.maxEventPayloadChars,
      );
      const session = await kv.get<Session>(KV.sessions, data.sessionId);
      const observations = await loadObservations(kv, data.sessionId);
      const timeline = projectTimeline(observations, { offset, limit, maxEventPayloadChars });
      return { success: true, timeline, session };
    },
  );

  sdk.registerFunction(
    "mem::replay::sessions",
    async (): Promise<{ success: true; sessions: Session[] }> => {
      const sessions = await kv.list<Session>(KV.sessions);
      sessions.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      return { success: true, sessions };
    },
  );

  sdk.registerFunction(
    "mem::replay::finalize-deferred-index",
    async (): Promise<
      | { success: true; rebuilt: number; dirtyCleared: boolean }
      | { success: false; error: string }
    > => {
      await releaseInactiveReplaySearchIndexDirtyRuns(kv);
      const marker = await readReplaySearchIndexDirty(kv);
      if (!marker?.dirty) {
        return { success: true, rebuilt: 0, dirtyCleared: false };
      }
      if (
        marker.inProgress ||
        !(await markerSessionsAreImportComplete(kv, marker))
      ) {
        return {
          success: false,
          error: "deferred replay import is still in progress",
        };
      }
      if (
        await dirtySessionsAreCoveredByLoadedSearchIndex(kv, marker.sessionIds)
      ) {
        const latest = await readReplaySearchIndexDirty(kv);
        if (
          latest?.dirty &&
          !latest.inProgress &&
          latest.importRunId === marker.importRunId &&
          latest.updatedAt === marker.updatedAt
        ) {
          const now = new Date().toISOString();
          await setWithCommitProbe(kv, KV.state, SEARCH_INDEX_DIRTY_KEY, {
            ...latest,
            dirty: false,
            inProgress: false,
            updatedAt: now,
          });
          await setWithCommitProbe(
            kv,
            KV.state,
            replaySearchIndexDirtyRunKey(latest.importRunId),
            {
              ...latest,
              dirty: false,
              inProgress: false,
              updatedAt: now,
              sessionIds: [],
            },
          );
          return { success: true, rebuilt: 0, dirtyCleared: true };
        }
        return { success: true, rebuilt: 0, dirtyCleared: false };
      }
      const reindex = await reindexSessions(kv, marker.sessionIds, {
        includeVector: false,
        shouldIndex: shouldIndexReplayObservation,
      });
      const rebuilt = reindex.indexed;
      const saved = await flushIndexSaveStrict({ includeVector: false });
      if (reindex.failedSessionIds.length > 0 || !saved) {
        return {
          success: false,
          error:
            "failed to persist rebuilt replay index; dirty marker remains",
        };
      }
      const latest = await readReplaySearchIndexDirty(kv);
      if (
        !latest?.dirty ||
        latest.inProgress ||
        latest.importRunId !== marker.importRunId ||
        latest.updatedAt !== marker.updatedAt
      ) {
        return { success: true, rebuilt, dirtyCleared: false };
      }
      const now = new Date().toISOString();
      await setWithCommitProbe(kv, KV.state, SEARCH_INDEX_DIRTY_KEY, {
        ...latest,
        dirty: false,
        inProgress: false,
        updatedAt: now,
      });
      await setWithCommitProbe(
        kv,
        KV.state,
        replaySearchIndexDirtyRunKey(latest.importRunId),
        {
          ...latest,
          dirty: false,
          inProgress: false,
          updatedAt: now,
          sessionIds: [],
        },
      );
      return { success: true, rebuilt, dirtyCleared: true };
    },
  );

  sdk.registerFunction(
    "mem::replay::import-jsonl",
    async (
      data: {
        path?: string;
        maxFiles?: number;
        indexMode?: ReplayImportIndexMode;
        lessonExtraction?: Partial<ReplayLessonExtractionConfig>;
      } = {},
    ): Promise<
      | {
          success: true;
          imported: number;
          sessionIds: string[];
          observations: number;
          created: number;
          updated: number;
          skippedDuplicate: number;
          filteredChildSession: number;
          mergedChildSession: number;
          filteredSidechainSession: number;
          mergedSidechainSession: number;
          ambiguousLineage: number;
          lessonExtraction: {
            enabled: boolean;
            sessions: Record<
              string,
              {
                lessonIds: string[];
                created: number;
                reinforced: number;
                skipped: number;
                errors: string[];
              }
            >;
            created: number;
            reinforced: number;
            skipped: number;
            errors: string[];
          };
          indexing: {
            mode: ReplayImportIndexMode;
            indexed: number;
            saved: boolean;
            dirty: boolean;
            requiresFinalize: boolean;
            failedSessionIds: string[];
          };
          discovered: number;
          truncated: boolean;
          traversalCapped: boolean;
          maxFiles: number;
          maxFilesUpperBound: number;
        }
      | { success: false; error: string }
    > => {
      const defaultRoot = join(homedir(), ".claude", "projects");
      const rawPath = data.path || defaultRoot;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { success: false, error: "path must be a non-empty string" };
      }
      const expanded = rawPath.startsWith("~")
        ? join(homedir(), rawPath.slice(1))
        : rawPath;
      const abs = resolve(expanded);
      if (isSensitive(abs)) {
        return { success: false, error: "refusing to process sensitive-looking path" };
      }
      if (await isSymlink(abs)) {
        return { success: false, error: "symlinks are not supported" };
      }

      let stat;
      try {
        stat = await lstat(abs);
      } catch {
        return { success: false, error: "path not found" };
      }

      // Valid integer requests are clamped to MAX_FILES_UPPER_BOUND so
      // callers see a stable maxFiles in the response. Non-integer or
      // <= 0 falls back to the safe default. The HTTP layer rejects
      // out-of-range up front; this is the SDK-callable safety net.
      const maxFiles =
        Number.isInteger(data.maxFiles) && (data.maxFiles as number) > 0
          ? Math.min(data.maxFiles as number, MAX_FILES_UPPER_BOUND)
          : MAX_FILES_DEFAULT;
      let files: string[] = [];
      let truncated = false;
      let discovered = 0;
      let traversalCapped = false;
      const lessonExtractionError = validateReplayLessonExtractionPayload(
        data.lessonExtraction,
      );
      if (lessonExtractionError) {
        return { success: false, error: lessonExtractionError };
      }
      const lessonExtractionConfig = resolveReplayLessonExtractionConfig(
        process.env,
        data.lessonExtraction || {},
      );
      if (
        data.indexMode !== undefined &&
        data.indexMode !== "session" &&
        data.indexMode !== "manual"
      ) {
        return {
          success: false,
          error: "indexMode must be 'session' or 'manual'",
        };
      }
      const indexMode: ReplayImportIndexMode = data.indexMode ?? "session";
      if (stat.isDirectory()) {
        const found = await findJsonlFiles(abs, maxFiles);
        files = found.files;
        truncated = found.truncated;
        discovered = found.discovered;
        traversalCapped = found.traversalCapped;
      } else if (stat.isFile() && abs.endsWith(".jsonl")) {
        files = [abs];
        discovered = 1;
      } else {
        return { success: false, error: "path must be a .jsonl file or directory" };
      }
      files.sort();

      if (files.length === 0) {
        return {
          success: true,
          imported: 0,
          sessionIds: [],
          observations: 0,
          created: 0,
          updated: 0,
          skippedDuplicate: 0,
          filteredChildSession: 0,
          mergedChildSession: 0,
          filteredSidechainSession: 0,
          mergedSidechainSession: 0,
          ambiguousLineage: 0,
          lessonExtraction: summarizeLessonExtractionSessions(
            {},
            lessonExtractionConfig.enabled,
          ),
          indexing: {
            mode: indexMode,
            indexed: 0,
            saved: false,
            dirty: false,
            requiresFinalize: false,
            failedSessionIds: [],
          },
          discovered,
          truncated,
          traversalCapped,
          maxFiles,
          maxFilesUpperBound: MAX_FILES_UPPER_BOUND,
        };
      }

      const sessionIds = new Set<string>();
      const sourceFileHashes = new Set<string>();
      let created = 0;
      const updated = 0;
      let skippedDuplicate = 0;
      let filteredChildSession = 0;
      let mergedChildSession = 0;
      let filteredSidechainSession = 0;
      let mergedSidechainSession = 0;
      let ambiguousLineage = 0;
      const lessonExtractionResults: Record<string, ExtractLessonsResult> = {};
      const importRunId = generateId("replay_import");
      const sessionRowCache = new Map<string, Session>();
      const sessionObservationCounts = new Map<string, number>();
      const sessionImportObservationIds = new Map<string, Set<string>>();
      const reconcileSessionObservationCount = (
        sessionId: string,
        fallbackCount: number,
      ): number =>
        Math.max(
          sessionObservationCounts.get(sessionId) ?? fallbackCount,
          sessionImportObservationIds.get(sessionId)?.size ?? 0,
          fallbackCount,
        );
      let deferredDirtyTouched = false;

      activeReplayImportRunIds.add(importRunId);
      try {
      const parsedFiles: Array<{ parsed: ReturnType<typeof parseTranscriptText> }> = [];
      const batchTopLevelSessionIds = new Set<string>();

      for (const file of files) {
        if (isSensitive(file)) continue;
        if (await isSymlink(file)) continue;
        let text: string;
        try {
          text = await readFile(file, "utf-8");
        } catch (err) {
          logger.warn("replay: failed to read jsonl", {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const sourceFormat = detectTranscriptFormat(text);
        const sourceFileHash = computeSourceFileHash(text);
        sourceFileHashes.add(sourceFileHash);
        const context: ReplayImportContext = { sourceFormat, sourceFileHash };
        const parsed = parseTranscriptText(
          text,
          stableFallbackSessionId(context),
          context,
        );
        if (parsed.observations.length === 0) continue;
        parsedFiles.push({ parsed });

        const baseTargetSessionId = parsed.targetSessionId || parsed.sessionId;
        const hasTopLevelObservation = parsed.observations.some((obs) => {
          const lineage = obs.lineage ?? parsed.lineage ?? "top-level";
          return lineage !== "child" && lineage !== "sidechain";
        });
        if ((parsed.lineage ?? "top-level") === "top-level" || hasTopLevelObservation) {
          batchTopLevelSessionIds.add(baseTargetSessionId);
        }
      }

      for (const { parsed } of parsedFiles) {
        const baseTargetSessionId = parsed.targetSessionId || parsed.sessionId;
        const groups = new Map<
          string,
          {
            lineage: string;
            targetSessionId: string;
            observations: RawObservation[];
          }
        >();

        for (const obs of parsed.observations) {
          const obsLineage = obs.lineage ?? parsed.lineage ?? "top-level";
          let targetSessionId = baseTargetSessionId;

          if (obsLineage === "child") {
            const parentSessionId = obs.parentSessionId ?? parsed.parentSessionId;
            if (!parentSessionId) {
              ambiguousLineage += 1;
              continue;
            }
            const parentExists =
              batchTopLevelSessionIds.has(parentSessionId) ||
              sessionIds.has(parentSessionId) ||
              (await kv.get<Session>(KV.sessions, parentSessionId));
            if (!parentExists) {
              filteredChildSession += 1;
              continue;
            }
            targetSessionId = parentSessionId;
          } else if (obsLineage === "sidechain") {
            const parentSessionId = obs.parentSessionId ?? parsed.parentSessionId;
            if (!parentSessionId) {
              ambiguousLineage += 1;
              continue;
            }
            const parentExists =
              batchTopLevelSessionIds.has(parentSessionId) ||
              sessionIds.has(parentSessionId) ||
              (await kv.get<Session>(KV.sessions, parentSessionId));
            if (!parentExists) {
              filteredSidechainSession += 1;
              continue;
            }
            targetSessionId = parentSessionId;
          }

          const groupKey = `${obsLineage}:${targetSessionId}`;
          let group = groups.get(groupKey);
          if (!group) {
            group = { lineage: obsLineage, targetSessionId, observations: [] };
            groups.set(groupKey, group);
            if (obsLineage === "child") mergedChildSession += 1;
            if (obsLineage === "sidechain") mergedSidechainSession += 1;
          }
          obs.sessionId = targetSessionId;
          group.observations.push(obs);
        }

        for (const group of groups.values()) {
          const { targetSessionId, observations } = group;
          if (observations.length === 0) continue;

          const firstPromptObs = observations.find(
            (o) => typeof o.userPrompt === "string" && o.userPrompt.trim().length > 0,
          );
          const firstPrompt = firstPromptObs?.userPrompt
            ? sanitizeLoneSurrogates(
                firstPromptObs.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200),
              )
            : undefined;
          const replayProject = sanitizeLoneSurrogates(parsed.project);
          const replayCwd = sanitizeLoneSurrogates(parsed.cwd);

          const cachedSession = sessionRowCache.get(targetSessionId) ?? null;
          const storedSession =
            cachedSession ?? (await kv.get<Session>(KV.sessions, targetSessionId));
          if (!sessionObservationCounts.has(targetSessionId)) {
            sessionObservationCounts.set(
              targetSessionId,
              storedSession?.observationCount ?? 0,
            );
          }
          const canCreateSessionRow =
            group.lineage !== "child" &&
            group.lineage !== "sidechain" &&
            batchTopLevelSessionIds.has(targetSessionId);
          if (storedSession || canCreateSessionRow) {
            const nextSession: Session = storedSession
              ? {
                  ...storedSession,
                  id: storedSession.id || targetSessionId,
                }
              : {
                  id: targetSessionId,
                  project: replayProject,
                  cwd: replayCwd,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  status: "completed",
                  observationCount:
                    sessionObservationCounts.get(targetSessionId) ?? 0,
                  tags: [],
                  firstPrompt,
                };
            if (parsed.endedAt > (nextSession.endedAt || "")) {
              nextSession.endedAt = parsed.endedAt;
            }
            if (nextSession.status === "active") nextSession.status = "completed";
            nextSession.tags = addTag(
              addTag(nextSession.tags, "jsonl-import"),
              "jsonl-importing",
            );
            if (!nextSession.firstPrompt && firstPrompt) {
              nextSession.firstPrompt = firstPrompt;
            }
            nextSession.observationCount =
              sessionObservationCounts.get(targetSessionId) ??
              nextSession.observationCount;
            const safeNextSession = sanitizeReplayJsonValue(nextSession);
            await setWithCommitProbe(
              kv,
              KV.sessions,
              targetSessionId,
              safeNextSession,
            );
            sessionRowCache.set(targetSessionId, safeNextSession);
          }

          const existingObservationIds = await loadExistingObservationIds(
            kv,
            storedSession,
            targetSessionId,
            indexMode === "manual",
          );
          const successfulNewObservationIds = new Set<string>();
          const newRawObservations: RawObservation[] = [];
          const newCompressedObservations: CompressedObservation[] = [];
          let dirtyMarkedForGroup = false;
          for (const obs of observations) {
            const safeObs = sanitizeReplayJsonValue(obs);
            let importedObservationIds =
              sessionImportObservationIds.get(targetSessionId);
            if (!importedObservationIds) {
              importedObservationIds = new Set<string>();
              sessionImportObservationIds.set(targetSessionId, importedObservationIds);
            }
            importedObservationIds.add(safeObs.id);

            if (successfulNewObservationIds.has(safeObs.id)) {
              skippedDuplicate += 1;
              continue;
            }

            const existingObservation =
              existingObservationIds === null
                ? await kv.get<ReplayStoredObservation>(
                    KV.observations(targetSessionId),
                    safeObs.id,
                  )
                : existingObservationIds.has(safeObs.id)
                  ? ({ id: safeObs.id } as ReplayStoredObservation)
                  : null;
            if (existingObservation) {
              skippedDuplicate += 1;
              continue;
            }

            if (indexMode === "manual" && !dirtyMarkedForGroup) {
              await markReplaySearchIndexDirty(kv, {
                reason: "replay-import-deferred",
                importRunId,
                sessionIds: [targetSessionId],
                inProgress: true,
              });
              deferredDirtyTouched = true;
              dirtyMarkedForGroup = true;
            }

            const synthetic = sanitizeReplayJsonValue(
              buildSyntheticCompression(safeObs),
            );
            const storedObservation: ReplayStoredObservation = {
              ...synthetic,
              hookType: safeObs.hookType,
              userPrompt: safeObs.userPrompt,
              assistantResponse: safeObs.assistantResponse,
              toolName: safeObs.toolName,
              toolInput: safeObs.toolInput,
              toolOutput: safeObs.toolOutput,
              modality: safeObs.modality,
              imageData: safeObs.imageData,
              agentId: safeObs.agentId,
              sourceFormat: safeObs.sourceFormat,
              sourceFileHash: safeObs.sourceFileHash,
              sourceSessionId: safeObs.sourceSessionId,
              sourceEventId: safeObs.sourceEventId,
              sourceEventIndex: safeObs.sourceEventIndex,
              importKey: safeObs.importKey,
              lineage: safeObs.lineage,
              parentSessionId: safeObs.parentSessionId,
            };
            await setWithCommitProbe(
              kv,
              KV.observations(targetSessionId),
              safeObs.id,
              storedObservation,
            );
            existingObservationIds?.add(safeObs.id);
            successfulNewObservationIds.add(safeObs.id);
            sessionObservationCounts.set(
              targetSessionId,
              (sessionObservationCounts.get(targetSessionId) ?? 0) + 1,
            );
            newRawObservations.push(safeObs);
            newCompressedObservations.push(synthetic);
            created += 1;
          }

          const sessionRow = sessionRowCache.get(targetSessionId);
          if (sessionRow) {
            sessionRow.observationCount = reconcileSessionObservationCount(
              targetSessionId,
              sessionRow.observationCount,
            );
            sessionRowCache.set(targetSessionId, sessionRow);
          }

          sessionIds.add(targetSessionId);

          if (newRawObservations.length > 0) {
            const extraction = lessonExtractionConfig.enabled
              ? await extractLessonsFromReplay({
                  kv,
                  sessionId: targetSessionId,
                  project: parsed.project,
                  rawObservations: newRawObservations,
                  firstPrompt,
                  config: lessonExtractionConfig,
                }).catch((error) => ({
                  lessonIds: [],
                  created: 0,
                  reinforced: 0,
                  skipped: 0,
                  errors: [
                    error instanceof Error ? error.message : String(error),
                  ],
                }))
              : {
                  lessonIds: [],
                  created: 0,
                  reinforced: 0,
                  skipped: 0,
                  errors: [],
                };

            lessonExtractionResults[targetSessionId] = extraction;

            if (lessonExtractionConfig.enabled) {
              await deriveCrystal(
                kv,
                targetSessionId,
                parsed.project,
                newRawObservations,
                newCompressedObservations,
                firstPrompt,
                extraction.lessonIds,
              );
            }
          }
        }
      }

      const returnedSessionIds = Array.from(sessionIds);
      for (const [sessionId, sessionRow] of sessionRowCache) {
        const finalizedSession: Session = {
          ...sessionRow,
          status: "completed",
          observationCount: reconcileSessionObservationCount(
            sessionId,
            sessionRow.observationCount,
          ),
          tags: addTag(removeTag(sessionRow.tags, "jsonl-importing"), "jsonl-import"),
        };
        await setWithCommitProbe(
          kv,
          KV.sessions,
          sessionId,
          sanitizeReplayJsonValue(finalizedSession),
        );
      }

      let indexed = 0;
      let failedSessionIds: string[] = [];
      let indexSaved = false;
      let indexDirty = false;
      let requiresFinalize = indexMode === "manual" && deferredDirtyTouched;

      if (indexMode === "session" && returnedSessionIds.length > 0) {
        const reindex = await reindexSessions(kv, returnedSessionIds, {
          includeVector: false,
          shouldIndex: shouldIndexReplayObservation,
        });
        indexed = reindex.indexed;
        failedSessionIds = reindex.failedSessionIds;
        indexSaved = await flushIndexSaveStrict({ includeVector: false });
        if (failedSessionIds.length > 0 || !indexSaved) {
          await markReplaySearchIndexDirty(kv, {
            reason: "replay-import-deferred",
            importRunId,
            sessionIds: returnedSessionIds,
            inProgress: false,
          });
          indexDirty = true;
          requiresFinalize = true;
        }
      }

      if (indexMode === "manual" && deferredDirtyTouched) {
        await markReplaySearchIndexDirty(kv, {
          reason: "replay-import-deferred",
          importRunId,
          sessionIds: returnedSessionIds,
          inProgress: false,
        });
        indexDirty = true;
        requiresFinalize = true;
      }
      await safeAudit(kv, "import", "mem::replay::import-jsonl", returnedSessionIds, {
        source: "jsonl",
        files: files.length,
        sourceFileHashes: Array.from(sourceFileHashes),
        created,
        updated,
        skippedDuplicate,
        filteredChildSession,
        mergedChildSession,
        filteredSidechainSession,
        mergedSidechainSession,
        ambiguousLineage,
      });

      return {
        success: true,
        imported: files.length,
        sessionIds: returnedSessionIds,
        observations: created,
        created,
        updated,
        skippedDuplicate,
        filteredChildSession,
        mergedChildSession,
        filteredSidechainSession,
        mergedSidechainSession,
        ambiguousLineage,
        lessonExtraction: summarizeLessonExtractionSessions(
          lessonExtractionResults,
          lessonExtractionConfig.enabled,
        ),
        indexing: {
          mode: indexMode,
          indexed,
          saved: indexSaved,
          dirty: indexDirty,
          requiresFinalize,
          failedSessionIds,
        },
        discovered,
        truncated,
        traversalCapped,
        maxFiles,
        maxFilesUpperBound: MAX_FILES_UPPER_BOUND,
      };
      } finally {
        activeReplayImportRunIds.delete(importRunId);
      }
    },
  );
}
