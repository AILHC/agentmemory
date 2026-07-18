import { describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Lesson, MemoryProvider, RawObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import { validateOutput } from "../src/eval/validator.js";
import { LessonExtractionOutputSchema } from "../src/eval/schemas.js";
import {
  DEFAULT_REPLAY_LESSON_CONFIG,
  buildTurnAwareLessonChunks,
  extractHeuristicLessonCandidates,
  extractLlmLessonCandidates,
  extractLlmLessonsFromObservations,
  extractLessonsFromReplay,
  resolveReplayLessonExtractionConfig,
} from "../src/functions/lesson-extract.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";
import { logger } from "../src/logger.js";
import {
  buildLessonExtractionPrompt,
  parseLessonExtractionXml,
} from "../src/prompts/lesson-extraction.js";

function rawObservation(overrides: Partial<RawObservation>): RawObservation {
  return {
    id: overrides.id ?? "obs-1",
    sessionId: overrides.sessionId ?? "session-1",
    timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
    hookType: overrides.hookType ?? "prompt_submit",
    raw: overrides.raw ?? {},
    ...overrides,
  };
}

function compressedObservation(overrides: Partial<CompressedObservation>): CompressedObservation {
  return {
    id: overrides.id ?? "cmp-1",
    sessionId: overrides.sessionId ?? "session-1",
    timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
    type: overrides.type ?? "conversation",
    title: overrides.title ?? "title",
    facts: overrides.facts ?? ["fact"],
    narrative: overrides.narrative ?? "narrative",
    concepts: overrides.concepts ?? ["concept"],
    files: overrides.files ?? [],
    importance: overrides.importance ?? 6,
    ...overrides,
  };
}

describe("lesson extraction parser", () => {
  it("parses lesson XML with confidence attribute", () => {
    const parsed = parseLessonExtractionXml(`
<lessons>
  <lesson confidence="0.82">
    <content>以后导入 replay 数据前必须确认来源接口。</content>
    <context>AgentMemory replay import 产物评估</context>
    <importance>0.42</importance>
    <evidence>会话中有明确回放来源核验要求。</evidence>
    <tags>
      <tag>agentmemory</tag>
      <tag>replay-import</tag>
    </tags>
  </lesson>
</lessons>`);

    expect(parsed).toEqual({
      lessons: [
        {
          content: "以后导入 replay 数据前必须确认来源接口。",
          context: "AgentMemory replay import 产物评估",
          confidence: 0.82,
          importance: 0.42,
          evidence: "会话中有明确回放来源核验要求。",
          tags: ["agentmemory", "replay-import"],
        },
      ],
    });
    const validation = validateOutput(
      LessonExtractionOutputSchema,
      parsed,
      "mem::replay::lesson-extract",
    );
    expect(validation.valid).toBe(true);
  });

  it("parses markdown fences and ignores empty lesson content", () => {
    const parsed = parseLessonExtractionXml(`
\`\`\`xml
<lessons>
  <lesson confidence="2">
    <content>  </content>
    <context>ignored</context>
    <tags><tag>ignored</tag></tags>
  </lesson>
  <lesson>
    <content>不要把模拟脚本结果写成 AgentMemory 真实产物。</content>
    <context></context>
    <tags></tags>
  </lesson>
</lessons>
\`\`\`
`);

    expect(parsed).toEqual({
      lessons: [
        {
          content: "不要把模拟脚本结果写成 AgentMemory 真实产物。",
          context: "",
          confidence: 0.6,
          tags: [],
        },
      ],
    });
  });

  it("throws when <lessons> root is missing", () => {
    expect(() =>
      parseLessonExtractionXml("<lesson confidence=\"0.9\"><content>bad</content></lesson>"),
    ).toThrow(/Missing <lessons> root/i);
  });

  it("throws when valid lessons are empty", () => {
    expect(() =>
      parseLessonExtractionXml("<lessons><lesson confidence=\"0.9\"><content>   </content></lesson></lessons>"),
    ).toThrow(/No valid lessons found/i);
  });
});

describe("lesson extraction prompt", () => {
  it("builds session-aware prompt from items", () => {
    const prompt = buildLessonExtractionPrompt({
      sessionId: "s1",
      project: "/repo",
      firstPrompt: "分析 AgentMemory replay import",
      items: [
        {
          index: 1,
          kind: "user_prompt",
          text: "以后回答 AgentMemory 事实问题必须依据源码。",
        },
      ],
    });

    expect(prompt).toContain("Session: s1");
    expect(prompt).toContain("Project: /repo");
    expect(prompt).toContain("First prompt:");
    expect(prompt).toContain("[1] user_prompt");
    expect(prompt).toContain("以后回答 AgentMemory 事实问题必须依据源码。");
  });
});

describe("replay lesson extraction config", () => {
  it("uses safe defaults", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, {});
    expect(cfg).toMatchObject(DEFAULT_REPLAY_LESSON_CONFIG);
    expect(cfg).toMatchObject({
      textLimit: 200,
      matchLimit: 40,
      saveLimit: 20,
      additionalHeuristicTerms: [],
    });
  });

  it("requires allowUnbounded before zero means unlimited", () => {
    expect(resolveReplayLessonExtractionConfig({}, { textLimit: 0 }).textLimit).toBe(200);
    expect(
      resolveReplayLessonExtractionConfig({}, { textLimit: 0, allowUnbounded: true }).textLimit,
    ).toBe(0);
    expect(resolveReplayLessonExtractionConfig({}, { matchLimit: 0 }).matchLimit).toBe(40);
    expect(
      resolveReplayLessonExtractionConfig({}, { matchLimit: 0, allowUnbounded: true }).matchLimit,
    ).toBe(0);
    expect(resolveReplayLessonExtractionConfig({}, { saveLimit: 0 }).saveLimit).toBe(0);
    expect(
      resolveReplayLessonExtractionConfig({}, { saveLimit: 0, allowUnbounded: true }).saveLimit,
    ).toBe(0);
  });

  it("appends additional heuristic terms", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, { additionalHeuristicTerms: ["优先"] });
    expect(cfg.additionalHeuristicTerms).toContain("优先");
    expect(cfg.additionalHeuristicTerms).not.toContain("不会出现");
  });
});

