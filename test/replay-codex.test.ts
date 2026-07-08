import { describe, expect, it, beforeEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTranscriptFormat } from "../src/replay/format.js";
import { parseCodexJsonlText } from "../src/replay/codex-jsonl-parser.js";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { computeSourceFileHash } from "../src/replay/import-identity.js";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, Session } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockSearchAdd, mockReindexSessions } = vi.hoisted(() => ({
  mockSearchAdd: vi.fn(),
  mockReindexSessions: vi.fn(async () => ({ indexed: 0, failedSessionIds: [] })),
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: mockSearchAdd }),
  rebuildIndex: vi.fn(async () => 0),
  flushIndexSaveStrict: vi.fn(async () => false),
  reindexSessions: mockReindexSessions,
}));

const fixturePath = (...parts: string[]) =>
  join(__dirname, "fixtures", "jsonl", ...parts);

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls: Array<{ scope: string; key: string; value: unknown }> = [];
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      setCalls.push({ scope, key, value });
      if (!store.has(scope)) store.set(scope, new Map());
      if (key === undefined) {
        throw new Error("missing field `key`");
      }
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    getSetCalls: () => setCalls,
  };
}

function noopProvider(): MemoryProvider {
  return {
    name: "noop",
    compress: vi.fn().mockResolvedValue(""),
    summarize: vi.fn().mockResolvedValue(""),
  };
}

function mockSdk(kv: ReturnType<typeof mockKV>) {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => fns.set(id, handler),
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : (idOrInput as { payload?: unknown }).payload;
      const fn = fns.get(id);
      if (!fn) return { success: false, error: `missing function: ${id}` };
      return fn(payload);
    },
    _kv: kv,
  } as any;
}

describe("replay import copy", () => {
  it("does not describe import-jsonl as Claude-only", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf-8");
    const viewer = readFileSync(
      join(__dirname, "..", "src", "viewer", "index.html"),
      "utf-8",
    );

    expect(cli).not.toContain("Import Claude Code JSONL transcripts");
    expect(viewer).not.toContain("import Claude Code JSONL transcripts");
    expect(cli).toContain("Claude Code or Codex");
    expect(viewer).toContain("Claude Code or Codex");
  });

  it("documents and forwards bulk import controls from the CLI", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf-8");

    expect(cli).toContain("--manual-index");
    expect(cli).not.toContain("--defer-index");
    expect(cli).not.toContain("--deferred-index");
    expect(cli).toContain("--no-lesson-extraction");
    expect(cli).toContain("--timeout-ms <N>");
    expect(cli).toContain('body["indexMode"] = "manual"');
    expect(cli).toContain('body["lessonExtraction"] = { enabled: false }');
    expect(cli).toContain("AbortSignal.timeout(timeoutMs)");
    expect(cli).toContain("finalize-replay-index");
    expect(cli).toContain("/agentmemory/replay/finalize-deferred-index");
  });

  it("rejects removed legacy import index flags before making an import request", () => {
    for (const flag of ["--defer-index", "--deferred-index"]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", join(__dirname, "..", "src", "cli.ts"), "import-jsonl", flag],
        {
          cwd: join(__dirname, ".."),
          encoding: "utf-8",
        },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        `Unknown import-jsonl option: ${flag}`,
      );
    }
  });
});

