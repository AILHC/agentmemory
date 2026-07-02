import { describe, it, expect, beforeEach, vi } from "vitest";

import { registerGraphBuildTaskFunctions } from "../src/functions/graph-build-tasks.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, GraphBuildTask, Session } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerSpy = vi.fn(async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
    const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
    const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
    const fn = functions.get(id);
    if (!fn) throw new Error(`No function: ${id}`);
    return fn(payload);
  });
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: triggerSpy,
    getFunction: (id: string): Function => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn;
    },
  };
}

function makeSession(id: string): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo",
    startedAt: "2026-07-01T00:00:00.000Z",
    status: "completed",
    observationCount: 0,
  };
}

function makeObservation(id: string, sessionId: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-07-01T00:00:00.000Z",
    type: "decision",
    title: `Observation ${id}`,
    facts: [`fact ${id}`],
    narrative: `Narrative ${id}`,
    concepts: ["graph"],
    files: [],
    importance: 0.5,
  };
}

describe("graph build task functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerGraphBuildTaskFunctions(sdk as never, kv as never);
  });

  it("creates a queued task without triggering graph extraction", async () => {
    await kv.set(KV.sessions, "s1", makeSession("s1"));
    await kv.set(KV.sessions, "s2", makeSession("s2"));

    const result = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: 250,
    })) as { success: boolean; taskId: string; status: string; task: GraphBuildTask };

    expect(result).toMatchObject({ success: true, status: "queued" });
    expect(result.taskId).toMatch(/^gbt_/);
    expect(result.task.batchSize).toBe(100);
    expect(result.task.progress.sessionTotal).toBe(2);
    expect(result.task.progress.sessionProcessed).toBe(0);
    expect(result.task.resultVisibility).toBe("none");
    expect(result.task).not.toHaveProperty("sessionIds");
    expect(sdk.trigger).not.toHaveBeenCalledWith(
      expect.objectContaining({ function_id: "mem::graph-extract" }),
    );
  });

  it("processes only a bounded number of batches using stable session id ordering", async () => {
    const extractedIds: string[] = [];
    sdk.registerFunction("mem::graph-extract", async (payload: { observations: CompressedObservation[] }) => {
      extractedIds.push(...payload.observations.map((o) => o.id));
      return { success: true, nodesAdded: 2, edgesAdded: 3 };
    });
    await kv.set(KV.sessions, "s2", makeSession("s2"));
    await kv.set(KV.sessions, "s1", makeSession("s1"));
    await kv.set(KV.observations("s1"), "o2", makeObservation("o2", "s1"));
    await kv.set(KV.observations("s1"), "o1", makeObservation("o1", "s1"));
    await kv.set(KV.observations("s1"), "o3", makeObservation("o3", "s1"));
    await kv.set(KV.observations("s2"), "o4", makeObservation("o4", "s2"));

    const created = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: 1,
    })) as { taskId: string };
    const processed = (await sdk.trigger("mem::graph-build-task-process", {
      taskId: created.taskId,
      maxBatches: 2,
    })) as { success: boolean; processedBatches: number; task: GraphBuildTask };

    expect(processed.success).toBe(true);
    expect(processed.processedBatches).toBe(2);
    expect(processed.task.status).toBe("running");
    expect(processed.task.cursor).toEqual({ sessionIndex: 0, batchIndex: 2 });
    expect(processed.task.progress.batchProcessed).toBe(2);
    expect(processed.task.progress.batchFailed).toBe(0);
    expect(processed.task.progress.nodeCount).toBe(4);
    expect(processed.task.progress.edgeCount).toBe(6);
    expect(processed.task.resultVisibility).toBe("partial");
    expect(extractedIds).toEqual(["o1", "o2"]);
  });

  it("defaults processing to one batch per invocation", async () => {
    sdk.registerFunction("mem::graph-extract", async () => ({
      success: true,
      nodesAdded: 1,
      edgesAdded: 1,
    }));
    await kv.set(KV.sessions, "s1", makeSession("s1"));
    await kv.set(KV.observations("s1"), "o1", makeObservation("o1", "s1"));
    await kv.set(KV.observations("s1"), "o2", makeObservation("o2", "s1"));

    const created = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: 1,
    })) as { taskId: string };
    const processed = (await sdk.trigger("mem::graph-build-task-process", {
      taskId: created.taskId,
    })) as { success: boolean; processedBatches: number; task: GraphBuildTask };

    expect(processed.success).toBe(true);
    expect(processed.processedBatches).toBe(1);
    expect(processed.task.status).toBe("running");
    expect(processed.task.cursor).toEqual({ sessionIndex: 0, batchIndex: 1 });
  });

  it("derives stale view status for an expired running lease without mutating persisted status", async () => {
    const task: GraphBuildTask = {
      id: "gbt_stale",
      status: "running",
      step: "processing",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      leaseUntil: "2026-07-01T00:01:00.000Z",
      leaseToken: "old-token",
      cursor: { sessionIndex: 0, batchIndex: 0 },
      progress: {
        sessionTotal: 1,
        sessionProcessed: 0,
        batchProcessed: 0,
        batchFailed: 0,
        nodeCount: 0,
        edgeCount: 0,
      },
      resultVisibility: "none",
      batchSize: 25,
    };
    await kv.set(KV.graphBuildTasks, task.id, task);

    const result = (await sdk.trigger("mem::graph-build-task-get", {
      taskId: task.id,
    })) as { success: boolean; viewStatus: string; task: GraphBuildTask };
    const persisted = await kv.get<GraphBuildTask>(KV.graphBuildTasks, task.id);

    expect(result.success).toBe(true);
    expect(result.viewStatus).toBe("stale");
    expect(result.task.status).toBe("running");
    expect(persisted?.status).toBe("running");
  });

  it("records batch failures with error metadata and continues cursor progress", async () => {
    const hugeError = `provider failed ${"x".repeat(2000)}`;
    sdk.registerFunction("mem::graph-extract", async () => ({
      success: false,
      error: hugeError,
    }));
    await kv.set(KV.sessions, "s1", makeSession("s1"));
    await kv.set(KV.observations("s1"), "o1", makeObservation("o1", "s1"));

    const created = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: 1,
    })) as { taskId: string };
    const processed = (await sdk.trigger("mem::graph-build-task-process", {
      taskId: created.taskId,
      maxBatches: 1,
    })) as { failedBatches: number; task: GraphBuildTask };

    expect(processed.failedBatches).toBe(1);
    expect(processed.task.status).toBe("failed");
    expect(processed.task.progress.batchFailed).toBe(1);
    expect(processed.task.lastError).toContain("provider failed");
    expect(processed.task.lastError!.length).toBeLessThanOrEqual(512);
    expect(processed.task.errorClass).toBe("GraphExtractFailed");
    expect(processed.task.resultVisibility).toBe("none");
  });

  it("returns success for terminal task process attempts", async () => {
    const task: GraphBuildTask = {
      id: "gbt_done",
      status: "succeeded",
      step: "succeeded",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:02:00.000Z",
      cursor: { sessionIndex: 1, batchIndex: 0 },
      progress: {
        sessionTotal: 1,
        sessionProcessed: 1,
        batchProcessed: 1,
        batchFailed: 0,
        nodeCount: 2,
        edgeCount: 3,
      },
      resultVisibility: "published",
      batchSize: 25,
    };
    await kv.set(KV.graphBuildTasks, task.id, task);

    const result = (await sdk.trigger("mem::graph-build-task-process", {
      taskId: task.id,
      maxBatches: 1,
    })) as { success: boolean; alreadyFinished: boolean; viewStatus: string; task: GraphBuildTask };

    expect(result.success).toBe(true);
    expect(result.alreadyFinished).toBe(true);
    expect(result.viewStatus).toBe("succeeded");
    expect(result.task.status).toBe("succeeded");
  });

  it("keeps result visibility none when a task finishes without processing any batches", async () => {
    const created = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: 1,
    })) as { taskId: string };
    const processed = (await sdk.trigger("mem::graph-build-task-process", {
      taskId: created.taskId,
      maxBatches: 1,
    })) as { task: GraphBuildTask };

    expect(processed.task.status).toBe("succeeded");
    expect(processed.task.progress.batchProcessed).toBe(0);
    expect(processed.task.resultVisibility).toBe("none");
  });

  it("does not report terminal success when the final state save loses its lease", async () => {
    const created = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: 1,
    })) as { taskId: string };
    const originalList = kv.list;
    let sabotage = true;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      const values = await originalList<T>(scope);
      if (scope === KV.sessions && sabotage) {
        sabotage = false;
        const current = await kv.get<GraphBuildTask>(KV.graphBuildTasks, created.taskId);
        if (current) {
          await kv.set(KV.graphBuildTasks, current.id, {
            ...current,
            leaseToken: "stolen-lease",
          });
        }
      }
      return values;
    };

    const processed = (await sdk.trigger("mem::graph-build-task-process", {
      taskId: created.taskId,
      maxBatches: 1,
    })) as { success: boolean; statusCode: number; error: string; task: GraphBuildTask };

    expect(processed.success).toBe(false);
    expect(processed.statusCode).toBe(409);
    expect(processed.error).toBe("task lease lost");
    expect(processed.task.leaseToken).toBe("stolen-lease");
  });

  it("validates create and process parameters", async () => {
    const badCreate = (await sdk.trigger("mem::graph-build-task-create", {
      batchSize: "not-a-number",
    })) as { success: boolean; error: string };
    const badProcess = (await sdk.trigger("mem::graph-build-task-process", {
      maxBatches: 1,
    })) as { success: boolean; error: string };

    expect(badCreate).toMatchObject({ success: false });
    expect(badCreate.error).toContain("batchSize");
    expect(badProcess).toMatchObject({ success: false });
    expect(badProcess.error).toContain("taskId");
  });
});

