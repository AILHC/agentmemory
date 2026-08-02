import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    observations: (sessionId: string) => `obs:${sessionId}`,
    summaryResumableRuns: "summary-resumable-runs",
    summaryResumableActiveRuns: "summary-resumable-active-runs",
    summaryResumablePartials: (runId: string) =>
      `summary-resumable-partials:${runId}`,
    extractionOperationReceipt: (operationToken: string) =>
      `extraction-operation-receipt:${operationToken}`,
    extractionContributionContract: (stage: string) =>
      `extraction-contribution-contract:${stage}`,
    extractionContributionRecords: (stage: string, contractVersion: string) =>
      `extraction-contribution-records:${stage}:${contractVersion}`,
    extractionContributionHeads: (stage: string, contractVersion: string) =>
      `extraction-contribution-heads:${stage}:${contractVersion}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: vi.fn(() => ({ valid: true, result: { errors: [] } })),
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

import {
  buildSummaryExperimentChunks,
  buildTurnAwareSummaryChunks,
  registerSummarizeFunction,
} from "../src/functions/summarize.js";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";
import {
  ProviderCallError,
  ProviderPreflightError,
} from "../src/providers/provider-call-result.js";
import { validateOutput } from "../src/eval/validator.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type {
  CompressedObservation,
  Session,
  MemoryProvider,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function extractionReceipts(kv: ReturnType<typeof mockKV>): any[] {
  return [...kv.store.entries()]
    .filter(([scope]) => scope.startsWith("extraction-operation-receipt:"))
    .flatMap(([, entries]) => [...entries.values()]);
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function makeObs(i: number, sessionId: string): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "conversation",
    title: `obs ${i}`,
    facts: [`fact ${i}`],
    narrative: `narrative for obs ${i}`,
    concepts: [],
    files: [`src/file_${i}.ts`],
    importance: 5,
  };
}

function makeCompressedObservation(
  id: string,
  overrides: Partial<CompressedObservation> & { userPrompt?: string; hookType?: string } = {},
): CompressedObservation & { userPrompt?: string; hookType?: string } {
  return {
    id,
    sessionId: "session-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: overrides.type ?? "command_run",
    title: overrides.title ?? id,
    narrative: overrides.narrative ?? "",
    facts: overrides.facts ?? [],
    files: overrides.files ?? [],
    concepts: overrides.concepts ?? [],
    ...overrides,
  };
}

function makeProvider(responses: Array<string | Error>): MemoryProvider & {
  calls: Array<{ system: string; user: string; options: unknown }>;
} {
  const calls: Array<{ system: string; user: string; options: unknown }> = [];
  let i = 0;
  return {
    name: "test",
    calls,
    compress: async () => "",
    summarize: async (system: string, user: string, options?: unknown) => {
      calls.push({ system, user, options });
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function makeDetailedProvider(responses: string[], delays: number[] = []): MemoryProvider & {
  calls: Array<{ system: string; user: string; options: unknown }>;
} {
  const calls: Array<{ system: string; user: string; options: unknown }> = [];
  let i = 0;
  return {
    name: "pi-agent-sdk",
    calls,
    compress: async () => "",
    summarize: async () => {
      throw new Error("legacy summarize path should not be used");
    },
    summarizeWithMetadata: async (system: string, user: string, options?: unknown) => {
      calls.push({ system, user, options });
      const text = responses[i] ?? responses[responses.length - 1];
      const callIndex = i++;
      if (delays[callIndex]) {
        await new Promise((resolve) => setTimeout(resolve, delays[callIndex]));
      }
      return {
        text,
        metadata: {
          inputTokens: 10 + callIndex,
          outputTokens: 20 + callIndex,
          totalTokens: 30 + callIndex,
          maxOutputTokens: 4096,
          stopReason: "stop" as const,
          responseModel: "telemetry-model",
          contextWindow: 128000,
          modelMaxTokens: 8192,
        },
      };
    },
  };
}

function summaryXml(opts: {
  title: string;
  narrative?: string;
  decisions?: string[];
  files?: string[];
  concepts?: string[];
}): string {
  const d = (opts.decisions ?? []).map((x) => `<decision>${x}</decision>`).join("");
  const f = (opts.files ?? []).map((x) => `<file>${x}</file>`).join("");
  const c = (opts.concepts ?? []).map((x) => `<concept>${x}</concept>`).join("");
  return `<summary>
