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
  });
  return pageItems(request.type, source, items, {
    limit,
    offset,
    cursor: request.cursor ?? null,
    filters: { ...filters, ...storeFilters },
  });
}

async function readFlatStore(
  kv: KeyValueStore,
  type: Exclude<ViewerStoreType, "observations">,
  options: { includeDeleted: boolean },
): Promise<{ source: string; items: unknown[]; filters: Record<string, string> }> {
  switch (type) {
    case "sessions": {
      const sessions = await kv.list<Session>(KV.sessions);
      return { source: KV.sessions, items: sortByDateDesc(sessions, "startedAt"), filters: {} };
    }
    case "summaries": {
      const summaries = await kv.list<SessionSummary>(KV.summaries);
      return { source: KV.summaries, items: sortByDateDesc(summaries, "createdAt"), filters: {} };
    }
    case "lessons": {
      const lessons = await kv.list<Lesson>(KV.lessons);
      return {
        source: KV.lessons,
        items: filterDeleted(lessons, options.includeDeleted).sort(compareConfidenceDesc),
        filters: deletedFilter(options.includeDeleted),
      };
    }
    case "semantic": {
      const semantic = await kv.list<SemanticMemory>(KV.semantic);
      return { source: KV.semantic, items: sortByDateDesc(semantic, "updatedAt"), filters: {} };
    }
    case "procedural": {
      const procedural = await kv.list<ProceduralMemory>(KV.procedural);
      return { source: KV.procedural, items: sortByDateDesc(procedural, "updatedAt"), filters: {} };
    }
    case "crystals": {
      const crystals = await kv.list<Crystal>(KV.crystals);
      return { source: KV.crystals, items: sortByDateDesc(crystals, "createdAt"), filters: {} };
    }
    case "insights": {
      const insights = await kv.list<Insight>(KV.insights);
      return {
        source: KV.insights,
        items: filterDeleted(insights, options.includeDeleted).sort(compareConfidenceDesc),
        filters: deletedFilter(options.includeDeleted),
      };
    }
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
