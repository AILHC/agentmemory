import { createHash } from "node:crypto";
import type {
  AdoptedBaselineControl,
  AdoptedBaselineCoverageRecord,
  AdoptedBaselineExpectedSet,
  AdoptedBaselineLessonSeedRecord,
  AdoptedBaselineManifest,
  AdoptedBaselineStage,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

const BASELINE_CONTROL_KEY = "active";
const BASELINE_LOCK_KEY = "extraction-adopted-baseline";
const SHA256 = /^[0-9a-f]{64}$/;
const BASELINE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PARTITION_READ_CONCURRENCY = 64;
const STAGES = new Set<AdoptedBaselineStage>([
  "summary",
  "lessons",
  "memory_consolidate",
  "semantic_rollup",
  "skill_extract",
]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  project: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    results.push(...await Promise.all(items.slice(offset, offset + concurrency).map(project)));
  }
  return results;
}

function validateExpectedSet(value: AdoptedBaselineExpectedSet): void {
  if (!Number.isSafeInteger(value.count) || value.count < 0 || !SHA256.test(value.digest)) {
    throw new Error("invalid_adopted_baseline_expected_set");
  }
}

function coverageIdentity(record: AdoptedBaselineCoverageRecord): unknown[] {
  return [
    record.stage,
    record.stageContractVersion,
    record.sessionId,
    record.normalizedContentHash,
  ];
}

function lessonSeedIdentity(record: AdoptedBaselineLessonSeedRecord): unknown[] {
  return [record.lessonId, record.sourceVersionKey, record.normalizedContentHash];
}

export function digestAdoptedBaselineCoverage(
  records: AdoptedBaselineCoverageRecord[],
): string {
  return digest(records.map(coverageIdentity).sort((left, right) => (
    stableStringify(left).localeCompare(stableStringify(right), "en")
  )));
}

