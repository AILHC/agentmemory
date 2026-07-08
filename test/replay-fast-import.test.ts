import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, Session } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  mockSearchAdd,
  mockSearchHas,
  mockRebuildIndex,
  mockFlushIndexSaveStrict,
  mockReindexSessions,
} = vi.hoisted(() => ({
  mockSearchAdd: vi.fn(),
  mockSearchHas: vi.fn(() => false),
  mockRebuildIndex: vi.fn(async () => 7),
  mockFlushIndexSaveStrict: vi.fn(async () => true),
  mockReindexSessions: vi.fn(async () => ({ indexed: 1, failedSessionIds: [] })),
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: mockSearchAdd, has: mockSearchHas }),
  rebuildIndex: mockRebuildIndex,
  flushIndexSaveStrict: mockFlushIndexSaveStrict,
  reindexSessions: mockReindexSessions,
}));

type SetBehavior = {
  kind: "commit-then-timeout" | "timeout-before-commit";
  match: (scope: string, key: string, value: unknown) => boolean;
  used?: boolean;
};

function timeoutError(message = "state::set timed out after 30000ms") {
  const err = new Error(message) as Error & { code?: string };
  err.code = "TIMEOUT";
  return err;
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls: Array<{ scope: string; key: string; value: unknown }> = [];
  const getCalls: Array<{ scope: string; key: string }> = [];
  const listCalls: Array<{ scope: string }> = [];
  const behaviors: SetBehavior[] = [];

  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      getCalls.push({ scope, key });
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      setCalls.push({ scope, key, value });
      if (key === undefined) throw new Error("missing field `key`");
      const behavior = behaviors.find((candidate) => !candidate.used && candidate.match(scope, key, value));
      if (behavior?.kind === "timeout-before-commit") {
        behavior.used = true;
        throw timeoutError();
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      if (behavior?.kind === "commit-then-timeout") {
        behavior.used = true;
        throw timeoutError();
      }
      return value;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push({ scope });
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
    getSetCalls: () => setCalls,
    getGetCalls: () => getCalls,
    getListCalls: () => listCalls,
    addBehavior: (behavior: SetBehavior) => {
      behaviors.push(behavior);
    },
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
      const payload =
        typeof idOrInput === "string"
          ? data
          : (idOrInput as { payload?: unknown }).payload;
      const fn = fns.get(id);
      if (!fn) return { success: false, error: `missing function: ${id}` };
      return fn(payload);
    },
  } as any;
}

function writeCodexSession(
  dir: string,
  name: string,
  opts: {
    sessionId: string;
    events: Array<{
      id: string;
      role: "user" | "assistant";
      message: string;
      timestamp: string;
    }>;
    meta?: Record<string, unknown>;
  },
) {
  const lines = [
    JSON.stringify({
      timestamp: opts.events[0]?.timestamp ?? "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: opts.sessionId,
        cwd: `/workspace/${opts.sessionId}`,
        ...opts.meta,
      },
    }),
    ...opts.events.map((event) =>
      JSON.stringify({
        timestamp: event.timestamp,
        type: "event_msg",
        payload: {
          type: event.role === "user" ? "user_message" : "agent_message",
          id: event.id,
          message: event.message,
        },
      }),
    ),
  ];
  writeFileSync(join(dir, name), lines.join("\n"));
}

function hasLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => hasLoneSurrogate(item));
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => hasLoneSurrogate(key) || hasLoneSurrogate(item),
    );
  }
  return false;
}