describe("heuristic replay lesson extraction", () => {
  it("keeps legacy English extraction compatible", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, {});
    const candidates = extractHeuristicLessonCandidates({
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      config: cfg,
      firstPrompt: "initial prompt",
      project: "/repo",
    });

    expect(candidates).toEqual([
      {
        content: "Always validate import keys before writing duplicate observations.",
        context: "initial prompt",
        confidence: 0.4,
        importance: 0.4,
        evidence: "",
        tags: ["auto-import", "heuristic"],
        source: "heuristic",
      },
    ]);
  });

  it("extracts Chinese strong-rule sentences", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, {});
    const candidates = extractHeuristicLessonCandidates({
      rawObservations: [
        rawObservation({
          assistantResponse:
            "以后回答 AgentMemory 机制问题必须依据源码和测试，不能猜测。",
        }),
      ],
      config: cfg,
      firstPrompt: undefined,
      project: "/repo",
    });

    expect(candidates.map((c) => c.content)).toContain(
      "以后回答 AgentMemory 机制问题必须依据源码和测试，不能猜测",
    );
  });

  it("does not extract weak Chinese explanations by default", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, {});
    const candidates = extractHeuristicLessonCandidates({
      rawObservations: [
        rawObservation({
          assistantResponse: "这个函数应该返回空数组。注意这里有一个普通说明。后续可以优化。",
        }),
      ],
      config: cfg,
      firstPrompt: undefined,
      project: "/repo",
    });

    expect(candidates).toEqual([]);
  });

  it("does not extract weak future-looking Chinese sentences by default", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, {});
    const candidates = extractHeuristicLessonCandidates({
      rawObservations: [
        rawObservation({
          assistantResponse: "以后可以优化这个函数。下次再看这个问题。除非需要，否则后续再说。",
        }),
      ],
      config: cfg,
      firstPrompt: undefined,
      project: "/repo",
    });

    expect(candidates).toEqual([]);
  });

  it("honors additional Chinese terms", () => {
    const cfg = resolveReplayLessonExtractionConfig({}, { additionalHeuristicTerms: ["优先"] });
    const candidates = extractHeuristicLessonCandidates({
      rawObservations: [
        rawObservation({
          assistantResponse: "优先记录这个关键前置条件。",
        }),
      ],
      config: cfg,
      firstPrompt: undefined,
      project: "/repo",
    });

    expect(candidates[0]).toEqual({
      content: "优先记录这个关键前置条件",
      context: "/repo",
      confidence: 0.4,
      importance: 0.4,
      evidence: "",
      tags: ["auto-import", "heuristic"],
      source: "heuristic",
    });
  });
});

