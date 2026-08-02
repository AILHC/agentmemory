import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type {
  Action,
  ActionEdge,
  AuditEntry,
  ContributionEffectRef,
  ContributionRecord,
  Crystal,
  ExtractionOperationIdentity,
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
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  inspectContributionCandidates,
  releaseClaimedBatch,
} from "./extraction-contributions.js";

interface CrystalDigest {
  narrative: string;
  keyOutcomes: string[];
  filesAffected: string[];
  lessons: string[];
}

const CRYSTAL_RECOVERY_COMMIT_LOCK = "recovery-effect-commit:crystal";
export const CRYSTAL_CONTRIBUTION_CONTRACT = "crystal/v1";

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
  | "crystal_committed_audit_missing"
  | "crystal_plan_drifted"
  | "crystal_response_parse_failure";

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
  stageContractVersion: typeof CRYSTAL_CONTRIBUTION_CONTRACT;
  sourceVersionKeys: string[];
  actionCount: number;
  project?: string;
  isolateReason?: string;
  blockReason?: string;
}

export interface BuildEligibleCrystalActionGroupsOptions {
  kv: StateKV;
  olderThanDays?: number;
  project?: string;
}

export const CRYSTALLIZE_SYSTEM = `You are summarizing a completed chain of agent actions into a compact digest.
Extract: (1) what was accomplished in 1-2 sentences, (2) key decisions as bullet points,
(3) files affected, (4) any lessons or patterns worth remembering.
Return as JSON: { "narrative": "...", "keyOutcomes": ["..."], "filesAffected": ["..."], "lessons": ["..."] }`;

export function buildCrystalActionSourceSnapshot(action: Action): Record<string, unknown> {
  return {
    schema: CRYSTAL_CONTRIBUTION_CONTRACT,
    action: {
      id: action.id,
      title: action.title,
      description: action.description,
      status: action.status,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      result: action.result ?? null,
      tags: action.tags,
      project: action.project ?? null,
      parentId: action.parentId ?? null,
    },
  };
}

export function buildCrystalActionSourceVersion(action: Action): {
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  sourceVersionKey: string;
} {
  const snapshot = buildCrystalActionSourceSnapshot(action);
  const snapshotHash = stableHash(snapshot);
  return {
    snapshot,
    snapshotHash,
    sourceVersionKey: buildSourceVersionKey("crystal", "action", action.id, snapshotHash),
  };
}

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

function crystalContributionFailure(cause: string): Record<string, unknown> {
  return {
    success: false,
    status: "failed",
    failure: { class: "hard", cause },
  };
}

function crystalReceiptRef(receipt: CrystalRecoveryReceipt): ContributionEffectRef {
  return {
    scope: KV.extractionOperationReceipt(receipt.key),
    key: receipt.key,
  };
}

function sameEffectRefs(
  left: ContributionEffectRef[] | undefined,
  right: ContributionEffectRef[],
): boolean {
  return stableHash(left ?? []) === stableHash(right);
}