export function digestAdoptedBaselineLessonSeeds(
  records: AdoptedBaselineLessonSeedRecord[],
): string {
  return digest(records.map(lessonSeedIdentity).sort((left, right) => (
    stableStringify(left).localeCompare(stableStringify(right), "en")
  )));
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function validateManifestInput(
  input: Omit<AdoptedBaselineManifest, "version" | "state" | "createdAt" | "updatedAt" | "sealedAt">,
): void {
  if (!BASELINE_ID.test(input.id) || !input.sourceRunId.trim() || !input.decisionRef.trim()) {
    throw new Error("invalid_adopted_baseline_manifest");
  }
  if (
    input.retiredRunIds.length === 0
    || new Set(input.retiredRunIds).size !== input.retiredRunIds.length
    || input.retiredRunIds.some((runId) => !runId.trim())
    || !input.retiredRunIds.includes(input.sourceRunId)
  ) {
    throw new Error("invalid_adopted_baseline_retired_runs");
  }
  if (Object.keys(input.expectedCoverage).length !== STAGES.size) {
    throw new Error("invalid_adopted_baseline_stage_set");
  }
  for (const [stage, expected] of Object.entries(input.expectedCoverage)) {
    if (!STAGES.has(stage as AdoptedBaselineStage) || !expected?.stageContractVersion.trim()) {
      throw new Error("invalid_adopted_baseline_stage");
    }
    validateExpectedSet(expected);
  }
  validateExpectedSet(input.expectedLessonSeed);
  if (!sameValue([...input.naturalBoundaryStages].sort(), ["consolidation_procedural", "crystal"])) {
    throw new Error("invalid_adopted_baseline_natural_boundaries");
  }
}

export async function prepareAdoptedBaseline(
  kv: StateKV,
  input: Omit<AdoptedBaselineManifest, "version" | "state" | "createdAt" | "updatedAt" | "sealedAt">,
): Promise<AdoptedBaselineManifest> {
  validateManifestInput(input);
  return withKeyedLock(BASELINE_LOCK_KEY, async () => {
    const active = await kv.get<AdoptedBaselineControl>(
      KV.extractionAdoptedBaselineControl,
      BASELINE_CONTROL_KEY,
    );
    if (active && active.activeBaselineId !== input.id) {
      throw new Error("adopted_baseline_already_active");
    }
    const existing = await kv.get<AdoptedBaselineManifest>(
      KV.extractionAdoptedBaselineManifests,
      input.id,
    );
    if (existing) {
      const immutableExisting = {
        id: existing.id,
        sourceRunId: existing.sourceRunId,
        retiredRunIds: existing.retiredRunIds,
        decisionRef: existing.decisionRef,
        expectedCoverage: existing.expectedCoverage,
        expectedLessonSeed: existing.expectedLessonSeed,
        naturalBoundaryStages: existing.naturalBoundaryStages,
      };
      if (!sameValue(immutableExisting, input)) {
        throw new Error("adopted_baseline_manifest_conflict");
      }
      return existing;
    }
    const now = new Date().toISOString();
    const manifest: AdoptedBaselineManifest = {
      version: 1,
      state: "preparing",
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    await kv.set(KV.extractionAdoptedBaselineManifests, manifest.id, manifest);
    return manifest;
  });
}

async function readPreparingManifest(
  kv: StateKV,
  baselineId: string,
): Promise<AdoptedBaselineManifest> {
  const manifest = await kv.get<AdoptedBaselineManifest>(
    KV.extractionAdoptedBaselineManifests,
    baselineId,
  );
  if (!manifest) throw new Error("adopted_baseline_missing");
  if (manifest.state !== "preparing") throw new Error("adopted_baseline_not_preparing");
  return manifest;
}

export async function appendAdoptedBaselineCoverage(
  kv: StateKV,
  baselineId: string,
  records: AdoptedBaselineCoverageRecord[],
): Promise<{ written: number; existing: number }> {
  if (records.length === 0 || records.length > 100) {
    throw new Error("invalid_adopted_baseline_coverage_batch");
  }
  return withKeyedLock(BASELINE_LOCK_KEY, async () => {
    const manifest = await readPreparingManifest(kv, baselineId);
    const keys = new Set<string>();
    for (const record of records) {
      const expected = manifest.expectedCoverage[record.stage];
      if (
        record.baselineId !== baselineId
        || !expected
        || expected.stageContractVersion !== record.stageContractVersion
        || !record.sessionId.trim()
        || !SHA256.test(record.normalizedContentHash)
        || keys.has(`${record.stage}\0${record.sessionId}`)
      ) {
        throw new Error("invalid_adopted_baseline_coverage_record");
      }
      keys.add(`${record.stage}\0${record.sessionId}`);
    }
    let written = 0;
    let existingCount = 0;
    for (const record of records) {
      const scope = KV.extractionAdoptedBaselineCoverage(baselineId, record.stage);
      const existing = await kv.get<AdoptedBaselineCoverageRecord>(scope, record.sessionId);
      if (existing) {
        if (!sameValue(existing, record)) throw new Error("adopted_baseline_coverage_conflict");
        existingCount += 1;
        continue;
      }
      await kv.set(scope, record.sessionId, record);
      written += 1;
    }
    return { written, existing: existingCount };
  });
}

export async function appendAdoptedBaselineLessonSeeds(
  kv: StateKV,
  baselineId: string,
  records: AdoptedBaselineLessonSeedRecord[],
): Promise<{ written: number; existing: number }> {
  if (records.length === 0 || records.length > 100) {
    throw new Error("invalid_adopted_baseline_lesson_seed_batch");
  }
  return withKeyedLock(BASELINE_LOCK_KEY, async () => {
    await readPreparingManifest(kv, baselineId);
    if (new Set(records.map((record) => record.lessonId)).size !== records.length) {
      throw new Error("invalid_adopted_baseline_lesson_seed_record");
    }
    let written = 0;
    let existingCount = 0;
    const scope = KV.extractionAdoptedBaselineLessonSeeds(baselineId);
    for (const record of records) {
      if (
        record.baselineId !== baselineId
        || !record.lessonId.trim()
        || !record.sourceVersionKey.trim()
        || !SHA256.test(record.normalizedContentHash)
      ) {
        throw new Error("invalid_adopted_baseline_lesson_seed_record");
      }
      const existing = await kv.get<AdoptedBaselineLessonSeedRecord>(scope, record.lessonId);
      if (existing) {
        if (!sameValue(existing, record)) throw new Error("adopted_baseline_lesson_seed_conflict");
        existingCount += 1;
        continue;
      }
      await kv.set(scope, record.lessonId, record);
      written += 1;
    }
    return { written, existing: existingCount };
  });
}

async function validatePreparedBaseline(
  kv: StateKV,
  manifest: AdoptedBaselineManifest,
): Promise<{ lessonSeeds: AdoptedBaselineLessonSeedRecord[] }> {
  for (const [stageName, expected] of Object.entries(manifest.expectedCoverage)) {
    const stage = stageName as AdoptedBaselineStage;
    const records = (await kv.list<AdoptedBaselineCoverageRecord>(
      KV.extractionAdoptedBaselineCoverage(manifest.id, stage),
    )).filter((record) => record.baselineId === manifest.id && record.stage === stage);
    if (records.length !== expected.count || digestAdoptedBaselineCoverage(records) !== expected.digest) {
      throw new Error(`adopted_baseline_coverage_mismatch:${stage}`);
    }
  }
  const lessonSeeds = (await kv.list<AdoptedBaselineLessonSeedRecord>(
    KV.extractionAdoptedBaselineLessonSeeds(manifest.id),
  )).filter((record) => record.baselineId === manifest.id);
  if (
    lessonSeeds.length !== manifest.expectedLessonSeed.count
    || digestAdoptedBaselineLessonSeeds(lessonSeeds) !== manifest.expectedLessonSeed.digest
  ) {
    throw new Error("adopted_baseline_lesson_seed_mismatch");
  }
  return { lessonSeeds };
}

export async function sealAdoptedBaseline(
  kv: StateKV,
  baselineId: string,
  materializeLessonSeeds: (records: AdoptedBaselineLessonSeedRecord[]) => Promise<void>,
): Promise<AdoptedBaselineManifest> {
  return withKeyedLock(BASELINE_LOCK_KEY, async () => {
    const existing = await kv.get<AdoptedBaselineManifest>(
      KV.extractionAdoptedBaselineManifests,
      baselineId,
    );
    if (!existing) throw new Error("adopted_baseline_missing");
    const active = await kv.get<AdoptedBaselineControl>(
      KV.extractionAdoptedBaselineControl,
      BASELINE_CONTROL_KEY,
    );
    if (existing.state === "sealed") {
      if (active?.activeBaselineId === baselineId) return existing;
      if (active) throw new Error("adopted_baseline_already_active");
      const now = new Date().toISOString();
      await kv.set<AdoptedBaselineControl>(KV.extractionAdoptedBaselineControl, BASELINE_CONTROL_KEY, {
        activeBaselineId: baselineId,
        updatedAt: now,
      });
      return existing;
    }
    if (active && active.activeBaselineId !== baselineId) {
      throw new Error("adopted_baseline_already_active");
    }
    const validated = await validatePreparedBaseline(kv, existing);
    await materializeLessonSeeds(validated.lessonSeeds);
    const now = new Date().toISOString();
    const sealed: AdoptedBaselineManifest = {
      ...existing,
      state: "sealed",
      updatedAt: now,
      sealedAt: now,
    };
    await kv.set(KV.extractionAdoptedBaselineManifests, baselineId, sealed);
    await kv.set<AdoptedBaselineControl>(KV.extractionAdoptedBaselineControl, BASELINE_CONTROL_KEY, {
      activeBaselineId: baselineId,
      updatedAt: now,
    });
    return sealed;
  });
}

export async function readActiveAdoptedBaseline(
  kv: StateKV,
): Promise<AdoptedBaselineManifest | null> {
  const control = await kv.get<AdoptedBaselineControl>(
    KV.extractionAdoptedBaselineControl,
    BASELINE_CONTROL_KEY,
  );
  if (!control) return null;
  const manifest = await kv.get<AdoptedBaselineManifest>(
    KV.extractionAdoptedBaselineManifests,
    control.activeBaselineId,
  );
  if (!manifest || manifest.state !== "sealed") {
    throw new Error("adopted_baseline_control_drift");
  }
  return manifest;
}

export async function partitionAdoptedBaselineSessions(
  kv: StateKV,
  input: {
    stage: AdoptedBaselineStage;
    stageContractVersion: string;
    sessionIds: string[];
  },
): Promise<{
  baselineId: string | null;
  adoptedSessionIds: string[];
  openSessionIds: string[];
}> {
  if (
    !STAGES.has(input.stage)
    || !input.stageContractVersion.trim()
    || input.sessionIds.length > 10_000
    || input.sessionIds.some((sessionId) => !sessionId.trim())
    || new Set(input.sessionIds).size !== input.sessionIds.length
  ) {
    throw new Error("invalid_adopted_baseline_partition_request");
  }
  const manifest = await readActiveAdoptedBaseline(kv);
  const expected = manifest?.expectedCoverage[input.stage];
  if (!manifest || !expected) {
    return { baselineId: manifest?.id ?? null, adoptedSessionIds: [], openSessionIds: input.sessionIds };
  }
  if (expected.stageContractVersion !== input.stageContractVersion) {
    throw new Error("adopted_baseline_contract_migration_required");
  }
  const scope = KV.extractionAdoptedBaselineCoverage(manifest.id, input.stage);
  const records = await mapWithConcurrency(
    input.sessionIds,
    PARTITION_READ_CONCURRENCY,
    (sessionId) => kv.get<AdoptedBaselineCoverageRecord>(scope, sessionId),
  );
  const adoptedSessionIds: string[] = [];
  const openSessionIds: string[] = [];
  for (let index = 0; index < input.sessionIds.length; index += 1) {
    const sessionId = input.sessionIds[index];
    const record = records[index];
    if (!record) {
      openSessionIds.push(sessionId);
      continue;
    }
    if (
      record.baselineId !== manifest.id
      || record.stage !== input.stage
      || record.stageContractVersion !== input.stageContractVersion
      || record.sessionId !== sessionId
      || !SHA256.test(record.normalizedContentHash)
    ) {
      throw new Error("adopted_baseline_coverage_drift");
    }
    adoptedSessionIds.push(sessionId);
  }
  return { baselineId: manifest.id, adoptedSessionIds, openSessionIds };
}

export async function inspectAdoptedBaselineRun(
  kv: StateKV,
  runId: string,
): Promise<{ baselineId: string | null; retired: boolean }> {
  if (!runId.trim()) throw new Error("invalid_adopted_baseline_run_id");
  const manifest = await readActiveAdoptedBaseline(kv);
  return {
    baselineId: manifest?.id ?? null,
    retired: manifest?.retiredRunIds.includes(runId) ?? false,
  };
}
