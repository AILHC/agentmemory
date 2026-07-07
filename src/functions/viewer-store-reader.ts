import { KV } from "../state/schema.js";
import type {
  CompressedObservation,
  Crystal,
  Insight,
  Lesson,
  ProceduralMemory,
  SemanticMemory,
  Session,
  SessionSummary,
} from "../types.js";

export type ViewerStoreType =
  | "sessions"
  | "summaries"
  | "observations"
  | "lessons"
  | "semantic"
  | "procedural"
  | "crystals"
  | "insights";

export type ViewerCompleteness = "complete" | "partial" | "unknown" | "failed";

export interface ViewerStorePage {
  success: true;
  type: ViewerStoreType;
  source: string;
  items: unknown[];
  total: number;
  returned: number;
  nextCursor?: string;
  hasMore: boolean;
  completeness: ViewerCompleteness;
  filters: Record<string, string>;
  limit: number;
  cursor: string | null;
}

export interface ViewerStoreSummary {
  type: ViewerStoreType;
  source: string;
  total: number;
  completeness: ViewerCompleteness;
  filters: Record<string, string>;
}

export interface ViewerStoreList {
  success: true;
  stores: ViewerStoreSummary[];
}

export type ViewerSessionStatStatus = "complete" | "failed";

export interface ViewerSessionCategoryStat {
  count: number;
  status: ViewerSessionStatStatus;
  source: string;
  attribution?: string;
  error?: string;
}

export interface ViewerSessionStats {
  success: true;
  sessionId: string;
  categories: Record<
    "summary" | "observations" | "lessons" | "semantic" | "procedural" | "crystals" | "insights",
    ViewerSessionCategoryStat
  >;
}

export interface ViewerSessionStatsRequest {
  sessionId: string;
  includeDeleted?: boolean;
}

export interface ViewerStoreRequest {
  type: ViewerStoreType;
  limit?: number;
  cursor?: string | null;
  sessionId?: string;
  includeDeleted?: boolean;
}

interface KeyValueStore {
  get<T>(scope: string, key: string): Promise<T | null>;
  list<T>(scope: string): Promise<T[]>;
}

const DEFAULT_LIMIT = 100;
export const MAX_VIEWER_STORE_LIMIT = 500;

const VIEWER_STORE_TYPES: ViewerStoreType[] = [
  "sessions",
  "summaries",
  "observations",
  "lessons",
  "semantic",
  "procedural",
  "crystals",
  "insights",
];

export function isViewerStoreType(value: unknown): value is ViewerStoreType {
  return typeof value === "string" && VIEWER_STORE_TYPES.includes(value as ViewerStoreType);
}

export function viewerStoreTypes(): ViewerStoreType[] {
  return [...VIEWER_STORE_TYPES];
}