describe("codex replay fixtures", () => {
  it("detects Codex rollout JSONL from the minimal public-reference fixture", () => {
    const text = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    expect(detectTranscriptFormat(text)).toBe("codex");
  });

  it("returns unknown when Codex markers appear after the first 20 valid JSON rows", () => {
    const lines = [
      ...Array.from({ length: 20 }, (_value, index) => JSON.stringify(index)),
      JSON.stringify({ type: "session_meta" }),
      JSON.stringify({ type: "response_item" }),
    ];
    expect(detectTranscriptFormat(lines.join("\n"))).toBe("unknown");
  });

  it("treats malformed lines as non-counted while keeping a real Codex marker window under 20 valid rows", () => {
    const lines = [
      ...Array.from({ length: 18 }, (_value, index) => JSON.stringify(index)),
      "{not-json}",
      JSON.stringify({ type: "session_meta" }),
      JSON.stringify({ type: "response_item" }),
    ];
    expect(detectTranscriptFormat(lines.join("\n"))).toBe("codex");
  });

  it("returns unknown when transcript shape is not Claude or Codex", () => {
    const text = [JSON.stringify({ type: "foo" }), JSON.stringify({ type: "bar" })].join("\n");
    expect(detectTranscriptFormat(text)).toBe("unknown");
  });

  it("keeps existing Claude Code JSONL detection", () => {
    const text = readFileSync(fixturePath("basic.jsonl"), "utf-8");
    expect(detectTranscriptFormat(text)).toBe("claude-code");
  });

  it("keeps a minimal public-reference Codex rollout fixture", () => {
    const text = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines.some((entry) => entry.type === "session_meta")).toBe(true);
    expect(lines.some((entry) => entry.type === "response_item")).toBe(true);
    expect(
      lines.some(
        (entry) =>
          entry.type === "event_msg" &&
          entry.payload?.type === "user_message" &&
          typeof entry.payload?.message === "string",
      ),
    ).toBe(true);
  });

  it("records lightweight source notes without binding to local paths", () => {
    const manifest = JSON.parse(
      readFileSync(fixturePath("codex-sample-manifest.json"), "utf-8"),
    ) as {
      schema: string;
      publicReferences: string[];
      localValidation: {
        requiredLongSessions: number;
        requiredDevelopmentSessions: number;
        requiredNonDevelopmentSessions: number;
        pathPolicy: string;
      };
    };

    expect(manifest.schema).toBe("agentmemory_codex_sample_manifest.v1");
    expect(manifest.publicReferences).toContain(
      "openai/codex:codex-rs/app-server/tests/common/rollout.rs",
    );
    expect(manifest.publicReferences).toContain(
      "MemPalace/mempalace:mempalace/normalize.py",
    );
    expect(manifest.localValidation.requiredLongSessions).toBeGreaterThanOrEqual(5);
    expect(manifest.localValidation.requiredDevelopmentSessions).toBeGreaterThanOrEqual(3);
    expect(manifest.localValidation.requiredNonDevelopmentSessions).toBeGreaterThanOrEqual(2);
    expect(manifest.localValidation.pathPolicy).toBe("do-not-commit-local-absolute-paths");
  });
});

