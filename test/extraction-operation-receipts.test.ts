import { describe, expect, it, vi } from "vitest";

import {
  buildExtractionOperationKey,
  registerExtractionOperationReceiptFunctions,
  withExtractionOperationReceipt,
} from "../src/functions/extraction-operation-receipts.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
  };
}

const identity = {
  runId: "formal-run",
  stage: "memory_consolidate",
  unitId: "mcw-1",
  inputHash: "input-a",
};

const orphanIdentity = {
  runId: "a".repeat(64),
  stage: "summary",
  unitId: "session-1:reduce",
  inputHash: "b".repeat(64),
};

const orphanReconciliationInput = {
  operation: {
    ...orphanIdentity,
    expectedStatus: "running",
    expectedStartedAt: "2026-07-26T17:44:07.622Z",
  },
  result: {
    sessionId: "session-1",
    resumableRunId: `sumr_${"c".repeat(24)}`,
    serviceInputHash: "d".repeat(64),
    runnerInputHash: "e".repeat(64),
    generationConfigHash: "f".repeat(64),
  },
};

async function seedOrphanedSummaryOperation(kv: ReturnType<typeof mockKV>) {
  const key = buildExtractionOperationKey(orphanIdentity);
  await kv.set(KV.extractionOperationReceipt(key), key, {
    ...orphanIdentity,
    key,
    status: "running",
    startedAt: orphanReconciliationInput.operation.expectedStartedAt,
  });
  await kv.set(KV.summaryResumableRuns, orphanReconciliationInput.result.resumableRunId, {
    id: orphanReconciliationInput.result.resumableRunId,
    sessionId: orphanReconciliationInput.result.sessionId,
    inputHash: orphanReconciliationInput.result.serviceInputHash,
    attemptId: orphanIdentity.runId,
    attemptInputHash: orphanReconciliationInput.result.runnerInputHash,
    generationConfigHash: orphanReconciliationInput.result.generationConfigHash,
    status: "in_progress",
    createdAt: "2026-07-26T17:39:42.912Z",
    updatedAt: "2026-07-26T17:44:06.658Z",
  });
  await kv.set(KV.summaryResumableActiveRuns, orphanReconciliationInput.result.sessionId, {
    sessionId: orphanReconciliationInput.result.sessionId,
    runId: orphanReconciliationInput.result.resumableRunId,
    inputHash: orphanReconciliationInput.result.serviceInputHash,
    createdAt: "2026-07-26T17:39:42.912Z",
    updatedAt: "2026-07-26T17:44:07.395Z",
  });
}

