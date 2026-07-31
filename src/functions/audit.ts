import { createHash } from "node:crypto";

import type {
  AuditEntry,
  ExtractionRunAuditLocator,
  ExtractionRunAuditState,
  ExtractionRunStoredAuditEvent,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";

const EXTRACTION_AUDIT_STATE_KEY = "audit";
const EXTRACTION_AUDIT_EVENT_KEY = "event";
const EXTRACTION_AUDIT_PAGE_CAPACITY = 128;
const EXTRACTION_AUDIT_MAX_EVENT_BYTES = 64 * 1024;
export const AUDIT_ENTRY_CONFLICT = "audit_entry_conflict";
export const AUDIT_ENTRY_MISSING = "audit_entry_missing";

export interface RecordAuditOptions {
  id?: string;
  timestamp?: string;
  requireExisting?: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stablePersistedJson(value: unknown): string {
  return stableJson(JSON.parse(JSON.stringify(value)));
}

async function listExtractionAuditEntries(kv: StateKV): Promise<AuditEntry[]> {
  const state = await kv.get<ExtractionRunAuditState>(
    KV.extractionRunAuditControl,
    EXTRACTION_AUDIT_STATE_KEY,
  );
  if (!state) return [];
  const pages = await Promise.all(
    Array.from({ length: state.pageCount }, (_, page) =>
      kv.list<ExtractionRunAuditLocator>(
        KV.extractionRunAuditManifestPage(page),
      )),
  );
  const locators = pages.flat();
  const entries: AuditEntry[] = [];
  for (let offset = 0; offset < locators.length; offset += 16) {
    const batch = await Promise.all(
      locators.slice(offset, offset + 16).map((locator) =>
        kv.get<ExtractionRunStoredAuditEvent>(
          KV.extractionRunAuditEvent(locator.eventToken),
          EXTRACTION_AUDIT_EVENT_KEY,
        )),
    );
    for (let index = 0; index < batch.length; index++) {
      const stored = batch[index];
      if (!stored) {
        throw new Error(
          `extraction run audit manifest references missing event: ${locators[offset + index].eventToken}`,
        );
      }
      const { page: _page, ...entry } = stored;
      entries.push(entry);
    }
  }
  return entries;
}

// Audit coverage policy (issue #125).
//
// Every structural deletion of a memory, observation, session, or
// semantic row MUST call recordAudit. Two shapes are allowed, keyed to
// whether the caller is scoped or bulk:
//
//   Scoped deletions — a user-visible, per-call action removing a
//   bounded set of items. Emit ONE audit row per call with targetIds
//   populated. Examples: mem::governance-delete, mem::forget.
//
//   Bulk deletions — automatic sweeps (retention, TTL eviction,
//   auto-forget) that can remove hundreds of rows per invocation.
//   Emit ONE batched audit row per invocation with targetIds listing
//   every removed id and details.evicted holding the count. Per-item
//   audit rows would flood the audit log during routine sweeps.
//
//   Either shape is required; silent deletes are not acceptable.
//
// operation field:
//   - "delete"          — permanent removal (governance, retention sweep, evict).
//   - "forget"          — forget/removal flows. Scoped when emitted by
//                         mem::forget (user-initiated); bulk-batched when
//                         emitted by mem::auto-forget (automatic sweep).
//   - everything else   — see AuditEntry["operation"] union in src/types.ts.
//
// When adding a new deletion path, add an explicit recordAudit call
// BEFORE kv.delete(...) and match one of the two shapes above.

export async function recordAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
  options: RecordAuditOptions = {},
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: options.id ?? generateId("aud"),
    timestamp: options.timestamp ?? new Date().toISOString(),
    operation,
    functionId,
    targetIds,
    details,
    ...(qualityScore === undefined ? {} : { qualityScore }),
    ...(userId === undefined ? {} : { userId }),
  };
  if (options.requireExisting && options.id === undefined) {
    throw new Error(AUDIT_ENTRY_MISSING);
  }
  if (options.id === undefined) {
    await kv.set(KV.audit, entry.id, entry);
    return entry;
  }
  return withKeyedLock(`audit-entry:${entry.id}`, async () => {
    const existing = await kv.get<AuditEntry>(KV.audit, entry.id);
    if (existing) {
      if (stablePersistedJson(existing) !== stablePersistedJson(entry)) {
        throw new Error(AUDIT_ENTRY_CONFLICT);
      }
      return existing;
    }
    if (options.requireExisting) {
      throw new Error(AUDIT_ENTRY_MISSING);
    }
    await kv.set(KV.audit, entry.id, entry);
    return entry;
  });
}

