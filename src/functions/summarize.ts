import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
  MemoryProviderCallOptions,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  REDUCE_SYSTEM,
  buildReducePrompt,
  SUMMARY_OUTPUT_CONTRACT,
} from "../prompts/summary.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  getSummarizeRuntimeConfig,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";

// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;

type SummaryLineageInput = {
  lineage?: Session["lineage"];
  parentSessionId?: string;
};

type ResumableSummaryRun = {
  id: string;
  sessionId: string;
  inputHash: string;
  chunkSize: number;
  totalChunks: number;
  completedChunks: number;
  skippedChunks: number;
  status: "in_progress" | "succeeded" | "failed";
  summary?: SessionSummary;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type ResumableSummaryPartial = {
  runId: string;
  chunkIndex: number;
  status: "completed" | "skipped";
  summary?: SessionSummary;
  createdAt: string;
};

type ResumableSummaryResponse = {
  success: boolean;
  status: "in_progress" | "succeeded" | "failed";
  completedChunks: number;
  totalChunks: number;
  skippedChunks: number;
  summary?: SessionSummary;
  error?: string;
};

function summarizeWithOptions(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  callOptions?: MemoryProviderCallOptions,
): Promise<string> {
  return callOptions
    ? provider.summarize(systemPrompt, userPrompt, callOptions)
    : provider.summarize(systemPrompt, userPrompt);
}

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
  lineageContext: SummaryLineageInput,
  callOptions?: MemoryProviderCallOptions,
): Promise<SessionSummary | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await summarizeWithOptions(
        provider,
        withOutputLanguagePolicy(SUMMARY_SYSTEM, undefined, SUMMARY_OUTPUT_CONTRACT),
        buildSummaryPrompt(chunk, lineageContext),
        callOptions,
      );
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) return parsed;
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
      });
    } catch (err) {
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

function startsNewUserTurn(obs: CompressedObservation): boolean {
  const maybeRaw = obs as CompressedObservation & {
    hookType?: unknown;
    userPrompt?: unknown;
  };
  return (
    maybeRaw.hookType === "prompt_submit" ||
    (typeof maybeRaw.userPrompt === "string" && maybeRaw.userPrompt.trim().length > 0)
  );
}

export function buildTurnAwareSummaryChunks(
  compressed: CompressedObservation[],
  chunkSize: number,
): CompressedObservation[][] {
  if (chunkSize <= 0) return [compressed];

  if (!compressed.some(startsNewUserTurn)) {
    const fixedChunks: CompressedObservation[][] = [];
    for (let i = 0; i < compressed.length; i += chunkSize) {
      fixedChunks.push(compressed.slice(i, i + chunkSize));
    }
    return fixedChunks;
  }

  const segments: CompressedObservation[][] = [];
  let currentSegment: CompressedObservation[] = [];
  for (const obs of compressed) {
    if (startsNewUserTurn(obs) && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
    currentSegment.push(obs);
  }
  if (currentSegment.length > 0) segments.push(currentSegment);

  const chunks: CompressedObservation[][] = [];
  let currentChunk: CompressedObservation[] = [];
  const flushCurrentChunk = () => {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  };

  for (const segment of segments) {
    if (segment.length > chunkSize) {
      flushCurrentChunk();
      for (let i = 0; i < segment.length; i += chunkSize) {
        chunks.push(segment.slice(i, i + chunkSize));
      }
      continue;
    }

    if (currentChunk.length > 0 && currentChunk.length + segment.length > chunkSize) {
      flushCurrentChunk();
    }
    currentChunk.push(...segment);
  }
  flushCurrentChunk();

  return chunks;
}

// Returns the final summary XML string. For sessions ≤ chunk size, this is
// a single LLM call (legacy behavior). For larger sessions, observations
// are split into chunks processed in parallel batches, each chunk retried
// once on parse failure, persistently-bad chunks skipped, and remaining
// partials merged via a reduce call.
async function produceSummaryXml(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
  lineageContext: SummaryLineageInput,
  callOptions?: MemoryProviderCallOptions,
): Promise<{
  response: string;
  mode: "single" | "chunked";
  chunks: number;
  skipped?: number;
  promptChars: number;
}> {
  const runtimeConfig = getSummarizeRuntimeConfig();
  const chunkSize = runtimeConfig.chunkSize;
  if (compressed.length <= chunkSize) {
    const userPrompt = buildSummaryPrompt(compressed, lineageContext);
    const response = await summarizeWithOptions(
      provider,
      withOutputLanguagePolicy(SUMMARY_SYSTEM, undefined, SUMMARY_OUTPUT_CONTRACT),
      userPrompt,
      callOptions,
    );
    return { response, mode: "single", chunks: 1, promptChars: userPrompt.length };
  }

  const chunks = buildTurnAwareSummaryChunks(compressed, chunkSize);
  const chunkStartOffsets: number[] = [];
  let nextOffset = 0;
  for (const chunk of chunks) {
    chunkStartOffsets.push(nextOffset);
    nextOffset += chunk.length;
  }
  const concurrency = runtimeConfig.chunkConcurrency;
  logger.info("Summarize chunking session", {
    sessionId,
    chunks: chunks.length,
    chunkSize,
    concurrency,
    totalObservations: compressed.length,
  });

  // Sparse array preserves chunk → index mapping after parallel resolution,
  // so the reduce step sees partials in chronological order even when some
  // were skipped.
  const partialByIdx: Array<SessionSummary | null> = new Array(chunks.length).fill(null);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (chunk, j) => {
        const idx = batchStart + j;
        partialByIdx[idx] = await summarizeChunkWithRetry(
          provider,
          chunk,
          sessionId,
          project,
          idx,
          chunks.length,
          lineageContext,
          callOptions,
        );
      }),
    );
  }

  const skipped = partialByIdx.filter((p) => p === null).length;
  const partials = partialByIdx.filter((p): p is SessionSummary => p !== null);

  if (skipped > Math.floor(chunks.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunks.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunks.length,
    });
  }

  const reduceInput = partials.map((p) => {
    const originalIdx = partialByIdx.indexOf(p);
    return {
      title: p.title,
      narrative: p.narrative,
      keyDecisions: p.keyDecisions,
      filesModified: p.filesModified,
      concepts: p.concepts,
      obsRangeStart: chunkStartOffsets[originalIdx] + 1,
      obsRangeEnd: chunkStartOffsets[originalIdx] + chunks[originalIdx].length,
    };
  });
  const reducePrompt = buildReducePrompt(reduceInput);
  const response = await summarizeWithOptions(
    provider,
    withOutputLanguagePolicy(REDUCE_SYSTEM, undefined, SUMMARY_OUTPUT_CONTRACT),
    reducePrompt,
    callOptions,
  );
  const chunkPromptChars = chunks.reduce(
    (sum, chunk) => sum + buildSummaryPrompt(chunk, lineageContext).length,
    0,
  );
  return {
    response,
    mode: "chunked",
    chunks: chunks.length,
    skipped,
    promptChars: chunkPromptChars + reducePrompt.length,
  };
}

