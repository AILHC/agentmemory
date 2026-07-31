import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type {
  Action,
  ActionEdge,
  Crystal,
  ExtractionOperationReceipt,
  Lesson,
  MemoryProvider,
  StageFailure,
} from "../types.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import { resolveStageModelCallOptions } from "../config.js";
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";
import {
  AUDIT_ENTRY_CONFLICT,
  AUDIT_ENTRY_MISSING,
  recordAudit,
} from "./audit.js";
import {
  lessonIdForContent,
  normalizeLessonIdentityContent,
} from "./lesson-commit.js";
import { stableHash } from "./lesson-extraction-runs.js";

interface CrystalDigest {
  narrative: string;
  keyOutcomes: string[];
  filesAffected: string[];
  lessons: string[];
}

const CRYSTAL_RECOVERY_COMMIT_LOCK = "recovery-effect-commit:crystal";

interface CrystalOperationIdentity {
  runId: string;
  unitId: string;
  inputHash: string;
  groupId: string;
}

interface CrystalRecoveryEvidence {
  schema: "crystal-recovery/v1";
  phase: "committed";
  receiptKey: string;
  receiptVersion: number;
  resultRef: string;
  effectHash: string;
  identity: Omit<CrystalOperationIdentity, "groupId">;
  group: {
    groupId: string;
    actionIds: string[];
    actionUpdatedAts: string[];
  };
}

interface CrystalRecoveryLessonPlan {
  lessonId: string;
  content: string;
  context: string;
  confidence: number;
  project?: string;
  sourceMutationId: string;
  baseline: {
    kind: "absent" | "active" | "deleted";
    stateHash?: string;
  };
  predecessorMutationId?: string;
}

interface CrystalRecoveryState {
  schema: "crystal-recovery/v1";
  phase: "staged" | "committed";
  identity: Omit<CrystalOperationIdentity, "groupId">;
  group: {
    groupId: string;
    actionIds: string[];
    actionUpdatedAts: string[];
  };
  digest: CrystalDigest;
  plan: {
    crystal: {
      id: string;
      sourceActionIds: string[];
      sessionId?: string;
      project?: string;
      createdAt: string;
    };
    lessons: CrystalRecoveryLessonPlan[];
    actions: Array<{
      actionId: string;
      expectedUpdatedAt: string;
      crystalId: string;
    }>;
    effectHash: string;
  };
  result?: {
    crystalIds: string[];
    lessonIds: string[];
    actionIds: string[];
    auditId: string;
  };
}

type CrystalRecoveryReceipt = ExtractionOperationReceipt<Record<string, unknown>> & {
  crystalRecovery?: CrystalRecoveryState;
};

type CrystalRecoveryFailureCode =
  | "crystal_recovery_receipt_unavailable"
  | "crystal_recovery_identity_conflict"
  | "crystal_recovery_plan_conflict"
  | "crystal_formal_effect_conflict"
  | "crystal_audit_conflict"
  | "crystal_committed_audit_missing";

