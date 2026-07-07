import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  CompressedObservation,
  Memory,
  Session,
  MemoryProvider,
  MemoryProviderCallOptions,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import {
  resolveOutputLanguage,
  withOutputLanguagePolicy,
} from "../prompts/output-language.js";

const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Given a set of related observations from coding sessions, synthesize them into a single long-term memory.

Output XML:
<memory>
  <type>pattern|preference|architecture|bug|workflow|fact</type>
  <title>Concise memory title (max 80 chars)</title>
  <content>2-4 sentence description of the learned insight</content>
  <concepts>
    <concept>key term</concept>
  </concepts>
  <files>
    <file>relevant/file/path</file>
  </files>
  <strength>1-10 how confident/important this memory is</strength>
</memory>`;

import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { logger } from "../logger.js";
import {
  getMemoryConsolidateCompressTimeoutMs,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";

export interface ConsolidateObservationWindow {
  windowId: string;
  concept: string;
  observationIds: string[];
  sourceObservationIds: string[];
  sessionIds: string[];
  sourceSessionIds: string[];
  observationCount: number;
  estimatedChars: number;
  observationEstimatedChars?: Record<string, number>;
  charBudget?: number;
  budgetApplied?: boolean;
  overBudget?: boolean;
  overBudgetReason?: "single_observation";
  inputHash: string;
}

export interface ConsolidateObservationWindowOptions {
  kv: StateKV;
  provider: MemoryProvider;
  project?: string;
  concept?: string;
  observationIds?: string[];
  minObservations?: number;
  minImportance?: number;
  minObservationsPerConcept?: number;
  maxObservationsPerWindow?: number;
  charBudget?: number;
  model?: string;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modelOptionsFromMemoryConsolidate(model?: string): MemoryProviderCallOptions | undefined {
  return resolveStageModelCallOptions("memory_consolidate", model);
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

function parseMemoryXml(
  xml: string,
  sessionIds: string[],
): Omit<Memory, "id" | "createdAt" | "updatedAt"> | null {
  const type = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  const content = getXmlTag(xml, "content");
  if (!type || !title || !content) return null;

  const validTypes = new Set([
    "pattern",
    "preference",
    "architecture",
    "bug",
    "workflow",
    "fact",
  ]);

  return {
    type: (validTypes.has(type) ? type : "fact") as Memory["type"],
    title,
    content,
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    sessionIds,
    strength: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "strength") || "5", 10) || 5),
    ),
    version: 1,
    isLatest: true,
  };
}

async function collectConsolidationObservations(
  kv: StateKV,
  project?: string,
  minImportance = 5,
): Promise<Array<CompressedObservation & { sid: string }>> {
  const sessions = await kv.list<Session>(KV.sessions);
  const scopedProject =
    typeof project === "string" && project.trim().length > 0
      ? project.trim()
      : undefined;
  const filtered = scopedProject
    ? sessions.filter((s) => s.project === scopedProject)
    : sessions;

  const obsPerSession = await Promise.all(
    filtered.map((s) =>
      kv
        .list<CompressedObservation>(KV.observations(s.id))
        .catch(() => [] as CompressedObservation[]),
    ),
  );

  const allObs: Array<CompressedObservation & { sid: string }> = [];
  for (let i = 0; i < filtered.length; i++) {
    for (const obs of obsPerSession[i]) {
      if (obs.title && obs.importance >= minImportance) {
        allObs.push({ ...obs, sid: filtered[i].id });
      }
    }
  }
  return allObs;
}

function groupObservationsByConcept(
  allObs: Array<CompressedObservation & { sid: string }>,
  minGroupSize: number,
): Map<string, Array<CompressedObservation & { sid: string }>> {
  const conceptGroups = new Map<string, Array<CompressedObservation & { sid: string }>>();
  for (const obs of allObs) {
    for (const concept of obs.concepts) {
      const key = concept.toLowerCase();
      if (!conceptGroups.has(key)) conceptGroups.set(key, []);
      conceptGroups.get(key)!.push(obs);
    }
  }
  return new Map(
    [...conceptGroups.entries()]
      .filter(([, group]) => group.length >= minGroupSize)
      .sort((a, b) => b[1].length - a[1].length),
  );
}

function estimateObservationChars(obs: CompressedObservation): number {
  return obs.title.length + obs.narrative.length + obs.files.join(", ").length + 32;
}

function windowChunksByBudget<T extends CompressedObservation>(
  observations: T[],
  maxObservationsPerWindow: number,
  charBudget?: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  const maxCount = Math.max(1, maxObservationsPerWindow);

  for (const obs of observations) {
    const obsChars = estimateObservationChars(obs);
    const wouldExceedCount = current.length >= maxCount;
    const wouldExceedBudget =
      charBudget !== undefined && current.length > 0 && currentChars + obsChars > charBudget;
    if (wouldExceedCount || wouldExceedBudget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(obs);
    currentChars += obsChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function consolidateWindowFromChunk(
  concept: string,
  chunk: Array<CompressedObservation & { sid: string }>,
  index: number,
  charBudget?: number,
  windowKey = concept,
): ConsolidateObservationWindow {
  const observationIds = chunk.map((o) => o.id);
  const sessionIds = [...new Set(chunk.map((o) => o.sid))];
  const observationEstimatedChars = Object.fromEntries(chunk.map((o) => [o.id, estimateObservationChars(o)]));
  const estimatedChars = Object.values(observationEstimatedChars).reduce((sum, chars) => sum + chars, 0);
  const budgetApplied = charBudget !== undefined;
  const overBudget = budgetApplied && estimatedChars > charBudget;
  return {
    windowId: `memory-consolidate:${windowKey}:${index + 1}`,
    concept,
    observationIds,
    sourceObservationIds: observationIds,
    sessionIds,
    sourceSessionIds: sessionIds,
    observationCount: chunk.length,
    estimatedChars,
    observationEstimatedChars,
    ...(budgetApplied ? { charBudget, budgetApplied } : {}),
    ...(overBudget && chunk.length === 1
      ? { overBudget: true, overBudgetReason: "single_observation" as const }
      : {}),
    inputHash: stableHash(["memory-consolidate", concept, observationIds, sessionIds, estimatedChars]),
  };
}

export async function planConsolidateObservationWindows(options: {
  kv: StateKV;
  project?: string;
  minObservations?: number;
  minImportance?: number;
  minObservationsPerConcept?: number;
  maxObservationsPerWindow?: number;
  charBudget?: number;
}): Promise<{
  success: boolean;
  totalObservations: number;
  windows: ConsolidateObservationWindow[];
  reason?: string;
  charBudget?: number;
  budgetApplied: boolean;
  maxWindowEstimatedChars: number;
  overBudgetWindowCount: number;
}> {
  const minObs = options.minObservationsPerConcept ?? options.minObservations ?? 10;
  const minImportance = options.minImportance ?? 5;
  const charBudget = options.charBudget !== undefined ? Math.max(1, options.charBudget) : undefined;
  const budgetApplied = charBudget !== undefined;
  const allObs = await collectConsolidationObservations(options.kv, options.project, minImportance);
  if (allObs.length < minObs) {
    return {
      success: true,
      totalObservations: allObs.length,
      windows: [],
      reason: "insufficient_observations",
      ...(budgetApplied ? { charBudget } : {}),
      budgetApplied,
      maxWindowEstimatedChars: 0,
      overBudgetWindowCount: 0,
    };
  }

  const groups = groupObservationsByConcept(allObs, minObs);
  const windows: ConsolidateObservationWindow[] = [];
  const coveredObservationIds = new Set<string>();
  for (const [concept, obsGroup] of groups.entries()) {
    const sorted = [...obsGroup]
      .sort((a, b) => b.importance - a.importance)
      .filter((obs) => !coveredObservationIds.has(obs.id));
    const chunkSize = Math.max(1, options.maxObservationsPerWindow ?? sorted.length);
    const chunks = windowChunksByBudget(sorted, chunkSize, charBudget);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.length === 0) continue;
      for (const obs of chunk) coveredObservationIds.add(obs.id);
      windows.push(consolidateWindowFromChunk(concept, chunk, i, charBudget));
    }
  }
  const remaining = allObs
    .filter((obs) => !coveredObservationIds.has(obs.id))
    .sort((a, b) => b.importance - a.importance);
  if (remaining.length > 0) {
    const chunkSize = Math.max(1, options.maxObservationsPerWindow ?? remaining.length);
    const chunks = windowChunksByBudget(remaining, chunkSize, charBudget);
    for (let i = 0; i < chunks.length; i++) {
      windows.push(consolidateWindowFromChunk("remaining-observations", chunks[i], i, charBudget, "remaining"));
    }
  }
  const maxWindowEstimatedChars = windows.reduce(
    (max, window) => Math.max(max, window.estimatedChars),
    0,
  );
  const overBudgetWindowCount = budgetApplied
    ? windows.filter((window) => charBudget !== undefined && window.estimatedChars > charBudget).length
    : 0;
  return {
    success: true,
    totalObservations: allObs.length,
    windows,
    ...(budgetApplied ? { charBudget } : {}),
    budgetApplied,
    maxWindowEstimatedChars,
    overBudgetWindowCount,
  };
}

async function persistConsolidatedMemory(
  kv: StateKV,
  parsed: Omit<Memory, "id" | "createdAt" | "updatedAt">,
  existingMemories: Memory[],
  concept: string,
  obsIds: string[],
  scopedProject?: string,
): Promise<{ action: "created" | "evolved"; memoryId: string; parentId?: string }> {
  const existingMatch = existingMemories.find(
    (m) =>
      m.title.toLowerCase() === parsed.title.toLowerCase() &&
      (!scopedProject || !m.project || m.project === scopedProject),
  );
  const now = new Date().toISOString();

  if (existingMatch) {
    existingMatch.isLatest = false;
    await kv.set(KV.memories, existingMatch.id, existingMatch);
    await recordAudit(kv, "evolve", "mem::consolidate", [existingMatch.id], {
      action: "mark_non_latest",
      concept,
    });

    const evolved: Memory = {
      id: generateId("mem"),
      createdAt: now,
      updatedAt: now,
      ...parsed,
      version: (existingMatch.version || 1) + 1,
      parentId: existingMatch.id,
      supersedes: [existingMatch.id, ...(existingMatch.supersedes || [])],
      sourceObservationIds: obsIds,
      isLatest: true,
      ...(scopedProject !== undefined && { project: scopedProject }),
    };
    await kv.set(KV.memories, evolved.id, evolved);
    await recordAudit(kv, "evolve", "mem::consolidate", [evolved.id], {
      action: "evolve_memory",
      oldId: existingMatch.id,
      newId: evolved.id,
      concept,
    });
    return { action: "evolved", memoryId: evolved.id, parentId: existingMatch.id };
  }

  const memory: Memory = {
    id: generateId("mem"),
    createdAt: now,
    updatedAt: now,
    ...parsed,
    sourceObservationIds: obsIds,
    version: 1,
    isLatest: true,
    ...(scopedProject !== undefined && { project: scopedProject }),
  };
  await kv.set(KV.memories, memory.id, memory);
  await recordAudit(kv, "remember", "mem::consolidate", [memory.id], {
    action: "create_memory",
    concept,
  });
  return { action: "created", memoryId: memory.id };
}

export async function runConsolidateObservationWindow(
  options: ConsolidateObservationWindowOptions,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const stageMetadata = resolveStageModelMetadata("memory_consolidate", options.provider, options.model);
  const responseMetadata = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    ...stageMetadata,
    durationMs: Date.now() - startMs,
    ...extra,
  });
  try {
    resolveOutputLanguage();
    if (!options.provider?.compress) {
      return { success: false, error: "provider.compress is required", ...responseMetadata("failed") };
    }

    const hasExplicitObservationIds = (options.observationIds?.length ?? 0) > 0;
    const minObs = options.minObservations ?? (hasExplicitObservationIds ? 1 : 3);
    const scopedProject =
      typeof options.project === "string" && options.project.trim().length > 0
        ? options.project.trim()
        : undefined;
    const allObs = await collectConsolidationObservations(options.kv, scopedProject, options.minImportance ?? 5);
    const selectedIds = new Set(options.observationIds ?? []);
    let obsGroup = selectedIds.size > 0
      ? allObs.filter((obs) => selectedIds.has(obs.id))
      : [];

    const concept = options.concept?.trim().toLowerCase();
    if (obsGroup.length === 0 && concept) {
      const groups = groupObservationsByConcept(allObs, minObs);
      obsGroup = groups.get(concept) ?? [];
    }

    if (obsGroup.length < minObs) {
      return {
        success: true,
        consolidated: 0,
        reason: "insufficient_observations",
        totalObservations: obsGroup.length,
        ...responseMetadata("skipped"),
      };
    }

    const sorted = [...obsGroup].sort((a, b) => b.importance - a.importance);
    const sessionIds = [...new Set(sorted.map((o) => o.sid))];
    const prompt = sorted
      .map(
        (o) =>
          `[${o.type}] ${o.title}\n${o.narrative}\nFiles: ${o.files.join(", ")}\nImportance: ${o.importance}`,
      )
      .join("\n\n");
    if (options.charBudget !== undefined && prompt.length > options.charBudget) {
      return {
        success: false,
        error: "input_too_large",
        promptChars: prompt.length,
        charBudget: options.charBudget,
        ...responseMetadata("failed", {
          promptChars: prompt.length,
          charBudget: options.charBudget,
          parseFailures: 0,
        }),
      };
    }
    const callOptions = modelOptionsFromMemoryConsolidate(options.model);
    const timeoutMs = getMemoryConsolidateCompressTimeoutMs();
    const response = await Promise.race([
      compressWithOptions(
        options.provider,
        withOutputLanguagePolicy(CONSOLIDATION_SYSTEM),
        `Concept: "${concept ?? "observation-window"}"\n\nObservations:\n${prompt}`,
        callOptions,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`compress timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const parsed = parseMemoryXml(response, sessionIds);
    if (!parsed) {
      return {
        success: false,
        error: "failed to parse memory XML",
        totalObservations: sorted.length,
        ...responseMetadata("failed", {
          promptChars: prompt.length,
          charBudget: options.charBudget,
          parseFailures: 1,
        }),
      };
    }

    const existingMemories = await options.kv.list<Memory>(KV.memories);
    const persisted = await persistConsolidatedMemory(
      options.kv,
      parsed,
      existingMemories,
      concept ?? "observation-window",
      [...new Set(sorted.map((o) => o.id))],
      scopedProject,
    );
    return {
      success: true,
      consolidated: 1,
      totalObservations: sorted.length,
      memoryIds: [persisted.memoryId],
      ...persisted,
      ...responseMetadata("succeeded", {
        promptChars: prompt.length,
        charBudget: options.charBudget,
        parseFailures: 0,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Full consolidation window failed", { error: msg });
    return { success: false, error: msg, ...responseMetadata("failed") };
  }
}

export function registerConsolidateFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::full-memory-consolidate-windows-plan",
    async (data: {
      project?: string;
      minImportance?: number;
      minObservationsPerConcept?: number;
      maxObservationsPerWindow?: number;
      charBudget?: number;
    }) => planConsolidateObservationWindows({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-memory-consolidate-window",
    async (data: {
      project?: string;
      concept?: string;
      observationIds?: string[];
      minObservations?: number;
      charBudget?: number;
      model?: string;
    }) => runConsolidateObservationWindow({ kv, provider, ...data }),
  );

  sdk.registerFunction("mem::consolidate", 
    async (data: { project?: string; minObservations?: number; model?: string }) => {
      resolveOutputLanguage();
      const minObs = data.minObservations ?? 10;

      const allObs = await collectConsolidationObservations(kv, data.project);

      if (allObs.length < minObs) {
        return { consolidated: 0, reason: "insufficient_observations" };
      }

      const conceptGroups = groupObservationsByConcept(allObs, 3);

      let consolidated = 0;
      const existingMemories = await kv.list<Memory>(KV.memories);
      const MAX_LLM_CALLS = 10;
      let llmCallCount = 0;
      const callOptions = modelOptionsFromMemoryConsolidate(data.model);

      const sortedGroups = [...conceptGroups.entries()]
        .filter(([, g]) => g.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

      for (const [concept, obsGroup] of sortedGroups) {
        if (llmCallCount >= MAX_LLM_CALLS) break;

        const top = obsGroup
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 8);
        const sessionIds = [...new Set(top.map((o) => o.sid))];

        const prompt = top
          .map(
            (o) =>
              `[${o.type}] ${o.title}\n${o.narrative}\nFiles: ${o.files.join(", ")}\nImportance: ${o.importance}`,
          )
          .join("\n\n");

        try {
          const response = await Promise.race([
            compressWithOptions(
              provider,
              withOutputLanguagePolicy(CONSOLIDATION_SYSTEM),
              `Concept: "${concept}"\n\nObservations:\n${prompt}`,
              callOptions,
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`compress timeout after ${getMemoryConsolidateCompressTimeoutMs()}ms`)),
                getMemoryConsolidateCompressTimeoutMs(),
              ),
            ),
          ]);
          llmCallCount++;
          const parsed = parseMemoryXml(response, sessionIds);
          if (!parsed) continue;

          const obsIds = [...new Set(top.map((o) => o.id))];
          const scopedProject =
            typeof data.project === "string" && data.project.trim().length > 0
              ? data.project.trim()
              : undefined;

          // A scoped consolidation run must only evolve memories that belong
          // to the same project. Without this guard, two projects that happen
          // to consolidate observations into an identically-titled memory would
          // cause one project's memory to silently evolve the other's — the
          // exact class of cross-project corruption this fix is designed to
          // prevent. An unscoped run (no data.project, background cron path)
          // preserves the pre-existing behavior and may evolve any memory.
          await persistConsolidatedMemory(
            kv,
            parsed,
            existingMemories,
            concept,
            obsIds,
            scopedProject,
          );
          consolidated++;
        } catch (err) {
          logger.warn("Consolidation failed for concept", {
            concept,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("Consolidation complete", {
        consolidated,
        totalObs: allObs.length,
      });
      return { consolidated, totalObservations: allObs.length };
    },
  );
}