describe("graph build REST wrappers", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("api::graph-build passes only whitelisted fields to task create", async () => {
    sdk.registerFunction("mem::graph-build-task-create", async (payload: unknown) => ({
      success: true,
      payload,
    }));
    const handler = sdk.getFunction("api::graph-build");

    const response = await handler({
      body: { batchSize: 10, maxSessions: 20 },
      headers: {},
      query_params: {},
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::graph-build-task-create",
      payload: { batchSize: 10, maxSessions: 20 },
    });
    expect(response.body).toMatchObject({
      success: true,
      payload: { batchSize: 10, maxSessions: 20 },
    });
  });

  it("api::graph-build rejects unknown fields without triggering task create", async () => {
    const handler = sdk.getFunction("api::graph-build");

    const response = await handler({
      body: { batchSize: 10, rawBody: { shouldNotPass: true } },
      headers: {},
      query_params: {},
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("api::graph-build-process passes only taskId and maxBatches", async () => {
    sdk.registerFunction("mem::graph-build-task-process", async (payload: unknown) => ({
      success: true,
      payload,
    }));
    const handler = sdk.getFunction("api::graph-build-process");

    const response = await handler({
      body: { taskId: "gbt_1", maxBatches: 3 },
      headers: {},
      query_params: {},
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::graph-build-task-process",
      payload: { taskId: "gbt_1", maxBatches: 3 },
    });
    expect(response.body).toMatchObject({
      success: true,
      payload: { taskId: "gbt_1", maxBatches: 3 },
    });
  });

  it("api::graph-build-process rejects unknown fields and missing taskId", async () => {
    const handler = sdk.getFunction("api::graph-build-process");

    const unknownField = await handler({
      body: { taskId: "gbt_1", maxBatches: 3, rawBody: true },
      headers: {},
      query_params: {},
    });
    const missingTaskId = await handler({
      body: { maxBatches: 3 },
      headers: {},
      query_params: {},
    });

    expect(unknownField.status_code).toBe(400);
    expect(missingTaskId.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("api::graph-build-task forwards taskId query param to task get", async () => {
    sdk.registerFunction("mem::graph-build-task-get", async (payload: unknown) => ({
      success: true,
      payload,
    }));
    const handler = sdk.getFunction("api::graph-build-task");

    const response = await handler({
      body: {},
      headers: {},
      query_params: { taskId: "gbt_1" },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::graph-build-task-get",
      payload: { taskId: "gbt_1" },
    });
    expect(response.body).toMatchObject({
      success: true,
      payload: { taskId: "gbt_1" },
    });
  });

  it("api::graph-build-task rejects missing taskId query param", async () => {
    const handler = sdk.getFunction("api::graph-build-task");

    const response = await handler({
      body: {},
      headers: {},
      query_params: {},
    });

    expect(response.status_code).toBe(400);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });
});
