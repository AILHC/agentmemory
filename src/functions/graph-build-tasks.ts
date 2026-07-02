import type { ISdk } from "iii-sdk";

import { logger } from "../logger.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  CompressedObservation,
  GraphBuildResultVisibility,
  GraphBuildTask,
  Session,
} from "../types.js";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const MAX_SESSION_LIMIT = 100_000;
const DEFAULT_MAX_BATCHES = 1;
const MAX_PROCESS_BATCHES = 20;
const PROCESS_BUDGET_MS = 20_000;
const SAVE_MARGIN_MS = 3_000;
const LEASE_MS = 45_000;
const MAX_ERROR_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalPositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function truncateError(value: unknown): string {
  const msg = value instanceof Error ? value.message : String(value);
  return msg.length > MAX_ERROR_LENGTH ? msg.slice(0, MAX_ERROR_LENGTH) : msg;
}

function errorClass(value: unknown, fallback: string): string {
  return value instanceof Error && value.name ? value.name : fallback;
}

function isLeaseExpired(task: GraphBuildTask, nowMs: number): boolean {
  return !task.leaseUntil || Date.parse(task.leaseUntil) <= nowMs;
}

function viewStatus(task: GraphBuildTask, nowMs: number): GraphBuildTask["status"] | "stale" {
  if (task.status === "running" && isLeaseExpired(task, nowMs)) return "stale";
  return task.status;
}

function visibilityFor(task: GraphBuildTask): GraphBuildResultVisibility {
  if (task.status === "succeeded") return "published";
  if (task.progress.batchProcessed > 0) return "partial";
  return "none";
}

async function saveIfLeaseCurrent(
  kv: StateKV,
  task: GraphBuildTask,
  leaseToken: string,
): Promise<boolean> {
  const current = await kv.get<GraphBuildTask>(KV.graphBuildTasks, task.id);
  if (!current || current.leaseToken !== leaseToken) return false;
  await kv.set(KV.graphBuildTasks, task.id, task);
  return true;
}

async function leaseLostResponse(
  kv: StateKV,
  task: GraphBuildTask,
  processedBatches: number,
  failedBatches: number,
  nodesAdded: number,
  edgesAdded: number,
) {
  const currentTask = await kv.get<GraphBuildTask>(KV.graphBuildTasks, task.id);
  return {
    success: false,
    statusCode: 409,
    error: "task lease lost",
    task: currentTask ?? task,
    processedBatches,
    failedBatches,
    nodesAdded,
    edgesAdded,
  };
}

async function claimTask(
  kv: StateKV,
  taskId: string,
  nowMs: number,
): Promise<
  | { ok: true; task: GraphBuildTask; leaseToken: string }
  | { ok: false; statusCode: number; error: string; task?: GraphBuildTask; alreadyFinished?: boolean }
> {
  const task = await kv.get<GraphBuildTask>(KV.graphBuildTasks, taskId);
  if (!task) return { ok: false, statusCode: 404, error: "task not found" };
  if (task.status === "succeeded" || task.status === "failed") {
    return {
      ok: false,
      statusCode: 200,
      error: "task is already finished",
      task,
      alreadyFinished: true,
    };
  }
  if (task.status === "running" && !isLeaseExpired(task, nowMs)) {
    return { ok: false, statusCode: 409, error: "task is already running", task };
  }

  const now = new Date(nowMs).toISOString();
  const leaseToken = generateId("lease");
  const claimed: GraphBuildTask = {
    ...task,
    status: "running",
    step: "processing",
    startedAt: task.startedAt ?? now,
    updatedAt: now,
    leaseToken,
    leaseUntil: new Date(nowMs + LEASE_MS).toISOString(),
    cursor: task.cursor ?? { sessionIndex: 0, batchIndex: 0 },
  };
  await kv.set(KV.graphBuildTasks, task.id, claimed);
  const current = await kv.get<GraphBuildTask>(KV.graphBuildTasks, task.id);
  if (!current || current.leaseToken !== leaseToken) {
    return { ok: false, statusCode: 409, error: "task claim lost", task: current ?? task };
  }
  return { ok: true, task: current, leaseToken };
}

function finishTask(task: GraphBuildTask, now: string): GraphBuildTask {
  const failed = task.progress.batchFailed > 0;
  return {
    ...task,
    status: failed ? "failed" : "succeeded",
    step: failed ? "failed" : "succeeded",
    updatedAt: now,
    finishedAt: now,
    leaseUntil: undefined,
    leaseToken: undefined,
    resultVisibility: failed
      ? visibilityFor(task)
      : task.progress.batchProcessed > 0
        ? "published"
        : "none",
  };
}

function extractCounts(result: unknown): { ok: boolean; nodes: number; edges: number; error?: string } {
  if (!isRecord(result) || result.success !== true) {
    const err = isRecord(result) && typeof result.error === "string"
      ? result.error
      : "mem::graph-extract returned success=false";
    return { ok: false, nodes: 0, edges: 0, error: err };
  }
  return {
    ok: true,
    nodes: typeof result.nodesAdded === "number" ? result.nodesAdded : 0,
    edges: typeof result.edgesAdded === "number" ? result.edgesAdded : 0,
  };
}