class CrystalRecoveryFailure extends Error {
  constructor(readonly code: CrystalRecoveryFailureCode) {
    super(code);
    this.name = "CrystalRecoveryFailure";
  }
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

function crystalOperationKey(identity: CrystalOperationIdentity): string {
  return JSON.stringify([
    "crystal-operation/v1",
    identity.runId,
    identity.unitId,
    identity.inputHash,
    identity.groupId,
  ]);
}

function crystalIdForOperation(operationKey: string): string {
  return fingerprintId("crys", operationKey);
}

function recoveryIdentity(
  identity: CrystalOperationIdentity,
): CrystalRecoveryState["identity"] {
  return {
    runId: identity.runId,
    unitId: identity.unitId,
    inputHash: identity.inputHash,
  };
}

function recoveryReceiptKey(identity: CrystalRecoveryState["identity"]): string {
  return buildExtractionOperationKey({
    runId: identity.runId,
    stage: "crystal",
    unitId: identity.unitId,
  });
}

function crystalRecoveryEvidence(
  receipt: CrystalRecoveryReceipt,
  recovery: CrystalRecoveryState,
): CrystalRecoveryEvidence {
  return {
    schema: "crystal-recovery/v1",
    phase: "committed",
    receiptKey: receipt.key,
    receiptVersion: receipt.version ?? 1,
    resultRef: `crystal:${recovery.plan.crystal.id}`,
    effectHash: recovery.plan.effectHash,
    identity: recovery.identity,
    group: recovery.group,
  };
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function crystalRecoveryEffectMaterial(recovery: CrystalRecoveryState): Record<string, unknown> {
  return {
    identity: recovery.identity,
    group: recovery.group,
    digest: recovery.digest,
    crystal: recovery.plan.crystal,
    lessons: recovery.plan.lessons,
    actions: recovery.plan.actions,
  };
}

function crystalAuditId(recovery: CrystalRecoveryState): string {
  return fingerprintId("aud", JSON.stringify([
    recoveryReceiptKey(recovery.identity),
    recovery.plan.effectHash,
  ]));
}

function expectedCrystalRecoveryResult(
  recovery: CrystalRecoveryState,
): NonNullable<CrystalRecoveryState["result"]> {
  return {
    crystalIds: [recovery.plan.crystal.id],
    lessonIds: recovery.plan.lessons.map((item) => item.lessonId),
    actionIds: recovery.plan.actions.map((item) => item.actionId),
    auditId: crystalAuditId(recovery),
  };
}

function plannedCrystal(recovery: CrystalRecoveryState): Crystal {
  return {
    id: recovery.plan.crystal.id,
    narrative: recovery.digest.narrative,
    keyOutcomes: recovery.digest.keyOutcomes,
    filesAffected: recovery.digest.filesAffected,
    lessons: recovery.digest.lessons,
    sourceActionIds: recovery.plan.crystal.sourceActionIds,
    ...(recovery.plan.crystal.sessionId === undefined
      ? {}
      : { sessionId: recovery.plan.crystal.sessionId }),
    ...(recovery.plan.crystal.project === undefined
      ? {}
      : { project: recovery.plan.crystal.project }),
    createdAt: recovery.plan.crystal.createdAt,
  };
}

function assertCrystalRecoveryPlan(
  receipt: CrystalRecoveryReceipt,
  recovery: CrystalRecoveryState,
  identity: CrystalOperationIdentity,
  group: EligibleCrystalActionGroup,
): void {
  if (
    !recovery
    || typeof recovery !== "object"
    || !recovery.identity
    || !recovery.group
    || !recovery.digest
    || !recovery.plan
    || !recovery.plan.crystal
    || !Array.isArray(recovery.plan.lessons)
    || !Array.isArray(recovery.plan.actions)
  ) {
    throw new CrystalRecoveryFailure("crystal_recovery_plan_conflict");
  }
  const expectedIdentity = recoveryIdentity(identity);
  const expectedCrystalId = crystalIdForOperation(crystalOperationKey(identity));
  const expectedActions = group.actionIds.map((actionId, index) => ({
    actionId,
    expectedUpdatedAt: group.actionUpdatedAts[index],
    crystalId: expectedCrystalId,
  }));
  const validDigest = typeof recovery.digest?.narrative === "string"
    && [recovery.digest.keyOutcomes, recovery.digest.filesAffected, recovery.digest.lessons]
      .every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
  const validLessons = recovery.plan?.lessons?.length === recovery.digest?.lessons?.length
    && recovery.plan.lessons.every((item, index) => {
      const expectedMutationId = `crystal:${expectedCrystalId}:lesson:${index}`;
      const predecessor = recovery.plan.lessons
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.lessonId === item.lessonId);
      return item.content === recovery.digest.lessons[index]
        && item.context === recovery.digest.narrative
        && item.confidence === 0.6
        && item.project === recovery.plan.crystal.project
        && item.sourceMutationId === expectedMutationId
        && item.baseline
        && ["absent", "active", "deleted"].includes(item.baseline.kind)
        && (
          item.baseline.kind === "absent"
            ? item.baseline.stateHash === undefined
            : typeof item.baseline.stateHash === "string" && /^[0-9a-f]{64}$/.test(item.baseline.stateHash)
        )
        && item.predecessorMutationId === predecessor?.sourceMutationId;
    });
  const expectedResult = expectedCrystalRecoveryResult(recovery);
  const validReceiptStatus = receipt.status === "running"
    || (receipt.status === "succeeded" && recovery.phase === "committed");
  if (
    recovery.schema !== "crystal-recovery/v1"
    || !["staged", "committed"].includes(recovery.phase)
    || receipt.key !== recoveryReceiptKey(expectedIdentity)
    || receipt.stage !== "crystal"
    || receipt.runId !== expectedIdentity.runId
    || receipt.unitId !== expectedIdentity.unitId
    || receipt.inputHash !== expectedIdentity.inputHash
    || !validReceiptStatus
    || stableHash(recovery.identity) !== stableHash(expectedIdentity)
    || recovery.group.groupId !== identity.groupId
    || recovery.group.groupId !== identity.unitId
    || !sameOrderedStrings(recovery.group.actionIds, group.actionIds)
    || !sameOrderedStrings(recovery.group.actionUpdatedAts, group.actionUpdatedAts)
    || !validDigest
    || recovery.plan.crystal.id !== expectedCrystalId
    || !sameOrderedStrings(recovery.plan.crystal.sourceActionIds, group.actionIds)
    || recovery.plan.crystal.project !== group.project
    || !validLessons
    || stableHash(recovery.plan.actions) !== stableHash(expectedActions)
    || recovery.plan.effectHash !== stableHash(crystalRecoveryEffectMaterial(recovery))
    || (recovery.phase === "staged" && recovery.result !== undefined)
    || (
      recovery.phase === "committed"
      && stableHash(recovery.result) !== stableHash(expectedResult)
    )
  ) {
    throw new CrystalRecoveryFailure("crystal_recovery_plan_conflict");
  }
}

async function requireCrystalRecoveryReceipt(
  kv: StateKV,
  identity: CrystalOperationIdentity,
): Promise<CrystalRecoveryReceipt> {
  const expectedIdentity = recoveryIdentity(identity);
  const key = recoveryReceiptKey(expectedIdentity);
  const receipt = await kv.get<CrystalRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  if (!receipt) {
    throw new CrystalRecoveryFailure("crystal_recovery_receipt_unavailable");
  }
  if (
    receipt.key !== key
    || receipt.stage !== "crystal"
    || receipt.runId !== expectedIdentity.runId
    || receipt.unitId !== expectedIdentity.unitId
    || receipt.inputHash !== expectedIdentity.inputHash
    || (
      receipt.status !== "running"
      && !(receipt.status === "succeeded" && receipt.crystalRecovery?.phase === "committed")
    )
  ) {
    throw new CrystalRecoveryFailure("crystal_recovery_identity_conflict");
  }
  return receipt;
}

async function readCrystalRecovery(options: {
  kv: StateKV;
  identity: CrystalOperationIdentity;
  group: EligibleCrystalActionGroup;
}): Promise<{ receipt: CrystalRecoveryReceipt; recovery: CrystalRecoveryState } | null> {
  const receipt = await requireCrystalRecoveryReceipt(options.kv, options.identity);
  if (!receipt.crystalRecovery) return null;
  assertCrystalRecoveryPlan(receipt, receipt.crystalRecovery, options.identity, options.group);
  return { receipt, recovery: receipt.crystalRecovery };
}

async function resolveCrystalLessonPlan(options: {
  kv: StateKV;
  digest: CrystalDigest;
  crystalId: string;
  project?: string;
}): Promise<CrystalRecoveryLessonPlan[]> {
  const previousByLessonId = new Map<string, string>();
  const plans: CrystalRecoveryLessonPlan[] = [];
  for (let index = 0; index < options.digest.lessons.length; index += 1) {
    const content = options.digest.lessons[index];
    const normalizedContent = normalizeLessonIdentityContent(content);
    const canonicalId = lessonIdForContent(normalizedContent);
    const legacyId = fingerprintId("lsn", normalizedContent);
    const [canonical, legacy] = await Promise.all([
      options.kv.get<Lesson>(KV.lessons, canonicalId),
      options.kv.get<Lesson>(KV.lessons, legacyId),
    ]);
    if (canonical && legacy) {
      throw new CrystalRecoveryFailure("crystal_recovery_plan_conflict");
    }
    const existing = canonical ?? legacy;
    const lessonId = existing?.id ?? canonicalId;
    const predecessorMutationId = previousByLessonId.get(lessonId);
    const sourceMutationId = `crystal:${options.crystalId}:lesson:${index}`;
    plans.push({
      lessonId,
      content,
      context: options.digest.narrative,
      confidence: 0.6,
      ...(options.project === undefined ? {} : { project: options.project }),
      sourceMutationId,
      baseline: existing
        ? {
            kind: existing.deleted ? "deleted" : "active",
            stateHash: stableHash(existing),
          }
        : { kind: "absent" },
      ...(predecessorMutationId ? { predecessorMutationId } : {}),
    });
    previousByLessonId.set(lessonId, sourceMutationId);
  }
  return plans;
}

async function stageCrystalRecovery(options: {
  kv: StateKV;
  identity: CrystalOperationIdentity;
  group: EligibleCrystalActionGroup;
  digest: CrystalDigest;
  sessionId?: string;
}): Promise<{ receipt: CrystalRecoveryReceipt; recovery: CrystalRecoveryState }> {
  const recovered = await readCrystalRecovery(options);
  if (recovered) return recovered;
  if (options.identity.groupId !== options.identity.unitId) {
    throw new CrystalRecoveryFailure("crystal_recovery_identity_conflict");
  }
  const receipt = await requireCrystalRecoveryReceipt(options.kv, options.identity);
  const crystalId = crystalIdForOperation(crystalOperationKey(options.identity));
  const lessonPlans = await resolveCrystalLessonPlan({
    kv: options.kv,
    digest: options.digest,
    crystalId,
    project: options.group.project,
  });
  const recovery: CrystalRecoveryState = {
    schema: "crystal-recovery/v1",
    phase: "staged",
    identity: recoveryIdentity(options.identity),
    group: {
      groupId: options.group.groupId,
      actionIds: [...options.group.actionIds],
      actionUpdatedAts: [...options.group.actionUpdatedAts],
    },
    digest: {
      narrative: options.digest.narrative,
      keyOutcomes: [...options.digest.keyOutcomes],
      filesAffected: [...options.digest.filesAffected],
      lessons: [...options.digest.lessons],
    },
    plan: {
      crystal: {
        id: crystalId,
        sourceActionIds: [...options.group.actionIds],
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.group.project === undefined ? {} : { project: options.group.project }),
        createdAt: new Date().toISOString(),
      },
      lessons: lessonPlans,
      actions: options.group.actionIds.map((actionId, index) => ({
        actionId,
        expectedUpdatedAt: options.group.actionUpdatedAts[index],
        crystalId,
      })),
      effectHash: "",
    },
  };
  recovery.plan.effectHash = stableHash(crystalRecoveryEffectMaterial(recovery));
  assertCrystalRecoveryPlan(receipt, recovery, options.identity, options.group);
  const staged = { ...receipt, crystalRecovery: recovery };
  await options.kv.set(KV.extractionOperationReceipt(receipt.key), receipt.key, staged);
  return { receipt: staged, recovery };
}

