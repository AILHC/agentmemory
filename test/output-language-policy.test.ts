import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveOutputLanguage,
  withOutputLanguagePolicy,
} from "../src/prompts/output-language.js";

describe("AgentMemory output language policy", () => {
  afterEach(() => {
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
  });

  it("returns default when AGENTMEMORY_OUTPUT_LANGUAGE is unset or English", () => {
    expect(resolveOutputLanguage({})).toBe("default");
    expect(resolveOutputLanguage({ AGENTMEMORY_OUTPUT_LANGUAGE: "en" })).toBe(
      "default",
    );
    expect(
      resolveOutputLanguage({ AGENTMEMORY_OUTPUT_LANGUAGE: "en-US" }),
    ).toBe("default");
  });

  it("keeps the original system prompt when output language is default", () => {
    const prompt = "You are an AgentMemory extractor.";

    expect(withOutputLanguagePolicy(prompt, {})).toBe(prompt);
    expect(
      withOutputLanguagePolicy(prompt, { AGENTMEMORY_OUTPUT_LANGUAGE: "en" }),
    ).toBe(prompt);
  });

  it("injects Simplified Chinese output rules when zh-CN is configured", () => {
    const prompt = withOutputLanguagePolicy("Extract memory.", {
      AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN",
    });

    expect(prompt).toContain("AgentMemory Output Language Policy");
    expect(prompt).toContain("人类可读内容使用简体中文");
  });

  it("fails fast for unsupported output language values", () => {
    expect(() =>
      withOutputLanguagePolicy("Extract memory.", {
        AGENTMEMORY_OUTPUT_LANGUAGE: "fr",
      }),
    ).toThrow("Unsupported AGENTMEMORY_OUTPUT_LANGUAGE: fr");
  });

  it("preserves structured and code identifiers", () => {
    const prompt = withOutputLanguagePolicy("Extract memory.", {
      AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN",
    });

    expect(prompt).toContain(
      "保留 XML tags、JSON keys、attribute names、enum values、file paths、code identifiers",
    );
    expect(prompt).toContain("schema fields");
    expect(prompt).toContain("URLs");
    expect(prompt).toContain("commands");
    expect(prompt).toContain("package/API/class/function/type names");
  });

  it("keeps retrieval fields useful for English technical identifiers", () => {
    const prompt = withOutputLanguagePolicy("Extract memory.", {
      AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN",
    });

    expect(prompt).toContain("concepts/tags/sourceConceptCluster");
    expect(prompt).toContain("保留英文技术标识");
    expect(prompt).toContain("中英双语");
  });

  it("keeps graph identifiers exact and unmodified", () => {
    const prompt = withOutputLanguagePolicy("Extract memory.", {
      AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN",
    });

    expect(prompt).toContain("entity name");
    expect(prompt).toContain("relationship source/target");
    expect(prompt).toContain("relationship type enum");
    expect(prompt).toContain("不得翻译或改写");
    expect(prompt).toContain("source/target 必须与 entity name 精确匹配");
  });

  it("does not duplicate the policy when called more than once", () => {
    const once = withOutputLanguagePolicy("Extract memory.", {
      AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN",
    });
    const twice = withOutputLanguagePolicy(once, {
      AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN",
    });

    expect(twice).toBe(once);
    expect(twice.match(/AgentMemory Output Language Policy/g)).toHaveLength(1);
  });

  it("keeps mem::compress retry calls under the output language policy", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const { registerCompressFunction } = await import(
      "../src/functions/compress.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const calls: Array<{ system: string; user: string }> = [];
    const provider = {
      name: "test",
      summarize: vi.fn(),
      compress: vi.fn(async (system: string, user: string) => {
        calls.push({ system, user });
        if (calls.length === 1) return "not xml";
        return `<type>file_read</type>
<title>Read auth.ts</title>
<facts><fact>Reviewed auth middleware</fact></facts>
<narrative>Reviewed src/auth.ts for JWT handling.</narrative>
<concepts><concept>JWT</concept></concepts>
<files><file>src/auth.ts</file></files>
<importance>7</importance>`;
      }),
    };
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::compress", {
      observationId: "obs_1",
      sessionId: "ses_1",
      raw: {
        id: "obs_1",
        sessionId: "ses_1",
        hookType: "post_tool_use",
        toolName: "Read",
        toolInput: { file_path: "src/auth.ts" },
        toolOutput: "auth source",
        timestamp: "2026-06-25T00:00:00.000Z",
        raw: {},
      },
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].system).toContain("AgentMemory Output Language Policy");
    expect(calls[1].system).toContain("AgentMemory Output Language Policy");
    expect(calls[1].system).toContain("IMPORTANT: Your previous response was invalid");
  });

  it("injects output language policy into mem::flow-compress", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const { registerFlowCompressFunction } = await import(
      "../src/functions/flow-compress.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(`<summary>
<goal>Ship auth fix</goal>
<outcome>Auth middleware was fixed</outcome>
<steps>1. Read src/auth.ts</steps>
<discoveries>JWT clock skew mattered</discoveries>
<lesson>Check token expiry boundaries</lesson>
</summary>`),
    };
    await kv.set("mem:actions", "act_1", {
      id: "act_1",
      title: "Fix auth",
      description: "Repair JWT validation",
      status: "done",
      priority: 5,
      result: "Fixed",
      tags: ["JWT"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
      createdBy: "agent",
    });
    registerFlowCompressFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::flow-compress", {
      actionIds: ["act_1"],
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provider.summarize).toHaveBeenCalledWith(
      expect.stringContaining("AgentMemory Output Language Policy"),
      expect.any(String),
    );
  });
});

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) return {};
      return fn(payload);
    },
  };
}
