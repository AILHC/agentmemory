import { describe, expect, it, vi } from "vitest";

import {
  insightBelongsToSession,
  listViewerSessionStats,
  listViewerStore,
  listViewerStores,
} from "../src/functions/viewer-store-reader.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type {
  CompressedObservation,
  Crystal,
  Insight,
  Lesson,
  ProceduralMemory,
  SemanticMemory,
  Session,
  SessionSummary,
} from "../src/types.js";

interface TestKV {
  store: Map<string, Map<string, unknown>>;
  get<T>(scope: string, key: string): Promise<T | null>;
  set<T>(scope: string, key: string, data: T): Promise<T>;
  list<T>(scope: string): Promise<T[]>;
}

function mockKV(): TestKV {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
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

function summary(sessionId: string): SessionSummary {
  return {
    sessionId,
    project: "/repo",
    createdAt: "2026-01-01T00:00:00Z",
    title: "Summary",
    narrative: "Summary narrative",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 3,
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

function semantic(
  id: string,
  sourceSessionIds: string[],
): SemanticMemory {
  return {
    id,
    fact: `Semantic ${id}`,
    confidence: 0.7,
    sourceSessionIds,
    sourceMemoryIds: [],
    accessCount: 0,
    lastAccessedAt: "2026-01-01T00:00:00Z",
    strength: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function procedural(
  id: string,
  sourceSessionIds: string[],
): ProceduralMemory {
  return {
    id,
    name: `Procedural ${id}`,
    steps: ["step"],
    triggerCondition: "condition",
    frequency: 1,
    sourceSessionIds,
    strength: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function crystal(id: string, sessionId?: string): Crystal {
  return {
    id,
    narrative: `Crystal ${id}`,
    keyOutcomes: [],
    filesAffected: [],
    lessons: [],
    sourceActionIds: [],
    ...(sessionId ? { sessionId } : {}),
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function insight(
  id: string,
  sourceMemoryIds: string[],
  sourceLessonIds: string[],
  sourceCrystalIds: string[],
): Insight {
  return {
    id,
    title: `Insight ${id}`,
    content: `Insight content ${id}`,
    confidence: 0.9,
    reinforcements: 0,
    sourceConceptCluster: [],
    sourceMemoryIds,
    sourceLessonIds,
    sourceCrystalIds,
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    decayRate: 0.01,
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

  it("supports session-scoped filtering for summaries and insights with consistent totals", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 1));
    await kv.set(KV.summaries, "session-a", summary("session-a"));
    await kv.set(KV.summaries, "session-b", summary("session-b"));
    await kv.set(KV.lessons, "lesson-a", lesson("lesson-a", 0.9));
    await kv.set(KV.lessons, "lesson-b", { ...lesson("lesson-b", 0.8), sourceIds: ["other"] });
    await kv.set(KV.semantic, "semantic-a", semantic("semantic-a", ["session-a"]));
    await kv.set(KV.semantic, "semantic-b", semantic("semantic-b", ["session-b"]));
    await kv.set(KV.procedural, "procedural-a", procedural("procedural-a", ["session-a"]));
    await kv.set(KV.crystals, "crystal-a", { ...crystal("crystal-a", "session-a"), createdAt: "2026-01-01T00:00:00Z" });
    await kv.set(KV.crystals, "crystal-b", { ...crystal("crystal-b", "session-b"), createdAt: "2026-01-01T00:00:01Z" });
    await kv.set(KV.insights, "insight-semantic", insight("insight-semantic", ["semantic-a"], [], []));
    await kv.set(KV.insights, "insight-lesson", insight("insight-lesson", [], ["lesson-a"], []));
    await kv.set(KV.insights, "insight-crystal", insight("insight-crystal", [], [], ["crystal-a"]));
    await kv.set(KV.insights, "insight-other", insight("insight-other", ["semantic-b"], [], []));

    const list = await listViewerStore(kv, { type: "summaries", sessionId: "session-a" });
    const stats = await listViewerSessionStats(kv, { sessionId: "session-a" });
    expect(list.total).toBe(1);
    expect(list.items.map((item) => (item as SessionSummary).sessionId)).toEqual(["session-a"]);

    const insightList = await listViewerStore(kv, {
      type: "insights",
      sessionId: "session-a",
    });
    expect(insightList.total).toBe(3);
    expect(stats.categories.summary.count).toBe(1);
    expect(stats.categories.insights.count).toBe(3);
    expect(insightList.total).toBe(stats.categories.insights.count);
  });

  it("keeps list sessionId filtering semantics for lessons and insights aligned with stats counts", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 3));
    await kv.set(KV.lessons, "lesson-session", {
      ...lesson("lesson-session", 0.9),
      sourceIds: ["session-a"],
    });
    await kv.set(KV.lessons, "lesson-observation", {
      ...lesson("lesson-observation", 0.8),
      sourceIds: ["obs-a-1"],
    });
    await kv.set(KV.lessons, "lesson-other", {
      ...lesson("lesson-other", 0.7),
      sourceIds: ["other-session"],
    });
    await kv.set(KV.observations("session-a"), "obs-a-1", observation("obs-a-1", "session-a"));
    await kv.set(KV.semantic, "semantic-a", semantic("semantic-a", ["session-a"]));
    await kv.set(KV.procedural, "procedural-a", procedural("procedural-a", ["session-a"]));
    await kv.set(KV.crystals, "crystal-a", { ...crystal("crystal-a", "session-a"), createdAt: "2026-01-01T00:00:00Z" });
    await kv.set(KV.insights, "insight-a", insight("insight-a", ["semantic-a"], ["lesson-session"], ["crystal-a"]));
    await kv.set(KV.insights, "insight-b", insight("insight-b", ["semantic-b"], ["lesson-other"], ["crystal-b"]));

    const lessonList = await listViewerStore(kv, {
      type: "lessons",
      sessionId: "session-a",
      limit: 50,
    });
    const insightList = await listViewerStore(kv, {
      type: "insights",
      sessionId: "session-a",
      limit: 50,
    });
    const stats = await listViewerSessionStats(kv, { sessionId: "session-a" });

    expect(lessonList.total).toBe(2);
    expect(insightList.total).toBe(1);
    expect(stats.categories.lessons.count).toBe(2);
    expect(stats.categories.insights.count).toBe(1);
    expect(lessonList.total).toBe(stats.categories.lessons.count);
    expect(insightList.total).toBe(stats.categories.insights.count);
  });

  it("keeps session-scoped filtering for other list types aligned with attribution rules", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 3));
    await kv.set(KV.sessions, "session-b", session("session-b", 2));
    await kv.set(KV.summaries, "summary-a", summary("session-a"));
    await kv.set(KV.summaries, "summary-b", summary("session-b"));
    await kv.set(KV.observations("session-a"), "obs-a-1", observation("obs-a-1", "session-a"));
    await kv.set(KV.observations("session-b"), "obs-b-1", observation("obs-b-1", "session-b"));
    await kv.set(KV.semantic, "semantic-a", semantic("semantic-a", ["session-a"]));
    await kv.set(KV.semantic, "semantic-b", semantic("semantic-b", ["session-b"]));
    await kv.set(KV.procedural, "procedural-a", procedural("procedural-a", ["session-a"]));
    await kv.set(KV.procedural, "procedural-b", procedural("procedural-b", ["session-b"]));
    await kv.set(KV.crystals, "crystal-a", { ...crystal("crystal-a", "session-a"), createdAt: "2026-01-01T00:00:00Z" });
    await kv.set(KV.crystals, "crystal-b", { ...crystal("crystal-b", "session-b"), createdAt: "2026-01-01T00:00:01Z" });

    const summaries = await listViewerStore(kv, { type: "summaries", sessionId: "session-a" });
    const observations = await listViewerStore(kv, { type: "observations", sessionId: "session-a" });
    const semanticList = await listViewerStore(kv, { type: "semantic", sessionId: "session-a" });
    const proceduralList = await listViewerStore(kv, { type: "procedural", sessionId: "session-a" });
    const crystalsList = await listViewerStore(kv, { type: "crystals", sessionId: "session-a" });

    expect(summaries.total).toBe(1);
    expect(observations.total).toBe(1);
    expect(semanticList.total).toBe(1);
    expect(proceduralList.total).toBe(1);
    expect(crystalsList.total).toBe(1);
  });

  it("classifies insight attribution via semantic/lesson/crystal source-id reverse lookups", () => {
    const sourceIds = {
      semanticMemoryIds: new Set(["semantic-a"]),
      lessonIds: new Set(["lesson-a"]),
      crystalIds: new Set(["crystal-a"]),
    };

    expect(
      insightBelongsToSession(
        insight("semantic-source", ["semantic-a"], [], []),
        sourceIds,
      ),
    ).toBe(true);
    expect(
      insightBelongsToSession(
        insight("lesson-source", [], ["lesson-a"], []),
        sourceIds,
      ),
    ).toBe(true);
    expect(
      insightBelongsToSession(
        insight("crystal-source", [], [], ["crystal-a"]),
        sourceIds,
      ),
    ).toBe(true);
    expect(
      insightBelongsToSession(
        insight("none", [], [], []),
        sourceIds,
      ),
    ).toBe(false);
  });

  it("lists store summaries with counts and completeness metadata", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 3));
    await kv.set(KV.summaries, "session-a", summary("session-a"));
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

  it("computes viewer session stats with base category counts", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 4));
    await kv.set(KV.summaries, "summary-a", summary("session-a"));
    await kv.set(KV.lessons, "lesson-a", lesson("lesson-a", 0.9));
    await kv.set(KV.semantic, "semantic-a", semantic("semantic-a", ["session-a"]));
    await kv.set(KV.procedural, "procedural-a", procedural("procedural-a", ["session-a"]));
    await kv.set(KV.crystals, "crystal-a", { ...crystal("crystal-a", "session-a"), createdAt: "2026-01-01T00:00:00Z" });

    const stats = await listViewerSessionStats(kv, { sessionId: "session-a" });

    expect(stats).toMatchObject({
      success: true,
      sessionId: "session-a",
      categories: {
        summary: { count: 1, status: "complete", source: KV.summaries },
        observations: { count: 4, status: "complete", source: "mem:sessions.observationCount" },
        lessons: { count: 1, status: "complete", source: KV.lessons },
        semantic: { count: 1, status: "complete", source: KV.semantic },
        procedural: { count: 1, status: "complete", source: KV.procedural },
        crystals: { count: 1, status: "complete", source: KV.crystals },
      },
    });
  });

  it("uses observation metadata first and observations list fallback source when needed", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-meta", session("session-meta", 9));
    await kv.set(KV.sessions, "session-fallback", session("session-fallback", -1));
    await kv.set(KV.observations("session-fallback"), "obs-1", observation("obs-1", "session-fallback"));
    await kv.set(KV.observations("session-fallback"), "obs-2", observation("obs-2", "session-fallback"));

    const metadataStats = await listViewerSessionStats(kv, { sessionId: "session-meta" });
    expect(metadataStats.categories.observations.source).toBe("mem:sessions.observationCount");
    expect(metadataStats.categories.observations.attribution).toBeUndefined();
    expect(metadataStats.categories.observations.count).toBe(9);

    const fallbackStats = await listViewerSessionStats(kv, { sessionId: "session-fallback" });
    expect(fallbackStats.categories.observations).toMatchObject({
      count: 2,
      source: KV.observations("session-fallback"),
      attribution: "mem:sessions.observationCount",
      status: "complete",
    });
  });

  it("keeps per-category failures isolated when one session scoped store read fails", async () => {
    const kv = mockKV();
    const originalList = kv.list;
    kv.list = vi.fn(async (scope: string) => {
      if (scope === KV.lessons) {
        throw new Error("lessons store read failed");
      }
      return originalList(scope);
    });

    await kv.set(KV.sessions, "session-a", session("session-a", 1));
    await kv.set(KV.summaries, "summary-a", summary("session-a"));
    await kv.set(KV.semantic, "semantic-a", semantic("semantic-a", ["session-a"]));
    await kv.set(KV.procedural, "procedural-a", procedural("procedural-a", ["session-a"]));
    await kv.set(KV.crystals, "crystal-a", { ...crystal("crystal-a", "session-a"), createdAt: "2026-01-01T00:00:00Z" });
    await kv.set(KV.insights, "insight-a", insight("insight-a", ["semantic-a"], ["lesson-a"], []));

    const stats = await listViewerSessionStats(kv, { sessionId: "session-a" });

    expect(stats.categories.lessons).toMatchObject({
      status: "failed",
      count: 0,
      source: KV.lessons,
      error: "lessons store read failed",
    });
    expect(stats.categories.summary.status).toBe("complete");
    expect(stats.categories.semantic.status).toBe("complete");
    expect(stats.categories.summary.count).toBe(1);
  });
});