async function applyCrystalLessonPlan(
  sdk: ISdk,
  kv: StateKV,
  crystalId: string,
  item: CrystalRecoveryLessonPlan,
): Promise<void> {
  const current = await kv.get<Lesson>(KV.lessons, item.lessonId);
  const watermark = current?.sourceWatermarks?.[item.sourceMutationId];
  if (watermark?.mutationId === item.sourceMutationId) return;
  if (watermark !== undefined) {
    throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  }
  if (item.predecessorMutationId) {
    if (
      !current
      || current.deleted
      || current.sourceWatermarks?.[item.predecessorMutationId]?.mutationId
        !== item.predecessorMutationId
    ) {
      throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
    }
  } else if (item.baseline.kind === "absent") {
    if (current) throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  } else if (
    !current
    || stableHash(current) !== item.baseline.stateHash
    || (item.baseline.kind === "active" && current.deleted)
    || (item.baseline.kind === "deleted" && !current.deleted)
  ) {
    throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  }
  const result = (await sdk.trigger({
    function_id: "mem::lesson-save",
    payload: {
      content: item.content,
      context: item.context,
      confidence: item.confidence,
      project: item.project,
      tags: [],
      source: "crystal",
      sourceIds: [crystalId],
      sourceMutationId: item.sourceMutationId,
      sourceMutationPrecondition: {
        lessonId: item.lessonId,
        baselineKind: item.baseline.kind,
        baselineStateHash: item.baseline.stateHash,
        predecessorMutationId: item.predecessorMutationId,
      },
    },
  })) as { success?: boolean; lesson?: Lesson };
  if (result?.success !== true || result.lesson?.id !== item.lessonId) {
    throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  }
  const persisted = await kv.get<Lesson>(KV.lessons, item.lessonId);
  if (
    persisted?.sourceWatermarks?.[item.sourceMutationId]?.mutationId
      !== item.sourceMutationId
  ) {
    throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  }
}

