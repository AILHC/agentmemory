import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
  MemoryProviderCallOptions,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
  SEMANTIC_MERGE_OUTPUT_CONTRACT,
} from "../prompts/consolidation.js";
import {
  resolveOutputLanguage,
  withOutputLanguagePolicy,
} from "../prompts/output-language.js";
import {
  parseFactResponse,
  type ParsedSemanticFact,
} from "../prompts/facts.js";
import { recordAudit } from "./audit.js";
import {
  getConsolidationDecayDays,
  isConsolidationEnabled,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";
import { logger } from "../logger.js";
import {
  callProviderWithTelemetry,
  isProviderPreflightError,
  providerPreflightStatus,
  sortProviderCallTelemetry,
  type ProviderCallTelemetry,
} from "../providers/provider-call-result.js";

export interface ConsolidationProceduralWindow {
  windowId: string;
  memoryIds: string[];
  patternCount: number;
}

export interface ConsolidationProceduralWindowOptions {
  kv: StateKV;
  provider: MemoryProvider;
  memoryIds?: string[];
  project?: string;
  maxItemsPerWindow?: number;
  model?: string;
}

function hasChinese(input: string): boolean {
  return /[\u4e00-\u9fff]/.test(input);
}

function collectLanguageViolations(facts: ParsedSemanticFact[]): string[] {
  return facts.filter((entry) => !hasChinese(entry.fact)).map((entry) => entry.fact);
}

function buildSemanticRetryContractPrompt(): string {
  return [
    SEMANTIC_MERGE_OUTPUT_CONTRACT.semantic?.[0] ?? "每个 <fact> 内容必须使用简体中文。",
    "若仍有非中文 fact，先保留语义与关键技术名词，再补充可读中文句子；保持 XML 与属性不变。",
  ].join("\n");
}

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
    }
  }
}

function eligibleProceduralPatterns(memories: Memory[], project?: string): Memory[] {
  return memories
    .filter((m) => m.isLatest && m.type === "pattern")
    .filter((m) => !project || !m.project || m.project === project)
    .filter((m) => (m.sessionIds.length || 1) >= 2);
}

export async function planConsolidationProceduralWindows(options: {
  kv: StateKV;
  project?: string;
  maxItemsPerWindow?: number;
}): Promise<{ success: boolean; windows: ConsolidationProceduralWindow[]; totalPatterns: number; reason?: string }> {
  const memories = await options.kv.list<Memory>(KV.memories);
  const patterns = eligibleProceduralPatterns(memories, options.project);
  if (patterns.length < 2) {
    return {
      success: true,
      windows: [],
      totalPatterns: patterns.length,
      reason: "fewer than 2 recurring patterns",
    };
  }

  const chunkSize = Math.max(2, options.maxItemsPerWindow ?? patterns.length);
  const windows: ConsolidationProceduralWindow[] = [];
  for (let i = 0; i < patterns.length; i += chunkSize) {
    const chunk = patterns.slice(i, i + chunkSize);
    if (chunk.length < 2) continue;
    windows.push({
      windowId: `procedural:${windows.length + 1}`,
      memoryIds: chunk.map((memory) => memory.id),
      patternCount: chunk.length,
    });
  }

  return { success: true, windows, totalPatterns: patterns.length };
}

async function extractProceduralMemories(
  kv: StateKV,
  provider: MemoryProvider,
  patterns: Array<{ content: string; frequency: number }>,
  callOptions?: MemoryProviderCallOptions,
  telemetry: ProviderCallTelemetry[] = [],
  callIndex = 0,
): Promise<{
  newProcedures: number;
  patternsAnalyzed: number;
  proceduralMemoryIds: string[];
  telemetry: ProviderCallTelemetry[];
}> {
  const prompt = buildProceduralExtractionPrompt(patterns);
  const response = await callProviderWithTelemetry({
    provider,
    operation: "summarize",
    callRole: "window",
    callIndex,
    systemPrompt: withOutputLanguagePolicy(PROCEDURAL_EXTRACTION_SYSTEM),
    userPrompt: prompt,
    callOptions,
    telemetry,
  });

  const procRegex =
    /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
  let match;
  let newProcs = 0;
  const now = new Date().toISOString();
  const existingProcs = await kv.list<ProceduralMemory>(KV.procedural);
  const proceduralMemoryIds: string[] = [];

  while ((match = procRegex.exec(response)) !== null) {
    const name = match[1];
    const trigger = match[2];
    const stepsBlock = match[3];
    const steps: string[] = [];

    const stepRegex = /<step>([^<]+)<\/step>/g;
    let stepMatch;
    while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
      steps.push(stepMatch[1].trim());
    }

    const existing = existingProcs.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      existing.frequency++;
      existing.updatedAt = now;
      existing.strength = Math.min(1, existing.strength + 0.1);
      await kv.set(KV.procedural, existing.id, existing);
      if (!proceduralMemoryIds.includes(existing.id)) proceduralMemoryIds.push(existing.id);
    } else {
      const proc: ProceduralMemory = {
        id: generateId("proc"),
        name,
        steps,
        triggerCondition: trigger,
        frequency: 1,
        sourceSessionIds: [],
        strength: 0.5,
        createdAt: now,
        updatedAt: now,
      };
      await kv.set(KV.procedural, proc.id, proc);
      proceduralMemoryIds.push(proc.id);
      newProcs++;
    }
  }

  return {
    newProcedures: newProcs,
    patternsAnalyzed: patterns.length,
    proceduralMemoryIds,
    telemetry: sortProviderCallTelemetry(telemetry),
  };
}