// #783: many LLMs (DeepSeek, GPT variants, some Anthropic responses)
// wrap structured XML in markdown code fences or add conversational
// text before/after. Strip those wrappers before the tag regex so a
// well-formed summary doesn't get silently dropped as parse_failed.
function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function resumableSummaryInputHash(
  session: Session,
  compressed: CompressedObservation[],
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        project: session.project,
        lineage: session.lineage,
        parentSessionId: session.parentSessionId,
        observations: compressed,
      }),
    )
    .digest("hex");
}

function resumableSummaryRunId(
  sessionId: string,
  inputHash: string,
  chunkSize: number,
): string {
  const bindingHash = createHash("sha256")
    .update(stableStringify({ sessionId, inputHash, chunkSize }))
    .digest("hex");
  return `sumr_${bindingHash.slice(0, 24)}`;
}

function resumableResponse(
  status: ResumableSummaryResponse["status"],
  completedChunks: number,
  totalChunks: number,
  skippedChunks: number,
  options: { summary?: SessionSummary; error?: string } = {},
): ResumableSummaryResponse {
  return {
    success: status !== "failed",
    status,
    completedChunks,
    totalChunks,
    skippedChunks,
    ...(status === "succeeded" && options.summary
      ? { summary: options.summary }
      : {}),
    ...(status === "failed" && options.error ? { error: options.error } : {}),
  };
}

