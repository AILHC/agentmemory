import { describe, expect, it } from "vitest";
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  inspectContributionCandidates,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
} from "../src/functions/extraction-contributions.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const gets: Array<{ scope: string; key: string }> = [];
  const sets: Array<{ scope: string; key: string }> = [];
  return {
    store,
    gets,
    sets,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      gets.push({ scope, key });
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      sets.push({ scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<boolean> =>
      store.get(scope)?.delete(key) ?? false,
  };
}

describe("extraction contributions", () => {
  const sourceA = buildSourceVersionKey("summary", "session", "session-a", "a".repeat(64));
  const sourceB = buildSourceVersionKey("summary", "session", "session-b", "b".repeat(64));

  it("serializes an entire batch and excludes a competing run in the same worker", async () => {
    const kv = mockKV();
    const [first, second] = await Promise.all([
      claimBatch(kv as any, {
        stage: "summary",
        stageContractVersion: "summary/v1",
        runId: "run-a",
        unitId: "unit-a",
        sourceVersionKeys: [sourceA, sourceB],
      }),
      claimBatch(kv as any, {
        stage: "summary",
        stageContractVersion: "summary/v1",
        runId: "run-b",
        unitId: "unit-b",
        sourceVersionKeys: [sourceA, sourceB],
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["claimed", "claimed_by_other"]);
    const winner = first.status === "claimed" ? first : second;
    expect(winner.records).toHaveLength(2);
    expect(winner.records.every((record) => record.state === "claimed")).toBe(true);
    expect(winner.records.every((record) => !record.sourceVersionKey.includes("run-"))).toBe(true);

    const contract = await kv.get<any>(KV.extractionContributionContract("summary"), "active");
    expect(contract).toMatchObject({
      stage: "summary",
      version: "summary/v1",
    });
  });

  it("commits only a matching claim and records effect and receipt references", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      runId: "run-a",
      unitId: "unit-a",
      sourceVersionKeys: [sourceA],
    });
    expect(claim.status).toBe("claimed");
    const [record] = await commitClaimedBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      contributionId: claim.records[0].contributionId,
      sourceVersionKeys: [sourceA],
      operationReceiptRef: { scope: "receipts", key: "receipt-a" },
      effectRefs: [{ scope: "summaries", key: "session-a", effectHash: "c".repeat(64) }],
    });
    expect(record).toMatchObject({
      state: "committed",
      operationReceiptRef: { scope: "receipts", key: "receipt-a" },
      effectRefs: [{ scope: "summaries", key: "session-a", effectHash: "c".repeat(64) }],
    });
  });

  it("keeps a persisted active contract and closes a migration without reopening sources", async () => {
    const kv = mockKV();
    const first = await claimBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      runId: "run-a",
      unitId: "unit-a",
      sourceVersionKeys: [sourceA],
    });
    const second = await claimBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v2",
      runId: "run-b",
      unitId: "unit-b",
      sourceVersionKeys: [sourceA],
    });
    expect(first.status).toBe("claimed");
    expect(second.status).toBe("contract_migration_required");
  });

  it("reads and writes only the claimed batch, not unrelated contribution history", async () => {
    const kv = mockKV();
    const historyScope = KV.extractionContributionRecords("summary", "summary/v1");
    for (let index = 0; index < 10_000; index++) {
      await kv.set(historyScope, `historical-${index}`, { state: "committed" });
    }
    await kv.set(KV.extractionContributionContract("summary"), "active", {
      stage: "summary",
      version: "summary/v1",
      activatedAt: "2026-01-01T00:00:00.000Z",
    });
    kv.gets.length = 0;
    kv.sets.length = 0;
    await claimBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      runId: "run-next",
      unitId: "unit-next",
      sourceVersionKeys: [sourceA, sourceB],
    });
    expect(kv.gets).toHaveLength(5);
    expect(kv.gets.filter((entry) => entry.scope === historyScope)).toHaveLength(2);
    expect(kv.sets.filter((entry) => entry.scope === historyScope).map((entry) => entry.key).sort()).toEqual([sourceA, sourceB].sort());
  });

  it("allows the original partially persisted claim to complete after a write failure", async () => {
    const kv = mockKV();
    const originalSet = kv.set;
    let failSecondRecordWrite = true;
    let recordWrites = 0;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.extractionContributionRecords("summary", "summary/v1")) {
        recordWrites += 1;
        if (failSecondRecordWrite && recordWrites === 2) {
          throw new Error("injected_contribution_write_failure");
        }
      }
      return originalSet(scope, key, value);
    };
    const originalClaim = {
      stage: "summary" as const,
      stageContractVersion: "summary/v1",
      runId: "run-original",
      unitId: "unit-original",
      sourceVersionKeys: [sourceA, sourceB],
    };
    let providerCalls = 0;
    await expect(claimBatch(kv as any, originalClaim)).rejects.toThrow(
      "injected_contribution_write_failure",
    );
    failSecondRecordWrite = false;
    recordWrites = 0;
    const completed = await claimBatch(kv as any, originalClaim);
    if (completed.status === "claimed") providerCalls += 1;
    const competing = await claimBatch(kv as any, {
      ...originalClaim,
      runId: "run-competing",
      unitId: "unit-competing",
    });
    expect(completed.status).toBe("claimed");
    expect(completed.records).toHaveLength(2);
    expect(competing.status).toBe("claimed_by_other");
    expect(providerCalls).toBe(1);
  });

  it("waits for a delayed partial claim write before allowing a competing claim", async () => {
    const kv = mockKV();
    const originalSet = kv.set;
    let firstRecordWrite = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.extractionContributionRecords("summary", "summary/v1")) {
        if (firstRecordWrite) {
          firstRecordWrite = false;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return originalSet(scope, key, value);
        }
        throw new Error("injected_second_claim_write_failure");
      }
      return originalSet(scope, key, value);
    };
    const batch = {
      stage: "summary" as const,
      stageContractVersion: "summary/v1",
      unitId: "unit-a",
      sourceVersionKeys: [sourceA, sourceB],
    };
    const original = claimBatch(kv as any, { ...batch, runId: "run-a" });
    const competing = claimBatch(kv as any, { ...batch, runId: "run-b" });
    await expect(original).rejects.toThrow("injected_second_claim_write_failure");
    await expect(competing).resolves.toMatchObject({ status: "claimed_by_other" });
  });

  it("recovers a commit when the second terminal record write fails", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      runId: "run-a",
      unitId: "unit-a",
      sourceVersionKeys: [sourceA, sourceB],
    });
    const originalSet = kv.set;
    let writes = 0;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.extractionContributionRecords("summary", "summary/v1") && ++writes === 2) {
        throw new Error("injected_second_commit_write_failure");
      }
      return originalSet(scope, key, value);
    };
    const commit = {
      stage: "summary" as const,
      stageContractVersion: "summary/v1",
      contributionId: claim.records[0].contributionId,
      sourceVersionKeys: [sourceA, sourceB],
      operationReceiptRef: { scope: "receipts", key: "receipt-a" },
      effectRefs: [{ scope: "summaries", key: "session-a", effectHash: "c".repeat(64) }],
    };
    await expect(commitClaimedBatch(kv as any, commit)).rejects.toThrow("injected_second_commit_write_failure");
    expect((await claimBatch(kv as any, {
      stage: "summary",
      stageContractVersion: "summary/v1",
      runId: "run-b",
      unitId: "unit-b",
      sourceVersionKeys: [sourceA, sourceB],
    })).status).toBe("contribution_reconciliation_required");
    kv.set = originalSet;
    await expect(commitClaimedBatch(kv as any, commit)).resolves.toHaveLength(2);
  });

  it("recovers no-effect when the second terminal record write fails", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA, sourceB] });
    const originalSet = kv.set;
    let writes = 0;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.extractionContributionRecords("summary", "summary/v1") && ++writes === 2) throw new Error("injected_second_no_effect_record_failure");
      return originalSet(scope, key, value);
    };
    const input = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA, sourceB], operationReceiptRef: { scope: "receipt", key: "r" }, receiptKey: "r", reasonCode: "empty" };
    await expect(markClaimedBatchNoEffect(kv as any, input)).rejects.toThrow("injected_second_no_effect_record_failure");
    kv.set = originalSet;
    await expect(markClaimedBatchNoEffect(kv as any, input)).resolves.toHaveLength(2);
  });

  it("recovers a commit when the second terminal head write fails", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA, sourceB] });
    const originalSet = kv.set;
    let writes = 0;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.extractionContributionHeads("summary", "summary/v1") && ++writes === 2) throw new Error("injected_second_commit_head_failure");
      return originalSet(scope, key, value);
    };
    const input = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA, sourceB], operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "a" }] };
    await expect(commitClaimedBatch(kv as any, input)).rejects.toThrow("injected_second_commit_head_failure");
    kv.set = originalSet;
    await expect(commitClaimedBatch(kv as any, input)).resolves.toHaveLength(2);
  });

  it("recovers no-effect when the second terminal head write fails", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA, sourceB] });
    const originalSet = kv.set;
    let writes = 0;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.extractionContributionHeads("summary", "summary/v1") && ++writes === 2) throw new Error("injected_second_no_effect_head_failure");
      return originalSet(scope, key, value);
    };
    const input = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA, sourceB], operationReceiptRef: { scope: "receipt", key: "r" }, receiptKey: "r", reasonCode: "empty" };
    await expect(markClaimedBatchNoEffect(kv as any, input)).rejects.toThrow("injected_second_no_effect_head_failure");
    kv.set = originalSet;
    await expect(markClaimedBatchNoEffect(kv as any, input)).resolves.toHaveLength(2);
  });

  it("backfills an exact missing head on terminal commit re-entry", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    const input = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "a" }] };
    await commitClaimedBatch(kv as any, input);
    const headScope = KV.extractionContributionHeads("summary", "summary/v1");
    await kv.delete(headScope, "session|session-a");
    await expect(commitClaimedBatch(kv as any, input)).resolves.toHaveLength(1);
    expect(await kv.get(headScope, "session|session-a")).toMatchObject({ state: "committed" });
  });

  it("marks a terminal record without a head as terminal and strictly backfills it", async () => {
    const kv = mockKV();
    const original = { stage: "summary" as const, stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] };
    const claim = await claimBatch(kv as any, original);
    await commitClaimedBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "a" }] });
    const headScope = KV.extractionContributionHeads("summary", "summary/v1");
    await kv.delete(headScope, "session|session-a");
    expect((await inspectContributionCandidates(kv as any, { stage: "summary", stageContractVersion: "summary/v1", sourceVersionKeys: [sourceA] }))[0].state).toBe("terminal");
    await expect(claimBatch(kv as any, original)).resolves.toMatchObject({ status: "already_committed" });
    expect(await kv.get(headScope, "session|session-a")).toMatchObject({ state: "committed" });
  });

  it("requires reconciliation for incomplete terminal records without heads", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA, sourceB] });
    const recordsScope = KV.extractionContributionRecords("summary", "summary/v1");
    const headsScope = KV.extractionContributionHeads("summary", "summary/v1");
    await kv.set(recordsScope, sourceA, { ...claim.records[0], state: "committed", operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [] });
    await kv.set(recordsScope, sourceB, { ...claim.records[1], state: "no_effect", operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "unexpected" }], noEffectProof: { kind: "strict_legal_empty", receiptKey: "wrong", reasonCode: "empty" } });
    await kv.delete(headsScope, "session|session-a");
    await kv.delete(headsScope, "session|session-b");
    const candidates = await inspectContributionCandidates(kv as any, { stage: "summary", stageContractVersion: "summary/v1", sourceVersionKeys: [sourceA, sourceB] });
    expect(candidates.map((candidate) => candidate.state)).toEqual(["contribution_reconciliation_required", "contribution_reconciliation_required"]);
  });

  it("fails closed when a record does not match the requested contribution scope", async () => {
    const kv = mockKV();
    const original = { stage: "summary" as const, stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] };
    const claim = await claimBatch(kv as any, original);
    const recordsScope = KV.extractionContributionRecords("summary", "summary/v1");
    await kv.set(recordsScope, sourceA, { ...claim.records[0], stage: "semantic" });
    await expect(inspectContributionCandidates(kv as any, { stage: "summary", stageContractVersion: "summary/v1", sourceVersionKeys: [sourceA] })).resolves.toMatchObject([{ state: "contribution_reconciliation_required" }]);
    await expect(claimBatch(kv as any, original)).resolves.toMatchObject({ status: "contribution_reconciliation_required" });
    await expect(commitClaimedBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "a" }] })).rejects.toThrow("contribution_record_scope_conflict");
  });

  it("isolates a terminal source correction while leaving unrelated candidates eligible", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    await commitClaimedBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "a" }] });
    const corrected = buildSourceVersionKey("summary", "session", "session-a", "c".repeat(64));
    const candidates = await inspectContributionCandidates(kv as any, { stage: "summary", stageContractVersion: "summary/v1", sourceVersionKeys: [corrected, sourceB] });
    expect(candidates.map((item) => item.state)).toEqual(["source_correction_requires_migration", "eligible"]);
  });

  it("releases only an exact claimed record and head", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    await releaseClaimedBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA] });
    expect(await kv.get(KV.extractionContributionRecords("summary", "summary/v1"), sourceA)).toBeNull();
    expect(await kv.get(KV.extractionContributionHeads("summary", "summary/v1"), "session|session-a")).toBeNull();
  });

  it("records and re-enters a strict no-effect terminal outcome", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    const input = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" }, receiptKey: "r", reasonCode: "empty" };
    await expect(markClaimedBatchNoEffect(kv as any, input)).resolves.toMatchObject([{ state: "no_effect" }]);
    await expect(markClaimedBatchNoEffect(kv as any, input)).resolves.toMatchObject([{ state: "no_effect" }]);
    expect(await kv.get(KV.extractionContributionHeads("summary", "summary/v1"), "session|session-a")).toMatchObject({ state: "no_effect" });
  });

  it("validates a conflicting head before a commit or no-effect record write", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    const headScope = KV.extractionContributionHeads("summary", "summary/v1");
    await kv.set(headScope, "session|session-a", { sourceVersionKey: sourceA, state: "claimed", contributionId: "other", updatedAt: "2026-01-01T00:00:00.000Z" });
    kv.sets.length = 0;
    const base = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" } };
    await expect(commitClaimedBatch(kv as any, { ...base, effectRefs: [{ scope: "effects", key: "a" }] })).rejects.toThrow("contribution_head_conflict");
    await expect(markClaimedBatchNoEffect(kv as any, { ...base, receiptKey: "r", reasonCode: "empty" })).rejects.toThrow("contribution_head_conflict");
    expect(kv.sets).toHaveLength(0);
  });

  it("requires reconciliation for an orphaned exact head and does not reopen the source", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    await kv.delete(KV.extractionContributionRecords("summary", "summary/v1"), sourceA);
    expect((await inspectContributionCandidates(kv as any, { stage: "summary", stageContractVersion: "summary/v1", sourceVersionKeys: [sourceA] }))[0].state).toBe("contribution_reconciliation_required");
    kv.sets.length = 0;
    await expect(claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] })).resolves.toMatchObject({ status: "contribution_reconciliation_required" });
    expect(kv.sets).toHaveLength(0);
    expect(claim.status).toBe("claimed");
  });

  it("requires reconciliation when a terminal head points at a missing record", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    await commitClaimedBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA], operationReceiptRef: { scope: "receipt", key: "r" }, effectRefs: [{ scope: "effects", key: "a" }] });
    await kv.delete(KV.extractionContributionRecords("summary", "summary/v1"), sourceA);
    expect((await inspectContributionCandidates(kv as any, { stage: "summary", stageContractVersion: "summary/v1", sourceVersionKeys: [sourceA] }))[0].state).toBe("contribution_reconciliation_required");
  });

  it("lets the original claim recover a missing head while rejecting a competing claim", async () => {
    const kv = mockKV();
    const original = { stage: "summary" as const, stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] };
    const originalSet = kv.set;
    let failHeadWrite = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (failHeadWrite && scope === KV.extractionContributionHeads("summary", "summary/v1")) {
        throw new Error("injected_head_write_failure");
      }
      return originalSet(scope, key, value);
    };
    await expect(claimBatch(kv as any, original)).rejects.toThrow("injected_head_write_failure");
    failHeadWrite = false;
    await expect(claimBatch(kv as any, original)).resolves.toMatchObject({ status: "claimed" });
    await expect(claimBatch(kv as any, { ...original, runId: "run-b", unitId: "unit-b" })).resolves.toMatchObject({ status: "claimed_by_other" });
  });

  it("releases either side of a partially released claimed pair on re-entry", async () => {
    const kv = mockKV();
    const claim = await claimBatch(kv as any, { stage: "summary", stageContractVersion: "summary/v1", runId: "run-a", unitId: "unit-a", sourceVersionKeys: [sourceA] });
    const input = { stage: "summary" as const, stageContractVersion: "summary/v1", contributionId: claim.records[0].contributionId, sourceVersionKeys: [sourceA] };
    await kv.delete(KV.extractionContributionRecords("summary", "summary/v1"), sourceA);
    await releaseClaimedBatch(kv as any, input);
    expect(await kv.get(KV.extractionContributionHeads("summary", "summary/v1"), "session|session-a")).toBeNull();
  });
});
