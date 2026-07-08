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
  mockRebuildIndex,
  mockFlushIndexSaveStrict,
  mockReindexSessions,
} = vi.hoisted(() => ({
  mockSearchAdd: vi.fn(),
  mockRebuildIndex: vi.fn(async () => 7),
  mockFlushIndexSaveStrict: vi.fn(async () => true),
  mockReindexSessions: vi.fn(async () => ({ indexed: 1, failedSessionIds: [] })),
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: mockSearchAdd }),
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

describe("replay fast import", () => {
  let tmpRoot: string;
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "replay-fast-import-"));
    kv = mockKV();
    sdk = mockSdk(kv);
    mockSearchAdd.mockClear();
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
    );
    expect(mockFlushIndexSaveStrict).toHaveBeenCalled();
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

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as {
      success: boolean;
      rebuilt?: number;
      dirtyCleared?: boolean;
    };
    expect(finalize).toEqual({
      success: true,
      rebuilt: 7,
      dirtyCleared: true,
    });
    expect(mockRebuildIndex).toHaveBeenCalledTimes(1);
    expect(mockFlushIndexSaveStrict).toHaveBeenCalledTimes(1);

    const clearedMarker = await kv.get<{ dirty: boolean; inProgress: boolean }>(
      KV.state,
      "search-index-dirty",
    );
    expect(clearedMarker).toMatchObject({ dirty: false, inProgress: false });
  });

  it("does not finalize while any deferred replay import run marker is active", async () => {
    await kv.set(KV.state, "search-index-dirty", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importRunId: "finished-run",
      sessionIds: ["finished-session"],
      inProgress: false,
    });
    await kv.set(KV.state, "search-index-dirty:active-run", {
      dirty: true,
      reason: "replay-import-deferred",
      updatedAt: "2026-01-01T00:00:01.000Z",
      importRunId: "active-run",
      sessionIds: ["active-session"],
      inProgress: true,
    });

    const finalize = (await sdk.trigger(
      "mem::replay::finalize-deferred-index",
    )) as { success: boolean; error?: string };

    expect(finalize).toEqual({
      success: false,
      error: "deferred replay import is still in progress",
    });
    expect(mockRebuildIndex).not.toHaveBeenCalled();
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
    expect(mockRebuildIndex).toHaveBeenCalledTimes(1);

    const marker = await kv.get<{ dirty: boolean; inProgress: boolean }>(
      KV.state,
      "search-index-dirty",
    );
    expect(marker).toMatchObject({ dirty: true, inProgress: false });
  });
});