function validateFinalSummary(summary: SessionSummary): string | null {
  const validation = validateOutput(
    SummaryOutputSchema,
    {
      title: summary.title,
      narrative: summary.narrative,
      keyDecisions: summary.keyDecisions,
      filesModified: summary.filesModified,
      concepts: summary.concepts,
    },
    "mem::summarize-resumable",
  );
  return validation.valid ? null : "validation_failed";
}

async function persistResumableSummary(
  kv: StateKV,
  run: ResumableSummaryRun,
  summary: SessionSummary,
  completedChunks: number,
  skippedChunks: number,
): Promise<ResumableSummaryResponse> {
  const updatedAt = new Date().toISOString();
  const succeededRun: ResumableSummaryRun = {
    ...run,
    status: "succeeded",
    completedChunks,
    skippedChunks,
    summary,
    lastError: undefined,
    updatedAt,
  };
  await kv.set(KV.summaryResumableRuns, run.id, succeededRun);
  await kv.set(KV.summaries, run.sessionId, summary);
  await safeAudit(kv, "compress", "mem::summarize-resumable", [run.sessionId], {
    title: summary.title,
    observationCount: summary.observationCount,
    resumableRunId: run.id,
  });
  return resumableResponse(
    "succeeded",
    completedChunks,
    run.totalChunks,
    skippedChunks,
    { summary },
  );
}

