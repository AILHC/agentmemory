import { describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Lesson, MemoryProvider, RawObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import { validateOutput } from "../src/eval/validator.js";
import { LessonExtractionOutputSchema } from "../src/eval/schemas.js";
import {
  DEFAULT_REPLAY_LESSON_CONFIG,
  extractHeuristicLessonCandidates,
  extractLlmLessonCandidates,
  extractLessonsFromReplay,
  isNoopProvider,
  resolveReplayLessonExtractionConfig,
} from "../src/functions/lesson-extract.js";
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

function noopProvider(): MemoryProvider {
  return {
    name: "noop",
    compress: vi.fn().mockResolvedValue(""),
    summarize: vi.fn().mockResolvedValue(""),
  };
}

describe("lesson extraction parser", () => {
  it("parses lesson XML with confidence attribute", () => {
    const parsed = parseLessonExtractionXml(`
<lessons>
  <lesson confidence="0.82">
    <content>以后导入 replay 数据前必须确认来源接口。</content>
    <context>AgentMemory replay import 产物评估</context>
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
      mode: "heuristic",
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
    expect(resolveReplayLessonExtractionConfig({}, { saveLimit: 0 }).saveLimit).toBe(20);
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
      tags: ["auto-import", "heuristic"],
      source: "heuristic",
    });
  });
});

describe("lesson extraction end-to-end", () => {
  it("mode off does not write lessons", async () => {
    const kv = mockKV();
    const config = { ...resolveReplayLessonExtractionConfig({}, {}), mode: "off" as const };

    const provider = noopProvider();
    const result = await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "session-off",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      compressedObservations: [],
      config,
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(result).toEqual({ lessonIds: [], created: 0, reinforced: 0, skipped: 0, errors: [] });
    expect(lessons).toHaveLength(0);
  });

  it("noop and resilient(noop) skip LLM in llm mode", async () => {
    const raw = [
      rawObservation({
        assistantResponse: "以后必须先确认来源接口，再执行。",
      }),
    ];

    const baseConfig = resolveReplayLessonExtractionConfig({}, {});
    const config = { ...baseConfig, mode: "llm" as const };

    const noop = { ...noopProvider(), name: "noop" };
    const noopResult = await extractLessonsFromReplay({
      kv: mockKV(),
      provider: noop,
      sessionId: "session-noop",
      project: "/repo",
      rawObservations: raw,
      compressedObservations: [],
      config,
    });
    expect(noopResult.skipped).toBeGreaterThan(0);
    expect(isNoopProvider(noop)).toBe(true);

    const resilient = {
      ...noopProvider(),
      name: "resilient(noop)",
    };
    const resilientResult = await extractLessonsFromReplay({
      kv: mockKV(),
      provider: resilient,
      sessionId: "session-resilient",
      project: "/repo",
      rawObservations: raw,
      compressedObservations: [],
      config,
    });
    expect(resilientResult.skipped).toBeGreaterThan(0);
    expect(isNoopProvider(resilient)).toBe(true);
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
    expect(capturedPrompt).not.toContain("tail-marker");
  });

  it("strips private data before persisting heuristic lessons", async () => {
    const kv = mockKV();
    await extractLessonsFromReplay({
      kv,
      provider: noopProvider(),
      sessionId: "heuristic-secret-session",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt:
            "必须不要把 api_key=abcdefghijklmnopqrstuvwxyz123456 写入持久化 lesson。",
        }),
      ],
      compressedObservations: [],
      config: resolveReplayLessonExtractionConfig({}, {}),
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].content).toContain("[REDACTED_SECRET]");
    expect(lessons[0].content).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(lessons[0].content).not.toContain("api_key=");
  });

  it("strips private data from LLM output before persisting lessons", async () => {
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async () => `
<lessons>
  <lesson confidence=\"0.8\">
    <content>不要保存 Bearer abcdefghijklmnopqrstuvwxyz1234567890 这类令牌。</content>
    <context>api_key=abcdefghijklmnopqrstuvwxyz123456</context>
    <tags><tag>sk-abcdefghijklmnopqrstuvwxyz123456</tag></tags>
  </lesson>
</lessons>`),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const kv = mockKV();

    await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "llm-secret-session",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      compressedObservations: [],
      config: { ...resolveReplayLessonExtractionConfig({}, {}), mode: "llm" },
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(JSON.stringify(lessons[0])).toContain("[REDACTED_SECRET]");
    expect(JSON.stringify(lessons[0])).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(lessons[0])).not.toContain("Bearer");
    expect(JSON.stringify(lessons[0])).not.toContain("api_key=");
    expect(JSON.stringify(lessons[0])).not.toContain("sk-");
  });

  it("strips private data from fallback lesson context", async () => {
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async () => `
<lessons>
  <lesson confidence=\"0.8\">
    <content>Always validate import keys before writing duplicate observations.</content>
    <context></context>
    <tags></tags>
  </lesson>
</lessons>`),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const kv = mockKV();

    await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "fallback-context-secret-session",
      project: "/repo",
      firstPrompt: "api_key=abcdefghijklmnopqrstuvwxyz123456",
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      compressedObservations: [],
      config: { ...resolveReplayLessonExtractionConfig({}, {}), mode: "llm" },
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].context).toContain("[REDACTED_SECRET]");
    expect(lessons[0].context).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(lessons[0].context).not.toContain("api_key=");
  });

  it("applies matchLimit after LLM candidate merge before saveLimit", async () => {
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async () => `
<lessons>
  <lesson confidence=\"0.8\"><content>Always validate import keys before writing duplicate observations.</content><context></context><tags></tags></lesson>
  <lesson confidence=\"0.7\"><content>Never persist secrets in lessons.</content><context></context><tags></tags></lesson>
  <lesson confidence=\"0.6\"><content>Prefer source-backed answers for mechanism questions.</content><context></context><tags></tags></lesson>
</lessons>`),
      summarize: vi.fn().mockResolvedValue(""),
    };
    const kv = mockKV();

    const result = await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "llm-limit-session",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      compressedObservations: [],
      config: {
        ...resolveReplayLessonExtractionConfig({}, {}),
        mode: "llm",
        matchLimit: 1,
        saveLimit: 10,
      },
    });

    expect(result.created).toBe(1);
    expect(await kv.list<Lesson>(KV.lessons)).toHaveLength(1);
  });

  it("prefers higher-confidence hybrid candidates by normalized content", async () => {
    const xml = `
<lessons>
  <lesson confidence=\"0.92\">
    <content>Always validate import keys before writing duplicate observations.</content>
    <context>from llm</context>
    <tags><tag>llm</tag></tags>
  </lesson>
</lessons>`;
    const provider: MemoryProvider = {
      name: "mock-llm",
      compress: vi.fn(async () => xml),
      summarize: vi.fn().mockResolvedValue(""),
    };

    const kv = mockKV();
    const result = await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "session-hybrid",
      project: "/repo",
      rawObservations: [
        rawObservation({
          userPrompt: "Always validate import keys before writing duplicate observations.",
        }),
      ],
      compressedObservations: [],
      config: { ...resolveReplayLessonExtractionConfig({}, {}), mode: "hybrid" },
    });

    const lessons = await kv.list<Lesson>(KV.lessons);
    expect(result.created).toBe(1);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].confidence).toBe(0.92);
    expect(lessons[0].source).toBe("consolidation");
    expect(lessons[0].content).toBe(
      "Always validate import keys before writing duplicate observations.",
    );
  });

  it("keeps reinforcement idempotent for same session and increases on different sessions", async () => {
    const provider = noopProvider();
    const raw = [
      rawObservation({
        userPrompt: "Always validate import keys before writing duplicate observations.",
      }),
    ];
    const config = resolveReplayLessonExtractionConfig({}, {});
    const kv = mockKV();

    const first = await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "s1",
      project: "/repo",
      rawObservations: raw,
      compressedObservations: [],
      config,
    });
    const afterFirst = await kv.list<Lesson>(KV.lessons);
    expect(first.created).toBe(1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].reinforcements).toBe(0);

    const second = await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "s1",
      project: "/repo",
      rawObservations: raw,
      compressedObservations: [],
      config,
    });
    const afterSecond = await kv.list<Lesson>(KV.lessons);
    expect(second.created).toBe(0);
    expect(second.reinforced).toBe(0);
    expect(afterSecond[0].reinforcements).toBe(0);

    const third = await extractLessonsFromReplay({
      kv,
      provider,
      sessionId: "s2",
      project: "/repo",
      rawObservations: raw,
      compressedObservations: [],
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
