import { describe, expect, it, vi } from "vitest";

import {
  buildExtractionOperationKey,
  completeModelOperationFromVerifiedResult,
  ExtractionOperationResultUncertainError,
  registerExtractionOperationReceiptFunctions,
  withExtractionOperationReceipt,
  withIdempotentCommitReceipt,
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

function failedRetryAuthorization(receipt: any) {
  return {
    receiptInputHash: receipt.inputHash,
    retryEpoch: receipt.retry.epoch,
    failureClass: receipt.failure.class,
    failureCause: receipt.failure.cause,
    failurePhase: receipt.failure.phase,
    lastSafeFailure: {
      errorClass: receipt.retry.lastSafeFailure.errorClass,
      cause: receipt.retry.lastSafeFailure.cause,
      phase: receipt.retry.lastSafeFailure.phase,
      timestamp: receipt.retry.lastSafeFailure.timestamp,
    },
  };
}

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
    totalChunks: 2,
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

  it("serializes a delayed original request with an absence-authorized fresh retry", async () => {
    const kv = mockKV();
    const operationIdentity = {
      runId: "absence-race-run",
      stage: "memory_consolidate" as const,
      unitId: "absence-race-unit",
      inputHash: "a".repeat(64),
    };
    const probe = await withExtractionOperationReceipt(
      kv as never,
      operationIdentity,
      vi.fn(),
      { requireExisting: true },
    );
    expect(probe.receiptAbsence?.inputHash).toBe(operationIdentity.inputHash);

    let releaseOldRequest!: () => void;
    const oldRequestGate = new Promise<void>((resolve) => {
      releaseOldRequest = resolve;
    });
    let effectStarted!: () => void;
    const effectStartedGate = new Promise<void>((resolve) => {
      effectStarted = resolve;
    });
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const execute = vi.fn(async () => {
      effectStarted();
      await effectGate;
      return { success: true, memoryIds: ["mem-race"] };
    });

    const delayedOldRequest = oldRequestGate.then(() =>
      withExtractionOperationReceipt(kv as never, operationIdentity, execute));
    const freshRetry = withExtractionOperationReceipt(
      kv as never,
      operationIdentity,
      execute,
      { expectedInputHash: probe.receiptAbsence!.inputHash },
    );
    await effectStartedGate;
    releaseOldRequest();
    releaseEffect();

    const [fresh, delayed] = await Promise.all([freshRetry, delayedOldRequest]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fresh.response).toEqual({ success: true, memoryIds: ["mem-race"] });
    expect(delayed.response).toEqual(fresh.response);
  });

  it("rejects service input drift after receipt absence before any effect runs", async () => {
    const kv = mockKV();
    const execute = vi.fn(async () => ({ success: true }));
    const driftedIdentity = {
      runId: "absence-drift-run",
      stage: "skill_extract" as const,
      unitId: "absence-drift-unit",
      inputHash: "b".repeat(64),
    };

    const modelResult = await withExtractionOperationReceipt(
      kv as never,
      driftedIdentity,
      execute,
      { expectedInputHash: "a".repeat(64) },
    );
    const commitResult = await withIdempotentCommitReceipt(
      kv as never,
      { ...driftedIdentity, stage: "memory_consolidate" as const },
      execute,
      { expectedInputHash: "a".repeat(64) },
    );

    expect(modelResult.failure).toEqual({
      class: "hard",
      cause: "extraction_operation_input_hash_drifted_after_absence",
    });
    expect(commitResult.failure).toEqual(modelResult.failure);
    expect(execute).not.toHaveBeenCalled();
    expect(await kv.get(
      KV.extractionOperationReceipt(buildExtractionOperationKey(driftedIdentity)),
      buildExtractionOperationKey(driftedIdentity),
    )).toBeNull();
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

  it("fails closed when a persisted receipt identity is tampered", async () => {
    const kv = mockKV();
    const key = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...identity,
      inputHash: "tampered-input-hash",
      key,
      version: 1,
      status: "succeeded",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z",
      response: { success: true, memoryIds: ["tampered-result"] },
    });
    const execute = vi.fn(async () => ({ success: true, memoryIds: ["new-result"] }));

    const result = await withExtractionOperationReceipt(kv as never, identity, execute);

    expect(result).toMatchObject({
      replayed: true,
      failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
      receipt: { inputHash: "tampered-input-hash" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an out-of-order verified response after the receipt is terminal", async () => {
    const kv = mockKV();
    const first = { success: true, memoryIds: ["canonical-result"] };
    const late = { success: true, memoryIds: ["late-result"] };

    await completeModelOperationFromVerifiedResult(
      kv as never,
      identity,
      first,
      { allowMissing: true },
    );
    const rejected = await completeModelOperationFromVerifiedResult(
      kv as never,
      identity,
      late,
      { allowMissing: true },
    );
    const key = buildExtractionOperationKey(identity);

    expect(rejected).toMatchObject({
      replayed: true,
      response: first,
      receipt: { status: "succeeded", response: first },
    });
    await expect(kv.get(
      KV.extractionOperationReceipt(key),
      key,
    )).resolves.toMatchObject({ status: "succeeded", response: first });
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
      receiptAbsence: {
        schema: "extraction-operation-receipt-absence/v1",
        ...identity,
        key: buildExtractionOperationKey(identity),
        observedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
      },
    });
    expect(result.receipt).toBeUndefined();
    const key = buildExtractionOperationKey(identity);
    await expect(kv.get(KV.extractionOperationReceipt(key), key)).resolves.toBeNull();
  });

  it("materializes a succeeded receipt only from an explicitly verified missing result", async () => {
    const kv = mockKV();
    const verified = { success: true, status: "succeeded", memoryIds: ["mem-1"] };

    const repaired = await completeModelOperationFromVerifiedResult(
      kv as never,
      identity,
      verified,
      { allowMissing: true },
    );
    const replayed = await completeModelOperationFromVerifiedResult(
      kv as never,
      identity,
      { success: true, status: "succeeded", memoryIds: ["different"] },
      { allowMissing: true },
    );

    expect(repaired).toMatchObject({
      replayed: true,
      response: verified,
      receipt: {
        status: "succeeded",
        key: buildExtractionOperationKey(identity),
        response: verified,
      },
    });
    expect(replayed).toMatchObject({
      replayed: true,
      response: verified,
      receipt: { status: "succeeded", response: verified },
    });
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

  it("preserves whitelisted diagnostics and retry metadata for an opt-in safe failure", async () => {
    const kv = mockKV();
    const result = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => ({
        success: false,
        status: "failed",
        retryableReceiptFailure: true,
        failure: {
          class: "transient_provider",
          cause: "network_error",
          phase: "provider_call",
          diagnostics: {
            requestPhase: "reduce",
            providerErrorCode: "network_error",
            elapsedMs: 12,
            inputChars: 34,
            maxOutputTokens: 4096,
            responseStarted: false,
          },
        },
        error: "secret must not persist",
      }),
    );

    expect(result.receipt).toMatchObject({
      status: "failed",
      failure: {
        phase: "provider_call",
        diagnostics: {
          requestPhase: "reduce",
          providerErrorCode: "network_error",
        },
      },
      retry: {
        epoch: 0,
        lastSafeFailure: {
          errorClass: "transient_provider",
          cause: "network_error",
        },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain("secret must not persist");
  });

  it("reopens only require-existing safe failures and preserves retry audit after a later hard failure", async () => {
    const kv = mockKV();
    const execute = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_provider",
          cause: "network_error",
          phase: "provider_call",
        },
      })
      .mockResolvedValueOnce({
        success: false,
        failure: { class: "hard", cause: "pi_auth_failed", phase: "provider_preflight" },
      });

    await withExtractionOperationReceipt(kv as never, identity, execute);
    const ordinaryReplay = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      { retryFailed: true },
    );
    const reopened = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      { retryFailed: true, requireExisting: true },
    );
    const hardReplay = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      { retryFailed: true, requireExisting: true },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(ordinaryReplay).toMatchObject({ replayed: true, failure: { cause: "network_error" } });
    expect(reopened).toMatchObject({ failure: { class: "hard", cause: "pi_auth_failed" } });
    expect(hardReplay).toMatchObject({ replayed: true, failure: { cause: "pi_auth_failed" } });
    expect(reopened.receipt).toMatchObject({
      retry: { epoch: 1, lastSafeFailure: { cause: "network_error" } },
    });
  });

  it("does not reopen when the current safe-looking failure differs from its retry audit", async () => {
    const kv = mockKV();
    const execute = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_provider",
          cause: "network_error",
          phase: "provider_call",
        },
      })
      .mockResolvedValueOnce({
        success: false,
        failure: {
          class: "transient_provider",
          cause: "server_error",
          phase: "provider_call",
        },
      });

    await withExtractionOperationReceipt(kv as never, identity, execute);
    const secondFailure = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      { retryFailed: true, requireExisting: true },
    );
    const replay = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      { retryFailed: true, requireExisting: true },
    );

    expect(secondFailure).toMatchObject({ failure: { cause: "server_error" } });
    expect(replay).toMatchObject({ replayed: true, failure: { cause: "server_error" } });
    expect(replay.receipt).toMatchObject({
      retry: { lastSafeFailure: { cause: "network_error", phase: "provider_call" } },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("consumes one authorized epoch and replays a newer safe failure without reopening it", async () => {
    const kv = mockKV();
    const execute = vi.fn(async () => ({
      success: false,
      status: "failed",
      retryableReceiptFailure: true,
      failure: {
        class: "transient_provider" as const,
        cause: "network_error",
        phase: "provider_call" as const,
      },
    }));

    const first = await withExtractionOperationReceipt(kv as never, identity, execute);
    const epochZeroAuthorization = failedRetryAuthorization(first.receipt);
    const epochOneFailure = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: epochZeroAuthorization,
      },
    );
    const rejected = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: epochZeroAuthorization,
      },
    );

    expect(epochOneFailure.receipt).toMatchObject({
      status: "failed",
      retry: { epoch: 1 },
    });
    expect(rejected).toMatchObject({
      replayed: true,
      failure: {
        class: "transient_provider",
        cause: "network_error",
        phase: "provider_call",
      },
      receipt: { status: "failed", retry: { epoch: 1 } },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("replays a succeeded receipt before checking stale retry authorization", async () => {
    const kv = mockKV();
    const summaryIdentity = {
      ...identity,
      stage: "summary" as const,
      unitId: "summary-unit",
    };
    const first = await withExtractionOperationReceipt(
      kv as never,
      summaryIdentity,
      async () => ({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_provider" as const,
          cause: "network_error",
          phase: "provider_call" as const,
        },
      }),
    );
    const authorization = failedRetryAuthorization(first.receipt);
    const succeeded = await withExtractionOperationReceipt(
      kv as never,
      summaryIdentity,
      async () => ({ success: true, summary: { title: "persisted" } }),
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: authorization,
      },
    );
    const execute = vi.fn(async () => ({ success: true }));

    const replayed = await withExtractionOperationReceipt(
      kv as never,
      summaryIdentity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: authorization,
      },
    );

    expect(succeeded.receipt).toMatchObject({ status: "succeeded", retry: { epoch: 1 } });
    expect(replayed).toMatchObject({
      replayed: true,
      response: { success: true },
      receipt: { status: "succeeded", retry: { epoch: 1 } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns reconciliation for a running receipt before checking stale retry authorization", async () => {
    const kv = mockKV();
    const first = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => ({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_provider" as const,
          cause: "network_error",
          phase: "provider_call" as const,
        },
      }),
    );
    const authorization = failedRetryAuthorization(first.receipt);
    const key = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...first.receipt,
      status: "running",
      completedAt: undefined,
      failure: undefined,
    });
    const execute = vi.fn(async () => ({ success: true }));

    const rejected = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: authorization,
      },
    );

    expect(rejected).toMatchObject({
      replayed: true,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      receipt: { status: "running" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not consume a second epoch after an authorized dispatch crashes", async () => {
    const kv = mockKV();
    const first = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => ({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_runtime" as const,
          cause: "network_error",
          phase: "before_final_persistence" as const,
        },
      }),
    );
    const authorization = failedRetryAuthorization(first.receipt);
    const execute = vi.fn(async () => {
      throw new Error("dispatch_crashed");
    });

    const crashed = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: authorization,
      },
    );
    const resumed = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: authorization,
      },
    );

    expect(crashed).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      receipt: { status: "running", retry: { epoch: 1 } },
    });
    expect(resumed).toMatchObject({
      replayed: true,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      receipt: { status: "running", retry: { epoch: 1 } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects stale authorization when the current failed receipt is no longer safe", async () => {
    const kv = mockKV();
    const first = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => ({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_provider" as const,
          cause: "network_error",
          phase: "provider_call" as const,
        },
      }),
    );
    const authorization = failedRetryAuthorization(first.receipt);
    const key = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...first.receipt,
      failure: {
        class: "hard",
        cause: "provider_auth_failed",
        phase: "provider_preflight",
      },
    });
    const execute = vi.fn(async () => ({ success: true }));

    const rejected = await withExtractionOperationReceipt(
      kv as never,
      identity,
      execute,
      {
        retryFailed: true,
        requireExisting: true,
        failedRetryAuthorization: authorization,
      },
    );

    expect(rejected).toMatchObject({
      replayed: true,
      failure: {
        class: "hard",
        cause: "extraction_operation_retry_authorization_drifted",
      },
      receipt: {
        status: "failed",
        failure: { class: "hard", cause: "provider_auth_failed" },
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["provider_preflight", "final_result_persistence", undefined] as const)(
    "does not reopen a retry opt-in failure outside safe phases: %s",
    async (phase) => {
      const kv = mockKV();
      const execute = vi.fn(async () => ({
        success: false,
        retryableReceiptFailure: true,
        failure: {
          class: "transient_runtime" as const,
          cause: "network_error",
          ...(phase ? { phase } : {}),
        },
      }));

      await withExtractionOperationReceipt(kv as never, identity, execute);
      const replay = await withExtractionOperationReceipt(
        kv as never,
        identity,
        execute,
        { retryFailed: true, requireExisting: true },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(replay).toMatchObject({ replayed: true, receipt: { status: "failed" } });
      expect(replay.receipt?.retry).toBeUndefined();
    },
  );

  it("records only whitelisted uncertainty when final persistence becomes indeterminate", async () => {
    const kv = mockKV();
    const result = await withExtractionOperationReceipt(
      kv as never,
      identity,
      async () => { throw new ExtractionOperationResultUncertainError(); },
    );

    expect(result).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
        phase: "final_result_persistence",
      },
      receipt: {
        status: "running",
        uncertainty: {
          phase: "final_result_persistence",
          errorClass: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
          timestamp: expect.any(String),
        },
      },
    });
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
      configHash: "a".repeat(64),
      semanticRecoveryEvidence: {
        schema: "semantic-rollup-recovery/v1",
        phase: "committed",
        receiptKey: buildExtractionOperationKey(semanticIdentity),
        receiptVersion: 1,
        resultRef: "mem:audit:audit-semantic-1",
        effectHash: "b".repeat(64),
        identity: {
          runId: semanticIdentity.runId,
          unitId: semanticIdentity.unitId,
          receiptInputHash: semanticIdentity.inputHash,
          runnerInputHash: "c".repeat(64),
          extractionRunId: semanticIdentity.runId,
          extractionWindowId: semanticIdentity.unitId,
          inputHash: semanticIdentity.inputHash,
          configHash: "a".repeat(64),
        },
        sourceSummaryHashes: { "session-1": "d".repeat(64) },
      },
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
      configHash: "a".repeat(64),
      semanticRecoveryEvidence: {
        schema: "semantic-rollup-recovery/v1",
        phase: "committed",
        receiptKey: buildExtractionOperationKey(semanticIdentity),
        receiptVersion: 1,
        resultRef: "mem:audit:audit-semantic-1",
        effectHash: "b".repeat(64),
        identity: {
          runId: semanticIdentity.runId,
          unitId: semanticIdentity.unitId,
          receiptInputHash: semanticIdentity.inputHash,
          runnerInputHash: "c".repeat(64),
          extractionRunId: semanticIdentity.runId,
          extractionWindowId: semanticIdentity.unitId,
          inputHash: semanticIdentity.inputHash,
          configHash: "a".repeat(64),
        },
        sourceSummaryHashes: { "session-1": "d".repeat(64) },
      },
      provider: "pi-agent-sdk",
      model: "gpt-test",
      promptChars: 123,
    });
    expect(replay.response).toEqual(first.response);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retains only the strict crystal recovery evidence needed for replay", async () => {
    const kv = mockKV();
    const crystalIdentity = {
      ...identity,
      stage: "crystal" as const,
      unitId: "crystal-group-1",
      inputHash: "c".repeat(64),
    };
    const recoveryEvidence = {
      schema: "crystal-recovery/v1",
      phase: "committed",
      receiptKey: buildExtractionOperationKey(crystalIdentity),
      receiptVersion: 1,
      resultRef: "crystal:crys-1",
      effectHash: "d".repeat(64),
      identity: {
        runId: crystalIdentity.runId,
        unitId: crystalIdentity.unitId,
        inputHash: crystalIdentity.inputHash,
      },
      group: {
        groupId: crystalIdentity.unitId,
        actionIds: ["act-1"],
        actionUpdatedAts: ["2026-07-14T00:00:00.000Z"],
      },
    };

    const result = await withExtractionOperationReceipt(
      kv as never,
      crystalIdentity,
      async () => ({
        success: true,
        crystalIds: ["crys-1"],
        crystalRecoveryEvidence: {
          ...recoveryEvidence,
          arbitraryModelText: "must not survive",
        },
      }),
    );

    expect(result.response).toEqual({
      success: true,
      crystalIds: ["crys-1"],
      crystalRecoveryEvidence: recoveryEvidence,
    });
  });

  it("retains strict reflect identity and structured no-effect evidence", async () => {
    const kv = mockKV();
    const committedIdentity = {
      ...identity,
      stage: "reflect_insight" as const,
      unitId: "reflect-committed",
      inputHash: "e".repeat(64),
    };
    const committedEvidence = {
      schema: "reflect-insight-commit/v1",
      kind: "committed",
      receiptKey: buildExtractionOperationKey(committedIdentity),
      receiptVersion: 1,
      resultRef: `reflect-insight-recoveries:${buildExtractionOperationKey(committedIdentity)}`,
      effectHash: "f".repeat(64),
      identity: {
        runId: committedIdentity.runId,
        unitId: committedIdentity.unitId,
        inputHash: committedIdentity.inputHash,
      },
    };
    const committed = await withExtractionOperationReceipt(
      kv as never,
      committedIdentity,
      async () => ({
        success: true,
        status: "succeeded",
        inputHash: committedIdentity.inputHash,
        insightIds: ["ins-1"],
        reflectRecoveryEvidence: {
          ...committedEvidence,
          arbitraryModelText: "must not survive",
          identity: { ...committedEvidence.identity, arbitrary: "must not survive" },
        },
      }),
    );
    expect(committed.response).toEqual({
      success: true,
      status: "succeeded",
      inputHash: committedIdentity.inputHash,
      insightIds: ["ins-1"],
      reflectRecoveryEvidence: committedEvidence,
    });

    const emptyIdentity = {
      ...committedIdentity,
      unitId: "reflect-empty",
      inputHash: "a".repeat(64),
    };
    const noEffectEvidence = {
      kind: "no_effect",
      observation: "business_empty",
      reasonCode: "no_novel_insight",
      identity: {
        runId: emptyIdentity.runId,
        unitId: emptyIdentity.unitId,
        inputHash: emptyIdentity.inputHash,
      },
      proof: {
        kind: "committed_structured_no_effect",
        receiptKey: buildExtractionOperationKey(emptyIdentity),
        receiptVersion: 1,
        schema: "reflect-insight-no-effect/v1",
        proposalHash: "b".repeat(64),
        reasonCode: "no_novel_insight",
        proofHash: "c".repeat(64),
      },
    };
    const empty = await withExtractionOperationReceipt(
      kv as never,
      emptyIdentity,
      async () => ({
        success: true,
        status: "skipped",
        inputHash: emptyIdentity.inputHash,
        insightIds: [],
        reflectRecoveryEvidence: {
          ...noEffectEvidence,
          arbitraryModelText: "must not survive",
        },
      }),
    );
    expect(empty.response).toEqual({
      success: true,
      status: "skipped",
      inputHash: emptyIdentity.inputHash,
      insightIds: [],
      reflectRecoveryEvidence: noEffectEvidence,
    });
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

  it("projects only receipt-bound procedural business-empty recovery evidence", async () => {
    const kv = mockKV();
    const proceduralIdentity = {
      runId: "procedural-run",
      stage: "consolidation_procedural" as const,
      unitId: "cpw-1",
      inputHash: "a".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey(proceduralIdentity);
    const result = await withExtractionOperationReceipt(kv as never, proceduralIdentity, async () => ({
      success: true,
      status: "skipped",
      inputHash: proceduralIdentity.inputHash,
      proceduralRecoveryEvidence: {
        kind: "no_effect",
        observation: "business_empty",
        reasonCode: "fewer_than_2_recurring_patterns",
        identity: {
          runId: proceduralIdentity.runId,
          unitId: proceduralIdentity.unitId,
          inputHash: proceduralIdentity.inputHash,
        },
        proof: {
          kind: "receipt_before_formal_effect",
          receiptKey,
          receiptVersion: 1,
          phase: "candidate_staging",
          commitPlanAbsent: true,
        },
        rawModelText: "must not persist",
      },
    }));

    expect(result.response).toMatchObject({
      proceduralRecoveryEvidence: {
        kind: "no_effect",
        identity: {
          runId: proceduralIdentity.runId,
          unitId: proceduralIdentity.unitId,
          inputHash: proceduralIdentity.inputHash,
        },
        proof: { receiptKey, commitPlanAbsent: true },
      },
    });
    expect(JSON.stringify(result.response)).not.toContain("rawModelText");
  });

  it("projects only receipt-bound committed procedural no-effect evidence", async () => {
    const kv = mockKV();
    const proceduralIdentity = {
      runId: "procedural-empty-run",
      stage: "consolidation_procedural" as const,
      unitId: "cpw-empty-1",
      inputHash: "b".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey(proceduralIdentity);
    const result = await withExtractionOperationReceipt(kv as never, proceduralIdentity, async () => ({
      success: true,
      status: "skipped",
      inputHash: proceduralIdentity.inputHash,
      proceduralMemoryIds: [],
      proceduralRecoveryEvidence: {
        kind: "no_effect",
        observation: "business_empty",
        reasonCode: "no_reusable_procedure",
        identity: {
          runId: proceduralIdentity.runId,
          unitId: proceduralIdentity.unitId,
          inputHash: proceduralIdentity.inputHash,
        },
        proof: {
          kind: "committed_structured_no_effect",
          receiptKey,
          receiptVersion: 1,
          schema: "consolidation-procedural-no-effect/v1",
          proposalHash: "c".repeat(64),
          reasonCode: "no_reusable_procedure",
          proofHash: "d".repeat(64),
        },
        rawModelText: "must not persist",
      },
    }));

    expect(result.response).toMatchObject({
      proceduralMemoryIds: [],
      proceduralRecoveryEvidence: {
        kind: "no_effect",
        observation: "business_empty",
        reasonCode: "no_reusable_procedure",
        proof: {
          kind: "committed_structured_no_effect",
          receiptKey,
          schema: "consolidation-procedural-no-effect/v1",
        },
      },
    });
    expect(JSON.stringify(result.response)).not.toContain("rawModelText");
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
          version: 1,
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
            phase: "provider_call",
            diagnostics: { rawMessage: "must-not-cross-boundary" },
          },
          retry: {
            epoch: 2,
            lastSafeFailure: {
              errorClass: "transient_provider",
              cause: "pi_stream_failed",
              phase: "provider_call",
              timestamp: "2026-07-24T00:00:59.000Z",
              diagnostics: { rawMessage: "must-not-cross-boundary" },
            },
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
          ...("version" in entry.receipt ? { version: entry.receipt.version } : {}),
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
                  ...("phase" in entry.receipt.failure
                    ? { phase: entry.receipt.failure.phase }
                    : {}),
                },
                ...("retry" in entry.receipt
                  ? {
                      retry: {
                        epoch: entry.receipt.retry.epoch,
                        lastSafeFailure: {
                          errorClass: entry.receipt.retry.lastSafeFailure.errorClass,
                          cause: entry.receipt.retry.lastSafeFailure.cause,
                          phase: entry.receipt.retry.lastSafeFailure.phase,
                          timestamp: entry.receipt.retry.lastSafeFailure.timestamp,
                        },
                      },
                    }
                  : {}),
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
    const runtimeKV = {
      ...kv,
      get: async <T>(scope: string, key: string): Promise<T | null | undefined> =>
        scope === KV.summaries ? undefined : kv.get<T>(scope, key),
    };
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, runtimeKV as never);
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

  it("reconciles an exact orphaned summary map receipt only when its partial is absent", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const mapIdentity = {
      ...orphanIdentity,
      unitId: `${orphanReconciliationInput.result.sessionId}:map:1`,
    };
    const mapKey = buildExtractionOperationKey(mapIdentity);
    await kv.set(KV.extractionOperationReceipt(mapKey), mapKey, {
      ...mapIdentity,
      key: mapKey,
      status: "running",
      startedAt: orphanReconciliationInput.operation.expectedStartedAt,
    });
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const reconcile = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;
    const mapInput = {
      ...orphanReconciliationInput,
      operation: {
        ...orphanReconciliationInput.operation,
        unitId: mapIdentity.unitId,
      },
    };

    await expect(reconcile(mapInput)).resolves.toMatchObject({
      success: true,
      replayed: false,
      operation: mapIdentity,
      receipt: {
        status: "reconciled",
        failure: { cause: "orphaned_operation_result_absent" },
      },
    });
  });

  it("refuses summary map orphan reconciliation when the exact partial exists", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const mapIdentity = {
      ...orphanIdentity,
      unitId: `${orphanReconciliationInput.result.sessionId}:map:1`,
    };
    const mapKey = buildExtractionOperationKey(mapIdentity);
    await kv.set(KV.extractionOperationReceipt(mapKey), mapKey, {
      ...mapIdentity,
      key: mapKey,
      status: "running",
      startedAt: orphanReconciliationInput.operation.expectedStartedAt,
    });
    await kv.set(
      KV.summaryResumablePartials(orphanReconciliationInput.result.resumableRunId),
      "1",
      {
        runId: orphanReconciliationInput.result.resumableRunId,
        chunkIndex: 1,
        status: "completed",
        summary: { title: "persisted map result" },
        createdAt: "2026-07-26T17:44:07.700Z",
      },
    );
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const reconcile = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;

    await expect(reconcile({
      ...orphanReconciliationInput,
      operation: {
        ...orphanReconciliationInput.operation,
        unitId: mapIdentity.unitId,
      },
    })).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_result_present",
      },
    });
  });

  it("treats a malformed summary map partial as binding drift, not as absence", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const mapIdentity = {
      ...orphanIdentity,
      unitId: `${orphanReconciliationInput.result.sessionId}:map:1`,
    };
    const mapKey = buildExtractionOperationKey(mapIdentity);
    await kv.set(KV.extractionOperationReceipt(mapKey), mapKey, {
      ...mapIdentity,
      key: mapKey,
      status: "running",
      startedAt: orphanReconciliationInput.operation.expectedStartedAt,
    });
    await kv.set(
      KV.summaryResumablePartials(orphanReconciliationInput.result.resumableRunId),
      "1",
      {
        runId: orphanReconciliationInput.result.resumableRunId,
        chunkIndex: 1,
        status: "skipped",
        createdAt: "2026-07-26T17:44:07.700Z",
      },
    );
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const reconcile = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;

    await expect(reconcile({
      ...orphanReconciliationInput,
      operation: {
        ...orphanReconciliationInput.operation,
        unitId: mapIdentity.unitId,
      },
    })).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_result_binding_drifted",
      },
    });
  });

  it("reconciles generic protocol-state orphans but rejects persisted stage recovery", async () => {
    const kv = mockKV();
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const reconcile = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;
    const operation = {
      runId: "7".repeat(64),
      stage: "semantic_rollup" as const,
      unitId: "semantic-unit",
      inputHash: "8".repeat(64),
    };
    const key = buildExtractionOperationKey(operation);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...operation,
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    const input = {
      operation: {
        ...operation,
        expectedStatus: "running",
        expectedStartedAt: "2026-07-30T00:00:00.000Z",
      },
      result: {
        kind: "protocol_state",
        phase: "execute",
        runnerInputHash: "9".repeat(64),
      },
    };

    await expect(reconcile(input)).resolves.toMatchObject({
      success: true,
      replayed: false,
      operation,
      receipt: {
        status: "reconciled",
        failure: { cause: "orphaned_operation_result_absent" },
      },
      reconciliation: { resultStatus: "absent" },
    });

    const stagedOperation = {
      ...operation,
      runId: "a".repeat(64),
    };
    const stagedKey = buildExtractionOperationKey(stagedOperation);
    await kv.set(KV.extractionOperationReceipt(stagedKey), stagedKey, {
      ...stagedOperation,
      key: stagedKey,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:02:00.000Z",
      semanticRecovery: {
        schema: "semantic-rollup-recovery/v1",
        phase: "staged",
        identity: {
          runId: stagedOperation.runId,
          unitId: stagedOperation.unitId,
          receiptInputHash: stagedOperation.inputHash,
        },
      },
    });
    await expect(reconcile({
      ...input,
      operation: {
        ...stagedOperation,
        expectedStatus: "running",
        expectedStartedAt: "2026-07-30T00:02:00.000Z",
      },
    })).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_result_present",
      },
    });
  });

  it("requires a server-side proposal absence check for prepare reconciliation", async () => {
    const kv = mockKV();
    const operation = {
      runId: "b".repeat(64),
      stage: "memory_consolidate" as const,
      unitId: "memory-unit",
      inputHash: "c".repeat(64),
    };
    const key = buildExtractionOperationKey(operation);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...operation,
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:03:00.000Z",
    });
    const input = {
      operation: {
        ...operation,
        expectedStatus: "running",
        expectedStartedAt: "2026-07-30T00:03:00.000Z",
      },
      result: {
        kind: "protocol_state",
        phase: "prepare",
        runnerInputHash: "d".repeat(64),
      },
    };

    const withoutVerifier = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => withoutVerifier.set(id, handler),
    } as never, kv as never);
    await expect(withoutVerifier.get(
      "mem::extraction-operation-receipt-reconcile-orphan",
    )!(input)).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_result_binding_drifted",
      },
    });

    const findMemoryProposal = vi.fn(async () => null);
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never, { findMemoryProposal });
    await expect(functions.get(
      "mem::extraction-operation-receipt-reconcile-orphan",
    )!(input)).resolves.toMatchObject({
      success: true,
      receipt: { status: "reconciled" },
    });
    expect(findMemoryProposal).toHaveBeenCalledWith(kv, {
      runId: operation.runId,
      stage: operation.stage,
      unitId: operation.unitId,
      inputHash: input.result.runnerInputHash,
    });
  });

  it("requires a server-side lesson result absence proof before reconciling", async () => {
    const kv = mockKV();
    const operation = {
      runId: "e".repeat(64),
      stage: "lessons" as const,
      unitId: "lesson-unit",
      inputHash: "f".repeat(64),
    };
    const key = buildExtractionOperationKey(operation);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...operation,
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:05:00.000Z",
    });
    const input = {
      operation: {
        ...operation,
        expectedStatus: "running",
        expectedStartedAt: "2026-07-30T00:05:00.000Z",
      },
      result: {
        kind: "protocol_state",
        phase: "execute",
        runnerInputHash: "a".repeat(64),
      },
    };

    const absent = vi.fn(async () => "absent" as const);
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never, { verifyLessonResult: absent });
    await expect(functions.get(
      "mem::extraction-operation-receipt-reconcile-orphan",
    )!(input)).resolves.toMatchObject({
      success: true,
      receipt: { status: "reconciled" },
      reconciliation: { resultStatus: "absent" },
    });
    expect(absent).toHaveBeenCalledWith(
      kv,
      operation,
      input.result.runnerInputHash,
    );

    const presentKv = mockKV();
    await presentKv.set(KV.extractionOperationReceipt(key), key, {
      ...operation,
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:05:00.000Z",
    });
    const presentFunctions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => presentFunctions.set(id, handler),
    } as never, presentKv as never, {
      verifyLessonResult: async () => "present",
    });
    await expect(presentFunctions.get(
      "mem::extraction-operation-receipt-reconcile-orphan",
    )!(input)).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_result_present",
      },
    });
  });

  it("persists a fresh running boundary before re-executing a reconciled receipt", async () => {
    const kv = mockKV();
    await seedOrphanedSummaryOperation(kv);
    const key = buildExtractionOperationKey(orphanIdentity);
    const seeded = await kv.get<Record<string, unknown>>(
      KV.extractionOperationReceipt(key),
      key,
    );
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...seeded,
      retry: {
        epoch: 1,
        lastSafeFailure: {
          errorClass: "transient_provider",
          cause: "pi_stream_failed",
          phase: "provider_call",
          timestamp: "2026-07-26T17:44:07.000Z",
        },
      },
      uncertainty: {
        phase: "final_result_persistence",
        errorClass: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
        timestamp: "2026-07-26T17:44:07.500Z",
      },
    });
    const functions = new Map<string, Function>();
    registerExtractionOperationReceiptFunctions({
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    } as never, kv as never);
    const reconcile = functions.get("mem::extraction-operation-receipt-reconcile-orphan")!;
    const firstReconciliation = await reconcile(orphanReconciliationInput);
    let runningBeforeExecute: Record<string, unknown> | null = null;

    const interrupted = await withExtractionOperationReceipt(
      kv as never,
      orphanIdentity,
      async () => {
        runningBeforeExecute = await kv.get<Record<string, unknown>>(
          KV.extractionOperationReceipt(key),
          key,
        );
        throw new ExtractionOperationResultUncertainError();
      },
    );

    expect(runningBeforeExecute).toMatchObject({
      ...orphanIdentity,
      key,
      status: "running",
      startedAt: expect.any(String),
      retry: {
        epoch: 1,
        lastSafeFailure: {
          cause: "pi_stream_failed",
          phase: "provider_call",
        },
      },
    });
    expect(runningBeforeExecute?.startedAt).not.toBe(
      orphanReconciliationInput.operation.expectedStartedAt,
    );
    expect(Date.parse(String(runningBeforeExecute?.startedAt))).toBeGreaterThan(
      Date.parse(firstReconciliation.reconciliation.at),
    );
    for (const staleField of [
      "completedAt",
      "response",
      "failure",
      "reconciliation",
      "uncertainty",
    ]) {
      expect(runningBeforeExecute).not.toHaveProperty(staleField);
    }
    expect(interrupted).toMatchObject({
      replayed: false,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
        phase: "final_result_persistence",
      },
      receipt: {
        status: "running",
        startedAt: runningBeforeExecute?.startedAt,
        retry: { epoch: 1 },
        uncertainty: {
          cause: "extraction_operation_reconciliation_required",
        },
      },
    });
    await expect(kv.get<Record<string, unknown>>(
      KV.extractionOperationReceipt(key),
      key,
    )).resolves.toMatchObject({
      status: "running",
      startedAt: runningBeforeExecute?.startedAt,
      retry: { epoch: 1 },
    });

    await expect(reconcile(orphanReconciliationInput)).resolves.toEqual({
      success: false,
      failure: {
        class: "hard",
        cause: "orphan_reconciliation_evidence_drifted",
      },
    });
    const freshReconciliation = await reconcile({
      ...orphanReconciliationInput,
      operation: {
        ...orphanReconciliationInput.operation,
        expectedStartedAt: runningBeforeExecute!.startedAt,
      },
    });
    expect(freshReconciliation).toMatchObject({
      success: true,
      replayed: false,
      receipt: {
        status: "reconciled",
        startedAt: runningBeforeExecute?.startedAt,
        retry: { epoch: 1 },
      },
      reconciliation: {
        id: expect.stringMatching(/^xrec_[0-9a-f]{32}$/),
        resultStatus: "absent",
      },
    });
    expect(freshReconciliation.reconciliation.id).not.toBe(
      firstReconciliation.reconciliation.id,
    );
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

  it("re-enters a staged reflect receipt under the same identity", async () => {
    const kv = mockKV();
    const reflectIdentity = {
      runId: "reflect-run",
      stage: "reflect_insight" as const,
      unitId: "reflect-unit",
      inputHash: "reflect-input",
    };
    const key = buildExtractionOperationKey(reflectIdentity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...reflectIdentity,
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
      reflectRecovery: {
        schema: "reflect-insight-recovery/v1",
        phase: "staged",
        identity: {
          runId: reflectIdentity.runId,
          unitId: reflectIdentity.unitId,
          inputHash: reflectIdentity.inputHash,
        },
      },
    });
    const execute = vi.fn(async () => ({ success: true, status: "succeeded" }));

    const result = await withExtractionOperationReceipt(
      kv as never,
      reflectIdentity,
      execute,
      { requireExisting: true },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.response).toMatchObject({ success: true, status: "succeeded" });
    await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
      .resolves.toMatchObject({ status: "succeeded" });
  });

  it("re-enters a staged procedural receipt under the same identity", async () => {
    const kv = mockKV();
    const proceduralIdentity = {
      runId: "procedural-run",
      stage: "consolidation_procedural" as const,
      unitId: "procedural-unit",
      inputHash: "procedural-input",
    };
    const key = buildExtractionOperationKey(proceduralIdentity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...proceduralIdentity,
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
      proceduralRecovery: {
        schema: "consolidation-procedural-recovery/v1",
        phase: "staged",
        identity: {
          runId: proceduralIdentity.runId,
          unitId: proceduralIdentity.unitId,
          inputHash: proceduralIdentity.inputHash,
        },
      },
    });
    const execute = vi.fn(async () => ({ success: true, status: "succeeded" }));

    const result = await withExtractionOperationReceipt(
      kv as never,
      proceduralIdentity,
      execute,
      { requireExisting: true },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.response).toMatchObject({ success: true, status: "succeeded" });
    await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
      .resolves.toMatchObject({ status: "succeeded" });
  });

  it.each([
    ["semantic_rollup", "semantic"],
    ["crystal", "crystal"],
  ] as const)(
    "does not re-enter a running %s receipt without a frozen stage plan",
    async (stage, prefix) => {
      const kv = mockKV();
      const stageIdentity = {
        runId: `${prefix}-run`,
        stage,
        unitId: `${prefix}-unit`,
        inputHash: `${prefix}-input`,
      };
      const key = buildExtractionOperationKey(stageIdentity);
      await kv.set(KV.extractionOperationReceipt(key), key, {
        ...stageIdentity,
        key,
        version: 1,
        status: "running",
        startedAt: "2026-07-30T00:00:00.000Z",
      });
      const execute = vi.fn(async () => ({ success: true, status: "succeeded" }));

      const result = await withExtractionOperationReceipt(
        kv as never,
        stageIdentity,
        execute,
        { requireExisting: true },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        failure: {
          class: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
        },
      });
      await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
        .resolves.toMatchObject({ status: "running" });
    },
  );

  it.each([
    ["semantic_rollup", "semantic", "semanticRecovery", "semantic-rollup-recovery/v1"],
    ["crystal", "crystal", "crystalRecovery", "crystal-recovery/v1"],
  ] as const)(
    "re-enters a running %s receipt only with a matching frozen stage plan",
    async (stage, prefix, recoveryField, schema) => {
      const kv = mockKV();
      const stageIdentity = {
        runId: `${prefix}-run`,
        stage,
        unitId: `${prefix}-unit`,
        inputHash: `${prefix}-input`,
      };
      const key = buildExtractionOperationKey(stageIdentity);
      const recoveryIdentity = stage === "semantic_rollup"
        ? {
          runId: stageIdentity.runId,
          unitId: stageIdentity.unitId,
          receiptInputHash: stageIdentity.inputHash,
        }
        : {
          runId: stageIdentity.runId,
          unitId: stageIdentity.unitId,
          inputHash: stageIdentity.inputHash,
        };
      await kv.set(KV.extractionOperationReceipt(key), key, {
        ...stageIdentity,
        key,
        version: 1,
        status: "running",
        startedAt: "2026-07-30T00:00:00.000Z",
        [recoveryField]: {
          schema,
          phase: "staged",
          identity: recoveryIdentity,
        },
      });
      const execute = vi.fn(async () => ({ success: true, status: "succeeded" }));

      const result = await withExtractionOperationReceipt(
        kv as never,
        stageIdentity,
        execute,
        { requireExisting: true },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.response).toMatchObject({ success: true, status: "succeeded" });
      await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
        .resolves.toMatchObject({
          status: "succeeded",
          [recoveryField]: { schema, phase: "staged" },
        });
    },
  );

  it("re-verifies a succeeded semantic receipt and preserves its committed recovery plan", async () => {
    const kv = mockKV();
    const semanticIdentity = {
      runId: "semantic-verify-run",
      stage: "semantic_rollup" as const,
      unitId: "semantic-verify-unit",
      inputHash: "e".repeat(64),
    };
    const key = buildExtractionOperationKey(semanticIdentity);
    const semanticRecovery = {
      schema: "semantic-rollup-recovery/v1",
      phase: "committed",
      identity: {
        runId: semanticIdentity.runId,
        unitId: semanticIdentity.unitId,
        receiptInputHash: semanticIdentity.inputHash,
      },
      expectedFacts: [{ id: "sem-1" }],
    };
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...semanticIdentity,
      key,
      version: 1,
      status: "succeeded",
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:01:00.000Z",
      response: { success: true, status: "succeeded", semanticMemoryIds: ["sem-1"] },
      semanticRecovery,
    });
    const execute = vi.fn(async () => ({
      success: true,
      status: "succeeded",
      semanticMemoryIds: ["sem-1", "sem-2"],
    }));

    const result = await withExtractionOperationReceipt(
      kv as never,
      semanticIdentity,
      execute,
      { requireExisting: true },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      replayed: true,
      response: { semanticMemoryIds: ["sem-1", "sem-2"] },
      receipt: {
        status: "succeeded",
        semanticRecovery,
      },
    });
  });

  it("keeps a staged semantic receipt running when the domain reports a non-hard failure", async () => {
    const kv = mockKV();
    const semanticIdentity = {
      runId: "semantic-failure-run",
      stage: "semantic_rollup" as const,
      unitId: "semantic-failure-unit",
      inputHash: "a".repeat(64),
    };
    const key = buildExtractionOperationKey(semanticIdentity);
    const semanticRecovery = {
      schema: "semantic-rollup-recovery/v1",
      phase: "staged",
      identity: {
        runId: semanticIdentity.runId,
        unitId: semanticIdentity.unitId,
        receiptInputHash: semanticIdentity.inputHash,
      },
    };

    const result = await withExtractionOperationReceipt(
      kv as never,
      semanticIdentity,
      async () => {
        const running = await kv.get<Record<string, unknown>>(
          KV.extractionOperationReceipt(key),
          key,
        );
        await kv.set(KV.extractionOperationReceipt(key), key, {
          ...running,
          semanticRecovery,
        });
        return {
          success: false,
          failure: { class: "transient_runtime", cause: "semantic_commit_uncertain" },
        };
      },
    );

    expect(result).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      receipt: { status: "running", semanticRecovery },
    });
    await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
      .resolves.toMatchObject({ status: "running", semanticRecovery });
  });

  it("preserves staged semantic recovery evidence on a hard failed receipt", async () => {
    const kv = mockKV();
    const semanticIdentity = {
      runId: "semantic-hard-run",
      stage: "semantic_rollup" as const,
      unitId: "semantic-hard-unit",
      inputHash: "b".repeat(64),
    };
    const key = buildExtractionOperationKey(semanticIdentity);
    const semanticRecovery = {
      schema: "semantic-rollup-recovery/v1",
      phase: "staged",
      identity: {
        runId: semanticIdentity.runId,
        unitId: semanticIdentity.unitId,
        receiptInputHash: semanticIdentity.inputHash,
      },
    };

    const result = await withExtractionOperationReceipt(
      kv as never,
      semanticIdentity,
      async () => {
        const running = await kv.get<Record<string, unknown>>(
          KV.extractionOperationReceipt(key),
          key,
        );
        await kv.set(KV.extractionOperationReceipt(key), key, {
          ...running,
          semanticRecovery,
        });
        return {
          success: false,
          failure: { class: "hard", cause: "semantic_rollup_commit_conflict" },
        };
      },
    );

    expect(result).toMatchObject({
      failure: { class: "hard", cause: "semantic_rollup_commit_conflict" },
      receipt: { status: "failed", semanticRecovery },
    });
    await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
      .resolves.toMatchObject({ status: "failed", semanticRecovery });
  });

  it("keeps a staged crystal receipt running when commit verification is uncertain", async () => {
    const kv = mockKV();
    const crystalIdentity = {
      runId: "crystal-failure-run",
      stage: "crystal" as const,
      unitId: "crystal-failure-unit",
      inputHash: "c".repeat(64),
    };
    const key = buildExtractionOperationKey(crystalIdentity);
    const crystalRecovery = {
      schema: "crystal-recovery/v1",
      phase: "staged",
      identity: {
        runId: crystalIdentity.runId,
        unitId: crystalIdentity.unitId,
        inputHash: crystalIdentity.inputHash,
      },
    };

    const result = await withIdempotentCommitReceipt(
      kv as never,
      crystalIdentity,
      async () => {
        const running = await kv.get<Record<string, unknown>>(
          KV.extractionOperationReceipt(key),
          key,
        );
        await kv.set(KV.extractionOperationReceipt(key), key, {
          ...running,
          crystalRecovery,
        });
        return {
          success: false,
          failure: { class: "transient_runtime", cause: "crystal_commit_uncertain" },
        };
      },
    );

    expect(result).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      receipt: { status: "running", crystalRecovery },
    });
    await expect(kv.get<Record<string, unknown>>(KV.extractionOperationReceipt(key), key))
      .resolves.toMatchObject({ status: "running", crystalRecovery });
  });

  it("returns exact absence evidence instead of executing a missing recovered commit", async () => {
    const kv = mockKV();
    const commit = vi.fn(async () => ({ success: true, status: "succeeded" }));
    const commitIdentity = {
      runId: "missing-commit-run",
      stage: "memory_consolidate" as const,
      unitId: "missing-commit-unit",
      inputHash: "a".repeat(64),
    };

    const result = await withIdempotentCommitReceipt(
      kv as never,
      commitIdentity,
      commit,
      { requireExisting: true },
    );

    expect(commit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      receiptAbsence: {
        schema: "extraction-operation-receipt-absence/v1",
        ...commitIdentity,
        key: buildExtractionOperationKey(commitIdentity),
      },
    });
  });

  it.each(["memory_consolidate", "skill_extract"] as const)(
    "re-verifies a succeeded %s commit receipt through its domain callback",
    async (stage) => {
      const kv = mockKV();
      const commitIdentity = {
        runId: `${stage}-run`,
        stage,
        unitId: `${stage}-unit`,
        inputHash: `${stage}-input`,
      };
      const key = buildExtractionOperationKey(commitIdentity);
      await kv.set(KV.extractionOperationReceipt(key), key, {
        ...commitIdentity,
        key,
        version: 1,
        status: "succeeded",
        startedAt: "2026-07-30T00:00:00.000Z",
        completedAt: "2026-07-30T00:00:01.000Z",
        response: { success: true, status: "succeeded" },
      });
      const domainEffectEvidence = {
        schema: stage === "memory_consolidate"
          ? "memory-consolidate-domain-effect/v1"
          : "skill-extract-domain-effect/v1",
        proposalHash: `${stage}-proposal`,
        resultId: `${stage}-result`,
        auditId: `${stage}-audit`,
        effectHash: "a".repeat(64),
      };
      const verify = vi.fn(async () => ({
        success: true,
        status: "succeeded",
        ...(stage === "memory_consolidate"
          ? { memoryIds: [domainEffectEvidence.resultId] }
          : {
              proceduralMemoryIds: [domainEffectEvidence.resultId],
              skill: {
                id: domainEffectEvidence.resultId,
                name: "must not enter recovery state",
                triggerCondition: "sensitive trigger",
                steps: ["sensitive step"],
              },
            }),
        domainEffectEvidence,
      }));

      const result = await withIdempotentCommitReceipt(
        kv as never,
        commitIdentity,
        verify,
        { requireExisting: true },
      );

      expect(verify).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        replayed: true,
        response: { success: true, status: "succeeded", domainEffectEvidence },
        receipt: { status: "succeeded", response: { domainEffectEvidence } },
      });
      expect(result.response).not.toHaveProperty("skill");
      expect(result.receipt.response).not.toHaveProperty("skill");
    },
  );

  it("retains only a strict committed memory no-effect proof in the receipt projection", async () => {
    const kv = mockKV();
    const identity = {
      runId: "memory-no-effect-run",
      stage: "memory_consolidate" as const,
      unitId: "memory-no-effect-unit",
      inputHash: "memory-no-effect-input",
    };
    const key = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(key), key, {
      ...identity,
      key,
      version: 1,
      status: "succeeded",
      startedAt: "2026-08-02T00:00:00.000Z",
      completedAt: "2026-08-02T00:00:01.000Z",
      response: { success: true, status: "skipped", consolidated: 0, memoryIds: [] },
    });
    const noEffectEvidence = {
      schema: "memory-consolidate-no-effect/v1",
      proposalHash: "proposal-no-effect",
      reasonCode: "no_durable_memory",
      proofHash: "b".repeat(64),
    };
    const verify = vi.fn(async () => ({
      success: true,
      status: "skipped",
      consolidated: 0,
      memoryIds: [],
      noEffectEvidence,
      sensitive: "must be dropped",
    }));

    const result = await withIdempotentCommitReceipt(
      kv as never,
      identity,
      verify,
      { requireExisting: true },
    );

    expect(result).toMatchObject({
      replayed: true,
      response: { noEffectEvidence },
      receipt: { response: { noEffectEvidence } },
    });
    expect(result.response).not.toHaveProperty("sensitive");
    expect(result.receipt.response).not.toHaveProperty("sensitive");
  });
});