async function recordCrystalRecoveryAudit(options: {
  kv: StateKV;
  receipt: CrystalRecoveryReceipt;
  recovery: CrystalRecoveryState;
  result: NonNullable<CrystalRecoveryState["result"]>;
  requireExisting: boolean;
}): Promise<void> {
  try {
    await recordAudit(
      options.kv,
      "crystallize",
      "mem::crystallize",
      options.result.crystalIds,
      {
        runId: options.recovery.identity.runId,
        unitId: options.recovery.identity.unitId,
        inputHash: options.recovery.identity.inputHash,
        lessonIds: options.result.lessonIds,
        actionIds: options.result.actionIds,
      },
      undefined,
      undefined,
      {
        id: options.result.auditId,
        timestamp: options.receipt.startedAt,
        requireExisting: options.requireExisting,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === AUDIT_ENTRY_CONFLICT) {
      throw new CrystalRecoveryFailure("crystal_audit_conflict");
    }
    if (message === AUDIT_ENTRY_MISSING) {
      throw new CrystalRecoveryFailure("crystal_committed_audit_missing");
    }
    throw error;
  }
}

type CrystalRecoveryCommitOptions = {
  sdk: ISdk;
  kv: StateKV;
  receipt: CrystalRecoveryReceipt;
  recovery: CrystalRecoveryState;
  identity: CrystalOperationIdentity;
  group: EligibleCrystalActionGroup;
};

type CrystalRecoveryCommitResult = {
  receipt: CrystalRecoveryReceipt;
  recovery: CrystalRecoveryState;
  crystal: Crystal;
};

async function commitCrystalRecovery(
  options: CrystalRecoveryCommitOptions,
): Promise<CrystalRecoveryCommitResult> {
  return withKeyedLock(
    CRYSTAL_RECOVERY_COMMIT_LOCK,
    () => commitCrystalRecoveryLocked(options),
  );
}

async function commitCrystalRecoveryLocked(
  options: CrystalRecoveryCommitOptions,
): Promise<CrystalRecoveryCommitResult> {
  assertCrystalRecoveryPlan(options.receipt, options.recovery, options.identity, options.group);
  const result = expectedCrystalRecoveryResult(options.recovery);
  const verifyingCommitted = options.recovery.phase === "committed";
  if (verifyingCommitted) {
    await recordCrystalRecoveryAudit({
      kv: options.kv,
      receipt: options.receipt,
      recovery: options.recovery,
      result,
      requireExisting: true,
    });
  }
  const crystal = plannedCrystal(options.recovery);
  const existingCrystal = await options.kv.get<Crystal>(KV.crystals, crystal.id);
  if (existingCrystal && stableHash(existingCrystal) !== stableHash(crystal)) {
    throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  }
  if (!existingCrystal) await options.kv.set(KV.crystals, crystal.id, crystal);

  for (const item of options.recovery.plan.lessons) {
    await applyCrystalLessonPlan(options.sdk, options.kv, crystal.id, item);
  }

  for (const item of options.recovery.plan.actions) {
    const current = await options.kv.get<Action>(KV.actions, item.actionId);
    if (
      !current
      || current.updatedAt !== item.expectedUpdatedAt
      || (
        current.crystallizedInto !== undefined
        && current.crystallizedInto !== item.crystalId
      )
    ) {
      throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
    }
    if (current.crystallizedInto !== item.crystalId) {
      await options.kv.set(KV.actions, current.id, {
        ...current,
        crystallizedInto: item.crystalId,
      });
    }
  }

  const verifiedCrystal = await options.kv.get<Crystal>(KV.crystals, crystal.id);
  if (!verifiedCrystal || stableHash(verifiedCrystal) !== stableHash(crystal)) {
    throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
  }
  for (const item of options.recovery.plan.lessons) {
    const lesson = await options.kv.get<Lesson>(KV.lessons, item.lessonId);
    if (
      lesson?.sourceWatermarks?.[item.sourceMutationId]?.mutationId
        !== item.sourceMutationId
    ) {
      throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
    }
  }
  for (const item of options.recovery.plan.actions) {
    const action = await options.kv.get<Action>(KV.actions, item.actionId);
    if (
      !action
      || action.updatedAt !== item.expectedUpdatedAt
      || action.crystallizedInto !== item.crystalId
    ) {
      throw new CrystalRecoveryFailure("crystal_formal_effect_conflict");
    }
  }

  if (!verifyingCommitted) {
    await recordCrystalRecoveryAudit({
      kv: options.kv,
      receipt: options.receipt,
      recovery: options.recovery,
      result,
      requireExisting: false,
    });
  }
  const committed: CrystalRecoveryState = {
    ...options.recovery,
    phase: "committed",
    result,
  };
  const receipt = { ...options.receipt, crystalRecovery: committed };
  await options.kv.set(KV.extractionOperationReceipt(receipt.key), receipt.key, receipt);
  return { receipt, recovery: committed, crystal };
}

async function runRecoverableCrystallize(options: {
  sdk: ISdk;
  kv: StateKV;
  provider: MemoryProvider;
  identity: CrystalOperationIdentity;
  group: EligibleCrystalActionGroup;
  actions: Action[];
  relevantEdges: ActionEdge[];
  sessionId?: string;
  model?: string;
}): Promise<Record<string, unknown>> {
  const recovered = await readCrystalRecovery(options);
  let staged = recovered;
  if (!staged) {
    const callOptions = resolveStageModelCallOptions("crystal", options.model);
    const prompt = buildChainText(options.actions, options.relevantEdges);
    const response = callOptions
      ? await options.provider.summarize(
          withOutputLanguagePolicy(CRYSTALLIZE_SYSTEM),
          prompt,
          callOptions,
        )
      : await options.provider.summarize(
          withOutputLanguagePolicy(CRYSTALLIZE_SYSTEM),
          prompt,
        );
    staged = await stageCrystalRecovery({
      kv: options.kv,
      identity: options.identity,
      group: options.group,
      digest: parseDigest(response),
      sessionId: options.sessionId,
    });
  }
  const committed = await commitCrystalRecovery({
    sdk: options.sdk,
    kv: options.kv,
    receipt: staged.receipt,
    recovery: staged.recovery,
    identity: options.identity,
    group: options.group,
  });
  return {
    success: true,
    crystal: committed.crystal,
    effectState: "committed",
    crystalRecoveryEvidence: crystalRecoveryEvidence(
      committed.receipt,
      committed.recovery,
    ),
  };
}

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
    model?: string;
    groupId?: string;
    actionIds?: string[];
    actionUpdatedAts?: string[];
    runId?: string;
    unitId?: string;
    inputHash?: string;
  },
  failedGroupsMakeRunFail: boolean,
): Promise<Record<string, unknown>> {
  const dryRun = data.dryRun ?? false;
  const operationIdentityFields = [data.runId, data.unitId, data.inputHash];
  const hasOperationIdentity = operationIdentityFields.some((value) => value !== undefined);
  if (
    hasOperationIdentity
    && operationIdentityFields.some((value) => typeof value !== "string" || !value)
  ) {
    return {
      success: false,
      status: "failed",
      failure: { class: "hard", cause: "crystal_operation_identity_invalid" },
    };
  }
  const hasPinnedGroup = data.groupId !== undefined
    || data.actionIds !== undefined
    || data.actionUpdatedAts !== undefined;
  let groups: EligibleCrystalActionGroup[];
  if (hasPinnedGroup) {
    if (
      !data.groupId
      || !Array.isArray(data.actionIds)
      || data.actionIds.length === 0
      || !Array.isArray(data.actionUpdatedAts)
      || data.actionUpdatedAts.length !== data.actionIds.length
      || new Set(data.actionIds).size !== data.actionIds.length
      || (hasOperationIdentity && data.groupId !== data.unitId)
    ) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "crystal_plan_identity_invalid" },
      };
    }
    const actions = await Promise.all(
      data.actionIds.map((id) => kv.get<Action>(KV.actions, id)),
    );
    const expectedCrystalId = hasOperationIdentity
      ? crystalIdForOperation(crystalOperationKey({
          runId: data.runId!,
          unitId: data.unitId!,
          inputHash: data.inputHash!,
          groupId: data.groupId,
        }))
      : null;
    const drifted = actions.some((action, index) =>
      !action
      || action.status !== "done"
      || Boolean(
        action.crystallizedInto
        && action.crystallizedInto !== expectedCrystalId,
      )
      || action.updatedAt !== data.actionUpdatedAts![index]);
    if (drifted) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "crystal_plan_drifted" },
      };
    }
    groups = [{
      groupId: data.groupId,
      groupKey: data.groupId,
      actionIds: data.actionIds,
      actionUpdatedAts: data.actionUpdatedAts,
      actionCount: data.actionIds.length,
      project: data.project ?? actions[0]?.project,
    }];
  } else {
    groups = await buildEligibleCrystalActionGroups({
      kv,
      olderThanDays: data.olderThanDays,
      project: data.project,
    });
  }

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
    retrySameIdentity?: boolean;
    failure?: StageFailure;
    crystalRecoveryEvidence?: CrystalRecoveryEvidence;
  }> = [];
  for (const group of groups) {
    const actionIds = group.actionIds;

    try {
      const result = (await sdk.trigger({ function_id: "mem::crystallize", payload: {
        actionIds,
        project: group.project,
        ...(hasOperationIdentity
          ? {
              operationKey: crystalOperationKey({
                runId: data.runId!,
                unitId: data.unitId!,
                inputHash: data.inputHash!,
                groupId: group.groupId,
              }),
              recoveryIdentity: {
                runId: data.runId!,
                unitId: data.unitId!,
                inputHash: data.inputHash!,
              },
              recoveryGroup: {
                groupId: group.groupId,
                actionIds: group.actionIds,
                actionUpdatedAts: group.actionUpdatedAts,
              },
            }
          : {}),
        ...(data.model ? { model: data.model } : {}),
      } })) as {
        success: boolean;
        crystal?: Crystal;
        error?: string;
        effectState?: string;
        retrySameIdentity?: boolean;
        failure?: StageFailure;
        crystalRecoveryEvidence?: CrystalRecoveryEvidence;
      };

      if (result.success && result.crystal) {
        crystalIds.push(result.crystal.id);
        groupResults.push({
          ...group,
          status: "succeeded",
          crystalIds: [result.crystal.id],
          ...(result.crystalRecoveryEvidence
            ? { crystalRecoveryEvidence: result.crystalRecoveryEvidence }
            : {}),
        });
      } else {
        groupResults.push({
          ...group,
          status: "failed",
          crystalIds: [],
          error: result.error ?? "crystallize returned no crystal",
          ...(result.retrySameIdentity ? { retrySameIdentity: true } : {}),
          ...(result.failure ? { failure: result.failure } : {}),
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
  const singleFailure = groupResults.length === 1 ? groupResults[0]?.failure : undefined;
  return {
    success: failedGroupsMakeRunFail ? !hasFailedGroups : true,
    groupCount: groups.length,
    groups: groupResults,
    crystalIds,
    ...(groupResults.length === 1 && groupResults[0]?.crystalRecoveryEvidence
      ? { crystalRecoveryEvidence: groupResults[0].crystalRecoveryEvidence }
      : {}),
    ...(groupResults.some((group) => group.retrySameIdentity)
      ? { retrySameIdentity: true }
      : {}),
    ...(singleFailure ? { failure: singleFailure } : {}),
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
      model?: string;
      operationKey?: string;
      recoveryIdentity?: {
        runId: string;
        unitId: string;
        inputHash: string;
      };
      recoveryGroup?: {
        groupId: string;
        actionIds: string[];
        actionUpdatedAts: string[];
      };
    }) => {
      if (!data.actionIds || data.actionIds.length === 0) {
        return { success: false, error: "actionIds is required" };
      }

      const actions: Action[] = [];
      const deterministicCrystalId = data.operationKey
        ? crystalIdForOperation(data.operationKey)
        : null;
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
        if (
          action.crystallizedInto
          && action.crystallizedInto !== deterministicCrystalId
        ) {
          return {
            success: false,
            error: `action ${id} is already crystallized into ${action.crystallizedInto}`,
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
      const callOptions = resolveStageModelCallOptions("crystal", data.model);

      try {
        const hasRecoveryInput = data.recoveryIdentity !== undefined
          || data.recoveryGroup !== undefined;
        if (hasRecoveryInput) {
          const identityFields = data.recoveryIdentity;
          const recoveryGroup = data.recoveryGroup;
          if (
            !identityFields
            || !recoveryGroup
            || !identityFields.runId
            || !identityFields.unitId
            || !identityFields.inputHash
            || !recoveryGroup.groupId
            || recoveryGroup.groupId !== identityFields.unitId
            || !Array.isArray(recoveryGroup.actionIds)
            || !Array.isArray(recoveryGroup.actionUpdatedAts)
            || !sameOrderedStrings(recoveryGroup.actionIds, data.actionIds)
            || recoveryGroup.actionUpdatedAts.length !== data.actionIds.length
          ) {
            return {
              success: false,
              failure: {
                class: "hard",
                cause: "crystal_recovery_identity_conflict",
              },
            };
          }
          const identity: CrystalOperationIdentity = {
            ...identityFields,
            groupId: recoveryGroup.groupId,
          };
          if (data.operationKey !== crystalOperationKey(identity)) {
            return {
              success: false,
              failure: {
                class: "hard",
                cause: "crystal_recovery_identity_conflict",
              },
            };
          }
          return await runRecoverableCrystallize({
            sdk,
            kv,
            provider,
            identity,
            group: {
              groupId: recoveryGroup.groupId,
              groupKey: recoveryGroup.groupId,
              actionIds: recoveryGroup.actionIds,
              actionUpdatedAts: recoveryGroup.actionUpdatedAts,
              actionCount: recoveryGroup.actionIds.length,
              project: data.project,
            },
            actions,
            relevantEdges,
            sessionId: data.sessionId,
            model: data.model,
          });
        }
        let crystal = deterministicCrystalId
          ? await kv.get<Crystal>(KV.crystals, deterministicCrystalId)
          : null;
        if (crystal) {
          if (
            !sameOrderedStrings(crystal.sourceActionIds, data.actionIds)
            || crystal.project !== data.project
            || crystal.sessionId !== data.sessionId
          ) {
            return {
              success: false,
              error: "crystal operation identity conflict",
            };
          }
        } else {
          const response = callOptions
            ? await provider.summarize(
                withOutputLanguagePolicy(CRYSTALLIZE_SYSTEM),
                prompt,
                callOptions,
              )
            : await provider.summarize(
                withOutputLanguagePolicy(CRYSTALLIZE_SYSTEM),
                prompt,
              );
          const digest = parseDigest(response);
          crystal = {
            id: deterministicCrystalId ?? generateId("crys"),
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
        }

        for (let index = 0; index < crystal.lessons.length; index += 1) {
          const lessonResult = (await sdk.trigger({
            function_id: "mem::lesson-save",
            payload: {
              content: crystal.lessons[index],
              context: crystal.narrative,
              confidence: 0.6,
              project: data.project,
              tags: [],
              source: "crystal",
              sourceIds: [crystal.id],
              sourceMutationId: `crystal:${crystal.id}:lesson:${index}`,
            },
          })) as { success?: boolean; error?: string };
          if (lessonResult?.success !== true) {
            throw new Error(lessonResult?.error || "crystal lesson commit failed");
          }
        }

        for (const action of actions) {
          const current = await kv.get<Action>(KV.actions, action.id);
          if (!current) throw new Error(`action disappeared during crystal commit: ${action.id}`);
          if (
            current.crystallizedInto
            && current.crystallizedInto !== crystal.id
          ) {
            throw new Error(`action crystal conflict: ${action.id}`);
          }
          if (current.crystallizedInto !== crystal.id) {
            await kv.set(KV.actions, action.id, {
              ...current,
              crystallizedInto: crystal.id,
            });
          }
        }

        return {
          success: true,
          crystal,
          effectState: "committed",
        };
      } catch (err) {
        if (err instanceof CrystalRecoveryFailure) {
          return {
            success: false,
            error: err.code,
            failure: { class: "hard", cause: err.code },
          };
        }
        return {
          success: false,
          error: `crystallization failed: ${String(err)}`,
          ...(data.operationKey ? { retrySameIdentity: true } : {}),
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
    async (data: {
      olderThanDays?: number;
      project?: string;
      dryRun?: boolean;
      model?: string;
      groupId?: string;
      actionIds?: string[];
      actionUpdatedAts?: string[];
      runId?: string;
      unitId?: string;
      inputHash?: string;
    }) =>
      runAutoCrystallize(sdk, kv, data, false),
  );

  sdk.registerFunction(
    "mem::full-crystals-auto",
    async (data: {
      olderThanDays?: number;
      project?: string;
      dryRun?: boolean;
      model?: string;
      groupId?: string;
      actionIds?: string[];
      actionUpdatedAts?: string[];
      runId?: string;
      unitId?: string;
      inputHash?: string;
    }) =>
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
