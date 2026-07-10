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
    summaryResumablePartials: (runId: string) =>
      `summary-resumable-partials:${runId}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

import {
  buildTurnAwareSummaryChunks,
  registerSummarizeFunction,
} from "../src/functions/summarize.js";
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

function makeProvider(responses: string[]): MemoryProvider & {
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
      return r;
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
): Promise<void> {
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
}

function setupResumableHandler(
  kv: ReturnType<typeof mockKV>,
  provider: MemoryProvider,
): { handler: Function; sdk: ReturnType<typeof mockSdk> } {
  const sdk = mockSdk();
  registerSummarizeFunction(sdk as any, kv as any, provider);
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
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    delete process.env.AGENTMEMORY_SUMMARY_MODEL;
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
      completedChunks: 1,
      totalChunks: 3,
      skippedChunks: 0,
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
      "completedChunks",
      "skippedChunks",
      "status",
      "success",
      "summary",
      "totalChunks",
    ]);
    const stored = await kv.get<any>("summaries", "ses_reduce");
    expect(stored?.title).toBe("Merged");

    const repeated = await handler({ sessionId: "ses_reduce" });
    expect(repeated).toEqual(result);
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

  it("keeps the existing two-attempt chunk skip semantics", async () => {
    const kv = mockKV();
    await seedSummarySession(kv, "ses_step_skip", 250);
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1" }),
      "garbage one",
      "garbage two",
      summaryXml({ title: "Chunk 3" }),
      summaryXml({ title: "Merged with skip" }),
    ]);
    const { handler } = setupResumableHandler(kv, provider);

    await handler({ sessionId: "ses_step_skip" });
    const skipped = await handler({ sessionId: "ses_step_skip" });
    await handler({ sessionId: "ses_step_skip" });
    const result = await handler({ sessionId: "ses_step_skip" });

    expect(skipped).toMatchObject({
      success: true,
      status: "in_progress",
      completedChunks: 1,
      totalChunks: 3,
      skippedChunks: 1,
    });
    expect(provider.calls).toHaveLength(5);
    expect(result).toMatchObject({
      success: true,
      status: "succeeded",
      completedChunks: 2,
      totalChunks: 3,
      skippedChunks: 1,
      summary: { title: "Merged with skip" },
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