describe("lesson extraction end-to-end", () => {
  it("keeps lesson prompt items for one user turn in the same chunk", () => {
    const items = [
      { index: 1, kind: "user_prompt" as const, text: "Do A" },
      { index: 2, kind: "assistant_response" as const, text: "Answer A" },
      { index: 3, kind: "observation" as const, text: "Tool evidence A" },
      { index: 4, kind: "user_prompt" as const, text: "Do B" },
      { index: 5, kind: "assistant_response" as const, text: "Answer B" },
    ];

    const chunks = buildTurnAwareLessonChunks(items, 4);

    expect(chunks.map((chunk) => chunk.map((item) => item.index))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it("splits one oversized lesson turn by item count as a fallback", () => {
    const items = [
      { index: 1, kind: "user_prompt" as const, text: "Do A" },
      { index: 2, kind: "assistant_response" as const, text: "Answer A1" },
      { index: 3, kind: "observation" as const, text: "Observation A2" },
      { index: 4, kind: "observation" as const, text: "Observation A3" },
    ];

    const chunks = buildTurnAwareLessonChunks(items, 2);

    expect(chunks.map((chunk) => chunk.map((item) => item.index))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("falls back to fixed-size lesson chunks when there are no user prompt items", () => {
    const items = [
      { index: 1, kind: "assistant_response" as const, text: "Answer 1" },
      { index: 2, kind: "observation" as const, text: "Observation 1" },
      { index: 3, kind: "assistant_response" as const, text: "Answer 2" },
      { index: 4, kind: "observation" as const, text: "Observation 2" },
      { index: 5, kind: "observation" as const, text: "Observation 3" },
    ];

    const chunks = buildTurnAwareLessonChunks(items, 2);

    expect(chunks.map((chunk) => chunk.map((item) => item.index))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  it("builds lesson LLM chunks from the real observation timeline", async () => {
    const provider = {
      name: "test",
      compress: vi.fn().mockResolvedValue("<lessons></lessons>"),
      summarize: vi.fn(),
    };
    await extractLlmLessonCandidates({
      provider: provider as never,
      sessionId: "s1",
      project: "proj",
      firstPrompt: undefined,
      config: {
        enabled: true,
        textLimit: 1200,
        matchLimit: 10,
        saveLimit: 10,
        additionalHeuristicTerms: [],
        allowUnbounded: false,
        chunkSize: 3,
        chunkConcurrency: 1,
      },
      rawObservations: [
        rawObservation({
          id: "raw-a",
          sessionId: "s1",
          timestamp: "2026-01-01T00:00:00.000Z",
          hookType: "prompt_submit",
          userPrompt: "Do A",
        }),
        rawObservation({
          id: "raw-b",
          sessionId: "s1",
          timestamp: "2026-01-01T00:10:00.000Z",
          hookType: "prompt_submit",
          userPrompt: "Do B",
        }),
      ],
      compressedObservations: [
        compressedObservation({
          id: "obs-a",
          sessionId: "s1",
          timestamp: "2026-01-01T00:01:00.000Z",
          type: "decision",
          title: "Decision A",
          narrative: "Decision belongs to A.",
          facts: [],
          files: [],
          concepts: [],
          importance: 7,
        }),
        compressedObservation({
          id: "obs-b",
          sessionId: "s1",
          timestamp: "2026-01-01T00:11:00.000Z",
          type: "decision",
          title: "Decision B",
          narrative: "Decision belongs to B.",
          facts: [],
          files: [],
          concepts: [],
          importance: 7,
        }),
      ],
    });

    expect(provider.compress.mock.calls[0][1]).toContain("Do A");
    expect(provider.compress.mock.calls[0][1]).toContain("Decision A");
    expect(provider.compress.mock.calls[0][1]).not.toContain("Do B");
  });

  it("enabled false skips extraction", async () => {
    const kv = mockKV();
    const config = { ...resolveReplayLessonExtractionConfig({}, {}), enabled: false };

    const result = await extractLessonsFromReplay({
      kv,
      sessionId: "session-off",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      config,
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(result).toEqual({ lessonIds: [], created: 0, reinforced: 0, skipped: 0, errors: [] });
    expect(lessons).toHaveLength(0);
  });

  it("extracts with provider.compress and retries parser on first failure", async () => {
    const validXml = `
<lessons>
  <lesson confidence=\"0.72\">
    <content>Always validate import keys before writing duplicate observations.</content>
    <context>replay session</context>
    <tags><tag>agentmemory</tag></tags>
  </lesson>
</lessons>`;

    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi
        .fn()
        .mockResolvedValueOnce("<root />")
        .mockResolvedValueOnce(validXml),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const result = await extractLlmLessonCandidates({
      provider,
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      compressedObservations: [],
      config: resolveReplayLessonExtractionConfig({}, {}),
      firstPrompt: "first",
      project: "/repo",
      sessionId: "retry-session",
    });

    expect(result.candidates).toHaveLength(1);
    expect((provider.compress as any).mock.calls).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("returns sanitized provider diagnostics without retrying a transport failure", async () => {
    const sensitive = "sensitive-provider-error-marker";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn().mockRejectedValue(new ProviderCallError(
        `pi_stream_failed ${sensitive}`,
        {
          providerErrorCode: "rate_limited",
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 1200,
          inputChars: 38000,
          maxOutputTokens: 4096,
          responseStarted: false,
          rawError: sensitive,
          authorization: sensitive,
        } as never,
      )),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const result = await extractLlmLessonsFromObservations({
      kv: mockKV(),
      provider,
      sessionId: "provider-failure-session",
      project: "/repo",
      rawObservations: [rawObservation({
        sessionId: "provider-failure-session",
        userPrompt: "Always validate import keys before writing duplicate observations.",
      })],
      compressedObservations: [],
      firstPrompt: "first",
      config: {
        providerName: "pi-agent-sdk",
        textLimit: 1200,
        saveLimit: 50,
        chunkSize: 20,
        chunkConcurrency: 1,
        timeoutMs: 60000,
      },
      sourceRunId: "run-provider-failure",
    });

    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(result.failureDiagnostics).toEqual({
      requestPhase: "chunk",
      providerErrorCode: "rate_limited",
      statusCode: 429,
      retryAfterMs: 2500,
      elapsedMs: 1200,
      inputChars: 38000,
      maxOutputTokens: 4096,
      responseStarted: false,
    });
    expect(result.errors).toEqual(["pi_stream_failed"]);
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
    warn.mockRestore();
  });

  it("stops starting later chunk batches after a transport failure", async () => {
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi.fn().mockRejectedValue(new ProviderCallError(
        "pi_stream_failed",
        {
          providerErrorCode: "timeout",
          elapsedMs: 60000,
          inputChars: 100,
          maxOutputTokens: 4096,
          responseStarted: false,
        },
      )),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const result = await extractLlmLessonCandidates({
      provider,
      rawObservations: [
        rawObservation({ id: "raw-a", userPrompt: "First independent turn." }),
        rawObservation({ id: "raw-b", userPrompt: "Second independent turn." }),
        rawObservation({ id: "raw-c", userPrompt: "Third independent turn." }),
      ],
      compressedObservations: [],
      config: {
        ...resolveReplayLessonExtractionConfig({}, {}),
        chunkSize: 1,
        chunkConcurrency: 1,
      },
      project: "/repo",
      sessionId: "transport-stops-later-batches",
    });

    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual(["pi_stream_failed"]);
    expect(result.failureDiagnostics?.providerErrorCode).toBe("timeout");
  });

  it("retries an ordinary pi_empty_response as an invalid response", async () => {
    const validXml = `
<lessons>
  <lesson confidence="0.72">
    <content>Retry an empty Pi response once before failing the chunk.</content>
    <context>replay session</context>
    <tags><tag>agentmemory</tag></tags>
  </lesson>
</lessons>`;
    const provider: MemoryProvider = {
      name: "pi-agent-sdk",
      compress: vi
        .fn()
        .mockRejectedValueOnce(new Error("pi_empty_response"))
        .mockResolvedValueOnce(validXml),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const result = await extractLlmLessonCandidates({
      provider,
      rawObservations: [rawObservation({
        userPrompt: "Always validate import keys before writing duplicate observations.",
      })],
      compressedObservations: [],
      config: resolveReplayLessonExtractionConfig({}, {}),
      firstPrompt: "first",
      project: "/repo",
      sessionId: "pi-empty-response-retry",
    });

    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("repairs complete lesson blocks that only miss the lessons root without another provider call", async () => {
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn().mockResolvedValue(`
<lesson confidence="0.72">
  <content>Wrap a complete lesson block before asking the provider again.</content>
  <context>lesson format recovery</context>
  <tags><tag>agentmemory</tag></tags>
</lesson>`),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const result = await extractLlmLessonCandidates({
      provider,
      rawObservations: [rawObservation({
        userPrompt: "Preserve valid lesson content while repairing only its XML envelope.",
      })],
      compressedObservations: [],
      config: resolveReplayLessonExtractionConfig({}, {}),
      firstPrompt: "first",
      project: "/repo",
      sessionId: "lesson-root-recovery",
    });

    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("uses a distinct format-repair request and keeps only allowlisted parse diagnostics", async () => {
    const sensitive = "sensitive-response-marker";
    const calls: Array<{ system: string; prompt: string }> = [];
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async (system, prompt) => {
        calls.push({ system, prompt });
        return `not valid lesson xml ${sensitive}`;
      }),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const result = await extractLlmLessonCandidates({
      provider,
      rawObservations: [rawObservation({
        userPrompt: "Return a lesson using the required XML contract.",
      })],
      compressedObservations: [],
      config: resolveReplayLessonExtractionConfig({}, {}),
      firstPrompt: "first",
      project: "/repo",
      sessionId: "lesson-format-repair",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.system).not.toBe(calls[0]?.system);
    expect(calls[1]?.prompt).not.toBe(calls[0]?.prompt);
    expect(calls[1]?.system).toMatch(/format/i);
    expect(result.errors).toEqual(["lesson_missing_root"]);
    expect(result.failureDiagnostics).toEqual({
      requestPhase: "chunk",
      parseErrorCode: "lesson_missing_root",
      chunkIndex: 0,
      attempt: 2,
      responseChars: `not valid lesson xml ${sensitive}`.length,
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it("preserves allowlisted causes from ordinary provider errors without retrying", async () => {
    const sensitive = "sensitive-ordinary-error-marker";
    for (const [message, expectedCause] of [
      [`circuit_breaker_open ${sensitive}`, "circuit_breaker_open"],
      [`pi_auth_failed ${sensitive}`, "pi_auth_failed"],
      [`opaque provider failure ${sensitive}`, "provider_failure"],
    ] as const) {
      const provider: MemoryProvider = {
        name: "resilient(pi-agent-sdk)",
        compress: vi.fn().mockRejectedValue(new Error(message)),
        summarize: vi.fn().mockResolvedValue(""),
      };

      const result = await extractLlmLessonCandidates({
        provider,
        rawObservations: [rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        })],
        compressedObservations: [],
        config: resolveReplayLessonExtractionConfig({}, {}),
        firstPrompt: "first",
        project: "/repo",
        sessionId: "ordinary-provider-error-session",
      });

      expect(provider.compress).toHaveBeenCalledTimes(1);
      expect(result.errors).toEqual([expectedCause]);
      expect(JSON.stringify(result)).not.toContain(sensitive);
    }
  });

  it("strips private data before calling provider.compress", async () => {
    const validXml = `
<lessons>
  <lesson confidence=\"0.82\">
    <content>Always validate import keys before writing duplicate observations.</content>
    <context>replay</context>
    <tags><tag>agentmemory</tag></tags>
  </lesson>
</lessons>`;
    let capturedPrompt = "";
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async (_system, userPrompt) => {
        capturedPrompt = userPrompt;
        return validXml;
      }),
      summarize: vi.fn().mockResolvedValue(""),
    };

    await extractLlmLessonCandidates({
      provider,
      rawObservations: [
        rawObservation({
          userPrompt:
            "请不要写出明文凭证 Bearer sk-proj-abcdefghijklmnopqrstu，请严格脱敏。",
        }),
      ],
      compressedObservations: [
        compressedObservation({
          type: "error",
          title: "注意到 api_key=sk-1234567890abcdefghijk在本次会话。",
          narrative: "后续可以继续。",
        }),
      ],
      config: resolveReplayLessonExtractionConfig({}, {}),
      firstPrompt: "分析会话，包含 sk-1234567890ABCDEFGHIJKL",
      project: "/repo",
      sessionId: "secret-session",
    });

    expect(capturedPrompt).not.toContain("sk-proj-abcdefghijklmnopqrstu");
    expect(capturedPrompt).not.toContain("sk-1234567890abcdefghijk");
    expect(capturedPrompt).not.toContain("Bearer");
    expect(capturedPrompt).not.toContain("api_key=");
    expect(capturedPrompt).not.toContain("replay");
    expect(capturedPrompt).toContain("Session: secret-session");
  });

  it("truncates long LLM prompt items before calling provider.compress", async () => {
    const validXml = `
<lessons>
  <lesson confidence=\"0.7\">
    <content>Always validate import keys before writing duplicate observations.</content>
    <context>replay</context>
    <tags><tag>agentmemory</tag></tags>
  </lesson>
</lessons>`;
    let capturedPrompt = "";
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async (_system, userPrompt) => {
        capturedPrompt = userPrompt;
        return validXml;
      }),
      summarize: vi.fn().mockResolvedValue(""),
    };

    await extractLlmLessonCandidates({
      provider,
      rawObservations: [
        rawObservation({
          userPrompt: `Always validate import keys. ${"x".repeat(5000)} tail-marker`,
        }),
      ],
      compressedObservations: [],
      config: resolveReplayLessonExtractionConfig({}, {}),
      firstPrompt: undefined,
      project: "/repo",
      sessionId: "long-prompt-session",
    });

    expect(capturedPrompt).toContain("[...truncated]");
    expect(capturedPrompt.length).toBeLessThan(`Session: long-prompt-session

Project: /repo

[1] user_prompt
Always validate import keys. ${"x".repeat(5000)} tail-marker`.length);
  });

  it("strips private data before persisting heuristic lessons", async () => {
    const kv = mockKV();
    await extractLessonsFromReplay({
      kv,
      sessionId: "heuristic-secret-session",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt:
            "必须不要把 api_key=abcdefghijklmnopqrstuvwxyz123456 写入持久化 lesson。",
        }),
      ],
      config: resolveReplayLessonExtractionConfig({}, {}),
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].content).toContain("[REDACTED_SECRET]");
    expect(lessons[0].content).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(lessons[0].content).not.toContain("api_key=");
  });

  it("creates lessons with heuristic source and replay-import-heuristic origin", async () => {
    const kv = mockKV();
    const config = resolveReplayLessonExtractionConfig({}, {});

    await extractLessonsFromReplay({
      kv,
      sessionId: "heuristic-source-session",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt: "以后必须先确认来源接口，再执行。",
        }),
      ],
      config,
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].source).toBe("heuristic");
    expect(lessons[0].origin).toBe("replay-import-heuristic");
  });

  it("keeps reinforcement idempotent for same session and increases on different sessions", async () => {
    const raw = [
      rawObservation({
        userPrompt: "Always validate import keys before writing duplicate observations.",
      }),
    ];
    const config = resolveReplayLessonExtractionConfig({}, {});
    const kv = mockKV();

    const first = await extractLessonsFromReplay({
      kv,
      sessionId: "s1",
      project: "/repo",
      rawObservations: raw,
      config,
    });
    const afterFirst = await kv.list<Lesson>(KV.lessons);
    expect(first.created).toBe(1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].reinforcements).toBe(0);

    const second = await extractLessonsFromReplay({
      kv,
      sessionId: "s1",
      project: "/repo",
      rawObservations: raw,
      config,
    });
    const afterSecond = await kv.list<Lesson>(KV.lessons);
    expect(second.created).toBe(0);
    expect(second.reinforced).toBe(0);
    expect(afterSecond[0].reinforcements).toBe(0);

    const third = await extractLessonsFromReplay({
      kv,
      sessionId: "s2",
      project: "/repo",
      rawObservations: raw,
      config,
    });
    const afterThird = await kv.list<Lesson>(KV.lessons);
    expect(third.created).toBe(0);
    expect(third.reinforced).toBe(1);
    expect(afterThird[0].reinforcements).toBe(1);
    expect(afterThird[0].sourceIds).toContain("s1");
    expect(afterThird[0].sourceIds).toContain("s2");
  });
});
