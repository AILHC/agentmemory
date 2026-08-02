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
import {
  CRYSTAL_CONTRIBUTION_CONTRACT,
  registerCrystallizeFunction,
} from "../src/functions/crystallize.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import {
  CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
  enqueueConsolidationProceduralBacklog,
  registerConsolidationPipelineFunction,
} from "../src/functions/consolidation-pipeline.js";
import {
  REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
  registerReflectFunctions,
} from "../src/functions/reflect.js";
import {
  buildSkillExtractionSourceVersion,
  registerSkillExtractFunctions,
  SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
} from "../src/functions/skill-extract.js";
import { ADOPTED_BASELINE_STAGE_CONTRACTS } from "../src/functions/extraction-baseline-preview.js";
import { fingerprintId, KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import {
  mainForTest as runFullExtractionV2,
  stableHash as stableV2Hash,
} from "../ops/scripts/run-agentmemory-full-extraction.mjs";
import { runV2RemainingStages } from "../ops/scripts/lib/full-extraction-stage-adapters-v2.mjs";
import { runTwoPhaseStage as runRecoveryTwoPhaseStage } from "../ops/scripts/lib/recoverable-stage-v2.mjs";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
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
  const trigger = vi.fn(triggerImpl ?? (async (input: { function_id: string; payload: unknown }) => {
    const handler = functions.get(input.function_id);
    if (handler) return handler(input.payload);
    return {
      success: true,
      functionId: input.function_id,
      payload: input.payload,
    };
  }));
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
  it("protects adopted baseline control and keeps an unsealed manifest inactive", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "test-secret");
    const handler = sdk.getFunction("api::extraction-adopted-baseline");
    const headers = { authorization: "Bearer test-secret" };

    await expect(handler({ headers: {}, body: { action: "status" } }))
      .resolves.toMatchObject({ status_code: 401 });
    await expect(handler({
      headers,
      body: {
        action: "prepare",
        baselineId: "baseline-incomplete",
        sourceRunId: "old-run",
        retiredRunIds: ["old-run"],
        decisionRef: "MYC-122",
        expectedCoverage: {},
        expectedLessonSeed: {
          count: 0,
          digest: createHash("sha256").update("[]").digest("hex"),
        },
      },
    })).resolves.toMatchObject({ status_code: 400 });
    const prepared = await handler({
      headers,
      body: {
        action: "prepare",
        baselineId: "baseline-1",
        sourceRunId: "old-run",
        retiredRunIds: ["old-run"],
        decisionRef: "MYC-122",
        expectedCoverage: Object.fromEntries(Object.entries(ADOPTED_BASELINE_STAGE_CONTRACTS)
          .map(([stage, stageContractVersion]) => [stage, {
            stageContractVersion,
            count: 0,
            digest: createHash("sha256").update("[]").digest("hex"),
          }])),
        expectedLessonSeed: {
          count: 0,
          digest: createHash("sha256").update("[]").digest("hex"),
        },
      },
    });
    expect(prepared).toMatchObject({
      status_code: 200,
      body: { success: true, manifest: { id: "baseline-1", state: "preparing" } },
    });
    await expect(handler({
      headers,
      body: {
        action: "partition_sessions",
        stage: "summary",
        stageContractVersion: "summary/v1",
        sessionIds: ["session-a"],
      },
    })).resolves.toMatchObject({
      status_code: 200,
      body: {
        baselineId: null,
        adoptedSessionIds: [],
        openSessionIds: ["session-a"],
      },
    });
  });

  it("exposes bounded skill extraction eligibility without an operation receipt", async () => {
    const sdk = mockSdk(async ({ function_id, payload }) => ({ success: true, function_id, payload }));
    registerApiTriggers(sdk as never, mockKV() as never, "");
    const handler = sdk.getFunction("api::skill-extract-eligibility");

    await expect(handler({ headers: {}, body: { sessionIds: ["session-a", "session-b"] } }))
      .resolves.toMatchObject({ status_code: 200, body: { success: true } });
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::skill-extract-eligibility",
      payload: { sessionIds: ["session-a", "session-b"] },
    });

    const invalidResponses = await Promise.all([
      { sessionIds: [] },
      { sessionIds: ["session-a", "session-a"] },
      { sessionIds: Array.from({ length: 101 }, (_, index) => `session-${index}`) },
      { sessionIds: ["session-a"], unexpected: true },
    ].map((body) => handler({ headers: {}, body })));
    expect(invalidResponses.map((response) => response.status_code)).toEqual([400, 400, 400, 400]);
  });

  it("exposes bounded semantic contribution eligibility without an operation receipt", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::semantic-rollup-eligibility");
    const body = {
      sessionIds: ["session-a", "session-b"],
      sourceSummaryHashes: {
        "session-a": "a".repeat(64),
        "session-b": "b".repeat(64),
      },
    };

    const response = await handler({ headers: {}, body });
    expect(response).toMatchObject({ status_code: 200 });
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::semantic-rollup-eligibility",
      payload: body,
    });
    expect(await handler({ headers: {}, body: { ...body, unexpected: true } })).toMatchObject({
      status_code: 400,
    });
    expect(await handler({
      headers: {},
      body: { ...body, sourceSummaryHashes: { ...body.sourceSummaryHashes, "session-b": "bad" } },
    })).toMatchObject({ status_code: 400 });
  });

  it("takes committed structured memory no-effect through the shared two-phase runner and replays cleanly", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "structured-empty",
      compress: vi.fn(async () =>
        "<no_effect><reason_code>no_durable_memory</reason_code></no_effect>"),
      summarize: vi.fn(),
    };
    registerExtractionOperationReceiptFunctions(sdk as never, kv as never);
    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    for (const id of Array.from({ length: 10 }, (_, index) => `empty-${index + 1}`)) {
      await kv.set(KV.observations("structured-empty-session"), id, {
        id,
        sessionId: "structured-empty-session",
        timestamp: "2026-08-02T00:00:00.000Z",
        type: "decision",
        title: `Empty candidate ${id}`,
        facts: [],
        narrative: `Evidence ${id}`,
        concepts: ["structured-empty"],
        files: [],
        importance: 8,
      });
    }
    const endpoints = new Map([
      ["/agentmemory/full/memory-consolidate-windows/plan", "api::full-memory-consolidate-windows-plan"],
      ["/agentmemory/full/memory-consolidate-window/prepare", "api::full-memory-consolidate-window-prepare"],
      ["/agentmemory/full/memory-consolidate-window/commit", "api::full-memory-consolidate-window-commit"],
    ]);
    const request = async (endpoint: string, body: Record<string, unknown>) => {
      if (endpoint === "/agentmemory/extraction-runs/record") {
        return { ok: true, status_code: 200, data: { success: true } };
      }
      const functionId = endpoints.get(endpoint);
      if (!functionId) throw new Error(`unexpected endpoint: ${endpoint}`);
      const response = await sdk.getFunction(functionId)({ headers: {}, body });
      return {
        ok: response.status_code >= 200 && response.status_code < 300,
        status_code: response.status_code,
        data: response.body,
      };
    };
    const events: Array<{ seq: number; type: string; payload: unknown }> = [];
    let frozenPlan: unknown[] | undefined;
    const execute = () => runV2RemainingStages({
      options: { mark: "structured-empty" },
      runId: "structured-empty-run",
      config: {
        semantic_window_size: 20,
        semantic_rollup_target_prompt_chars: 64_000,
        memory_consolidate_char_budget: 64_000,
        reflect_insight_char_budget: 64_000,
      },
      configHash: "structured-empty-config",
      inventoryHash: "structured-empty-inventory",
      request,
      stableHash,
      eligibleStages: {
        memory_consolidate: true,
        semantic_rollup: false,
        skill_extract: false,
        crystal: false,
        consolidation_procedural: false,
        reflect_insight: false,
      },
      loadSelectedSessions: async () => [{ id: "structured-empty-session" }],
      runTwoPhaseStage: async ({ plan, adapter }: { plan: () => Promise<unknown[]>; adapter: object }) => {
        frozenPlan ??= await plan();
        return runRecoveryTwoPhaseStage({
          events,
          plan: frozenPlan,
          append: async (type: string, payload: unknown) => {
            const event = { seq: events.length, type, payload };
            events.push(event);
            return event;
          },
          ...adapter,
        });
      },
      runSingleStage: async () => ({ status: "failed" }),
    });

    await expect(execute()).resolves.toMatchObject({ status: "completed" });
    await expect(execute()).resolves.toMatchObject({ status: "completed" });
    expect(provider.compress).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type.includes("blocked") || event.type.includes("pending"))).toBe(false);
    const contributions = await kv.list<{ state: string }>(KV.extractionContributionRecords(
      "memory_consolidate",
      "memory_consolidate/v1",
    ));
    expect(contributions).toHaveLength(10);
    expect(contributions.every((record) => record.state === "no_effect")).toBe(true);
  });

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

  it("persists and replays a provider failure through the real memory prepare endpoint", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn().mockRejectedValue(new Error("pi_stream_failed")),
      summarize: vi.fn(),
    };
    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    const observationId = "obs-provider-failure";
    const unitId = "window-provider-failure";
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ unitId, sourceIds: [observationId] }))
      .digest("hex");
    await kv.set(KV.observations("ses-provider-failure"), observationId, {
      id: observationId,
      sessionId: "ses-provider-failure",
      timestamp: "2026-07-30T00:00:00.000Z",
      type: "decision",
      title: "Provider failure source",
      facts: [],
      narrative: "This source must not produce a memory when the provider fails.",
      concepts: ["recovery"],
      files: [],
      importance: 8,
    });
    const body = {
      runId: "memory-provider-failure",
      stage: "memory_consolidate",
      unitId,
      inputHash,
      concept: "recovery",
      sourceObservationIds: [observationId],
      observationSessionIds: { [observationId]: "ses-provider-failure" },
      minObservations: 1,
    };
    const handler = sdk.getFunction("api::full-memory-consolidate-window-prepare");

    const first = await handler({ headers: {}, body });
    const replay = await handler({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });

    expect(first.status_code).toBe(503);
    expect(first.body).toMatchObject({
      success: false,
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
      operationReceipt: { status: "failed", runnerInputHash: inputHash },
    });
    expect(replay.status_code).toBe(503);
    expect(replay.body).toMatchObject({
      success: false,
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
      operationReceipt: { status: "failed", runnerInputHash: inputHash },
    });
    expect(provider.compress).toHaveBeenCalledTimes(1);
    const receipts = [...kv.store.entries()]
      .filter(([scope]) => scope.startsWith("mem:extraction-operation-receipt:"))
      .flatMap(([, entries]) => [...entries.values()]);
    expect(receipts).toEqual([
      expect.objectContaining({
        status: "failed",
        failure: { class: "transient_provider", cause: "pi_stream_failed" },
      }),
    ]);
    expect(await kv.list(KV.memories)).toEqual([]);
    expect(await kv.list(KV.audit)).toEqual([]);
    expect([...kv.store.keys()].some((scope) =>
      scope.startsWith("mem:memory-consolidation-proposal:"))).toBe(false);
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
      version: 1,
      status: "running",
      startedAt: "2026-07-24T00:00:00.000Z",
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: { ...identity, concept: "windows", sourceObservationIds: ["obs-1"] },
    });
    const recovered = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: {
        ...identity,
        concept: "windows",
        sourceObservationIds: ["obs-1"],
        requireExistingReceipt: true,
      },
    });

    expect(response.status_code).toBe(503);
    expect(recovered.status_code).toBe(200);
    expect(recovered.body).toMatchObject({
      operationReceipt: {
        key: receiptKey,
        version: 1,
        status: "running",
        runId: receiptIdentity.runId,
        stage: receiptIdentity.stage,
        unitId: receiptIdentity.unitId,
        inputHash: receiptIdentity.inputHash,
        runnerInputHash: identity.inputHash,
      },
    });
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

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      operationReceiptAbsence: {
        schema: "extraction-operation-receipt-absence/v1",
        key: buildExtractionOperationKey({
          runId: "prepare-missing",
          stage: "memory_consolidate",
          unitId: "window-1",
        }),
        runId: "prepare-missing",
        stage: "memory_consolidate",
        unitId: "window-1",
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        runnerInputHash: "input-1",
      },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects a memory prepare whose fresh retry drifted from the absence input hash", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const body = {
      runId: "prepare-drifted",
      stage: "memory_consolidate",
      unitId: "window-1",
      inputHash: "input-1",
      concept: "windows",
      sourceObservationIds: ["obs-1"],
    };

    const probe = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    const observedInputHash = probe.body.operationReceiptAbsence.inputHash as string;
    const driftedInputHash = observedInputHash === "f".repeat(64)
      ? "e".repeat(64)
      : "f".repeat(64);
    const retry = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: { ...body, expectedReceiptInputHash: driftedInputHash },
    });

    expect(retry.status_code).toBe(409);
    expect(retry.body).toMatchObject({
      failure: {
        class: "hard",
        cause: "extraction_operation_input_hash_drifted_after_absence",
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
    const parsed = {};
    const sourceObservationIds = ["obs-1"];
    const concept = "windows";
    const proposalHash = stableHash([parsed, sourceObservationIds, undefined, concept]);
    const preparedHandle = fingerprintId("mcph", `${proposalKey}:${proposalHash}`);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...receiptIdentity,
      key: receiptKey,
      status: "running",
      startedAt: "2026-07-24T00:00:00.000Z",
    });
    await kv.set(KV.memoryConsolidationProposal(proposalKey), proposalKey, {
      ...identity,
      key: proposalKey,
      handle: preparedHandle,
      proposalHash,
      status: "prepared",
      preparedAt: "2026-07-24T00:00:01.000Z",
      concept,
      sourceObservationIds,
      parsed,
      totalObservations: 1,
      promptChars: 42,
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: { ...identity, concept: "windows", sourceObservationIds: ["obs-1"] },
    });
    const recovered = await sdk.getFunction("api::full-memory-consolidate-window-prepare")({
      headers: {},
      body: {
        ...identity,
        concept: "windows",
        sourceObservationIds: ["obs-1"],
        requireExistingReceipt: true,
      },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      status: "prepared",
      preparedHandle,
      proposalHash,
    });
    expect(recovered.status_code).toBe(200);
    expect(recovered.body).toMatchObject({
      status: "prepared",
      preparedHandle,
      proposalHash,
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

  it("repairs the memory-to-procedural backlog handoff from the succeeded upstream receipt", async () => {
    const sdk = mockSdk(async ({ function_id }) => {
      expect(function_id).toBe("mem::full-memory-consolidate-window-commit");
      return {
        success: true,
        status: "succeeded",
        consolidated: 1,
        memoryIds: ["handoff-pattern"],
      };
    });
    const kv = mockKV();
    await kv.set(KV.memories, "handoff-pattern", {
      id: "handoff-pattern",
      type: "pattern",
      title: "Handoff pattern",
      content: "Persist the downstream source before acknowledging the handoff",
      concepts: ["recovery"],
      files: [],
      sessionIds: ["handoff-session-1", "handoff-session-2"],
      sourceObservationIds: ["handoff-observation"],
      strength: 5,
      version: 1,
      isLatest: true,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    registerApiTriggers(sdk as never, kv as never, "");
    const commitInputHash = stableHash({
      prepareRunId: "handoff-prepare",
      unitId: "handoff-window",
      prepareInputHash: "handoff-prepare-input",
      preparedHandle: "handoff-handle",
      proposalHash: "handoff-proposal",
    });
    const body = {
      runId: "handoff-commit",
      stage: "memory_consolidate",
      unitId: "handoff-window",
      inputHash: commitInputHash,
      prepareRunId: "handoff-prepare",
      prepareInputHash: "handoff-prepare-input",
      preparedHandle: "handoff-handle",
      proposalHash: "handoff-proposal",
    };
    const originalSet = kv.set;
    let interruptBacklogWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (interruptBacklogWrite && scope === KV.consolidationProceduralBacklog) {
        interruptBacklogWrite = false;
        throw new Error("downstream backlog write interrupted");
      }
      return originalSet(scope, key, data);
    };

    const interrupted = await sdk.getFunction("api::full-memory-consolidate-window-commit")({
      headers: {},
      body,
    });
    expect(interrupted).toMatchObject({
      status_code: 503,
      body: {
        success: false,
        failure: { cause: "extraction_operation_reconciliation_required" },
        operationReceipt: { status: "succeeded", runId: body.runId },
      },
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(1);

    const resumed = await sdk.getFunction("api::full-memory-consolidate-window-commit")({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    expect(resumed).toMatchObject({ status_code: 200, body: { success: true } });
    expect(sdk.trigger).toHaveBeenCalledTimes(2);
    const [backlog] = await kv.list<{
      memoryId: string;
      upstreamReceiptRef?: { scope: string; key: string };
    }>(KV.consolidationProceduralBacklog);
    expect(backlog).toMatchObject({
      memoryId: "handoff-pattern",
      upstreamReceiptRef: {
        scope: KV.extractionOperationReceipt(resumed.body.operationReceipt.key),
        key: resumed.body.operationReceipt.key,
      },
    });
  });

  it("re-enters an orphaned deterministic v2 memory commit", async () => {
    const sdk = mockSdk(async () => ({
      success: true,
      status: "succeeded",
      memoryIds: [],
    }));
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

  it.each([
    {
      api: "api::full-memory-consolidate-window-commit",
      stage: "memory_consolidate",
    },
    {
      api: "api::full-skill-extract-commit",
      stage: "skill_extract",
    },
  ])("does not create a missing recovered $stage commit receipt", async ({ api, stage }) => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "");
    const prepareRunId = `${stage}-prepare`;
    const unitId = `${stage}-unit`;
    const prepareInputHash = `${stage}-prepare-input`;
    const preparedHandle = `${stage}-handle`;
    const proposalHash = `${stage}-proposal`;
    const inputHash = stableHash({
      prepareRunId,
      unitId,
      prepareInputHash,
      preparedHandle,
      proposalHash,
    });

    const response = await sdk.getFunction(api)({
      headers: {},
      body: {
        runId: `${stage}-commit`,
        stage,
        unitId,
        inputHash,
        prepareRunId,
        prepareInputHash,
        preparedHandle,
        proposalHash,
        requireExistingReceipt: true,
      },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      operationReceiptAbsence: {
        schema: "extraction-operation-receipt-absence/v1",
        key: buildExtractionOperationKey({
          runId: `${stage}-commit`,
          stage,
          unitId,
        }),
        runId: `${stage}-commit`,
        stage,
        unitId,
        inputHash,
        runnerInputHash: inputHash,
      },
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
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
      lessonEvidence: [{
        runId: "lex-stable",
        receiptKey: "lesson-receipt-1",
        effectHash: "d".repeat(64),
      }],
    }));
    const kv = mockKV();
    const startedAt = "2026-07-22T00:00:00.000Z";
    await kv.set(KV.sessions, "session-1", {
      id: "session-1",
      startedAt,
    });
    await kv.set(KV.lessons, "lesson-1", {
      id: "lesson-1",
      content: "Persist exact incremental lesson evidence",
      context: "",
      confidence: 0.8,
      reinforcements: 0,
      source: "extracted",
      sourceIds: ["session-1"],
      tags: ["incremental"],
      createdAt: startedAt,
      updatedAt: startedAt,
      decayRate: 0.05,
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
    expect(await kv.list<{ sourceType: string; sourceId: string }>(KV.reflectInsightBacklog))
      .toEqual([
        expect.objectContaining({ sourceType: "lesson", sourceId: "lesson-1" }),
      ]);
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

  it("returns an exact lesson receipt-absence proof through the HTTP transport", async () => {
    const operationReceiptAbsence = {
      schema: "extraction-operation-receipt-absence/v1",
      key: `xop_${"a".repeat(32)}`,
      runId: "attempt-absence",
      stage: "lessons",
      unitId: "session-1",
      inputHash: "b".repeat(64),
      runnerInputHash: "c".repeat(64),
      observedAt: "2026-07-30T00:00:00.000Z",
    };
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      operationReceiptAbsence,
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
        attemptId: "attempt-absence",
        inputHash,
        requireExistingReceipt: true,
      },
    });

    expect(response).toEqual({
      status_code: 200,
      body: {
        success: false,
        status: "failed",
        failure: {
          class: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
        },
        operationReceiptAbsence,
      },
    });
  });

  it("returns a running lesson receipt through the recovered HTTP query", async () => {
    const startedAt = "2026-07-30T00:00:00.000Z";
    const operationReceipt = {
      key: `xop_${"a".repeat(32)}`,
      version: 1,
      status: "running",
      runId: "attempt-running",
      stage: "lessons",
      unitId: "session-1",
      inputHash: "b".repeat(64),
      runnerInputHash: "c".repeat(64),
      startedAt,
    };
    const sdk = mockSdk(async () => ({
      success: false,
      status: "failed",
      failure: {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      },
      operationReceipt,
    }));
    const kv = mockKV();
    const sessionStartedAt = "2026-07-22T00:00:00.000Z";
    await kv.set(KV.sessions, "session-1", {
      id: "session-1",
      startedAt: sessionStartedAt,
    });
    registerApiTriggers(sdk as never, kv as never, "");

    const response = await sdk.getFunction("api::lesson-extract")({
      headers: {},
      body: {
        sessionIds: ["session-1"],
        attemptId: "attempt-running",
        inputHash: sessionInputHash("session-1", sessionStartedAt),
        requireExistingReceipt: true,
      },
    });

    expect(response).toEqual({
      status_code: 200,
      body: {
        success: false,
        status: "failed",
        failure: {
          class: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
        },
        operationReceipt,
      },
    });
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
            const attemptId = payload.attemptId as string;
            const operationUnitId = payload.operationUnitId as string;
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
                : {
                    operationReceipt: {
                      key: `xop_${stableV2Hash([
                        attemptId,
                        "summary",
                        operationUnitId,
                      ]).slice(0, 32)}`,
                      version: 1,
                      status: "running",
                      runId: attemptId,
                      stage: "summary",
                      unitId: operationUnitId,
                      inputHash: stableV2Hash({
                        attemptId,
                        operationUnitId,
                        phase: "final_result_persistence",
                      }),
                      runnerInputHash: payload.inputHash,
                      startedAt: "2026-07-30T00:00:00.000Z",
                    },
                  }),
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
              resultRef: `mem:summary-resumable:runs:${resumableRunId}`,
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
          "--pending-policy", "exit",
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
      ...(input.function_id === "mem::semantic-rollup" ? { semanticMemoryIds: [] } : {}),
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
          inputHash: "a".repeat(64),
          windowId: "w0001",
          mark: "full",
          kind: "window",
          sessionIds: ["ses-1"],
          sourceSummaryHashes: { "ses-1": "b".repeat(64) },
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
      const domainReverification = new Set([
        "semantic_rollup",
        "crystal",
        "consolidation_procedural",
        "reflect_insight",
      ]).has(entry.body.stage);
      if (domainReverification && first.status_code === 200) {
        const operationReceipt = first.body.operationReceipt as {
          key: string;
          inputHash: string;
        };
        const scope = KV.extractionOperationReceipt(operationReceipt.key);
        const stored = await kv.get<Record<string, unknown>>(scope, operationReceipt.key);
        const identity = {
          runId: entry.body.runId,
          unitId: entry.body.unitId,
          inputHash: operationReceipt.inputHash,
        };
        const stageRecovery = entry.body.stage === "semantic_rollup"
          ? {
            semanticRecovery: {
              schema: "semantic-rollup-recovery/v1",
              phase: "committed",
              identity: {
                runId: identity.runId,
                unitId: identity.unitId,
                receiptInputHash: identity.inputHash,
              },
            },
          }
          : entry.body.stage === "crystal"
            ? {
              crystalRecovery: {
                schema: "crystal-recovery/v1",
                phase: "committed",
                identity,
              },
            }
            : entry.body.stage === "consolidation_procedural"
              ? {
                proceduralRecovery: {
                  schema: "consolidation-procedural-recovery/v1",
                  phase: "committed",
                  identity,
                },
              }
              : {
                reflectRecovery: {
                  schema: "reflect-insight-recovery/v1",
                  phase: "committed",
                  identity,
                },
              };
        await kv.set(scope, operationReceipt.key, { ...stored, ...stageRecovery });
      }
      const replay = await handler({
        headers: {},
        body: domainReverification
          ? { ...entry.body, requireExistingReceipt: true }
          : entry.body,
      });

      expect(first.status_code).toBe(200);
      expect(replay.status_code).toBe(200);
      expect(sdk.trigger).toHaveBeenCalledTimes(domainReverification ? 2 : 1);
      expect(sdk.trigger).toHaveBeenCalledWith(expect.objectContaining({
        function_id: entry.functionId,
      }));
      expect(first.body).toMatchObject({
        operationReceipt: {
          key: expect.stringMatching(/^xop_[0-9a-f]{32}$/),
          version: 1,
          status: "succeeded",
          runId: entry.body.runId,
          stage: entry.body.stage,
          unitId: entry.body.unitId,
          inputHash: expect.any(String),
          runnerInputHash: entry.body.inputHash,
        },
      });
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
    const contribution = {
      stageContractVersion: "skill_extract/v1",
      sourceVersionKey: "skill_extract|session|ses-1|source-hash",
    };

    const prepared = await sdk.getFunction("api::full-skill-extract-prepare")({
      headers: {},
      body: { ...identity, ...contribution, sessionId: " ses-1 ", model: " skill-model " },
    });
    expect(prepared.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::full-skill-extract-prepare",
      payload: {
        identity,
        sessionId: "ses-1",
        ...contribution,
        model: "skill-model",
        operationReceiptManaged: true,
      },
    });

    const recoveredPrepare = await sdk.getFunction("api::full-skill-extract-prepare")({
      headers: {},
      body: {
        ...identity,
        ...contribution,
        sessionId: "ses-1",
        requireExistingReceipt: true,
      },
    });
    expect(recoveredPrepare.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::full-skill-extract-prepare",
      payload: {
        identity,
        sessionId: "ses-1",
        ...contribution,
        operationReceiptManaged: true,
        requireExistingReceipt: true,
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

  it("repairs a committed skill contribution through the formal commit receipt", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        "<skill><trigger>When formal commit is interrupted</trigger><title>Repair formal skill</title><steps><step>Verify receipt</step><step>Reconcile contribution</step></steps><expected_outcome>One durable skill</expected_outcome><tags>recovery</tags></skill>",
      ),
    };
    registerSkillExtractFunctions(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    const session = {
      id: "skill-api-reconcile",
      project: "repo",
      status: "completed" as const,
    };
    const summary = {
      sessionId: session.id,
      title: "Formal skill recovery",
      narrative: "Commit once and reconcile from its receipt",
      keyDecisions: ["preserve the domain effect"],
      filesModified: ["skill.ts"],
      concepts: ["recovery"],
    };
    const observations = Array.from({ length: 3 }, (_, index) => ({
      id: `skill-api-obs-${index}`,
      sessionId: session.id,
      timestamp: `2026-07-30T00:00:0${index}.000Z`,
      type: "file_edit",
      title: `Step ${index}`,
      narrative: "Apply formal recovery step",
      importance: 8,
    }));
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.summaries, session.id, summary);
    for (const observation of observations) {
      await kv.set(KV.observations(session.id), observation.id, observation);
    }
    const source = buildSkillExtractionSourceVersion(
      session as never,
      summary as never,
      observations as never,
    );
    const prepareBody = {
      runId: "skill-api-prepare",
      stage: "skill_extract",
      unitId: session.id,
      inputHash: "runner-prepare-input",
      sessionId: session.id,
      stageContractVersion: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
      sourceVersionKey: source.sourceVersionKey,
    };
    const prepared = await sdk.getFunction("api::full-skill-extract-prepare")({
      headers: {},
      body: prepareBody,
    });
    expect(prepared).toMatchObject({
      status_code: 200,
      body: {
        success: true,
        status: "prepared",
        preparedHandle: expect.any(String),
        proposalHash: expect.any(String),
        inputHash: expect.any(String),
      },
    });
    const commitBody = {
      runId: "skill-api-commit",
      stage: "skill_extract",
      unitId: session.id,
      inputHash: stableHash({
        prepareRunId: prepareBody.runId,
        unitId: session.id,
        prepareInputHash: prepared.body.inputHash,
        preparedHandle: prepared.body.preparedHandle,
        proposalHash: prepared.body.proposalHash,
      }),
      prepareRunId: prepareBody.runId,
      prepareInputHash: prepared.body.inputHash,
      preparedHandle: prepared.body.preparedHandle,
      proposalHash: prepared.body.proposalHash,
    };
    const originalSet = kv.set;
    let failContributionWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (
        failContributionWrite
        && scope === KV.extractionContributionRecords(
          "skill_extract",
          SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
        )
        && (data as { state?: string }).state === "committed"
      ) {
        failContributionWrite = false;
        throw new Error("contribution response lost");
      }
      return originalSet(scope, key, data);
    };

    const interrupted = await sdk.getFunction("api::full-skill-extract-commit")({
      headers: {},
      body: commitBody,
    });
    expect(interrupted).toMatchObject({
      status_code: 503,
      body: {
        success: false,
        failure: { cause: "extraction_operation_reconciliation_required" },
        operationReceipt: { status: "succeeded", runId: commitBody.runId },
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const contributionScope = KV.extractionContributionRecords(
      "skill_extract",
      SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
    );
    expect(await kv.get<{ state: string }>(contributionScope, source.sourceVersionKey))
      .toMatchObject({ state: "claimed" });

    const resumed = await sdk.getFunction("api::full-skill-extract-commit")({
      headers: {},
      body: { ...commitBody, requireExistingReceipt: true },
    });
    expect(resumed).toMatchObject({ status_code: 200, body: { success: true } });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(await kv.get<{ state: string }>(contributionScope, source.sourceVersionKey))
      .toMatchObject({ state: "committed" });
    expect(await kv.list(KV.procedural)).toHaveLength(1);
    expect((await kv.list<{ operation: string }>(KV.audit))
      .filter((entry) => entry.operation === "skill_extract")).toHaveLength(1);

    const clean = await sdk.getFunction("api::full-skill-extract-prepare")({
      headers: {},
      body: {
        ...prepareBody,
        runId: "skill-api-clean",
        inputHash: "clean-runner-input",
      },
    });
    expect(clean).toMatchObject({ status_code: 200, body: { success: true, status: "succeeded" } });
    expect(provider.summarize).toHaveBeenCalledTimes(1);

    await kv.set(KV.summaries, session.id, {
      ...summary,
      narrative: "Corrected after the original contribution",
    });
    const correction = await sdk.getFunction("api::skill-extract-eligibility")({
      headers: {},
      body: { sessionIds: [session.id] },
    });
    expect(correction).toMatchObject({
      status_code: 200,
      body: {
        success: true,
        eligible: [],
        sourceCorrection: [{
          sessionId: session.id,
          reason: "terminal_source_version_changed",
        }],
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    await kv.set(KV.summaries, session.id, summary);

    const [skill] = await kv.list<{ id: string }>(KV.procedural);
    await kv.delete(KV.procedural, skill.id);
    const missingEffect = await sdk.getFunction("api::full-skill-extract-prepare")({
      headers: {},
      body: {
        ...prepareBody,
        runId: "skill-api-tampered",
        inputHash: "tampered-runner-input",
      },
    });
    expect(missingEffect).toMatchObject({
      status_code: 200,
      body: {
        success: false,
        failure: { cause: "skill_extract_terminal_reconciliation_required" },
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("repairs a procedural contribution after its receipt succeeds without another provider call", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        '<procedures><procedure name="Receipt repair" trigger="when a procedural commit is interrupted"><step>Verify the receipt</step><step>Repair the contribution</step></procedure></procedures>',
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    const memories = [1, 2].map((index) => ({
      id: `procedural-api-pattern-${index}`,
      type: "pattern" as const,
      title: `Procedural API pattern ${index}`,
      content: `Use the same receipt repair workflow ${index}`,
      concepts: ["recovery"],
      files: [],
      sessionIds: [`procedural-api-session-${index}-a`, `procedural-api-session-${index}-b`],
      sourceObservationIds: [`procedural-api-observation-${index}`],
      strength: 5,
      version: 1,
      isLatest: true,
      project: "repo",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    }));
    for (const memory of memories) await kv.set(KV.memories, memory.id, memory);
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: memories.map((memory) => memory.id),
    });
    const planned = await sdk.getFunction("api::full-consolidation-procedural-windows-plan")({
      headers: {},
      body: { project: "repo" },
    });
    expect(planned).toMatchObject({
      status_code: 200,
      body: {
        success: true,
        windows: [{
          stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
          patternCount: 2,
        }],
      },
    });
    const [window] = planned.body.windows;
    const body = {
      runId: "procedural-api-attempt",
      stage: "consolidation_procedural",
      unitId: window.windowId,
      inputHash: stableHash({ windowId: window.windowId, sources: window.sourceVersionKeys }),
      project: window.project,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
    };
    const contributionScope = KV.extractionContributionRecords(
      "consolidation_procedural",
      CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
    );
    const originalSet = kv.set;
    let interruptContributionWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (
        interruptContributionWrite
        && scope === contributionScope
        && (data as { state?: string }).state === "committed"
      ) {
        interruptContributionWrite = false;
        throw new Error("procedural contribution write interrupted");
      }
      return originalSet(scope, key, data);
    };

    const interrupted = await sdk.getFunction("api::full-consolidation-procedural-window")({
      headers: {},
      body,
    });
    expect(interrupted).toMatchObject({
      status_code: 503,
      body: {
        success: false,
        failure: { cause: "extraction_operation_reconciliation_required" },
        operationReceipt: { status: "succeeded", runId: body.runId },
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(await kv.list(KV.procedural)).toHaveLength(1);

    const resumed = await sdk.getFunction("api::full-consolidation-procedural-window")({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    expect(resumed).toMatchObject({
      status_code: 200,
      body: { success: true, status: "succeeded" },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const records = await kv.list<{ state: string }>(contributionScope);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.state === "committed")).toBe(true);
    expect(await kv.list(KV.consolidationProceduralBacklog)).toEqual([]);

    const clean = await sdk.getFunction("api::full-consolidation-procedural-windows-plan")({
      headers: {},
      body: { project: "repo" },
    });
    expect(clean).toMatchObject({ status_code: 200, body: { success: true, windows: [] } });
    expect(provider.summarize).toHaveBeenCalledTimes(1);

    const [procedure] = await kv.list<{ id: string; steps: string[] }>(KV.procedural);
    await kv.set(KV.procedural, procedure.id, {
      ...procedure,
      steps: ["Tampered after commit"],
    });
    const driftedEffect = await sdk.getFunction("api::full-consolidation-procedural-window")({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    expect(driftedEffect).toMatchObject({
      status_code: 409,
      body: {
        success: false,
        failure: { cause: "consolidation_procedural_source_mutation_conflict" },
      },
    });
    await kv.set(KV.procedural, procedure.id, procedure);
    await kv.delete(KV.procedural, procedure.id);
    const tampered = await sdk.getFunction("api::full-consolidation-procedural-window")({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    expect(tampered).toMatchObject({
      status_code: 409,
      body: {
        success: false,
        failure: { cause: "consolidation_procedural_source_mutation_conflict" },
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("commits and replays a strict procedural business-empty contribution", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue("<procedures></procedures>"),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    const memories = [1, 2].map((index) => ({
      id: `procedural-empty-pattern-${index}`,
      type: "pattern" as const,
      title: `Procedural empty pattern ${index}`,
      content: `Evidence that does not form a reusable procedure ${index}`,
      concepts: ["empty"],
      files: [],
      sessionIds: [`procedural-empty-${index}-a`, `procedural-empty-${index}-b`],
      strength: 5,
      version: 1,
      isLatest: true,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    }));
    for (const memory of memories) await kv.set(KV.memories, memory.id, memory);
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: memories.map((memory) => memory.id),
    });
    const plan = await sdk.getFunction("api::full-consolidation-procedural-windows-plan")({
      headers: {},
      body: {},
    });
    const [window] = plan.body.windows;
    const body = {
      runId: "procedural-empty-attempt",
      stage: "consolidation_procedural",
      unitId: window.windowId,
      inputHash: stableHash(window.sourceVersionKeys),
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
    };
    const handler = sdk.getFunction("api::full-consolidation-procedural-window");

    const first = await handler({ headers: {}, body });
    const replay = await handler({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });

    expect(first).toMatchObject({
      status_code: 200,
      body: {
        success: true,
        status: "skipped",
        proceduralMemoryIds: [],
        proceduralRecoveryEvidence: {
          kind: "no_effect",
          observation: "business_empty",
          reasonCode: "no_reusable_procedure",
          proof: { kind: "committed_structured_no_effect" },
        },
      },
    });
    expect(replay).toMatchObject({ status_code: 200, body: { status: "skipped" } });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const records = await kv.list<{ state: string; effectRefs?: unknown[] }>(
      KV.extractionContributionRecords(
        "consolidation_procedural",
        CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
      ),
    );
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.state === "no_effect")).toBe(true);
    expect(records.every((record) => record.effectRefs?.length === 0)).toBe(true);
    expect(await kv.list(KV.consolidationProceduralBacklog)).toEqual([]);
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
      const expectsRecoveryIdentity = [
        "api::full-consolidation-procedural-window",
        "api::full-reflect-insight-window",
      ].includes(entry.api);
      expect(sdk.trigger).toHaveBeenCalledWith({
        function_id: entry.function_id,
        payload: expectsRecoveryIdentity
          ? expect.objectContaining({
              ...entry.payload,
              recoveryIdentity: expect.objectContaining({
                runId: "formal-run",
                unitId: (entry.body as Record<string, unknown>).unitId,
                inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
              }),
            })
          : entry.payload,
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

  it("repairs incremental reflect reconciliation without replaying the provider", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        '<insights><insight confidence="0.8" title="Incremental evidence">'
          + "Exact new sources support a durable incremental insight."
          + "</insight></insights>",
      ),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    await kv.set(KV.semantic, "sem-reflect-api", {
      id: "sem-reflect-api",
      fact: "Exact semantic evidence for incremental reflection",
      confidence: 0.9,
      sourceSessionIds: [],
      sourceMemoryIds: [],
      accessCount: 0,
      lastAccessedAt: "2026-08-02T00:00:00.000Z",
      strength: 0.9,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    await kv.set(KV.lessons, "lsn-reflect-api", {
      id: "lsn-reflect-api",
      content: "Use exact lesson provenance for incremental reflection",
      context: "",
      confidence: 0.8,
      reinforcements: 0,
      source: "extracted",
      sourceIds: [],
      tags: ["incremental"],
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      decayRate: 0.05,
    });
    await kv.set(KV.crystals, "crys-reflect-api", {
      id: "crys-reflect-api",
      narrative: "Completed exact-source reflection handoff",
      keyOutcomes: ["incremental"],
      filesAffected: [],
      lessons: ["retain provenance"],
      sourceActionIds: [],
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const planHandler = sdk.getFunction("api::full-reflect-insight-windows-plan");
    const planned = await planHandler({
      headers: {},
      body: {
        useGraph: false,
        semanticMemoryIds: ["sem-reflect-api"],
        lessonIds: ["lsn-reflect-api"],
        crystalIds: ["crys-reflect-api"],
      },
    });
    expect(planned.status_code).toBe(200);
    const window = planned.body.windows[0] as {
      windowId: string;
      semanticMemoryIds: string[];
      lessonIds: string[];
      crystalIds: string[];
      stageContractVersion: string;
      sourceVersionKeys: string[];
    };
    expect(window).toMatchObject({
      semanticMemoryIds: ["sem-reflect-api"],
      lessonIds: ["lsn-reflect-api"],
      crystalIds: ["crys-reflect-api"],
      stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
    });
    const body = {
      runId: "reflect-api-run",
      stage: "reflect_insight",
      unitId: window.windowId,
      inputHash: "a".repeat(64),
      useGraph: false,
      semanticMemoryIds: window.semanticMemoryIds,
      lessonIds: window.lessonIds,
      crystalIds: window.crystalIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
    };
    const runHandler = sdk.getFunction("api::full-reflect-insight-window");
    const originalSet = kv.set;
    let interruptContributionWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (
        interruptContributionWrite
        && scope === KV.extractionContributionRecords(
          "reflect_insight",
          REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        )
        && (data as { state?: string }).state === "committed"
      ) {
        interruptContributionWrite = false;
        throw new Error("reflect contribution response lost");
      }
      return originalSet(scope, key, data);
    };
    const interrupted = await runHandler({ headers: {}, body });
    const replay = await runHandler({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });

    expect(interrupted).toMatchObject({
      status_code: 503,
      body: {
        success: false,
        failure: { cause: "extraction_operation_reconciliation_required" },
        operationReceipt: { status: "succeeded" },
      },
    });
    expect(replay).toMatchObject({
      status_code: 200,
      body: { success: true, insightIds: [expect.stringMatching(/^ins_/)] },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(await planHandler({ headers: {}, body: { useGraph: false } }))
      .toMatchObject({ status_code: 200, body: { windows: [], totalItems: 0 } });
    expect(await kv.list<{ state: string }>(KV.extractionContributionRecords(
      "reflect_insight",
      REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "committed" }),
      expect.objectContaining({ state: "committed" }),
      expect.objectContaining({ state: "committed" }),
    ]));
  });

  it("repairs a semantic-to-reflect handoff from the committed receipt without another provider effect", async () => {
    const kv = mockKV();
    let providerEffects = 0;
    const sdk = mockSdk(async ({ function_id, payload }) => {
      expect(function_id).toBe("mem::semantic-rollup");
      const recoveryIdentity = (payload as Record<string, unknown>).recoveryIdentity as {
        runId: string;
        stage: "semantic_rollup";
        unitId: string;
        inputHash: string;
      };
      const key = buildExtractionOperationKey(recoveryIdentity);
      const scope = KV.extractionOperationReceipt(key);
      const receipt = await kv.get<Record<string, unknown>>(scope, key);
      if (!(receipt as { semanticRecovery?: unknown })?.semanticRecovery) {
        providerEffects += 1;
        await kv.set(scope, key, {
          ...receipt,
          semanticRecovery: {
            schema: "semantic-rollup-recovery/v1",
            phase: "committed",
            identity: {
              runId: recoveryIdentity.runId,
              unitId: recoveryIdentity.unitId,
              receiptInputHash: recoveryIdentity.inputHash,
            },
          },
        });
      }
      return {
        success: true,
        status: "succeeded",
        semanticMemoryIds: ["sem-handoff-repair"],
      };
    });
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::semantic-rollup");
    const body = {
      runId: "semantic-handoff-run",
      stage: "semantic_rollup",
      unitId: "semantic-handoff-window",
      inputHash: "b".repeat(64),
      windowId: "semantic-handoff-window",
      mark: "incremental",
      kind: "window",
      sessionIds: ["session-handoff"],
      sourceSummaryHashes: { "session-handoff": "c".repeat(64) },
    };

    expect(await handler({ headers: {}, body })).toMatchObject({
      status_code: 503,
      body: {
        failure: { cause: "extraction_operation_reconciliation_required" },
        operationReceipt: { status: "succeeded" },
      },
    });
    expect(providerEffects).toBe(1);
    await kv.set(KV.semantic, "sem-handoff-repair", {
      id: "sem-handoff-repair",
      fact: "Committed semantic effect becomes visible to the handoff repair",
      confidence: 0.9,
      sourceSessionIds: ["session-handoff"],
      sourceMemoryIds: [],
      accessCount: 0,
      lastAccessedAt: "2026-08-02T00:00:00.000Z",
      strength: 0.9,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(await handler({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    })).toMatchObject({ status_code: 200, body: { success: true } });
    expect(providerEffects).toBe(1);
    expect(await kv.list<{ sourceType: string; sourceId: string }>(KV.reflectInsightBacklog))
      .toEqual([
        expect.objectContaining({ sourceType: "semantic", sourceId: "sem-handoff-repair" }),
      ]);
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
        stageContractVersion: "crystal/v1",
        sourceVersionKeys: [`crystal|action|action-1|${"a".repeat(64)}`],
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::full-crystals-auto",
      payload: {
        groupId: "crystal-group:1:repo",
        actionIds: ["action-1"],
        actionUpdatedAts: ["2026-07-24T00:00:00.000Z"],
        stageContractVersion: "crystal/v1",
        sourceVersionKeys: [`crystal|action|action-1|${"a".repeat(64)}`],
        runId: "crystal-attempt",
        unitId: "crystal-group:1:repo",
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("repairs a committed crystal contribution without another provider call", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        '{"narrative":"done","keyOutcomes":["shipped"],"filesAffected":["a.ts"],"lessons":["verify effects"]}',
      ),
    };
    registerLessonsFunctions(sdk as never, kv as never);
    registerCrystallizeFunction(sdk as never, kv as never, provider as never);
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-crystals-auto");
    const action = {
      id: "action-contribution",
      title: "Finish contribution",
      description: "Commit the durable result",
      status: "done",
      priority: 5,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
      createdBy: "test",
      project: "repo",
      tags: ["release"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
      result: "complete",
    };
    await kv.set(KV.actions, action.id, action);

    const planned = await handler({ headers: {}, body: { dryRun: true, project: "repo" } });
    const group = planned.body.groups[0] as {
      groupId: string;
      actionIds: string[];
      actionUpdatedAts: string[];
      stageContractVersion: string;
      sourceVersionKeys: string[];
      project: string;
    };
    expect(group).toMatchObject({
      actionIds: [action.id],
      stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
      sourceVersionKeys: [expect.stringMatching(/^crystal\|action\|/)],
    });
    const body = {
      runId: "crystal-contribution-run",
      stage: "crystal",
      unitId: group.groupId,
      inputHash: "runner-crystal-input",
      groupId: group.groupId,
      actionIds: group.actionIds,
      actionUpdatedAts: group.actionUpdatedAts,
      stageContractVersion: group.stageContractVersion,
      sourceVersionKeys: group.sourceVersionKeys,
      project: group.project,
    };
    const originalSet = kv.set;
    let failContributionWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (
        failContributionWrite
        && scope === KV.extractionContributionRecords(
          "crystal",
          CRYSTAL_CONTRIBUTION_CONTRACT,
        )
        && (data as { state?: string }).state === "committed"
      ) {
        failContributionWrite = false;
        throw new Error("contribution response lost");
      }
      return originalSet(scope, key, data);
    };

    const interrupted = await handler({ headers: {}, body });
    expect(interrupted).toMatchObject({
      status_code: 503,
      body: {
        success: false,
        failure: { cause: "extraction_operation_reconciliation_required" },
        operationReceipt: { status: "succeeded" },
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const contributionScope = KV.extractionContributionRecords(
      "crystal",
      CRYSTAL_CONTRIBUTION_CONTRACT,
    );
    expect(await kv.get<{ state: string }>(contributionScope, group.sourceVersionKeys[0]))
      .toMatchObject({ state: "claimed" });

    const resumed = await handler({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    expect(resumed).toMatchObject({ status_code: 200, body: { success: true } });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(await kv.get<{ state: string }>(contributionScope, group.sourceVersionKeys[0]))
      .toMatchObject({ state: "committed" });
    expect(await kv.list(KV.crystals)).toHaveLength(1);
    expect(await kv.list<{ sourceType: string; sourceId: string }>(KV.reflectInsightBacklog))
      .toEqual([
        expect.objectContaining({ sourceType: "crystal", sourceId: expect.stringMatching(/^crys_/) }),
      ]);
    expect((await kv.list<{ operation: string }>(KV.audit))
      .filter((entry) => entry.operation === "crystallize")).toHaveLength(1);

    const cleanPlan = await handler({ headers: {}, body: { dryRun: true, project: "repo" } });
    expect(cleanPlan.body).toMatchObject({ success: true, groupCount: 0 });
    expect(provider.summarize).toHaveBeenCalledTimes(1);

    const [crystal] = await kv.list<{ id: string }>(KV.crystals);
    await kv.delete(KV.crystals, crystal.id);
    const missingEffect = await handler({
      headers: {},
      body: { ...body, requireExistingReceipt: true },
    });
    expect(missingEffect.status_code).toBe(409);
    expect(provider.summarize).toHaveBeenCalledTimes(1);

    const committedAction = await kv.get<Record<string, unknown>>(KV.actions, action.id);
    await kv.set(KV.actions, action.id, {
      ...committedAction,
      title: "Corrected after contribution",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });
    const correctionPlan = await handler({
      headers: {},
      body: { dryRun: true, project: "repo" },
    });
    expect(correctionPlan.body).toMatchObject({
      success: true,
      groupCount: 1,
      groups: [{
        actionIds: [action.id],
        isolateReason: "crystal_source_correction_requires_migration",
      }],
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
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

  it("binds incremental memory planning to explicit selected session ids", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    for (let index = 0; index < 3; index++) {
      await kv.set(KV.observations("selected-session"), `obs-${index}`, {
        id: `obs-${index}`,
        sessionId: "selected-session",
        timestamp: "2026-08-02T00:00:00.000Z",
        type: "decision",
        title: `Observation ${index}`,
        facts: [],
        narrative: `Evidence ${index}`,
        concepts: ["windows"],
        files: [],
        importance: 8,
      });
    }
    const originalList = kv.list.bind(kv);
    kv.list = vi.fn(async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.sessions) throw new Error("full_session_inventory_forbidden");
      return originalList<T>(scope);
    });
    registerConsolidateFunction(
      sdk as never,
      kv as never,
      { compress: vi.fn() } as never,
    );
    registerApiTriggers(sdk as never, kv as never, "");
    const handler = sdk.getFunction("api::full-memory-consolidate-windows-plan");
    const base = {
      plannerId: "selected-plan",
      sessionIds: ["selected-session"],
      charBudget: 10_000,
    };
    const descriptorPage = await handler({
      headers: {},
      body: { ...base, sessionOffset: 0, sessionLimit: 8 },
    });
    expect(descriptorPage.status_code).toBe(200);
    expect(descriptorPage.body).toMatchObject({ totalSessions: 1, nextSessionOffset: null });

    const finalized = await handler({
      headers: {},
      body: {
        ...base,
        minObservationsPerConcept: 3,
        windowOffset: 0,
        windowLimit: 8,
      },
    });
    expect(finalized.status_code).toBe(200);
    expect(finalized.body.windows).toHaveLength(1);
    expect(kv.list).not.toHaveBeenCalledWith(KV.sessions);
  });
});
