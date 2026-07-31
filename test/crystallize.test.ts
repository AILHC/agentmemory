import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildEligibleCrystalActionGroups,
  registerCrystallizeFunction,
} from "../src/functions/crystallize.js";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { KV } from "../src/state/schema.js";
import type {
  Action,
  AuditEntry,
  Crystal,
  Lesson,
  MemoryProvider,
} from "../src/types.js";

function mockKV(jsonRoundTrip = false) {
  const store = new Map<string, Map<string, unknown>>();
  const persistedValue = <T>(value: T): T => (
    jsonRoundTrip ? JSON.parse(JSON.stringify(value)) as T : value
  );
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const value = store.get(scope)?.get(key) as T | undefined;
      return value === undefined ? null : persistedValue(value);
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, persistedValue(data));
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
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function mockProvider(): MemoryProvider {
  return {
    name: "test",
    compress: vi.fn(),
    summarize: vi.fn().mockResolvedValue(
      '{"narrative":"test","keyOutcomes":["done"],"filesAffected":["a.ts"],"lessons":["learned"]}',
    ),
  };
}

function makeAction(overrides: Partial<Action> & { id: string }): Action {
  const stablePast = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    title: "Test action",
    description: "A test action",
    status: "done",
    priority: 5,
    createdAt: stablePast,
    updatedAt: stablePast,
    createdBy: "agent-1",
    tags: [],
    sourceObservationIds: [],
    sourceMemoryIds: [],
    ...overrides,
  };
}

async function seedRunningCrystalReceipt(
  kv: ReturnType<typeof mockKV>,
  payload: { runId: string; unitId: string; inputHash: string },
): Promise<string> {
  const identity = {
    runId: payload.runId,
    stage: "crystal" as const,
    unitId: payload.unitId,
    inputHash: payload.inputHash,
  };
  const key = buildExtractionOperationKey(identity);
  await kv.set(KV.extractionOperationReceipt(key), key, {
    ...identity,
    key,
    version: 1,
    status: "running",
    startedAt: "2026-07-29T00:00:00.000Z",
  });
  return key;
}