async function readCrystalContributionEffectRefs(
  kv: StateKV,
  receipt: CrystalRecoveryReceipt,
  recovery: CrystalRecoveryState,
): Promise<ContributionEffectRef[] | null> {
  const result = expectedCrystalRecoveryResult(recovery);
  const crystal = await kv.get<Crystal>(KV.crystals, recovery.plan.crystal.id);
  if (!crystal || stableHash(crystal) !== stableHash(plannedCrystal(recovery))) return null;

  const lessonRefs: ContributionEffectRef[] = [];
  for (const item of recovery.plan.lessons) {
    const lesson = await kv.get<Lesson>(KV.lessons, item.lessonId);
    const watermark = lesson?.sourceWatermarks?.[item.sourceMutationId];
    if (
      !lesson
      || watermark?.mutationId !== item.sourceMutationId
      || !lesson.sourceIds.includes(crystal.id)
    ) return null;
    lessonRefs.push({
      scope: KV.lessons,
      key: lesson.id,
      effectHash: stableHash({
        lessonId: lesson.id,
        crystalId: crystal.id,
        sourceMutationId: item.sourceMutationId,
        watermark,
      }),
    });
  }

  const actionRefs: ContributionEffectRef[] = [];
  for (const item of recovery.plan.actions) {
    const action = await kv.get<Action>(KV.actions, item.actionId);
    if (
      !action
      || action.updatedAt !== item.expectedUpdatedAt
      || action.crystallizedInto !== item.crystalId
    ) return null;
    actionRefs.push({
      scope: KV.actions,
      key: action.id,
      effectHash: stableHash({
        actionId: action.id,
        updatedAt: action.updatedAt,
        crystallizedInto: action.crystallizedInto,
      }),
    });
  }

  const audit = await kv.get<AuditEntry>(KV.audit, result.auditId);
  const details = audit?.details as Record<string, unknown> | undefined;
  if (
    !audit
    || audit.timestamp !== receipt.startedAt
    || audit.operation !== "crystallize"
    || audit.functionId !== "mem::crystallize"
    || stableHash(audit.targetIds) !== stableHash(result.crystalIds)
    || details?.runId !== recovery.identity.runId
    || details?.unitId !== recovery.identity.unitId
    || details?.inputHash !== recovery.identity.inputHash
    || stableHash(details?.lessonIds) !== stableHash(result.lessonIds)
    || stableHash(details?.actionIds) !== stableHash(result.actionIds)
  ) return null;

  return [
    { scope: KV.crystals, key: crystal.id, effectHash: stableHash(crystal) },
    ...lessonRefs,
    ...actionRefs,
    {
      scope: KV.audit,
      key: audit.id,
      effectHash: stableHash({
        id: audit.id,
        timestamp: audit.timestamp,
        operation: audit.operation,
        functionId: audit.functionId,
        targetIds: audit.targetIds,
        details: {
          runId: details.runId,
          unitId: details.unitId,
          inputHash: details.inputHash,
          lessonIds: details.lessonIds,
          actionIds: details.actionIds,
        },
      }),
    },
  ];
}

async function readVerifiedCrystalReceiptAndEffects(options: {
  kv: StateKV;
  operationReceiptRef: ContributionEffectRef;
  group: EligibleCrystalActionGroup;
}): Promise<{
  receipt: CrystalRecoveryReceipt;
  recovery: CrystalRecoveryState;
  effectRefs: ContributionEffectRef[];
} | null> {
  const receipt = await options.kv.get<CrystalRecoveryReceipt>(
    options.operationReceiptRef.scope,
    options.operationReceiptRef.key,
  );
  const recovery = receipt?.crystalRecovery;
  if (!receipt || !recovery) return null;
  const identity: CrystalOperationIdentity = {
    ...recovery.identity,
    groupId: recovery.group.groupId,
  };
  if (
    options.operationReceiptRef.scope !== KV.extractionOperationReceipt(receipt.key)
    || options.operationReceiptRef.key !== receipt.key
    || receipt.version !== 1
    || receipt.status !== "succeeded"
  ) return null;
  try {
    assertCrystalRecoveryPlan(receipt, recovery, identity, options.group);
  } catch {
    return null;
  }
  const result = expectedCrystalRecoveryResult(recovery);
  const response = receipt.response as Record<string, unknown> | undefined;
  const groups = Array.isArray(response?.groups) ? response.groups : [];
  const firstGroup = groups[0] as Record<string, unknown> | undefined;
  if (
    response?.success !== true
    || response.groupCount !== 1
    || stableHash(response.crystalIds) !== stableHash(result.crystalIds)
    || groups.length !== 1
    || firstGroup?.groupId !== recovery.group.groupId
    || firstGroup.status !== "succeeded"
    || stableHash(firstGroup.actionIds) !== stableHash(recovery.group.actionIds)
    || stableHash(firstGroup.actionUpdatedAts) !== stableHash(recovery.group.actionUpdatedAts)
    || stableHash(firstGroup.crystalIds) !== stableHash(result.crystalIds)
    || stableHash(response.crystalRecoveryEvidence)
      !== stableHash(crystalRecoveryEvidence(receipt, recovery))
  ) return null;
  const effectRefs = await readCrystalContributionEffectRefs(options.kv, receipt, recovery);
  return effectRefs ? { receipt, recovery, effectRefs } : null;
}