describe("parseCodexJsonlText", () => {
  it("maps minimal Codex user and assistant events to observations", () => {
    const text = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    const parsed = parseCodexJsonlText(text, "fallback-session");

    expect(parsed.sessionId).not.toBe("fallback-session");
    expect(parsed.observations.length).toBeGreaterThanOrEqual(2);
    expect(parsed.observations.some((o) => o.hookType === "prompt_submit")).toBe(true);
    expect(parsed.observations.some((o) => o.hookType === "stop")).toBe(true);
  });

  it("tolerates Codex response_item duplicates without creating extra prompt observations", () => {
    const text = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    const parsed = parseCodexJsonlText(text, "fallback-session");

    const promptObservations = parsed.observations.filter((o) => o.hookType === "prompt_submit");
    expect(promptObservations).toHaveLength(1);
  });

  it("uses fallback sessionId when session_meta payload id is missing", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/workspace/example" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Hello" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");
    expect(parsed.sessionId).toBe("fallback-session");
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]?.userPrompt).toBe("Hello");
  });

  it("falls back project to unknown when no cwd is present", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-without-cwd" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Hello" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");
    expect(parsed.project).toBe("unknown");
    expect(parsed.sessionId).toBe("session-without-cwd");
    expect(parsed.observations).toHaveLength(1);
  });

  it("reads nested session_meta.meta.id and session_meta.meta.cwd for sessionId and cwd", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          meta: {
            id: "nested-codex-session",
            cwd: "/workspace/nested-codex-project",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Hello from nested meta" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");
    expect(parsed.sessionId).toBe("nested-codex-session");
    expect(parsed.cwd).toBe("/workspace/nested-codex-project");
    expect(parsed.project).toBe("nested-codex-project");
    expect(parsed.observations[0]?.sessionId).toBe("nested-codex-session");
    expect(parsed.sessionId).not.toBe("fallback-session");
  });

  it("keeps flat session_meta payload fields over nested meta fields", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "flat-codex-session",
          cwd: "/workspace/flat-codex-project",
          meta: {
            id: "nested-codex-session",
            cwd: "/workspace/nested-codex-project",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Hello from flat meta" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");
    expect(parsed.sessionId).toBe("flat-codex-session");
    expect(parsed.cwd).toBe("/workspace/flat-codex-project");
  });

  it("returns same parsed.sessionId across repeated parses of one nested-meta transcript", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          meta: {
            id: "nested-stable-session",
            cwd: "/workspace/nested-codex-project",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Stable import test" },
      }),
    ].join("\n");

    const first = parseCodexJsonlText(text, "fallback-first");
    const second = parseCodexJsonlText(text, "fallback-second");
    expect(first.sessionId).toBe("nested-stable-session");
    expect(second.sessionId).toBe("nested-stable-session");
    expect(first.sessionId).toBe(second.sessionId);
  });

  it("skips malformed JSON rows and still parses following event_msg rows", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-valid", cwd: "/workspace/example" },
      }),
      "{malformed-json",
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "After malformed line" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Parsed normally too" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");

    const userObs = parsed.observations.find((o) => o.hookType === "prompt_submit");
    const stopObs = parsed.observations.find((o) => o.hookType === "stop");
    expect(userObs?.userPrompt).toBe("After malformed line");
    expect(stopObs?.assistantResponse).toBe("Parsed normally too");
    expect(parsed.observations).toHaveLength(2);
  });

  it("preserves at least one event object as raw observation data", () => {
    const text = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    const parsed = parseCodexJsonlText(text, "fallback-session");
    const userObs = parsed.observations.find((o) => o.hookType === "prompt_submit");

    expect(userObs).toBeDefined();
    expect(userObs?.raw).toMatchObject({
      type: "event_msg",
      payload: { type: "user_message", message: "Inspect the sample project" },
    });
  });

  it("maps Codex tool call and tool result rows to pre/post tool observations", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "safe-session", cwd: "/tmp/safe-codex-project" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "fn-call",
          name: "safe_function",
          arguments: { safe: true },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "fn-call",
          output: { status: "ok" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "custom-call",
          name: "safe_custom",
          input: { safe: "input" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "custom-call",
          output: { status: "ok" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:05.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          action: { query: "safe query" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:06.000Z",
        type: "event_msg",
        payload: {
          type: "web_search_end",
          call_id: "web-call",
          query: "safe query",
          action: "safe_action_result",
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:07.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "safe user prompt" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:08.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "safe assistant response" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");
    const preToolCalls = parsed.observations.filter((o) => o.hookType === "pre_tool_use");
    const postToolCalls = parsed.observations.filter((o) => o.hookType === "post_tool_use");

    expect(preToolCalls).toHaveLength(3);
    expect(postToolCalls).toHaveLength(3);
    expect(preToolCalls.map((o) => o.toolName)).toEqual(
      expect.arrayContaining(["safe_function", "safe_custom", "web_search"]),
    );
    expect(postToolCalls.map((o) => o.toolName)).toEqual(
      expect.arrayContaining([undefined, undefined, "web_search"]),
    );
    const webResult = parsed.observations.find(
      (o) => o.hookType === "post_tool_use" && o.toolName === "web_search",
    );
    expect(webResult?.toolInput).toMatchObject({ toolUseId: "web-call", query: "safe query" });
    expect(parsed.observations.some((o) => o.hookType === "prompt_submit")).toBe(true);
    expect(parsed.observations.some((o) => o.hookType === "stop")).toBe(true);
  });

  it("maps execution, patch, and generic error rows as post_tool_failure", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "safe-session-error", cwd: "/tmp/safe-codex-project-error" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "exec-call",
          command: "safe command",
          cwd: "/tmp/safe-codex-project-error",
          exit_code: 1,
          status: "failed",
          stdout: "safe stdout",
          stderr: "safe stderr",
          aggregated_output: "safe aggregated output",
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "patch-call",
          success: false,
          status: "failed",
          stdout: "safe patch stdout",
          stderr: "safe patch stderr",
          changes: ["safe change line"],
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "error",
          message: "safe error",
          codex_error_info: { code: "SAFE", reason: "placeholder" },
        },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, "fallback-session");
    const failures = parsed.observations.filter((o) => o.hookType === "post_tool_failure");

    expect(failures).toHaveLength(3);
    expect(failures.map((o) => o.toolName)).toEqual(
      expect.arrayContaining(["exec_command", "apply_patch", "codex"]),
    );

    const execFailure = failures.find((o) => o.toolName === "exec_command");
    expect(execFailure?.toolInput).toMatchObject({
      toolUseId: "exec-call",
      command: "safe command",
      cwd: "/tmp/safe-codex-project-error",
    });
    expect(execFailure?.toolOutput).toMatchObject({
      exit_code: 1,
      status: "failed",
      aggregated_output: "safe aggregated output",
    });

    const patchFailure = failures.find((o) => o.toolName === "apply_patch");
    expect(patchFailure?.toolOutput).toMatchObject({
      success: false,
      status: "failed",
      changes: ["safe change line"],
    });

    const errorFailure = failures.find((o) => o.toolName === "codex");
    expect(errorFailure?.toolOutput).toMatchObject({
      message: "safe error",
      codex_error_info: { code: "SAFE", reason: "placeholder" },
    });
  });

  it("returns stable observation ids across repeated parses with import context", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "stable-codex-session", cwd: "/workspace/stable" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "user-msg-1", message: "hello" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "safe_function",
          arguments: { safe: true },
        },
      }),
    ].join("\n");
    const context = {
      sourceFormat: "codex" as const,
      sourceFileHash: computeSourceFileHash(text),
    };

    const first = parseCodexJsonlText(text, undefined, context);
    const second = parseCodexJsonlText(text, undefined, context);

    expect(first.observations.map((obs) => obs.id)).toEqual(
      second.observations.map((obs) => obs.id),
    );
    expect(first.observations.every((obs) => obs.importKey === obs.id)).toBe(true);
  });

  it("carries Codex parent_thread_id lineage to parsed transcript and observations", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "child-codex-session",
          cwd: "/workspace/child",
          parent_thread_id: "parent-codex-session",
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "child work" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, undefined, {
      sourceFormat: "codex",
      sourceFileHash: computeSourceFileHash(text),
    });

    expect(parsed.lineage).toBe("child");
    expect(parsed.parentSessionId).toBe("parent-codex-session");
    expect(parsed.observations[0].lineage).toBe("child");
    expect(parsed.observations[0].parentSessionId).toBe("parent-codex-session");
  });

  it("carries Codex meta.parent_thread_id lineage to parsed transcript and observations", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          meta: {
            id: "child-codex-session-meta",
            cwd: "/workspace/child-meta",
            parent_thread_id: "parent-codex-session-meta",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "child meta work" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonlText(text, undefined, {
      sourceFormat: "codex",
      sourceFileHash: computeSourceFileHash(text),
    });

    expect(parsed.lineage).toBe("child");
    expect(parsed.parentSessionId).toBe("parent-codex-session-meta");
    expect(parsed.observations[0].lineage).toBe("child");
    expect(parsed.observations[0].parentSessionId).toBe("parent-codex-session-meta");
  });
});