export async function safeAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<void> {
  try {
    await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
  } catch (err) {
    try {
      logger.warn("audit write failed", {
        functionId,
        operation,
        targetIds,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function recordExtractionRunAudit(
  kv: StateKV,
  runId: string,
  details: Record<string, unknown>,
  eventIdentity: unknown = details,
): Promise<AuditEntry> {
  const eventToken = createHash("sha256")
    .update(stableJson([runId, eventIdentity]))
    .digest("hex");
  const id = `aud_extraction_${eventToken.slice(0, 24)}`;
  return withKeyedLock("extraction-run-audit", async () => {
    const eventScope = KV.extractionRunAuditEvent(eventToken);
    const existing = await kv.get<ExtractionRunStoredAuditEvent>(
      eventScope,
      EXTRACTION_AUDIT_EVENT_KEY,
    );
    if (existing) {
      await kv.set(
        KV.extractionRunAuditManifestPage(existing.page),
        eventToken,
        { eventToken },
      );
      const { page: _page, ...entry } = existing;
      return entry;
    }

    const storedState = await kv.get<ExtractionRunAuditState>(
      KV.extractionRunAuditControl,
      EXTRACTION_AUDIT_STATE_KEY,
    );
    const state = storedState ?? { currentPage: 0, pageCount: 1 };
    let page = state.currentPage;
    const entries = await kv.list<ExtractionRunAuditLocator>(
      KV.extractionRunAuditManifestPage(page),
    );
    let nextState = state;
    if (entries.length >= EXTRACTION_AUDIT_PAGE_CAPACITY) {
      page += 1;
      nextState = { currentPage: page, pageCount: page + 1 };
    }
    await kv.set(
      KV.extractionRunAuditControl,
      EXTRACTION_AUDIT_STATE_KEY,
      nextState,
    );
    const entry: ExtractionRunStoredAuditEvent = {
      id,
      timestamp: new Date().toISOString(),
      operation: "extraction_run_record",
      functionId: "mem::extraction-run-record",
      targetIds: [runId],
      details,
      page,
    };
    if (Buffer.byteLength(JSON.stringify(entry)) > EXTRACTION_AUDIT_MAX_EVENT_BYTES) {
      throw new Error(
        `extraction run audit exceeds ${EXTRACTION_AUDIT_MAX_EVENT_BYTES} bytes`,
      );
    }
    await kv.set(eventScope, EXTRACTION_AUDIT_EVENT_KEY, entry);
    await kv.set(
      KV.extractionRunAuditManifestPage(page),
      eventToken,
      { eventToken },
    );
    const { page: _page, ...result } = entry;
    return result;
  });
}

export async function queryAudit(
  kv: StateKV,
  filter?: {
    operation?: AuditEntry["operation"];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<AuditEntry[]> {
  const includeGlobal = true;
  const includeExtraction = (
    filter?.operation === undefined
    || filter.operation === "extraction_run_record"
  );
  const all = [
    ...(includeGlobal ? await kv.list<AuditEntry>(KV.audit) : []),
    ...(includeExtraction ? await listExtractionAuditEntries(kv) : []),
  ];
  let entries = [...all].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (filter?.operation) {
    entries = entries.filter((e) => e.operation === filter.operation);
  }
  if (filter?.dateFrom) {
    const from = new Date(filter.dateFrom).getTime();
    if (Number.isNaN(from)) {
      throw new Error(`Invalid dateFrom: ${filter.dateFrom}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= from);
  }
  if (filter?.dateTo) {
    const to = new Date(filter.dateTo).getTime();
    if (Number.isNaN(to)) {
      throw new Error(`Invalid dateTo: ${filter.dateTo}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  return entries.slice(0, filter?.limit || 100);
}