describe("extraction operation receipts", () => {
  it("serializes concurrent calls and executes the same successful operation once", async () => {
    const kv = mockKV();
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { success: true, memoryIds: ["mem-1"] };
    });

    const [first, second] = await Promise.all([
      withExtractionOperationReceipt(kv as never, identity, execute),
      withExtractionOperationReceipt(kv as never, identity, execute),
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.response).toEqual({ success: true, memoryIds: ["mem-1"] });
    expect(second.response).toEqual(first.response);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  });

  it("returns the cached safe response when the original client lost the response", async () => {
    const kv = mockKV();
    const execute = vi.fn(async () => ({
      success: true,
      memoryIds: ["mem-1"],
      content: "model output must not be stored",
      token: "secret must not be stored",
    }));

    const first = await withExtractionOperationReceipt(kv as never, identity, execute);
    const replay = await withExtractionOperationReceipt(kv as never, identity, execute);
    const key = buildExtractionOperationKey(identity);
    const stored = await kv.get<Record<string, unknown>>(
      KV.extractionOperationReceipt(key),
      key,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.response).toMatchObject({ success: true, memoryIds: ["mem-1"] });
    expect(replay).toMatchObject({ replayed: true, response: { success: true, memoryIds: ["mem-1"] } });
    expect(JSON.stringify(stored)).not.toContain("model output must not be stored");
    expect(JSON.stringify(stored)).not.toContain("secret must not be stored");
  });

  it("rejects a changed input hash for the same run stage and unit", async () => {
    const kv = mockKV();
    await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => ({ success: true, memoryIds: ["mem-1"] }),
    );

    const conflict = await withExtractionOperationReceipt(
      kv as never,
      { ...identity, inputHash: "input-b" },
      async () => ({ success: true, memoryIds: ["mem-2"] }),
    );

    expect(conflict).toMatchObject({
      replayed: true,
      failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
    });
  });

  it("does not re-execute an operation left running across a server crash", async () => {
    const kv = mockKV();
    const key = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...identity,
      key,
      status: "running",
      startedAt: "2026-07-14T00:00:00.000Z",
    });
    const execute = vi.fn(async () => ({ success: true, memoryIds: ["mem-2"] }));

    const result = await withExtractionOperationReceipt(kv as never, identity, execute);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      replayed: true,
      failure: { class: "transient_runtime", cause: "extraction_operation_reconciliation_required" },
    });
  });

  it("does not execute a recovered operation when its acknowledged receipt is missing", async () => {
    const kv = mockKV();
    const execute = vi.fn(async () => ({ success: true, memoryIds: ["mem-1"] }));

    const result = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      { requireExisting: true },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      replayed: true,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(result.receipt).toBeUndefined();
    const key = buildExtractionOperationKey(identity);
    await expect(kv.get(KV.extractionOperationReceipt(key), key)).resolves.toBeNull();
  });

  it("stores only a structured failure and immutably replays it for the same attempt", async () => {
    const kv = mockKV();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "provider token=must-not-persist",
        failure: { class: "transient_provider", cause: "pi_stream_failed" },
      })
      .mockResolvedValueOnce({ success: true, memoryIds: ["mem-1"] });

    const failed = await withExtractionOperationReceipt(kv as never, identity, execute);
    const retried = await withExtractionOperationReceipt(kv as never, identity, execute);
    const storedAfterFailure = failed.receipt;

    expect(failed).toMatchObject({
      replayed: false,
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
    });
    expect(JSON.stringify(storedAfterFailure)).not.toContain("must-not-persist");
    expect(retried).toMatchObject({
      replayed: true,
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const nextAttempt = await withExtractionOperationReceipt(
      kv as never,
      { ...identity, runId: "formal-run-attempt-2" },
      execute,
    );
    expect(nextAttempt).toMatchObject({ response: { success: true, memoryIds: ["mem-1"] } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not downgrade an uncertain succeeded-receipt write into a retryable failure", async () => {
    const kv = mockKV();
    const originalSet = kv.set.bind(kv);
    let failAfterSucceededCommit = true;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      const stored = await originalSet(scope, key, value);
      if (
        failAfterSucceededCommit
        && scope === KV.extractionOperationReceipt(buildExtractionOperationKey(identity))
        && (value as { status?: unknown }).status === "succeeded"
      ) {
        failAfterSucceededCommit = false;
        throw new Error("state write timed out after commit");
      }
      return stored;
    };
    const execute = vi.fn(async () => ({ success: true, memoryIds: ["mem-1"] }));

    await expect(
      withExtractionOperationReceipt(kv as never, identity, execute),
    ).rejects.toThrow("state write timed out after commit");
    const replay = await withExtractionOperationReceipt(kv as never, identity, execute);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      replayed: true,
      response: { success: true, memoryIds: ["mem-1"] },
    });
  });

  it("projects semantic receipts to result identifiers and required runtime metadata", async () => {
    const kv = mockKV();
    const semanticIdentity = { ...identity, stage: "semantic_rollup" as const };
    const execute = vi.fn(async () => ({
      success: true,
      status: "succeeded",
      semanticMemoryIds: ["sem-1"],
      semanticMemoryCharSizes: { "sem-1": 42 },
      inputHash: "semantic-source-hash",
      provider: "pi-agent-sdk",
      model: "gpt-test",
      promptChars: 123,
      description: "model prose",
      evidence: ["model evidence"],
      steps: ["model step"],
      details: { explanation: "model details" },
      reason: "model reason",
      facts: [{ fact: "model fact", confidence: 0.9 }],
    }));

    const first = await withExtractionOperationReceipt(kv as never, semanticIdentity, execute);
    const replay = await withExtractionOperationReceipt(kv as never, semanticIdentity, execute);

    expect(first.response).toEqual({
      success: true,
      status: "succeeded",
      semanticMemoryIds: ["sem-1"],
      semanticMemoryCharSizes: { "sem-1": 42 },
      inputHash: "semantic-source-hash",
      provider: "pi-agent-sdk",
      model: "gpt-test",
      promptChars: 123,
    });
    expect(replay.response).toEqual(first.response);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("projects each write stage without retaining arbitrary model prose", async () => {
    const cases = [
      {
        stage: "skill_extract" as const,
        response: { success: true, status: "succeeded", proceduralMemoryIds: ["proc-1"] },
      },
      {
        stage: "memory_consolidate" as const,
        response: { success: true, status: "succeeded", memoryIds: ["mem-1"] },
      },
      {
        stage: "consolidation_procedural" as const,
        response: { success: true, status: "succeeded", proceduralMemoryIds: ["proc-2"] },
      },
      {
        stage: "reflect_insight" as const,
        response: { success: true, status: "succeeded", insightIds: ["ins-1"] },
      },
      {
        stage: "crystal" as const,
        response: {
          success: true,
          status: "succeeded",
          crystalIds: ["crys-1"],
          groups: [{
            groupId: "group-1",
            status: "succeeded",
            actionIds: ["act-1"],
            actionUpdatedAts: ["2026-07-14T00:00:00.000Z"],
            crystalIds: ["crys-1"],
            description: "nested model prose",
            reason: "nested reason",
          }],
          items: [{ unitId: "unit-1", status: "succeeded", memoryIds: ["mem-2"], evidence: "text" }],
        },
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const kv = mockKV();
      const stageIdentity = {
        ...identity,
        stage: entry.stage,
        unitId: `unit-${index}`,
      };
      const raw = {
        ...entry.response,
        provider: "pi-agent-sdk",
        model: "gpt-test",
        promptChars: 99,
        description: "top-level model prose",
        evidence: ["top-level evidence"],
        steps: ["top-level step"],
        details: { explanation: "top-level details" },
        reason: "top-level reason",
      };

      const first = await withExtractionOperationReceipt(kv as never, stageIdentity, async () => raw);
      const replay = await withExtractionOperationReceipt(kv as never, stageIdentity, async () => raw);
      const serialized = JSON.stringify(first.response);

      expect(replay.response).toEqual(first.response);
      expect(serialized).not.toContain("model prose");
      expect(serialized).not.toContain("evidence");
      expect(serialized).not.toContain("top-level step");
      expect(serialized).not.toContain("details");
      expect(serialized).not.toContain("reason");
      expect(first.response).toMatchObject({
        success: true,
        status: "succeeded",
        provider: "pi-agent-sdk",
        model: "gpt-test",
        promptChars: 99,
      });
    }
  });

  it("keeps total receipt bytes linear while every StateKV scope stays bounded", async () => {
    const kv = mockKV();
    const identities: typeof identity[] = [];
    const serializedBytes = async () => {
      const receipts = await Promise.all(identities.map(async (entry) => {
        const key = buildExtractionOperationKey(entry);
        return kv.get(KV.extractionOperationReceipt(key), key);
      }));
      return {
        total: receipts.reduce(
          (sum, receipt) => sum + Buffer.byteLength(JSON.stringify(receipt)),
          0,
        ),
        max: Math.max(...receipts.map((receipt) => Buffer.byteLength(JSON.stringify(receipt)))),
        serialized: JSON.stringify(receipts),
      };
    };
    const sizes = [];

    for (const target of [100, 200]) {
      for (let index = sizes.length === 0 ? 0 : 100; index < target; index += 1) {
        const operationIdentity = {
          runId: "scale-run",
          stage: "summary" as const,
          unitId: `summary-${String(index).padStart(4, "0")}`,
          inputHash: `input-${String(index).padStart(4, "0")}`,
        };
        identities.push(operationIdentity);
        await withExtractionOperationReceipt(
          kv as never,
          operationIdentity,
          async () => ({
            success: true,
            status: "succeeded",
            resultRef: {
              scope: KV.summaryResumableRuns,
              key: `summary-run-${String(index).padStart(4, "0")}`,
            },
            narrative: "large model prose must not enter the receipt",
          }),
        );
      }
      sizes.push(await serializedBytes());
    }

    const ratio = sizes[1].total / sizes[0].total;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
    expect(sizes[1].max).toBe(sizes[0].max);
    expect(sizes[1].serialized).not.toContain("large model prose");
  });

  it("blocks an interrupted operation because its side effect is uncertain", async () => {
    const kv = mockKV();
    const result = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => {
        throw new Error("fetch failed: local sdk socket timeout");
      },
    );

    expect(result.failure).toEqual({
      class: "transient_runtime",
      cause: "extraction_operation_reconciliation_required",
    });
  });

  it("does not treat a thrown provider interruption as a confirmed failure", async () => {
    const kv = mockKV();
    const result = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => {
        throw new Error("pi_stream_failed");
      },
    );

    expect(result.failure).toEqual({
      class: "transient_runtime",
      cause: "extraction_operation_reconciliation_required",
    });
  });

  it("validates identity at the receipt iii-function boundary", async () => {
    const functions = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    };
    registerExtractionOperationReceiptFunctions(sdk as never, mockKV() as never);
    const handler = functions.get("mem::extraction-operation-receipt-get")!;

    await expect(handler(undefined)).resolves.toEqual({
      success: false,
      failure: { class: "hard", cause: "invalid_extraction_operation_identity" },
    });
    await expect(handler({
      runId: "formal-run",
      stage: "unknown-stage",
      unitId: "unit-1",
      inputHash: "input-a",
    })).resolves.toEqual({
      success: false,
      failure: { class: "hard", cause: "invalid_extraction_operation_identity" },
    });
    await expect(handler({
      ...identity,
      response: { prompt: "must-not-cross-boundary" },
    })).resolves.toEqual({
      success: true,
      operation: identity,
      receipt: null,
    });
  });

  it("returns only whitelisted receipt diagnostics without executing work", async () => {
    const kv = mockKV();
    const functions = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    };
    registerExtractionOperationReceiptFunctions(sdk as never, kv as never);
    const handler = functions.get("mem::extraction-operation-receipt-get")!;
    const cases = [
      {
        identity: { ...identity, unitId: "succeeded-unit" },
        receipt: {
          ...identity,
          unitId: "succeeded-unit",
          key: buildExtractionOperationKey({ ...identity, unitId: "succeeded-unit" }),
          status: "succeeded",
          startedAt: "2026-07-24T00:00:00.000Z",
          completedAt: "2026-07-24T00:01:00.000Z",
          response: {
            success: true,
            prompt: "must-not-cross-boundary",
            response: "must-not-cross-boundary",
            memoryIds: ["mem-1"],
          },
        },
      },
      {
        identity: { ...identity, unitId: "failed-unit" },
        receipt: {
          ...identity,
          unitId: "failed-unit",
          key: buildExtractionOperationKey({ ...identity, unitId: "failed-unit" }),
          status: "failed",
          startedAt: "2026-07-24T00:00:00.000Z",
          completedAt: "2026-07-24T00:01:00.000Z",
          failure: {
            class: "transient_provider",
            cause: "pi_stream_failed",
            diagnostics: { rawMessage: "must-not-cross-boundary" },
          },
        },
      },
      {
        identity: { ...identity, unitId: "running-unit" },
        receipt: {
          ...identity,
          unitId: "running-unit",
          key: buildExtractionOperationKey({ ...identity, unitId: "running-unit" }),
          status: "running",
          startedAt: "2026-07-24T00:00:00.000Z",
        },
      },
    ] as const;

    for (const entry of cases) {
      await kv.set(
        KV.extractionOperationReceipt(entry.receipt.key),
        entry.receipt.key,
        entry.receipt,
      );
      const {
        inputHash: _inputHash,
        ...operationLookup
      } = entry.identity;
      const result = await handler(operationLookup);
      expect(result).toEqual({
        success: true,
        operation: entry.identity,
        receipt: {
          status: entry.receipt.status,
          startedAt: entry.receipt.startedAt,
          ...("completedAt" in entry.receipt
            ? { completedAt: entry.receipt.completedAt }
            : {}),
          ...("failure" in entry.receipt
            ? {
                failure: {
                  class: entry.receipt.failure.class,
                  cause: entry.receipt.failure.cause,
                },
              }
            : {}),
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /memoryIds|prompt|response|rawMessage|must-not-cross-boundary/,
      );
    }
  });

  it("CAS-reconciles only an exact orphaned summary reduce receipt with no result", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const handler = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;

    const first = await handler({
      ...orphanReconciliationInput,
      runtimeContext: { traceId: "framework-added" },
    });
    const replay = await handler({
      ...orphanReconciliationInput,
      runtimeContext: { traceId: "framework-added" },
    });

    expect(first).toEqual({
      success: true,
      replayed: false,
      operation: orphanIdentity,
      receipt: {
        status: "reconciled",
        startedAt: orphanReconciliationInput.operation.expectedStartedAt,
        completedAt: expect.any(String),
        failure: {
          class: "transient_runtime",
          cause: "orphaned_operation_result_absent",
        },
      },
      reconciliation: {
        id: expect.stringMatching(/^xrec_[0-9a-f]{32}$/),
        at: expect.any(String),
        resultStatus: "absent",
      },
    });
    expect(replay).toEqual({
      ...first,
      replayed: true,
    });

    const execute = vi.fn(async () => ({ success: true }));
    await expect(withExtractionOperationReceipt(
      kv as never,
      orphanIdentity,
      execute,
      { requireExisting: true },
    )).resolves.toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(withExtractionOperationReceipt(
      kv as never,
      orphanIdentity,
      execute,
    )).resolves.toMatchObject({
      replayed: false,
      response: { success: true },
      receipt: { status: "succeeded" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects extra fields inside the exact orphan operation identity", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const handler = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;

    await expect(handler({
      ...orphanReconciliationInput,
      operation: {
        ...orphanReconciliationInput.operation,
        reset: true,
      },
    })).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "invalid_orphan_reconciliation_identity",
      },
    });
  });

  it("rejects stale orphan reconciliation evidence without mutating the receipt", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const handler = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;

    await expect(handler({
      ...orphanReconciliationInput,
      operation: {
        ...orphanReconciliationInput.operation,
        expectedStartedAt: "2026-07-26T17:44:07.623Z",
      },
    })).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_evidence_drifted",
      },
    });

    const key = buildExtractionOperationKey(orphanIdentity);
    await expect(kv.get<Record<string, unknown>>(
      KV.extractionOperationReceipt(key),
      key,
    )).resolves.toMatchObject({ status: "running" });
  });

  it("refuses orphan reconciliation when a summary result already exists", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    await kv.set(KV.summaries, orphanReconciliationInput.result.sessionId, {
      sessionId: orphanReconciliationInput.result.sessionId,
      createdAt: "2026-07-26T17:44:08.000Z",
      title: "must-not-cross-boundary",
    });
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const handler = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;

    await expect(handler(orphanReconciliationInput)).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_result_present",
      },
    });
  });
});
