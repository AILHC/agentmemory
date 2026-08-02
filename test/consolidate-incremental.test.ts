import { describe, expect, it, vi } from "vitest";
import {
  collectConsolidationObservationDescriptorPage,
  commitMemoryConsolidationProposal,
  planConsolidateObservationWindows,
  reconcileMemoryConsolidationContribution,
  runConsolidateObservationWindow,
} from "../src/functions/consolidate.js";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  ExtractionOperationIdentity,
  Memory,
  MemoryProvider,
} from "../src/types.js";

function memoryXml(title = "Incremental workflow"): string {
  return `<memory><type>workflow</type><title>${title}</title><content>Use the accumulated delta.</content><concepts><concept>windows</concept></concepts><files></files><strength>7</strength></memory>`;
}

function observation(id: string, sessionId: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-08-02T00:00:00.000Z",
    type: "decision",
    title: `Observation ${id}`,
    facts: [],
    narrative: `Evidence ${id}`,
    concepts: ["windows"],
    files: [],
    importance: 8,
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const get = vi.fn(async <T>(scope: string, key: string): Promise<T | null> =>
    (store.get(scope)?.get(key) as T) ?? null);
  const set = vi.fn(async <T>(scope: string, key: string, value: T): Promise<T> => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)!.set(key, value);
    return value;
  });
  const list = vi.fn(async <T>(scope: string): Promise<T[]> =>
    Array.from(store.get(scope)?.values() ?? []) as T[]);
  const del = vi.fn(async (scope: string, key: string): Promise<void> => {
    store.get(scope)?.delete(key);
  });
  return { store, get, set, list, delete: del };
}

async function seedObservations(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  observations: CompressedObservation[],
): Promise<void> {
  for (const item of observations) {
    await kv.set(KV.observations(sessionId), item.id, item);
  }
}

