import { createHash } from "node:crypto";
import type {
  ContributionEffectRef,
  ContributionHead,
  ContributionRecord,
  ExtractionOperationStage,
  StageContractVersion,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export type ClaimBatchResult =
  | { status: "claimed"; records: ContributionRecord[] }
  | { status: "already_committed"; records: ContributionRecord[] }
  | { status: "claimed_by_other"; records: ContributionRecord[] }
  | { status: "contract_migration_required"; records: ContributionRecord[] }
  | { status: "source_correction_requires_migration"; records: ContributionRecord[]; corrections: SourceContributionCandidate[] }
  | { status: "contribution_reconciliation_required"; records: ContributionRecord[]; candidates: SourceContributionCandidate[] };
export type SourceContributionCandidate = {
  sourceVersionKey: string;
  stableSourceId: string;
  state: "eligible" | "terminal" | "claimed" | "source_correction_requires_migration" | "contribution_reconciliation_required";
  reason?: string;
};

export function parseSourceVersionKey(sourceVersionKey: string): {
  stage: string; sourceType: string; stableSourceId: string; normalizedContentHash: string;
} {
  const parts = sourceVersionKey.split("|");
  if (parts.length !== 4 || !parts[0] || !/^[a-z_][a-z0-9_]{0,63}$/.test(parts[1])
    || !parts[2] || !/^[0-9a-f]{64}$/.test(parts[3])) throw new Error("invalid_source_version");
  return { stage: parts[0], sourceType: parts[1], stableSourceId: decodeURIComponent(parts[2]), normalizedContentHash: parts[3] };
}
function sourceHeadKey(sourceVersionKey: string): string {
  const parsed = parseSourceVersionKey(sourceVersionKey);
  return `${parsed.sourceType}|${encodeURIComponent(parsed.stableSourceId)}`;
}

export function buildSourceVersionKey(
  stage: ExtractionOperationStage,
  sourceType: string,
  stableSourceId: string,
  normalizedContentHash: string,
): string {
  if (!/^[a-z_][a-z0-9_]{0,63}$/.test(sourceType)) {
    throw new Error("invalid_source_type");
  }
  if (!stableSourceId || !/^[0-9a-f]{64}$/.test(normalizedContentHash)) {
    throw new Error("invalid_source_version");
  }
  return `${stage}|${sourceType}|${encodeURIComponent(stableSourceId)}|${normalizedContentHash}`;
}

function contributionId(
  stage: ExtractionOperationStage,
  contractVersion: string,
  runId: string,
  unitId: string,
  sourceVersionKeys: string[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([stage, contractVersion, runId, unitId, sourceVersionKeys]))
    .digest("hex");
  return `ctr_${digest.slice(0, 32)}`;
}

async function waitForWrites(writes: Array<Promise<unknown>>): Promise<void> {
  const settled = await Promise.allSettled(writes);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
}

function sameEffectRefs(
  left: ContributionEffectRef[] | undefined,
  right: ContributionEffectRef[],
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

function isTerminal(record: ContributionRecord | null | undefined): record is ContributionRecord {
  return record?.state === "committed" || record?.state === "no_effect";
}

function isStrictTerminalRecord(record: ContributionRecord): boolean {
  if (!record.operationReceiptRef?.scope || !record.operationReceiptRef.key) return false;
  if (record.state === "committed") {
    return Array.isArray(record.effectRefs)
      && record.effectRefs.some((effectRef) => Boolean(effectRef.scope && effectRef.key));
  }
  return Array.isArray(record.effectRefs)
    && record.effectRefs.length === 0
    && record.noEffectProof?.kind === "strict_legal_empty"
    && record.noEffectProof.receiptKey === record.operationReceiptRef.key
    && Boolean(record.noEffectProof.reasonCode);
}

function headMatchesRecord(head: ContributionHead, record: ContributionRecord): boolean {
  return head.sourceVersionKey === record.sourceVersionKey
    && head.contributionId === record.contributionId
    && head.state === record.state;
}

function recordMatchesScope(
  record: ContributionRecord,
  stage: ExtractionOperationStage,
  stageContractVersion: string,
  sourceVersionKey: string,
): boolean {
  return record.stage === stage
    && record.stageContractVersion === stageContractVersion
    && record.sourceVersionKey === sourceVersionKey;
}

function isClaimedHeadTerminalRecovery(head: ContributionHead, record: ContributionRecord): boolean {
  return head.sourceVersionKey === record.sourceVersionKey
    && head.contributionId === record.contributionId
    && head.state === "claimed"
    && isStrictTerminalRecord(record);
}

function reconciliationCandidate(sourceVersionKey: string, reason: string): SourceContributionCandidate {
  return {
    sourceVersionKey,
    stableSourceId: parseSourceVersionKey(sourceVersionKey).stableSourceId,
    state: "contribution_reconciliation_required",
    reason,
  };
}

async function activeContract(
  kv: StateKV,
  stage: ExtractionOperationStage,
): Promise<StageContractVersion | null> {
  return kv.get<StageContractVersion>(KV.extractionContributionContract(stage), "active");
}

export async function inspectContributionCandidates(
  kv: StateKV,
  input: { stage: ExtractionOperationStage; stageContractVersion: string; sourceVersionKeys: string[] },
): Promise<SourceContributionCandidate[]> {
  const scope = KV.extractionContributionRecords(input.stage, input.stageContractVersion);
  const headScope = KV.extractionContributionHeads(input.stage, input.stageContractVersion);
  return Promise.all(input.sourceVersionKeys.map(async (sourceVersionKey) => {
    const parsed = parseSourceVersionKey(sourceVersionKey);
    if (parsed.stage !== input.stage) throw new Error("invalid_contribution_source_stage");
    const [record, head] = await Promise.all([
      kv.get<ContributionRecord>(scope, sourceVersionKey),
      kv.get<ContributionHead>(headScope, sourceHeadKey(sourceVersionKey)),
    ]);
    if (record && !recordMatchesScope(record, input.stage, input.stageContractVersion, sourceVersionKey)) {
      return reconciliationCandidate(sourceVersionKey, "record_scope_drift");
    }
    if (head) {
      const pointed = await kv.get<ContributionRecord>(scope, head.sourceVersionKey);
      if (!pointed
        || !recordMatchesScope(pointed, input.stage, input.stageContractVersion, head.sourceVersionKey)
        || !headMatchesRecord(head, pointed)) {
        return reconciliationCandidate(sourceVersionKey, "head_record_drift");
      }
      if (head.sourceVersionKey !== sourceVersionKey) {
        return { sourceVersionKey, stableSourceId: parsed.stableSourceId,
          state: isTerminal(pointed) && isStrictTerminalRecord(pointed)
            ? "source_correction_requires_migration"
            : "contribution_reconciliation_required",
          reason: isTerminal(pointed) ? "terminal_source_version_changed" : "prior_source_version_claimed" };
      }
      if (!record || !headMatchesRecord(head, record)) {
        return reconciliationCandidate(sourceVersionKey, "head_record_drift");
      }
    }
    if (record && isTerminal(record) && isStrictTerminalRecord(record)) {
      return { sourceVersionKey, stableSourceId: parsed.stableSourceId, state: "terminal" };
    }
    if (record && isTerminal(record)) return reconciliationCandidate(sourceVersionKey, "terminal_record_incomplete");
    return { sourceVersionKey, stableSourceId: parsed.stableSourceId, state: record ? "claimed" : "eligible" };
  }));
}

export async function claimBatch(
  kv: StateKV,
  input: {
    stage: ExtractionOperationStage;
    stageContractVersion: string;
    runId: string;
    unitId: string;
    sourceVersionKeys: string[];
  },
): Promise<ClaimBatchResult> {
  const sourceVersionKeys = [...new Set(input.sourceVersionKeys)].sort();
  if (
    !input.stageContractVersion
    || !input.runId
    || !input.unitId
    || sourceVersionKeys.length === 0
    || sourceVersionKeys.length !== input.sourceVersionKeys.length
  ) {
    throw new Error("invalid_contribution_claim_batch");
  }
  if (sourceVersionKeys.some((key) => parseSourceVersionKey(key).stage !== input.stage)) {
    throw new Error("invalid_contribution_source_stage");
  }
  const id = contributionId(
    input.stage,
    input.stageContractVersion,
    input.runId,
    input.unitId,
    sourceVersionKeys,
  );
  const scope = KV.extractionContributionRecords(input.stage, input.stageContractVersion);
  const headScope = KV.extractionContributionHeads(input.stage, input.stageContractVersion);
  return withKeyedLock(`extraction-contribution:${input.stage}`, async () => {
    const contract = await activeContract(kv, input.stage);
    if (contract && contract.version !== input.stageContractVersion) {
      return { status: "contract_migration_required", records: [] };
    }
    const records = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionRecord>(scope, sourceVersionKey),
    ));
    const presentRecords = records.filter(
      (record): record is ContributionRecord => Boolean(record),
    );
    const scopeDrift = records.flatMap((record, index) => record
      && !recordMatchesScope(record, input.stage, input.stageContractVersion, sourceVersionKeys[index])
      ? [reconciliationCandidate(sourceVersionKeys[index], "record_scope_drift")]
      : []);
    if (scopeDrift.length > 0) {
      return { status: "contribution_reconciliation_required", records: presentRecords, candidates: scopeDrift };
    }
    const heads = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionHead>(headScope, sourceHeadKey(sourceVersionKey)),
    ));
    const pointed = await Promise.all(heads.map((head) => head
      ? kv.get<ContributionRecord>(scope, head.sourceVersionKey)
      : Promise.resolve(null),
    ));
    const reconciliation = heads.flatMap((head, index) => {
      if (!head) return [];
      const pointedRecord = pointed[index];
      const record = records[index];
      if (!pointedRecord
        || !recordMatchesScope(pointedRecord, input.stage, input.stageContractVersion, head.sourceVersionKey)
        || !headMatchesRecord(head, pointedRecord)) {
        return [reconciliationCandidate(sourceVersionKeys[index], "head_record_drift")];
      }
      if (head.sourceVersionKey === sourceVersionKeys[index]
        && (!record || !headMatchesRecord(head, record))) {
        return [reconciliationCandidate(sourceVersionKeys[index], "head_record_drift")];
      }
      if (head.sourceVersionKey !== sourceVersionKeys[index]
        && (!isTerminal(pointedRecord) || !isStrictTerminalRecord(pointedRecord))) {
        return [reconciliationCandidate(sourceVersionKeys[index], "prior_source_version_claimed")];
      }
      return [];
    });
    if (reconciliation.length > 0) {
      return { status: "contribution_reconciliation_required", records: presentRecords, candidates: reconciliation };
    }
    const corrections = heads.flatMap((head, index) => head
      && head.sourceVersionKey !== sourceVersionKeys[index]
      && isTerminal(pointed[index])
      && isStrictTerminalRecord(pointed[index]!)
      ? [{ sourceVersionKey: sourceVersionKeys[index], stableSourceId: parseSourceVersionKey(sourceVersionKeys[index]).stableSourceId,
        state: "source_correction_requires_migration" as const, reason: "terminal_source_version_changed" }]
      : []);
    if (corrections.length > 0) {
      return {
        status: "source_correction_requires_migration",
        records: presentRecords,
        corrections,
      };
    }
    const terminalRecords = presentRecords.filter(
      (record) => isTerminal(record),
    );
    if (terminalRecords.length > 0) {
      if (terminalRecords.length !== sourceVersionKeys.length) {
        return { status: "claimed_by_other", records: presentRecords };
      }
      if (!terminalRecords.every(isStrictTerminalRecord)) {
        return {
          status: "contribution_reconciliation_required",
          records: presentRecords,
          candidates: sourceVersionKeys.map((sourceVersionKey) => reconciliationCandidate(sourceVersionKey, "terminal_record_incomplete")),
        };
      }
      const now = new Date().toISOString();
      await waitForWrites(terminalRecords.map((record, index) => heads[index]
        ? Promise.resolve()
        : kv.set(headScope, sourceHeadKey(record.sourceVersionKey), {
          sourceVersionKey: record.sourceVersionKey,
          state: record.state,
          contributionId: record.contributionId,
          updatedAt: now,
        } satisfies ContributionHead)));
      return { status: "already_committed", records: presentRecords };
    }
    if (presentRecords.some((record) => record.state !== "claimed" || record.contributionId !== id)) {
      return { status: "claimed_by_other", records: presentRecords };
    }
    const now = new Date().toISOString();
    const nextRecords = records.map((record, index) => record ?? {
      stage: input.stage,
      stageContractVersion: input.stageContractVersion,
      sourceVersionKey: sourceVersionKeys[index],
      state: "claimed" as const,
      contributionId: id,
      runId: input.runId,
      unitId: input.unitId,
      claimedAt: now,
    });
    if (!contract) {
      await kv.set(KV.extractionContributionContract(input.stage), "active", {
        stage: input.stage,
        version: input.stageContractVersion,
        activatedAt: now,
      });
    }
    await waitForWrites(nextRecords.map((record) =>
      kv.set(scope, record.sourceVersionKey, record),
    ));
    await waitForWrites(nextRecords.map((record) => kv.set(headScope, sourceHeadKey(record.sourceVersionKey), {
      sourceVersionKey: record.sourceVersionKey,
      state: record.state,
      contributionId: record.contributionId,
      updatedAt: now,
    } satisfies ContributionHead)));
    return { status: "claimed", records: nextRecords };
  });
}