describe("api::viewer-session-stats", () => {
  function registerViewerHandlers(kv: TestKV) {
    const sdk = {
      registerFunction: (id: string, handler: Function) => {
        if (id === "api::viewer-stores") sdk.viewerStores = handler;
        if (id === "api::viewer-store") sdk.viewerStore = handler;
        if (id === "api::viewer-session-stats") sdk.viewerSessionStats = handler;
      },
      registerTrigger: vi.fn(),
      trigger: vi.fn(),
      viewerStores: undefined as undefined | Function,
      viewerStore: undefined as undefined | Function,
      viewerSessionStats: undefined as undefined | Function,
    };
    registerApiTriggers(sdk as never, kv as never, "");
    return sdk;
  }

  it("returns session stats through the read-only GET handler", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "session-a", session("session-a", 1));
    await kv.set(KV.summaries, "summary-a", summary("session-a"));
    const sdk = registerViewerHandlers(kv);

    const response = await sdk.viewerSessionStats!({
      query_params: { sessionId: "session-a", includeDeleted: "false" },
      headers: {},
    });

    expect(response.status_code).toBe(200);
    expect((response.body as { sessionId: string }).sessionId).toBe("session-a");
    expect(response.body).toMatchObject({
      success: true,
      categories: { summary: { count: 1 } },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects missing sessionId for session stats handler", async () => {
    const sdk = registerViewerHandlers(mockKV());
    const response = await sdk.viewerSessionStats!({ query_params: {}, headers: {} });
    expect(response.status_code).toBe(400);
    expect(response.body).toMatchObject({ error: "sessionId is required" });
  });

  it("rejects invalid includeDeleted for session stats handler", async () => {
    const sdk = registerViewerHandlers(mockKV());
    const response = await sdk.viewerSessionStats!({
      query_params: { sessionId: "session-a", includeDeleted: "wrong" },
      headers: {},
    });
    expect(response.status_code).toBe(400);
    expect(response.body).toMatchObject({ error: "includeDeleted must be true or false" });
  });
});
