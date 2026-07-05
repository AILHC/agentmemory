import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type { Action, ActionEdge, Crystal, MemoryProvider } from "../types.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";

interface CrystalDigest {
  narrative: string;
  keyOutcomes: string[];
  filesAffected: string[];
  lessons: string[];
}

export interface EligibleCrystalActionGroup {
  groupId: string;
  groupKey: string;
  actionIds: string[];
  actionUpdatedAts: string[];
  actionCount: number;
  project?: string;
}

export interface BuildEligibleCrystalActionGroupsOptions {
  kv: StateKV;
  olderThanDays?: number;
  project?: string;
}

const CRYSTALLIZE_SYSTEM = `You are summarizing a completed chain of agent actions into a compact digest.
Extract: (1) what was accomplished in 1-2 sentences, (2) key decisions as bullet points,
(3) files affected, (4) any lessons or patterns worth remembering.
Return as JSON: { "narrative": "...", "keyOutcomes": ["..."], "filesAffected": ["..."], "lessons": ["..."] }`;

export async function buildEligibleCrystalActionGroups(
  options: BuildEligibleCrystalActionGroupsOptions,
): Promise<EligibleCrystalActionGroup[]> {
  const olderThanDays = options.olderThanDays ?? 7;
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  let allActions = await options.kv.list<Action>(KV.actions);
  allActions = allActions.filter(
    (a) =>
      a.status === "done" &&
      !a.crystallizedInto &&
      new Date(a.updatedAt).getTime() < cutoff,
  );

  if (options.project) {
    allActions = allActions.filter((a) => a.project === options.project);
  }

  const groups = new Map<string, Action[]>();
  for (const action of allActions) {
    const key = action.parentId ?? action.project ?? "_ungrouped";
    const group = groups.get(key);
    if (group) {
      group.push(action);
    } else {
      groups.set(key, [action]);
    }
  }

  return Array.from(groups.entries()).map(([key, actions], index) => ({
    groupId: `crystal-group:${index + 1}:${key}`,
    groupKey: key,
    actionIds: actions.map((a) => a.id),
    actionUpdatedAts: actions.map((a) => a.updatedAt),
    actionCount: actions.length,
    project: actions[0]?.project,
  }));
}

