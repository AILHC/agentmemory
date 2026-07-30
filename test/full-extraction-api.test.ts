import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import {
  buildExtractionOperationKey,
  registerExtractionOperationReceiptFunctions,
} from "../src/functions/extraction-operation-receipts.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { fingerprintId, KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import {
  mainForTest as runFullExtractionV2,
  stableHash as stableV2Hash,
} from "../ops/scripts/run-agentmemory-full-extraction.mjs";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
  };
}

function mockSdk(triggerImpl?: (input: { function_id: string; payload: unknown }) => Promise<unknown>) {
  const functions = new Map<string, Function>();
  const trigger = vi.fn(triggerImpl ?? (async (input: { function_id: string; payload: unknown }) => ({
    success: true,
    functionId: input.function_id,
    payload: input.payload,
  })));
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger,
    getFunction: (id: string): Function => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn;
    },
  };
}

function stableHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function sessionInputHash(sessionId: string, startedAt: string): string {
  return stableHash({ session_id: sessionId, started_at: startedAt });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("full extraction REST wrappers", () => {
  it("replays a v2 memory prepare response with its proposal handle", async () => {
    const sdk = mockSdk(async () => ({
      success: true,
      status: "prepared",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
      totalObservations: 2,
    }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const body = {
      runId: "prepare-attempt-1",
      stage: "memory_consolidate",
      unitId: "window-1",
      inputHash: "input-1",
      concept: "windows",
      sourceObservationIds: ["obs-1"],
    };
    const handler = sdk.getFunction("api::full-memory-consolidate-window-prepare");

    const first = await handler({ headers: {}, body });
    const replay = await handler({ headers: {}, body });

    expect(first.status_code).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.body).toMatchObject({ preparedHandle: "mcph-1", proposalHash: "proposal-1" });
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::full-memory-consolidate-window-prepare",
      payload: expect.objectContaining({ operationReceiptManaged: true }),
    });
  });

  it("hard-stops an orphaned v2 memory prepare receipt", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const identity = {
      runId: "prepare-orphaned",
      stage: "memory_consolidate" as const,
      unitId: "window-1",
      inputHash: "input-1",
    };
    const receiptIdentity = {
      ...identity,
      inputHash: stableHash({
        runnerInputHash: identity.inputHash,
        payload: {
          identity,
          concept: "windows",
          observationIds: ["obs-1"],
        },
      }),
    };
    const receiptKey = buildExtractionOperationKey(receiptIdentity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...receiptIdentity,
      key: receiptKey,
      status: "running",
      startedAt: "2026-07-24T00:00:00.000Z",
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: { ...identity, concept: "windows", sourceObservationIds: ["obs-1"] },
    });

    expect(response.status_code).toBe(503);
    expect(response.body).toMatchObject({
      failure: { class: "transient_runtime", cause: "extraction_operation_reconciliation_required" },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("hard-stops a recovered memory prepare when the receipt is missing", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: {
        runId: "prepare-missing",
        stage: "memory_consolidate",
        unitId: "window-1",
        inputHash: "input-1",
        concept: "windows",
        sourceObservationIds: ["obs-1"],
        requireExistingReceipt: true,
      },
    });

    expect(response.status_code).toBe(503);
    expect(response.body).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("replays a v2 memory prepare direct terminal without dispatching it twice", async () => {
    const sdk = mockSdk(async () => ({
      success: true,
      status: "skipped",
      consolidated: 0,
      totalObservations: 0,
    }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const body = {
      runId: "prepare-terminal-1",
      stage: "memory_consolidate",
      unitId: "window-empty",
      inputHash: "input-empty",
      concept: "windows",
      sourceObservationIds: [],
    };
    const handler = sdk.getFunction("api::full-memory-consolidate-window-prepare");

    const first = await handler({ headers: {}, body });
    const replay = await handler({ headers: {}, body });

    expect(first.status_code).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.body).toMatchObject({ status: "skipped", consolidated: 0 });
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
  });

  it("reconciles an orphaned v2 memory prepare receipt from its persisted proposal", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const identity = {
      runId: "prepare-reconciled",
      stage: "memory_consolidate" as const,
      unitId: "window-1",
      inputHash: "input-1",
    };
    const receiptIdentity = {
      ...identity,
      inputHash: stableHash({
        runnerInputHash: identity.inputHash,
        payload: {
          identity,
          concept: "windows",
          observationIds: ["obs-1"],
        },
      }),
    };
    const receiptKey = buildExtractionOperationKey(receiptIdentity);
    const proposalKey = fingerprintId("mcp", JSON.stringify([
      identity.runId,
      identity.stage,
      identity.unitId,
    ]));
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...receiptIdentity,
      key: receiptKey,
      status: "running",
      startedAt: "2026-07-24T00:00:00.000Z",
    });
    await kv.set(KV.memoryConsolidationProposal(proposalKey), proposalKey, {
      ...identity,
      key: proposalKey,
      handle: "mcph-1",
      proposalHash: "proposal-1",
      status: "prepared",
      preparedAt: "2026-07-24T00:00:01.000Z",
      concept: "windows",
      sourceObservationIds: ["obs-1"],
      parsed: {},
      totalObservations: 1,
      promptChars: 42,
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: { ...identity, concept: "windows", sourceObservationIds: ["obs-1"] },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      status: "prepared",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
    expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey)).toMatchObject({
      status: "succeeded",
    });
  });

  it("replays a v2 memory commit with an identity distinct from prepare", async () => {
    const sdk = mockSdk(async () => ({
      success: true,
      status: "succeeded",
      consolidated: 1,
      memoryIds: ["mem-1"],
    }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const commitInputHash = stableHash({
      prepareRunId: "prepare-attempt-1",
      unitId: "window-1",
      prepareInputHash: "prepare-input-1",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
    });
    const body = {
      runId: "commit-attempt-1",
      stage: "memory_consolidate",
      unitId: "window-1",
      inputHash: commitInputHash,
      prepareRunId: "prepare-attempt-1",
      prepareInputHash: "prepare-input-1",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
    };
    const handler = sdk.getFunction("api::full-memory-consolidate-window-commit");

    const first = await handler({ headers: {}, body });
    const replay = await handler({ headers: {}, body });

    expect(first.status_code).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::full-memory-consolidate-window-commit",
      payload: {
        identity: {
          runId: "prepare-attempt-1",
          stage: "memory_consolidate",
          unitId: "window-1",
          inputHash: "prepare-input-1",
        },
        preparedHandle: "mcph-1",
        proposalHash: "proposal-1",
      },
    });
    const conflict = await handler({
      headers: {},
      body: { ...body, inputHash: "caller-supplied-conflict" },
    });
    expect(conflict).toMatchObject({
      status_code: 409,
      body: {
        failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
      },
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
  });

  it("re-enters an orphaned deterministic v2 memory commit", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const commitInputHash = stableHash({
      prepareRunId: "prepare-1",
      unitId: "window-1",
      prepareInputHash: "prepare-input-1",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
    });
    const identity = {
      runId: "commit-orphaned",
      stage: "memory_consolidate" as const,
      unitId: "window-1",
      inputHash: commitInputHash,
    };
    const receiptKey = buildExtractionOperationKey(identity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...identity,
      key: receiptKey,
      status: "running",
      startedAt: "2026-07-24T00:00:00.000Z",
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::full-memory-consolidate-window-commit")({
      headers: {},
      body: {
        ...identity,
        prepareRunId: "prepare-1",
        prepareInputHash: "prepare-input-1",
        preparedHandle: "mcph-1",
        proposalHash: "proposal-1",
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
  });

  it("keeps an interrupted deterministic v2 memory commit retryable", async () => {
    let calls = 0;
    const sdk = mockSdk(async () => {
      calls += 1;
      if (calls === 1) throw new Error("state write interrupted");
      return {
        success: true,
        status: "succeeded",
        consolidated: 1,
        memoryIds: ["mem-1"],
      };
    });
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const commitInputHash = stableHash({
      prepareRunId: "prepare-attempt-1",
      unitId: "window-1",
      prepareInputHash: "prepare-input-1",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
    });
    const body = {
      runId: "commit-attempt-1",
      stage: "memory_consolidate",
      unitId: "window-1",
      inputHash: commitInputHash,
      prepareRunId: "prepare-attempt-1",
      prepareInputHash: "prepare-input-1",
      preparedHandle: "mcph-1",
      proposalHash: "proposal-1",
    };
    const handler = sdk.getFunction("api::full-memory-consolidate-window-commit");

    const interrupted = await handler({ headers: {}, body });
    const retried = await handler({ headers: {}, body });

    expect(interrupted).toMatchObject({
      status_code: 503,
      body: {
        retrySameIdentity: true,
        failure: {
          class: "transient_runtime",
          cause: "extraction_operation_interrupted",
        },
      },
    });
    expect(retried).toMatchObject({
      status_code: 200,
      body: { success: true, status: "succeeded", memoryIds: ["mem-1"] },
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(2);
  });

  it("forwards a v2 summary attempt and exact operation identity", async () => {
    const sdk = mockSdk(async () => ({ success: true, status: "in_progress" }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: {
        sessionId: "session-1",
        attemptId: "attempt-1",
        inputHash: "freshness-1",
        operationUnitId: "session-1:map:0",
        requireExistingReceipt: true,
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::summarize-resumable",
      payload: {
        sessionId: "session-1",
        attemptId: "attempt-1",
        inputHash: "freshness-1",
        operationUnitId: "session-1:map:0",
        requireExistingReceipt: true,
      },
    });
  });

  it("forwards only exact summary failed-receipt retry evidence", async () => {
    const sdk = mockSdk(async () => ({ success: true, status: "in_progress" }));
    registerApiTriggers(sdk as never, mockKV() as never, "");
    const failedReceiptRetryAuthorization = {
      receiptInputHash: "a".repeat(64),
      retryEpoch: 0,
      failureClass: "transient_provider",
      failureCause: "pi_stream_failed",
      failurePhase: "provider_call",
      lastSafeFailure: {
        errorClass: "transient_provider",
        cause: "pi_stream_failed",
        phase: "provider_call",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
    };

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: {
        sessionId: "session-1",
        attemptId: "attempt-1",
        inputHash: "freshness-1",
        operationUnitId: "session-1:reduce",
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization,
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::summarize-resumable",
      payload: {
        sessionId: "session-1",
        attemptId: "attempt-1",
        inputHash: "freshness-1",
        operationUnitId: "session-1:reduce",
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization,
      },
    });
  });

  it.each([
    {
      name: "unsafe phase",
      patch: { failurePhase: "provider_preflight" },
    },
    {
      name: "last-safe mismatch",
      patch: { lastSafeFailure: { cause: "other_failure" } },
    },
    {
      name: "unknown field",
      patch: { response: "must-not-cross-boundary" },
    },
  ])("rejects malformed summary retry authorization: $name", async ({ patch }) => {
    const sdk = mockSdk(async () => ({ success: true, status: "in_progress" }));
    registerApiTriggers(sdk as never, mockKV() as never, "");
    const base = {
      receiptInputHash: "a".repeat(64),
      retryEpoch: 0,
      failureClass: "transient_provider",
      failureCause: "pi_stream_failed",
      failurePhase: "provider_call",
      lastSafeFailure: {
        errorClass: "transient_provider",
        cause: "pi_stream_failed",
        phase: "provider_call",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
    };
    const failedReceiptRetryAuthorization = {
      ...base,
      ...patch,
      ...(patch.lastSafeFailure
        ? { lastSafeFailure: { ...base.lastSafeFailure, ...patch.lastSafeFailure } }
        : {}),
    };

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: {
        sessionId: "session-1",
        attemptId: "attempt-1",
        inputHash: "freshness-1",
        operationUnitId: "session-1:reduce",
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization,
      },
    });

    expect(response.status_code).toBe(400);
    expect(response.body).toMatchObject({
      failure: {
        class: "hard",
        cause: "invalid_extraction_operation_retry_authorization",
      },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("passes API retry evidence into the real summary receipt reopen CAS", async () => {
    const previousChunkSize = process.env.SUMMARIZE_CHUNK_SIZE;
    process.env.SUMMARIZE_CHUNK_SIZE = "1";
    const kv = mockKV();
    const functions = new Map<string, Function>();
    const responses: Array<string | Error> = [
      "<summary><title>分片一</title><narrative>分片一</narrative><decisions></decisions><files></files><concepts></concepts></summary>",
      "<summary><title>分片二</title><narrative>分片二</narrative><decisions></decisions><files></files><concepts></concepts></summary>",
      new Error("pi_stream_failed"),
      `<summary>
<title>授权后摘要</title>
<narrative>这是授权后生成并通过真实收据重开路径持久化的完整摘要内容。</narrative>
<decisions></decisions>
<files></files>
<concepts></concepts>
</summary>`,
    ];
    let responseIndex = 0;
    const provider = {
      name: "test",
      compress: async () => "",
      summarize: async () => {
        const response = responses[responseIndex++] ?? responses.at(-1)!;
        if (response instanceof Error) throw response;
        return response;
      },
    };
    const sdk = {
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
      registerTrigger: vi.fn(),
      trigger: vi.fn(async ({ function_id, payload }: {
        function_id: string;
        payload: unknown;
      }) => {
        const handler = functions.get(function_id);
        if (!handler) throw new Error(`No function: ${function_id}`);
        return handler(payload);
      }),
      getFunction: (id: string): Function => {
        const handler = functions.get(id);
        if (!handler) throw new Error(`No function: ${id}`);
        return handler;
      },
    };
    const sessionId = "session-real-receipt";
    const attemptId = "attempt-real-receipt";
    const startedAt = "2026-07-28T00:00:00.000Z";
    const inputHash = sessionInputHash(sessionId, startedAt);
    await kv.set(KV.sessions, sessionId, {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt,
      status: "completed",
      observationCount: 2,
    });
    for (let index = 0; index < 2; index += 1) {
      await kv.set(KV.observations(sessionId), `obs-${index}`, {
        id: `obs-${index}`,
        sessionId,
        timestamp: `2026-07-28T00:00:0${index}.000Z`,
        type: "conversation",
        title: `观察 ${index}`,
        narrative: `观察正文 ${index}`,
        facts: [],
        files: [],
        concepts: [],
      });
    }
    registerSummarizeFunction(sdk as never, kv as never, provider as never);
    registerExtractionOperationReceiptFunctions(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, "");
    const summarize = sdk.getFunction("api::summarize-resumable");
    const request = (operationUnitId: string, extra: Record<string, unknown> = {}) => summarize({
      headers: {},
      body: {
        sessionId,
        attemptId,
        inputHash,
        operationUnitId,
        ...extra,
      },
    });

    try {
      await request(`${sessionId}:map:0`);
      await request(`${sessionId}:map:1`);
      const failed = await request(`${sessionId}:reduce`);
      expect(failed.body).toMatchObject({
        status: "failed",
        failure: {
          class: "transient_provider",
          cause: "pi_stream_failed",
          phase: "provider_call",
        },
      });
      expect(responseIndex).toBe(3);
      const receiptResult = await sdk.getFunction("mem::extraction-operation-receipt-get")({
        runId: attemptId,
        stage: "summary",
        unitId: `${sessionId}:reduce`,
      });
      const authorization = {
        receiptInputHash: receiptResult.operation.inputHash,
        retryEpoch: receiptResult.receipt.retry.epoch,
        failureClass: receiptResult.receipt.failure.class,
        failureCause: receiptResult.receipt.failure.cause,
        failurePhase: receiptResult.receipt.failure.phase,
        lastSafeFailure: receiptResult.receipt.retry.lastSafeFailure,
      };
      const resumed = await request(`${sessionId}:reduce`, {
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization: authorization,
      });

      expect(resumed.body, `${JSON.stringify(resumed.body)} responseIndex=${responseIndex}`).toMatchObject({
        status: "succeeded",
        summary: { title: "授权后摘要" },
      });
      expect(responseIndex).toBe(4);
      const finalReceipt = await sdk.getFunction("mem::extraction-operation-receipt-get")({
        runId: attemptId,
        stage: "summary",
        unitId: `${sessionId}:reduce`,
      });
      expect(finalReceipt.receipt).toMatchObject({
        status: "succeeded",
        retry: { epoch: 1 },
      });
    } finally {
      if (previousChunkSize === undefined) delete process.env.SUMMARIZE_CHUNK_SIZE;
      else process.env.SUMMARIZE_CHUNK_SIZE = previousChunkSize;
    }
  });

  it("rejects receipt-only summary recovery without an exact operation identity", async () => {
    const sdk = mockSdk(async () => ({ success: true, status: "in_progress" }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: {
        sessionId: "session-1",
        attemptId: "attempt-1",
        inputHash: "freshness-1",
        requireExistingReceipt: true,
      },
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it.each(["true", "false"])(
    "rejects string requireExistingReceipt=%s on the summary HTTP boundary",
    async (requireExistingReceipt) => {
      const sdk = mockSdk(async () => ({ success: true, status: "in_progress" }));
      registerApiTriggers(sdk as never, mockKV() as never, "");

      const response = await sdk.getFunction("api::summarize-resumable")({
        headers: {},
        body: {
          sessionId: "session-1",
          attemptId: "attempt-1",
          inputHash: "freshness-1",
          requireExistingReceipt,
        },
      });

      expect(response).toMatchObject({
        status_code: 400,
        body: {
          success: false,
          failure: {
            class: "hard",
            cause: "invalid_extraction_operation_identity",
          },
        },
      });
      expect(sdk.trigger).not.toHaveBeenCalled();
    },
  );

  it("forwards a v2 lesson attempt identity to the service-owned receipt boundary", async () => {
    const sdk = mockSdk(async () => ({
      success: true,
      runs: [{
        id: "lex-stable",
        sessionId: "session-1",
        status: "succeeded",
        inputHash: "service-input",
        configHash: "config-a",
        createdLessonIds: ["lesson-1"],
      }],
    }));
    const kv = mockKV();
    const startedAt = "2026-07-22T00:00:00.000Z";
    await kv.set(KV.sessions, "session-1", {
      id: "session-1",
      startedAt,
    });
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::lesson-extract");
    const body = {
      sessionIds: ["session-1"],
      attemptId: "attempt-1",
      inputHash: sessionInputHash("session-1", startedAt),
    };

    const response = await handler({ headers: {}, body });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::lessons::extract-llm",
      payload: {
        sessionIds: ["session-1"],
        attemptId: "attempt-1",
        inputHash: sessionInputHash("session-1", startedAt),
      },
    });
  });

  it("forwards only exact lessons failed-receipt retry evidence", async () => {
    const sdk = mockSdk(async () => ({ success: true, runs: [] }));
    const kv = mockKV();
    const startedAt = "2026-07-22T00:00:00.000Z";
    const inputHash = sessionInputHash("session-1", startedAt);
    await kv.set(KV.sessions, "session-1", {
      id: "session-1",
      startedAt,
    });
    registerApiTriggers(sdk as never, kv as never, "");
    const failedAt = "2026-07-28T16:23:40.115Z";
    const failedReceiptRetryAuthorization = {
      receiptInputHash: "a".repeat(64),
      retryEpoch: 0,
      failureClass: "transient_provider",
      failureCause: "lesson_extraction_failed",
      failurePhase: "provider_call",
      lastSafeFailure: {
        errorClass: "transient_provider",
        cause: "lesson_extraction_failed",
        phase: "provider_call",
        timestamp: failedAt,
      },
    };
    const failedLessonRunEvidence = {
      status: "retryable",
      inputHash: "b".repeat(64),
      configHash: "c".repeat(64),
      failureCause: "timeout",
      failurePhase: "provider_call",
      failedAt,
      createdLessonCount: 0,
      replacedLessonCount: 0,
      chunkLessonCount: 0,
    };

    const response = await sdk.getFunction("api::lesson-extract")({
      headers: {},
      body: {
        sessionIds: ["session-1"],
        attemptId: "attempt-1",
        inputHash,
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization,
        failedLessonRunEvidence,
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::lessons::extract-llm",
      payload: {
        sessionIds: ["session-1"],
        attemptId: "attempt-1",
        inputHash,
        requireExistingReceipt: true,
        failedReceiptRetryAuthorization,
        failedLessonRunEvidence,
      },
    });
  });

  it("maps a service-owned orphaned v2 lesson receipt to a hard stop", async () => {
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    }));
    const kv = mockKV();
    const startedAt = "2026-07-22T00:00:00.000Z";
    const inputHash = sessionInputHash("session-1", startedAt);
    await kv.set(KV.sessions, "session-1", {
      id: "session-1",
      startedAt,
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::lesson-extract")({
      headers: {},
      body: {
        sessionIds: ["session-1"],
        attemptId: "attempt-orphaned",
        inputHash,
      },
    });

    expect(response.status_code).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
  });

  it("allows only structured summary failure diagnostics through the REST boundary", async () => {
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: "transient_provider",
        cause: "pi_stream_failed",
        phase: "provider_call",
        diagnostics: {
          requestPhase: "chunk",
          providerErrorCode: "rate_limited",
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 12,
          inputChars: 345,
          maxOutputTokens: 4096,
          responseStarted: false,
          responseModel: "safe-model",
          stopReason: "error",
          prompt: "prompt-marker",
          rawError: "raw-error-marker",
          headers: { authorization: "credential-marker" },
          token: "token-marker",
        },
      },
    }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: { sessionId: "session-1" },
    });

    expect(response.body).toEqual({
      success: false,
      status: "failed",
      failure: {
        class: "transient_provider",
        cause: "pi_stream_failed",
        phase: "provider_call",
        diagnostics: {
          requestPhase: "chunk",
          providerErrorCode: "rate_limited",
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 12,
          inputChars: 345,
          maxOutputTokens: 4096,
          responseStarted: false,
          responseModel: "safe-model",
          stopReason: "error",
        },
      },
    });
    const serialized = JSON.stringify(response.body);
    for (const marker of ["prompt-marker", "raw-error-marker", "credential-marker", "token-marker"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("drops an invalid summary failure object instead of passing unsafe diagnostics through", async () => {
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: 42,
        cause: "pi_stream_failed",
        diagnostics: {
          prompt: "prompt-marker",
          rawError: "raw-error-marker",
          headers: { authorization: "credential-marker" },
          token: "token-marker",
        },
      },
    }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: { sessionId: "session-1" },
    });

    expect(response.body).toEqual({ success: false, status: "failed" });
    const serialized = JSON.stringify(response.body);
    for (const marker of ["prompt-marker", "raw-error-marker", "credential-marker", "token-marker"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("drops an unrecognized summary failure phase at the REST boundary", async () => {
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: "transient_runtime",
        cause: "summary_failed",
        phase: "unsafe_phase",
      },
    }));
    registerApiTriggers(sdk as never, mockKV() as never, "");

    const response = await sdk.getFunction("api::summarize-resumable")({
      headers: {},
      body: { sessionId: "session-1" },
    });

    expect(response.body).toEqual({
      success: false,
      status: "failed",
      failure: {
        class: "transient_runtime",
        cause: "summary_failed",
      },
    });
  });

  it("preserves safe reduce failure phases through REST for v2 retry and reconciliation", async () => {
    const cases = [
      {
        phase: "provider_call",
        failureClass: "transient_provider",
        cause: "network_error",
        initialExitCode: 75,
        retryable: true,
      },
      {
        phase: "before_final_persistence",
        failureClass: "transient_runtime",
        cause: "summary_reduce_before_final_persistence_failed",
        initialExitCode: 75,
        retryable: true,
      },
      {
        phase: "provider_preflight",
        failureClass: "hard",
        cause: "provider_drift",
        initialExitCode: 1,
        retryable: false,
      },
      {
        phase: "final_result_persistence",
        failureClass: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
        initialExitCode: 75,
        retryable: false,
        reconciled: true,
      },
    ] as const;
    const previousSecret = process.env.AGENTMEMORY_SECRET;
    process.env.AGENTMEMORY_SECRET = "test-secret";

    try {
      for (const testCase of cases) {
        const stateDir = await mkdtemp(path.join(os.tmpdir(), "agentmemory-summary-phase-"));
        let reduceFailed = true;
        let reduceApiResponse: unknown;
        const reduceRequests: Array<Record<string, unknown>> = [];
        const sdk = mockSdk(async (input) => {
          const payload = input.payload as Record<string, unknown>;
          if (payload.operationUnitId === "s1:map:0") {
            return {
              success: true,
              status: "in_progress",
              advanced: "completed",
              completedChunks: 1,
              totalChunks: 1,
              operationUnitId: payload.operationUnitId,
            };
          }
          reduceRequests.push(payload);
          if (reduceFailed) {
            return {
              success: false,
              status: "failed",
              operationUnitId: payload.operationUnitId,
              failure: {
                class: testCase.failureClass,
                cause: testCase.cause,
                phase: testCase.phase,
              },
              ...(!testCase.reconciled
                ? {
                    recoveryEvidence: {
                      kind: "no_effect",
                      observation: testCase.retryable
                        ? "execution_error"
                        : "business_rejected",
                      reasonCode: testCase.cause,
                      proof: {
                        kind: "receipt_before_formal_effect",
                        receiptKey: `receipt-${testCase.phase}`,
                        receiptVersion: 1,
                        phase: "provider_call",
                        commitPlanAbsent: true,
                      },
                    },
                  }
                : {}),
            };
          }
          const attemptId = payload.attemptId as string;
          const inputHash = payload.inputHash as string;
          const resumableRunId = stableV2Hash({
            attemptId,
            inputHash,
            source: "resumable-run",
          });
          const summary = { title: "retried summary" };
          return {
            success: true,
            status: "succeeded",
            operationUnitId: payload.operationUnitId,
            attemptId,
            runnerInputHash: inputHash,
            serviceInputHash: stableV2Hash({ attemptId, inputHash, source: "summary-service" }),
            resumableRunId,
            summary,
            recoveryEvidence: {
              kind: "committed",
              receiptKey: `receipt-${attemptId}`,
              receiptVersion: 1,
              resultRef: `summary-resumable-runs:${resumableRunId}`,
              effectHash: stableV2Hash({
                title: summary.title,
                narrative: "",
                keyDecisions: [],
                filesModified: [],
                concepts: [],
              }),
            },
          };
        });
        registerApiTriggers(sdk as never, mockKV() as never, "");
        const summarize = sdk.getFunction("api::summarize-resumable");
        const server = await listen(async (request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          response.setHeader("content-type", "application/json");
          if (request.method === "GET" && url.pathname === "/agentmemory/sessions") {
            response.end(JSON.stringify({
              success: true,
              sessions: [{ id: "s1", startedAt: "2026-07-22T00:00:00.000Z" }],
            }));
            return;
          }
          if (request.method === "POST" && url.pathname === "/agentmemory/summarize/resumable") {
            const body = JSON.parse(await readRequestBody(request));
            const apiResponse = await summarize({ headers: {}, body });
            if (body.operationUnitId === "s1:reduce") reduceApiResponse = apiResponse.body;
            response.statusCode = apiResponse.status_code;
            response.end(JSON.stringify(apiResponse.body));
            return;
          }
          if (request.method === "POST" && url.pathname === "/agentmemory/extraction-runs/record") {
            response.end(JSON.stringify({ success: true }));
            return;
          }
          response.statusCode = 404;
          response.end(JSON.stringify({ success: false }));
        });
        const argv = [
          "--base-url", server.baseUrl,
          "--state-dir", stateDir,
          "--run-id", `phase-${testCase.phase}`,
          "--run-state-format", "v2",
        ];
        const dependencies = {
          v2RuntimeCheck: async () => ({ summarizeChunkConcurrency: 1 }),
          v2LessonsRemote: {
            start: async ({ attemptId }: { attemptId: string }) => ({
              ok: true,
              data: { runs: [{ id: `lesson-${attemptId}`, status: "succeeded" }] },
            }),
            record: async () => {},
          },
          v2RemainingStages: false,
        };

        try {
          expect(await runFullExtractionV2(argv, dependencies)).toBe(testCase.initialExitCode);
          expect(reduceApiResponse).toMatchObject({
            failure: {
              class: testCase.failureClass,
              cause: testCase.cause,
              phase: testCase.phase,
            },
          });
          const events = JSON.parse(await readFile(
            path.join(stateDir, `phase-${testCase.phase}.v2`, "summary.jsonl"),
            "utf8",
          ).then((content) => `[${content.trim().split("\n").join(",")}]`)) as Array<Record<string, unknown>>;
          const terminalEvents = events.filter((event) => event.type === "unit_terminal");
          const reduceOperation = events.find(
            (event) => event.type === "unit_operation_started"
              && (event.payload as Record<string, unknown>).operation_id === "s1:reduce",
          );
          const completedReduceOperation = events.find(
            (event) => event.type === "unit_operation_completed"
              && (event.payload as Record<string, unknown>).operation_id === "s1:reduce",
          );

          expect(reduceOperation).toBeDefined();
          if (testCase.retryable) {
            expect(terminalEvents).toHaveLength(0);
            expect(events.some((event) => event.type === "unit_blocked")).toBe(false);
            expect(completedReduceOperation).toBeUndefined();
            reduceFailed = false;
            const retryScheduled = events.find(
              (event) => event.type === "unit_retry_scheduled",
            );
            const retryAt = Date.parse(
              String((retryScheduled?.payload as Record<string, unknown>)?.retry_at),
            );
            expect(Number.isFinite(retryAt)).toBe(true);
            await new Promise((resolve) => {
              setTimeout(resolve, Math.max(0, retryAt - Date.now() + 10));
            });
            const resumedExitCode = await runFullExtractionV2(
              [...argv, "--resume"],
              dependencies,
            );
            expect(reduceApiResponse).toMatchObject({
              status: "succeeded",
              recoveryEvidence: { kind: "committed" },
            });
            expect(resumedExitCode).toBe(0);
            expect(reduceRequests).toHaveLength(2);
            expect(reduceRequests[1]).toMatchObject({
              operationUnitId: "s1:reduce",
              inputHash: reduceRequests[0].inputHash,
            });
            expect(reduceRequests[1].attemptId).not.toBe(reduceRequests[0].attemptId);
            expect(reduceRequests[1].requireExistingReceipt).toBeUndefined();
          } else if (testCase.reconciled) {
            expect(terminalEvents).toHaveLength(0);
            expect(events.some(
              (event) => event.type === "unit_reconciliation_requested",
            )).toBe(true);
            expect(events.some((event) => event.type === "unit_blocked")).toBe(false);
          } else {
            expect(terminalEvents).toHaveLength(0);
            const isolated = events.find((event) => event.type === "unit_isolated");
            expect(isolated?.payload).toMatchObject({
              unit_id: "s1",
              decision: { action: "isolate" },
            });
          }
        } finally {
          await server.close();
          await rm(stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousSecret === undefined) delete process.env.AGENTMEMORY_SECRET;
      else process.env.AGENTMEMORY_SECRET = previousSecret;
    }
  }, 15_000);

  it("replays each formal write endpoint from a succeeded operation receipt", async () => {
    const sdk = mockSdk(async (input) => ({
      success: true,
      functionId: input.function_id,
      memoryIds: ["result-1"],
    }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const cases = [
      {
        api: "api::full-memory-consolidate-window",
        body: {
          runId: "formal-run",
          stage: "memory_consolidate",
          unitId: "mcw-1",
          inputHash: "input-1",
          concept: "retries",
          sourceObservationIds: ["obs-1"],
        },
        functionId: "mem::full-memory-consolidate-window",
      },
      {
        api: "api::semantic-rollup",
        body: {
          runId: "formal-run",
          stage: "semantic_rollup",
          unitId: "w0001",
          inputHash: "input-1",
          windowId: "w0001",
          mark: "full",
          kind: "window",
          sessionIds: ["ses-1"],
        },
        functionId: "mem::semantic-rollup",
      },
      {
        api: "api::full-skill-extract",
        body: {
          runId: "formal-run",
          stage: "skill_extract",
          unitId: "ses-1",
          inputHash: "input-1",
          sessionId: "ses-1",
        },
        functionId: "mem::skill-extract",
      },
      {
        api: "api::full-crystals-auto",
        body: {
          runId: "formal-run",
          stage: "crystal",
          unitId: "auto",
          inputHash: "input-1",
          dryRun: false,
        },
        functionId: "mem::full-crystals-auto",
      },
      {
        api: "api::full-consolidation-procedural-window",
        body: {
          runId: "formal-run",
          stage: "consolidation_procedural",
          unitId: "cpw-1",
          inputHash: "input-1",
          memoryIds: ["mem-1"],
        },
        functionId: "mem::full-consolidation-procedural-window",
      },
      {
        api: "api::full-reflect-insight-window",
        body: {
          runId: "formal-run",
          stage: "reflect_insight",
          unitId: "riw-1",
          inputHash: "input-1",
          useGraph: false,
          semanticMemoryIds: ["sem-1"],
        },
        functionId: "mem::full-reflect-insight-window",
      },
    ];

    for (const entry of cases) {
      sdk.trigger.mockClear();
      const handler = sdk.getFunction(entry.api);
      const first = await handler({ headers: {}, body: entry.body });
      const replay = await handler({ headers: {}, body: entry.body });

      expect(first.status_code).toBe(200);
      expect(replay.status_code).toBe(200);
      expect(sdk.trigger).toHaveBeenCalledTimes(1);
      expect(sdk.trigger).toHaveBeenCalledWith(expect.objectContaining({
        function_id: entry.functionId,
      }));
      expect(replay.body).toEqual(first.body);
    }
  });

  it("full skill-extract sends only sessionId to mem::skill-extract", async () => {
    const sdk = mockSdk(async () => ({ success: true, skill: { id: "proc-a" } }));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-skill-extract");

    const response = await handler({
      headers: {},
      body: {
        runId: "formal-run",
        stage: "skill_extract",
        unitId: "ses-a",
        inputHash: "input-a",
        sessionId: " ses-a ",
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-extract",
      payload: { sessionId: "ses-a" },
    });
    expect(response.body).toMatchObject({
      success: true,
      proceduralMemoryIds: ["proc-a"],
    });
  });

  it("full skill prepare and commit whitelist identity and handle fields", async () => {
    const sdk = mockSdk(async (input) => ({
      success: true,
      functionId: input.function_id,
      payload: input.payload,
    }));
    registerApiTriggers(sdk as never, mockKV() as never, "");
    const identity = {
      runId: "formal-run",
      stage: "skill_extract",
      unitId: "skill-0001",
      inputHash: "input-1",
    };

    const prepared = await sdk.getFunction("api::full-skill-extract-prepare")({
      headers: {},
      body: { ...identity, sessionId: " ses-1 ", model: " skill-model " },
    });
    expect(prepared.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::full-skill-extract-prepare",
      payload: {
        identity,
        sessionId: "ses-1",
        model: "skill-model",
      },
    });

    const committed = await sdk.getFunction("api::full-skill-extract-commit")({
      headers: {},
      body: { ...identity, preparedHandle: " prepared-1 " },
    });
    expect(committed.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::full-skill-extract-commit",
      payload: {
        identity,
        preparedHandle: "prepared-1",
      },
    });
  });

  it("full skill-extract whitelist error names operation identity fields", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, "");
    const response = await sdk.getFunction("api::full-skill-extract")({
      headers: {},
      body: { sessionId: "ses-a", unexpected: true },
    });

    expect(response).toEqual({
      status_code: 400,
      body: {
        error: "Only runId, stage, unitId, inputHash, sessionId, and model are accepted",
      },
    });
  });

  it("full extraction wrappers send only business fields to mem::full functions", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");

    const cases = [
      {
        api: "api::full-memory-consolidate-windows-plan",
        body: { project: " repo ", minObservations: 3, maxObservationsPerWindow: 5 },
        function_id: "mem::full-memory-consolidate-windows-plan",
        payload: { project: "repo", minObservationsPerConcept: 3, maxObservationsPerWindow: 5 },
      },
      {
        api: "api::full-memory-consolidate-window",
        body: {
          runId: "formal-run",
          stage: "memory_consolidate",
          unitId: "mcw-1",
          inputHash: "input-1",
          project: " repo ",
          concept: " Full ",
          sourceObservationIds: [" obs-a ", ""],
          observationSessionIds: { "obs-a": " ses-a " },
        },
        function_id: "mem::full-memory-consolidate-window",
        payload: {
          project: "repo",
          concept: "Full",
          observationIds: ["obs-a"],
          observationSessionIds: { "obs-a": "ses-a" },
        },
      },
      {
        api: "api::full-consolidation-procedural-windows-plan",
        body: { project: " repo ", maxItemsPerWindow: 4 },
        function_id: "mem::full-consolidation-procedural-windows-plan",
        payload: { project: "repo", maxItemsPerWindow: 4 },
      },
      {
        api: "api::full-consolidation-procedural-window",
        body: {
          runId: "formal-run",
          stage: "consolidation_procedural",
          unitId: "cpw-1",
          inputHash: "input-1",
          project: " repo ",
          memoryIds: [" mem-a ", ""],
          model: " memory-model ",
        },
        function_id: "mem::full-consolidation-procedural-window",
        payload: { project: "repo", memoryIds: ["mem-a"], model: "memory-model" },
      },
      {
        api: "api::full-reflect-insight-windows-plan",
        body: { project: " repo ", useGraph: false, maxItemsPerWindow: 5 },
        function_id: "mem::full-reflect-insight-windows-plan",
        payload: { project: "repo", useGraph: false, maxItemsPerWindow: 5 },
      },
      {
        api: "api::full-reflect-insight-window",
        body: {
          runId: "formal-run",
          stage: "reflect_insight",
          unitId: "riw-1",
          inputHash: "input-1",
          project: " repo ",
          semanticMemoryIds: [" sem-a "],
          lessonIds: [" lsn-a "],
          crystalIds: [" crys-a "],
        },
        function_id: "mem::full-reflect-insight-window",
        payload: { project: "repo", useGraph: false, semanticMemoryIds: ["sem-a"], lessonIds: ["lsn-a"], crystalIds: ["crys-a"] },
      },
      {
        api: "api::full-crystals-auto",
        body: { project: " repo ", olderThanDays: 7, dryRun: true, model: " crystal-model " },
        function_id: "mem::full-crystals-auto",
        payload: { project: "repo", olderThanDays: 7, dryRun: true, model: "crystal-model" },
      },
    ];

    for (const entry of cases) {
      sdk.trigger.mockClear();
      const handler = sdk.getFunction(entry.api);
      const response = await handler({ headers: {}, body: entry.body });

      expect(response.status_code).toBe(200);
      expect(sdk.trigger).toHaveBeenCalledWith({
        function_id: entry.function_id,
        payload: entry.payload,
      });
    }
  });

  it("full reflect insight wrappers reject useGraph true with a 400 response", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");

    for (const functionId of [
      "api::full-reflect-insight-windows-plan",
      "api::full-reflect-insight-window",
    ]) {
      const handler = sdk.getFunction(functionId);
      const response = await handler({
        headers: {},
        body: { useGraph: true },
      });

      expect(response.status_code).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining("useGraph:true"),
      });
    }
  });

  it("full crystals auto delegates the whole run to mem::full-crystals-auto", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-crystals-auto");

    const response = await handler({
      headers: {},
      body: { dryRun: true },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::full-crystals-auto",
      payload: { dryRun: true },
    });
  });

  it("full crystals auto forwards an exact pinned action snapshot", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-crystals-auto");

    const response = await handler({
      headers: {},
      body: {
        runId: "crystal-attempt",
        stage: "crystal",
        unitId: "crystal-group:1:repo",
        inputHash: "runner-input",
        groupId: "crystal-group:1:repo",
        actionIds: [" action-1 "],
        actionUpdatedAts: [" 2026-07-24T00:00:00.000Z "],
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::full-crystals-auto",
      payload: {
        groupId: "crystal-group:1:repo",
        actionIds: ["action-1"],
        actionUpdatedAts: ["2026-07-24T00:00:00.000Z"],
      },
    });
  });

  it("full memory consolidate plan endpoint applies charBudget through the service planner", async () => {
    let sdk: ReturnType<typeof mockSdk>;
    sdk = mockSdk(async (input) => sdk.getFunction(input.function_id)(input.payload));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    registerConsolidateFunction(sdk as never, kv as never, {
      name: "test",
      summarize: vi.fn(),
      compress: vi.fn(),
    });

    await kv.set(KV.sessions, "ses-a", {
      id: "ses-a",
      project: "repo",
      cwd: "/repo",
      startedAt: "2026-07-01T00:00:00.000Z",
      status: "completed",
      observationCount: 4,
    });
    for (let i = 0; i < 4; i++) {
      await kv.set(KV.observations("ses-a"), `obs-${i}`, {
        id: `obs-${i}`,
        sessionId: "ses-a",
        timestamp: "2026-07-01T00:00:00.000Z",
        type: "decision",
        title: `Observation ${i}`,
        facts: [],
        narrative: `Narrative ${i} ${"x".repeat(90)}`,
        concepts: ["windows"],
        files: [`file-${i}.ts`],
        importance: 6,
      });
    }

    const handler = sdk.getFunction("api::full-memory-consolidate-windows-plan");
    const response = await handler({
      headers: {},
      body: { project: " repo ", minObservations: 3, charBudget: 250 },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      charBudget: 250,
      budgetApplied: true,
      overBudgetWindowCount: 0,
    });
    expect(response.body.windows.length).toBeGreaterThan(1);
    expect(response.body.maxWindowEstimatedChars).toBeLessThanOrEqual(250);
    for (const window of response.body.windows) {
      if (window.observationCount > 1) {
        expect(window.estimatedChars).toBeLessThanOrEqual(250);
      }
    }
  });

  it("pages compact consolidation descriptors before finalizing a plan", async () => {
    let sdk: ReturnType<typeof mockSdk>;
    sdk = mockSdk(async (input) => sdk.getFunction(input.function_id)(input.payload));
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    registerConsolidateFunction(sdk as never, kv as never, {
      name: "test",
      summarize: vi.fn(),
      compress: vi.fn(),
    });
    for (let sessionIndex = 0; sessionIndex < 2; sessionIndex++) {
      const sessionId = `ses-${sessionIndex}`;
      await kv.set(KV.sessions, sessionId, {
        id: sessionId,
        project: "repo",
        cwd: "/repo",
        startedAt: "2026-07-01T00:00:00.000Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set(KV.observations(sessionId), `obs-${sessionIndex}`, {
        id: `obs-${sessionIndex}`,
        sessionId,
        timestamp: "2026-07-01T00:00:00.000Z",
        type: "decision",
        title: `Observation ${sessionIndex}`,
        facts: [],
        narrative: "private narrative must not be returned by the page",
        concepts: ["windows"],
        files: ["file.ts"],
        importance: 6,
      });
    }
    const handler = sdk.getFunction("api::full-memory-consolidate-windows-plan");

    const page = await handler({
      headers: {},
      body: {
        project: "repo",
        plannerId: "formal-plan",
        sessionOffset: 0,
        sessionLimit: 1,
      },
    });
    expect(page.status_code).toBe(200);
    expect(page.body).toMatchObject({
      sessionOffset: 0,
      nextSessionOffset: 1,
      totalSessions: 2,
      sessionInventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      plannerId: "formal-plan",
      descriptors: [],
      descriptorCount: 1,
      accumulatedDescriptorCount: 1,
    });
    expect(JSON.stringify(page.body)).not.toContain("private narrative");

    const secondPage = await handler({
      headers: {},
      body: {
        project: "repo",
        plannerId: "formal-plan",
        sessionOffset: 1,
        sessionLimit: 1,
      },
    });
    expect(secondPage.body).toMatchObject({
      nextSessionOffset: null,
      descriptorCount: 1,
      accumulatedDescriptorCount: 2,
    });

    const mismatchedFinalization = await handler({
      headers: {},
      body: {
        project: "other-repo",
        plannerId: "formal-plan",
        minObservations: 1,
        windowOffset: 0,
        windowLimit: 1,
      },
    });
    expect(mismatchedFinalization.body).toMatchObject({
      success: false,
      error: "incomplete_consolidation_plan_buffer",
      failure: { class: "hard", cause: "incomplete_consolidation_plan_buffer" },
    });

    await handler({
      headers: {},
      body: {
        project: "repo",
        plannerId: "formal-plan",
        sessionOffset: 0,
        sessionLimit: 1,
      },
    });
    await handler({
      headers: {},
      body: {
        project: "repo",
        plannerId: "formal-plan",
        sessionOffset: 1,
        sessionLimit: 1,
      },
    });

    const finalized = await handler({
      headers: {},
      body: {
        project: "repo",
        plannerId: "formal-plan",
        minObservations: 1,
        charBudget: 1,
        windowOffset: 0,
        windowLimit: 1,
      },
    });
    expect(finalized.status_code).toBe(200);
    expect(finalized.body).toMatchObject({
      plannerId: "formal-plan",
      windowOffset: 0,
      nextWindowOffset: 1,
      totalWindows: 2,
    });
    expect(finalized.body.windows[0]).toMatchObject({
      sourceObservationIds: ["obs-0"],
      observationSessionIds: {
        "obs-0": "ses-0",
      },
    });

    const finalPage = await handler({
      headers: {},
      body: {
        project: "repo",
        plannerId: "formal-plan",
        minObservations: 1,
        charBudget: 1,
        windowOffset: 1,
        windowLimit: 1,
      },
    });
    expect(finalPage.body).toMatchObject({
      windowOffset: 1,
      nextWindowOffset: null,
      totalWindows: 2,
      windows: [{
        sourceObservationIds: ["obs-1"],
        observationSessionIds: {
          "obs-1": "ses-1",
        },
      }],
    });
  });
});