describe("Crystallize Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: MemoryProvider;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    provider = mockProvider();
    registerLessonsFunctions(sdk as never, kv as never);
    registerCrystallizeFunction(sdk as never, kv as never, provider);
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
  });

  describe("mem::crystallize", () => {
    it("crystallizes completed actions with valid JSON response", async () => {
      process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
      const action = makeAction({ id: "act_1", title: "Fix bug", status: "done" });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_1"],
        project: "webapp",
        sessionId: "sess_1",
      })) as { success: boolean; crystal: Crystal };

      expect(result.success).toBe(true);
      expect(result.crystal.id).toMatch(/^crys_/);
      expect(result.crystal.narrative).toBe("test");
      expect(result.crystal.keyOutcomes).toEqual(["done"]);
      expect(result.crystal.filesAffected).toEqual(["a.ts"]);
      expect(result.crystal.lessons).toEqual(["learned"]);
      expect(result.crystal.sourceActionIds).toEqual(["act_1"]);
      expect(result.crystal.project).toBe("webapp");
      expect(result.crystal.sessionId).toBe("sess_1");
      expect(result.crystal.createdAt).toBeDefined();
      expect(provider.summarize).toHaveBeenCalledWith(
        expect.stringContaining("AgentMemory Output Language Policy"),
        expect.any(String),
      );
    });

    it("uses the crystal stage model when the provider supports overrides", async () => {
      process.env.AGENTMEMORY_CRYSTAL_MODEL = "crystal-model";
      provider = { ...mockProvider(), name: "pi-agent-sdk" };
      registerCrystallizeFunction(sdk as never, kv as never, provider);
      const action = makeAction({ id: "act_crystal_model", status: "done" });
      await kv.set("mem:actions", action.id, action);

      await sdk.trigger("mem::crystallize", { actionIds: [action.id] });

      expect(provider.summarize).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { model: "crystal-model", modelSource: "AGENTMEMORY_CRYSTAL_MODEL" },
      );
    });

    it("marks source actions with crystallizedInto", async () => {
      const action = makeAction({ id: "act_mark", status: "done" });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_mark"],
      })) as { success: boolean; crystal: Crystal };

      expect(result.success).toBe(true);

      const updated = await kv.get<Action>("mem:actions", "act_mark");
      expect(updated!.crystallizedInto).toBe(result.crystal.id);
    });

    it("falls back to raw text when provider returns non-JSON", async () => {
      (provider.summarize as ReturnType<typeof vi.fn>).mockResolvedValue(
        "Just a plain text summary with no JSON.",
      );

      const action = makeAction({ id: "act_nojson", status: "done" });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_nojson"],
      })) as { success: boolean; crystal: Crystal };

      expect(result.success).toBe(true);
      expect(result.crystal.narrative).toBe(
        "Just a plain text summary with no JSON.",
      );
      expect(result.crystal.keyOutcomes).toEqual([]);
      expect(result.crystal.filesAffected).toEqual([]);
      expect(result.crystal.lessons).toEqual([]);
    });

    it("returns error for non-existent action", async () => {
      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_ghost"],
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("action not found: act_ghost");
    });

    it("returns error for non-done action", async () => {
      const action = makeAction({ id: "act_pending", status: "pending" });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_pending"],
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('status "pending"');
    });

    it("returns error for empty actionIds", async () => {
      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: [],
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("actionIds is required");
    });

    it("returns error when actionIds is missing", async () => {
      const result = (await sdk.trigger("mem::crystallize", {})) as {
        success: boolean;
        error: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("actionIds is required");
    });

    it("accepts cancelled actions", async () => {
      const action = makeAction({ id: "act_cancel", status: "cancelled" });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_cancel"],
      })) as { success: boolean; crystal: Crystal };

      expect(result.success).toBe(true);
      expect(result.crystal.sourceActionIds).toEqual(["act_cancel"]);
    });

    it("crystallizes multiple actions in one call", async () => {
      const a1 = makeAction({ id: "act_m1", status: "done", title: "First" });
      const a2 = makeAction({ id: "act_m2", status: "done", title: "Second" });
      await kv.set("mem:actions", a1.id, a1);
      await kv.set("mem:actions", a2.id, a2);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_m1", "act_m2"],
      })) as { success: boolean; crystal: Crystal };

      expect(result.success).toBe(true);
      expect(result.crystal.sourceActionIds).toEqual(["act_m1", "act_m2"]);
    });

    it("returns failure when provider throws", async () => {
      (provider.summarize as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("API down"),
      );

      const action = makeAction({ id: "act_fail", status: "done" });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::crystallize", {
        actionIds: ["act_fail"],
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("crystallization failed");
      expect(result.error).toContain("API down");
    });
  });

  describe("mem::crystal-list", () => {
    beforeEach(async () => {
      const c1: Crystal = {
        id: "crys_1",
        narrative: "First crystal",
        keyOutcomes: [],
        filesAffected: [],
        lessons: [],
        sourceActionIds: ["act_1"],
        project: "alpha",
        sessionId: "sess_a",
        createdAt: new Date("2025-01-01").toISOString(),
      };
      const c2: Crystal = {
        id: "crys_2",
        narrative: "Second crystal",
        keyOutcomes: [],
        filesAffected: [],
        lessons: [],
        sourceActionIds: ["act_2"],
        project: "beta",
        sessionId: "sess_b",
        createdAt: new Date("2025-02-01").toISOString(),
      };
      const c3: Crystal = {
        id: "crys_3",
        narrative: "Third crystal",
        keyOutcomes: [],
        filesAffected: [],
        lessons: [],
        sourceActionIds: ["act_3"],
        project: "alpha",
        sessionId: "sess_a",
        createdAt: new Date("2025-03-01").toISOString(),
      };
      await kv.set("mem:crystals", c1.id, c1);
      await kv.set("mem:crystals", c2.id, c2);
      await kv.set("mem:crystals", c3.id, c3);
    });

    it("returns all crystals sorted by createdAt desc", async () => {
      const result = (await sdk.trigger("mem::crystal-list", {})) as {
        success: boolean;
        crystals: Crystal[];
      };

      expect(result.success).toBe(true);
      expect(result.crystals.length).toBe(3);
      expect(result.crystals[0].id).toBe("crys_3");
      expect(result.crystals[1].id).toBe("crys_2");
      expect(result.crystals[2].id).toBe("crys_1");
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::crystal-list", {
        project: "alpha",
      })) as { success: boolean; crystals: Crystal[] };

      expect(result.success).toBe(true);
      expect(result.crystals.length).toBe(2);
      expect(result.crystals.every((c) => c.project === "alpha")).toBe(true);
    });

    it("filters by sessionId", async () => {
      const result = (await sdk.trigger("mem::crystal-list", {
        sessionId: "sess_b",
      })) as { success: boolean; crystals: Crystal[] };

      expect(result.success).toBe(true);
      expect(result.crystals.length).toBe(1);
      expect(result.crystals[0].id).toBe("crys_2");
    });

    it("respects limit", async () => {
      const result = (await sdk.trigger("mem::crystal-list", {
        limit: 1,
      })) as { success: boolean; crystals: Crystal[] };

      expect(result.success).toBe(true);
      expect(result.crystals.length).toBe(1);
      expect(result.crystals[0].id).toBe("crys_3");
    });
  });

  describe("mem::crystal-get", () => {
    it("returns crystal by id", async () => {
      const crystal: Crystal = {
        id: "crys_get_1",
        narrative: "Found it",
        keyOutcomes: ["yes"],
        filesAffected: ["b.ts"],
        lessons: ["test"],
        sourceActionIds: ["act_x"],
        createdAt: new Date().toISOString(),
      };
      await kv.set("mem:crystals", crystal.id, crystal);

      const result = (await sdk.trigger("mem::crystal-get", {
        crystalId: "crys_get_1",
      })) as { success: boolean; crystal: Crystal };

      expect(result.success).toBe(true);
      expect(result.crystal.id).toBe("crys_get_1");
      expect(result.crystal.narrative).toBe("Found it");
    });

    it("returns error for non-existent crystal", async () => {
      const result = (await sdk.trigger("mem::crystal-get", {
        crystalId: "crys_missing",
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("crystal not found");
    });

    it("returns error when crystalId is missing", async () => {
      const result = (await sdk.trigger("mem::crystal-get", {})) as {
        success: boolean;
        error: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("crystalId is required");
    });
  });

  describe("mem::auto-crystallize", () => {
    it("buildEligibleCrystalActionGroups exposes stable group ids and action ids", async () => {
      const action = makeAction({
        id: "act_group",
        status: "done",
        project: "proj",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      await kv.set("mem:actions", action.id, action);

      const groups = await buildEligibleCrystalActionGroups({
        kv: kv as never,
        olderThanDays: 7,
      });

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        groupId: "crystal-group:1:proj",
        groupKey: "proj",
        actionIds: ["act_group"],
        actionUpdatedAts: ["2026-06-01T00:00:00.000Z"],
        actionCount: 1,
      });
    });

    it("does not include recently updated done actions even when created long ago", async () => {
      const action = makeAction({
        id: "act_recent_update",
        status: "done",
        project: "proj",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
      });
      await kv.set("mem:actions", action.id, action);

      const groups = await buildEligibleCrystalActionGroups({
        kv: kv as never,
        olderThanDays: 7,
      });

      expect(groups).toHaveLength(0);
    });

    it("returns group summaries in dryRun mode", async () => {
      const action = makeAction({
        id: "act_dry",
        status: "done",
        project: "proj",
      });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::auto-crystallize", {
        dryRun: true,
      })) as {
        success: boolean;
        dryRun: boolean;
        groupCount: number;
        groups: { groupKey: string; actionCount: number; actionIds: string[]; actionUpdatedAts: string[] }[];
        crystalIds: string[];
      };

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.groupCount).toBe(1);
      expect(result.groups[0].actionIds).toContain("act_dry");
      expect(result.groups[0].actionUpdatedAts).toHaveLength(1);
      expect(result.crystalIds).toEqual([]);
    });

    it("executes one pinned group without rebuilding the live auto plan", async () => {
      const action = makeAction({
        id: "act_pinned",
        status: "done",
        project: "pinned-project",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::full-crystals-auto", {
        groupId: "crystal-group:pinned",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
      })) as {
        success: boolean;
        groupCount: number;
        groups: Array<{ groupId: string; actionIds: string[]; status: string }>;
        crystalIds: string[];
      };

      expect(result).toMatchObject({
        success: true,
        groupCount: 1,
        groups: [{
          groupId: "crystal-group:pinned",
          actionIds: [action.id],
          status: "succeeded",
        }],
      });
      expect(result.crystalIds).toHaveLength(1);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("hard-stops a pinned group when an action snapshot has drifted", async () => {
      const action = makeAction({
        id: "act_pinned_drift",
        status: "done",
        updatedAt: "2026-06-02T00:00:00.000Z",
      });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::full-crystals-auto", {
        groupId: "crystal-group:drift",
        actionIds: [action.id],
        actionUpdatedAts: ["2026-06-01T00:00:00.000Z"],
      })) as {
        success: boolean;
        status: string;
        failure: { class: string; cause: string };
      };

      expect(result).toMatchObject({
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "crystal_plan_drifted" },
      });
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("groups by parentId when present", async () => {
      const parent = makeAction({
        id: "act_parent",
        status: "done",
        parentId: undefined,
      });
      const child1 = makeAction({
        id: "act_child1",
        status: "done",
        parentId: "act_parent",
      });
      const child2 = makeAction({
        id: "act_child2",
        status: "done",
        parentId: "act_parent",
      });
      await kv.set("mem:actions", parent.id, parent);
      await kv.set("mem:actions", child1.id, child1);
      await kv.set("mem:actions", child2.id, child2);

      const result = (await sdk.trigger("mem::auto-crystallize", {
        dryRun: true,
      })) as {
        success: boolean;
        groups: { groupKey: string; actionCount: number; actionIds: string[] }[];
      };

      expect(result.success).toBe(true);
      const parentGroup = result.groups.find((g) => g.groupKey === "act_parent");
      expect(parentGroup).toBeDefined();
      expect(parentGroup!.actionCount).toBe(2);
    });

    it("groups by project when no parentId", async () => {
      const a1 = makeAction({ id: "act_proj1", status: "done", project: "webapp" });
      const a2 = makeAction({ id: "act_proj2", status: "done", project: "webapp" });
      const a3 = makeAction({ id: "act_proj3", status: "done", project: "api" });
      await kv.set("mem:actions", a1.id, a1);
      await kv.set("mem:actions", a2.id, a2);
      await kv.set("mem:actions", a3.id, a3);

      const result = (await sdk.trigger("mem::auto-crystallize", {
        dryRun: true,
      })) as {
        success: boolean;
        groups: { groupKey: string; actionCount: number }[];
      };

      expect(result.success).toBe(true);
      const webGroup = result.groups.find((g) => g.groupKey === "webapp");
      const apiGroup = result.groups.find((g) => g.groupKey === "api");
      expect(webGroup).toBeDefined();
      expect(webGroup!.actionCount).toBe(2);
      expect(apiGroup).toBeDefined();
      expect(apiGroup!.actionCount).toBe(1);
    });

    it("skips already-crystallized actions", async () => {
      const action = makeAction({
        id: "act_already",
        status: "done",
        crystallizedInto: "crys_existing",
      });
      await kv.set("mem:actions", action.id, action);

      const result = (await sdk.trigger("mem::auto-crystallize", {
        dryRun: true,
      })) as { success: boolean; groupCount: number };

      expect(result.success).toBe(true);
      expect(result.groupCount).toBe(0);
    });

    it("skips actions newer than threshold", async () => {
      const recentAction = makeAction({
        id: "act_recent",
        status: "done",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await kv.set("mem:actions", recentAction.id, recentAction);

      const result = (await sdk.trigger("mem::auto-crystallize", {
        olderThanDays: 7,
        dryRun: true,
      })) as { success: boolean; groupCount: number };

      expect(result.success).toBe(true);
      expect(result.groupCount).toBe(0);
    });

    it("creates crystals for each group in non-dryRun mode", async () => {
      const a1 = makeAction({ id: "act_auto1", status: "done", project: "proj1" });
      const a2 = makeAction({ id: "act_auto2", status: "done", project: "proj2" });
      await kv.set("mem:actions", a1.id, a1);
      await kv.set("mem:actions", a2.id, a2);

      const result = (await sdk.trigger("mem::auto-crystallize", {})) as {
        success: boolean;
        groupCount: number;
        crystalIds: string[];
      };

      expect(result.success).toBe(true);
      expect(result.groupCount).toBe(2);
      expect(result.crystalIds.length).toBe(2);
      expect(result.crystalIds[0]).toMatch(/^crys_/);
      expect(result.crystalIds[1]).toMatch(/^crys_/);
    });

    it("full auto-crystallize exposes failed groups and marks overall failure", async () => {
      (provider.summarize as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          '{"narrative":"ok","keyOutcomes":[],"filesAffected":[],"lessons":[]}',
        )
        .mockRejectedValueOnce(new Error("provider failed"));
      const ok = makeAction({ id: "act_full_ok", status: "done", project: "ok" });
      const fail = makeAction({ id: "act_full_fail", status: "done", project: "fail" });
      await kv.set("mem:actions", ok.id, ok);
      await kv.set("mem:actions", fail.id, fail);

      const result = (await sdk.trigger("mem::full-crystals-auto", {})) as {
        success: boolean;
        groupCount: number;
        crystalIds: string[];
        groups: Array<{
          groupId: string;
          actionIds: string[];
          actionUpdatedAts: string[];
          status: "succeeded" | "failed";
          crystalIds: string[];
          error?: string;
        }>;
      };

      expect(result.success).toBe(false);
      expect(result.groupCount).toBe(2);
      expect(result.crystalIds).toHaveLength(1);
      expect(result.groups).toEqual([
        expect.objectContaining({
          groupId: "crystal-group:1:ok",
          actionIds: ["act_full_ok"],
          actionUpdatedAts: [ok.updatedAt],
          status: "succeeded",
        }),
        expect.objectContaining({
          groupId: "crystal-group:2:fail",
          actionIds: ["act_full_fail"],
          actionUpdatedAts: [fail.updatedAt],
          status: "failed",
          crystalIds: [],
          error: expect.stringContaining("provider failed"),
        }),
      ]);
    });

    it("leaves a provider-failed crystal receipt running without formal effects", async () => {
      (provider.summarize as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error("pi_stream_failed"));
      const action = makeAction({
        id: "act_crystal_provider_failure",
        status: "done",
        project: "provider-failure",
      });
      await kv.set(KV.actions, action.id, action);
      const payload = {
        groupId: "crystal-group:provider-failure",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: action.project,
        runId: "crystal-provider-failure",
        unitId: "crystal-group:provider-failure",
        inputHash: "a".repeat(64),
      };
      const receiptKey = await seedRunningCrystalReceipt(kv, payload);
      const runningReceipt = await kv.get(
        KV.extractionOperationReceipt(receiptKey),
        receiptKey,
      );

      const result = await sdk.trigger("mem::full-crystals-auto", payload);

      expect(result).toMatchObject({
        success: false,
        groupCount: 1,
        crystalIds: [],
        groups: [
          expect.objectContaining({
            groupId: payload.groupId,
            status: "failed",
            crystalIds: [],
            error: expect.stringContaining("pi_stream_failed"),
          }),
        ],
      });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey))
        .toEqual(runningReceipt);
      expect(await kv.list(KV.crystals)).toEqual([]);
      expect(await kv.list(KV.lessons)).toEqual([]);
      expect(await kv.list(KV.audit)).toEqual([]);
      expect(await kv.get<Action>(KV.actions, action.id)).toEqual(action);
    });

    it("replays one pinned full-stage operation without repeating provider work", async () => {
      const action = makeAction({
        id: "act_full_replay",
        status: "done",
        project: "replay",
      });
      await kv.set("mem:actions", action.id, action);
      const payload = {
        groupId: "crystal-group:replay",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: "replay",
        runId: "run-crystal-replay",
        unitId: "crystal-group:replay",
        inputHash: "a".repeat(64),
      };
      const receiptKey = await seedRunningCrystalReceipt(kv, payload);

      const first = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        crystalIds: string[];
        crystalRecoveryEvidence: {
          schema: string;
          phase: string;
          receiptKey: string;
          receiptVersion: number;
          resultRef: string;
          effectHash: string;
          identity: {
            runId: string;
            unitId: string;
            inputHash: string;
          };
          group: {
            groupId: string;
            actionIds: string[];
            actionUpdatedAts: string[];
          };
        };
      };
      const committedReceipt = await kv.get<Record<string, unknown>>(
        KV.extractionOperationReceipt(receiptKey),
        receiptKey,
      );
      await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
        ...committedReceipt,
        status: "succeeded",
        completedAt: "2026-07-29T00:01:00.000Z",
        response: { success: true, crystalIds: first.crystalIds },
      });
      const replayed = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        crystalIds: string[];
        crystalRecoveryEvidence: typeof first.crystalRecoveryEvidence;
      };

      expect(first.success).toBe(true);
      expect(replayed.success).toBe(true);
      expect(replayed.crystalIds).toEqual(first.crystalIds);
      expect(first.crystalRecoveryEvidence).toEqual({
        schema: "crystal-recovery/v1",
        phase: "committed",
        receiptKey: expect.stringMatching(/^xop_[0-9a-f]{32}$/),
        receiptVersion: 1,
        resultRef: `crystal:${first.crystalIds[0]}`,
        effectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        identity: {
          runId: payload.runId,
          unitId: payload.unitId,
          inputHash: payload.inputHash,
        },
        group: {
          groupId: payload.groupId,
          actionIds: payload.actionIds,
          actionUpdatedAts: payload.actionUpdatedAts,
        },
      });
      expect(replayed.crystalRecoveryEvidence).toEqual(first.crystalRecoveryEvidence);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(await kv.list<Crystal>("mem:crystals")).toHaveLength(1);
      const audits = await kv.list<AuditEntry>(KV.audit);
      const crystalAudits = audits.filter((audit) => audit.operation === "crystallize");
      expect(crystalAudits).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^aud_/),
          timestamp: "2026-07-29T00:00:00.000Z",
          functionId: "mem::crystallize",
          targetIds: first.crystalIds,
        }),
      ]);
      await kv.set(KV.audit, crystalAudits[0].id, {
        ...crystalAudits[0],
        details: { ...crystalAudits[0].details, actionIds: ["foreign-action"] },
      });
      const conflictingAudit = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        failure: { class: string; cause: string };
      };
      expect(conflictingAudit).toMatchObject({
        success: false,
        failure: {
          class: "hard",
          cause: "crystal_audit_conflict",
        },
      });
      await kv.delete(KV.audit, crystalAudits[0].id);
      const missingAudit = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        failure: { class: string; cause: string };
      };
      expect(missingAudit).toMatchObject({
        success: false,
        failure: {
          class: "hard",
          cause: "crystal_committed_audit_missing",
        },
      });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("resumes a frozen crystal after a lesson commit failure", async () => {
      const action = makeAction({
        id: "act_full_resume",
        status: "done",
        project: "resume",
      });
      await kv.set("mem:actions", action.id, action);
      let failLessonCommit = true;
      const lessonSave = sdk.getFunction("mem::lesson-save")!;
      sdk.registerFunction("mem::lesson-save", async (data: unknown) => {
        if (failLessonCommit) {
          failLessonCommit = false;
          return { success: false, error: "lesson unavailable" };
        }
        return lessonSave(data);
      });
      const payload = {
        groupId: "crystal-group:resume",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: "resume",
        runId: "run-crystal-resume",
        unitId: "crystal-group:resume",
        inputHash: "b".repeat(64),
      };
      await seedRunningCrystalReceipt(kv, payload);

      const failed = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
      };
      expect(failed.success).toBe(false);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(await kv.list<Crystal>("mem:crystals")).toHaveLength(1);
      expect((await kv.get<Action>("mem:actions", action.id))?.crystallizedInto).toBeUndefined();

      const resumed = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        crystalIds: string[];
      };
      expect(resumed.success).toBe(true);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect((await kv.get<Action>("mem:actions", action.id))?.crystallizedInto)
        .toBe(resumed.crystalIds[0]);
    });

    it("persists the frozen recovery plan before effects and resumes without a second provider call", async () => {
      const action = makeAction({
        id: "act_full_stage_loss",
        status: "done",
        project: "stage-loss",
      });
      await kv.set(KV.actions, action.id, action);
      const payload = {
        groupId: "crystal-group:stage-loss",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: "stage-loss",
        runId: "run-crystal-stage-loss",
        unitId: "crystal-group:stage-loss",
        inputHash: "c".repeat(64),
      };
      const receiptKey = await seedRunningCrystalReceipt(kv, payload);
      const originalSet = kv.set;
      let loseStagedResponse = true;
      kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
        const persisted = await originalSet(scope, key, data);
        const recovery = (data as { crystalRecovery?: { phase?: string } }).crystalRecovery;
        if (loseStagedResponse && key === receiptKey && recovery?.phase === "staged") {
          loseStagedResponse = false;
          throw new Error("staged_response_lost");
        }
        return persisted;
      };

      const interrupted = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        retrySameIdentity?: boolean;
      };
      expect(interrupted).toMatchObject({ success: false, retrySameIdentity: true });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(await kv.list<Crystal>(KV.crystals)).toEqual([]);
      await expect(kv.get<Record<string, unknown>>(
        KV.extractionOperationReceipt(receiptKey),
        receiptKey,
      )).resolves.toMatchObject({
        status: "running",
        crystalRecovery: {
          schema: "crystal-recovery/v1",
          phase: "staged",
          identity: {
            runId: payload.runId,
            unitId: payload.unitId,
            inputHash: payload.inputHash,
          },
          group: {
            groupId: payload.groupId,
            actionIds: payload.actionIds,
            actionUpdatedAts: payload.actionUpdatedAts,
          },
          digest: {
            narrative: "test",
            lessons: ["learned"],
          },
          plan: {
            crystal: { sourceActionIds: payload.actionIds },
            lessons: [{
              sourceMutationId: expect.stringMatching(/^crystal:.*:lesson:0$/),
            }],
            actions: [{
              actionId: action.id,
              expectedUpdatedAt: action.updatedAt,
            }],
            effectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        },
      });

      const resumed = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
      };
      expect(resumed.success).toBe(true);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("serializes crystal effect commits across different recovery identities", async () => {
      provider.summarize = vi.fn().mockResolvedValue(
        '{"narrative":"shared","keyOutcomes":["done"],"filesAffected":[],"lessons":[]}',
      );
      const action = makeAction({
        id: "act_full_concurrent",
        status: "done",
        project: "concurrent",
      });
      await kv.set(KV.actions, action.id, action);
      const payloads = [
        {
          groupId: "crystal-group:concurrent-a",
          actionIds: [action.id],
          actionUpdatedAts: [action.updatedAt],
          project: "concurrent",
          runId: "run-crystal-concurrent-a",
          unitId: "crystal-group:concurrent-a",
          inputHash: "a".repeat(64),
        },
        {
          groupId: "crystal-group:concurrent-b",
          actionIds: [action.id],
          actionUpdatedAts: [action.updatedAt],
          project: "concurrent",
          runId: "run-crystal-concurrent-b",
          unitId: "crystal-group:concurrent-b",
          inputHash: "b".repeat(64),
        },
      ];
      const receiptKeys = await Promise.all(
        payloads.map((payload) => seedRunningCrystalReceipt(kv, payload)),
      );
      const originalSet = kv.set;
      kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
        const persisted = await originalSet(scope, key, data);
        const recovery = (data as { crystalRecovery?: { phase?: string } }).crystalRecovery;
        if (recovery?.phase === "staged") {
          throw new Error("staged response lost");
        }
        return persisted;
      };
      for (const payload of payloads) {
        const staged = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
          success: boolean;
          retrySameIdentity?: boolean;
        };
        expect(staged).toMatchObject({ success: false, retrySameIdentity: true });
      }

      let activeCrystalWrites = 0;
      let maxConcurrentCrystalWrites = 0;
      kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope !== KV.crystals) return originalSet(scope, key, data);
        activeCrystalWrites += 1;
        maxConcurrentCrystalWrites = Math.max(
          maxConcurrentCrystalWrites,
          activeCrystalWrites,
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return await originalSet(scope, key, data);
        } finally {
          activeCrystalWrites -= 1;
        }
      };
      const results = await Promise.all(payloads.map((payload) =>
        sdk.trigger("mem::full-crystals-auto", payload) as Promise<{
          success: boolean;
          failure?: { class: string; cause: string };
        }>));

      expect(maxConcurrentCrystalWrites).toBe(1);
      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(results.filter(
        (result) => result.failure?.cause === "crystal_formal_effect_conflict",
      )).toHaveLength(1);
      const audits = (await kv.list<AuditEntry>(KV.audit))
        .filter((audit) => audit.operation === "crystallize");
      expect(audits).toHaveLength(1);
      const receipts = await Promise.all(receiptKeys.map((key) =>
        kv.get<{ crystalRecovery?: { phase?: string } }>(
          KV.extractionOperationReceipt(key),
          key,
        )));
      expect(receipts.filter(
        (receipt) => receipt?.crystalRecovery?.phase === "committed",
      )).toHaveLength(1);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
    });

    it("resumes a projectless frozen plan after JSON persistence drops undefined fields", async () => {
      kv = mockKV(true);
      sdk = mockSdk();
      registerLessonsFunctions(sdk as never, kv as never);
      registerCrystallizeFunction(sdk as never, kv as never, provider);
      const action = makeAction({
        id: "act_full_json_round_trip",
        status: "done",
        project: undefined,
      });
      await kv.set(KV.actions, action.id, action);
      const payload = {
        groupId: "crystal-group:json-round-trip",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        runId: "run-crystal-json-round-trip",
        unitId: "crystal-group:json-round-trip",
        inputHash: "d".repeat(64),
      };
      const receiptKey = await seedRunningCrystalReceipt(kv, payload);
      const originalSet = kv.set;
      let loseStagedResponse = true;
      kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
        const persisted = await originalSet(scope, key, data);
        const recovery = (data as { crystalRecovery?: { phase?: string } }).crystalRecovery;
        if (loseStagedResponse && key === receiptKey && recovery?.phase === "staged") {
          loseStagedResponse = false;
          throw new Error("staged_response_lost");
        }
        return persisted;
      };

      const interrupted = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        retrySameIdentity?: boolean;
      };
      expect(interrupted).toMatchObject({ success: false, retrySameIdentity: true });

      const resumed = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        crystalIds: string[];
      };
      expect(resumed.success).toBe(true);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      const crystal = await kv.get<Crystal>(KV.crystals, resumed.crystalIds[0]);
      expect(crystal).not.toHaveProperty("sessionId");
      expect(crystal).not.toHaveProperty("project");
    });

    it("re-verifies a committed plan and fills missing crystal, lesson, and action effects", async () => {
      const action = makeAction({
        id: "act_full_committed_gap",
        status: "done",
        project: "committed-gap",
      });
      await kv.set(KV.actions, action.id, action);
      const payload = {
        groupId: "crystal-group:committed-gap",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: "committed-gap",
        runId: "run-crystal-committed-gap",
        unitId: "crystal-group:committed-gap",
        inputHash: "d".repeat(64),
      };
      await seedRunningCrystalReceipt(kv, payload);
      const first = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        crystalIds: string[];
      };
      const [lesson] = await kv.list<Lesson>(KV.lessons);
      expect(first.success).toBe(true);
      await kv.delete(KV.crystals, first.crystalIds[0]);
      await kv.delete(KV.lessons, lesson.id);
      await kv.set(KV.actions, action.id, action);

      const repaired = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        crystalIds: string[];
      };
      expect(repaired.success).toBe(true);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(await kv.get<Crystal>(KV.crystals, first.crystalIds[0])).not.toBeNull();
      expect((await kv.get<Lesson>(KV.lessons, lesson.id))
        ?.sourceWatermarks?.[`crystal:${first.crystalIds[0]}:lesson:0`]?.mutationId)
        .toBe(`crystal:${first.crystalIds[0]}:lesson:0`);
      expect((await kv.get<Action>(KV.actions, action.id))?.crystallizedInto)
        .toBe(first.crystalIds[0]);
    });

    it("fails closed when a committed crystal conflicts with the frozen plan", async () => {
      const action = makeAction({
        id: "act_full_committed_conflict",
        status: "done",
        project: "committed-conflict",
      });
      await kv.set(KV.actions, action.id, action);
      const payload = {
        groupId: "crystal-group:committed-conflict",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: "committed-conflict",
        runId: "run-crystal-committed-conflict",
        unitId: "crystal-group:committed-conflict",
        inputHash: "e".repeat(64),
      };
      await seedRunningCrystalReceipt(kv, payload);
      const first = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        crystalIds: string[];
      };
      const crystal = await kv.get<Crystal>(KV.crystals, first.crystalIds[0]);
      await kv.set(KV.crystals, crystal!.id, { ...crystal!, narrative: "foreign edit" });

      const conflicted = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
        failure: { class: string; cause: string };
      };
      expect(conflicted).toMatchObject({
        success: false,
        failure: { class: "hard", cause: "crystal_formal_effect_conflict" },
      });
      expect((await kv.get<Crystal>(KV.crystals, crystal!.id))?.narrative)
        .toBe("foreign edit");
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("does not revive a derived lesson soft-deleted after the committed mutation", async () => {
      const action = makeAction({
        id: "act_full_soft_deleted_lesson",
        status: "done",
        project: "soft-deleted",
      });
      await kv.set(KV.actions, action.id, action);
      const payload = {
        groupId: "crystal-group:soft-deleted",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        project: "soft-deleted",
        runId: "run-crystal-soft-deleted",
        unitId: "crystal-group:soft-deleted",
        inputHash: "f".repeat(64),
      };
      await seedRunningCrystalReceipt(kv, payload);
      const first = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        crystalIds: string[];
      };
      const [lesson] = await kv.list<Lesson>(KV.lessons);
      await kv.set(KV.lessons, lesson.id, { ...lesson, deleted: true });
      await kv.set(KV.actions, action.id, action);

      const replayed = (await sdk.trigger("mem::full-crystals-auto", payload)) as {
        success: boolean;
      };
      expect(replayed.success).toBe(true);
      expect((await kv.get<Lesson>(KV.lessons, lesson.id))?.deleted).toBe(true);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("filters by project when specified", async () => {
      const a1 = makeAction({ id: "act_fp1", status: "done", project: "keep" });
      const a2 = makeAction({ id: "act_fp2", status: "done", project: "skip" });
      await kv.set("mem:actions", a1.id, a1);
      await kv.set("mem:actions", a2.id, a2);

      const result = (await sdk.trigger("mem::auto-crystallize", {
        project: "keep",
        dryRun: true,
      })) as {
        success: boolean;
        groupCount: number;
        groups: { groupKey: string; actionCount: number }[];
      };

      expect(result.success).toBe(true);
      expect(result.groupCount).toBe(1);
      expect(result.groups[0].groupKey).toBe("keep");
    });

    it("returns empty when no qualifying actions exist", async () => {
      const result = (await sdk.trigger("mem::auto-crystallize", {})) as {
        success: boolean;
        groupCount: number;
        crystalIds: string[];
      };

      expect(result.success).toBe(true);
      expect(result.groupCount).toBe(0);
      expect(result.crystalIds).toEqual([]);
    });
  });
});