async function listTaskSessionIds(kv: StateKV, task: GraphBuildTask): Promise<string[]> {
  const sessions = await kv.list<Session>(KV.sessions);
  return sessions
    .map((s) => s?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, task.maxSessions);
}

export function registerGraphBuildTaskFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::graph-build-task-create",
    async (data: unknown) => {
      if (!isRecord(data)) data = {};
      const input = data as Record<string, unknown>;

      const batchSizeInput = parseOptionalPositiveInt(input.batchSize);
      if (batchSizeInput === null) {
        return { success: false, error: "batchSize must be a positive integer" };
      }
      const maxSessionsInput = parseOptionalPositiveInt(input.maxSessions);
      if (maxSessionsInput === null) {
        return { success: false, error: "maxSessions must be a positive integer" };
      }

      const maxSessions =
        maxSessionsInput === undefined
          ? undefined
          : clamp(maxSessionsInput, 1, MAX_SESSION_LIMIT);
      const sessions = await kv.list<Session>(KV.sessions);
      const sessionTotal = sessions
        .map((s) => s?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, maxSessions).length;
      const now = new Date().toISOString();
      const task: GraphBuildTask = {
        id: generateId("gbt"),
        status: "queued",
        step: "queued",
        createdAt: now,
        updatedAt: now,
        cursor: { sessionIndex: 0, batchIndex: 0 },
        progress: {
          sessionTotal,
          sessionProcessed: 0,
          batchProcessed: 0,
          batchFailed: 0,
          nodeCount: 0,
          edgeCount: 0,
        },
        resultVisibility: "none",
        batchSize: clamp(batchSizeInput ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
      };
      if (maxSessions !== undefined) task.maxSessions = maxSessions;
      await kv.set(KV.graphBuildTasks, task.id, task);
      return { success: true, taskId: task.id, status: task.status, task };
    },
  );

  sdk.registerFunction(
    "mem::graph-build-task-get",
    async (data: unknown) => {
      if (!isRecord(data) || typeof data.taskId !== "string" || !data.taskId.trim()) {
        return { success: false, error: "taskId is required" };
      }
      const task = await kv.get<GraphBuildTask>(KV.graphBuildTasks, data.taskId.trim());
      if (!task) return { success: false, error: "task not found" };
      return { success: true, task, viewStatus: viewStatus(task, Date.now()) };
    },
  );

  sdk.registerFunction(
    "mem::graph-build-task-process",
    async (data: unknown) => {
      if (!isRecord(data) || typeof data.taskId !== "string" || !data.taskId.trim()) {
        return { success: false, error: "taskId is required" };
      }
      const maxBatchesInput = parseOptionalPositiveInt(data.maxBatches);
      if (maxBatchesInput === null) {
        return { success: false, error: "maxBatches must be a positive integer" };
      }

      const startedMs = Date.now();
      const deadlineMs = startedMs + PROCESS_BUDGET_MS;
      const claim = await claimTask(kv, data.taskId.trim(), startedMs);
      if (!claim.ok) {
        if (claim.alreadyFinished && claim.task) {
          return {
            success: true,
            task: claim.task,
            viewStatus: viewStatus(claim.task, Date.now()),
            alreadyFinished: true,
            processedBatches: 0,
            failedBatches: 0,
            nodesAdded: 0,
            edgesAdded: 0,
          };
        }
        return { success: false, error: claim.error, statusCode: claim.statusCode, task: claim.task };
      }

      const leaseToken = claim.leaseToken;
      let task = claim.task;
      const maxBatches = clamp(maxBatchesInput ?? DEFAULT_MAX_BATCHES, 1, MAX_PROCESS_BATCHES);
      let processedBatches = 0;
      let failedBatches = 0;
      let nodesAdded = 0;
      let edgesAdded = 0;
      const sessionIds = await listTaskSessionIds(kv, task);
      if (task.progress.sessionTotal !== sessionIds.length) {
        task = {
          ...task,
          progress: { ...task.progress, sessionTotal: sessionIds.length },
        };
      }

      while (processedBatches + failedBatches < maxBatches) {
        if (Date.now() >= deadlineMs - SAVE_MARGIN_MS) {
          task = { ...task, updatedAt: new Date().toISOString(), resultVisibility: visibilityFor(task) };
          const saved = await saveIfLeaseCurrent(kv, task, leaseToken);
          if (!saved) {
            return leaseLostResponse(
              kv,
              task,
              processedBatches,
              failedBatches,
              nodesAdded,
              edgesAdded,
            );
          }
          return {
            success: true,
            task,
            processedBatches,
            failedBatches,
            nodesAdded,
            edgesAdded,
            budgetExhausted: true,
          };
        }

        const current = await kv.get<GraphBuildTask>(KV.graphBuildTasks, task.id);
        if (!current || current.leaseToken !== leaseToken) {
          return leaseLostResponse(
            kv,
            task,
            processedBatches,
            failedBatches,
            nodesAdded,
            edgesAdded,
          );
        }

        let cursor = task.cursor ?? { sessionIndex: 0, batchIndex: 0 };
        if (cursor.sessionIndex >= sessionIds.length) {
          task = finishTask(task, new Date().toISOString());
          const saved = await saveIfLeaseCurrent(kv, task, leaseToken);
          if (!saved) {
            return leaseLostResponse(
              kv,
              task,
              processedBatches,
              failedBatches,
              nodesAdded,
              edgesAdded,
            );
          }
          return {
            success: true,
            task,
            processedBatches,
            failedBatches,
            nodesAdded,
            edgesAdded,
          };
        }

        const sessionId = sessionIds[cursor.sessionIndex];
        const observations = await kv.list<CompressedObservation>(KV.observations(sessionId));
        const compressed = observations.filter(
          (o) => o && typeof o.title === "string" && o.title.length > 0,
        ).sort((a, b) => {
          const aKey = `${a.timestamp ?? ""}|${a.id ?? ""}`;
          const bKey = `${b.timestamp ?? ""}|${b.id ?? ""}`;
          return aKey.localeCompare(bKey);
        });
        const batchStart = cursor.batchIndex * task.batchSize;
        const batch = compressed.slice(batchStart, batchStart + task.batchSize);
        if (batch.length === 0) {
          task = {
            ...task,
            cursor: { sessionIndex: cursor.sessionIndex + 1, batchIndex: 0 },
            updatedAt: new Date().toISOString(),
            progress: {
              ...task.progress,
              sessionProcessed: Math.min(
                task.progress.sessionTotal ?? sessionIds.length,
                task.progress.sessionProcessed + 1,
              ),
            },
            resultVisibility: visibilityFor(task),
          };
          const saved = await saveIfLeaseCurrent(kv, task, leaseToken);
          if (!saved) {
            return leaseLostResponse(
              kv,
              task,
              processedBatches,
              failedBatches,
              nodesAdded,
              edgesAdded,
            );
          }
          continue;
        }

        try {
          const result = await sdk.trigger({
            function_id: "mem::graph-extract",
            payload: { observations: batch },
          });
          const counts = extractCounts(result);
          if (!counts.ok) {
            failedBatches += 1;
            task = {
              ...task,
              lastError: truncateError(counts.error),
              errorClass: "GraphExtractFailed",
              progress: {
                ...task.progress,
                batchFailed: task.progress.batchFailed + 1,
              },
            };
          } else {
            processedBatches += 1;
            nodesAdded += counts.nodes;
            edgesAdded += counts.edges;
            task = {
              ...task,
              progress: {
                ...task.progress,
                batchProcessed: task.progress.batchProcessed + 1,
                nodeCount: task.progress.nodeCount + counts.nodes,
                edgeCount: task.progress.edgeCount + counts.edges,
              },
            };
          }
        } catch (err) {
          failedBatches += 1;
          task = {
            ...task,
            lastError: truncateError(err),
            errorClass: errorClass(err, "GraphExtractError"),
            progress: {
              ...task.progress,
              batchFailed: task.progress.batchFailed + 1,
            },
          };
          logger.warn("graph-build task batch failed", {
            taskId: task.id,
            sessionId,
            batchIndex: cursor.batchIndex,
            error: task.lastError,
          });
        }

        const nextBatchIndex = cursor.batchIndex + 1;
        const sessionCompleted = nextBatchIndex * task.batchSize >= compressed.length;
        const nextSession =
          sessionCompleted ? cursor.sessionIndex + 1 : cursor.sessionIndex;
        cursor =
          sessionCompleted
            ? { sessionIndex: nextSession, batchIndex: 0 }
            : { sessionIndex: cursor.sessionIndex, batchIndex: nextBatchIndex };
        task = {
          ...task,
          cursor,
          updatedAt: new Date().toISOString(),
          resultVisibility: visibilityFor(task),
          progress: {
            ...task.progress,
            sessionProcessed:
              sessionCompleted
                ? Math.min(
                    task.progress.sessionTotal ?? sessionIds.length,
                    task.progress.sessionProcessed + 1,
                  )
                : task.progress.sessionProcessed,
          },
        };

        if (cursor.sessionIndex >= sessionIds.length) {
          task = finishTask(task, new Date().toISOString());
        }
        const saved = await saveIfLeaseCurrent(kv, task, leaseToken);
        if (!saved) {
          return leaseLostResponse(
            kv,
            task,
            processedBatches,
            failedBatches,
            nodesAdded,
            edgesAdded,
          );
        }
        if (task.status === "succeeded" || task.status === "failed") break;
      }

      return {
        success: true,
        task,
        processedBatches,
        failedBatches,
        nodesAdded,
        edgesAdded,
      };
    },
  );
}