export async function runConsolidationProceduralWindow(
  options: ConsolidationProceduralWindowOptions,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const telemetry: ProviderCallTelemetry[] = [];
  const stageMetadata = resolveStageModelMetadata("procedural", options.provider, options.model);
  const responseMetadata = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    ...stageMetadata,
    durationMs: Date.now() - startMs,
    telemetry: sortProviderCallTelemetry(telemetry),
    ...extra,
  });
  try {
    resolveOutputLanguage();
    if (!options.provider?.summarize) {
      return { success: false, error: "provider.summarize is required", ...responseMetadata("failed") };
    }
    const allMemories = await options.kv.list<Memory>(KV.memories);
    const selectedIds = new Set(options.memoryIds ?? []);
    const sourceMemories = selectedIds.size > 0
      ? allMemories.filter((memory) => selectedIds.has(memory.id))
      : allMemories;
    const eligible = eligibleProceduralPatterns(sourceMemories, options.project);
    const maxItems = options.maxItemsPerWindow ?? eligible.length;
    const patterns = eligible
      .slice(0, maxItems)
      .map((m) => ({
        content: m.content,
        frequency: m.sessionIds.length || 1,
      }));

    if (patterns.length < 2) {
      return {
        success: true,
        skipped: true,
        reason: "fewer than 2 recurring patterns",
        patternsAnalyzed: patterns.length,
        ...responseMetadata("skipped", { parseFailures: 0 }),
      };
    }

    const promptChars = buildProceduralExtractionPrompt(patterns).length;
    const result = await extractProceduralMemories(
      options.kv,
      options.provider,
      patterns,
      resolveStageModelCallOptions("procedural", options.model),
      telemetry,
      0,
    );
    return {
      success: true,
      ...result,
      ...responseMetadata("succeeded", {
        promptChars,
        parseFailures: result.proceduralMemoryIds.length > 0 ? 0 : 1,
      }),
    };
  } catch (err) {
    if (isProviderPreflightError(err)) {
      const status = providerPreflightStatus(err);
      return { success: false, error: status, ...responseMetadata(status) };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Full procedural extraction failed", { error: msg });
    return { success: false, error: msg, ...responseMetadata("failed") };
  }
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::full-consolidation-procedural-windows-plan",
    async (data: { project?: string; maxItemsPerWindow?: number }) =>
      planConsolidationProceduralWindows({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-consolidation-procedural-window",
    async (data: {
      project?: string;
      memoryIds?: string[];
      maxItemsPerWindow?: number;
      model?: string;
    }) =>
      runConsolidationProceduralWindow({ kv, provider, ...data }),
  );

  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string; model?: string }) => {
      resolveOutputLanguage();
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};
      const callOptions = resolveStageModelCallOptions(
        "memory_consolidate",
        data?.model,
      );
      const proceduralCallOptions = resolveStageModelCallOptions(
        "procedural",
        data?.model,
      );

      if (tier === "all" || tier === "semantic") {
        const summaries = await kv.list<SessionSummary>(KV.summaries);
        const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 20);

          const prompt = buildSemanticMergePrompt(
            recentSummaries.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              concepts: s.concepts,
            })),
          );
          const semanticTelemetry: ProviderCallTelemetry[] = [];

          try {
            const outputLanguage = resolveOutputLanguage();
            const baseSystem = withOutputLanguagePolicy(
              SEMANTIC_MERGE_SYSTEM,
              undefined,
              SEMANTIC_MERGE_OUTPUT_CONTRACT,
            );
            const parseResponse = (response: string) => {
              const parsed = parseFactResponse(response);
              const languageViolations = outputLanguage === "zh-CN"
                ? collectLanguageViolations(parsed)
                : [];
              return { parsed, languageViolations };
            };

            let parsedResult = parseResponse(
              await callProviderWithTelemetry({
                provider,
                operation: "summarize",
                callRole: "window",
                callIndex: 0,
                systemPrompt: baseSystem,
                userPrompt: prompt,
                callOptions,
                telemetry: semanticTelemetry,
              }),
            );

            if (outputLanguage === "zh-CN" && parsedResult.languageViolations.length > 0) {
              logger.warn("Semantic merge language contract may be violated", {
                violations: parsedResult.languageViolations.length,
              });
              const strictSystem = withOutputLanguagePolicy(
                SEMANTIC_MERGE_SYSTEM,
                undefined,
                {
                  semantic: [
                    ...(SEMANTIC_MERGE_OUTPUT_CONTRACT.semantic ?? []),
                    buildSemanticRetryContractPrompt(),
                  ],
                },
              );
              try {
                parsedResult = parseResponse(
                  await callProviderWithTelemetry({
                    provider,
                    operation: "summarize",
                    callRole: "window",
                    callIndex: 1,
                    systemPrompt: strictSystem,
                    userPrompt: prompt,
                    callOptions,
                    telemetry: semanticTelemetry,
                  }),
                );
              } catch (retryErr) {
                logger.warn("Semantic merge retry failed; keep first extraction", {
                  error: retryErr instanceof Error ? retryErr.message : String(retryErr),
                });
              }
            }

            const facts = parsedResult.parsed;
            const languageViolations = parsedResult.languageViolations;
            let newFacts = 0;
            const now = new Date().toISOString();

            for (const { fact, confidence } of facts) {
              const existing = existingSemantic.find(
                (s) => s.fact.toLowerCase() === fact.toLowerCase(),
              );
              if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = now;
                existing.updatedAt = now;
                existing.confidence = Math.max(existing.confidence, confidence);
                await kv.set(KV.semantic, existing.id, existing);
              } else {
                const sem: SemanticMemory = {
                  id: generateId("sem"),
                  fact,
                  confidence,
                  sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                  sourceMemoryIds: [],
                  accessCount: 1,
                  lastAccessedAt: now,
                  strength: confidence,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.semantic, sem.id, sem);
                newFacts++;
              }
            }

            results.semantic = {
              newFacts,
              totalSummaries: summaries.length,
              ...(languageViolations.length > 0 ? { languageViolations } : {}),
              telemetry: sortProviderCallTelemetry(semanticTelemetry),
            };
            if (languageViolations.length > 0) {
              logger.warn("Semantic merge kept non-Chinese facts after retry", {
                count: languageViolations.length,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Semantic consolidation failed", { error: msg });
            const status = isProviderPreflightError(err) ? providerPreflightStatus(err) : "failed";
            results.semantic = {
              error: msg,
              status,
              telemetry: sortProviderCallTelemetry(semanticTelemetry),
            };
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project: data?.project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = eligibleProceduralPatterns(memories, data?.project).map((m) => ({
          content: m.content,
          frequency: m.sessionIds.length || 1,
        }));

        if (patterns.length >= 2) {
          const proceduralTelemetry: ProviderCallTelemetry[] = [];
          try {
            results.procedural = await extractProceduralMemories(
              kv,
              provider,
              patterns,
              proceduralCallOptions,
              proceduralTelemetry,
              0,
            );
          } catch (err) {
            if (isProviderPreflightError(err)) {
              const status = providerPreflightStatus(err);
              return {
                success: false,
                error: status,
                status,
                telemetry: sortProviderCallTelemetry(proceduralTelemetry),
              };
            }
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = {
              error: msg,
              telemetry: sortProviderCallTelemetry(proceduralTelemetry),
            };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        applyDecay(semantic, decayDays);
        for (const s of semantic) {
          await kv.set(KV.semantic, s.id, s);
        }

        const procedural = await kv.list<ProceduralMemory>(KV.procedural);
        applyDecay(procedural, decayDays);
        for (const p of procedural) {
          await kv.set(KV.procedural, p.id, p);
        }

        results.decay = {
          semantic: semantic.length,
          procedural: procedural.length,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
    },
  );
}