describe("memory consolidate cross-run incremental contract", () => {
  it("propagates selected-session observation read failures instead of treating them as empty", async () => {
    const kv = mockKV();
    kv.list.mockImplementation(async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.observations("selected-failure")) {
        throw new Error("selected_observation_read_failed");
      }
      return Array.from(kv.store.get(scope)?.values() ?? []) as T[];
    });

    await expect(collectConsolidationObservationDescriptorPage({
      kv: kv as never,
      sessionIds: ["selected-failure"],
    })).rejects.toThrow("selected_observation_read_failed");
  });

  it("plans only selected sessions plus persistent backlog and consumes every source once", async () => {
    const kv = mockKV();
    await seedObservations(kv, "session-a", [
      observation("obs-a1", "session-a"),
      observation("obs-a2", "session-a"),
    ]);

    const first = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-a"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(first.windows).toHaveLength(0);
    expect(await kv.list(KV.memoryConsolidationBacklog())).toHaveLength(2);
    kv.list.mockClear();

    await seedObservations(kv, "session-b", [observation("obs-b1", "session-b")]);
    const second = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-b"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(second.windows).toHaveLength(1);
    expect(new Set(second.windows[0].sourceObservationIds)).toEqual(new Set([
      "obs-a1",
      "obs-a2",
      "obs-b1",
    ]));
    expect(new Set(second.windows[0].sourceVersionKeys)).toHaveProperty("size", 3);
    const accumulatedWindow = second.windows[0];
    await expect(runConsolidateObservationWindow({
      kv: kv as never,
      provider: { compress: vi.fn(async () => memoryXml()) } as unknown as MemoryProvider,
      concept: accumulatedWindow.concept,
      observationIds: accumulatedWindow.observationIds,
      observationSessionIds: accumulatedWindow.observationSessionIds,
      stageContractVersion: accumulatedWindow.stageContractVersion,
      sourceVersionKeys: accumulatedWindow.sourceVersionKeys,
      operationIdentity: {
        runId: "backlog-combination",
        stage: "memory_consolidate",
        unitId: accumulatedWindow.windowId,
        inputHash: accumulatedWindow.inputHash,
      },
      operationReceiptManaged: true,
    })).resolves.toMatchObject({ success: true, status: "prepared" });
    expect(kv.list).not.toHaveBeenCalledWith(KV.sessions);
    expect(kv.list).not.toHaveBeenCalledWith(KV.observations("session-a"));
  });

  it("has a read-call bound independent of a million-observation historical shape", async () => {
    const kv = mockKV();
    await seedObservations(kv, "selected", [
      observation("selected-1", "selected"),
      observation("selected-2", "selected"),
      observation("selected-3", "selected"),
    ]);
    kv.list.mockImplementation(async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.sessions || scope.startsWith("mem:observations:") && scope !== KV.observations("selected")) {
        throw new Error("full_history_enumeration_forbidden");
      }
      return Array.from(kv.store.get(scope)?.values() ?? []) as T[];
    });

    const result = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["selected"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(result.windows).toHaveLength(1);
    expect(kv.list.mock.calls.filter(([scope]) => scope === KV.observations("selected"))).toHaveLength(1);
    expect(kv.list.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(0);
  });

  it("refreshes a drifted backlog source version without rescanning its session", async () => {
    const kv = mockKV();
    const firstVersion = observation("obs-old-1", "old-session");
    await seedObservations(kv, "old-session", [
      firstVersion,
      observation("obs-old-2", "old-session"),
    ]);
    const first = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["old-session"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(first.windows).toHaveLength(0);
    const oldSourceVersionKey = (await kv.list<{ observationId: string; sourceVersionKey: string }>(
      KV.memoryConsolidationBacklog(),
    )).find((record) => record.observationId === firstVersion.id)!.sourceVersionKey;

    await kv.set(KV.observations("old-session"), firstVersion.id, {
      ...firstVersion,
      narrative: "Evidence changed while waiting in backlog",
    });
    await seedObservations(kv, "new-session", [observation("obs-new-1", "new-session")]);
    kv.list.mockClear();
    const second = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["new-session"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(second.windows).toHaveLength(1);
    const window = second.windows[0];
    const refreshedKey = window.sourceVersionKeys.find((key) => key.includes("obs-old-1"));
    expect(refreshedKey).toBeDefined();
    expect(refreshedKey).not.toBe(oldSourceVersionKey);
    expect(kv.list).not.toHaveBeenCalledWith(KV.observations("old-session"));
    expect(await kv.get(KV.memoryConsolidationBacklog(), oldSourceVersionKey)).toBeNull();
    await expect(runConsolidateObservationWindow({
      kv: kv as never,
      provider: { compress: vi.fn(async () => memoryXml()) } as unknown as MemoryProvider,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      concept: window.concept,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: {
        runId: "backlog-drift",
        stage: "memory_consolidate",
        unitId: window.windowId,
        inputHash: window.inputHash,
      },
      operationReceiptManaged: true,
    })).resolves.toMatchObject({ success: true, status: "prepared" });
  });

  it("removes deleted and newly ineligible observations from backlog and its source index", async () => {
    const kv = mockKV();
    const deleted = observation("deleted-backlog", "waiting-session");
    const ineligible = observation("ineligible-backlog", "waiting-session");
    await seedObservations(kv, "waiting-session", [deleted, ineligible]);
    await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["waiting-session"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    const records = await kv.list<{ observationId: string; sourceVersionKey: string }>(
      KV.memoryConsolidationBacklog(),
    );
    expect(records).toHaveLength(2);
    await kv.delete(KV.observations("waiting-session"), deleted.id);
    await kv.set(KV.observations("waiting-session"), ineligible.id, {
      ...ineligible,
      importance: 1,
    });

    await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["empty-session"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(await kv.list(KV.memoryConsolidationBacklog())).toHaveLength(0);
    for (const record of records) {
      expect(await kv.get(
        KV.memoryConsolidationBacklogSourceIndex(),
        record.observationId,
      )).toBeNull();
    }
  });

  it("claims the whole delta before provider entry so overlapping runs call provider once", async () => {
    const kv = mockKV();
    const source = [
      observation("obs-1", "session-1"),
      observation("obs-2", "session-1"),
      observation("obs-3", "session-1"),
    ];
    await seedObservations(kv, "session-1", source);
    const plan = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-1"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    const window = plan.windows[0];
    let releaseProvider!: (value: string) => void;
    const providerResult = new Promise<string>((resolve) => { releaseProvider = resolve; });
    const compress = vi.fn(() => providerResult);
    const provider = { compress } as unknown as MemoryProvider;
    const base = {
      kv: kv as never,
      provider,
      concept: window.concept,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      charBudget: window.charBudget,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
    };
    const first = runConsolidateObservationWindow({
      ...base,
      operationIdentity: {
        runId: "run-a",
        stage: "memory_consolidate",
        unitId: window.windowId,
        inputHash: window.inputHash,
      },
      operationReceiptManaged: true,
    });
    await vi.waitFor(() => expect(compress).toHaveBeenCalledTimes(1));
    const second = await runConsolidateObservationWindow({
      ...base,
      operationIdentity: {
        runId: "run-b",
        stage: "memory_consolidate",
        unitId: window.windowId,
        inputHash: window.inputHash,
      },
      operationReceiptManaged: true,
    });
    expect(second).toMatchObject({
      success: false,
      failure: { cause: "extraction_operation_reconciliation_required" },
    });
    releaseProvider(memoryXml());
    await expect(first).resolves.toMatchObject({ success: true, status: "prepared" });
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("separates delta evidence from read-only historical context and reconciles after effect persistence", async () => {
    const kv = mockKV();
    const oldMemory: Memory = {
      id: "memory-old",
      type: "workflow",
      title: "Prior context",
      content: "Historical only.",
      concepts: ["windows"],
      files: [],
      sessionIds: ["old-session"],
      strength: 4,
      version: 5,
      isLatest: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    await kv.set(KV.memories, oldMemory.id, oldMemory);
    const source = [
      observation("obs-1", "session-1"),
      observation("obs-2", "session-1"),
      observation("obs-3", "session-1"),
    ];
    await seedObservations(kv, "session-1", source);
    const plan = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-1"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    const window = plan.windows[0];
    const compress = vi.fn(async (_system: string, prompt: string) => {
      expect(prompt).toContain("Delta evidence (the only new contribution)");
      expect(prompt).toContain("Historical context (read-only");
      expect(prompt).toContain("Prior context");
      return memoryXml("Incremental result");
    });
    const prepareIdentity: ExtractionOperationIdentity = {
      runId: "run-prepare",
      stage: "memory_consolidate",
      unitId: window.windowId,
      inputHash: window.inputHash,
    };
    const prepared = await runConsolidateObservationWindow({
      kv: kv as never,
      provider: { compress } as unknown as MemoryProvider,
      concept: window.concept,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      charBudget: window.charBudget,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: prepareIdentity,
      operationReceiptManaged: true,
    });
    expect(prepared).toMatchObject({ success: true, status: "prepared" });
    expect(await kv.get<Memory>(KV.memories, oldMemory.id)).toEqual(oldMemory);

    const committed = await commitMemoryConsolidationProposal({
      kv: kv as never,
      identity: prepareIdentity,
      preparedHandle: String(prepared.preparedHandle),
      proposalHash: String(prepared.proposalHash),
    });
    expect(committed).toMatchObject({ success: true, status: "succeeded" });
    const commitIdentity: ExtractionOperationIdentity = {
      runId: "run-commit",
      stage: "memory_consolidate",
      unitId: window.windowId,
      inputHash: "commit-input",
    };
    const receiptKey = buildExtractionOperationKey(commitIdentity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...commitIdentity,
      key: receiptKey,
      status: "succeeded",
      startedAt: "2026-08-02T00:00:00.000Z",
      completedAt: "2026-08-02T00:00:01.000Z",
      response: committed,
    });
    await reconcileMemoryConsolidationContribution(kv as never, prepareIdentity, commitIdentity);
    await reconcileMemoryConsolidationContribution(kv as never, prepareIdentity, commitIdentity);

    const replayProvider = { compress: vi.fn(async () => memoryXml()) } as unknown as MemoryProvider;
    const replayRequest = {
      kv: kv as never,
      provider: replayProvider,
      concept: window.concept,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: prepareIdentity,
      operationReceiptManaged: true,
    };
    const resultId = (committed.memoryIds as string[])[0];
    const originalMemory = structuredClone(await kv.get<Memory>(KV.memories, resultId)!);
    await kv.set(KV.memories, resultId, { ...originalMemory, content: "drifted" });
    await expect(runConsolidateObservationWindow(replayRequest)).resolves.toMatchObject({
      success: false,
      failure: { cause: "memory_consolidate_contribution_effect_reconciliation_required" },
    });
    await kv.set(KV.memories, resultId, originalMemory);

    const audit = (await kv.list<Record<string, unknown>>(KV.audit))[0];
    const originalAudit = structuredClone(audit);
    await kv.set(KV.audit, String(audit.id), { ...audit, operation: "forget" });
    await expect(runConsolidateObservationWindow(replayRequest)).resolves.toMatchObject({
      success: false,
      failure: { cause: "memory_consolidate_contribution_effect_reconciliation_required" },
    });
    await kv.set(KV.audit, String(audit.id), originalAudit);

    const proposalScope = [...kv.store.keys()].find((scope) =>
      scope.startsWith("mem:memory-consolidation-proposal:"),
    )!;
    const [proposalKey, proposal] = [...kv.store.get(proposalScope)!.entries()][0];
    const originalProposal = structuredClone(proposal) as Record<string, unknown>;
    await kv.set(proposalScope, proposalKey, {
      ...originalProposal,
      response: { ...(originalProposal.response as object), memoryId: "drifted" },
    });
    await expect(runConsolidateObservationWindow(replayRequest)).resolves.toMatchObject({
      success: false,
      failure: { cause: "memory_consolidate_contribution_effect_reconciliation_required" },
    });
    await kv.set(proposalScope, proposalKey, originalProposal);
    expect((replayProvider.compress as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const clean = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-1"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    expect(clean.windows).toHaveLength(0);
    expect(compress).toHaveBeenCalledTimes(1);
    expect((await kv.get<Memory>(KV.memories, oldMemory.id))?.strength).toBe(4);
  });

  it("recovers a response persisted immediately before a crash without another provider call", async () => {
    const kv = mockKV();
    await seedObservations(kv, "session-1", [
      observation("obs-1", "session-1"),
      observation("obs-2", "session-1"),
      observation("obs-3", "session-1"),
    ]);
    const plan = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-1"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    const window = plan.windows[0];
    const identity: ExtractionOperationIdentity = {
      runId: "crash-run",
      stage: "memory_consolidate",
      unitId: window.windowId,
      inputHash: window.inputHash,
    };
    const compress = vi.fn(async () => memoryXml());
    const originalSet = kv.set.getMockImplementation()!;
    let crashed = false;
    kv.set.mockImplementation(async <T>(scope: string, key: string, value: T): Promise<T> => {
      const stored = await originalSet(scope, key, value) as T;
      if (!crashed && scope.startsWith("mem:memory-consolidation-proposal:")) {
        crashed = true;
        throw new Error("simulated_process_crash_after_response_persistence");
      }
      return stored;
    });
    const request = {
      kv: kv as never,
      provider: { compress } as unknown as MemoryProvider,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      concept: window.concept,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: identity,
    };
    await expect(runConsolidateObservationWindow(request)).resolves.toMatchObject({
      success: false,
      error: "simulated_process_crash_after_response_persistence",
    });
    kv.set.mockImplementation(originalSet);
    await expect(runConsolidateObservationWindow(request)).resolves.toMatchObject({
      success: true,
      status: "prepared",
    });
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("evolves only the frozen latest historical parent for incremental commits", async () => {
    const kv = mockKV();
    const baseMemory = (id: string, isLatest: boolean, version: number): Memory => ({
      id,
      type: "workflow",
      title: "Frozen title",
      content: `Version ${version}`,
      concepts: ["windows"],
      files: [],
      sessionIds: ["historical"],
      strength: 5,
      version,
      isLatest,
      createdAt: `2026-07-0${version}T00:00:00.000Z`,
      updatedAt: `2026-07-0${version}T00:00:00.000Z`,
    });
    await kv.set(KV.memories, "older-first", baseMemory("older-first", false, 1));
    await kv.set(KV.memories, "frozen-latest", baseMemory("frozen-latest", true, 2));
    await seedObservations(kv, "session-1", [
      observation("parent-1", "session-1"),
      observation("parent-2", "session-1"),
      observation("parent-3", "session-1"),
    ]);
    const window = (await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-1"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    })).windows[0];
    const identity: ExtractionOperationIdentity = {
      runId: "frozen-parent",
      stage: "memory_consolidate",
      unitId: window.windowId,
      inputHash: window.inputHash,
    };
    const prepared = await runConsolidateObservationWindow({
      kv: kv as never,
      provider: { compress: vi.fn(async () => memoryXml("Frozen title")) } as unknown as MemoryProvider,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      concept: window.concept,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: identity,
      operationReceiptManaged: true,
    });
    const committed = await commitMemoryConsolidationProposal({
      kv: kv as never,
      identity,
      preparedHandle: String(prepared.preparedHandle),
      proposalHash: String(prepared.proposalHash),
    });
    expect(committed).toMatchObject({
      success: true,
      status: "succeeded",
      action: "evolved",
      parentId: "frozen-latest",
    });
    expect((await kv.get<Memory>(KV.memories, "older-first"))?.isLatest).toBe(false);
    expect((await kv.get<Memory>(KV.memories, "frozen-latest"))?.isLatest).toBe(false);
  });

  it.each(["content", "latest"] as const)(
    "fails closed when frozen historical context drifts in %s before commit",
    async (drift) => {
      const kv = mockKV();
      const parent: Memory = {
        id: `drift-parent-${drift}`,
        type: "workflow",
        title: "Drift parent",
        content: "Frozen provider context",
        concepts: ["windows"],
        files: [],
        sessionIds: ["historical"],
        strength: 6,
        version: 2,
        isLatest: true,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      };
      await kv.set(KV.memories, parent.id, parent);
      await seedObservations(kv, `drift-session-${drift}`, [
        observation(`drift-${drift}-1`, `drift-session-${drift}`),
        observation(`drift-${drift}-2`, `drift-session-${drift}`),
        observation(`drift-${drift}-3`, `drift-session-${drift}`),
      ]);
      const window = (await planConsolidateObservationWindows({
        kv: kv as never,
        sessionIds: [`drift-session-${drift}`],
        minObservationsPerConcept: 3,
        charBudget: 10_000,
      })).windows[0];
      const identity: ExtractionOperationIdentity = {
        runId: `historical-drift-${drift}`,
        stage: "memory_consolidate",
        unitId: window.windowId,
        inputHash: window.inputHash,
      };
      const prepared = await runConsolidateObservationWindow({
        kv: kv as never,
        provider: {
          compress: vi.fn(async () => memoryXml("Drift parent")),
        } as unknown as MemoryProvider,
        observationIds: window.observationIds,
        observationSessionIds: window.observationSessionIds,
        concept: window.concept,
        stageContractVersion: window.stageContractVersion,
        sourceVersionKeys: window.sourceVersionKeys,
        operationIdentity: identity,
        operationReceiptManaged: true,
      });
      const proposalScope = [...kv.store.keys()].find((scope) =>
        scope.startsWith("mem:memory-consolidation-proposal:"),
      )!;
      const proposal = [...kv.store.get(proposalScope)!.values()][0] as {
        historicalContext: { memoryVersions: unknown[] };
      };
      expect(proposal.historicalContext.memoryVersions).toHaveLength(1);
      const driftedParent = drift === "content"
        ? { ...parent, content: "Changed after prepare" }
        : { ...parent, isLatest: false };
      await kv.set(KV.memories, parent.id, driftedParent);

      const committed = await commitMemoryConsolidationProposal({
        kv: kv as never,
        identity,
        preparedHandle: String(prepared.preparedHandle),
        proposalHash: String(prepared.proposalHash),
      });
      expect(committed).toMatchObject({
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "memory_consolidate_historical_context_conflict" },
      });
      expect(await kv.list(KV.memories)).toEqual([driftedParent]);
      expect(await kv.list(KV.audit)).toHaveLength(0);
    },
  );

  it("does not consume claims on provider or parse failure and accepts only structured empty", async () => {
    const kv = mockKV();
    const source = [
      observation("obs-1", "session-1"),
      observation("obs-2", "session-1"),
      observation("obs-3", "session-1"),
    ];
    await seedObservations(kv, "session-1", source);
    const plan = await planConsolidateObservationWindows({
      kv: kv as never,
      sessionIds: ["session-1"],
      minObservationsPerConcept: 3,
      charBudget: 10_000,
    });
    const window = plan.windows[0];
    const identity: ExtractionOperationIdentity = {
      runId: "parse-retry",
      stage: "memory_consolidate",
      unitId: window.windowId,
      inputHash: window.inputHash,
    };
    const providerFailure = await runConsolidateObservationWindow({
      kv: kv as never,
      provider: {
        compress: vi.fn(async () => { throw new Error("provider_unavailable"); }),
      } as unknown as MemoryProvider,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      concept: window.concept,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: identity,
      operationReceiptManaged: true,
    });
    expect(providerFailure).toMatchObject({ success: false, error: "provider_unavailable" });
    expect(await kv.list(KV.extractionContributionRecords(
      "memory_consolidate",
      "memory_consolidate/v1",
    ))).toHaveLength(0);
    for (const malformed of [
      "not structured",
      "<no_effect><reason_code>no_durable_memory</reason_code>",
      `${memoryXml()}<no_effect><reason_code>no_durable_memory</reason_code></no_effect>`,
      `${memoryXml()} trailing-junk`,
      "<memory><type>workflow</type><title>Broken<content>nested</title></content><concepts></concepts><files></files><strength>5</strength></memory>",
    ]) {
      const invalid = await runConsolidateObservationWindow({
        kv: kv as never,
        provider: { compress: vi.fn(async () => malformed) } as unknown as MemoryProvider,
        observationIds: window.observationIds,
        observationSessionIds: window.observationSessionIds,
        concept: window.concept,
        stageContractVersion: window.stageContractVersion,
        sourceVersionKeys: window.sourceVersionKeys,
        operationIdentity: identity,
        operationReceiptManaged: true,
      });
      expect(invalid).toMatchObject({ success: false, error: "failed to parse memory XML" });
      expect(await kv.list(KV.extractionContributionRecords(
        "memory_consolidate",
        "memory_consolidate/v1",
      ))).toHaveLength(0);
    }

    const legalEmpty = await runConsolidateObservationWindow({
      kv: kv as never,
      provider: {
        compress: vi.fn(async () =>
          "<no_effect><reason_code>no_durable_memory</reason_code></no_effect>"),
      } as unknown as MemoryProvider,
      observationIds: window.observationIds,
      observationSessionIds: window.observationSessionIds,
      concept: window.concept,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      operationIdentity: identity,
      operationReceiptManaged: true,
    });
    expect(legalEmpty).toMatchObject({ success: true, status: "prepared" });
    const committed = await commitMemoryConsolidationProposal({
      kv: kv as never,
      identity,
      preparedHandle: String(legalEmpty.preparedHandle),
      proposalHash: String(legalEmpty.proposalHash),
    });
    expect(committed).toMatchObject({
      success: true,
      status: "skipped",
      consolidated: 0,
      noEffectEvidence: {
        schema: "memory-consolidate-no-effect/v1",
        reasonCode: "no_durable_memory",
      },
    });
    const commitIdentity: ExtractionOperationIdentity = {
      runId: "parse-retry-commit",
      stage: "memory_consolidate",
      unitId: window.windowId,
      inputHash: "commit-input",
    };
    const receiptKey = buildExtractionOperationKey(commitIdentity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...commitIdentity,
      key: receiptKey,
      status: "succeeded",
      startedAt: "2026-08-02T00:00:00.000Z",
      response: committed,
    });
    await reconcileMemoryConsolidationContribution(kv as never, identity, commitIdentity);
    const records = await kv.list<Record<string, unknown>>(KV.extractionContributionRecords(
      "memory_consolidate",
      "memory_consolidate/v1",
    ));
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.state === "no_effect")).toBe(true);
  });
});