export async function listViewerStores(
  kv: KeyValueStore,
  options: { includeDeleted?: boolean } = {},
): Promise<ViewerStoreList> {
  const includeDeleted = options.includeDeleted !== false;
  const [sessions, summaries, lessons, semantic, procedural, crystals, insights] =
    await Promise.all([
      kv.list<Session>(KV.sessions).catch(() => []),
      kv.list<SessionSummary>(KV.summaries).catch(() => []),
      kv.list<Lesson>(KV.lessons).catch(() => []),
      kv.list<SemanticMemory>(KV.semantic).catch(() => []),
      kv.list<ProceduralMemory>(KV.procedural).catch(() => []),
      kv.list<Crystal>(KV.crystals).catch(() => []),
      kv.list<Insight>(KV.insights).catch(() => []),
    ]);

  const filteredLessons = filterDeleted(lessons, includeDeleted);
  const filteredInsights = filterDeleted(insights, includeDeleted);
  const observationTotal = sessions.reduce((sum, session) => {
    const count = Number(session.observationCount);
    return sum + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);

  return {
    success: true,
    stores: [
      summary("sessions", KV.sessions, sessions.length),
      summary("summaries", KV.summaries, summaries.length),
      summary("observations", "mem:obs:*", observationTotal),
      summary("lessons", KV.lessons, filteredLessons.length, deletedFilter(includeDeleted)),
      summary("semantic", KV.semantic, semantic.length),
      summary("procedural", KV.procedural, procedural.length),
      summary("crystals", KV.crystals, crystals.length),
      summary("insights", KV.insights, filteredInsights.length, deletedFilter(includeDeleted)),
    ],
  };
}

export async function listViewerStore(
  kv: KeyValueStore,
  request: ViewerStoreRequest,
): Promise<ViewerStorePage> {
  const limit = normalizeLimit(request.limit);
  const offset = normalizeCursor(request.cursor);
  const includeDeleted = request.includeDeleted !== false;
  const filters = deletedFilter(includeDeleted);

  if (request.type === "observations") {
    return pageObservations(kv, {
      limit,
      offset,
      cursor: request.cursor ?? null,
      sessionId: request.sessionId,
    });
  }

  const { source, items, filters: storeFilters } = await readFlatStore(kv, request.type, {
    includeDeleted,
    sessionId: request.sessionId,
  });
  return pageItems(request.type, source, items, {
    limit,
    offset,
    cursor: request.cursor ?? null,
    filters: { ...filters, ...storeFilters },
  });
}

export async function buildObservationIdSet(
  kv: KeyValueStore,
  sessionId: string,
): Promise<Set<string>> {
  const observations = await kv.list<CompressedObservation>(KV.observations(sessionId));
  return new Set(observations.map((observation) => observation.id));
}

export function lessonBelongsToSession(
  lesson: Lesson,
  sessionId: string,
  observationIds: Set<string>,
): boolean {
  return lesson.sourceIds.includes(sessionId) || lesson.sourceIds.some((id) => observationIds.has(id));
}

export function semanticBelongsToSession(
  semantic: SemanticMemory,
  sessionId: string,
): boolean {
  return semantic.sourceSessionIds.includes(sessionId);
}

export function proceduralBelongsToSession(
  procedural: ProceduralMemory,
  sessionId: string,
): boolean {
  return procedural.sourceSessionIds.includes(sessionId);
}

export function crystalBelongsToSession(
  crystal: Crystal,
  sessionId: string,
): boolean {
  return crystal.sessionId === sessionId;
}

export function insightBelongsToSession(
  insight: Insight,
  sourceIds: {
    semanticMemoryIds: Set<string>;
    lessonIds: Set<string>;
    crystalIds: Set<string>;
  },
): boolean {
  return (
    insight.sourceMemoryIds.some((id) => sourceIds.semanticMemoryIds.has(id)) ||
    insight.sourceLessonIds.some((id) => sourceIds.lessonIds.has(id)) ||
    insight.sourceCrystalIds.some((id) => sourceIds.crystalIds.has(id))
  );
}

export async function listViewerSessionStats(
  kv: KeyValueStore,
  request: ViewerSessionStatsRequest,
): Promise<ViewerSessionStats> {
  const sessionId = request.sessionId?.trim();
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const includeDeleted = request.includeDeleted !== false;

  const categories = await Promise.all([
    safeCategoryStat(KV.summaries, async () => ({
      count: (await kv.list<SessionSummary>(KV.summaries))
        .filter((summary) => summary.sessionId === sessionId)
        .length,
    })),
    safeCategoryStat("mem:sessions.observationCount", async () => {
      const session = await kv.get<Session>(KV.sessions, sessionId);
      const countValue = session?.observationCount;
      const isValidCount = typeof countValue === "number" && Number.isFinite(countValue) && countValue >= 0;
      if (isValidCount) {
        return { count: countValue, source: "mem:sessions.observationCount" };
      }

      const observations = await kv.list<CompressedObservation>(KV.observations(sessionId));
      return {
        count: observations.length,
        source: KV.observations(sessionId),
        attribution: "mem:sessions.observationCount",
      };
    }),
    safeCategoryStat(KV.lessons, async () => ({
      count: (await getSessionScopedLessons(kv, sessionId, includeDeleted)).length,
    })),
    safeCategoryStat(KV.semantic, async () => ({
      count: (await getSessionScopedSemantic(kv, sessionId)).length,
    })),
    safeCategoryStat(KV.procedural, async () => ({
      count: (await getSessionScopedProcedural(kv, sessionId)).length,
    })),
    safeCategoryStat(KV.crystals, async () => ({
      count: (await getSessionScopedCrystals(kv, sessionId)).length,
    })),
    safeCategoryStat(KV.insights, async () => ({
      count: (await getSessionScopedInsights(kv, sessionId, includeDeleted)).length,
    })),
  ]);

  return {
    success: true,
    sessionId,
    categories: {
      summary: categories[0],
      observations: categories[1],
      lessons: categories[2],
      semantic: categories[3],
      procedural: categories[4],
      crystals: categories[5],
      insights: categories[6],
    },
  };
}

async function readFlatStore(
  kv: KeyValueStore,
  type: Exclude<ViewerStoreType, "observations">,
  options: { includeDeleted: boolean; sessionId?: string },
): Promise<{ source: string; items: unknown[]; filters: Record<string, string> }> {
  switch (type) {
    case "sessions": {
      const sessions = await kv.list<Session>(KV.sessions);
      const filtered = options.sessionId
        ? sessions.filter((session) => session.id === options.sessionId)
        : sessions;
      return {
        source: KV.sessions,
        items: sortByDateDesc(filtered, "startedAt"),
        filters: {},
      };
    }
    case "summaries": {
      const summaries = await kv.list<SessionSummary>(KV.summaries);
      const filtered = options.sessionId
        ? summaries.filter((summary) => summary.sessionId === options.sessionId)
        : summaries;
      return { source: KV.summaries, items: sortByDateDesc(filtered, "createdAt"), filters: {} };
    }
    case "lessons": {
      const filtered = options.sessionId
        ? await getSessionScopedLessons(kv, options.sessionId, options.includeDeleted)
        : filterDeleted(await kv.list<Lesson>(KV.lessons), options.includeDeleted)
            .sort(compareConfidenceDesc);
      return {
        source: KV.lessons,
        items: filtered,
        filters: deletedFilter(options.includeDeleted),
      };
    }
    case "semantic": {
      const semantic = await (options.sessionId
        ? getSessionScopedSemantic(kv, options.sessionId)
        : kv.list<SemanticMemory>(KV.semantic));
      return { source: KV.semantic, items: sortByDateDesc(semantic, "updatedAt"), filters: {} };
    }
    case "procedural": {
      const procedural = await (options.sessionId
        ? getSessionScopedProcedural(kv, options.sessionId)
        : kv.list<ProceduralMemory>(KV.procedural));
      return { source: KV.procedural, items: sortByDateDesc(procedural, "updatedAt"), filters: {} };
    }
    case "crystals": {
      const crystals = await (options.sessionId
        ? getSessionScopedCrystals(kv, options.sessionId)
        : kv.list<Crystal>(KV.crystals));
      return { source: KV.crystals, items: sortByDateDesc(crystals, "createdAt"), filters: {} };
    }
    case "insights": {
      const insights = await (options.sessionId
        ? getSessionScopedInsights(kv, options.sessionId, options.includeDeleted)
        : filterDeleted(await kv.list<Insight>(KV.insights), options.includeDeleted));
      return {
        source: KV.insights,
        items: insights.sort(compareConfidenceDesc),
        filters: deletedFilter(options.includeDeleted),
      };
    }
  }
}

async function getSessionScopedLessons(
  kv: KeyValueStore,
  sessionId: string,
  includeDeleted: boolean,
): Promise<Lesson[]> {
  const lessons = await kv.list<Lesson>(KV.lessons);
  const observationIds = await buildObservationIdSet(kv, sessionId);
  return filterDeleted(lessons, includeDeleted)
    .filter((lesson) => lessonBelongsToSession(lesson, sessionId, observationIds))
    .sort(compareConfidenceDesc);
}

async function getSessionScopedSemantic(
  kv: KeyValueStore,
  sessionId: string,
): Promise<SemanticMemory[]> {
  const semantic = await kv.list<SemanticMemory>(KV.semantic);
  return semantic.filter((item) => semanticBelongsToSession(item, sessionId));
}

async function getSessionScopedProcedural(
  kv: KeyValueStore,
  sessionId: string,
): Promise<ProceduralMemory[]> {
  const procedural = await kv.list<ProceduralMemory>(KV.procedural);
  return procedural.filter((item) => proceduralBelongsToSession(item, sessionId));
}

async function getSessionScopedCrystals(
  kv: KeyValueStore,
  sessionId: string,
): Promise<Crystal[]> {
  const crystals = await kv.list<Crystal>(KV.crystals);
  return crystals.filter((crystal) => crystalBelongsToSession(crystal, sessionId));
}

async function getSessionScopedInsights(
  kv: KeyValueStore,
  sessionId: string,
  includeDeleted: boolean,
): Promise<Insight[]> {
  const [insights, sourceIds] = await Promise.all([
    kv.list<Insight>(KV.insights),
    getInsightSourceIds(kv, sessionId, includeDeleted),
  ]);
  return filterDeleted(insights, includeDeleted)
    .filter((insight) => insightBelongsToSession(insight, sourceIds))
    .sort(compareConfidenceDesc);
}

async function getInsightSourceIds(
  kv: KeyValueStore,
  sessionId: string,
  includeDeleted: boolean,
): Promise<{
  semanticMemoryIds: Set<string>;
  lessonIds: Set<string>;
  crystalIds: Set<string>;
}> {
  const [semantic, lessons, crystals] = await Promise.all([
    kv.list<SemanticMemory>(KV.semantic),
    kv.list<Lesson>(KV.lessons),
    kv.list<Crystal>(KV.crystals),
  ]);
  const observationIds = await buildObservationIdSet(kv, sessionId);
  return {
    semanticMemoryIds: new Set(
      semantic.filter((item) => semanticBelongsToSession(item, sessionId)).map((item) => item.id),
    ),
    lessonIds: new Set(
      filterDeleted(lessons, includeDeleted)
        .filter((lesson) => lessonBelongsToSession(lesson, sessionId, observationIds))
        .map((lesson) => lesson.id),
    ),
    crystalIds: new Set(
      crystals.filter((crystal) => crystalBelongsToSession(crystal, sessionId)).map((crystal) => crystal.id),
    ),
  };
}

async function safeCategoryStat(
  source: string,
  calculate: () => Promise<Omit<ViewerSessionCategoryStat, "status" | "source" | "error"> & { source?: string }>,
): Promise<ViewerSessionCategoryStat> {
  try {
    const data = await calculate();
    return {
      status: "complete",
      source: data.source ?? source,
      count: data.count,
      ...(data.attribution ? { attribution: data.attribution } : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      source,
      count: 0,
      error: error instanceof Error ? error.message : "failed",
    };
  }
}

async function pageObservations(
  kv: KeyValueStore,
  request: { limit: number; offset: number; cursor: string | null; sessionId?: string },
): Promise<ViewerStorePage> {
  if (request.sessionId) {
    const source = KV.observations(request.sessionId);
    const observations = sortByDateAsc(await kv.list<CompressedObservation>(source), "timestamp");
    return pageItems("observations", source, observations, {
      limit: request.limit,
      offset: request.offset,
      cursor: request.cursor,
      filters: { sessionId: request.sessionId },
    });
  }

  const sessions = sortByDateDesc(await kv.list<Session>(KV.sessions), "startedAt");
  const observations: CompressedObservation[] = [];
  for (const session of sessions) {
    observations.push(
      ...sortByDateAsc(
        await kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []),
        "timestamp",
      ),
    );
  }

  return pageItems("observations", "mem:obs:*", observations, {
    limit: request.limit,
    offset: request.offset,
    cursor: request.cursor,
    filters: {},
  });
}

function pageItems(
  type: ViewerStoreType,
  source: string,
  items: unknown[],
  options: {
    limit: number;
    offset: number;
    cursor: string | null;
    filters: Record<string, string>;
  },
): ViewerStorePage {
  const page = items.slice(options.offset, options.offset + options.limit);
  const hasMore = options.offset + page.length < items.length;
  return {
    success: true,
    type,
    source,
    items: page,
    total: items.length,
    returned: page.length,
    ...(hasMore ? { nextCursor: String(options.offset + page.length) } : {}),
    hasMore,
    completeness: hasMore ? "partial" : "complete",
    filters: options.filters,
    limit: options.limit,
    cursor: options.cursor,
  };
}

function summary(
  type: ViewerStoreType,
  source: string,
  total: number,
  filters: Record<string, string> = {},
): ViewerStoreSummary {
  return { type, source, total, completeness: "complete", filters };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, MAX_VIEWER_STORE_LIMIT);
}

function normalizeCursor(value: string | null | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error("cursor must be a non-negative integer offset");
  }
  return Number(value);
}

function filterDeleted<T extends { deleted?: boolean }>(items: T[], includeDeleted: boolean): T[] {
  return includeDeleted ? items : items.filter((item) => !item.deleted);
}

function deletedFilter(includeDeleted: boolean): Record<string, string> {
  return { deleted: includeDeleted ? "included" : "excluded" };
}

function sortByDateDesc<T>(items: T[], key: keyof T): T[] {
  return [...items].sort((a, b) => dateValue(b[key]) - dateValue(a[key]));
}

function sortByDateAsc<T>(items: T[], key: keyof T): T[] {
  return [...items].sort((a, b) => dateValue(a[key]) - dateValue(b[key]));
}

function dateValue(value: unknown): number {
  if (typeof value !== "string") return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function compareConfidenceDesc(
  a: { confidence?: number; createdAt?: string },
  b: { confidence?: number; createdAt?: string },
): number {
  const byConfidence = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (byConfidence !== 0) return byConfidence;
  return dateValue(b.createdAt) - dateValue(a.createdAt);
}
