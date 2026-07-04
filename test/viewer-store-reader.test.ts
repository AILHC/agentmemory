import { describe, expect, it, vi } from "vitest";

import {
  listViewerStore,
  listViewerStores,
} from "../src/functions/viewer-store-reader.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type {
  CompressedObservation,
  Lesson,
  Session,
  SessionSummary,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    async get<T>(scope: string, key: string): Promise<T | null> {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    async set<T>(scope: string, key: string, data: T): Promise<T> {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    async list<T>(scope: string): Promise<T[]> {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function lesson(id: string, confidence: number, deleted = false): Lesson {
  return {
    id,
    content: `Lesson ${id}`,
    context: "",
    confidence,
    reinforcements: 0,
    source: "llm",
    sourceIds: ["session-a"],
    tags: [],
    createdAt: `2026-01-01T00:00:${id.slice(-2).padStart(2, "0")}Z`,
    updatedAt: `2026-01-01T00:00:${id.slice(-2).padStart(2, "0")}Z`,
    decayRate: 0.01,
    ...(deleted ? { deleted: true } : {}),
  };
}

function session(id: string, observationCount: number): Session {
  return {
    id,
    project: "/repo",
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00Z",
    status: "completed",
    observationCount,
  };
}

function observation(id: string, sessionId: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: `2026-01-01T00:00:${id.slice(-2).padStart(2, "0")}Z`,
    type: "conversation",
    title: `Observation ${id}`,
    facts: [],
    narrative: `Narrative ${id}`,
    concepts: [],
    files: [],
    importance: 0.5,
  };
}

describe("viewer store reader", () => {
  it("returns paginated lessons with total and deleted rows included by default", async () => {
    const kv = mockKV();
    for (let i = 1; i <= 55; i++) {
      await kv.set(KV.lessons, `lesson-${i}`, lesson(`lesson-${i}`, i / 100));
    }
    await kv.set(KV.lessons, "lesson-deleted", lesson("lesson-deleted", 1, true));

    const first = await listViewerStore(kv, { type: "lessons", limit: 50 });
    expect(first).toMatchObject({
      success: true,
      type: "lessons",
      source: KV.lessons,
      total: 56,
      returned: 50,
      hasMore: true,
      completeness: "partial",
      filters: { deleted: "included" },
    });
    expect(first.nextCursor).toBe("50");
    expect(first.items).toHaveLength(50);

    const second = await listViewerStore(kv, {
      type: "lessons",
      limit: 50,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({
      total: 56,
      returned: 6,
      hasMore: false,
      completeness: "complete",
    });
  });

  it("can exclude deleted lessons explicitly without hiding the applied filter", async () => {
    const kv = mockKV();
    await kv.set(KV.lessons, "lesson-live", lesson("lesson-live", 0.8));
    await kv.set(KV.lessons, "lesson-deleted", lesson("lesson-deleted", 0.9, true));

    const result = await listViewerStore(kv, {
      type: "lessons",
      includeDeleted: false,
    });

    expect(result.total).toBe(1);
    expect(result.items.map((item) => (item as Lesson).id)).toEqual(["lesson-live"]);
    expect(result.filters).toMatchObject({ deleted: "excluded" });
  });

  it("paginates observations for a selected session", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 3));
    await kv.set(KV.sessions, "session-b", session("session-b", 1));
    for (let i = 1; i <= 3; i++) {
      await kv.set(KV.observations("session-a"), `obs-a-${i}`, observation(`obs-a-${i}`, "session-a"));
    }
    await kv.set(KV.observations("session-b"), "obs-b-1", observation("obs-b-1", "session-b"));

    const result = await listViewerStore(kv, {
      type: "observations",
      sessionId: "session-a",
      limit: 2,
    });

    expect(result).toMatchObject({
      type: "observations",
      source: "mem:obs:session-a",
      total: 3,
      returned: 2,
      hasMore: true,
      nextCursor: "2",
      completeness: "partial",
    });
    expect(result.items.every((item) => (item as CompressedObservation).sessionId === "session-a")).toBe(true);
  });

  it("lists store summaries with counts and completeness metadata", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 3));
    await kv.set<SessionSummary>(KV.summaries, "session-a", {
      sessionId: "session-a",
      project: "/repo",
      createdAt: "2026-01-01T00:00:00Z",
      title: "Summary",
      narrative: "Summary narrative",
      keyDecisions: [],
      filesModified: [],
      concepts: [],
      observationCount: 3,
    });
    await kv.set(KV.lessons, "lesson-live", lesson("lesson-live", 0.8));

    const result = await listViewerStores(kv);

    expect(result.success).toBe(true);
    expect(result.stores.find((s) => s.type === "sessions")).toMatchObject({
      total: 1,
      source: KV.sessions,
      completeness: "complete",
    });
    expect(result.stores.find((s) => s.type === "observations")).toMatchObject({
      total: 3,
      source: "mem:obs:*",
      completeness: "complete",
    });
    expect(result.stores.find((s) => s.type === "lessons")).toMatchObject({
      total: 1,
      source: KV.lessons,
      filters: { deleted: "included" },
    });
  });
});

describe("api::viewer-store", () => {
  function registerViewerHandlers(kv: ReturnType<typeof mockKV>) {
    const sdk = {
      registerFunction: (id: string, handler: Function) => {
        if (id === "api::viewer-stores") sdk.viewerStores = handler;
        if (id === "api::viewer-store") sdk.viewerStore = handler;
      },
      registerTrigger: vi.fn(),
      trigger: vi.fn(),
      viewerStores: undefined as undefined | Function,
      viewerStore: undefined as undefined | Function,
    };
    registerApiTriggers(sdk as never, kv as never, "");
    return sdk;
  }

  it("serves paginated viewer store data through a read-only GET handler", async () => {
    const kv = mockKV();
    for (let i = 1; i <= 3; i++) {
      await kv.set(KV.lessons, `lesson-${i}`, lesson(`lesson-${i}`, i / 10));
    }
    const sdk = registerViewerHandlers(kv);

    const response = await sdk.viewerStore!({
      query_params: { type: "lessons", limit: "2" },
      headers: {},
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      type: "lessons",
      total: 3,
      returned: 2,
      hasMore: true,
      nextCursor: "2",
      completeness: "partial",
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects invalid viewer store query params", async () => {
    const sdk = registerViewerHandlers(mockKV());

    const missingType = await sdk.viewerStore!({ query_params: {}, headers: {} });
    const badLimit = await sdk.viewerStore!({
      query_params: { type: "lessons", limit: "501" },
      headers: {},
    });
    const badCursor = await sdk.viewerStore!({
      query_params: { type: "lessons", cursor: "nope" },
      headers: {},
    });

    expect(missingType).toMatchObject({ status_code: 400 });
    expect(badLimit).toMatchObject({ status_code: 400 });
    expect(badCursor).toMatchObject({ status_code: 400 });
  });
});