async function verifyTerminalCrystalContribution(options: {
  kv: StateKV;
  group: EligibleCrystalActionGroup;
  records: ContributionRecord[];
}): Promise<Record<string, unknown>> {
  const expectedSourceKeys = [...options.group.sourceVersionKeys].sort();
  const records = [...options.records].sort((left, right) =>
    left.sourceVersionKey.localeCompare(right.sourceVersionKey, "en"));
  const first = records[0];
  if (
    !first
    || records.length !== expectedSourceKeys.length
    || records.some((record, index) =>
      record.stage !== "crystal"
      || record.stageContractVersion !== CRYSTAL_CONTRIBUTION_CONTRACT
      || record.sourceVersionKey !== expectedSourceKeys[index]
      || record.state !== "committed"
      || record.contributionId !== first.contributionId
      || record.runId !== first.runId
      || record.unitId !== first.unitId
      || record.operationReceiptRef?.scope !== first.operationReceiptRef?.scope
      || record.operationReceiptRef?.key !== first.operationReceiptRef?.key
      || !sameEffectRefs(record.effectRefs, first.effectRefs ?? []))
  ) return crystalContributionFailure("crystal_terminal_reconciliation_required");
  if (!first.operationReceiptRef) {
    return crystalContributionFailure("crystal_terminal_reconciliation_required");
  }
  const verified = await readVerifiedCrystalReceiptAndEffects({
    kv: options.kv,
    operationReceiptRef: first.operationReceiptRef,
    group: options.group,
  });
  if (!verified || !sameEffectRefs(first.effectRefs, verified.effectRefs)) {
    return crystalContributionFailure("crystal_terminal_reconciliation_required");
  }
  return verified.receipt.response ?? crystalContributionFailure(
    "crystal_terminal_reconciliation_required",
  );
}

