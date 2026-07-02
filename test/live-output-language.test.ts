import { describe, expect, it } from "vitest";

import { extractLlmLessonCandidates } from "../src/functions/lesson-extract.js";
import { PiAgentSDKProvider } from "../src/providers/pi-agent-sdk.js";

const runLive = process.env.AGENTMEMORY_LIVE_LLM_TESTS === "true";

describe.runIf(runLive)("live AgentMemory output language policy", () => {
  it("gets Simplified Chinese lesson content from a real pi-agent-sdk model", async () => {
    const previousLanguage = process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    const previousTimeout = process.env.PI_AGENT_TIMEOUT_MS;
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    process.env.PI_AGENT_TIMEOUT_MS ||= "120000";

    try {
      const provider = new PiAgentSDKProvider(
        process.env.PI_AGENT_MODEL || "gpt-5.4-mini",
        1200,
      );
      const result = await extractLlmLessonCandidates({
        provider,
        project: "agentmemory-live-language-test",
        sessionId: "live-zh-language-check",
        firstPrompt: "分析 AgentMemory replay 导入流程，并提炼以后必须遵守的经验。",
        rawObservations: [
          {
            id: "raw-live-1",
            sessionId: "live-zh-language-check",
            timestamp: new Date().toISOString(),
            project: "agentmemory",
            cwd: "agentmemory-live-language-test",
            userPrompt: "我需要确认 replay 导入时 lesson 提取是否真正支持中文输出。",
            assistantResponse:
              "以后必须用真实模型验证语言策略，而不是只检查 mock provider 是否收到提示词。",
            toolName: "codex",
            toolInput: {},
            toolOutput: "",
            raw: {},
          },
        ],
        compressedObservations: [
          {
            id: "cmp-live-1",
            sessionId: "live-zh-language-check",
            timestamp: new Date().toISOString(),
            project: "agentmemory",
            type: "decision",
            title: "语言策略验收必须调用真实模型",
            narrative:
              "只检查 system prompt 注入不能证明模型实际返回中文；需要 live integration test。",
            sourceObservationIds: ["raw-live-1"],
          },
        ],
        config: {
          textLimit: 12,
          chunkSize: 8,
          chunkConcurrency: 1,
          timeoutMs: 120000,
        },
      });

      const text = JSON.stringify(result.candidates);
      const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;

      expect(result.errors).toEqual([]);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(cjkCount).toBeGreaterThanOrEqual(8);
      expect(result.candidates[0].content).toMatch(/[\u4e00-\u9fff]/);
    } finally {
      if (previousLanguage === undefined) {
        delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
      } else {
        process.env.AGENTMEMORY_OUTPUT_LANGUAGE = previousLanguage;
      }
      if (previousTimeout === undefined) {
        delete process.env.PI_AGENT_TIMEOUT_MS;
      } else {
        process.env.PI_AGENT_TIMEOUT_MS = previousTimeout;
      }
    }
  }, 180000);
});

describe.skipIf(runLive)("live AgentMemory output language policy", () => {
  it("is skipped unless AGENTMEMORY_LIVE_LLM_TESTS=true", () => {
    expect(runLive).toBe(false);
  });
});