export async function commitClaimedBatch(
  kv: StateKV,
  input: {
    stage: ExtractionOperationStage;
    stageContractVersion: string;
    contributionId: string;
    sourceVersionKeys: string[];
    operationReceiptRef: ContributionEffectRef;
    effectRefs: ContributionEffectRef[];
  },
): Promise<ContributionRecord[]> {
  const sourceVersionKeys = [...new Set(input.sourceVersionKeys)].sort();
  const scope = KV.extractionContributionRecords(input.stage, input.stageContractVersion);
  const headScope = KV.extractionContributionHeads(input.stage, input.stageContractVersion);
  return withKeyedLock(`extraction-contribution:${input.stage}`, async () => {
    const records = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionRecord>(scope, sourceVersionKey),
    ));
    if (records.some((record) => !record)) throw new Error("contribution_record_missing");
    const existing = records as ContributionRecord[];
    if (existing.some((record, index) =>
      !recordMatchesScope(record, input.stage, input.stageContractVersion, sourceVersionKeys[index])
    )) throw new Error("contribution_record_scope_conflict");
    const heads = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionHead>(headScope, sourceHeadKey(sourceVersionKey)),
    ));
    if (existing.some((record) => record.contributionId !== input.contributionId)) {
      throw new Error("contribution_claim_conflict");
    }
    if (existing.some((record) => record.state === "no_effect")) {
      throw new Error("contribution_terminal_state_conflict");
    }
    const committed = existing.filter((record) => record.state === "committed");
    if (committed.some((record) =>
      record.operationReceiptRef?.scope !== input.operationReceiptRef.scope
      || record.operationReceiptRef?.key !== input.operationReceiptRef.key
      || !sameEffectRefs(record.effectRefs, input.effectRefs)
    )) {
      throw new Error("contribution_effect_reference_conflict");
    }
    if (existing.some((record) => record.state !== "claimed" && record.state !== "committed")) {
      throw new Error("contribution_terminal_state_conflict");
    }
    if (!input.operationReceiptRef.scope || !input.operationReceiptRef.key
      || !input.effectRefs.some((effectRef) => effectRef.scope && effectRef.key)) {
      throw new Error("invalid_contribution_effect_references");
    }
    const committedAt = new Date().toISOString();
    const pending = existing.filter((record) => record.state === "claimed").map((record) => ({
      ...record,
      state: "committed" as const,
      committedAt,
      operationReceiptRef: input.operationReceiptRef,
      effectRefs: input.effectRefs,
    }));
    const finalRecords = existing.map((record) => record.state === "committed"
      ? record
      : pending.find((next) => next.sourceVersionKey === record.sourceVersionKey)!);
    if (heads.some((head, index) => head
      && !headMatchesRecord(head, existing[index])
      && !isClaimedHeadTerminalRecovery(head, existing[index]))) {
      throw new Error("contribution_head_conflict");
    }
    await waitForWrites(pending.map((record) =>
      kv.set(scope, record.sourceVersionKey, record),
    ));
    await waitForWrites(finalRecords.map((record) => kv.set(headScope, sourceHeadKey(record.sourceVersionKey), {
      sourceVersionKey: record.sourceVersionKey, state: record.state,
      contributionId: record.contributionId, updatedAt: committedAt,
    } satisfies ContributionHead)));
    return finalRecords;
  });
}