<title>${opts.title}</title>
<narrative>${opts.narrative ?? "narrative"}</narrative>
<decisions>${d}</decisions>
<files>${f}</files>
<concepts>${c}</concepts>
</summary>`;
}

async function setupHandler(opts: {
  sessionId: string;
  obsCount: number;
  provider: MemoryProvider;
}) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: opts.sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: opts.obsCount,
  };
  await kv.set("sessions", opts.sessionId, session);
  for (let i = 0; i < opts.obsCount; i++) {
    const o = makeObs(i, opts.sessionId);
    await kv.set(`obs:${opts.sessionId}`, o.id, o);
  }
  registerSummarizeFunction(sdk as any, kv as any, opts.provider);
  const handler = sdk.functions.get("mem::summarize")!;
  return { handler, kv };
}

async function seedSummarySession(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  obsCount: number,
): Promise<Session> {
  const session: Session = {
    id: sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: obsCount,
  };
  await kv.set("sessions", sessionId, session);
  for (let i = 0; i < obsCount; i++) {
    const observation = makeObs(i, sessionId);
    await kv.set(`obs:${sessionId}`, observation.id, observation);
  }
  return session;
}

function summarySessionInputHash(session: Session): string {
  return createHash("sha256").update(JSON.stringify({
    session_id: session.id,
    started_at: session.startedAt || null,
  })).digest("hex");
}

function setupResumableHandler(
  kv: ReturnType<typeof mockKV>,
  provider: MemoryProvider,
  retryOptions?: unknown,
): { handler: Function; sdk: ReturnType<typeof mockSdk> } {
  const sdk = mockSdk();
  (registerSummarizeFunction as any)(sdk, kv, provider, undefined, retryOptions);
  return {
    handler: sdk.functions.get("mem::summarize-resumable")!,
    sdk,
  };
}

describe("mem::summarize chunking", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.SUMMARIZE_CHUNK_SIZE;
    delete process.env.SUMMARIZE_CHUNK_CONCURRENCY;
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    delete process.env.AGENTMEMORY_SUMMARY_MODEL;
    delete process.env.AGENTMEMORY_EVALUATION_MODE;
    delete process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE;
    delete process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
    delete process.env.AGENTMEMORY_SUMMARY_CONTEXT_TREATMENT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("keeps a user prompt and its following work in the same summary chunk", () => {
    const observations = [
      makeCompressedObservation("obs-1", {
        type: "conversation",
        hookType: "prompt_submit",
        title: "User asks A",
        narrative: "User asks A.",
        userPrompt: "Do A",
      }),
      makeCompressedObservation("obs-2", {
        type: "command_run",
        title: "Tool for A",
        narrative: "Tool work for A.",
      }),
      makeCompressedObservation("obs-3", {
        type: "conversation",
        title: "Answer A",
        narrative: "Assistant answer for A.",
      }),
      makeCompressedObservation("obs-4", {
        type: "conversation",
        hookType: "prompt_submit",
        title: "User asks B",
        narrative: "User asks B.",
        userPrompt: "Do B",
      }),
      makeCompressedObservation("obs-5", {
        type: "command_run",
        title: "Tool for B",
        narrative: "Tool work for B.",
      }),
    ];

    const chunks = buildTurnAwareSummaryChunks(observations, 4);

    expect(chunks.map((chunk) => chunk.map((obs) => obs.id))).toEqual([
      ["obs-1", "obs-2", "obs-3"],
      ["obs-4", "obs-5"],
    ]);
  });

  it("splits a single oversized turn by observation count as a fallback", () => {
    const observations = [
      makeCompressedObservation("obs-1", {
        type: "conversation",
        hookType: "prompt_submit",
        title: "User asks A",
        narrative: "User asks A.",
        userPrompt: "Do A",
      }),
      makeCompressedObservation("obs-2", { type: "command_run", title: "Tool 1" }),
      makeCompressedObservation("obs-3", { type: "command_run", title: "Tool 2" }),
      makeCompressedObservation("obs-4", { type: "command_run", title: "Tool 3" }),
    ];

    const chunks = buildTurnAwareSummaryChunks(observations, 2);

    expect(chunks.map((chunk) => chunk.map((obs) => obs.id))).toEqual([
      ["obs-1", "obs-2"],
      ["obs-3", "obs-4"],
    ]);
  });

  it("keeps the current B chunk plan identical to turn-aware chunking", () => {
    const observations = [
      makeCompressedObservation("obs-1", { hookType: "prompt_submit", userPrompt: "A" }),
      makeCompressedObservation("obs-2"),
      makeCompressedObservation("obs-3", { hookType: "prompt_submit", userPrompt: "B" }),
      makeCompressedObservation("obs-4"),
      makeCompressedObservation("obs-5"),
    ];

    const plan = buildSummaryExperimentChunks(observations, 4, {
      boundaryPolicy: "current-turn-aware",
      inputTarget: { kind: "observation-count", targetObservations: 4 },
    });

    expect(plan.chunks).toEqual(buildTurnAwareSummaryChunks(observations, 4));
    expect(plan.oversizedAtomicChunkIndexes).toEqual([]);
  });

  it("keeps an oversized A turn atomic and marks its map telemetry", () => {
    const observations = [
      makeCompressedObservation("obs-1", { hookType: "prompt_submit", userPrompt: "A" }),
      makeCompressedObservation("obs-2"),
      makeCompressedObservation("obs-3"),
      makeCompressedObservation("obs-4"),
      makeCompressedObservation("obs-5"),
      makeCompressedObservation("obs-6", { hookType: "prompt_submit", userPrompt: "B" }),
      makeCompressedObservation("obs-7"),
    ];

    const plan = buildSummaryExperimentChunks(observations, 4, {
      boundaryPolicy: "atomic-turn",
      inputTarget: { kind: "observation-count", targetObservations: 4 },
    });

    expect(plan.chunks.map((chunk) => chunk.map((observation) => observation.id))).toEqual([
      ["obs-1", "obs-2", "obs-3", "obs-4", "obs-5"],
      ["obs-6", "obs-7"],
    ]);
    expect(plan.oversizedAtomicChunkIndexes).toEqual([0]);
  });

  it("packs W turns by targetInputTokens without splitting a recognized turn", () => {
    const observations = [
      makeCompressedObservation("obs-1", { hookType: "prompt_submit", userPrompt: "A" }),
      makeCompressedObservation("obs-2"),
      makeCompressedObservation("obs-3"),
      makeCompressedObservation("obs-4", { hookType: "prompt_submit", userPrompt: "B" }),
      makeCompressedObservation("obs-5"),
    ];

    const plan = buildSummaryExperimentChunks(observations, 400, {
      boundaryPolicy: "atomic-turn",
      inputTarget: { kind: "token-target", targetInputTokens: 30 },
    }, (chunk) => chunk.length * 10);

    expect(plan.chunks.map((chunk) => chunk.map((observation) => observation.id))).toEqual([
      ["obs-1", "obs-2", "obs-3"],
      ["obs-4", "obs-5"],
    ]);
    expect(plan.oversizedAtomicChunkIndexes).toEqual([]);
  });

  it("fails closed when an active W treatment has no targetInputTokens", () => {
    const observations = [
      makeCompressedObservation("obs-1", { hookType: "prompt_submit", userPrompt: "A" }),
    ];

    expect(() => buildSummaryExperimentChunks(observations, 400, {
      boundaryPolicy: "atomic-turn",
      inputTarget: { kind: "token-target" } as any,
    })).toThrow(/targetInputTokens/);
  });

  it("does not activate summary experiment controls for a non-summary target stage", async () => {
    process.env.AGENTMEMORY_EVALUATION_MODE = "context-strategy";
    process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE = "memory";
    process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY = "not-json";
    const provider = makeProvider([summaryXml({ title: "ordinary summary" })]);
    const { handler } = await setupHandler({
      sessionId: "ses_non_summary_target",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_non_summary_target" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it("marks every A oversized atomic map call in provider telemetry", async () => {
    process.env.AGENTMEMORY_EVALUATION_MODE = "context-strategy";
    process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE = "summary";
    process.env.AGENTMEMORY_SUMMARY_CONTEXT_TREATMENT = JSON.stringify({
      boundaryPolicy: "atomic-turn",
      inputTarget: { kind: "observation-count", targetObservations: 4 },
    });
    process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY = JSON.stringify({
      schemaVersion: 1,
      expectedProvider: "pi-agent-sdk",
      expectedModel: "gpt-5.4",
      worstTokensPerChar: 0.5,
      fixedTokens: 1,
      proportionalReserve: 0,
      contextWindow: 128000,
      modelMaxTokens: 8192,
      maxOutputTokens: 4096,
      reasoningReserve: 0,
      safetyMargin: 0,
      calibrationHash: `sha256:${"a".repeat(64)}`,
    });
    process.env.PI_AGENT_MODEL = "gpt-5.4";
    process.env.SUMMARIZE_CHUNK_SIZE = "4";
    const provider = makeDetailedProvider([
      summaryXml({ title: "Atomic A" }),
      summaryXml({ title: "Atomic B" }),
      summaryXml({ title: "Merged" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_atomic_telemetry",
      obsCount: 7,
      provider,
    });
    for (let index = 0; index < 7; index++) {
      await kv.set("obs:ses_atomic_telemetry", `obs_${index}`, makeCompressedObservation(`obs_${index}`, {
        sessionId: "ses_atomic_telemetry",
        hookType: index === 0 || index === 5 ? "prompt_submit" : undefined,
        userPrompt: index === 0 || index === 5 ? `Turn ${index}` : undefined,
      }));
    }

    const result: any = await handler({ sessionId: "ses_atomic_telemetry" });

    expect(result.success).toBe(true);
    expect(result.telemetry.filter((entry: any) => entry.callRole === "map")).toEqual([
      expect.objectContaining({ oversizedAtomicChunk: true, chunkObservationCount: 5 }),
      expect.objectContaining({ oversizedAtomicChunk: false, chunkObservationCount: 2 }),
    ]);
  });

  it("falls back to fixed-size summary chunks when there are no user turn markers", () => {
    const observations = [
      makeCompressedObservation("obs-1", { type: "command_run", title: "Tool 1" }),
      makeCompressedObservation("obs-2", { type: "command_run", title: "Tool 2" }),
      makeCompressedObservation("obs-3", { type: "conversation", title: "Answer" }),
      makeCompressedObservation("obs-4", { type: "command_run", title: "Tool 3" }),
      makeCompressedObservation("obs-5", { type: "decision", title: "Decision" }),
    ];

    const chunks = buildTurnAwareSummaryChunks(observations, 2);

    expect(chunks.map((chunk) => chunk.map((obs) => obs.id))).toEqual([
      ["obs-1", "obs-2"],
      ["obs-3", "obs-4"],
      ["obs-5"],
    ]);
  });

  it("small session takes the single-call path (no chunking, no reduce)", async () => {
    const provider = makeProvider([
      summaryXml({
        title: "Small session",
        decisions: ["decision A"],
        files: ["src/a.ts"],
        concepts: ["concept-a"],
      }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_small",
      obsCount: 10,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_small" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].user).toContain("Session observations (10 total)");
    const stored: any = await kv.get("summaries", "ses_small");
    expect(stored?.title).toBe("Small session");
  });

  it("passes resolved summary stage model options to provider calls", async () => {
    process.env.AGENTMEMORY_SUMMARY_MODEL = "summary-stage-model";
    const provider = makeProvider([
      summaryXml({
        title: "Routed session",
        decisions: ["decision A"],
        files: ["src/a.ts"],
        concepts: ["concept-a"],
      }),
    ]);
    provider.name = "pi-agent-sdk";
    const { handler } = await setupHandler({
      sessionId: "ses_model",
      obsCount: 10,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_model" });

    expect(result.success).toBe(true);
    expect(provider.calls[0].options).toEqual({
      model: "summary-stage-model",
      modelSource: "AGENTMEMORY_SUMMARY_MODEL",
    });
    expect(result).toMatchObject({
      stage: "summary",
      model: "summary-stage-model",
      modelSource: "AGENTMEMORY_SUMMARY_MODEL",
      provider: "pi-agent-sdk",
      modelApplied: true,
      parseFailures: 0,
    });
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes child lineage boundaries in the summary prompt", async () => {
    const sessionId = "child-session";
    const provider = makeProvider([
      summaryXml({ title: "child summary" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId,
      obsCount: 1,
      provider,
    });
    await kv.set("sessions", sessionId, {
      id: sessionId,
      project: "proj",
      cwd: "/repo",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      observationCount: 1,
      lineage: "child",
      parentSessionId: "parent-session",
    });
    await kv.set(`obs:${sessionId}`, "obs-1", {
      id: "obs-1",
      sessionId,
      timestamp: "2026-01-01T00:00:10.000Z",
      type: "conversation",
      hookType: "prompt_submit",
      title: "Child task",
      narrative: "Investigated delegated work.",
      facts: ["Found a local fix."],
      files: [],
      concepts: ["delegation"],
    });

    const result: any = await handler({ sessionId });

    expect(result.success).toBe(true);
    expect(provider.calls[0].user).toContain("Session lineage: child.");
    expect(provider.calls[0].user).toContain("Parent session id: parent-session.");
    expect(provider.calls[0].user).toContain("Do not imply that child-local execution details are parent-session decisions.");
  });

  it("large session map-reduces: N chunk calls + 1 reduce call", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1"; // serial keeps call ordering deterministic
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1", decisions: ["dA"], files: ["src/a.ts"], concepts: ["ca"] }),
      summaryXml({ title: "Chunk 2", decisions: ["dB"], files: ["src/b.ts"], concepts: ["cb"] }),
      summaryXml({ title: "Chunk 3", decisions: ["dC"], files: ["src/c.ts"], concepts: ["cc"] }),
      summaryXml({
        title: "Merged",
        decisions: ["dA", "dB", "dC"],
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        concepts: ["ca", "cb", "cc"],
      }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_large",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_large" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(4);
    // First three are chunk calls (use the summary system prompt).
    expect(provider.calls[0].system).toContain("session summarizer");
    expect(provider.calls[2].system).toContain("session summarizer");
    // Last is the reduce call (uses the merge system prompt).
    expect(provider.calls[3].system).toContain("merging multiple partial summaries");
    expect(provider.calls[3].user).toContain("Chunk 1 of 3");
    expect(provider.calls[3].user).toContain("Chunk 3 of 3");

    const stored: any = await kv.get("summaries", "ses_large");
    expect(stored?.title).toBe("Merged");
    // observationCount on the persisted summary should reflect the full session,
    // not just the final chunk.
    expect(stored?.observationCount).toBe(250);
    expect(stored?.keyDecisions).toEqual(["dA", "dB", "dC"]);
  });

  it("returns per-attempt map and reduce telemetry without exposing prompt or response text", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "2";
    const provider = makeDetailedProvider([
      summaryXml({ title: "Chunk 1" }),
      summaryXml({ title: "Chunk 2" }),
      summaryXml({ title: "Chunk 3" }),
      summaryXml({ title: "Merged" }),
    ], [20, 0, 0, 0]);
    const { handler } = await setupHandler({
      sessionId: "ses_telemetry",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_telemetry" });

    expect(result.success).toBe(true);
    expect(result.telemetry).toHaveLength(4);
    expect(result.telemetry.map((item: any) => [item.operation, item.callRole, item.callIndex])).toEqual([
      ["summarize", "map", 0],
      ["summarize", "map", 1],
      ["summarize", "map", 2],
      ["summarize", "reduce", 3],
    ]);
    expect(result.telemetry[0]).toMatchObject({
      metadataStatus: "supported",
      metadata: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        maxOutputTokens: 4096,
        responseModel: "telemetry-model",
      },
    });
    expect(JSON.stringify(result.telemetry)).not.toContain("Chunk 1");
    expect(JSON.stringify(result.telemetry)).not.toContain("session summarizer");
  });

  it("blocks summary calls before the provider and does not retry", async () => {
    process.env.AGENTMEMORY_EVALUATION_MODE = "context-strategy";
    process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE = "summary";
    process.env.AGENTMEMORY_SUMMARY_CONTEXT_TREATMENT = JSON.stringify({
      boundaryPolicy: "current-turn-aware",
      inputTarget: { kind: "observation-count", targetObservations: 400 },
    });
    process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY = JSON.stringify({
      schemaVersion: 1,
      expectedProvider: "pi-agent-sdk",
      expectedModel: "gpt-5.4",
      worstTokensPerChar: 0.5,
      fixedTokens: 1,
      proportionalReserve: 0,
      contextWindow: 1,
      modelMaxTokens: 8192,
      maxOutputTokens: 128,
      reasoningReserve: 0,
      safetyMargin: 0,
      calibrationHash: `sha256:${"a".repeat(64)}`,
    });
    process.env.PI_AGENT_MODEL = "gpt-5.4";
    const provider = makeDetailedProvider([summaryXml({ title: "blocked" })]);
    const { handler } = await setupHandler({
      sessionId: "ses_preflight_blocked",
      obsCount: 2,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_preflight_blocked" });

    expect(result).toMatchObject({ success: false, status: "infeasible", error: "infeasible" });
    expect(provider.calls).toHaveLength(0);
    expect(result.telemetry).toEqual([
      expect.objectContaining({
        providerInvoked: false,
        preflightBlocked: true,
        reason: "context_window_exceeded",
      }),
    ]);
  });

  it("uses cumulative observation ranges when reducing variable-size chunks", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "4";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "Turn A" }),
      summaryXml({ title: "Turn B" }),
      summaryXml({ title: "Merged turns" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_turn_ranges",
      obsCount: 5,
      provider,
    });
    const observations = [
      makeCompressedObservation("obs_0", {
        sessionId: "ses_turn_ranges",
        type: "conversation",
        hookType: "prompt_submit",
        title: "User asks A",
        userPrompt: "Do A",
      }),
      makeCompressedObservation("obs_1", {
        sessionId: "ses_turn_ranges",
        type: "command_run",
        title: "Tool for A",
      }),
      makeCompressedObservation("obs_2", {
        sessionId: "ses_turn_ranges",
        type: "conversation",
        title: "Answer A",
      }),
      makeCompressedObservation("obs_3", {
        sessionId: "ses_turn_ranges",
        type: "conversation",
        hookType: "prompt_submit",
        title: "User asks B",
        userPrompt: "Do B",
      }),
      makeCompressedObservation("obs_4", {
        sessionId: "ses_turn_ranges",
        type: "command_run",
        title: "Tool for B",
      }),
    ];
    for (const observation of observations) {
      await kv.set("obs:ses_turn_ranges", observation.id, observation);
    }

    const result: any = await handler({ sessionId: "ses_turn_ranges" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[2].user).toContain("obs 1-3");
    expect(provider.calls[2].user).toContain("obs 4-5");
  });

  it("injects output language policy into chunk and reduce summary calls", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1" }),
      summaryXml({ title: "Chunk 2" }),
      summaryXml({ title: "Chunk 3" }),
      summaryXml({ title: "Merged" }),
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_policy",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_policy" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls.every((call) =>
      call.system.includes("AgentMemory Output Language Policy"),
    )).toBe(true);
    expect(provider.calls[3].system).toContain("人类可读内容使用简体中文");
  });

  it("SUMMARIZE_CHUNK_SIZE env override is respected", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "50";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "merged" }),
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_env",
      obsCount: 175,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_env" });

    expect(result.success).toBe(true);
    // 175 obs ÷ 50 = 4 chunks (last chunk has 25) + 1 reduce = 5 calls.
    expect(provider.calls).toHaveLength(5);
  });

  it("flaky chunk: parse fails once, retried, then succeeds — no skip", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "ok1" }),
      "<garbage/>",                  // chunk 2 attempt 1: parse-fail
      summaryXml({ title: "ok2" }),  // chunk 2 attempt 2 (retry): success
      summaryXml({ title: "ok3" }),
      summaryXml({ title: "merged" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_flaky",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_flaky" });

    expect(result.success).toBe(true);
    // 3 chunks × 1 attempt + 1 retry on chunk 2 + 1 reduce = 5 calls.
    expect(provider.calls).toHaveLength(5);
    const stored: any = await kv.get("summaries", "ses_flaky");
    expect(stored?.title).toBe("merged");
  });

  it("persistently-broken chunk is skipped, reduce still runs on remaining partials", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "ok1" }),
      "<garbage/>", "<garbage/>",   // chunk 2: both attempts parse-fail
      summaryXml({ title: "ok3" }),
      summaryXml({ title: "merged-with-skip" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_skip",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_skip" });

    expect(result.success).toBe(true);
    // 1 ok + (1 + 1 retry skip) + 1 ok + 1 reduce = 5 calls.
    expect(provider.calls).toHaveLength(5);
    // Reduce input should mention only 2 of 3 chunks (chunk 2 skipped) —
    // but the chunk indices in the reduce labels should reflect chunk 1 and 3,
    // preserving chronological boundaries.
    const reduceCall = provider.calls[4];
    expect(reduceCall.user).toContain("Chunk 1 of 2");
    expect(reduceCall.user).toContain("Chunk 2 of 2");
    expect(reduceCall.user).toContain("obs 1-100");        // first surviving chunk
    expect(reduceCall.user).toContain("obs 201-250");      // third surviving chunk (was idx 2, range 201-250)
    const stored: any = await kv.get("summaries", "ses_skip");
    expect(stored?.title).toBe("merged-with-skip");
  });

  it("too many skipped chunks bails out with a clear error", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    // 3 chunks, 2 fully broken → >50% skipped → bail.
    const provider = makeProvider([
      summaryXml({ title: "ok1" }),
      "<garbage/>", "<garbage/>",
      "<garbage/>", "<garbage/>",
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_too_broken",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_too_broken" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too_many_chunks_skipped: 2\/3/);
  });

  it("provider error on one chunk after retry is skipped, not propagated", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    let i = 0;
    const provider: MemoryProvider & { calls: any[] } = {
      name: "test",
      calls: [],
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        (provider as any).calls.push({ system, user });
        i += 1;
        if (i === 1) return summaryXml({ title: "ok1" });
        // chunk 2: both attempts throw (e.g. provider 400)
        if (i === 2 || i === 3) throw new Error("OpenAI API error (400): content rejected");
        if (i === 4) return summaryXml({ title: "ok3" });
        return summaryXml({ title: "merged-with-skip" });
      },
    };
    const { handler, kv } = await setupHandler({
      sessionId: "ses_net",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_net" });

    expect(result.success).toBe(true);
    // 1 ok + 2 fail + 1 ok + 1 reduce = 5 calls.
    expect((provider as any).calls.length).toBe(5);
    const stored: any = await kv.get("summaries", "ses_net");
    expect(stored?.title).toBe("merged-with-skip");
  });

  it("every chunk failing on provider error trips too_many_chunks_skipped", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    // 3 chunks, all chunk calls throw → 3/3 skipped → bail.
    const provider: MemoryProvider & { calls: any[] } = {
      name: "test",
      calls: [],
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        (provider as any).calls.push({ system, user });
        throw new Error("OpenAI API error (400): invalid request");
      },
    };
    const { handler } = await setupHandler({
      sessionId: "ses_all_400",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_all_400" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too_many_chunks_skipped: 3\/3/);
  });

  it("chunks run in parallel batches according to SUMMARIZE_CHUNK_CONCURRENCY", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "2";
    let inflight = 0;
    let maxInflight = 0;
    const provider: MemoryProvider & { calls: any[] } = {
      name: "test",
      calls: [],
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        (provider as any).calls.push({ system, user });
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        // Yield to event loop so siblings can also enter before we resolve.
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        if (system.includes("merging")) return summaryXml({ title: "merged" });
        return summaryXml({ title: "ok" });
      },
    };
    const { handler } = await setupHandler({
      sessionId: "ses_par",
      obsCount: 400, // 4 chunks at chunkSize=100
      provider,
    });

    const result: any = await handler({ sessionId: "ses_par" });

    expect(result.success).toBe(true);
    // 4 chunks at concurrency 2 → max 2 in flight at once during the chunk phase.
    // Reduce is a single call so doesn't bump it.
    expect(maxInflight).toBe(2);
  });

  // #783: markdown-wrapped XML used to silently fail parsing because
  // the tag regex looked for <title> in the raw payload. stripXmlWrappers
  // now peels ```xml ... ``` fences and conversational pre/postamble
  // before the regex runs.
  it("parses a summary even when the LLM wraps XML in markdown fences", async () => {
    const wrappedXml = "Here's the summary:\n```xml\n" + summaryXml({
      title: "wrapped",
      narrative: "n",
      decisions: ["d1"],
      files: ["src/a.ts"],
      concepts: ["c1"],
    }) + "\n```\nLet me know if you need anything else.";
    const provider = makeProvider([wrappedXml]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_md",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_md" });

    expect(result.success).toBe(true);
    expect(result.summary.title).toBe("wrapped");
    const stored = await kv.get("summaries", "ses_md");
    expect((stored as any).title).toBe("wrapped");
  });

  it("retries the final summarize once on first-attempt parse failure", async () => {
    // First call returns garbage (no <title>), second returns valid XML.
    // The chunk-level retry is bypassed for a 1-obs session (no chunking),
    // so this exercises the new final-summarize retry path.
    const provider = makeProvider([
      "not xml, just a sentence with no tags",
      summaryXml({ title: "second-attempt" }),
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_retry",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_retry" });

    expect(result.success).toBe(true);
    expect(result.summary.title).toBe("second-attempt");
    expect((provider as any).calls.length).toBeGreaterThanOrEqual(2);
  });

  it("records both final summarize attempts while preserving retry success", async () => {
    const provider = makeDetailedProvider([
      "not xml",
      summaryXml({ title: "retry telemetry" }),
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_retry_telemetry",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_retry_telemetry" });

    expect(result.success).toBe(true);
    expect(result.summary.title).toBe("retry telemetry");
    expect(result.telemetry).toHaveLength(2);
    expect(result.telemetry.map((item: any) => [item.callRole, item.callIndex])).toEqual([
      ["single", 0],
      ["single", 1],
    ]);
  });

  it("marks legacy provider telemetry as unsupported without inventing usage", async () => {
    const provider = makeProvider([summaryXml({ title: "legacy" })]);
    const { handler } = await setupHandler({
      sessionId: "ses_legacy_telemetry",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_legacy_telemetry" });

    expect(result.success).toBe(true);
    expect(result.telemetry).toEqual([
      expect.objectContaining({
        operation: "summarize",
        callRole: "single",
        callIndex: 0,
        metadataStatus: "unsupported",
      }),
    ]);
    expect(result.telemetry[0].metadata).toBeUndefined();
  });

  it("preserves supported ProviderCallError metadata on a failed stage response", async () => {
    const metadata = {
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
      maxOutputTokens: 4096,
      stopReason: "error" as const,
      responseModel: "error-model",
    };
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn(),
      summarize: vi.fn(),
      summarizeWithMetadata: vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed", metadata);
      }),
    };
    const { handler } = await setupHandler({
      sessionId: "ses_error_telemetry",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_error_telemetry" });

    expect(result.success).toBe(false);
    expect(result.telemetry).toHaveLength(1);
    expect(result.telemetry[0]).toMatchObject({
      metadataStatus: "supported",
      metadata,
    });
    expect(JSON.stringify(result.telemetry)).not.toContain("pi_stream_failed");
    expect(JSON.stringify(result.telemetry)).not.toContain("summary");
  });

  it("keeps resumable map, retry, and reduce call identities unique across invocations", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_identity", 250);
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1" }),
      summaryXml({ title: "Chunk 2" }),
      summaryXml({ title: "Chunk 3" }),
      summaryXml({ title: "Merged" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    const responses = [
      await handler({ sessionId: "ses_identity" }),
      await handler({ sessionId: "ses_identity" }),
      await handler({ sessionId: "ses_identity" }),
      await handler({ sessionId: "ses_identity" }),
    ] as any[];
    const callIndexes = responses.flatMap((response) =>
      (response.telemetry ?? []).map((item: any) => item.callIndex),
    );
    expect(callIndexes).toHaveLength(4);
    expect(new Set(callIndexes).size).toBe(callIndexes.length);
    expect(responses[0].telemetry[0].callRole).toBe("map");
    expect(responses[3].telemetry[0].callRole).toBe("reduce");
  });

  it("keeps resumable retry attempts unique across handler invocations", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_retry_identity", 1);
    const provider = makeProvider([
      "garbage one",
      "garbage two",
      summaryXml({ title: "Recovered" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    const first: any = await handler({ sessionId: "ses_retry_identity" });
    const second: any = await handler({ sessionId: "ses_retry_identity" });
    const callIndexes = [
      ...first.telemetry.map((item: any) => item.callIndex),
      ...second.telemetry.map((item: any) => item.callIndex),
    ];

    expect(callIndexes).toHaveLength(3);
    expect(new Set(callIndexes).size).toBe(3);
    expect(second.status).toBe("succeeded");
  });

  it("returns parse_failed only after both attempts fail", async () => {
    const provider = makeProvider([
      "garbage one",
      "garbage two",
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_fail",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_fail" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("parse_failed");
  });
});

describe("mem::summarize-resumable", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    vi.mocked(validateOutput).mockReset().mockReturnValue({
      valid: true,
      result: { errors: [] },
    } as any);
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    delete process.env.AGENTMEMORY_SUMMARY_MODEL;
    delete process.env.AGENTMEMORY_EVALUATION_MODE;
    delete process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE;
    delete process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
    delete process.env.AGENTMEMORY_SUMMARY_CONTEXT_TREATMENT;
  });

  it("binds a v2 attempt to the deterministic resumable run so a lost response resumes without another model call", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_attempt_resume";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "durable summary" })]);
    const { handler } = setupResumableHandler(kv, provider);
    const request = {
      sessionId,
      attemptId: "attempt-1",
      inputHash,
    };

    const first = await handler(request);
    const afterLostResponse = await handler(request);

    expect(first).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-1",
      runnerInputHash: inputHash,
      summary: { title: "durable summary" },
    });
    expect(afterLostResponse).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-1",
      runnerInputHash: inputHash,
      summary: { title: "durable summary" },
    });
    expect(provider.calls).toHaveLength(1);
    const runs = await kv.list<any>(KV.summaryResumableRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      attemptId: "attempt-1",
      attemptInputHash: inputHash,
      completedFinalWrites: 1,
    });
    expect(first).toMatchObject({
      serviceInputHash: runs[0].inputHash,
      resumableRunId: runs[0].id,
    });
    expect(afterLostResponse).toMatchObject({
      serviceInputHash: runs[0].inputHash,
      resumableRunId: runs[0].id,
    });
    const receipts = extractionReceipts(kv);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      version: 1,
      status: "succeeded",
    });
    expect(receipts[0].response).toMatchObject({
      resultRef: {
        scope: KV.summaryResumableRuns,
        key: runs[0].id,
      },
    });
    expect(JSON.stringify(receipts)).not.toContain("durable summary");
    expect(first).toMatchObject({
      recoveryEvidence: {
        kind: "committed",
        receiptVersion: 1,
        resultRef: `${KV.summaryResumableRuns}:${runs[0].id}`,
        effectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(afterLostResponse).toMatchObject({
      recoveryEvidence: first.recoveryEvidence,
    });

    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const inProgressKv = mockKV();
    const inProgressSessionId = "ses_v2_attempt_conflict";
    const inProgressSession = await seedSummarySession(inProgressKv, inProgressSessionId, 2);
    const inProgressInputHash = summarySessionInputHash(inProgressSession);
    const inProgressProvider = makeProvider([summaryXml({ title: "first chunk" })]);
    const { handler: inProgressHandler } = setupResumableHandler(inProgressKv, inProgressProvider);
    await inProgressHandler({
      sessionId: inProgressSessionId,
      attemptId: "attempt-in-progress-1",
      inputHash: inProgressInputHash,
    });
    const conflict = await inProgressHandler({
      sessionId: inProgressSessionId,
      attemptId: "attempt-in-progress-2",
      inputHash: inProgressInputHash,
    });
    expect(conflict).toMatchObject({
      success: false,
      failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
    });
    expect(inProgressProvider.calls).toHaveLength(1);
  });

  it("emits committed recovery evidence only after repairing an interrupted final Summary write", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_final_write_repair";
    const attemptId = "attempt-final-write-repair";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "repairable summary" })]);
    const { handler } = setupResumableHandler(kv, provider);
    const originalSet = kv.set.bind(kv);
    let interruptFormalSummary = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (interruptFormalSummary && scope === KV.summaries) {
        interruptFormalSummary = false;
        throw new Error("formal Summary write interrupted");
      }
      return originalSet(scope, key, value);
    };

    const interrupted = await handler({ sessionId, attemptId, inputHash });
    const [interruptedRun] = await kv.list<any>(KV.summaryResumableRuns);

    expect(interrupted).toMatchObject({
      status: "failed",
      failure: { cause: "extraction_operation_reconciliation_required" },
    });
    expect(interrupted.recoveryEvidence).toBeUndefined();
    expect(interruptedRun).toMatchObject({
      status: "succeeded",
      completedFinalWrites: 0,
    });
    expect(await kv.get(KV.summaries, sessionId)).toBeNull();

    const repaired = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });
    const [repairedRun] = await kv.list<any>(KV.summaryResumableRuns);
    const [receipt] = extractionReceipts(kv);

    expect(repaired).toMatchObject({
      status: "succeeded",
      summary: { title: "repairable summary" },
      recoveryEvidence: {
        kind: "committed",
        receiptKey: receipt.key,
        receiptVersion: 1,
        resultRef: `${KV.summaryResumableRuns}:${repairedRun.id}`,
        effectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(repairedRun.completedFinalWrites).toBe(1);
    expect(receipt).toMatchObject({ version: 1, status: "succeeded" });
    expect(await kv.get<any>(KV.summaries, sessionId)).toMatchObject({
      title: "repairable summary",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("reconciles a completed map receipt before advancing a multi-chunk attempt", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_multi_chunk_resume";
    const attemptId = "attempt-multi-chunk";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "first chunk" }),
      summaryXml({ title: "second chunk" }),
      summaryXml({ title: "merged" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    const first = await handler({ sessionId, attemptId, inputHash });
    const reconciled = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });

    expect(first).toMatchObject({
      status: "in_progress",
      advanced: "completed",
      completedChunks: 1,
      totalChunks: 2,
    });
    expect(reconciled).toMatchObject({
      status: "in_progress",
      advanced: "completed",
      completedChunks: 1,
      totalChunks: 2,
    });
    expect(provider.calls).toHaveLength(1);

    const advanced = await handler({ sessionId, attemptId, inputHash });

    expect(provider.calls).toHaveLength(2);
    expect(advanced).toMatchObject({
      status: "in_progress",
      advanced: "completed",
      completedChunks: 2,
      totalChunks: 2,
    });
    expect(extractionReceipts(kv).map((receipt) => receipt.unitId).sort()).toEqual([
      `${sessionId}:map:0`,
      `${sessionId}:map:1`,
    ]);
  });

  it("completes a running map receipt from its exact persisted partial", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_running_map_reconcile";
    const attemptId = "attempt-running-map";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "persisted first chunk" })]);
    const { handler } = setupResumableHandler(kv, provider);
    const originalSet = kv.set.bind(kv);
    let interruptReceiptCompletion = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (
        interruptReceiptCompletion
        && scope.startsWith("mem:extraction-operation-receipt:")
        && (value as { status?: unknown }).status === "succeeded"
      ) {
        interruptReceiptCompletion = false;
        throw new Error("receipt completion interrupted");
      }
      return originalSet(scope, key, value);
    };

    await handler({ sessionId, attemptId, inputHash });
    const recovered = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });

    expect(recovered).toMatchObject({
      status: "in_progress",
      advanced: "completed",
      completedChunks: 1,
      totalChunks: 2,
    });
    expect(provider.calls).toHaveLength(1);
    expect(extractionReceipts(kv)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        unitId: `${sessionId}:map:0`,
        response: expect.objectContaining({
          resultRef: expect.objectContaining({
            scope: expect.stringContaining("summary-resumable-partials"),
            key: "0",
            chunkIndex: 0,
          }),
        }),
      }),
    ]);
  });

  it("rebuilds a missing map receipt from its exact persisted partial", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_missing_map_receipt_with_partial";
    const attemptId = "attempt-missing-map-receipt-with-partial";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "persisted first chunk" })]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    const [receipt] = extractionReceipts(kv);
    await kv.delete(KV.extractionOperationReceipt(receipt.key), receipt.key);

    const recovered = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });

    expect(recovered).toMatchObject({
      status: "in_progress",
      advanced: "completed",
      completedChunks: 1,
      totalChunks: 2,
    });
    expect(provider.calls).toHaveLength(1);
    expect(extractionReceipts(kv)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        unitId: `${sessionId}:map:0`,
        response: expect.objectContaining({
          resultRef: expect.objectContaining({ key: "0", chunkIndex: 0 }),
        }),
      }),
    ]);
  });

  it("does not fall back to an older map receipt when the exact uncertain receipt is missing", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_exact_missing_map";
    const attemptId = "attempt-exact-missing-map";
    const session = await seedSummarySession(kv, sessionId, 3);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "map zero" }),
      summaryXml({ title: "map one" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
    });
    await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:1`,
    });

    const mapOneReceipt = extractionReceipts(kv).find(
      (receipt) => receipt.unitId === `${sessionId}:map:1`,
    );
    expect(mapOneReceipt).toBeDefined();
    await kv.delete(
      KV.extractionOperationReceipt(mapOneReceipt!.key),
      mapOneReceipt!.key,
    );
    const [run] = await kv.list<any>(KV.summaryResumableRuns);
    await kv.delete(KV.summaryResumablePartials(run.id), "1");

    const recovered = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:1`,
      requireExistingReceipt: true,
    });

    expect(recovered).toMatchObject({
      success: false,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("does not create a fresh receipt when reusing an exact committed summary", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_fresh_attempt_reuse";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "shared exact summary" })]);
    const { handler } = setupResumableHandler(kv, provider);

    const first = await handler({
      sessionId,
      attemptId: "attempt-1",
      inputHash,
    });
    const freshReuse = await handler({
      sessionId,
      attemptId: "attempt-2",
      inputHash,
    });
    const recoveredReuse = await handler({
      sessionId,
      attemptId: "attempt-2",
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });
    const missingReceiptReuse = await handler({
      sessionId,
      attemptId: "attempt-3",
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });

    expect(first).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-1",
    });
    expect(freshReuse).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-2",
      runnerInputHash: inputHash,
      summary: { title: "shared exact summary" },
    });
    expect(recoveredReuse).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-2",
      runnerInputHash: inputHash,
      summary: { title: "shared exact summary" },
    });
    expect(missingReceiptReuse).toMatchObject({
      success: true,
      status: "succeeded",
      summary: { title: "shared exact summary" },
    });
    expect(provider.calls).toHaveLength(1);

    const [run] = await kv.list<any>(KV.summaryResumableRuns);
    expect(run).toMatchObject({
      attemptId: "attempt-1",
      attemptInputHash: inputHash,
    });
    expect(freshReuse).toMatchObject({
      serviceInputHash: run.inputHash,
      resumableRunId: run.id,
    });
    expect(recoveredReuse).toMatchObject({
      serviceInputHash: run.inputHash,
      resumableRunId: run.id,
    });
    const receipts = extractionReceipts(kv);
    expect(receipts).toHaveLength(1);
    expect(receipts.map((receipt) => receipt.runId)).toEqual(["attempt-1"]);
    expect(receipts.every((receipt) => receipt.status === "succeeded")).toBe(true);
    expect(receipts.every((receipt) =>
      receipt.response?.resultRef?.scope === KV.summaryResumableRuns
      && receipt.response?.resultRef?.key === run.id)).toBe(true);
  });

  it("does not reopen a committed summary when the compatible model changes", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_generation_config";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "model A summary" }),
      summaryXml({ title: "model B summary" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    process.env.AGENTMEMORY_SUMMARY_MODEL = "model-A";
    const modelA = await handler({
      sessionId,
      attemptId: "attempt-model-a",
      inputHash,
    });

    process.env.AGENTMEMORY_SUMMARY_MODEL = "model-B";
    const modelB = await handler({
      sessionId,
      attemptId: "attempt-model-b",
      inputHash,
    });

    expect(modelA).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-model-a",
      summary: { title: "model A summary" },
    });
    expect(modelB).toMatchObject({
      status: "succeeded",
      attemptId: "attempt-model-b",
      summary: { title: "model A summary" },
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls.map((call) => call.options)).toEqual([
      expect.objectContaining({
        model: "model-A",
        modelSource: "AGENTMEMORY_SUMMARY_MODEL",
      }),
    ]);

    const runs = await kv.list<any>(KV.summaryResumableRuns);
    expect(runs).toHaveLength(1);
    expect(new Set(runs.map((run) => run.generationConfigHash)).size).toBe(1);
    expect(runs.every((run) =>
      typeof run.generationConfigHash === "string"
      && run.generationConfigHash.length === 64)).toBe(true);
    expect(runs.find((run) => run.summary?.title === "model A summary")).toMatchObject({
      attemptId: "attempt-model-a",
    });
    expect(extractionReceipts(kv).map((receipt) => receipt.runId)).toEqual(["attempt-model-a"]);
    expect(await kv.get<any>(KV.summaryResumableActiveRuns, sessionId)).toBeNull();
  });

  it("fails closed when a committed summary effect no longer matches its contribution record", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_committed_summary_drift";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "original summary" })]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId: "attempt-original", inputHash });
    const summary = await kv.get<any>(KV.summaries, sessionId);
    await kv.set(KV.summaries, sessionId, { ...summary, narrative: "tampered" });

    const replay = await handler({ sessionId, attemptId: "attempt-replay", inputHash });

    expect(replay).toMatchObject({
      status: "failed",
      error: "summary_contribution_effect_reconciliation_required",
    });
    expect(provider.calls).toHaveLength(1);
    expect(await kv.list<any>(KV.summaryResumableRuns)).toHaveLength(1);
    expect(extractionReceipts(kv)).toHaveLength(1);
  });

  it("reconciles a contribution write failure after the summary effect and receipt are durable", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_contribution_commit_recovery";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "durable before contribution" })]);
    const originalSet = kv.set;
    let failContributionCommit = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (
        failContributionCommit
        && scope === "extraction-contribution-records:summary:summary/v1"
        && (value as { state?: string }).state === "committed"
      ) {
        failContributionCommit = false;
        throw new Error("injected_contribution_commit_failure");
      }
      return originalSet(scope, key, value);
    };
    const { handler } = setupResumableHandler(kv, provider);

    const first = await handler({ sessionId, attemptId: "attempt-1", inputHash });
    const recovered = await handler({ sessionId, attemptId: "attempt-1", inputHash });

    expect(first.status).toBe("failed");
    expect(recovered).toMatchObject({ status: "succeeded", summary: { title: "durable before contribution" } });
    expect(provider.calls).toHaveLength(1);
    expect(extractionReceipts(kv)).toHaveLength(1);
    expect(await kv.list<any>(KV.summaries)).toHaveLength(1);
    const contributions = await kv.list<any>("extraction-contribution-records:summary:summary/v1");
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({ state: "committed" });
  });

  it("fails closed when the committed receipt points at a missing resumable run", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_missing_committed_run";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "summary with missing run" })]);
    const { handler } = setupResumableHandler(kv, provider);
    await handler({ sessionId, attemptId: "attempt-1", inputHash });
    const [run] = await kv.list<any>(KV.summaryResumableRuns);
    await kv.delete(KV.summaryResumableRuns, run.id);

    const replay = await handler({ sessionId, attemptId: "attempt-2", inputHash });

    expect(replay).toMatchObject({
      status: "failed",
      error: "summary_contribution_effect_reconciliation_required",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("does not dispatch a competing summary model while the source is claimed", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_active_generation_config";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "model A chunk" }),
      summaryXml({ title: "model B chunk" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    process.env.AGENTMEMORY_SUMMARY_MODEL = "model-A";
    const modelA = await handler({
      sessionId,
      attemptId: "attempt-active-a",
      inputHash,
    });
    process.env.AGENTMEMORY_SUMMARY_MODEL = "model-B";
    const modelB = await handler({
      sessionId,
      attemptId: "attempt-active-b",
      inputHash,
    });

    expect(modelA).toMatchObject({ status: "in_progress", completedChunks: 1 });
    expect(modelB).toMatchObject({
      status: "failed",
      error: "extraction_contribution_claimed_by_other",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls.map((call) =>
      (call.options as { model?: string }).model)).toEqual(["model-A"]);
    const runs = await kv.list<any>(KV.summaryResumableRuns);
    expect(runs).toHaveLength(1);
    expect(new Set(runs.map((run) => run.generationConfigHash)).size).toBe(1);
    expect(await kv.get<any>(KV.summaryResumableActiveRuns, sessionId)).toMatchObject({
      runId: runs.find((run) => run.attemptId === "attempt-active-a").id,
    });
  });

  it("requires explicit reconciliation when same-count summary source content changes", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_same_count_changed_content";
    const attemptId = "attempt-same-count";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([summaryXml({ title: "old content summary" })]);
    const { handler } = setupResumableHandler(kv, provider);

    const first = await handler({ sessionId, attemptId, inputHash });
    const [oldObservation] = await kv.list<CompressedObservation>(
      KV.observations(sessionId),
    );
    await kv.set(KV.observations(sessionId), oldObservation.id, {
      ...oldObservation,
      narrative: "changed content with the same observation count",
    });

    const recovered = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });

    expect(first).toMatchObject({
      status: "succeeded",
      attemptId,
      runnerInputHash: inputHash,
    });
    expect(recovered).toMatchObject({
      success: false,
      error: "summary_source_correction_requires_migration",
      failure: {
        class: "hard",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(provider.calls).toHaveLength(1);
    const runs = await kv.list<any>(KV.summaryResumableRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].summary.title).toBe("old content summary");
  });

  it("hard-stops an orphaned v2 summary model receipt instead of replaying that model unit", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_orphaned_receipt";
    const attemptId = "attempt-orphaned";
    const session = await seedSummarySession(kv, sessionId, 1);
    const inputHash = summarySessionInputHash(session);
    const originalSet = kv.set.bind(kv);
    let interruptBeforeResultPersistence = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (
        interruptBeforeResultPersistence
        && scope === KV.summaryResumableRuns
        && (value as { status?: unknown }).status === "succeeded"
      ) {
        interruptBeforeResultPersistence = false;
        throw new Error("summary result persistence interrupted");
      }
      return originalSet(scope, key, value);
    };
    const provider = makeProvider([summaryXml({ title: "must not run" })]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    const result = await handler({ sessionId, attemptId, inputHash });

    expect(result).toMatchObject({
      success: false,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      operationReceipt: {
        status: "running",
        runId: attemptId,
        stage: "summary",
        unitId: `${sessionId}:map:0`,
        runnerInputHash: inputHash,
        startedAt: expect.any(String),
      },
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("does not start a summary model unit when recovery requires a missing receipt", async () => {
    const kv = mockKV();
    const sessionId = "ses_v2_missing_receipt";
    const session = await seedSummarySession(kv, sessionId, 1);
    const provider = makeProvider([summaryXml({ title: "must not run" })]);
    const { handler } = setupResumableHandler(kv, provider);

    const result = await handler({
      sessionId,
      attemptId: "attempt-missing-receipt",
      inputHash: summarySessionInputHash(session),
      operationUnitId: `${sessionId}:map:0`,
      requireExistingReceipt: true,
    });

    expect(result).toMatchObject({
      success: false,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      operationReceiptAbsence: {
        schema: "extraction-operation-receipt-absence/v1",
        key: buildExtractionOperationKey({
          runId: "attempt-missing-receipt",
          stage: "summary",
          unitId: `${sessionId}:map:0`,
        }),
        runId: "attempt-missing-receipt",
        stage: "summary",
        unitId: `${sessionId}:map:0`,
        runnerInputHash: summarySessionInputHash(session),
      },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("hard-stops an orphaned v2 reduce receipt after durable map chunks", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_orphaned_reduce";
    const attemptId = "attempt-orphaned-reduce";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "map-1" }),
      summaryXml({ title: "map-2" }),
      summaryXml({ title: "reduce-must-not-run" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);
    const request = { sessionId, attemptId, inputHash };

    expect((await handler(request)).status).toBe("in_progress");
    expect((await handler(request)).status).toBe("in_progress");
    const [mapReceipt] = extractionReceipts(kv);
    const identity = {
      runId: attemptId,
      stage: "summary" as const,
      unitId: `${sessionId}:reduce`,
      inputHash: mapReceipt.inputHash,
    };
    const receiptKey = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...identity,
      key: receiptKey,
      status: "running",
      startedAt: "2026-07-22T00:00:00.000Z",
    });

    const result = await handler(request);

    expect(result).toMatchObject({
      success: false,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("does not retry a parse failure as a network failure", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_parse_no_network_retry", 1);
    const provider = makeProvider([
      "unparseable response",
      "still unparseable",
      summaryXml({ title: "must not be used" }),
    ]);
    const cooldowns: number[] = [];
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async (delayMs: number) => { cooldowns.push(delayMs); },
      cooldownMs: () => 0,
    });

    const result = await handler({ sessionId: "ses_parse_no_network_retry" });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      failureCause: "parse_failed",
    });
    expect(result.error).toMatch(/^too_many_chunks_skipped:/);
    expect(provider.calls).toHaveLength(2);
    expect(cooldowns).toEqual([]);
  });

  it.each([
    ["pi_stream_failed", "pi_stream_failed", 1],
    ["circuit_breaker_open", "circuit_breaker_open", 1],
    ["fetch failed", "network_error", 1],
    ["provider rejected token=must-not-persist", "provider_failure", 0],
  ])("preserves sanitized failure cause for %s", async (message, expectedCause, expectedCooldowns) => {
    const kv = mockKV();
    await seedSummarySession(kv, `ses_failure_${expectedCause}`, 1);
    const calls: string[] = [];
    const provider: MemoryProvider = {
      name: "test",
      compress: async () => "",
      summarize: async () => {
        calls.push(message);
        throw new Error(message);
      },
    };
    const cooldowns: number[] = [];
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async (delayMs: number) => { cooldowns.push(delayMs); },
      cooldownMs: () => 9,
    });

    const result = await handler({ sessionId: `ses_failure_${expectedCause}` });

    expect(result.failureCause).toBe(expectedCause);
    expect(result.error).toMatch(/^too_many_chunks_skipped:/);
    expect(result.error).not.toContain("must-not-persist");
    expect(calls).toHaveLength(2);
    expect(cooldowns).toHaveLength(expectedCooldowns);
    if (expectedCooldowns > 0) expect(cooldowns).toEqual([9]);
  });

  it.each([
    ["pi_stream_failed", "pi_stream_failed"],
    ["fetch failed", "network_error"],
  ])("keeps the first transient cause when retry encounters an open breaker", async (firstError, expectedCause) => {
    const kv = mockKV();
    const sessionId = `ses_first_cause_${expectedCause}`;
    await seedSummarySession(kv, sessionId, 1);
    const provider = makeProvider([
      new Error(firstError),
      new Error("circuit_breaker_open"),
    ]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    const result = await handler({ sessionId });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      failureCause: expectedCause,
    });
    expect(result.error).toContain(`failure_cause=${expectedCause}`);
  });

  it("uses a stable post-breaker cooldown above 30 seconds with session staggering", async () => {
    const sessionIds = ["ses_cooldown_1", "ses_cooldown_2", "ses_cooldown_3"];
    const firstDelays = new Map<string, number>();

    for (const sessionId of sessionIds) {
      const kv = mockKV();
      await seedSummarySession(kv, sessionId, 1);
      const provider = makeProvider([
        new Error("pi_stream_failed"),
        summaryXml({ title: `recovered-${sessionId}` }),
      ]);
      const { handler } = setupResumableHandler(kv, provider, {
        sleep: async (delayMs: number) => { firstDelays.set(sessionId, delayMs); },
      });
      const result = await handler({ sessionId });
      expect(result.status).toBe("succeeded");
    }

    const delays = [...firstDelays.values()];
    expect(delays).toHaveLength(3);
    expect(delays.every((delayMs) => delayMs >= 31_000 && delayMs <= 36_000)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(1);

    const kv = mockKV();
    await seedSummarySession(kv, sessionIds[0], 1);
    const repeatDelays: number[] = [];
    const provider = makeProvider([
      new Error("network timeout"),
      summaryXml({ title: "recovered-repeat" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async (delayMs: number) => { repeatDelays.push(delayMs); },
    });
    await handler({ sessionId: sessionIds[0] });
    expect(repeatDelays).toEqual([firstDelays.get(sessionIds[0])]);
  });

  it("cools down and recovers three concurrent transient failures", async () => {
    const kv = mockKV();
    const sessionIds = ["ses_transient_1", "ses_transient_2", "ses_transient_3"];
    for (const sessionId of sessionIds) await seedSummarySession(kv, sessionId, 1);
    let calls = 0;
    const cooldowns: number[] = [];
    const provider: MemoryProvider = {
      name: "test",
      compress: async () => "",
      summarize: async () => {
        calls += 1;
        if (calls <= 3) throw new Error("pi_stream_failed");
        return summaryXml({ title: `recovered-${calls}` });
      },
    };
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async (delayMs: number) => { cooldowns.push(delayMs); },
      cooldownMs: () => 7,
    });

    const results = await Promise.all(
      sessionIds.map((sessionId) => handler({ sessionId })),
    );

    expect(results.every((result) => result.status === "succeeded")).toBe(true);
    expect(calls).toBe(6);
    expect(cooldowns).toEqual([7, 7, 7]);
  });

  it("reports one completed advance for a 22 chunk summary step", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_22_chunks", 22);
    const provider = makeProvider([summaryXml({ title: "chunk-1" })]);
    const { handler } = setupResumableHandler(kv, provider);

    const result = await handler({ sessionId: "ses_22_chunks" });

    expect(provider.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "in_progress",
      advanced: "completed",
      completedChunks: 1,
      skippedChunks: 0,
      totalChunks: 22,
    });
    expect(result.failure).toBeUndefined();
  });

  it("reports the current transient failure when one 22 chunk step is skipped", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_22_transient", 22);
    const provider = makeProvider([
      new ProviderCallError("pi_stream_failed", {
        providerErrorCode: "network_error",
        elapsedMs: 12,
        inputChars: 34,
        maxOutputTokens: 4096,
        responseStarted: false,
      }),
      new Error("pi_stream_failed"),
    ]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    const result = await handler({ sessionId: "ses_22_transient" });

    expect(provider.calls).toHaveLength(2);
    expect(result).toMatchObject({
      status: "in_progress",
      advanced: "skipped",
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
      completedChunks: 0,
      skippedChunks: 1,
      totalChunks: 22,
    });
  });

  it("keeps the first chunk failure cause and its matching diagnostics atomically", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_chunk_diagnostics", 1);
    const first = new ProviderCallError("pi_stream_failed", {
      providerErrorCode: "rate_limited",
      statusCode: 429,
      retryAfterMs: 1000,
      elapsedMs: 11,
      inputChars: 101,
      maxOutputTokens: 4096,
      responseStarted: false,
      responseModel: "model-first",
      stopReason: "error",
    });
    const current = new ProviderCallError("circuit_breaker_open", {
      providerErrorCode: "server_error",
      elapsedMs: 22,
      inputChars: 102,
      maxOutputTokens: 4096,
      responseStarted: true,
      responseModel: "model-current",
      stopReason: "error",
    });
    const provider = makeProvider([first, current]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    const result = await handler({ sessionId: "ses_chunk_diagnostics" });

    expect(result.failure).toEqual({
      class: "transient_provider",
      cause: "pi_stream_failed",
      diagnostics: {
        requestPhase: "chunk",
        providerErrorCode: "rate_limited",
        statusCode: 429,
        retryAfterMs: 1000,
        elapsedMs: 11,
        inputChars: 101,
        maxOutputTokens: 4096,
        responseStarted: false,
        responseModel: "model-first",
        stopReason: "error",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("narrative for obs");
  });

  it("does not attach later provider diagnostics to an earlier parse failure", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_parse_then_provider", 1);
    const providerFailure = new ProviderCallError("pi_stream_failed", {
      providerErrorCode: "timeout",
      elapsedMs: 22,
      inputChars: 102,
      maxOutputTokens: 4096,
      responseStarted: false,
      responseModel: "model-provider",
      stopReason: "error",
    });
    const provider = makeProvider(["<garbage/>", providerFailure]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    const result = await handler({ sessionId: "ses_parse_then_provider" });

    expect(result.failure).toEqual({
      class: "unit",
      cause: "parse_failed",
    });
  });

  it("does not reuse the previous invocation failure when retrying a skipped chunk", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_current_failure", 22);
    const provider = makeProvider([
      new Error("pi_stream_failed"),
      new Error("pi_stream_failed"),
      new Error("pi_auth_failed"),
      new Error("pi_auth_failed"),
    ]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    const first = await handler({ sessionId: "ses_current_failure" });
    const second = await handler({ sessionId: "ses_current_failure" });

    expect(first.failure).toEqual({ class: "transient_provider", cause: "pi_stream_failed" });
    expect(second).toMatchObject({
      advanced: "skipped",
      failure: { class: "hard", cause: "pi_auth_failed" },
    });
  });

  it("reports reduced once and none when an already succeeded run is read again", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_reduce_advance", 2);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      summaryXml({ title: "reduced" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_reduce_advance" });
    await handler({ sessionId: "ses_reduce_advance" });
    const reduced = await handler({ sessionId: "ses_reduce_advance" });
    const repeated = await handler({ sessionId: "ses_reduce_advance" });

    expect(reduced).toMatchObject({ status: "succeeded", advanced: "reduced" });
    expect(repeated).toMatchObject({ status: "succeeded", advanced: "none" });
    expect(provider.calls).toHaveLength(3);
  });

  it("classifies the current reduce failure without claiming an advance", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_reduce_failure", 2);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new Error("pi_stream_failed"),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_reduce_failure" });
    await handler({ sessionId: "ses_reduce_failure" });
    const failed = await handler({ sessionId: "ses_reduce_failure" });

    expect(failed).toMatchObject({
      status: "failed",
      advanced: "none",
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
    });
  });

  it("marks a provider failure from the final merge as reduce diagnostics", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_reduce_diagnostics", 2);
    const reduceError = new ProviderCallError("pi_stream_failed", {
      providerErrorCode: "server_error",
      statusCode: 503,
      retryAfterMs: 2000,
      elapsedMs: 33,
      inputChars: 103,
      maxOutputTokens: 4096,
      responseStarted: false,
      responseModel: "model-reduce",
      stopReason: "error",
    });
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      reduceError,
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_reduce_diagnostics" });
    await handler({ sessionId: "ses_reduce_diagnostics" });
    const failed = await handler({ sessionId: "ses_reduce_diagnostics" });

    expect(failed.failure).toEqual({
      class: "transient_provider",
      cause: "pi_stream_failed",
      phase: "provider_call",
      diagnostics: {
        requestPhase: "reduce",
        providerErrorCode: "server_error",
        statusCode: 503,
        retryAfterMs: 2000,
        elapsedMs: 33,
        inputChars: 103,
        maxOutputTokens: 4096,
        responseStarted: false,
        responseModel: "model-reduce",
        stopReason: "error",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("narrative for obs");
  });

  it.each(["timeout", "network_error", "server_error"] as const)(
    "classifies ordinary provider errors with %s diagnostics as transient provider failures",
    async (providerErrorCode) => {
      process.env.SUMMARIZE_CHUNK_SIZE = "1";
      const kv = mockKV();
      const sessionId = `ses_diagnostic_${providerErrorCode}`;
      const attemptId = `attempt_diagnostic_${providerErrorCode}`;
      const session = await seedSummarySession(kv, sessionId, 2);
      const provider = makeProvider([
        summaryXml({ title: "chunk-1" }),
        summaryXml({ title: "chunk-2" }),
        new ProviderCallError("ordinary provider error", {
          providerErrorCode,
          elapsedMs: 5,
          inputChars: 40,
          maxOutputTokens: 4096,
          responseStarted: false,
        }),
      ]);
      const { handler } = setupResumableHandler(kv, provider);

      await handler({ sessionId, attemptId, inputHash: summarySessionInputHash(session) });
      await handler({ sessionId, attemptId, inputHash: summarySessionInputHash(session) });
      const failed = await handler({ sessionId, attemptId, inputHash: summarySessionInputHash(session) });

      expect(failed.failure).toMatchObject({
        class: "transient_provider",
        diagnostics: { providerErrorCode },
      });
    },
  );

  it("reopens a server-error reduce receipt when diagnostics classify it as transient", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_server_error_reduce_retry";
    const attemptId = "attempt-server-error-reduce-retry";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new ProviderCallError("ordinary provider error", {
        providerErrorCode: "server_error",
        elapsedMs: 5,
        inputChars: 40,
        maxOutputTokens: 4096,
        responseStarted: false,
      }),
      summaryXml({ title: "reduced after server retry" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    await handler({ sessionId, attemptId, inputHash });
    const failed = await handler({ sessionId, attemptId, inputHash });
    const resumed = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:reduce`,
      requireExistingReceipt: true,
    });

    expect(failed).toMatchObject({
      failure: {
        class: "transient_provider",
        phase: "provider_call",
        diagnostics: { providerErrorCode: "server_error" },
      },
    });
    expect(resumed).toMatchObject({ status: "succeeded", summary: { title: "reduced after server retry" } });
    expect(extractionReceipts(kv).find((entry) => entry.unitId === `${sessionId}:reduce`)).toMatchObject({
      status: "succeeded",
      retry: { epoch: 1, lastSafeFailure: { cause: "provider_failure" } },
    });
  });

  it("returns a structured hard failure for a real map preflight error", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_map_preflight", 1);
    const provider = makeProvider([new ProviderPreflightError({
      operation: "summarize",
      callRole: "map",
      callIndex: 0,
      durationMs: 0,
      metadataStatus: "unsupported",
      providerInvoked: false,
      preflightBlocked: true,
      reason: "context_window_exceeded",
      promptChars: 500,
    })]);
    const { handler } = setupResumableHandler(kv, provider);

    const result = await handler({ sessionId: "ses_map_preflight" });

    expect(result).toMatchObject({
      status: "infeasible",
      advanced: "none",
      failure: { class: "hard", cause: "context_window_exceeded" },
    });
  });

  it("returns a structured hard failure for a real reduce preflight error", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    await seedSummarySession(kv, "ses_reduce_preflight", 2);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new ProviderPreflightError({
        operation: "summarize",
        callRole: "reduce",
        callIndex: 2,
        durationMs: 0,
        metadataStatus: "unsupported",
        providerInvoked: false,
        preflightBlocked: true,
        reason: "provider_drift",
        promptChars: 500,
      }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_reduce_preflight" });
    await handler({ sessionId: "ses_reduce_preflight" });
    const result = await handler({ sessionId: "ses_reduce_preflight" });

    expect(result).toMatchObject({
      status: "preflight_unavailable",
      advanced: "none",
      failure: { class: "hard", cause: "provider_drift" },
    });
  });

  it("finalizes a receipt-wrapped reduce preflight failure without reconciliation", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reduce_preflight_receipt";
    const attemptId = "attempt-reduce-preflight-receipt";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new ProviderPreflightError({
        operation: "summarize",
        callRole: "reduce",
        callIndex: 2,
        durationMs: 0,
        metadataStatus: "unsupported",
        providerInvoked: false,
        preflightBlocked: true,
        reason: "provider_drift",
        promptChars: 500,
      }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    await handler({ sessionId, attemptId, inputHash });
    const failed = await handler({ sessionId, attemptId, inputHash });

    expect(failed).toMatchObject({
      status: "failed",
      failure: {
        class: "hard",
        cause: "provider_drift",
        phase: "provider_preflight",
      },
      recoveryEvidence: {
        kind: "no_effect",
        observation: "execution_error",
        reasonCode: "provider_drift",
        proof: {
          kind: "receipt_before_formal_effect",
          receiptVersion: 1,
          phase: "preflight",
          commitPlanAbsent: true,
        },
      },
    });
    const receipt = extractionReceipts(kv).find(
      (entry) => entry.unitId === `${sessionId}:reduce`,
    );
    expect(receipt).toMatchObject({
      version: 1,
      status: "failed",
      failure: {
        class: "hard",
        cause: "provider_drift",
        phase: "provider_preflight",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("narrative for obs");
  });

  it("anchors Retry-After evidence to the durable receipt completion time", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_retry_after_receipt";
    const attemptId = "attempt-retry-after-receipt";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new ProviderCallError("pi_stream_failed", {
        providerErrorCode: "rate_limited",
        statusCode: 429,
        retryAfterMs: 2500,
        elapsedMs: 15,
        inputChars: 120,
        maxOutputTokens: 4096,
        responseStarted: false,
      }),
      new ProviderCallError("pi_stream_failed", {
        providerErrorCode: "rate_limited",
        statusCode: 429,
        retryAfterMs: 2500,
        elapsedMs: 16,
        inputChars: 120,
        maxOutputTokens: 4096,
        responseStarted: false,
      }),
    ]);
    const { handler } = setupResumableHandler(kv, provider, {
      sleep: async () => {},
      cooldownMs: () => 0,
    });

    await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
    });
    await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:1`,
    });
    const failed = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:reduce`,
    });
    const receipt = extractionReceipts(kv).find(
      (entry) => entry.unitId === `${sessionId}:reduce`,
    );
    const expectedNotBefore = new Date(
      Date.parse(receipt!.completedAt!) + 2500,
    ).toISOString();

    expect(failed).toMatchObject({
      status: "failed",
      recoveryEvidence: {
        kind: "no_effect",
        observation: "execution_error",
        reasonCode: "pi_stream_failed",
        retryHint: { notBefore: expectedNotBefore },
      },
    });
    expect(receipt).toMatchObject({
      status: "failed",
      failure: {
        diagnostics: { retryAfterMs: 2500 },
      },
    });
  });

  it("reopens only a receipt-wrapped transient reduce failure with the same identity", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reduce_retry_receipt";
    const attemptId = "attempt-reduce-retry-receipt";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new Error("pi_stream_failed"),
      summaryXml({ title: "reduced after retry" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    await handler({ sessionId, attemptId, inputHash });
    const transient = await handler({ sessionId, attemptId, inputHash });
    const resumed = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:reduce`,
      requireExistingReceipt: true,
    });

    expect(transient).toMatchObject({
      status: "failed",
      failure: {
        class: "transient_provider",
        cause: "pi_stream_failed",
        phase: "provider_call",
      },
    });
    expect(resumed).toMatchObject({
      status: "succeeded",
      summary: { title: "reduced after retry" },
    });
    expect(provider.calls).toHaveLength(4);
    const receipt = extractionReceipts(kv).find(
      (entry) => entry.unitId === `${sessionId}:reduce`,
    );
    expect(receipt).toMatchObject({
      status: "succeeded",
      retry: {
        epoch: 1,
        lastSafeFailure: {
          phase: "provider_call",
          errorClass: "transient_provider",
          cause: "pi_stream_failed",
          timestamp: expect.any(String),
        },
      },
    });
  });

  it("rebinds a proved no-effect reduce failure to the next immutable attempt", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reduce_next_attempt";
    const firstAttemptId = "attempt-reduce-first";
    const nextAttemptId = "attempt-reduce-next";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      new Error("pi_stream_failed"),
      summaryXml({ title: "reduced on next attempt" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({
      sessionId,
      attemptId: firstAttemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:0`,
    });
    await handler({
      sessionId,
      attemptId: firstAttemptId,
      inputHash,
      operationUnitId: `${sessionId}:map:1`,
    });
    const failed = await handler({
      sessionId,
      attemptId: firstAttemptId,
      inputHash,
      operationUnitId: `${sessionId}:reduce`,
    });
    const priorReceipts = extractionReceipts(kv);
    expect(priorReceipts.map((receipt) => ({
      status: receipt.status,
      failure: receipt.failure,
    }))).toEqual([
      expect.objectContaining({ status: "succeeded" }),
      expect.objectContaining({ status: "succeeded" }),
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({
          class: "transient_provider",
          phase: "provider_call",
        }),
      }),
    ]);
    const resumed = await handler({
      sessionId,
      attemptId: nextAttemptId,
      inputHash,
      operationUnitId: `${sessionId}:reduce`,
    });

    expect(failed).toMatchObject({
      status: "failed",
      recoveryEvidence: {
        kind: "no_effect",
        observation: "execution_error",
      },
    });
    expect(resumed).toMatchObject({
      status: "succeeded",
      attemptId: nextAttemptId,
      summary: { title: "reduced on next attempt" },
      recoveryEvidence: { kind: "committed" },
    });
    expect(provider.calls).toHaveLength(4);
  });

  it("reopens a safe pre-persistence reduce failure without repeating map work", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reduce_before_persist";
    const attemptId = "attempt-reduce-before-persist";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      summaryXml({ title: "first reduce" }),
      summaryXml({ title: "second reduce" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    await handler({ sessionId, attemptId, inputHash });
    vi.mocked(validateOutput).mockImplementationOnce(() => {
      throw new Error("validator interrupted");
    });
    const failed = await handler({ sessionId, attemptId, inputHash });
    const resumed = await handler({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId: `${sessionId}:reduce`,
      requireExistingReceipt: true,
    });

    expect(failed).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "summary_reduce_before_final_persistence_failed",
        phase: "before_final_persistence",
      },
    });
    expect(resumed).toMatchObject({
      status: "succeeded",
      summary: { title: "second reduce" },
    });
    expect(provider.calls).toHaveLength(4);
  });

  it("does not claim no-effect when a formal Summary already exists", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reduce_existing_formal_summary";
    const attemptId = "attempt-reduce-existing-formal-summary";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      summaryXml({ title: "reduce" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    await handler({ sessionId, attemptId, inputHash });
    await kv.set(KV.summaries, sessionId, {
      sessionId,
      title: "already persisted",
    });
    vi.mocked(validateOutput).mockImplementationOnce(() => {
      throw new Error("validator interrupted");
    });
    const failed = await handler({ sessionId, attemptId, inputHash });

    expect(failed).toMatchObject({
      status: "failed",
      failure: {
        cause: "summary_reduce_before_final_persistence_failed",
        phase: "before_final_persistence",
      },
    });
    expect(failed.recoveryEvidence).toBeUndefined();
  });

  it("keeps a receipt running only when the final reduce persistence is uncertain", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reduce_persist_uncertain";
    const attemptId = "attempt-reduce-persist-uncertain";
    const session = await seedSummarySession(kv, sessionId, 2);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      summaryXml({ title: "chunk-1" }),
      summaryXml({ title: "chunk-2" }),
      summaryXml({ title: "reduce" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId, attemptId, inputHash });
    await handler({ sessionId, attemptId, inputHash });
    const originalSet = kv.set.bind(kv);
    let interrupt = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (interrupt && scope === KV.summaryResumableRuns && (value as { status?: string }).status === "succeeded") {
        interrupt = false;
        throw new Error("final persistence interrupted");
      }
      return originalSet(scope, key, value);
    };

    const failed = await handler({ sessionId, attemptId, inputHash });
    const receipt = extractionReceipts(kv).find(
      (entry) => entry.unitId === `${sessionId}:reduce`,
    );

    expect(failed).toMatchObject({
      failure: { cause: "extraction_operation_reconciliation_required" },
    });
    expect(receipt).toMatchObject({
      status: "running",
      uncertainty: {
        phase: "final_result_persistence",
        errorClass: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
        timestamp: expect.any(String),
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("final persistence interrupted");
    expect(JSON.stringify(failed)).not.toContain("final persistence interrupted");
    expect(provider.calls).toHaveLength(3);
  });

  it("resumes a reconciled reduce receipt after seventeen durable partials without repeating map", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const sessionId = "ses_v2_reconciled_reduce_17";
    const attemptId = "attempt-reconciled-reduce-17";
    const session = await seedSummarySession(kv, sessionId, 17);
    const inputHash = summarySessionInputHash(session);
    const provider = makeProvider([
      ...Array.from({ length: 17 }, (_, index) => summaryXml({ title: `chunk-${index}` })),
      summaryXml({ title: "recovered reduce" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    for (let index = 0; index < 17; index += 1) {
      await handler({ sessionId, attemptId, inputHash });
    }
    const mapReceipt = extractionReceipts(kv)[0];
    const reduceIdentity = {
      runId: attemptId,
      stage: "summary" as const,
      unitId: `${sessionId}:reduce`,
      inputHash: mapReceipt.inputHash,
    };
    const reduceKey = buildExtractionOperationKey(reduceIdentity);
    await kv.set(KV.extractionOperationReceipt(reduceKey), reduceKey, {
      ...reduceIdentity,
      key: reduceKey,
      status: "reconciled",
      startedAt: "2026-07-27T00:00:00.000Z",
      completedAt: "2026-07-27T00:01:00.000Z",
      failure: { class: "transient_runtime", cause: "orphaned_operation_result_absent" },
      reconciliation: {
        id: "xrec_0123456789abcdef0123456789abcdef",
        at: "2026-07-27T00:01:00.000Z",
        resultStatus: "absent",
        resumableRunId: "test",
      },
    });

    const result = await handler({ sessionId, attemptId, inputHash });
    const [run] = await kv.list<any>(KV.summaryResumableRuns);

    expect(result).toMatchObject({ status: "succeeded", summary: { title: "recovered reduce" } });
    expect(run).toMatchObject({ status: "succeeded", completedChunks: 17, summary: { title: "recovered reduce" } });
    expect(await kv.get<any>(KV.summaries, sessionId)).toMatchObject({ title: "recovered reduce" });
    expect(provider.calls).toHaveLength(18);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("executes only one chunk work unit per call", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_step", 250);
    const provider = makeProvider([summaryXml({ title: "Chunk 1" })]);
    const { handler } = setupResumableHandler(kv, provider);

    const result = await handler({ sessionId: "ses_step" });

    expect(provider.calls).toHaveLength(1);
    expect(result).toEqual({
      success: true,
      status: "in_progress",
      advanced: "completed",
      completedChunks: 1,
      totalChunks: 3,
      skippedChunks: 0,
      telemetry: [
        expect.objectContaining({
          operation: "summarize",
          callRole: "map",
          callIndex: expect.stringContaining(":map:0:0"),
          metadataStatus: "unsupported",
        }),
      ],
    });
  });

  it("resumes from persisted partials after the service is rebuilt", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_rebuild", 250);
    const firstProvider = makeProvider([summaryXml({ title: "Chunk 1" })]);
    const firstService = setupResumableHandler(kv, firstProvider);

    await firstService.handler({ sessionId: "ses_rebuild" });

    const secondProvider = makeProvider([summaryXml({ title: "Chunk 2" })]);
    const rebuiltService = setupResumableHandler(kv, secondProvider);
    const result = await rebuiltService.handler({ sessionId: "ses_rebuild" });

    expect(firstProvider.calls).toHaveLength(1);
    expect(secondProvider.calls).toHaveLength(1);
    expect(result).toMatchObject({
      success: true,
      status: "in_progress",
      completedChunks: 2,
      totalChunks: 3,
      skippedChunks: 0,
    });
  });

  it("resumes an existing non-evaluation partial under the legacy run ID", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_legacy_run_id", 250);
    const firstProvider = makeProvider([summaryXml({ title: "Chunk 1" })]);
    const firstService = setupResumableHandler(kv, firstProvider);

    await firstService.handler({ sessionId: "ses_legacy_run_id" });

    const [createdRun] = await kv.list<any>("summary-resumable-runs");
    expect(createdRun.generationConfigHash).toBeUndefined();
    const legacyRunId = `sumr_${createHash("sha256")
      .update(JSON.stringify({
        chunkSize: createdRun.chunkSize,
        inputHash: createdRun.inputHash,
        sessionId: createdRun.sessionId,
      }))
      .digest("hex")
      .slice(0, 24)}`;
    const partials = kv.store.get(`summary-resumable-partials:${createdRun.id}`)!;
    await kv.set("summary-resumable-runs", legacyRunId, {
      ...createdRun,
      id: legacyRunId,
    });
    for (const [partialId, partial] of partials) {
      await kv.set(`summary-resumable-partials:${legacyRunId}`, partialId, partial);
    }
    await kv.delete("summary-resumable-runs", createdRun.id);
    await kv.delete("summary-resumable-active-runs", "ses_legacy_run_id");

    const secondProvider = makeProvider([summaryXml({ title: "Chunk 2" })]);
    const rebuiltService = setupResumableHandler(kv, secondProvider);
    const result = await rebuiltService.handler({ sessionId: "ses_legacy_run_id" });

    expect(createdRun.id).toBe(legacyRunId);
    expect(result).toMatchObject({
      success: true,
      status: "in_progress",
      completedChunks: 2,
      totalChunks: 3,
      skippedChunks: 0,
    });
    expect(secondProvider.calls[0].user).toContain("obs 100");
    expect(secondProvider.calls[0].user).not.toContain("obs 0");
  });

  it("uses distinct resumable run IDs for different summary treatments", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_treatment_run_ids", 250);
    process.env.AGENTMEMORY_EVALUATION_MODE = "context-strategy";
    process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE = "summary";
    process.env.AGENTMEMORY_SUMMARY_CONTEXT_TREATMENT = JSON.stringify({
      boundaryPolicy: "current-turn-aware",
      inputTarget: { kind: "observation-count", targetObservations: 100 },
    });
    const treatmentA = setupResumableHandler(
      kv,
      makeProvider([summaryXml({ title: "Treatment A" })]),
    );

    await treatmentA.handler({ sessionId: "ses_treatment_run_ids" });
    const [runA] = await kv.list<any>("summary-resumable-runs");
    await kv.delete("summary-resumable-active-runs", "ses_treatment_run_ids");

    process.env.AGENTMEMORY_SUMMARY_CONTEXT_TREATMENT = JSON.stringify({
      boundaryPolicy: "atomic-turn",
      inputTarget: { kind: "observation-count", targetObservations: 100 },
    });
    const treatmentB = setupResumableHandler(
      kv,
      makeProvider([summaryXml({ title: "Treatment B" })]),
    );

    await treatmentB.handler({ sessionId: "ses_treatment_run_ids" });
    const runIds = (await kv.list<any>("summary-resumable-runs"))
      .map((run) => run.id);

    expect(runIds).toHaveLength(2);
    expect(runIds).toContain(runA.id);
    expect(new Set(runIds)).toHaveLength(2);
  });

  it("retries a skipped chunk and recovers a legacy too-many-skips terminal run", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_retry_skip", 1);
    const provider = makeProvider([
      "garbage one",
      "garbage two",
      summaryXml({ title: "Recovered single chunk" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    const first = await handler({ sessionId: "ses_retry_skip" });
    const [legacyRun] = await kv.list<any>("summary-resumable-runs");
    expect(legacyRun.status).toBe("in_progress");
    await kv.set("summary-resumable-runs", legacyRun.id, {
      ...legacyRun,
      status: "failed",
      lastError:
        "too_many_chunks_skipped: 1/1 chunks failed to parse after retry",
    });

    const resumed = await handler({ sessionId: "ses_retry_skip" });

    expect(first).toMatchObject({
      success: false,
      status: "failed",
      completedChunks: 0,
      totalChunks: 1,
      skippedChunks: 1,
    });
    expect(resumed).toMatchObject({
      success: true,
      status: "succeeded",
      completedChunks: 1,
      totalChunks: 1,
      skippedChunks: 0,
      summary: { title: "Recovered single chunk" },
    });
    expect(provider.calls).toHaveLength(3);
  });

  it("keeps an in-progress run bound when new observations are appended", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_append", 250);
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1" }),
      summaryXml({ title: "Chunk 2" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_append" });
    const appended = makeObs(250, "ses_append");
    await kv.set("obs:ses_append", appended.id, appended);
    const resumed = await handler({ sessionId: "ses_append" });

    expect(resumed).toMatchObject({
      success: true,
      status: "in_progress",
      completedChunks: 2,
      totalChunks: 3,
      skippedChunks: 0,
    });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].user).toContain("obs 100");
    expect(provider.calls[1].user).not.toContain("obs 250");
    const [run] = await kv.list<any>("summary-resumable-runs");
    expect(run.observationIds).toHaveLength(250);
    expect(run.chunkObservationCounts).toEqual([100, 100, 50]);
    expect(
      await kv.get<any>("summary-resumable-active-runs", "ses_append"),
    ).toMatchObject({ runId: run.id, inputHash: run.inputHash });
  });

  it("runs the final reduce as one step, persists it, and is idempotent", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_reduce", 250);
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1", decisions: ["d1"] }),
      summaryXml({ title: "Chunk 2", decisions: ["d2"] }),
      summaryXml({ title: "Chunk 3", decisions: ["d3"] }),
      summaryXml({ title: "Merged", decisions: ["d1", "d2", "d3"] }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_reduce" });
    await handler({ sessionId: "ses_reduce" });
    const chunksComplete = await handler({ sessionId: "ses_reduce" });
    const result = await handler({ sessionId: "ses_reduce" });

    expect(chunksComplete).toMatchObject({
      status: "in_progress",
      completedChunks: 3,
      totalChunks: 3,
    });
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[3].system).toContain("merging multiple partial summaries");
    expect(result).toMatchObject({
      success: true,
      status: "succeeded",
      completedChunks: 3,
      totalChunks: 3,
      skippedChunks: 0,
      summary: {
        title: "Merged",
        observationCount: 250,
      },
    });
    expect(Object.keys(result).sort()).toEqual([
      "advanced",
      "completedChunks",
      "skippedChunks",
      "status",
      "success",
      "summary",
      "telemetry",
      "totalChunks",
    ]);
    const stored = await kv.get<any>("summaries", "ses_reduce");
    expect(stored?.title).toBe("Merged");

    const repeated = await handler({ sessionId: "ses_reduce" });
    expect(repeated).toMatchObject({
      success: true,
      status: "succeeded",
      summary: { title: "Merged", observationCount: 250 },
    });
    expect(repeated.telemetry).toBeUndefined();
    expect(provider.calls).toHaveLength(4);
  });

  it("does not repeat a completed reduce when the final summary write is interrupted", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_reduce_repair", 250);
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1" }),
      summaryXml({ title: "Chunk 2" }),
      summaryXml({ title: "Chunk 3" }),
      summaryXml({ title: "Merged after repair" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_reduce_repair" });
    await handler({ sessionId: "ses_reduce_repair" });
    await handler({ sessionId: "ses_reduce_repair" });

    const originalSet = kv.set;
    let interruptSummaryWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === "summaries" && interruptSummaryWrite) {
        interruptSummaryWrite = false;
        throw new Error("summary write interrupted");
      }
      return originalSet(scope, key, data);
    };

    const interrupted = await handler({ sessionId: "ses_reduce_repair" });
    const resumed = await handler({ sessionId: "ses_reduce_repair" });

    expect(interrupted).toMatchObject({
      success: false,
      status: "failed",
      error: "summary write interrupted",
    });
    expect(resumed).toMatchObject({
      success: true,
      status: "succeeded",
      summary: { title: "Merged after repair" },
    });
    expect(provider.calls).toHaveLength(4);
    const stored = await kv.get<any>("summaries", "ses_reduce_repair");
    expect(stored?.title).toBe("Merged after repair");
  });

  it("does not reuse partials when the summary input hash changes", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_changed", 250);
    const provider = makeProvider([
      summaryXml({ title: "Old input chunk" }),
      summaryXml({ title: "New input chunk" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_changed" });
    await kv.set("obs:ses_changed", "obs_0", {
      ...makeObs(0, "ses_changed"),
      title: "changed observation",
    });
    const result = await handler({ sessionId: "ses_changed" });

    expect(provider.calls).toHaveLength(2);
    expect(result).toMatchObject({
      status: "in_progress",
      completedChunks: 1,
      totalChunks: 3,
      skippedChunks: 0,
    });
    const partialScopes = Array.from(kv.store.keys()).filter((scope) =>
      scope.startsWith("summary-resumable-partials:"),
    );
    expect(partialScopes).toHaveLength(2);
  });

  it("summarizes a small session in one step without a reduce call", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_small_step", 10);
    const provider = makeProvider([summaryXml({ title: "Small summary" })]);
    const { handler } = setupResumableHandler(kv, provider);

    const result = await handler({ sessionId: "ses_small_step" });

    expect(provider.calls).toHaveLength(1);
    expect(result).toMatchObject({
      success: true,
      status: "succeeded",
      completedChunks: 1,
      totalChunks: 1,
      skippedChunks: 0,
      summary: { title: "Small summary", observationCount: 10 },
    });
    expect(provider.calls[0].system).toContain("session summarizer");
    expect(provider.calls[0].system).not.toContain("merging multiple partial summaries");
  });

  it("commits a persisted single-chunk partial without calling reduce", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_single_partial", 1);
    const provider = makeProvider([
      summaryXml({ title: "Persisted single partial" }),
      summaryXml({ title: "Unexpected reduce" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);
    const originalSet = kv.set;
    let interruptRunCompletion = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (
        scope === "summary-resumable-runs" &&
        (data as { status?: string }).status === "succeeded" &&
        interruptRunCompletion
      ) {
        interruptRunCompletion = false;
        throw new Error("run completion interrupted");
      }
      return originalSet(scope, key, data);
    };

    await handler({ sessionId: "ses_single_partial" }).catch(() => undefined);
    const resumed = await handler({ sessionId: "ses_single_partial" });

    expect(resumed).toMatchObject({
      success: true,
      status: "succeeded",
      completedChunks: 1,
      totalChunks: 1,
      skippedChunks: 0,
      summary: { title: "Persisted single partial" },
    });
    expect(provider.calls).toHaveLength(1);
    expect(
      await kv.get<any>("summaries", "ses_single_partial"),
    ).toMatchObject({ title: "Persisted single partial" });
  });

  it("regenerates a single-chunk summary after final validation fails", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_single_validation_retry", 1);
    const provider = makeProvider([
      summaryXml({ title: "Invalid single partial" }),
      summaryXml({ title: "Recovered single partial" }),
    ]);
    vi.mocked(validateOutput)
      .mockReturnValueOnce({
        valid: false,
        result: { errors: [{ message: "invalid summary" }] },
      } as any)
      .mockReturnValue({ valid: true, result: { errors: [] } } as any);
    const { handler } = setupResumableHandler(kv, provider);

    const failed = await handler({ sessionId: "ses_single_validation_retry" });
    const resumed = await handler({ sessionId: "ses_single_validation_retry" });

    expect(failed).toMatchObject({
      success: false,
      status: "failed",
      failureCause: "parse_failed",
    });
    expect(resumed).toMatchObject({
      success: true,
      status: "succeeded",
      summary: { title: "Recovered single partial" },
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("repairs a persisted single-chunk validation failure before retrying", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_legacy_single_validation", 1);
    const provider = makeProvider([
      summaryXml({ title: "Legacy invalid partial" }),
      summaryXml({ title: "Recovered legacy partial" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);
    const originalSet = kv.set;
    let interruptRunCompletion = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (
        scope === "summary-resumable-runs" &&
        (data as { status?: string }).status === "succeeded" &&
        interruptRunCompletion
      ) {
        interruptRunCompletion = false;
        throw new Error("run completion interrupted");
      }
      return originalSet(scope, key, data);
    };

    await handler({ sessionId: "ses_legacy_single_validation" }).catch(() => undefined);
    const [run] = await kv.list<any>("summary-resumable-runs");
    await kv.set("summary-resumable-runs", run.id, {
      ...run,
      status: "failed",
      completedChunks: 1,
      skippedChunks: 0,
      lastError: "validation_failed",
    });

    const resumed = await handler({ sessionId: "ses_legacy_single_validation" });

    expect(resumed).toMatchObject({
      success: true,
      status: "succeeded",
      summary: { title: "Recovered legacy partial" },
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("retries a skipped multi-chunk partial before advancing", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_step_skip", 250);
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1" }),
      "garbage one",
      "garbage two",
      summaryXml({ title: "Recovered chunk 2" }),
      summaryXml({ title: "Chunk 3" }),
      summaryXml({ title: "Merged after retry" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_step_skip" });
    const skipped = await handler({ sessionId: "ses_step_skip" });
    const retried = await handler({ sessionId: "ses_step_skip" });
    await handler({ sessionId: "ses_step_skip" });
    const result = await handler({ sessionId: "ses_step_skip" });

    expect(skipped).toMatchObject({
      success: true,
      status: "in_progress",
      completedChunks: 1,
      totalChunks: 3,
      skippedChunks: 1,
    });
    expect(retried).toMatchObject({
      success: true,
      status: "in_progress",
      completedChunks: 2,
      totalChunks: 3,
      skippedChunks: 0,
    });
    expect(provider.calls).toHaveLength(6);
    expect(result).toMatchObject({
      success: true,
      status: "succeeded",
      completedChunks: 3,
      totalChunks: 3,
      skippedChunks: 0,
      summary: { title: "Merged after retry" },
    });
  });

  it("registers the resumable HTTP route and whitelists its payload", async () => {
    const functions = new Map<string, Function>();
    const triggers: Array<{ function_id: string; config: Record<string, unknown> }> = [];
    const trigger = vi.fn(async () => ({
      success: true,
      status: "in_progress",
      completedChunks: 1,
      totalChunks: 3,
      skippedChunks: 0,
    }));
    const sdk = {
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
      registerTrigger: (definition: (typeof triggers)[number]) => triggers.push(definition),
      trigger,
    };
    registerApiTriggers(sdk as any, {} as any, "");
    const handler = functions.get("api::summarize-resumable")!;

    const response = await handler({
      headers: {},
      body: { sessionId: " session-1 ", model: "model-1", unsafe: "drop-me" },
    });

    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::summarize-resumable",
      payload: { sessionId: "session-1", model: "model-1" },
    });
    expect(response.status_code).toBe(200);
    expect(triggers).toContainEqual({
      type: "http",
      function_id: "api::summarize-resumable",
      config: {
        api_path: "/agentmemory/summarize/resumable",
        http_method: "POST",
        middleware_function_ids: ["middleware::api-auth"],
      },
    });
  });
});
