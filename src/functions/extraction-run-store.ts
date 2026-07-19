import { createHash } from "node:crypto";

import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type {
  ExtractionRunCatalogEntry,
  ExtractionRunCatalogState,
  ExtractionRunIndex,
  ExtractionRunMetadata,
  ExtractionRunRecordLocator,
  ExtractionRunStageRecord,
  ExtractionRunStatus,
  ExtractionRunStoredRecord,
} from "../types.js";

const CATALOG_STATE_KEY = "catalog";
const METADATA_KEY = "metadata";
const RECORD_KEY = "record";
const PAGE_CAPACITY = 128;
export const EXTRACTION_RUN_MAX_ID_BYTES = 512;
export const EXTRACTION_RUN_MAX_MARK_BYTES = 512;
export const EXTRACTION_RUN_MAX_RECORD_BYTES = 1024 * 1024;

export interface ExtractionRunKV {
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  delete(scope: string, key: string): Promise<void>;
  list<T = unknown>(scope: string): Promise<T[]>;
}

export interface RecordExtractionRunInput {
  runId: string;
  mark: string;
  status?: ExtractionRunStatus;
  records: ExtractionRunStageRecord[];
  summarySessionIds?: string[];
  lessonRunIds?: string[];
  semanticWindowIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

function token(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function runToken(runId: string): string {
  return token([runId]);
}

function recordToken(
  runId: string,
  record: Pick<ExtractionRunStageRecord, "stage" | "unitId">,
): string {
  return token([runId, record.stage, record.unitId ?? ""]);
}

function addUnique(values: string[], additions: string[]): string[] {
  const next = [...values];
  for (const value of additions) {
    if (!next.includes(value)) next.push(value);
  }
  return next;
}

function assertByteLimit(value: string, limit: number, name: string): void {
  if (Buffer.byteLength(value) > limit) {
    throw new Error(`${name} exceeds ${limit} bytes`);
  }
}

function assertRecordBounded(record: ExtractionRunStageRecord): void {
  if (Buffer.byteLength(JSON.stringify(record)) > EXTRACTION_RUN_MAX_RECORD_BYTES) {
    throw new Error(
      `extraction run record exceeds ${EXTRACTION_RUN_MAX_RECORD_BYTES} bytes`,
    );
  }
}

function mergeStageRecord(
  existing: ExtractionRunStageRecord,
  next: ExtractionRunStageRecord,
): ExtractionRunStageRecord {
  return {
    ...existing,
    sourceIds: addUnique(existing.sourceIds, next.sourceIds),
    resultIds: addUnique(existing.resultIds, next.resultIds),
    resultType: next.resultType ?? existing.resultType,
    updatedAt: next.updatedAt,
  };
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export class ExtractionRunStore {
  constructor(private readonly kv: ExtractionRunKV) {}

  async record(input: RecordExtractionRunInput): Promise<ExtractionRunMetadata> {
    return withKeyedLock("extraction-run-store-lifecycle", () =>
      this.recordForRun(input));
  }

  private async recordForRun(
    input: RecordExtractionRunInput,
  ): Promise<ExtractionRunMetadata> {
    return withKeyedLock(`extraction-run-store:${input.runId}`, async () => {
      assertByteLimit(input.runId, EXTRACTION_RUN_MAX_ID_BYTES, "runId");
      assertByteLimit(input.mark, EXTRACTION_RUN_MAX_MARK_BYTES, "mark");
      for (const record of input.records) assertRecordBounded(record);
      const now = input.updatedAt ?? new Date().toISOString();
      const scopeToken = runToken(input.runId);
      const metadataScope = KV.extractionRunMetadata(scopeToken);
      let metadata = await this.kv.get<ExtractionRunMetadata>(
        metadataScope,
        METADATA_KEY,
      );

      if (!metadata) {
        const catalogPage = await this.ensureCatalogEntry(input.runId);
        metadata = {
          id: input.runId,
          mark: input.mark,
          status: input.status ?? "running",
          catalogPage,
          currentManifestPage: 0,
          createdAt: input.createdAt ?? now,
          updatedAt: now,
        };
        await this.kv.set(metadataScope, METADATA_KEY, metadata);
      } else if (metadata.mark !== input.mark) {
        throw new Error(
          `extraction run mark mismatch: expected ${metadata.mark}`,
        );
      }

      for (const record of input.records) {
        metadata = await this.upsertRecord(
          scopeToken,
          metadata,
          record,
          this.compatibilityIdForRecord(input, record),
        );
      }

      const nextMetadata: ExtractionRunMetadata = {
        ...metadata,
        mark: input.mark,
        status: input.status ?? metadata.status,
        updatedAt: now,
      };
      await this.kv.set(metadataScope, METADATA_KEY, nextMetadata);
      return nextMetadata;
    });
  }

  async get(runId: string): Promise<ExtractionRunIndex | null> {
    const scopeToken = runToken(runId);
    const [legacy, metadata] = await Promise.all([
      this.kv.get<ExtractionRunIndex>(KV.extractionRuns, runId),
      this.kv.get<ExtractionRunMetadata>(
        KV.extractionRunMetadata(scopeToken),
        METADATA_KEY,
      ),
    ]);
    return this.composeRun(runId, legacy, metadata);
  }

  async list(): Promise<ExtractionRunIndex[]> {
    const [legacyRuns, runIds] = await Promise.all([
      this.kv.list<ExtractionRunIndex>(KV.extractionRuns).catch(() => []),
      this.listCatalogRunIds(),
    ]);
    const legacyById = new Map(legacyRuns.map((run) => [run.id, run]));
    const allIds = addUnique(
      legacyRuns.map((run) => run.id),
      runIds,
    );
    const runs = await mapLimit(allIds, 8, async (runId) => {
      const metadata = await this.kv.get<ExtractionRunMetadata>(
        KV.extractionRunMetadata(runToken(runId)),
        METADATA_KEY,
      );
      return this.composeRun(runId, legacyById.get(runId) ?? null, metadata);
    });
    return runs.filter((run): run is ExtractionRunIndex => run !== null);
  }

  async replace(run: ExtractionRunIndex): Promise<void> {
    await withKeyedLock("extraction-run-store-lifecycle", async () => {
      await this.deleteForRun(run.id);
      await this.recordForRun({
        runId: run.id,
        mark: run.mark,
        status: run.status,
        records: this.normalizeImportedRecords(run),
        summarySessionIds: run.summarySessionIds,
        lessonRunIds: run.lessonRunIds,
        semanticWindowIds: run.semanticWindowIds,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    });
  }

  async delete(runId: string): Promise<void> {
    await withKeyedLock("extraction-run-store-lifecycle", () =>
      this.deleteForRun(runId));
  }

  private async deleteForRun(runId: string): Promise<void> {
    await withKeyedLock(`extraction-run-store:${runId}`, async () => {
      const scopeToken = runToken(runId);
      const metadataScope = KV.extractionRunMetadata(scopeToken);
      const metadata = await this.kv.get<ExtractionRunMetadata>(
        metadataScope,
        METADATA_KEY,
      );
      if (metadata) {
        for (let page = 0; page <= metadata.currentManifestPage; page++) {
          const manifestScope = KV.extractionRunManifest(scopeToken, page);
          const locators = await this.kv.list<ExtractionRunRecordLocator>(
            manifestScope,
          );
          for (const locator of locators) {
            await this.kv.delete(
              KV.extractionRunRecord(locator.recordId),
              RECORD_KEY,
            );
            await this.kv.delete(manifestScope, locator.recordId);
          }
        }
        await this.kv.delete(metadataScope, METADATA_KEY);
        await this.removeCatalogEntry(runId, scopeToken);
      } else {
        await this.removeCatalogEntry(runId, scopeToken);
      }
      await this.kv.delete(KV.extractionRuns, runId);
    });
  }

  async clear(): Promise<void> {
    await withKeyedLock("extraction-run-store-lifecycle", async () => {
      const runs = await this.list();
      for (const run of runs) {
        await this.deleteForRun(run.id);
      }
      const state = await this.kv.get<ExtractionRunCatalogState>(
        KV.extractionRunCatalogControl,
        CATALOG_STATE_KEY,
      );
      if (state) {
        for (let page = 0; page < state.pageCount; page++) {
          const entries = await this.kv.list<ExtractionRunCatalogEntry>(
            KV.extractionRunCatalogPage(page),
          );
          for (const entry of entries) {
            await this.kv.delete(
              KV.extractionRunCatalogPage(page),
              runToken(entry.runId),
            );
          }
        }
        await this.kv.delete(
          KV.extractionRunCatalogControl,
          CATALOG_STATE_KEY,
        );
      }
    });
  }

  private async composeRun(
    runId: string,
    legacy: ExtractionRunIndex | null,
    metadata: ExtractionRunMetadata | null,
  ): Promise<ExtractionRunIndex | null> {
    if (!legacy && !metadata) return null;
    const modernStoredRecords = metadata
      ? await this.readRecords(runToken(runId), metadata)
      : [];
    const modernRecords = modernStoredRecords.map(
      ({
        recordId: _recordId,
        runId: _runId,
        manifestPage: _page,
        compatibilityId: _compatibilityId,
        ...record
      }) => record,
    );
    const recordsByIdentity = new Map<string, ExtractionRunStageRecord>();
    for (const record of legacy?.stageRecords ?? []) {
      recordsByIdentity.set(this.recordIdentity(record), record);
    }
    for (const record of modernRecords) {
      const identity = this.recordIdentity(record);
      recordsByIdentity.set(identity, record);
    }
    const stageRecords = Array.from(recordsByIdentity.values());

    return {
      id: runId,
      mark: metadata?.mark ?? legacy!.mark,
      status: metadata?.status ?? legacy!.status,
      summarySessionIds: addUnique(
        legacy?.summarySessionIds ?? [],
        modernStoredRecords
          .filter((record) => record.stage === "summary")
          .flatMap((record) =>
            record.compatibilityId ? [record.compatibilityId] : []),
      ),
      lessonRunIds: addUnique(
        legacy?.lessonRunIds ?? [],
        modernStoredRecords
          .filter((record) => record.stage === "lessons")
          .flatMap((record) =>
            record.compatibilityId ? [record.compatibilityId] : []),
      ),
      semanticWindowIds: addUnique(
        legacy?.semanticWindowIds ?? [],
        modernStoredRecords
          .filter((record) => record.stage === "semantic_rollup")
          .flatMap((record) =>
            record.compatibilityId ? [record.compatibilityId] : []),
      ),
      stageRecords,
      createdAt: legacy?.createdAt ?? metadata!.createdAt,
      updatedAt: metadata?.updatedAt ?? legacy!.updatedAt,
    };
  }

  private async ensureCatalogEntry(runId: string): Promise<number> {
    return withKeyedLock("extraction-run-catalog", async () => {
      const storedState = await this.kv.get<ExtractionRunCatalogState>(
        KV.extractionRunCatalogControl,
        CATALOG_STATE_KEY,
      );
      const state = storedState ?? { currentPage: 0, pageCount: 1 };

      for (let page = 0; page < state.pageCount; page++) {
        const entries = await this.kv.list<ExtractionRunCatalogEntry>(
          KV.extractionRunCatalogPage(page),
        );
        if (entries.some((entry) => entry.runId === runId)) {
          if (!storedState) {
            await this.kv.set(
              KV.extractionRunCatalogControl,
              CATALOG_STATE_KEY,
              state,
            );
          }
          return page;
        }
      }

      let page = state.currentPage;
      const entries = await this.kv.list<ExtractionRunCatalogEntry>(
        KV.extractionRunCatalogPage(page),
      );
      let nextState = state;
      if (entries.length >= PAGE_CAPACITY) {
        page += 1;
        nextState = { currentPage: page, pageCount: page + 1 };
      }

      await this.kv.set(
        KV.extractionRunCatalogControl,
        CATALOG_STATE_KEY,
        nextState,
      );
      await this.kv.set(
        KV.extractionRunCatalogPage(page),
        runToken(runId),
        { runId },
      );
      return page;
    });
  }

  private async removeCatalogEntry(runId: string, scopeToken: string): Promise<void> {
    await withKeyedLock("extraction-run-catalog", async () => {
      const state = await this.kv.get<ExtractionRunCatalogState>(
        KV.extractionRunCatalogControl,
        CATALOG_STATE_KEY,
      );
      if (!state) return;
      for (let page = 0; page < state.pageCount; page++) {
        const entries = await this.kv.list<ExtractionRunCatalogEntry>(
          KV.extractionRunCatalogPage(page),
        );
        if (entries.some((entry) => entry.runId === runId)) {
          await this.kv.delete(KV.extractionRunCatalogPage(page), scopeToken);
          return;
        }
      }
    });
  }

  private async upsertRecord(
    scopeToken: string,
    metadata: ExtractionRunMetadata,
    record: ExtractionRunStageRecord,
    compatibilityId?: string,
  ): Promise<ExtractionRunMetadata> {
    const id = recordToken(metadata.id, record);
    const recordScope = KV.extractionRunRecord(id);
    const existing = await this.kv.get<ExtractionRunStoredRecord>(
      recordScope,
      RECORD_KEY,
    );
    if (
      existing
      && (
        existing.runId !== metadata.id
        || existing.stage !== record.stage
        || (existing.unitId ?? "") !== (record.unitId ?? "")
      )
    ) {
      throw new Error(`extraction run record token collision: ${id}`);
    }

    let page = existing?.manifestPage ?? metadata.currentManifestPage;
    let nextMetadata = metadata;
    if (!existing) {
      const locators = await this.kv.list<ExtractionRunRecordLocator>(
        KV.extractionRunManifest(scopeToken, page),
      );
      if (locators.length >= PAGE_CAPACITY) {
        page += 1;
        nextMetadata = { ...metadata, currentManifestPage: page };
        await this.kv.set(
          KV.extractionRunMetadata(scopeToken),
          METADATA_KEY,
          nextMetadata,
        );
      }
    }

    const next: ExtractionRunStoredRecord = {
      ...(existing ? mergeStageRecord(existing, record) : record),
      recordId: id,
      runId: metadata.id,
      manifestPage: page,
      compatibilityId: compatibilityId ?? existing?.compatibilityId,
    };
    assertRecordBounded(next);
    await this.kv.set(recordScope, RECORD_KEY, next);
    await this.kv.set(
      KV.extractionRunManifest(scopeToken, page),
      id,
      { recordId: id },
    );
    return nextMetadata;
  }

  private async readRecords(
    scopeToken: string,
    metadata: ExtractionRunMetadata,
  ): Promise<ExtractionRunStoredRecord[]> {
    const locators: ExtractionRunRecordLocator[] = [];
    for (let page = 0; page <= metadata.currentManifestPage; page++) {
      locators.push(
        ...await this.kv.list<ExtractionRunRecordLocator>(
          KV.extractionRunManifest(scopeToken, page),
        ),
      );
    }
    const stored = await mapLimit(locators, 16, async (locator) =>
      this.kv.get<ExtractionRunStoredRecord>(
        KV.extractionRunRecord(locator.recordId),
        RECORD_KEY,
      ));
    const missing = stored.findIndex((record) => record === null);
    if (missing !== -1) {
      throw new Error(
        `extraction run manifest references missing record: ${locators[missing].recordId}`,
      );
    }
    return stored as ExtractionRunStoredRecord[];
  }

  private recordIdentity(
    record: Pick<ExtractionRunStageRecord, "stage" | "unitId">,
  ): string {
    return `${record.stage}\u0000${record.unitId ?? ""}`;
  }

  private async listCatalogRunIds(): Promise<string[]> {
    const state = await this.kv.get<ExtractionRunCatalogState>(
      KV.extractionRunCatalogControl,
      CATALOG_STATE_KEY,
    );
    if (!state) return [];
    const runIds: string[] = [];
    for (let page = 0; page < state.pageCount; page++) {
      const entries = await this.kv.list<ExtractionRunCatalogEntry>(
        KV.extractionRunCatalogPage(page),
      );
      runIds.push(...entries.map((entry) => entry.runId));
    }
    return runIds;
  }

  private normalizeImportedRecords(
    run: ExtractionRunIndex,
  ): ExtractionRunStageRecord[] {
    const records = [...(run.stageRecords ?? [])];
    const addCompatibilityRecord = (
      stage: ExtractionRunStageRecord["stage"],
      unitId: string,
      resultType: ExtractionRunStageRecord["resultType"],
    ): void => {
      if (records.some(
        (record) =>
          record.stage === stage && (record.unitId ?? "") === unitId,
      )) return;
      records.push({
        stage,
        unitId,
        sourceIds: stage === "summary" ? [unitId] : [],
        resultIds: [unitId],
        resultType,
        updatedAt: run.updatedAt,
      });
    };
    for (const id of run.summarySessionIds ?? []) {
      addCompatibilityRecord("summary", id, "summary");
    }
    for (const id of run.lessonRunIds ?? []) {
      addCompatibilityRecord("lessons", id, "lesson");
    }
    for (const id of run.semanticWindowIds ?? []) {
      addCompatibilityRecord("semantic_rollup", id, "semantic");
    }
    return records;
  }

  private compatibilityIdForRecord(
    input: RecordExtractionRunInput,
    record: ExtractionRunStageRecord,
  ): string | undefined {
    const candidates = record.stage === "summary"
      ? input.summarySessionIds
      : record.stage === "lessons"
        ? input.lessonRunIds
        : record.stage === "semantic_rollup"
          ? input.semanticWindowIds
          : undefined;
    return candidates?.find((id) => id === record.unitId);
  }
}
