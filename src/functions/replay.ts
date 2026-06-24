import { homedir } from "node:os";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Crystal,
  Lesson,
  RawObservation,
  Session,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import { detectTranscriptFormat, parseTranscriptText } from "../replay/format.js";
import {
  computeSourceFileHash,
  stableFallbackSessionId,
  type ReplayImportContext,
} from "../replay/import-identity.js";
import { projectTimeline, type Timeline } from "../replay/timeline.js";
import { safeAudit } from "./audit.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex } from "./search.js";
import { logger } from "../logger.js";

export const MAX_FILES_DEFAULT = 200;
export const MAX_FILES_UPPER_BOUND = 1000;
export const DEFAULT_REPLAY_LOAD_LIMIT = 500;
export const MAX_REPLAY_LOAD_LIMIT = 1000;
export const DEFAULT_REPLAY_EVENT_PAYLOAD_CHARS = 1200;
export const MAX_REPLAY_EVENT_PAYLOAD_CHARS = 5000;

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

const LESSON_PATTERNS: RegExp[] = [
  /\b(always|never|don'?t|do not|make sure|remember to|note:|caveat:|warning:)\b[^.\n]{10,200}[.!\n]/gi,
  /\b(prefer|avoid)\s[^.\n]{10,200}[.!\n]/gi,
];

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

async function deriveCrystalAndLessons(
  kv: StateKV,
  sessionId: string,
  project: string,
  rawObs: RawObservation[],
  compressed: CompressedObservation[],
  firstPrompt: string | undefined,
): Promise<void> {
  if (rawObs.length === 0) return;
  const createdAt = new Date().toISOString();

  const files = new Set<string>();
  const tools = new Set<string>();
  for (const c of compressed) {
    for (const f of c.files || []) files.add(f);
    if (c.type && c.type !== "conversation" && c.title) tools.add(c.title);
  }

  const assistantTexts: string[] = [];
  const userPrompts: string[] = [];
  for (const r of rawObs) {
    if (typeof r.assistantResponse === "string" && r.assistantResponse.trim()) {
      assistantTexts.push(r.assistantResponse);
    }
    if (typeof r.userPrompt === "string" && r.userPrompt.trim()) {
      userPrompts.push(r.userPrompt);
    }
  }

  const lessonMatches = new Map<string, string>();
  for (const text of assistantTexts.concat(userPrompts).slice(0, 200)) {
    for (const pat of LESSON_PATTERNS) {
      pat.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null && lessonMatches.size < 40) {
        const snippet = m[0].replace(/\s+/g, " ").trim();
        if (snippet.length >= 20 && snippet.length <= 220) {
          const key = snippet.toLowerCase();
          if (!lessonMatches.has(key)) lessonMatches.set(key, snippet);
        }
      }
    }
  }

  const lessonEntries = Array.from(lessonMatches.values()).slice(0, 20);
  const lessonIds: string[] = [];
  for (const content of lessonEntries) {
    // Content-addressed ID so re-importing the same JSONL does not
    // duplicate lessons. fingerprintId hashes the normalized content,
    // giving a stable lesson_xxx for identical text.
    const lessonId = fingerprintId("lesson", content.trim().toLowerCase());
    try {
      const existing = await kv.get<Lesson>(KV.lessons, lessonId);
      if (existing) {
        const existingSources = existing.sourceIds || [];
        const mergedSources = existingSources.includes(sessionId)
          ? existingSources
          : [...existingSources, sessionId];
        const existingTags = existing.tags || [];
        const mergedTags = existingTags.includes("auto-import")
          ? existingTags
          : [...existingTags, "auto-import"];
        const merged: Lesson = {
          ...existing,
          sourceIds: mergedSources,
          tags: mergedTags,
          reinforcements: (existing.reinforcements || 0) + 1,
          updatedAt: createdAt,
          lastReinforcedAt: createdAt,
        };
        await kv.set(KV.lessons, lessonId, merged);
      } else {
        const lesson: Lesson = {
          id: lessonId,
          content,
          context: firstPrompt || project,
          confidence: 0.4,
          reinforcements: 0,
          source: "consolidation",
          sourceIds: [sessionId],
          project,
          tags: ["auto-import"],
          createdAt,
          updatedAt: createdAt,
          decayRate: 0.05,
        };
        await kv.set(KV.lessons, lessonId, lesson);
      }
      lessonIds.push(lessonId);
    } catch {}
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

export function registerReplayFunctions(sdk: ISdk, kv: StateKV): void {
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
    "mem::replay::import-jsonl",
    async (
      data: { path?: string; maxFiles?: number } = {},
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
            ? firstPromptObs.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
            : undefined;

          const existing = await kv.get<Session>(KV.sessions, targetSessionId);
          let pendingNewSession: Session | null = null;
          if (existing) {
            if (parsed.endedAt > (existing.endedAt || "")) {
              existing.endedAt = parsed.endedAt;
            }
            if (existing.status === "active") existing.status = "completed";
            const existingTags = existing.tags || [];
            if (!existingTags.includes("jsonl-import")) {
              existing.tags = [...existingTags, "jsonl-import"];
            }
            if (!existing.firstPrompt && firstPrompt) {
              existing.firstPrompt = firstPrompt;
            }
            // #775: re-key on targetSessionId, not existing.id. Older
            // session rows may be missing the `id` field; existing.id
            // would then be undefined, JSON.stringify would drop the
            // `key` from the state::set payload, and the engine would
            // reject the call with `missing field \`key\``.
            if (!existing.id) existing.id = targetSessionId;
            await kv.set(KV.sessions, targetSessionId, existing);
          } else if (
            batchTopLevelSessionIds.has(targetSessionId) &&
            group.lineage !== "child" &&
            group.lineage !== "sidechain"
          ) {
            pendingNewSession = {
              id: targetSessionId,
              project: parsed.project,
              cwd: parsed.cwd,
              startedAt: parsed.startedAt,
              endedAt: parsed.endedAt,
              status: "completed",
              observationCount: 0,
              tags: ["jsonl-import"],
              firstPrompt,
            };
          }

          const searchIndex = getSearchIndex();
          const newRawObservations: RawObservation[] = [];
          const newCompressedObservations: CompressedObservation[] = [];
          for (const obs of observations) {
            const existingObservation = await kv.get<ReplayStoredObservation>(
              KV.observations(targetSessionId),
              obs.id,
            );
            if (existingObservation) {
              skippedDuplicate += 1;
              continue;
            }

            const synthetic = buildSyntheticCompression(obs);
            const storedObservation: ReplayStoredObservation = {
              ...synthetic,
              hookType: obs.hookType,
              userPrompt: obs.userPrompt,
              assistantResponse: obs.assistantResponse,
              toolName: obs.toolName,
              toolInput: obs.toolInput,
              toolOutput: obs.toolOutput,
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
            await kv.set(
              KV.observations(targetSessionId),
              obs.id,
              storedObservation,
            );
            searchIndex.add(synthetic);
            newRawObservations.push(obs);
            newCompressedObservations.push(synthetic);
            created += 1;
          }

          const storedObservations = await kv.list<ReplayStoredObservation>(
            KV.observations(targetSessionId),
          );
          const sessionRow = await kv.get<Session>(KV.sessions, targetSessionId);
          if (sessionRow) {
            await kv.set(KV.sessions, targetSessionId, {
              ...sessionRow,
              observationCount: storedObservations.length,
            });
          } else if (pendingNewSession) {
            await kv.set(KV.sessions, targetSessionId, {
              ...pendingNewSession,
              observationCount: storedObservations.length,
            });
          }

          sessionIds.add(targetSessionId);

          if (newRawObservations.length > 0) {
            await deriveCrystalAndLessons(
              kv,
              targetSessionId,
              parsed.project,
              newRawObservations,
              newCompressedObservations,
              firstPrompt,
            );
          }
        }
      }

      const returnedSessionIds = Array.from(sessionIds);
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
        discovered,
        truncated,
        traversalCapped,
        maxFiles,
        maxFilesUpperBound: MAX_FILES_UPPER_BOUND,
      };
    },
  );
}