export async function markClaimedBatchNoEffect(
  kv: StateKV,
  input: {
    stage: ExtractionOperationStage;
    stageContractVersion: string;
    contributionId: string;
    sourceVersionKeys: string[];
    operationReceiptRef: ContributionEffectRef;
    receiptKey: string;
    reasonCode: string;
  },
): Promise<ContributionRecord[]> {
  const sourceVersionKeys = [...new Set(input.sourceVersionKeys)].sort();
  const scope = KV.extractionContributionRecords(input.stage, input.stageContractVersion);
  const headScope = KV.extractionContributionHeads(input.stage, input.stageContractVersion);
  return withKeyedLock(`extraction-contribution:${input.stage}`, async () => {
    const records = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionRecord>(scope, sourceVersionKey),
    ));
    if (records.some((record) => !record)) throw new Error("contribution_record_missing");
    const existing = records as ContributionRecord[];
    if (existing.some((record, index) =>
      !recordMatchesScope(record, input.stage, input.stageContractVersion, sourceVersionKeys[index])
    )) throw new Error("contribution_record_scope_conflict");
    const heads = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionHead>(headScope, sourceHeadKey(sourceVersionKey)),
    ));
    if (existing.some((record) => record.contributionId !== input.contributionId)) {
      throw new Error("contribution_claim_conflict");
    }
    if (existing.some((record) => record.state === "committed")) {
      throw new Error("contribution_terminal_state_conflict");
    }
    const noEffectProof = {
      kind: "strict_legal_empty" as const,
      receiptKey: input.receiptKey,
      reasonCode: input.reasonCode,
    };
    if (!input.operationReceiptRef.scope || !input.operationReceiptRef.key
      || !input.receiptKey || input.receiptKey !== input.operationReceiptRef.key || !input.reasonCode) {
      throw new Error("invalid_no_effect_proof");
    }
    const alreadyFinal = existing.filter((record) => record.state === "no_effect");
    if (alreadyFinal.some((record) =>
      record.operationReceiptRef?.scope !== input.operationReceiptRef.scope
      || record.operationReceiptRef?.key !== input.operationReceiptRef.key
      || JSON.stringify(record.noEffectProof) !== JSON.stringify(noEffectProof)
      || !isStrictTerminalRecord(record)
    )) {
      throw new Error("contribution_effect_reference_conflict");
    }
    const committedAt = new Date().toISOString();
    const pending = existing.filter((record) => record.state === "claimed").map((record) => ({
      ...record,
      state: "no_effect" as const,
      committedAt,
      operationReceiptRef: input.operationReceiptRef,
      effectRefs: [],
      noEffectProof,
    }));
    const finalRecords = existing.map((record) => record.state === "no_effect"
      ? record
      : pending.find((next) => next.sourceVersionKey === record.sourceVersionKey)!);
    if (heads.some((head, index) => head
      && !headMatchesRecord(head, existing[index])
      && !isClaimedHeadTerminalRecovery(head, existing[index]))) {
      throw new Error("contribution_head_conflict");
    }
    await waitForWrites(pending.map((record) =>
      kv.set(scope, record.sourceVersionKey, record),
    ));
    await waitForWrites(finalRecords.map((record) => kv.set(headScope, sourceHeadKey(record.sourceVersionKey), {
      sourceVersionKey: record.sourceVersionKey, state: record.state,
      contributionId: record.contributionId, updatedAt: committedAt,
    } satisfies ContributionHead)));
    return finalRecords;
  });
}