describe("replay import sdk", () => {
  let tmpRoot: string;
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "replay-codex-import-"));
    kv = mockKV();
    sdk = mockSdk(kv);
    mockSearchAdd.mockClear();
    mockReindexSessions.mockClear();
    mockReindexSessions.mockResolvedValue({ indexed: 0, failedSessionIds: [] });
    registerReplayFunctions(sdk, kv as never, noopProvider());
  });

  function writeCodexFixture() {
    const dir = join(tmpRoot, "project");
    require("node:fs").mkdirSync(dir, { recursive: true });
    const fixtureText = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    writeFileSync(join(dir, "session.jsonl"), fixtureText);
    return dir;
  }

  it("imports minimal public-reference Codex fixture and loads timeline prompt/response", async () => {
    const dir = writeCodexFixture();
    const importResult = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
    })) as {
      success: boolean;
      sessionIds?: string[];
      imported?: number;
      observations?: number;
      error?: string;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.imported).toBeGreaterThanOrEqual(1);
    expect(importResult.observations).toBeGreaterThanOrEqual(2);
    expect(importResult.sessionIds?.length).toBeGreaterThan(0);
    const sessionId = importResult.sessionIds?.[0];
    expect(typeof sessionId).toBe("string");

    const loadResult = (await sdk.trigger("mem::replay::load", {
      sessionId: sessionId!,
    })) as { success: boolean; timeline?: { events?: { kind: string }[] }; error?: string };

    expect(loadResult.success).toBe(true);
    const kinds = (loadResult.timeline?.events || []).map((e) => e.kind);
    expect(kinds).toContain("prompt");
    expect(kinds).toContain("response");
  });

  it("skips duplicate observations on repeated import of the same directory", async () => {
    const dir = writeCodexFixture();

    const first = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      sessionIds?: string[];
      created?: number;
      observations?: number;
    };
    const sessionId = first.sessionIds![0];
    const beforeSession = await kv.get<Session>(KV.sessions, sessionId);
    const firstTimeline = (await sdk.trigger("mem::replay::load", {
      sessionId,
    })) as { success: boolean; timeline: { eventCount: number } };

    const second = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      created?: number;
      skippedDuplicate?: number;
      sessionIds?: string[];
    };
    const afterSession = await kv.get<Session>(KV.sessions, sessionId);
    const secondTimeline = (await sdk.trigger("mem::replay::load", {
      sessionId,
    })) as { success: boolean; timeline: { eventCount: number } };

    expect(second.success).toBe(true);
    expect(second.created).toBe(0);
    expect(second.skippedDuplicate).toBeGreaterThan(0);
    expect(afterSession?.observationCount).toBe(beforeSession?.observationCount);
    expect(secondTimeline.timeline.eventCount).toBe(firstTimeline.timeline.eventCount);
    expect(mockSearchAdd).not.toHaveBeenCalled();
    const audits = await kv.list<any>(KV.audit);
    expect(JSON.stringify(audits)).not.toContain(dir);
    expect(JSON.stringify(audits)).toContain("sourceFileHashes");
  });

  it("deduplicates the same JSONL content copied to a different filename", async () => {
    const dir = join(tmpRoot, "copy-dedupe");
    mkdirSync(dir, { recursive: true });
    const fixtureText = readFileSync(fixturePath("codex-minimal-openai-style.jsonl"), "utf-8");
    writeFileSync(join(dir, "a.jsonl"), fixtureText);

    const first = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      sessionIds?: string[];
      created?: number;
    };
    const sessionId = first.sessionIds![0];
    const beforeObservations = await kv.list(KV.observations(sessionId));

    writeFileSync(join(dir, "b-copy.jsonl"), fixtureText);
    const second = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      created?: number;
      skippedDuplicate?: number;
      sessionIds?: string[];
    };
    const afterObservations = await kv.list(KV.observations(sessionId));

    expect(second.success).toBe(true);
    expect(second.created).toBe(0);
    expect(second.skippedDuplicate).toBeGreaterThanOrEqual(beforeObservations.length);
    expect(afterObservations).toHaveLength(beforeObservations.length);
    expect(new Set(second.sessionIds).size).toBe(second.sessionIds?.length);
  });

  it("does not append per-observation index entries when importing overlapping Codex files", async () => {
    const dir = join(tmpRoot, "overlap");
    mkdirSync(dir, { recursive: true });
    const oldText = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "overlap-session", cwd: "/workspace/overlap" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "prompt-1", message: "old prompt" },
      }),
    ].join("\n");
    const newText = [
      oldText,
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", id: "response-1", message: "new response" },
      }),
    ].join("\n");
    writeFileSync(join(dir, "01-old.jsonl"), oldText);
    const first = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      created?: number;
    };

    writeFileSync(join(dir, "02-new.jsonl"), newText);
    const second = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      created?: number;
      skippedDuplicate?: number;
    };

    expect(first.created).toBe(1);
    expect(second.success).toBe(true);
    expect(second.created).toBe(1);
    expect(second.skippedDuplicate).toBeGreaterThan(0);
    expect(mockSearchAdd).not.toHaveBeenCalled();
    expect(mockReindexSessions).toHaveBeenCalledWith(expect.anything(), ["overlap-session"]);
  });

  it("does not reinforce old lessons or drop crystal lesson links on overlapping import", async () => {
    const dir = join(tmpRoot, "overlap-lessons");
    mkdirSync(dir, { recursive: true });
    const oldText = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "overlap-lesson-session", cwd: "/workspace/overlap-lessons" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          id: "lesson-prompt-1",
          message: "Always validate import keys before writing duplicate observations.",
        },
      }),
    ].join("\n");
    const newText = [
      oldText,
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          id: "non-lesson-response-1",
          message: "Imported the new event.",
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "01-old.jsonl"), oldText);

    await sdk.trigger("mem::replay::import-jsonl", { path: dir });
    const firstLessons = await kv.list<any>(KV.lessons);
    const firstCrystals = await kv.list<any>(KV.crystals);
    expect(firstLessons).toHaveLength(1);
    expect(firstLessons[0].reinforcements).toBe(0);
    expect(firstCrystals[0].lessons).toContain(firstLessons[0].id);

    writeFileSync(join(dir, "02-new.jsonl"), newText);
    const second = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      created?: number;
      skippedDuplicate?: number;
    };
    const secondLessons = await kv.list<any>(KV.lessons);
    const secondCrystals = await kv.list<any>(KV.crystals);

    expect(second.success).toBe(true);
    expect(second.created).toBe(1);
    expect(second.skippedDuplicate).toBeGreaterThan(0);
    expect(secondLessons).toHaveLength(1);
    expect(secondLessons[0].reinforcements).toBe(0);
    expect(secondCrystals[0].lessons).toContain(firstLessons[0].id);
  });

  it("extracts Chinese replay lessons and links them to crystals", async () => {
    const dir = join(tmpRoot, "zh-lesson");
    mkdirSync(dir, { recursive: true });
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "zh-lesson-session", cwd: "/workspace/zh-lesson" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          id: "zh-lesson-prompt-1",
          message: "以后回答 AgentMemory 机制问题必须依据源码和测试，不能猜测。",
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), text);

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
    })) as {
      success: boolean;
      sessionIds?: string[];
      lessonExtraction?: { created: number; sessions?: Record<string, unknown> };
    };

    expect(result.success).toBe(true);
    expect(result.lessonExtraction?.created).toBe(1);

    const lessons = await kv.list<any>(KV.lessons);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].id).toMatch(/^lesson_/);
    expect(lessons[0].content).toContain("以后回答 AgentMemory 机制问题必须依据源码和测试");

    const crystals = await kv.list<any>(KV.crystals);
    expect(crystals).toHaveLength(1);
    expect(crystals[0].lessons).toContain(lessons[0].id);
    expect(result.sessionIds?.[0]).toBe(crystals[0].sessionId);
  });

  it("does not create or reinforce lessons when mode is off and still keeps crystal links", async () => {
    const dir = join(tmpRoot, "off-mode");
    mkdirSync(dir, { recursive: true });
    const baseText = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "off-mode-session", cwd: "/workspace/off-mode" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          id: "off-mode-prompt",
          message:
            "Always validate import keys before writing duplicate observations.",
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "01-base.jsonl"), baseText);

    await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
    });

    const firstLessons = await kv.list<any>(KV.lessons);
    const firstCrystal = (await kv.list<any>(KV.crystals))[0];
    expect(firstLessons).toHaveLength(1);
    expect(firstCrystal.lessons).toHaveLength(1);

    const updateText = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "session_meta",
        payload: { id: "off-mode-session", cwd: "/workspace/off-mode" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "assistant_message",
          id: "off-mode-assistant",
          message: "继续记录这个会话。",
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "02-update.jsonl"), updateText);

    const second = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as {
      success: boolean;
      lessonExtraction?: {
        enabled: boolean;
        created: number;
        reinforced: number;
        skipped: number;
        sessions?: Record<string, unknown>;
      };
    };

    const secondLessons = await kv.list<any>(KV.lessons);
    const secondCrystal = (await kv.list<any>(KV.crystals))[0];

    expect(second.success).toBe(true);
    expect(second.lessonExtraction?.enabled).toBe(false);
    expect(second.lessonExtraction?.created).toBe(0);
    expect(second.lessonExtraction?.reinforced).toBe(0);
    expect(secondLessons).toHaveLength(1);
    expect(secondLessons[0].id).toBe(firstLessons[0].id);
    expect(secondCrystal.lessons).toEqual(firstCrystal.lessons);
  });

  it("rejects legacy lesson extraction mode in SDK replay import calls", async () => {
    const dir = join(tmpRoot, "reject-lesson-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "reject-mode-session", cwd: "/workspace/reject-mode" },
      }),
    );

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { mode: "off" },
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid lessonExtraction");
  });

  it("uses one stable target session id for copied Codex JSONL without real session id", async () => {
    const dir = join(tmpRoot, "stable-fallback");
    mkdirSync(dir, { recursive: true });
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/workspace/no-real-session" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "no-session-prompt", message: "hello" },
      }),
    ].join("\n");
    writeFileSync(join(dir, "one.jsonl"), text);
    const first = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      sessionIds?: string[];
    };
    writeFileSync(join(dir, "two-copy.jsonl"), text);
    const second = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      sessionIds?: string[];
      created?: number;
    };

    expect(first.sessionIds).toHaveLength(1);
    expect(second.sessionIds).toEqual(first.sessionIds);
    expect(second.created).toBe(0);
    const sessions = await kv.list<Session>(KV.sessions);
    expect(sessions).toHaveLength(1);
  });

  it("merges Codex child sessions only when the parent session exists", async () => {
    const parentDir = join(tmpRoot, "child-merge-parent-first");
    mkdirSync(parentDir, { recursive: true });
    const parent = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "parent-session", cwd: "/workspace/parent" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "parent-prompt", message: "parent" },
      }),
    ].join("\n");
    const child = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "child-session",
          cwd: "/workspace/child",
          parent_thread_id: "parent-session",
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "child-prompt", message: "child" },
      }),
    ].join("\n");
    writeFileSync(join(parentDir, "01-parent.jsonl"), parent);
    writeFileSync(join(parentDir, "02-child.jsonl"), child);

    const merged = (await sdk.trigger("mem::replay::import-jsonl", {
      path: parentDir,
    })) as {
      success: boolean;
      mergedChildSession?: number;
      filteredChildSession?: number;
      sessionIds?: string[];
    };

    expect(merged.success).toBe(true);
    expect(merged.mergedChildSession).toBeGreaterThanOrEqual(1);
    expect(merged.filteredChildSession).toBe(0);
    expect(await kv.get<Session>(KV.sessions, "child-session")).toBeNull();
    expect(await kv.list(KV.observations("parent-session"))).toHaveLength(2);

    const childOnlyDir = join(tmpRoot, "child-filtered");
    mkdirSync(childOnlyDir, { recursive: true });
    const missingParentChild = child.replaceAll("parent-session", "missing-parent-session");
    writeFileSync(join(childOnlyDir, "child.jsonl"), missingParentChild);
    const filtered = (await sdk.trigger("mem::replay::import-jsonl", {
      path: childOnlyDir,
    })) as {
      success: boolean;
      filteredChildSession?: number;
    };

    expect(filtered.success).toBe(true);
    expect(filtered.filteredChildSession).toBeGreaterThanOrEqual(1);
    expect(await kv.get<Session>(KV.sessions, "child-session")).toBeNull();
  });

  it("merges Codex child sessions even when the child file sorts before the parent file", async () => {
    const dir = join(tmpRoot, "child-before-parent");
    mkdirSync(dir, { recursive: true });
    const parent = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "late-parent-session", cwd: "/workspace/late-parent" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "late-parent-prompt", message: "parent" },
      }),
    ].join("\n");
    const child = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "early-child-session",
          cwd: "/workspace/early-child",
          parent_thread_id: "late-parent-session",
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", id: "early-child-prompt", message: "child" },
      }),
    ].join("\n");
    writeFileSync(join(dir, "01-child.jsonl"), child);
    writeFileSync(join(dir, "02-parent.jsonl"), parent);

    const result = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      mergedChildSession?: number;
      filteredChildSession?: number;
    };

    expect(result.success).toBe(true);
    expect(result.mergedChildSession).toBeGreaterThanOrEqual(1);
    expect(result.filteredChildSession).toBe(0);
    expect(await kv.get<Session>(KV.sessions, "early-child-session")).toBeNull();
    expect(await kv.list(KV.observations("late-parent-session"))).toHaveLength(2);
  });

  it("merges or filters Claude sidechain sessions without creating top-level sidechain sessions", async () => {
    const dir = join(tmpRoot, "claude-sidechain");
    mkdirSync(dir, { recursive: true });
    const parent = JSON.stringify({
      type: "user",
      uuid: "parent-uuid",
      sessionId: "claude-parent",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/workspace/claude-parent",
      message: { role: "user", content: [{ type: "text", text: "parent work" }] },
    });
    const sidechain = JSON.stringify({
      type: "user",
      uuid: "sidechain-uuid",
      sessionId: "claude-sidechain",
      parentSessionId: "claude-parent",
      timestamp: "2026-01-01T00:00:01.000Z",
      cwd: "/workspace/claude-sidechain",
      isSidechain: true,
      message: { role: "user", content: [{ type: "text", text: "sidechain work" }] },
    });
    writeFileSync(join(dir, "01-parent.jsonl"), parent);
    writeFileSync(join(dir, "02-sidechain.jsonl"), sidechain);

    const merged = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      mergedSidechainSession?: number;
      filteredSidechainSession?: number;
    };

    expect(merged.success).toBe(true);
    expect(merged.mergedSidechainSession).toBeGreaterThanOrEqual(1);
    expect(merged.filteredSidechainSession).toBe(0);
    expect(await kv.get<Session>(KV.sessions, "claude-sidechain")).toBeNull();
    expect(await kv.list(KV.observations("claude-parent"))).toHaveLength(2);

    const missingParentDir = join(tmpRoot, "claude-sidechain-filtered");
    mkdirSync(missingParentDir, { recursive: true });
    const orphanSidechain = JSON.stringify({
      type: "user",
      uuid: "orphan-sidechain-uuid",
      sessionId: "orphan-sidechain",
      parentSessionId: "missing-claude-parent",
      timestamp: "2026-01-01T00:00:01.000Z",
      cwd: "/workspace/orphan-sidechain",
      isSidechain: true,
      message: { role: "user", content: [{ type: "text", text: "orphan sidechain" }] },
    });
    writeFileSync(join(missingParentDir, "orphan.jsonl"), orphanSidechain);
    const filtered = (await sdk.trigger("mem::replay::import-jsonl", {
      path: missingParentDir,
    })) as {
      success: boolean;
      filteredSidechainSession?: number;
    };

    expect(filtered.success).toBe(true);
    expect(filtered.filteredSidechainSession).toBeGreaterThanOrEqual(1);
    expect(await kv.get<Session>(KV.sessions, "orphan-sidechain")).toBeNull();
  });

  it("merges Claude sidechain sessions even when the sidechain file sorts before the parent file", async () => {
    const dir = join(tmpRoot, "sidechain-before-parent");
    mkdirSync(dir, { recursive: true });
    const parent = JSON.stringify({
      type: "user",
      uuid: "late-parent-uuid",
      sessionId: "late-claude-parent",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/workspace/late-claude-parent",
      message: { role: "user", content: [{ type: "text", text: "parent work" }] },
    });
    const sidechain = JSON.stringify({
      type: "user",
      uuid: "early-sidechain-uuid",
      sessionId: "early-claude-sidechain",
      parentSessionId: "late-claude-parent",
      timestamp: "2026-01-01T00:00:01.000Z",
      cwd: "/workspace/early-claude-sidechain",
      isSidechain: true,
      message: { role: "user", content: [{ type: "text", text: "sidechain work" }] },
    });
    writeFileSync(join(dir, "01-sidechain.jsonl"), sidechain);
    writeFileSync(join(dir, "02-parent.jsonl"), parent);

    const result = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      mergedSidechainSession?: number;
      filteredSidechainSession?: number;
    };

    expect(result.success).toBe(true);
    expect(result.mergedSidechainSession).toBeGreaterThanOrEqual(1);
    expect(result.filteredSidechainSession).toBe(0);
    expect(await kv.get<Session>(KV.sessions, "early-claude-sidechain")).toBeNull();
    expect(await kv.list(KV.observations("late-claude-parent"))).toHaveLength(2);
  });

  it("imports Claude parentUuid-only sessions as top-level sessions", async () => {
    const dir = join(tmpRoot, "claude-parentuuid-main");
    mkdirSync(dir, { recursive: true });
    const text = JSON.stringify({
      type: "user",
      uuid: "main-child-event",
      parentUuid: "main-parent-event",
      sessionId: "claude-main-with-parentuuid",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/workspace/main",
      message: { role: "user", content: [{ type: "text", text: "main session" }] },
    });
    writeFileSync(join(dir, "main.jsonl"), text);

    const result = (await sdk.trigger("mem::replay::import-jsonl", { path: dir })) as {
      success: boolean;
      created?: number;
      filteredSidechainSession?: number;
      mergedSidechainSession?: number;
      sessionIds?: string[];
    };

    expect(result.success).toBe(true);
    expect(result.created).toBe(1);
    expect(result.filteredSidechainSession).toBe(0);
    expect(result.mergedSidechainSession).toBe(0);
    expect(result.sessionIds).toEqual(["claude-main-with-parentuuid"]);
    expect(await kv.get<Session>(KV.sessions, "claude-main-with-parentuuid")).not.toBeNull();
  });
});