export async function reconcileCrystalContributionFromReceipt(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  group: {
    groupId: string;
    actionIds: string[];
    actionUpdatedAts: string[];
    project?: string;
    sourceVersionKeys?: string[];
  };
  operationReceiptRef: ContributionEffectRef;
}): Promise<Record<string, unknown>> {
  try {
    const actions = await Promise.all(
      options.group.actionIds.map((actionId) => options.kv.get<Action>(KV.actions, actionId)),
    );
    if (
      options.identity.stage !== "crystal"
      || options.group.groupId !== options.identity.unitId
      || actions.some((action, index) =>
        !action
        || action.status !== "done"
        || action.updatedAt !== options.group.actionUpdatedAts[index])
    ) return crystalContributionFailure("crystal_contribution_reconciliation_required");
    const sourceVersionKeys = actions.map((action) =>
      buildCrystalActionSourceVersion(action!).sourceVersionKey);
    if (
      options.group.sourceVersionKeys
      && stableHash(options.group.sourceVersionKeys) !== stableHash(sourceVersionKeys)
    ) return crystalContributionFailure("crystal_contribution_reconciliation_required");
    const group: EligibleCrystalActionGroup = {
      groupId: options.group.groupId,
      groupKey: options.group.groupId,
      actionIds: [...options.group.actionIds],
      actionUpdatedAts: [...options.group.actionUpdatedAts],
      stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
      sourceVersionKeys,
      actionCount: options.group.actionIds.length,
      ...(options.group.project === undefined ? {} : { project: options.group.project }),
    };
    const scope = KV.extractionContributionRecords(
      "crystal",
      CRYSTAL_CONTRIBUTION_CONTRACT,
    );
    const records = await Promise.all(
      [...sourceVersionKeys].sort().map((sourceVersionKey) =>
        options.kv.get<ContributionRecord>(scope, sourceVersionKey)),
    );
    if (records.some((record) => !record)) {
      return crystalContributionFailure("crystal_contribution_reconciliation_required");
    }
    const claimed = records as ContributionRecord[];
    const first = claimed[0];
    if (
      !first
      || claimed.some((record) =>
        record.contributionId !== first.contributionId
        || record.runId !== options.identity.runId
        || record.unitId !== options.identity.unitId
        || (record.state !== "claimed" && record.state !== "committed"))
    ) return crystalContributionFailure("crystal_contribution_reconciliation_required");
    if (claimed.every((record) => record.state === "committed")) {
      return verifyTerminalCrystalContribution({ kv: options.kv, group, records: claimed });
    }
    const verified = await readVerifiedCrystalReceiptAndEffects({
      kv: options.kv,
      operationReceiptRef: options.operationReceiptRef,
      group,
    });
    if (!verified) {
      return crystalContributionFailure("crystal_contribution_reconciliation_required");
    }
    await commitClaimedBatch(options.kv, {
      stage: "crystal",
      stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
      contributionId: first.contributionId,
      sourceVersionKeys,
      operationReceiptRef: options.operationReceiptRef,
      effectRefs: verified.effectRefs,
    });
    const committed = await Promise.all(
      [...sourceVersionKeys].sort().map((sourceVersionKey) =>
        options.kv.get<ContributionRecord>(scope, sourceVersionKey)),
    );
    return verifyTerminalCrystalContribution({
      kv: options.kv,
      group,
      records: committed.filter((record): record is ContributionRecord => Boolean(record)),
    });
  } catch {
    return crystalContributionFailure("crystal_contribution_reconciliation_required");
  }
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
  const currentActions = await Promise.all(
    options.recovery.plan.actions.map((item) =>
      options.kv.get<Action>(KV.actions, item.actionId)),
  );
  if (currentActions.some((current, index) => {
    const item = options.recovery.plan.actions[index];
    return !current
      || current.status !== "done"
      || current.updatedAt !== item.expectedUpdatedAt
      || (
        current.crystallizedInto !== undefined
        && current.crystallizedInto !== item.crystalId
      );
  })) {
    throw new CrystalRecoveryFailure(
      options.recovery.phase === "staged"
        ? "crystal_plan_drifted"
        : "crystal_formal_effect_conflict",
    );
  }
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
    const digest = parseDigestStrict(response);
    if (!digest) throw new CrystalRecoveryFailure("crystal_response_parse_failure");
    const currentActions = await Promise.all(
      options.group.actionIds.map((actionId) => options.kv.get<Action>(KV.actions, actionId)),
    );
    if (
      currentActions.some((action, index) =>
        !action
        || action.status !== "done"
        || action.updatedAt !== options.group.actionUpdatedAts[index])
      || stableHash(currentActions.map((action) => action
        ? buildCrystalActionSourceVersion(action).sourceVersionKey
        : null)) !== stableHash(options.group.sourceVersionKeys)
    ) {
      throw new CrystalRecoveryFailure("crystal_plan_drifted");
    }
    staged = await stageCrystalRecovery({
      kv: options.kv,
      identity: options.identity,
      group: options.group,
      digest,
      sessionId: options.sessionId,
    });
  }
  let committed: CrystalRecoveryCommitResult;
  try {
    committed = await commitCrystalRecovery({
      sdk: options.sdk,
      kv: options.kv,
      receipt: staged.receipt,
      recovery: staged.recovery,
      identity: options.identity,
      group: options.group,
    });
  } catch (error) {
    if (
      error instanceof CrystalRecoveryFailure
      && error.code === "crystal_plan_drifted"
      && staged.recovery.phase === "staged"
    ) {
      const current = await options.kv.get<CrystalRecoveryReceipt>(
        KV.extractionOperationReceipt(staged.receipt.key),
        staged.receipt.key,
      );
      if (
        current?.crystalRecovery?.phase === "staged"
        && stableHash(current.crystalRecovery) === stableHash(staged.recovery)
      ) {
        const { crystalRecovery: _discarded, ...receiptWithoutRecovery } = current;
        await options.kv.set(
          KV.extractionOperationReceipt(current.key),
          current.key,
          receiptWithoutRecovery,
        );
      }
    }
    throw error;
  }
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
  allActions = allActions.filter((a) =>
    a.status === "done" && new Date(a.updatedAt).getTime() < cutoff);

  if (options.project) {
    allActions = allActions.filter((a) => a.project === options.project);
  }

  const sourceVersions = allActions.map((action) => buildCrystalActionSourceVersion(action));
  const candidates = await inspectContributionCandidates(options.kv, {
    stage: "crystal",
    stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
    sourceVersionKeys: sourceVersions.map((source) => source.sourceVersionKey),
  });
  const candidatesByKey = new Map(candidates.map((candidate) => [
    candidate.sourceVersionKey,
    candidate,
  ]));
  const groups = new Map<string, Action[]>();
  const exceptional: EligibleCrystalActionGroup[] = [];
  for (let index = 0; index < allActions.length; index += 1) {
    const action = allActions[index];
    const source = sourceVersions[index];
    const candidate = candidatesByKey.get(source.sourceVersionKey);
    if (!candidate) continue;
    if (candidate.state === "terminal" && action.crystallizedInto) continue;
    if (candidate.state === "eligible" && action.crystallizedInto) continue;
    if (candidate.state !== "eligible") {
      const sourceCorrection = candidate.state === "source_correction_requires_migration";
      exceptional.push({
        groupId: `crystal-${sourceCorrection ? "correction" : "blocked"}:${action.id}`,
        groupKey: action.parentId ?? action.project ?? "_ungrouped",
        actionIds: [action.id],
        actionUpdatedAts: [action.updatedAt],
        stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: [source.sourceVersionKey],
        actionCount: 1,
        ...(action.project === undefined ? {} : { project: action.project }),
        ...(sourceCorrection
          ? { isolateReason: "crystal_source_correction_requires_migration" }
          : { blockReason: candidate.reason ?? "crystal_contribution_reconciliation_required" }),
      });
      continue;
    }
    const key = action.parentId ?? action.project ?? "_ungrouped";
    const group = groups.get(key);
    if (group) {
      group.push(action);
    } else {
      groups.set(key, [action]);
    }
  }

  const eligible = Array.from(groups.entries())
    .map(([key, unsortedActions], index) => {
      const actions = [...unsortedActions].sort((left, right) =>
        left.id.localeCompare(right.id, "en"));
      return {
    groupId: `crystal-group:${index + 1}:${key}`,
    groupKey: key,
    actionIds: actions.map((a) => a.id),
    actionUpdatedAts: actions.map((a) => a.updatedAt),
    stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
    sourceVersionKeys: actions.map((action) =>
      buildCrystalActionSourceVersion(action).sourceVersionKey),
    actionCount: actions.length,
    project: actions[0]?.project,
      };
    });
  return [...eligible, ...exceptional.sort((left, right) =>
    left.groupId.localeCompare(right.groupId, "en"))];
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
    stageContractVersion?: string;
    sourceVersionKeys?: string[];
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
    || data.actionUpdatedAts !== undefined
    || data.stageContractVersion !== undefined
    || data.sourceVersionKeys !== undefined;
  let groups: EligibleCrystalActionGroup[];
  if (hasPinnedGroup) {
    if (
      !data.groupId
      || !Array.isArray(data.actionIds)
      || data.actionIds.length === 0
      || !Array.isArray(data.actionUpdatedAts)
      || data.actionUpdatedAts.length !== data.actionIds.length
      || new Set(data.actionIds).size !== data.actionIds.length
      || (data.stageContractVersion !== undefined
        && data.stageContractVersion !== CRYSTAL_CONTRIBUTION_CONTRACT)
      || (data.sourceVersionKeys !== undefined
        && (!Array.isArray(data.sourceVersionKeys)
          || data.sourceVersionKeys.length !== data.actionIds.length
          || new Set(data.sourceVersionKeys).size !== data.sourceVersionKeys.length))
      || ((data.stageContractVersion === undefined) !== (data.sourceVersionKeys === undefined))
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
    const cutoff = Date.now() - (data.olderThanDays ?? 7) * 24 * 60 * 60 * 1000;
    const drifted = actions.some((action, index) =>
      !action
      || action.status !== "done"
      || new Date(action.updatedAt).getTime() >= cutoff
      || action.updatedAt !== data.actionUpdatedAts![index]);
    if (drifted) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "crystal_plan_drifted" },
      };
    }
    const sourceVersionKeys = actions.map((action) =>
      buildCrystalActionSourceVersion(action!).sourceVersionKey);
    if (
      data.sourceVersionKeys
      && stableHash(data.sourceVersionKeys) !== stableHash(sourceVersionKeys)
    ) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "crystal_source_version_conflict" },
      };
    }
    groups = [{
      groupId: data.groupId,
      groupKey: data.groupId,
      actionIds: data.actionIds,
      actionUpdatedAts: data.actionUpdatedAts,
      stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
      sourceVersionKeys,
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
    let claimedContribution: Extract<
      Awaited<ReturnType<typeof claimBatch>>,
      { status: "claimed" }
    > | null = null;

    if (hasOperationIdentity) {
      const claim = await claimBatch(kv, {
        stage: "crystal",
        stageContractVersion: group.stageContractVersion,
        runId: data.runId!,
        unitId: data.unitId!,
        sourceVersionKeys: group.sourceVersionKeys,
      });
      if (claim.status === "already_committed") {
        const verified = await verifyTerminalCrystalContribution({
          kv,
          group,
          records: claim.records,
        });
        const ids = Array.isArray(verified.crystalIds)
          ? verified.crystalIds.filter((id): id is string => typeof id === "string")
          : [];
        if (verified.success === true && ids.length === 1) {
          crystalIds.push(ids[0]);
          groupResults.push({
            ...group,
            status: "succeeded",
            crystalIds: ids,
            ...(verified.crystalRecoveryEvidence
              ? { crystalRecoveryEvidence: verified.crystalRecoveryEvidence as CrystalRecoveryEvidence }
              : {}),
          });
        } else {
          groupResults.push({
            ...group,
            status: "failed",
            crystalIds: [],
            error: "crystal terminal contribution could not be verified",
            failure: (verified.failure as StageFailure | undefined) ?? {
              class: "hard",
              cause: "crystal_terminal_reconciliation_required",
            },
          });
        }
        continue;
      }
      if (claim.status !== "claimed") {
        const cause = claim.status === "contract_migration_required"
          ? "crystal_contribution_contract_migration_required"
          : claim.status === "source_correction_requires_migration"
            ? "crystal_source_correction_requires_migration"
            : claim.status === "claimed_by_other"
              ? "crystal_contribution_claimed_by_other"
              : "crystal_contribution_reconciliation_required";
        groupResults.push({
          ...group,
          status: "failed",
          crystalIds: [],
          error: cause,
          failure: { class: "hard", cause },
        });
        continue;
      }
      claimedContribution = claim;
      const expectedCrystalId = crystalIdForOperation(crystalOperationKey({
        runId: data.runId!,
        unitId: data.unitId!,
        inputHash: data.inputHash!,
        groupId: group.groupId,
      }));
      const currentActions = await Promise.all(
        actionIds.map((actionId) => kv.get<Action>(KV.actions, actionId)),
      );
      if (
        currentActions.some((action, index) =>
          !action
          || action.status !== "done"
          || action.updatedAt !== group.actionUpdatedAts[index])
        || stableHash(currentActions.map((action) => action
          ? buildCrystalActionSourceVersion(action).sourceVersionKey
          : null)) !== stableHash(group.sourceVersionKeys)
      ) {
        await releaseClaimedBatch(kv, {
          stage: "crystal",
          stageContractVersion: group.stageContractVersion,
          contributionId: claim.records[0]!.contributionId,
          sourceVersionKeys: group.sourceVersionKeys,
        });
        groupResults.push({
          ...group,
          status: "failed",
          crystalIds: [],
          error: "crystal_plan_drifted",
          failure: { class: "hard", cause: "crystal_plan_drifted" },
        });
        continue;
      }
      if (currentActions.some((action) =>
        action?.crystallizedInto && action.crystallizedInto !== expectedCrystalId)) {
        await releaseClaimedBatch(kv, {
          stage: "crystal",
          stageContractVersion: group.stageContractVersion,
          contributionId: claim.records[0]!.contributionId,
          sourceVersionKeys: group.sourceVersionKeys,
        });
        groupResults.push({
          ...group,
          status: "failed",
          crystalIds: [],
          error: "crystal_contribution_reconciliation_required",
          failure: { class: "hard", cause: "crystal_contribution_reconciliation_required" },
        });
        continue;
      }
    }

    const releaseClaimIfNoRecovery = async (): Promise<void> => {
      if (!claimedContribution) return;
      const key = buildExtractionOperationKey({
        runId: data.runId!,
        stage: "crystal",
        unitId: data.unitId!,
      });
      const receipt = await kv.get<CrystalRecoveryReceipt>(
        KV.extractionOperationReceipt(key),
        key,
      );
      if (receipt?.crystalRecovery) return;
      await releaseClaimedBatch(kv, {
        stage: "crystal",
        stageContractVersion: group.stageContractVersion,
        contributionId: claimedContribution.records[0]!.contributionId,
        sourceVersionKeys: group.sourceVersionKeys,
      });
    };

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
                sourceVersionKeys: group.sourceVersionKeys,
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
        await releaseClaimIfNoRecovery();
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
      await releaseClaimIfNoRecovery().catch(() => undefined);
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
        sourceVersionKeys: string[];
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
            || !Array.isArray(recoveryGroup.sourceVersionKeys)
            || !sameOrderedStrings(recoveryGroup.actionIds, data.actionIds)
            || recoveryGroup.actionUpdatedAts.length !== data.actionIds.length
            || recoveryGroup.sourceVersionKeys.length !== data.actionIds.length
            || actions.some((action, index) =>
              action.status !== "done"
              || action.updatedAt !== recoveryGroup.actionUpdatedAts[index])
            || !sameOrderedStrings(
              recoveryGroup.sourceVersionKeys,
              actions.map((action) => buildCrystalActionSourceVersion(action).sourceVersionKey),
            )
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
              stageContractVersion: CRYSTAL_CONTRIBUTION_CONTRACT,
              sourceVersionKeys: recoveryGroup.sourceVersionKeys,
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
            failure: {
              class: err.code === "crystal_response_parse_failure" ? "unit" : "hard",
              cause: err.code,
            },
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
      stageContractVersion?: string;
      sourceVersionKeys?: string[];
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
      stageContractVersion?: string;
      sourceVersionKeys?: string[];
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

export function parseDigestStrict(response: string): CrystalDigest | null {
  const trimmed = response.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || typeof parsed.narrative !== "string"
      || !parsed.narrative.trim()
      || !Array.isArray(parsed.keyOutcomes)
      || !parsed.keyOutcomes.every((item) => typeof item === "string")
      || !Array.isArray(parsed.filesAffected)
      || !parsed.filesAffected.every((item) => typeof item === "string")
      || !Array.isArray(parsed.lessons)
      || !parsed.lessons.every((item) => typeof item === "string")
    ) return null;
    return {
      narrative: parsed.narrative.trim(),
      keyOutcomes: parsed.keyOutcomes,
      filesAffected: parsed.filesAffected,
      lessons: parsed.lessons,
    };
  } catch {
    return null;
  }
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