export async function releaseClaimedBatch(
  kv: StateKV,
  input: {
    stage: ExtractionOperationStage;
    stageContractVersion: string;
    contributionId: string;
    sourceVersionKeys: string[];
  },
): Promise<void> {
  const sourceVersionKeys = [...new Set(input.sourceVersionKeys)].sort();
  const scope = KV.extractionContributionRecords(input.stage, input.stageContractVersion);
  const headScope = KV.extractionContributionHeads(input.stage, input.stageContractVersion);
  await withKeyedLock(`extraction-contribution:${input.stage}`, async () => {
    const records = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionRecord>(scope, sourceVersionKey),
    ));
    const heads = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      kv.get<ContributionHead>(headScope, sourceHeadKey(sourceVersionKey)),
    ));
    if (records.some((record, index) => record
      && !recordMatchesScope(record, input.stage, input.stageContractVersion, sourceVersionKeys[index])
    )) throw new Error("contribution_record_scope_conflict");
    if (records.some((record) => record
      && (record.state !== "claimed" || record.contributionId !== input.contributionId)
    )) {
      throw new Error("contribution_claim_conflict");
    }
    if (heads.some((head, index) => head && (
      head.sourceVersionKey !== sourceVersionKeys[index]
      || head.contributionId !== input.contributionId
      || head.state !== "claimed"
    ))) throw new Error("contribution_head_conflict");
    await waitForWrites(sourceVersionKeys.map((sourceVersionKey, index) =>
      records[index] ? kv.delete(scope, sourceVersionKey) : Promise.resolve(),
    ));
    await waitForWrites(sourceVersionKeys.map((sourceVersionKey, index) =>
      heads[index] ? kv.delete(headScope, sourceHeadKey(sourceVersionKey)) : Promise.resolve(),
    ));
  });
}