describe("replay fast import", () => {
  let tmpRoot: string;
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "replay-fast-import-"));
    kv = mockKV();
    sdk = mockSdk(kv);
    mockSearchAdd.mockClear();
    mockSearchHas.mockClear();
    mockSearchHas.mockReturnValue(false);
    mockRebuildIndex.mockClear();
    mockRebuildIndex.mockResolvedValue(7);
    mockFlushIndexSaveStrict.mockClear();
    mockFlushIndexSaveStrict.mockResolvedValue(true);
    mockReindexSessions.mockClear();
    mockReindexSessions.mockResolvedValue({ indexed: 1, failedSessionIds: [] });
    registerReplayFunctions(sdk, kv as never, noopProvider());
  });

  it("can skip session indexing during manual replay import while session remains the default", async () => {
    const manualDir = join(tmpRoot, "manual");
    mkdirSync(manualDir, { recursive: true });
    writeCodexSession(manualDir, "session.jsonl", {
      sessionId: "manual-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "Always validate import keys before writing duplicate observations.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const manual = (await sdk.trigger("mem::replay::import-jsonl", {
      path: manualDir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number; indexing?: { mode: string; requiresFinalize: boolean } };
    expect(manual.success).toBe(true);
    expect(manual.observations).toBeGreaterThan(0);
    expect(manual.indexing).toMatchObject({ mode: "manual", requiresFinalize: true });
    expect(mockSearchAdd).not.toHaveBeenCalled();
    expect(mockReindexSessions).not.toHaveBeenCalled();

    const sessionDir = join(tmpRoot, "session");
    mkdirSync(sessionDir, { recursive: true });
    writeCodexSession(sessionDir, "session.jsonl", {
      sessionId: "session-mode-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "Session indexing runs after import by default.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const sessionMode = (await sdk.trigger("mem::replay::import-jsonl", {
      path: sessionDir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number; indexing?: { mode: string; saved: boolean } };
    expect(sessionMode.success).toBe(true);
    expect(sessionMode.observations).toBeGreaterThan(0);
    expect(sessionMode.indexing).toMatchObject({ mode: "session", saved: true });
    expect(mockSearchAdd).not.toHaveBeenCalled();
    expect(mockReindexSessions).toHaveBeenCalledWith(
      expect.anything(),
      ["session-mode-session"],
      expect.objectContaining({
        includeVector: false,
        shouldIndex: expect.any(Function),
      }),
    );
    expect(mockFlushIndexSaveStrict).toHaveBeenCalledWith({ includeVector: false });
  });

  it("uses brand-new/list/get dedupe paths and filters in-group duplicates once", async () => {
    const brandNewDir = join(tmpRoot, "brand-new");
    mkdirSync(brandNewDir, { recursive: true });
    writeCodexSession(brandNewDir, "session.jsonl", {
      sessionId: "brand-new-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "Brand new imports should avoid listing observations.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const brandNew = (await sdk.trigger("mem::replay::import-jsonl", {
      path: brandNewDir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean };
    expect(brandNew.success).toBe(true);
    expect(
      kv.getListCalls().filter((call) => call.scope === KV.observations("brand-new-session")),
    ).toHaveLength(0);

    const smallDir = join(tmpRoot, "small");
    mkdirSync(smallDir, { recursive: true });
    writeCodexSession(smallDir, "01-base.jsonl", {
      sessionId: "small-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "small baseline",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    await sdk.trigger("mem::replay::import-jsonl", {
      path: smallDir,
      lessonExtraction: { enabled: false },
    });
    kv.getListCalls().length = 0;
    kv.getGetCalls().length = 0;
    writeCodexSession(smallDir, "02-update.jsonl", {
      sessionId: "small-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "small baseline",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "response-1",
          role: "assistant",
          message: "small delta",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    });
    const small = (await sdk.trigger("mem::replay::import-jsonl", {
      path: smallDir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean };
    expect(small.success).toBe(true);
    expect(
      kv.getListCalls().filter((call) => call.scope === KV.observations("small-session")),
    ).toHaveLength(1);

    await kv.set<Session>(KV.sessions, "large-session", {
      id: "large-session",
      project: "large",
      cwd: "/workspace/large-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      observationCount: 2001,
      tags: ["jsonl-import"],
    });
    kv.getListCalls().length = 0;
    kv.getGetCalls().length = 0;
    const largeDir = join(tmpRoot, "large");
    mkdirSync(largeDir, { recursive: true });
    writeCodexSession(largeDir, "session.jsonl", {
      sessionId: "large-session",
      events: [
        {
          id: "response-2",
          role: "assistant",
          message: "large session uses targeted get",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    });
    const large = (await sdk.trigger("mem::replay::import-jsonl", {
      path: largeDir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean };
    expect(large.success).toBe(true);
    expect(
      kv.getListCalls().filter((call) => call.scope === KV.observations("large-session")),
    ).toHaveLength(0);
    expect(
      kv.getGetCalls().filter(
        (call) => call.scope === KV.observations("large-session"),
      ),
    ).toHaveLength(1);

    const duplicateDir = join(tmpRoot, "duplicate");
    mkdirSync(duplicateDir, { recursive: true });
    writeCodexSession(duplicateDir, "01-session.jsonl", {
      sessionId: "duplicate-session",
      events: [
        {
          id: "duplicate-prompt",
          role: "user",
          message: "Always validate import keys before writing duplicate observations.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    writeCodexSession(duplicateDir, "02-session-copy.jsonl", {
      sessionId: "duplicate-session",
      events: [
        {
          id: "duplicate-prompt",
          role: "user",
          message: "Always validate import keys before writing duplicate observations.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    const duplicate = (await sdk.trigger("mem::replay::import-jsonl", {
      path: duplicateDir,
    })) as {
      success: boolean;
      created?: number;
      skippedDuplicate?: number;
      lessonExtraction?: { created: number; reinforced: number };
    };
    expect(duplicate.success).toBe(true);
    expect(duplicate.created).toBe(1);
    expect(duplicate.skippedDuplicate).toBe(1);
    expect(duplicate.lessonExtraction?.created).toBe(1);
    expect(duplicate.lessonExtraction?.reinforced).toBe(0);
  });

  it("sanitizes lone UTF-16 surrogates before replay state writes", async () => {
    const dir = join(tmpRoot, "lone-surrogate");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "lone-surrogate-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: `first prompt has a broken surrogate ${String.fromCharCode(0xd83d)} marker`,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "response-1",
          role: "assistant",
          message: `tool output contains a broken surrogate ${String.fromCharCode(0xd83d)} marker`,
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(2);
    expect(kv.getSetCalls().some((call) => hasLoneSurrogate(call.value))).toBe(false);
    const writtenValues = kv
      .getSetCalls()
      .filter((call) => call.scope === KV.observations("lone-surrogate-session"))
      .map((call) => call.value);
    expect(writtenValues).toHaveLength(2);
    expect(writtenValues.some((value) => hasLoneSurrogate(value))).toBe(false);
  });

  it("sanitizes lone UTF-16 surrogates in replay object keys without changing valid emoji", async () => {
    const dir = join(tmpRoot, "lone-surrogate-key");
    mkdirSync(dir, { recursive: true });
    const brokenKey = `broken${String.fromCharCode(0xd83d)}key`;
    const validEmoji = "valid emoji 😀 remains";
    const lines = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "lone-surrogate-key-session", cwd: "/workspace/key" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "bad_key_tool",
          arguments: {
            [brokenKey]: "value",
            ok: validEmoji,
          },
        },
      }),
    ];
    writeFileSync(join(dir, "session.jsonl"), lines.join("\n"));

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    const stored = await kv.list<{ toolInput?: Record<string, unknown> }>(
      KV.observations("lone-surrogate-key-session"),
    );
    expect(stored.some((value) => hasLoneSurrogate(value))).toBe(false);
    expect(stored[0].toolInput?.ok).toBe(validEmoji);
  });

  it("reconciles session observationCount when resuming a partial importing session", async () => {
    const dir = join(tmpRoot, "partial-resume");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "partial-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "first imported observation",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "response-1",
          role: "assistant",
          message: "second imported observation",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "response-2",
          role: "assistant",
          message: "third imported observation",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    });

    const first = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };
    expect(first.success).toBe(true);
    expect(first.observations).toBe(3);

    const storedObservations = await kv.list<{ id: string }>(
      KV.observations("partial-session"),
    );
    await kv.delete(
      KV.observations("partial-session"),
      storedObservations[storedObservations.length - 1].id,
    );
    await kv.set<Session>(KV.sessions, "partial-session", {
      id: "partial-session",
      project: "/workspace/partial-session",
      cwd: "/workspace/partial-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:02.000Z",
      status: "completed",
      observationCount: 0,
      tags: ["jsonl-import", "jsonl-importing"],
    });

    const resumed = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number; skippedDuplicate?: number };

    expect(resumed.success).toBe(true);
    expect(resumed.observations).toBe(1);
    expect(resumed.skippedDuplicate).toBe(2);
    const session = await kv.get<Session>(KV.sessions, "partial-session");
    expect(session?.observationCount).toBe(3);
    expect(session?.tags).not.toContain("jsonl-importing");
  });

  it("writes the top-level session row before observations and clears jsonl-importing at the end", async () => {
    const dir = join(tmpRoot, "early-row");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "early-row-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "top level session row should exist before observations",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean };
    expect(result.success).toBe(true);

    const setCalls = kv.getSetCalls();
    const firstObservationWriteIndex = setCalls.findIndex(
      (call) => call.scope === KV.observations("early-row-session"),
    );
    const earlySessionWrite = setCalls.find(
      (call, index) =>
        index < firstObservationWriteIndex &&
        call.scope === KV.sessions &&
        call.key === "early-row-session" &&
        Array.isArray((call.value as Session).tags) &&
        (call.value as Session).tags?.includes("jsonl-importing"),
    );
    expect(firstObservationWriteIndex).toBeGreaterThan(-1);
    expect(earlySessionWrite).toBeDefined();

    const finalSession = await kv.get<Session>(KV.sessions, "early-row-session");
    expect(finalSession?.tags).not.toContain("jsonl-importing");
    expect(finalSession?.tags).toContain("jsonl-import");
  });

  it("reindexes default session imports after observation writes are finalized", async () => {
    const dir = join(tmpRoot, "post-write-index");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "post-write-index-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "Session reindex must happen after observation writes.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    let reindexCallSetCount = 0;
    mockReindexSessions.mockImplementationOnce(async () => {
      reindexCallSetCount = kv.getSetCalls().length;
      return { indexed: 1, failedSessionIds: [] };
    });

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const lastObservationWrite = kv.getSetCalls().findLastIndex(
      (call) => call.scope === KV.observations("post-write-index-session"),
    );
    expect(lastObservationWrite).toBeGreaterThanOrEqual(0);
    expect(reindexCallSetCount).toBeGreaterThan(lastObservationWrite);
  });

  it("skips replay lesson and crystal writes when lesson extraction is disabled", async () => {
    const dir = join(tmpRoot, "no-lessons");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "no-lessons-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "Always validate import keys before writing duplicate observations.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; lessonExtraction?: { enabled: boolean } };

    expect(result.success).toBe(true);
    expect(result.lessonExtraction?.enabled).toBe(false);
    expect(await kv.list(KV.lessons)).toHaveLength(0);
    expect(await kv.list(KV.crystals)).toHaveLength(0);
    expect(kv.getSetCalls().some((call) => call.scope === KV.lessons)).toBe(false);
    expect(kv.getSetCalls().some((call) => call.scope === KV.crystals)).toBe(false);
  });

  it("keeps lightweight replay lessons and crystals enabled for normal imports", async () => {
    const dir = join(tmpRoot, "normal-artifacts");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "normal-artifacts-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "Always validate import keys before writing duplicate observations.",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const result = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
    })) as { success: boolean; lessonExtraction?: { enabled: boolean; created: number } };

    expect(result.success).toBe(true);
    expect(result.lessonExtraction?.enabled).toBe(true);
    expect((await kv.list(KV.lessons)).length).toBeGreaterThan(0);
    expect((await kv.list(KV.crystals)).length).toBeGreaterThan(0);
  });

  it("uses value-equality commit probes for replay-only writes", async () => {
    const successDir = join(tmpRoot, "commit-probe-success");
    mkdirSync(successDir, { recursive: true });
    writeCodexSession(successDir, "session.jsonl", {
      sessionId: "commit-probe-success",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "commit after timeout should still count",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    kv.addBehavior({
      kind: "commit-then-timeout",
      match: (scope, key) =>
        scope === KV.observations("commit-probe-success") && key === "prompt-1",
    });

    const success = (await sdk.trigger("mem::replay::import-jsonl", {
      path: successDir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; created?: number };
    expect(success.success).toBe(true);
    expect(success.created).toBe(1);

    await kv.set<Session>(KV.sessions, "commit-probe-fail", {
      id: "commit-probe-fail",
      project: "probe",
      cwd: "/workspace/commit-probe-fail",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 0,
      tags: ["existing-tag"],
    });
    const failDir = join(tmpRoot, "commit-probe-fail");
    mkdirSync(failDir, { recursive: true });
    writeCodexSession(failDir, "session.jsonl", {
      sessionId: "commit-probe-fail",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "old values must not count as committed",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    kv.addBehavior({
      kind: "timeout-before-commit",
      match: (scope, key) => scope === KV.sessions && key === "commit-probe-fail",
    });

    await expect(
      sdk.trigger("mem::replay::import-jsonl", {
        path: failDir,
        lessonExtraction: { enabled: false },
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("persists the manual dirty marker before observation writes and only finalize rebuilds it", async () => {
    const dir = join(tmpRoot, "dirty-marker");
    mkdirSync(dir, { recursive: true });
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "previous-run",
      sessionIds: ["previous-dirty-session"],
      inProgress: false,
    });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "dirty-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "manual imports should mark the search index dirty first",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const importResult = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; indexing?: { mode: string; dirty: boolean; requiresFinalize: boolean } };
    expect(importResult.success).toBe(true);
    expect(importResult.indexing).toMatchObject({
      mode: "manual",
      dirty: true,
      requiresFinalize: true,
    });
    expect(mockRebuildIndex).not.toHaveBeenCalled();

    const setCalls = kv.getSetCalls();
    const firstObservationWriteIndex = setCalls.findIndex(
      (call) => call.scope === KV.observations("dirty-session"),
    );
    const dirtyWrite = setCalls.find(
      (call, index) =>
        index < firstObservationWriteIndex &&
        call.scope === KV.state &&
        call.key === "search-index-dirty" &&
        (call.value as { inProgress?: boolean }).inProgress === true,
    );
    expect(dirtyWrite).toBeDefined();

    const marker = await kv.get<{
      dirty: boolean;
      reason: string;
      importRunId: string;
      sessionIds: string[];
      inProgress: boolean;
    }>(KV.state, "search-index-dirty");
    expect(marker).toMatchObject({
      dirty: true,
      reason: "replay-import-deferred",
      inProgress: false,
    });
    expect(marker?.sessionIds).toContain("dirty-session");
    expect(marker?.sessionIds).toContain("previous-dirty-session");

    const runMarker = await kv.get<{
      dirty: boolean;
      sessionIds: string[];
      inProgress: boolean;
    }>(KV.state, `search-index-dirty:${marker!.importRunId}`);
    expect(runMarker).toMatchObject({
      dirty: true,
      inProgress: false,
      sessionIds: ["dirty-session"],
    });

    const originalList = kv.list;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.state) {
        throw new Error("finalize should not list global state");
      }
      return originalList<T>(scope);
    }) as typeof kv.list;

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as {
      success: boolean;
      rebuilt?: number;
      dirtyCleared?: boolean;
    };
    expect(finalize).toEqual({
      success: true,
      rebuilt: 1,
      dirtyCleared: true,
    });
    expect(mockRebuildIndex).not.toHaveBeenCalled();
    expect(mockReindexSessions).toHaveBeenCalledWith(kv, [
      "previous-dirty-session",
      "dirty-session",
    ], expect.objectContaining({
      includeVector: false,
      shouldIndex: expect.any(Function),
    }));
    expect(mockFlushIndexSaveStrict).toHaveBeenCalledWith({ includeVector: false });

    const clearedMarker = await kv.get<{ dirty: boolean; inProgress: boolean }>(
      KV.state,
      "search-index-dirty",
    );
    expect(clearedMarker).toMatchObject({ dirty: false, inProgress: false });
    const clearedRunMarker = await kv.get<{ sessionIds: string[] }>(
      KV.state,
      `search-index-dirty:${marker!.importRunId}`,
    );
    expect(clearedRunMarker?.sessionIds).toEqual([]);
  });

  it("clears a dirty marker without rebuilding when loaded BM25 already covers it", async () => {
    await kv.set<Session>(KV.sessions, "covered-session", {
      id: "covered-session",
      project: "/workspace/covered-session",
      cwd: "/workspace/covered-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      status: "completed",
      observationCount: 1,
      tags: ["jsonl-import"],
    });
    await kv.set(KV.observations("covered-session"), "covered-obs", {
      id: "covered-obs",
      sessionId: "covered-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "conversation",
      title: "covered",
      subtitle: "",
      facts: [],
      narrative: "already persisted in BM25 before a later finalize crash",
      concepts: [],
      files: [],
      importance: 5,
    });
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "covered-run",
      sessionIds: ["covered-session"],
      inProgress: false,
    });
    mockSearchHas.mockReturnValue(true);

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as {
      success: boolean;
      rebuilt?: number;
      dirtyCleared?: boolean;
    };

    expect(finalize).toEqual({
      success: true,
      rebuilt: 0,
      dirtyCleared: true,
    });
    expect(mockReindexSessions).not.toHaveBeenCalled();
    expect(mockFlushIndexSaveStrict).not.toHaveBeenCalled();
    const marker = await kv.get<{ dirty: boolean; inProgress: boolean }>(
      KV.state,
      "search-index-dirty",
    );
    expect(marker).toMatchObject({ dirty: false, inProgress: false });
  });

  it("rebuilds dirty replay sessions when loaded BM25 still contains skipped tool events", async () => {
    await kv.set<Session>(KV.sessions, "covered-with-tool-session", {
      id: "covered-with-tool-session",
      project: "/workspace/covered-with-tool-session",
      cwd: "/workspace/covered-with-tool-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      status: "completed",
      observationCount: 2,
      tags: ["jsonl-import"],
    });
    await kv.set(KV.observations("covered-with-tool-session"), "covered-prompt", {
      id: "covered-prompt",
      sessionId: "covered-with-tool-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "conversation",
      title: "prompt_submit",
      narrative: "already persisted in BM25",
      concepts: [],
      facts: [],
      files: [],
      importance: 5,
    });
    await kv.set(KV.observations("covered-with-tool-session"), "covered-tool", {
      id: "covered-tool",
      sessionId: "covered-with-tool-session",
      timestamp: "2026-01-01T00:00:01.000Z",
      hookType: "post_tool_use",
      type: "other",
      title: "post_tool_use",
      narrative: "old BM25 entry should force cleanup",
      concepts: [],
      facts: [],
      files: [],
      importance: 5,
    });
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "covered-with-tool-run",
      sessionIds: ["covered-with-tool-session"],
      inProgress: false,
    });
    mockSearchHas.mockImplementation((id: string) =>
      id === "covered-prompt" || id === "covered-tool",
    );

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; rebuilt?: number };

    expect(finalize).toMatchObject({ success: true, rebuilt: 1 });
    expect(mockReindexSessions).toHaveBeenCalledWith(kv, [
      "covered-with-tool-session",
    ], expect.objectContaining({
      includeVector: false,
      shouldIndex: expect.any(Function),
    }));
  });

  it("completes stale manual dirty markers when a retry finds only duplicate observations", async () => {
    const dir = join(tmpRoot, "manual-duplicate-retry");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "manual-duplicate-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "manual retry should recover an active dirty marker",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const first = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };
    expect(first.success).toBe(true);
    expect(first.observations).toBe(1);

    const staleMarker = await kv.get<{
      dirty: boolean;
      reason: "replay-import-deferred";
      updatedAt: string;
      importRunId: string;
      sessionIds: string[];
      inProgress: boolean;
    }>(KV.state, "search-index-dirty");
    expect(staleMarker).toBeTruthy();
    const activeStaleMarker = {
      ...staleMarker!,
      updatedAt: "2026-01-01T00:00:00.000Z",
      inProgress: true,
      ownerPid: process.pid,
    };
    await kv.set(KV.state, "search-index-dirty", activeStaleMarker);
    await kv.set(
      KV.state,
      `search-index-dirty:${staleMarker!.importRunId}`,
      activeStaleMarker,
    );

    const retry = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number; skippedDuplicate?: number };

    expect(retry.success).toBe(true);
    expect(retry.observations).toBe(0);
    expect(retry.skippedDuplicate).toBe(1);

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; rebuilt?: number; dirtyCleared?: boolean };
    expect(finalize).toEqual({
      success: true,
      rebuilt: 1,
      dirtyCleared: true,
    });
  });

  it("keeps fresh active manual dirty markers blocking finalize", async () => {
    const dir = join(tmpRoot, "manual-fresh-active-marker");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "manual-fresh-active-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "fresh active marker should not be cleared by another retry",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const first = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };
    expect(first.success).toBe(true);
    expect(first.observations).toBe(1);

    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "other-active-run",
      sessionIds: ["manual-fresh-active-session"],
      inProgress: true,
      ownerPid: process.ppid,
    });

    const retry = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number; skippedDuplicate?: number };
    expect(retry.success).toBe(true);
    expect(retry.observations).toBe(0);
    expect(retry.skippedDuplicate).toBe(1);

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; error?: string };
    expect(finalize).toEqual({
      success: false,
      error: "deferred replay import is still in progress",
    });
  });

  it("does not force manual finalize for a duplicate-only import with no deferred marker", async () => {
    const dir = join(tmpRoot, "manual-noop-duplicate");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "manual-noop-duplicate-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "duplicate-only manual import should stay a no-op",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const first = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };
    expect(first.success).toBe(true);
    expect(first.observations).toBe(1);

    const retry = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as {
      success: boolean;
      observations?: number;
      skippedDuplicate?: number;
      indexing?: { dirty: boolean; requiresFinalize: boolean };
    };

    expect(retry.success).toBe(true);
    expect(retry.observations).toBe(0);
    expect(retry.skippedDuplicate).toBe(1);
    expect(retry.indexing).toMatchObject({
      dirty: false,
      requiresFinalize: false,
    });
  });

  it("uses point lookups for manual duplicate retries instead of listing large sessions", async () => {
    const dir = join(tmpRoot, "manual-point-lookup-duplicate");
    mkdirSync(dir, { recursive: true });
    writeCodexSession(dir, "session.jsonl", {
      sessionId: "manual-point-lookup-session",
      events: [
        {
          id: "prompt-1",
          role: "user",
          message: "manual duplicate retries should not enumerate the whole session",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const first = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number };
    expect(first.success).toBe(true);
    expect(first.observations).toBe(1);

    const session = await kv.get<Session>(KV.sessions, "manual-point-lookup-session");
    await kv.set(KV.sessions, "manual-point-lookup-session", {
      ...session!,
      observationCount: 1884,
    });

    const originalList = kv.list;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.state) {
        throw new Error("manual retry should not list global state");
      }
      if (scope === KV.observations("manual-point-lookup-session")) {
        throw new Error("manual retry should not list existing observations");
      }
      return originalList<T>(scope);
    }) as typeof kv.list;

    const retry = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
      indexMode: "manual",
      lessonExtraction: { enabled: false },
    })) as { success: boolean; observations?: number; skippedDuplicate?: number };

    expect(retry.success).toBe(true);
    expect(retry.observations).toBe(0);
    expect(retry.skippedDuplicate).toBe(1);
  });

  it("does not finalize while the global deferred replay import marker is active", async () => {
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "active-run",
      sessionIds: ["active-session"],
      inProgress: true,
      ownerPid: process.ppid,
    });

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; error?: string };

    expect(finalize).toEqual({
      success: false,
      error: "deferred replay import is still in progress",
    });
    expect(mockRebuildIndex).not.toHaveBeenCalled();
    expect(mockReindexSessions).not.toHaveBeenCalled();
  });

  it("does not finalize while a dirty marker references an importing session", async () => {
    await kv.set<Session>(KV.sessions, "still-importing-session", {
      id: "still-importing-session",
      project: "/workspace/still-importing-session",
      cwd: "/workspace/still-importing-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      status: "completed",
      observationCount: 1,
      tags: ["jsonl-import", "jsonl-importing"],
    });
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "covered-active-run",
      sessionIds: ["still-importing-session"],
      inProgress: false,
    });

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; error?: string };

    expect(finalize).toEqual({
      success: false,
      error: "deferred replay import is still in progress",
    });
    expect(mockRebuildIndex).not.toHaveBeenCalled();
    expect(mockReindexSessions).not.toHaveBeenCalled();
  });

  it("finalize releases stale inactive manual dirty markers for completed sessions", async () => {
    await kv.set<Session>(KV.sessions, "stale-completed-session", {
      id: "stale-completed-session",
      project: "/workspace/stale-completed-session",
      cwd: "/workspace/stale-completed-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      status: "completed",
      observationCount: 1,
      tags: ["jsonl-import"],
    });
    const staleMarker = {
      dirty: true,
      reason: "replay-import-deferred" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "stale-completed-run",
      sessionIds: ["stale-completed-session"],
      inProgress: true,
    };
    await kv.set(KV.state, "search-index-dirty", staleMarker);
    await kv.set(KV.state, "search-index-dirty:stale-completed-run", staleMarker);

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as {
      success: boolean;
      rebuilt?: number;
      dirtyCleared?: boolean;
    };

    expect(finalize).toEqual({
      success: true,
      rebuilt: 1,
      dirtyCleared: true,
    });
  });

  it("fails finalize when rebuilt index cannot be strictly persisted", async () => {
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "persist-fails-run",
      sessionIds: ["persist-fails-session"],
      inProgress: false,
    });
    mockFlushIndexSaveStrict.mockResolvedValueOnce(false);

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; error?: string };

    expect(finalize).toEqual({
      success: false,
      error: "failed to persist rebuilt replay index; dirty marker remains",
    });
    expect(mockRebuildIndex).not.toHaveBeenCalled();
    expect(mockReindexSessions).toHaveBeenCalledWith(kv, [
      "persist-fails-session",
    ], expect.objectContaining({
      includeVector: false,
      shouldIndex: expect.any(Function),
    }));

    const marker = await kv.get<{ dirty: boolean; inProgress: boolean }>(
      KV.state,
      "search-index-dirty",
    );
    expect(marker).toMatchObject({ dirty: true, inProgress: false });
  });

  it("finalize passes replay index filtering to targeted reindex", async () => {
    await kv.set<Session>(KV.sessions, "filter-session", {
      id: "filter-session",
      project: "/workspace/filter-session",
      cwd: "/workspace/filter-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      status: "completed",
      observationCount: 2,
      tags: ["jsonl-import"],
    });
    await kv.set(KV.observations("filter-session"), "prompt-obs", {
      id: "prompt-obs",
      sessionId: "filter-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "conversation",
      title: "prompt_submit",
      narrative: "user decision should remain searchable",
      facts: [],
      concepts: [],
      files: [],
      importance: 5,
    });
    await kv.set(KV.observations("filter-session"), "tool-obs", {
      id: "tool-obs",
      sessionId: "filter-session",
      timestamp: "2026-01-01T00:00:01.000Z",
      hookType: "post_tool_use",
      type: "other",
      title: "post_tool_use",
      narrative: "tool result should remain stored but not indexed",
      facts: [],
      concepts: [],
      files: [],
      importance: 5,
    });
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "filter-run",
      sessionIds: ["filter-session"],
      inProgress: false,
    });

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean };

    expect(finalize.success).toBe(true);
    const options = mockReindexSessions.mock.calls.at(-1)?.[2];
    expect(options).toMatchObject({ includeVector: false });
    expect(options?.shouldIndex).toEqual(expect.any(Function));
    expect(options.shouldIndex({
      id: "prompt-obs",
      sessionId: "filter-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "conversation",
      title: "prompt_submit",
      narrative: "user decision should remain searchable",
      facts: [],
      concepts: [],
      files: [],
      importance: 5,
    })).toBe(true);
    expect(options.shouldIndex({
      id: "tool-obs",
      sessionId: "filter-session",
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "other",
      title: "post_tool_use",
      narrative: "tool result should remain stored but not indexed",
      facts: [],
      concepts: [],
      files: [],
      importance: 5,
      hookType: "post_tool_use",
    })).toBe(false);
  });
});