async function runAutoCrystallize(
  sdk: ISdk,
  kv: StateKV,
  data: {
    olderThanDays?: number;
    project?: string;
    dryRun?: boolean;
  },
  failedGroupsMakeRunFail: boolean,
): Promise<Record<string, unknown>> {
  const dryRun = data.dryRun ?? false;
  const groups = await buildEligibleCrystalActionGroups({
    kv,
    olderThanDays: data.olderThanDays,
    project: data.project,
  });

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      groupCount: groups.length,
      groups: groups.map((group) => ({ ...group, status: "planned" })),
      crystalIds: [],
    };
  }

  const crystalIds: string[] = [];
  const groupResults: Array<EligibleCrystalActionGroup & {
    status: "succeeded" | "failed";
    crystalIds: string[];
    error?: string;
  }> = [];
  for (const group of groups) {
    const actionIds = group.actionIds;

    try {
      const result = (await sdk.trigger({ function_id: "mem::crystallize", payload: {
        actionIds,
        project: group.project,
      } })) as { success: boolean; crystal?: Crystal; error?: string };

      if (result.success && result.crystal) {
        crystalIds.push(result.crystal.id);
        groupResults.push({
          ...group,
          status: "succeeded",
          crystalIds: [result.crystal.id],
        });
      } else {
        groupResults.push({
          ...group,
          status: "failed",
          crystalIds: [],
          error: result.error ?? "crystallize returned no crystal",
        });
      }
    } catch (err) {
      groupResults.push({
        ...group,
        status: "failed",
        crystalIds: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const hasFailedGroups = groupResults.some((group) => group.status === "failed");
  return {
    success: failedGroupsMakeRunFail ? !hasFailedGroups : true,
    groupCount: groups.length,
    groups: groupResults,
    crystalIds,
  };
}

export function registerCrystallizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::crystallize", 
    async (data: {
      actionIds: string[];
      sessionId?: string;
      project?: string;
    }) => {
      if (!data.actionIds || data.actionIds.length === 0) {
        return { success: false, error: "actionIds is required" };
      }

      const actions: Action[] = [];
      for (const id of data.actionIds) {
        const action = await kv.get<Action>(KV.actions, id);
        if (!action) {
          return { success: false, error: `action not found: ${id}` };
        }
        if (action.status !== "done" && action.status !== "cancelled") {
          return {
            success: false,
            error: `action ${id} has status "${action.status}", expected "done" or "cancelled"`,
          };
        }
        actions.push(action);
      }

      const allEdges = await kv.list<ActionEdge>(KV.actionEdges);
      const idSet = new Set(data.actionIds);
      const relevantEdges = allEdges.filter(
        (e) => idSet.has(e.sourceActionId) || idSet.has(e.targetActionId),
      );

      const prompt = buildChainText(actions, relevantEdges);

      try {
        const response = await provider.summarize(
          withOutputLanguagePolicy(CRYSTALLIZE_SYSTEM),
          prompt,
        );
        const digest = parseDigest(response);

        const crystal: Crystal = {
          id: generateId("crys"),
          narrative: digest.narrative,
          keyOutcomes: digest.keyOutcomes,
          filesAffected: digest.filesAffected,
          lessons: digest.lessons,
          sourceActionIds: data.actionIds,
          sessionId: data.sessionId,
          project: data.project,
          createdAt: new Date().toISOString(),
        };

        await kv.set(KV.crystals, crystal.id, crystal);

        await Promise.all(
          digest.lessons.map((lesson) =>
            sdk
              .trigger({
                function_id: "mem::lesson-save",
                payload: {
                  content: lesson,
                  context: crystal.narrative,
                  confidence: 0.6,
                  project: data.project,
                  tags: [],
                  source: "crystal",
                  sourceIds: [crystal.id],
                },
              })
              .catch(() => {}),
          ),
        );

        for (const action of actions) {
          const updated = { ...action, crystallizedInto: crystal.id };
          await kv.set(KV.actions, action.id, updated);
        }

        return { success: true, crystal };
      } catch (err) {
        return {
          success: false,
          error: `crystallization failed: ${String(err)}`,
        };
      }
    },
  );

  sdk.registerFunction("mem::crystal-list", 
    async (data: {
      project?: string;
      sessionId?: string;
      limit?: number;
    }) => {
      const limit = data.limit ?? 20;
      let crystals = await kv.list<Crystal>(KV.crystals);

      if (data.project) {
        crystals = crystals.filter((c) => c.project === data.project);
      }
      if (data.sessionId) {
        crystals = crystals.filter((c) => c.sessionId === data.sessionId);
      }

      crystals.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return { success: true, crystals: crystals.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::crystal-get", 
    async (data: { crystalId: string }) => {
      if (!data.crystalId) {
        return { success: false, error: "crystalId is required" };
      }

      const crystal = await kv.get<Crystal>(KV.crystals, data.crystalId);
      if (!crystal) {
        return { success: false, error: "crystal not found" };
      }

      return { success: true, crystal };
    },
  );

  sdk.registerFunction(
    "mem::auto-crystallize",
    async (data: { olderThanDays?: number; project?: string; dryRun?: boolean }) =>
      runAutoCrystallize(sdk, kv, data, false),
  );

  sdk.registerFunction(
    "mem::full-crystals-auto",
    async (data: { olderThanDays?: number; project?: string; dryRun?: boolean }) =>
      runAutoCrystallize(sdk, kv, data, true),
  );
}

function buildChainText(actions: Action[], edges: ActionEdge[]): string {
  const lines: string[] = ["## Completed Action Chain\n"];

  const sorted = [...actions].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  for (const action of sorted) {
    lines.push(`### ${action.title}`);
    if (action.description) lines.push(action.description);
    if (action.result) lines.push(`Result: ${action.result}`);
    lines.push(
      `Tags: ${(action.tags ?? []).join(", ")}`,
    );
    lines.push("");
  }

  if (edges.length > 0) {
    lines.push("## Dependencies");
    for (const edge of edges) {
      lines.push(
        `- ${edge.sourceActionId} --${edge.type}--> ${edge.targetActionId}`,
      );
    }
  }

  return lines.join("\n");
}

function parseDigest(response: string): CrystalDigest {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        narrative: response,
        keyOutcomes: [],
        filesAffected: [],
        lessons: [],
      };
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      narrative:
        typeof parsed.narrative === "string" ? parsed.narrative : response,
      keyOutcomes: Array.isArray(parsed.keyOutcomes)
        ? (parsed.keyOutcomes as string[])
        : [],
      filesAffected: Array.isArray(parsed.filesAffected)
        ? (parsed.filesAffected as string[])
        : [],
      lessons: Array.isArray(parsed.lessons)
        ? (parsed.lessons as string[])
        : [],
    };
  } catch {
    return {
      narrative: response,
      keyOutcomes: [],
      filesAffected: [],
      lessons: [],
    };
  }
}