async function runResumableSummaryStep(
  data: { sessionId: string; model?: string } | undefined,
  kv: StateKV,
  provider: MemoryProvider,
): Promise<ResumableSummaryResponse> {
  if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
    return resumableResponse("failed", 0, 0, 0, {
      error: "sessionId is required",
    });
  }
  const sessionId = data.sessionId.trim();

  return withKeyedLock(`summarize-resumable:${sessionId}`, async () => {
    let completedChunks = 0;
    let totalChunks = 0;
    let skippedChunks = 0;

    try {
      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        return resumableResponse("failed", 0, 0, 0, {
          error: "session_not_found",
        });
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((observation) => observation.title);
      if (compressed.length === 0) {
        return resumableResponse("failed", 0, 0, 0, {
          error: "no_observations",
        });
      }

      const chunkSize = getSummarizeRuntimeConfig().chunkSize;
      const chunks = buildTurnAwareSummaryChunks(compressed, chunkSize);
      totalChunks = chunks.length;
      const inputHash = resumableSummaryInputHash(session, compressed);
      const runId = resumableSummaryRunId(sessionId, inputHash, chunkSize);
      const now = new Date().toISOString();
      let run = await kv.get<ResumableSummaryRun>(KV.summaryResumableRuns, runId);

      if (
        run &&
        (run.sessionId !== sessionId ||
          run.inputHash !== inputHash ||
          run.chunkSize !== chunkSize ||
          run.totalChunks !== totalChunks)
      ) {
        return resumableResponse("failed", 0, totalChunks, 0, {
          error: "run_binding_mismatch",
        });
      }

      if (!run) {
        run = {
          id: runId,
          sessionId,
          inputHash,
          chunkSize,
          totalChunks,
          completedChunks: 0,
          skippedChunks: 0,
          status: "in_progress",
          createdAt: now,
          updatedAt: now,
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      }

      completedChunks = run.completedChunks;
      skippedChunks = run.skippedChunks;

      if (run.status === "succeeded") {
        if (!run.summary) {
          return resumableResponse(
            "failed",
            completedChunks,
            totalChunks,
            skippedChunks,
            { error: "completed_summary_missing" },
          );
        }
        await kv.set(KV.summaries, sessionId, run.summary);
        return resumableResponse(
          "succeeded",
          completedChunks,
          totalChunks,
          skippedChunks,
          { summary: run.summary },
        );
      }

      if (run.status === "failed") {
        return resumableResponse(
          "failed",
          completedChunks,
          totalChunks,
          skippedChunks,
          { error: run.lastError ?? "summary_run_failed" },
        );
      }

      if (provider.name === "noop") {
        return resumableResponse(
          "failed",
          completedChunks,
          totalChunks,
          skippedChunks,
          { error: "no_provider" },
        );
      }

      const partials = await kv.list<ResumableSummaryPartial>(
        KV.summaryResumablePartials(runId),
      );
      const partialByIndex = new Map(
        partials
          .filter(
            (partial) =>
              partial.runId === runId &&
              Number.isInteger(partial.chunkIndex) &&
              partial.chunkIndex >= 0 &&
              partial.chunkIndex < totalChunks,
          )
          .map((partial) => [partial.chunkIndex, partial]),
      );
      completedChunks = Array.from(partialByIndex.values()).filter(
        (partial) => partial.status === "completed" && partial.summary,
      ).length;
      skippedChunks = Array.from(partialByIndex.values()).filter(
        (partial) => partial.status === "skipped",
      ).length;

      if (
        completedChunks !== run.completedChunks ||
        skippedChunks !== run.skippedChunks
      ) {
        run = {
          ...run,
          completedChunks,
          skippedChunks,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      }

      const nextChunkIndex = chunks.findIndex(
        (_chunk, index) => !partialByIndex.has(index),
      );
      if (nextChunkIndex >= 0) {
        const callOptions = resolveStageModelCallOptions("summary", data.model);
        const summary = await summarizeChunkWithRetry(
          provider,
          chunks[nextChunkIndex],
          sessionId,
          session.project,
          nextChunkIndex,
          totalChunks,
          {
            lineage: session.lineage,
            parentSessionId: session.parentSessionId,
          },
          callOptions,
        );
        const partial: ResumableSummaryPartial = {
          runId,
          chunkIndex: nextChunkIndex,
          status: summary ? "completed" : "skipped",
          ...(summary ? { summary } : {}),
          createdAt: new Date().toISOString(),
        };
        await kv.set(
          KV.summaryResumablePartials(runId),
          String(nextChunkIndex),
          partial,
        );
        partialByIndex.set(nextChunkIndex, partial);
        completedChunks += summary ? 1 : 0;
        skippedChunks += summary ? 0 : 1;

        if (skippedChunks > Math.floor(totalChunks * MAX_SKIP_RATIO)) {
          const error = `too_many_chunks_skipped: ${skippedChunks}/${totalChunks} chunks failed to parse after retry`;
          run = {
            ...run,
            status: "failed",
            completedChunks,
            skippedChunks,
            lastError: error,
            updatedAt: new Date().toISOString(),
          };
          await kv.set(KV.summaryResumableRuns, runId, run);
          return resumableResponse(
            "failed",
            completedChunks,
            totalChunks,
            skippedChunks,
            { error },
          );
        }

        if (totalChunks === 1 && summary) {
          const validationError = validateFinalSummary(summary);
          if (validationError) {
            run = {
              ...run,
              status: "failed",
              completedChunks,
              skippedChunks,
              lastError: validationError,
              updatedAt: new Date().toISOString(),
            };
            await kv.set(KV.summaryResumableRuns, runId, run);
            return resumableResponse(
              "failed",
              completedChunks,
              totalChunks,
              skippedChunks,
              { error: validationError },
            );
          }
          return persistResumableSummary(
            kv,
            run,
            summary,
            completedChunks,
            skippedChunks,
          );
        }

        run = {
          ...run,
          completedChunks,
          skippedChunks,
          lastError: undefined,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
        return resumableResponse(
          "in_progress",
          completedChunks,
          totalChunks,
          skippedChunks,
        );
      }

      const chunkStartOffsets: number[] = [];
      let nextOffset = 0;
      for (const chunk of chunks) {
        chunkStartOffsets.push(nextOffset);
        nextOffset += chunk.length;
      }
      const successfulPartials = Array.from(partialByIndex.values())
        .filter(
          (partial): partial is ResumableSummaryPartial & { summary: SessionSummary } =>
            partial.status === "completed" && Boolean(partial.summary),
        )
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const reducePrompt = buildReducePrompt(
        successfulPartials.map((partial) => ({
          title: partial.summary.title,
          narrative: partial.summary.narrative,
          keyDecisions: partial.summary.keyDecisions,
          filesModified: partial.summary.filesModified,
          concepts: partial.summary.concepts,
          obsRangeStart: chunkStartOffsets[partial.chunkIndex] + 1,
          obsRangeEnd:
            chunkStartOffsets[partial.chunkIndex] + chunks[partial.chunkIndex].length,
        })),
      );

      const persistReduceFailure = async (
        message: string,
      ): Promise<ResumableSummaryResponse> => {
        run = {
          ...run,
          status: "in_progress",
          completedChunks,
          skippedChunks,
          lastError: message,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
        return resumableResponse(
          "failed",
          completedChunks,
          totalChunks,
          skippedChunks,
          { error: message },
        );
      };

      let response: string;
      try {
        response = await summarizeWithOptions(
          provider,
          withOutputLanguagePolicy(
            REDUCE_SYSTEM,
            undefined,
            SUMMARY_OUTPUT_CONTRACT,
          ),
          reducePrompt,
          resolveStageModelCallOptions("summary", data.model),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return persistReduceFailure(message);
      }
      if (!response || !response.trim()) {
        return persistReduceFailure("empty_provider_response");
      }
      const summary = parseSummaryXml(
        response,
        sessionId,
        session.project,
        compressed.length,
      );
      if (!summary) return persistReduceFailure("parse_failed");
      const validationError = validateFinalSummary(summary);
      if (validationError) return persistReduceFailure(validationError);
      return await persistResumableSummary(
        kv,
        run,
        summary,
        completedChunks,
        skippedChunks,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Resumable summarize step failed", {
        sessionId,
        error: message,
      });
      return resumableResponse(
        "failed",
        completedChunks,
        totalChunks,
        skippedChunks,
        { error: message },
      );
    }
  });
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::summarize", 
    async (data: { sessionId: string; model?: string } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      if (provider.name === "noop") {
        logger.info("Summarize skipped — no LLM provider configured", {
          sessionId,
        });
        return {
          success: false,
          error: "no_provider",
          reason:
            "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
        };
      }

      try {
        const callOptions = resolveStageModelCallOptions("summary", data.model);
        const stageMetadata = resolveStageModelMetadata("summary", provider, data.model);
        // #783: chunk-level produceSummaryXml retries internally, but
        // the final merge used to parse once and bail. Wrap the
        // produce-and-parse pair in the same 2-attempt loop so a
        // markdown-wrapped or otherwise wrapped response gets a
        // second roll-of-the-dice instead of dropping the summary.
        let summary: SessionSummary | null = null;
        let response = "";
        let mode = "single";
        let chunks = 1;
        let promptChars = 0;
        let parseFailures = 0;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const produced = await produceSummaryXml(
            provider,
            compressed,
            sessionId,
            session.project,
            {
              lineage: session.lineage,
              parentSessionId: session.parentSessionId,
            },
            callOptions,
          );
          response = produced.response;
          mode = produced.mode;
          chunks = produced.chunks;
          promptChars = produced.promptChars;
          if (!response || !response.trim()) {
            logger.warn("Empty provider response on summarize", {
              sessionId,
              provider: provider.name,
              mode,
              chunks,
              observationCount: compressed.length,
              attempt,
            });
            continue;
          }
          summary = parseSummaryXml(
            response,
            sessionId,
            session.project,
            compressed.length,
          );
          if (summary) break;
          parseFailures++;
          logger.warn("Failed to parse summary XML", { sessionId, attempt });
        }

        if (!response || !response.trim()) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return {
            success: false,
            error: "empty_provider_response",
            status: "failed",
            ...stageMetadata,
            promptChars,
            durationMs: latencyMs,
            parseFailures,
          };
        }

        if (!summary) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return {
            success: false,
            error: "parse_failed",
            status: "failed",
            ...stageMetadata,
            promptChars,
            durationMs: latencyMs,
            parseFailures,
          };
        }

        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return {
            success: false,
            error: "validation_failed",
            status: "failed",
            ...stageMetadata,
            promptChars,
            durationMs: latencyMs,
            parseFailures,
          };
        }

        const qualityScore = scoreSummary(summaryForValidation);

        await kv.set(KV.summaries, sessionId, summary);
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
        });

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
        });

        return {
          success: true,
          summary,
          qualityScore,
          status: "succeeded",
          ...stageMetadata,
          promptChars,
          durationMs: latencyMs,
          parseFailures,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return { success: false, error: msg };
      }
    },
  );

  sdk.registerFunction(
    "mem::summarize-resumable",
    async (data: { sessionId: string; model?: string } | undefined) =>
      runResumableSummaryStep(data, kv, provider),
  );
}
