import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  AuditEntry,
  CompressedObservation,
  ExtractionOperationIdentity,
  SessionSummary,
  ProceduralMemory,
  Session,
  MemoryProvider,
  SkillExtractionProposal,
  ContributionEffectRef,
  ContributionRecord,
  ExtractionOperationReceipt,
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  buildExtractionOperationKey,
  completeModelOperationFromVerifiedResult,
  projectExtractionOperationReceiptAbsence,
  withExtractionOperationReceipt,
} from "./extraction-operation-receipts.js";
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
  inspectContributionCandidates,
} from "./extraction-contributions.js";
import { partitionAdoptedBaselineSessions } from "./extraction-baselines.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import {
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";

export const SKILL_EXTRACT_SYSTEM = `You are a skill extraction engine. Given a completed multi-step task session, extract a reusable procedural skill document.

Output format:
<skill>
<trigger>When the agent encounters [specific situation/pattern]</trigger>
<title>Short skill title</title>
<steps>
<step>First concrete action</step>
<step>Second concrete action</step>
</steps>
<expected_outcome>What success looks like</expected_outcome>
<tags>comma,separated,tags</tags>
</skill>

Rules:
- Extract ONLY if the session shows a clear multi-step procedure that succeeded
- Steps must be concrete and actionable, not vague
- The trigger should describe WHEN to apply this skill
- If the session is exploratory with no clear procedure, output <no-skill/>
- Maximum 10 steps per skill`;

export const SKILL_EXTRACT_CONTRIBUTION_CONTRACT = "skill_extract/v1";

function buildSkillPrompt(
  summary: SessionSummary,
  observations: CompressedObservation[],
  session: Session,
): string {
  const lineageGuidance =
    session.lineage === "child" || session.lineage === "sidechain"
      ? [
          `Session lineage: ${session.lineage}.`,
          `Parent session id: ${session.parentSessionId ?? "unknown"}.`,
          "Only extract a skill if this session demonstrates a reusable procedure that should apply beyond this delegated subtask.",
          "Do not promote child-local facts, one-off implementation details, or parent-specific decisions into a general skill.",
        ].join("\n")
      : [
          "Session lineage: top-level.",
          "Prefer procedures that are reusable across future sessions and supported by the session summary and observations.",
        ].join("\n");

  const obsText = normalizedSkillObservations(observations)
    .map(
      (o) =>
        `[${o.type}] ${o.title}${o.narrative ? ": " + o.narrative : ""}`,
    )
    .join("\n");

  return `## Lineage Guidance
${lineageGuidance}

## Session Summary
Title: ${summary.title}
Narrative: ${summary.narrative}
Key Decisions: ${summary.keyDecisions.join("; ")}
Files Modified: ${summary.filesModified.join(", ")}
Concepts: ${summary.concepts.join(", ")}

## Observations (${observations.length} total, showing top by importance)
${obsText}`;
}

function normalizedSkillObservations(observations: CompressedObservation[]): Array<{
  id: string; timestamp: string; type: string; title: string; narrative?: string; importance: number;
}> {
  return observations
    .filter((o) => o.importance >= 4)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp, "en") || a.id.localeCompare(b.id, "en"))
    .slice(0, 30)
    .map((o) => ({
      id: o.id,
      timestamp: o.timestamp,
      type: o.type,
      title: o.title,
      narrative: o.narrative,
      importance: o.importance,
    }));
}

export function buildSkillExtractionSourceSnapshot(
  session: Session,
  summary: SessionSummary,
  observations: CompressedObservation[],
): Record<string, unknown> {
  return {
    schema: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
    session: {
      id: session.id,
      status: session.status,
      lineage: session.lineage ?? "top_level",
      parentSessionId: session.parentSessionId ?? null,
    },
    summary: {
      sessionId: summary.sessionId,
      title: summary.title,
      narrative: summary.narrative,
      keyDecisions: summary.keyDecisions,
      filesModified: summary.filesModified,
      concepts: summary.concepts,
    },
    observationTotal: observations.length,
    observations: normalizedSkillObservations(observations),
  };
}

export function buildSkillExtractionSourceVersion(
  session: Session,
  summary: SessionSummary,
  observations: CompressedObservation[],
): { snapshot: Record<string, unknown>; snapshotHash: string; sourceVersionKey: string } {
  const snapshot = buildSkillExtractionSourceSnapshot(session, summary, observations);
  const snapshotHash = stableHash(snapshot);
  return {
    snapshot,
    snapshotHash,
    sourceVersionKey: buildSourceVersionKey("skill_extract", "session", session.id, snapshotHash),
  };
}

export async function inspectSkillExtractionEligibility(
  kv: StateKV,
  input: { sessionIds: string[] },
): Promise<Record<string, unknown>> {
  const requestedSessionIds = [...new Set(input.sessionIds)];
  if (requestedSessionIds.length === 0 || requestedSessionIds.length > 100 || requestedSessionIds.length !== input.sessionIds.length) {
    throw new Error("invalid_skill_extract_eligibility_sessions");
  }
  const baseline = await partitionAdoptedBaselineSessions(kv, {
    stage: "skill_extract",
    stageContractVersion: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
    sessionIds: requestedSessionIds,
  });
  const sessionIds = baseline.openSessionIds;
  if (sessionIds.length === 0) {
    return {
      success: true,
      baselineId: baseline.baselineId,
      adoptedBaselineSessionIds: baseline.adoptedSessionIds,
      eligible: [],
      terminal: baseline.adoptedSessionIds.map((sessionId) => ({
        sessionId,
        reason: "adopted_baseline",
      })),
      sourceCorrection: [],
      claimed: [],
      reconciliation: [],
      ineligible: [],
    };
  }
  const [sessions, summaries, observationLists, skills] = await Promise.all([
    Promise.all(sessionIds.map((id) => kv.get<Session>(KV.sessions, id))),
    Promise.all(sessionIds.map((id) => kv.get<SessionSummary>(KV.summaries, id))),
    Promise.all(sessionIds.map((id) => kv.list<CompressedObservation>(KV.observations(id)))),
    kv.list<ProceduralMemory>(KV.procedural),
  ]);
  const sourceVersions = sessions.map((session, index) => session && summaries[index]
    ? buildSkillExtractionSourceVersion(session, summaries[index]!, observationLists[index])
    : null);
  const candidates = await inspectContributionCandidates(kv, {
    stage: "skill_extract",
    stageContractVersion: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
    sourceVersionKeys: sourceVersions.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => item.sourceVersionKey),
  });
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.sourceVersionKey, candidate]));
  const result = {
    eligible: [] as Record<string, unknown>[], terminal: [] as Record<string, unknown>[],
    sourceCorrection: [] as Record<string, unknown>[], claimed: [] as Record<string, unknown>[],
    reconciliation: [] as Record<string, unknown>[], ineligible: [] as Record<string, unknown>[],
  };
  for (let index = 0; index < sessionIds.length; index += 1) {
    const sessionId = sessionIds[index];
    const session = sessions[index]; const summary = summaries[index]; const observations = observationLists[index];
    if (!session || session.status !== "completed" || !summary || observations.length < 3) {
      result.ineligible.push({ sessionId, reason: !session ? "session_missing" : !summary ? "summary_missing" : "session_not_eligible" });
      continue;
    }
    const source = sourceVersions[index]!;
    const base = { sessionId, stageContractVersion: SKILL_EXTRACT_CONTRIBUTION_CONTRACT, sourceVersionKey: source.sourceVersionKey, sourceSnapshotHash: source.snapshotHash };
    const candidate = candidatesByKey.get(source.sourceVersionKey);
    if (!candidate) { result.reconciliation.push({ ...base, reason: "contribution_candidate_missing" }); continue; }
    if (candidate.state === "eligible") {
      if (skills.some((skill) => isVerifiableSkill(skill) && skill.sourceSessionIds.includes(sessionId))) {
        result.reconciliation.push({ ...base, reason: "existing_domain_effect_without_contribution" });
      } else result.eligible.push(base);
      continue;
    }
    if (candidate.state === "terminal") {
      const record = await kv.get<ContributionRecord>(KV.extractionContributionRecords("skill_extract", SKILL_EXTRACT_CONTRIBUTION_CONTRACT), source.sourceVersionKey);
      if (!record) { result.reconciliation.push({ ...base, reason: "terminal_record_missing" }); continue; }
      const verified = await verifyTerminalSkillContribution(kv, {
        identity: { runId: "eligibility", stage: "skill_extract", unitId: sessionId, inputHash: "" },
        stageContractVersion: SKILL_EXTRACT_CONTRIBUTION_CONTRACT, sourceVersionKey: source.sourceVersionKey,
        sourceSnapshotHash: source.snapshotHash, record,
      });
      if (verified.success === false) result.reconciliation.push({ ...base, reason: "terminal_verification_failed" });
      else result.terminal.push({ ...base, result: verified });
      continue;
    }
    if (candidate.state === "source_correction_requires_migration") result.sourceCorrection.push({ ...base, reason: candidate.reason });
    else if (candidate.state === "claimed") result.claimed.push({ ...base, reason: candidate.reason });
    else result.reconciliation.push({ ...base, reason: candidate.reason });
  }
  return {
    success: true,
    baselineId: baseline.baselineId,
    adoptedBaselineSessionIds: baseline.adoptedSessionIds,
    ...result,
    terminal: [
      ...baseline.adoptedSessionIds.map((sessionId) => ({
        sessionId,
        reason: "adopted_baseline",
      })),
      ...result.terminal,
    ],
  };
}

export function parseSkillXml(
  xml: string,
): {
  trigger: string;
  title: string;
  steps: string[];
  expectedOutcome: string;
  tags: string[];
} | null {
  const root = xml.trim().match(/^<skill>([\s\S]*)<\/skill>$/);
  if (!root) return null;
  const content = root[1];
  const structured = content.match(/^\s*<trigger>([^<>]+)<\/trigger>\s*<title>([^<>]+)<\/title>\s*<steps>([\s\S]*?)<\/steps>(?:\s*<expected_outcome>([^<>]*)<\/expected_outcome>)?(?:\s*<tags>([^<>]*)<\/tags>)?\s*$/);
  if (!structured) return null;
  const [, trigger, title, stepsContent, expectedOutcome = "", tagsContent = ""] = structured;
  const stepRegex = /<step>([^<>]+)<\/step>/g;
  const steps: string[] = [];
  let match;
  while ((match = stepRegex.exec(stepsContent)) !== null) {
    const step = match[1].trim();
    if (step) steps.push(step);
  }
  if (steps.length < 2 || stepsContent.replace(/<step>[^<>]+<\/step>/g, "").trim() !== "" || !trigger.trim() || !title.trim()) return null;

  return {
    trigger: trigger.trim(),
    title: title.trim(),
    steps,
    expectedOutcome: expectedOutcome.trim(),
    tags: tagsContent
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean) || [],
  };
}

export function isStrictNoSkillResponse(xml: string): boolean {
  return xml.trim() === "<no-skill/>";
}

interface SkillExtractOptions {
  kv: StateKV;
  provider: MemoryProvider;
  sessionId: string;
  model?: string;
  operationIdentity?: ExtractionOperationIdentity;
  operationReceiptManaged?: boolean;
  requireExistingReceipt?: boolean;
  expectedReceiptInputHash?: string;
  stageContractVersion?: string;
  sourceVersionKey?: string;
}

type ParsedSkill = NonNullable<ReturnType<typeof parseSkillXml>>;
const SKILL_COMMIT_LOCK_KEY = "skill-extract-commit";

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableOperationHash(value: unknown): string {
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

function skillProposalHash(options: {
  parsed: ParsedSkill | null;
  sessionId: string;
  concepts: string[];
  sourceObservationIds: string[];
  stageContractVersion?: string;
  sourceVersionKey?: string;
  sourceSnapshotHash?: string;
  contributionId?: string;
}): string {
  return fingerprintId("skh", stableStringify([
    options.parsed,
    options.sessionId,
    options.concepts,
    options.sourceObservationIds,
    options.stageContractVersion,
    options.sourceVersionKey,
    options.sourceSnapshotHash,
    options.contributionId,
  ]));
}

function skillStableEffect(skill: ProceduralMemory): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    triggerCondition: skill.triggerCondition,
    steps: skill.steps,
    expectedOutcome: skill.expectedOutcome,
    tags: skill.tags,
    concepts: skill.concepts,
    sourceObservationIds: skill.sourceObservationIds,
    createdAt: skill.createdAt,
  };
}

function skillAuditEffect(audit: AuditEntry): Record<string, unknown> {
  return {
    id: audit.id,
    timestamp: audit.timestamp,
    operation: audit.operation,
    functionId: audit.functionId,
    targetIds: audit.targetIds,
    details: audit.details,
  };
}

function skillContributionEffectRefs(skill: ProceduralMemory, audit: AuditEntry): ContributionEffectRef[] {
  return [
    { scope: KV.procedural, key: skill.id, effectHash: stableHash(skillStableEffect(skill)) },
    { scope: KV.audit, key: audit.id, effectHash: stableHash(skillAuditEffect(audit)) },
  ];
}

function isVerifiableSkill(value: unknown): value is ProceduralMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const skill = value as Partial<ProceduralMemory>;
  return typeof skill.id === "string"
    && typeof skill.name === "string"
    && typeof skill.triggerCondition === "string"
    && Array.isArray(skill.steps)
    && skill.steps.every((step) => typeof step === "string")
    && typeof skill.expectedOutcome === "string"
    && Array.isArray(skill.tags)
    && skill.tags.every((tag) => typeof tag === "string")
    && Array.isArray(skill.concepts)
    && skill.concepts.every((concept) => typeof concept === "string")
    && Array.isArray(skill.sourceSessionIds)
    && skill.sourceSessionIds.every((sessionId) => typeof sessionId === "string")
    && Array.isArray(skill.sourceObservationIds)
    && skill.sourceObservationIds.every((observationId) => typeof observationId === "string")
    && typeof skill.createdAt === "string";
}

function skillIdentityId(skill: Pick<
  ProceduralMemory,
  "name" | "triggerCondition" | "steps"
>): string {
  return fingerprintId(
    "skill",
    JSON.stringify({
      title: skill.name.toLowerCase(),
      trigger: skill.triggerCondition.toLowerCase(),
      steps: skill.steps.map((step) => step.toLowerCase().trim()),
    }),
  );
}

function skillProposalKey(identity: ExtractionOperationIdentity): string {
  return fingerprintId("skp", JSON.stringify([
    identity.runId,
    identity.stage,
    identity.unitId,
  ]));
}

function skillProposalResponse(proposal: SkillExtractionProposal): Record<string, unknown> {
  return {
    ...proposal.responseMetadata,
    ...(proposal.response || {}),
    success: true,
    status: proposal.response?.status || proposal.status,
    preparedHandle: proposal.handle,
    proposalHash: proposal.proposalHash,
    inputHash: proposal.inputHash,
    promptChars: proposal.promptChars,
  };
}

function committedSkillFailure(cause: string): Record<string, unknown> {
  return {
    success: false,
    status: "failed",
    failure: { class: "hard", cause },
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyCommittedSkillProposal(
  kv: StateKV,
  proposal: SkillExtractionProposal,
): Promise<Record<string, unknown> | null> {
  if (!proposal.parsed) {
    return (
      !proposal.commitIntent
      && proposal.response?.status === "skipped"
      && proposal.response.extracted === false
      && sameJsonValue(proposal.response.proceduralMemoryIds, [])
    )
      ? null
      : committedSkillFailure("skill_extract_committed_effect_conflict");
  }
  const intent = proposal.commitIntent;
  const response = proposal.response;
  if (!intent || !response) {
    return committedSkillFailure("skill_extract_committed_effect_missing");
  }
  if (
    typeof intent.stableResultHash !== "string"
    || !/^[0-9a-f]{64}$/.test(intent.stableResultHash)
  ) {
    return committedSkillFailure("skill_extract_committed_effect_missing");
  }
  const [skill, audit] = await Promise.all([
    kv.get<ProceduralMemory>(KV.procedural, intent.resultId),
    kv.get<AuditEntry>(KV.audit, intent.auditId),
  ]);
  if (!skill || !audit) {
    return committedSkillFailure("skill_extract_committed_effect_missing");
  }
  const auditDetails = audit.details as Record<string, unknown> | undefined;
  const responseSkill = response.skill;
  if (!isVerifiableSkill(skill) || !isVerifiableSkill(responseSkill)) {
    return committedSkillFailure("skill_extract_committed_effect_conflict");
  }
  const effectMatches = (
    skill.id === intent.resultId
    && skillIdentityId(skill) === intent.resultId
    && stableHash(skillStableEffect(skill)) === intent.stableResultHash
    && skill.sourceSessionIds.includes(proposal.sessionId)
    && responseSkill?.id === intent.resultId
    && stableHash(skillStableEffect(responseSkill)) === intent.stableResultHash
    && responseSkill.sourceSessionIds.includes(proposal.sessionId)
    && audit.id === intent.auditId
    && audit.timestamp === intent.createdAt
    && audit.operation === "skill_extract"
    && audit.functionId === "mem::full-skill-extract-commit"
    && sameJsonValue(audit.targetIds, [intent.resultId])
    && auditDetails?.skillId === intent.resultId
    && auditDetails?.sessionId === proposal.sessionId
    && auditDetails?.reinforced === response.reinforced
    && typeof auditDetails?.duplicateSession === "boolean"
    && response.success === true
    && response.status === "succeeded"
    && response.extracted === true
    && sameJsonValue(response.proceduralMemoryIds, [intent.resultId])
  );
  return effectMatches
    ? null
    : committedSkillFailure("skill_extract_committed_effect_conflict");
}

function skillDomainEffectEvidence(
  proposal: SkillExtractionProposal,
): Record<string, unknown> {
  const intent = proposal.commitIntent!;
  return {
    schema: "skill-extract-domain-effect/v1",
    proposalHash: proposal.proposalHash,
    resultId: intent.resultId,
    auditId: intent.auditId,
    effectHash: stableHash([
      proposal.key,
      proposal.proposalHash,
      intent.resultId,
      intent.auditId,
      intent.createdAt,
      intent.stableResultHash,
    ]),
  };
}

function skillCommitInputHashFromProposal(proposal: SkillExtractionProposal): string {
  return stableOperationHash({
    prepareRunId: proposal.runId,
    unitId: proposal.unitId,
    prepareInputHash: proposal.inputHash,
    preparedHandle: proposal.handle,
    proposalHash: proposal.proposalHash,
  });
}

function receiptMatchesIdentity(
  receipt: ExtractionOperationReceipt<Record<string, unknown>>,
  identity: ExtractionOperationIdentity,
): boolean {
  const expectedKey = buildExtractionOperationKey(identity);
  return receipt.key === expectedKey
    && receipt.version === 1
    && receipt.status === "succeeded"
    && receipt.stage === "skill_extract"
    && receipt.runId === identity.runId
    && receipt.unitId === identity.unitId
    && receipt.inputHash === identity.inputHash;
}

function receiptRefMatchesIdentity(
  receiptRef: ContributionEffectRef,
  identity: ExtractionOperationIdentity,
): boolean {
  const expectedKey = buildExtractionOperationKey(identity);
  return receiptRef.scope === KV.extractionOperationReceipt(expectedKey)
    && receiptRef.key === expectedKey;
}

function isSuccessfulCommittedSkillReceiptResponse(
  value: unknown,
  proposal: SkillExtractionProposal,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !proposal.commitIntent) return false;
  const response = value as Record<string, unknown>;
  return response.success === true
    && response.status === "succeeded"
    && response.extracted === true
    && sameJsonValue(response.proceduralMemoryIds, [proposal.commitIntent.resultId])
    && sameJsonValue(response.domainEffectEvidence, skillDomainEffectEvidence(proposal));
}

function isStrictNoEffectSkillReceiptResponse(
  value: unknown,
  proposal: SkillExtractionProposal,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return proposal.parsed === null
    && proposal.status === "committed"
    && proposal.response?.status === "skipped"
    && proposal.response.extracted === false
    && sameJsonValue(proposal.response.proceduralMemoryIds, [])
    && proposal.response.reason === "no clear procedure found"
    && proposal.response.parseFailures === 1
    && response.success === true
    && response.status === "skipped"
    && response.extracted === false
    && sameJsonValue(response.proceduralMemoryIds, [])
    && response.preparedHandle === proposal.handle
    && response.proposalHash === proposal.proposalHash
    && response.inputHash === proposal.inputHash
    && response.promptChars === proposal.response.promptChars
    && response.parseFailures === 1;
}

async function readVerifiedSkillContributionReceipt(
  kv: StateKV,
  options: {
    proposal: SkillExtractionProposal;
    operationReceiptRef: ContributionEffectRef;
    commitIdentity?: ExtractionOperationIdentity;
    noEffect?: boolean;
  },
): Promise<ExtractionOperationReceipt<Record<string, unknown>> | null> {
  const receipt = await kv.get<ExtractionOperationReceipt<Record<string, unknown>>>(
    options.operationReceiptRef.scope,
    options.operationReceiptRef.key,
  );
  if (!receipt) return null;
  if (options.noEffect) {
    const expectedIdentity = {
      runId: options.proposal.runId,
      stage: "skill_extract" as const,
      unitId: options.proposal.unitId,
      inputHash: options.proposal.inputHash,
    };
    if (
      (options.commitIdentity && (
        options.commitIdentity.runId !== expectedIdentity.runId
        || options.commitIdentity.stage !== expectedIdentity.stage
        || options.commitIdentity.unitId !== expectedIdentity.unitId
        || options.commitIdentity.inputHash !== expectedIdentity.inputHash
      ))
      || !receiptRefMatchesIdentity(options.operationReceiptRef, expectedIdentity)
      || !receiptMatchesIdentity(receipt, expectedIdentity)
    ) return null;
  } else {
    const receiptIdentity: ExtractionOperationIdentity = {
      runId: receipt.runId,
      stage: receipt.stage,
      unitId: receipt.unitId,
      inputHash: receipt.inputHash,
    };
    if (
      receipt.version !== 1
      || receipt.status !== "succeeded"
      || receipt.stage !== "skill_extract"
      || receipt.unitId !== options.proposal.unitId
      || receipt.inputHash !== skillCommitInputHashFromProposal(options.proposal)
      || !receiptRefMatchesIdentity(options.operationReceiptRef, receiptIdentity)
      || !receiptMatchesIdentity(receipt, receiptIdentity)
      || (options.commitIdentity && (
        options.commitIdentity.runId !== receipt.runId
        || options.commitIdentity.stage !== receipt.stage
        || options.commitIdentity.unitId !== receipt.unitId
        || options.commitIdentity.inputHash !== receipt.inputHash
      ))
    ) return null;
  }
  const responseMatches = options.noEffect
    ? isStrictNoEffectSkillReceiptResponse(receipt.response, options.proposal)
    : isSuccessfulCommittedSkillReceiptResponse(receipt.response, options.proposal);
  return responseMatches ? receipt : null;
}

async function storeSkillProposal(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  sessionId: string;
  parsed: ParsedSkill | null;
  concepts: string[];
  sourceObservationIds: string[];
  promptChars: number;
  responseMetadata: Record<string, unknown>;
  contribution?: {
    stageContractVersion: string;
    sourceVersionKey: string;
    sourceSnapshotHash: string;
    contributionId: string;
  };
}): Promise<Record<string, unknown>> {
  const key = skillProposalKey(options.identity);
  const proposalHash = skillProposalHash({ ...options, ...options.contribution });
  const proposal: SkillExtractionProposal = {
    ...options.identity,
    key,
    handle: fingerprintId("skph", `${key}:${proposalHash}`),
    proposalHash,
    status: options.parsed ? "prepared" : "committed",
    preparedAt: new Date().toISOString(),
    sessionId: options.sessionId,
    parsed: options.parsed,
    concepts: options.concepts,
    sourceObservationIds: options.sourceObservationIds,
    promptChars: options.promptChars,
    responseMetadata: options.responseMetadata,
    ...options.contribution,
    ...(!options.parsed ? {
      response: {
        success: true,
        status: "skipped",
        extracted: false,
        proceduralMemoryIds: [],
        reason: "no clear procedure found",
        promptChars: options.promptChars,
        parseFailures: 1,
      },
    } : {}),
  };
  await options.kv.set(KV.skillExtractionProposal(key), key, proposal);
  return skillProposalResponse(proposal);
}

export async function findSkillPreparationResult(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
): Promise<Record<string, unknown> | null> {
  const proposal = await kv.get<SkillExtractionProposal>(
    KV.skillExtractionProposal(skillProposalKey(identity)),
    skillProposalKey(identity),
  );
  if (!proposal) return null;
  if (proposal.inputHash !== identity.inputHash) {
    return {
      success: false,
      status: "failed",
      failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
    };
  }
  const expectedHash = skillProposalHash(proposal);
  if (
    proposal.key !== skillProposalKey(identity)
    || proposal.runId !== identity.runId
    || proposal.stage !== identity.stage
    || proposal.unitId !== identity.unitId
    || proposal.proposalHash !== expectedHash
    || proposal.handle !== fingerprintId("skph", `${proposal.key}:${expectedHash}`)
  ) {
    return committedSkillFailure("proposal_identity_conflict");
  }
  return skillProposalResponse(proposal);
}

function skillContributionFailure(cause: string): Record<string, unknown> {
  return { success: false, status: "failed", failure: { class: "hard", cause } };
}

function proposalMatchesSkillContribution(
  proposal: SkillExtractionProposal,
  input: {
    identity: ExtractionOperationIdentity;
    stageContractVersion: string;
    sourceVersionKey: string;
    sourceSnapshotHash: string;
    contributionId: string;
  },
): boolean {
  return proposal.stageContractVersion === input.stageContractVersion
    && proposal.sourceVersionKey === input.sourceVersionKey
    && proposal.sourceSnapshotHash === input.sourceSnapshotHash
    && proposal.contributionId === input.contributionId
    && proposal.runId === input.identity.runId
    && proposal.unitId === input.identity.unitId
    && proposal.stage === "skill_extract";
}

async function readVerifiedSkillProposal(
  kv: StateKV,
  input: {
    identity: ExtractionOperationIdentity;
    stageContractVersion: string;
    sourceVersionKey: string;
    sourceSnapshotHash: string;
    contributionId: string;
  },
): Promise<SkillExtractionProposal | null> {
  const key = skillProposalKey(input.identity);
  const proposal = await kv.get<SkillExtractionProposal>(KV.skillExtractionProposal(key), key);
  if (!proposal || !proposalMatchesSkillContribution(proposal, input)) return null;
  return skillProposalHash(proposal) === proposal.proposalHash ? proposal : null;
}

async function readVerifiedSkillProposalForRecord(
  kv: StateKV,
  input: {
    record: ContributionRecord;
    stageContractVersion: string;
    sourceVersionKey: string;
    sourceSnapshotHash: string;
  },
): Promise<{ proposal: SkillExtractionProposal; identity: ExtractionOperationIdentity } | null> {
  const identity = {
    runId: input.record.runId,
    stage: "skill_extract" as const,
    unitId: input.record.unitId,
    inputHash: "",
  };
  const key = skillProposalKey(identity);
  const proposal = await kv.get<SkillExtractionProposal>(KV.skillExtractionProposal(key), key);
  if (!proposal || !proposalMatchesSkillContribution(proposal, {
    identity,
    stageContractVersion: input.stageContractVersion,
    sourceVersionKey: input.sourceVersionKey,
    sourceSnapshotHash: input.sourceSnapshotHash,
    contributionId: input.record.contributionId,
  }) || skillProposalHash(proposal) !== proposal.proposalHash) return null;
  return { proposal, identity: { ...identity, inputHash: proposal.inputHash } };
}

async function verifyTerminalSkillContribution(
  kv: StateKV,
  input: {
    identity: ExtractionOperationIdentity;
    stageContractVersion: string;
    sourceVersionKey: string;
    sourceSnapshotHash: string;
    record: ContributionRecord;
  },
): Promise<Record<string, unknown>> {
  const verified = await readVerifiedSkillProposalForRecord(kv, input);
  if (!verified || !input.record.operationReceiptRef) {
    return skillContributionFailure("skill_extract_terminal_reconciliation_required");
  }
  const { proposal, identity } = verified;
  const receiptRef = input.record.operationReceiptRef;
  if (input.record.state === "no_effect") {
    const proof = input.record.noEffectProof;
    const receipt = await readVerifiedSkillContributionReceipt(kv, {
      proposal,
      operationReceiptRef: receiptRef,
      commitIdentity: identity,
      noEffect: true,
    });
    if (!receipt
      || !proof || proof.kind !== "strict_legal_empty" || proof.receiptKey !== receiptRef.key
      || proof.reasonCode !== "skill_extract_no_skill" || (input.record.effectRefs?.length ?? 0) !== 0
      || proposal.parsed !== null || proposal.status !== "committed"
      || proposal.response?.status !== "skipped" || proposal.response.extracted !== false
      || !sameJsonValue(proposal.response.proceduralMemoryIds, [])
      || proposal.contributionReceiptRef?.scope !== receiptRef.scope
      || proposal.contributionReceiptRef?.key !== receiptRef.key) {
      return skillContributionFailure("skill_extract_terminal_reconciliation_required");
    }
    return skillProposalResponse(proposal);
  }
  const receipt = await readVerifiedSkillContributionReceipt(kv, {
    proposal,
    operationReceiptRef: receiptRef,
  });
  const verificationFailure = await verifyCommittedSkillProposal(kv, proposal);
  if (!receipt || verificationFailure || proposal.status !== "committed" || !proposal.commitIntent
    || proposal.commitIntent.contributionReceiptRef?.scope !== receiptRef.scope
    || proposal.commitIntent.contributionReceiptRef?.key !== receiptRef.key) {
    return skillContributionFailure("skill_extract_terminal_reconciliation_required");
  }
  const [skill, audit] = await Promise.all([
    kv.get<ProceduralMemory>(KV.procedural, proposal.commitIntent.resultId),
    kv.get<AuditEntry>(KV.audit, proposal.commitIntent.auditId),
  ]);
  if (!skill || !audit || !sameJsonValue(input.record.effectRefs, skillContributionEffectRefs(skill, audit))
    || !sameJsonValue(proposal.commitIntent.contributionEffectRefs, input.record.effectRefs)) {
    return skillContributionFailure("skill_extract_terminal_reconciliation_required");
  }
  return skillProposalResponse(proposal);
}

export async function reconcileClaimedSkillContribution(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  stageContractVersion: string;
  sourceVersionKey: string;
  sourceSnapshotHash: string;
  contributionId: string;
  operationReceiptRef: ContributionEffectRef;
  commitIdentity?: ExtractionOperationIdentity;
}): Promise<Record<string, unknown>> {
  const proposal = await readVerifiedSkillProposal(options.kv, options);
  if (!proposal || proposal.status !== "committed") {
    return skillContributionFailure("skill_extract_contribution_reconciliation_required");
  }
  if (!proposal.parsed) {
    const receipt = await readVerifiedSkillContributionReceipt(options.kv, {
      proposal,
      operationReceiptRef: options.operationReceiptRef,
      commitIdentity: options.commitIdentity,
      noEffect: true,
    });
    if (!receipt) {
      return skillContributionFailure("skill_extract_contribution_reconciliation_required");
    }
    proposal.contributionReceiptRef = options.operationReceiptRef;
    await options.kv.set(KV.skillExtractionProposal(proposal.key), proposal.key, proposal);
    await markClaimedBatchNoEffect(options.kv, {
      stage: "skill_extract", stageContractVersion: options.stageContractVersion,
      contributionId: options.contributionId, sourceVersionKeys: [options.sourceVersionKey],
      operationReceiptRef: options.operationReceiptRef,
      receiptKey: options.operationReceiptRef.key,
      reasonCode: "skill_extract_no_skill",
    });
    return skillProposalResponse(proposal);
  }
  const verificationFailure = await verifyCommittedSkillProposal(options.kv, proposal);
  const receipt = await readVerifiedSkillContributionReceipt(options.kv, {
    proposal,
    operationReceiptRef: options.operationReceiptRef,
    commitIdentity: options.commitIdentity,
  });
  if (!receipt || verificationFailure || !proposal.commitIntent?.stableResultHash) {
    return skillContributionFailure("skill_extract_contribution_reconciliation_required");
  }
  const [skill, audit] = await Promise.all([
    options.kv.get<ProceduralMemory>(KV.procedural, proposal.commitIntent.resultId),
    options.kv.get<AuditEntry>(KV.audit, proposal.commitIntent.auditId),
  ]);
  if (!skill || !audit) return skillContributionFailure("skill_extract_contribution_reconciliation_required");
  const effectRefs = skillContributionEffectRefs(skill, audit);
  proposal.commitIntent.contributionReceiptRef = options.operationReceiptRef;
  proposal.commitIntent.contributionEffectRefs = effectRefs;
  await options.kv.set(KV.skillExtractionProposal(proposal.key), proposal.key, proposal);
  await commitClaimedBatch(options.kv, {
    stage: "skill_extract", stageContractVersion: options.stageContractVersion,
    contributionId: options.contributionId, sourceVersionKeys: [options.sourceVersionKey],
    operationReceiptRef: options.operationReceiptRef,
    effectRefs,
  });
  return skillProposalResponse(proposal);
}

export async function reconcileSkillContributionFromProposal(options: {
  kv: StateKV;
  prepareIdentity: Pick<ExtractionOperationIdentity, "runId" | "stage" | "unitId">;
  commitIdentity: ExtractionOperationIdentity;
  operationReceiptRef: ContributionEffectRef;
}): Promise<Record<string, unknown>> {
  try {
    const key = skillProposalKey({ ...options.prepareIdentity, inputHash: "" });
    const proposal = await options.kv.get<SkillExtractionProposal>(KV.skillExtractionProposal(key), key);
    if (!proposal?.stageContractVersion || !proposal.sourceVersionKey || !proposal.sourceSnapshotHash || !proposal.contributionId) {
      return skillContributionFailure("skill_extract_contribution_reconciliation_required");
    }
    return await reconcileClaimedSkillContribution({
      kv: options.kv,
      identity: { runId: proposal.runId, stage: "skill_extract", unitId: proposal.unitId, inputHash: proposal.inputHash },
      stageContractVersion: proposal.stageContractVersion,
      sourceVersionKey: proposal.sourceVersionKey,
      sourceSnapshotHash: proposal.sourceSnapshotHash,
      contributionId: proposal.contributionId,
      operationReceiptRef: options.operationReceiptRef,
      commitIdentity: options.commitIdentity,
    });
  } catch {
    return skillContributionFailure("skill_extract_contribution_reconciliation_required");
  }
}

async function persistSkillDirect(options: {
  kv: StateKV;
  parsed: ParsedSkill;
  summary: SessionSummary;
  observations: CompressedObservation[];
  sessionId: string;
}): Promise<{ skill: ProceduralMemory; reinforced: boolean }> {
  const id = fingerprintId(
    "skill",
    JSON.stringify({
      title: options.parsed.title.toLowerCase(),
      trigger: options.parsed.trigger.toLowerCase(),
      steps: options.parsed.steps.map((step) => step.toLowerCase().trim()),
    }),
  );
  return withKeyedLock(SKILL_COMMIT_LOCK_KEY, async () => {
    const existing = await options.kv.get<ProceduralMemory>(KV.procedural, id).catch(() => null);
    if (existing) {
      const alreadyReinforced = existing.sourceSessionIds.includes(options.sessionId);
      if (!alreadyReinforced) {
        existing.strength = Math.min(1.0, existing.strength + 0.15);
        existing.frequency += 1;
        existing.sourceSessionIds = [...existing.sourceSessionIds, options.sessionId];
      }
      existing.updatedAt = new Date().toISOString();
      await options.kv.set(KV.procedural, existing.id, existing);
      try {
        await recordAudit(options.kv, "skill_extract", "mem::skill-extract", [], {
          skillId: existing.id,
          reinforced: true,
          sessionId: options.sessionId,
        });
      } catch {}
      return { skill: existing, reinforced: true };
    }

    const now = new Date().toISOString();
    const skill: ProceduralMemory = {
      id,
      name: options.parsed.title,
      triggerCondition: options.parsed.trigger,
      steps: options.parsed.steps,
      expectedOutcome: options.parsed.expectedOutcome,
      strength: 0.6,
      frequency: 1,
      tags: options.parsed.tags,
      concepts: options.summary.concepts,
      sourceSessionIds: [options.sessionId],
      sourceObservationIds: options.observations.slice(0, 10).map((observation) => observation.id),
      createdAt: now,
      updatedAt: now,
    };
    await options.kv.set(KV.procedural, skill.id, skill);
    try {
      await recordAudit(options.kv, "skill_extract", "mem::skill-extract", [], {
        skillId: skill.id,
        title: options.parsed.title,
        steps: options.parsed.steps.length,
        sessionId: options.sessionId,
      });
    } catch {}
    return { skill, reinforced: false };
  });
}

export async function runSkillExtract(options: SkillExtractOptions): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const stageMetadata = resolveStageModelMetadata("skill_extract", options.provider, options.model);
  const responseMetadata = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    ...stageMetadata,
    durationMs: Date.now() - startMs,
    ...extra,
  });
  if (!options.sessionId) {
    return { success: false, error: "sessionId is required", ...responseMetadata("failed") };
  }

  const baseline = await partitionAdoptedBaselineSessions(options.kv, {
    stage: "skill_extract",
    stageContractVersion: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
    sessionIds: [options.sessionId],
  });
  if (baseline.adoptedSessionIds.length > 0) {
    return {
      success: false,
      error: "skill_extract_source_adopted_baseline",
      baselineId: baseline.baselineId,
      ...responseMetadata("failed"),
    };
  }

  const session = await options.kv.get<Session>(KV.sessions, options.sessionId).catch(() => null);
  if (!session) {
    return { success: false, error: "session not found", ...responseMetadata("failed") };
  }
  if (session.status !== "completed") {
    return {
      success: false,
      error: "session must be completed before skill extraction",
      ...responseMetadata("failed"),
    };
  }

  const [summary, observations] = await Promise.all([
    options.kv.get<SessionSummary>(KV.summaries, options.sessionId).catch(() => null),
    options.kv.list<CompressedObservation>(KV.observations(options.sessionId)).catch(() => []),
  ]);
  if (!summary) {
    return {
      success: false,
      error: "no summary — run mem::summarize first",
      ...responseMetadata("failed"),
    };
  }
  if (observations.length < 3) {
    return {
      success: false,
      error: "too few observations for skill extraction",
      ...responseMetadata("failed"),
    };
  }

  const sourceVersion = buildSkillExtractionSourceVersion(session, summary, observations);
  const sourceSnapshotHash = sourceVersion.snapshotHash;
  const suppliedContributionFields = [options.stageContractVersion, options.sourceVersionKey]
    .filter((value) => value !== undefined).length;
  if (suppliedContributionFields === 1 || (suppliedContributionFields > 0 && !options.operationIdentity)) {
    return skillContributionFailure("skill_extract_contribution_input_required");
  }
  const expectedSourceVersionKey = sourceVersion.sourceVersionKey;
  if (options.stageContractVersion && options.stageContractVersion !== SKILL_EXTRACT_CONTRIBUTION_CONTRACT) {
    return skillContributionFailure("skill_extract_contribution_contract_migration_required");
  }
  if (options.sourceVersionKey && options.sourceVersionKey !== expectedSourceVersionKey) {
    return skillContributionFailure("skill_extract_source_version_conflict");
  }
  const contributionInput = options.stageContractVersion && options.sourceVersionKey && options.operationIdentity
    ? {
        stageContractVersion: options.stageContractVersion,
        sourceVersionKey: options.sourceVersionKey,
        sourceSnapshotHash,
      }
    : null;

  const verifiedIdentity = options.operationIdentity && options.operationReceiptManaged
    ? {
        ...options.operationIdentity,
        inputHash: stableHash({
          runnerInputHash: options.operationIdentity.inputHash,
          sourceVersionKey: sourceVersion.sourceVersionKey,
          sourceSnapshot: sourceVersion.snapshot,
        }),
      }
    : options.operationIdentity;

  let contributionClaim: Awaited<ReturnType<typeof claimBatch>> | null = null;
  const claimContribution = async () => {
    if (!contributionInput || !verifiedIdentity) return null;
    if (!contributionClaim) {
      contributionClaim = await claimBatch(options.kv, {
        stage: "skill_extract",
        stageContractVersion: contributionInput.stageContractVersion,
        runId: verifiedIdentity.runId,
        unitId: verifiedIdentity.unitId,
        sourceVersionKeys: [contributionInput.sourceVersionKey],
      });
    }
    return contributionClaim;
  };
  if (contributionInput && verifiedIdentity) {
    const initialContribution = await claimContribution();
    if (initialContribution?.status === "already_committed") {
      return verifyTerminalSkillContribution(options.kv, {
        identity: verifiedIdentity,
        ...contributionInput,
        record: initialContribution.records[0]!,
      });
    }
    if (initialContribution?.status === "contribution_reconciliation_required") {
      const record = await options.kv.get<ContributionRecord>(
        KV.extractionContributionRecords("skill_extract", contributionInput.stageContractVersion),
        contributionInput.sourceVersionKey,
      );
      if (record?.state === "no_effect") {
        const verified = await readVerifiedSkillProposalForRecord(options.kv, {
          record,
          stageContractVersion: contributionInput.stageContractVersion,
          sourceVersionKey: contributionInput.sourceVersionKey,
          sourceSnapshotHash: contributionInput.sourceSnapshotHash,
        });
        if (verified?.proposal.contributionReceiptRef) {
          const recovered = await reconcileClaimedSkillContribution({
            kv: options.kv,
            identity: verified.identity,
            ...contributionInput,
            contributionId: record.contributionId,
            operationReceiptRef: verified.proposal.contributionReceiptRef,
          });
          if (recovered.success !== false) return recovered;
        }
      }
    }
    if (initialContribution?.status !== "claimed") {
      const cause = initialContribution?.status === "contract_migration_required"
        ? "skill_extract_contribution_contract_migration_required"
        : initialContribution?.status === "claimed_by_other"
          ? "skill_extract_contribution_claimed_by_other"
          : initialContribution?.status === "source_correction_requires_migration"
            ? "skill_extract_source_correction_requires_migration"
            : "skill_extract_contribution_reconciliation_required";
      return skillContributionFailure(cause);
    }
  }

  const execute = async (): Promise<Record<string, unknown>> => {
    let claimedContributionId: string | null = null;
    if (contributionInput && verifiedIdentity) {
      const contribution = await claimContribution();
      if (!contribution) return skillContributionFailure("skill_extract_contribution_reconciliation_required");
      if (contribution.status === "already_committed") {
        return verifyTerminalSkillContribution(options.kv, {
          identity: verifiedIdentity,
          ...contributionInput,
          record: contribution.records[0]!,
        });
      }
      if (contribution.status !== "claimed") {
        const cause = contribution.status === "contract_migration_required"
          ? "skill_extract_contribution_contract_migration_required"
          : contribution.status === "claimed_by_other"
            ? "skill_extract_contribution_claimed_by_other"
            : contribution.status === "source_correction_requires_migration"
              ? "skill_extract_source_correction_requires_migration"
              : "skill_extract_contribution_reconciliation_required";
        return skillContributionFailure(cause);
      }
      claimedContributionId = contribution.records[0]!.contributionId;
      const frozen = await readVerifiedSkillProposal(options.kv, {
        identity: verifiedIdentity,
        ...contributionInput,
        contributionId: claimedContributionId,
      });
      if (frozen) return skillProposalResponse(frozen);
      const skills = await options.kv.list<ProceduralMemory>(KV.procedural);
      if (skills.some((skill) => isVerifiableSkill(skill) && skill.sourceSessionIds.includes(options.sessionId))) {
        await releaseClaimedBatch(options.kv, {
          stage: "skill_extract", stageContractVersion: contributionInput.stageContractVersion,
          contributionId: claimedContributionId, sourceVersionKeys: [contributionInput.sourceVersionKey],
        });
        return skillContributionFailure("skill_extract_contribution_reconciliation_required");
      }
    } else if (verifiedIdentity) {
      const existing = await findSkillPreparationResult(options.kv, verifiedIdentity);
      if (existing) return existing;
    }
    try {
    const prompt = buildSkillPrompt(summary, observations, session);
    const systemPrompt = withOutputLanguagePolicy(SKILL_EXTRACT_SYSTEM);
    const callOptions = resolveStageModelCallOptions("skill_extract", options.model);
    const response = callOptions
      ? await options.provider.summarize(systemPrompt, prompt, callOptions)
      : await options.provider.summarize(systemPrompt, prompt);
    const strictNoSkill = isStrictNoSkillResponse(response);
    const parsed = strictNoSkill ? null : parseSkillXml(response);
    if (!strictNoSkill && !parsed) throw new Error("skill_extract_parse_failure");

    if (verifiedIdentity) {
      return storeSkillProposal({
        kv: options.kv,
        identity: verifiedIdentity,
        sessionId: options.sessionId,
        parsed,
        concepts: summary.concepts,
        sourceObservationIds: normalizedSkillObservations(observations).slice(0, 10).map((observation) => observation.id),
        promptChars: prompt.length,
        responseMetadata: responseMetadata(parsed ? "prepared" : "skipped"),
        ...(contributionInput && claimedContributionId ? {
          contribution: { ...contributionInput, contributionId: claimedContributionId },
        } : {}),
      });
    }
    if (!parsed) {
      logger.info("No skill extracted — session was exploratory", { sessionId: options.sessionId });
      return {
        success: true,
        extracted: false,
        reason: "no clear procedure found",
        ...responseMetadata("skipped", { promptChars: prompt.length, parseFailures: 1 }),
      };
    }

    const persisted = await persistSkillDirect({
      kv: options.kv,
      parsed,
      summary,
      observations,
      sessionId: options.sessionId,
    });
    logger.info(persisted.reinforced ? "Skill reinforced" : "Skill extracted", {
      id: persisted.skill.id,
      title: parsed.title,
    });
    return {
      success: true,
      extracted: true,
      reinforced: persisted.reinforced,
      skill: persisted.skill,
      ...responseMetadata("succeeded", { promptChars: prompt.length, parseFailures: 0 }),
    };
  } catch (err) {
    if (contributionInput && claimedContributionId) {
      await releaseClaimedBatch(options.kv, {
        stage: "skill_extract", stageContractVersion: contributionInput.stageContractVersion,
        contributionId: claimedContributionId, sourceVersionKeys: [contributionInput.sourceVersionKey],
      }).catch(() => undefined);
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Skill extraction failed", { error: msg });
    return { success: false, error: msg, ...responseMetadata("failed") };
    }
  };

  if (!verifiedIdentity || !options.operationReceiptManaged) return execute();
  let operation = await withExtractionOperationReceipt(
    options.kv,
    verifiedIdentity,
    execute,
    {
      requireExisting: options.requireExistingReceipt === true,
      ...(options.expectedReceiptInputHash
        ? { expectedInputHash: options.expectedReceiptInputHash }
        : {}),
    },
  );
  if (
    operation.failure?.cause === "extraction_operation_reconciliation_required"
  ) {
    const persisted = await findSkillPreparationResult(options.kv, verifiedIdentity);
    if (persisted) {
      operation = await completeModelOperationFromVerifiedResult(
        options.kv,
        verifiedIdentity,
        persisted,
        { allowMissing: true },
      );
    }
  }
  if (operation.failure) {
    const operationReceiptAbsence = projectExtractionOperationReceiptAbsence(
      operation.receiptAbsence,
      options.operationIdentity!.inputHash,
    );
    return {
      success: false,
      status: "failed",
      failure: operation.failure,
      ...(operationReceiptAbsence ? { operationReceiptAbsence } : {}),
    };
  }
  if (contributionInput && operation.receipt?.status === "succeeded") {
    const proposal = await options.kv.get<SkillExtractionProposal>(
      KV.skillExtractionProposal(skillProposalKey(verifiedIdentity)),
      skillProposalKey(verifiedIdentity),
    );
    if (proposal?.parsed === null && proposal.contributionId) {
      const reconciled = await reconcileClaimedSkillContribution({
        kv: options.kv,
        identity: verifiedIdentity,
        ...contributionInput,
        contributionId: proposal.contributionId,
        operationReceiptRef: {
          scope: KV.extractionOperationReceipt(operation.receipt.key),
          key: operation.receipt.key,
        },
      });
      if (reconciled.success === false) return reconciled;
    }
  }
  return operation.response ?? {
    success: false,
    status: "failed",
    failure: { class: "hard", cause: "skill_extract_result_reference_missing" },
  };
}

async function currentSkillSourceVersionForProposal(
  kv: StateKV,
  proposal: SkillExtractionProposal,
): Promise<ReturnType<typeof buildSkillExtractionSourceVersion> | null> {
  const [session, summary, observations] = await Promise.all([
    kv.get<Session>(KV.sessions, proposal.sessionId),
    kv.get<SessionSummary>(KV.summaries, proposal.sessionId),
    kv.list<CompressedObservation>(KV.observations(proposal.sessionId)),
  ]);
  if (!session || session.status !== "completed" || !summary || observations.length < 3) {
    return null;
  }
  return buildSkillExtractionSourceVersion(session, summary, observations);
}

export async function commitSkillExtractionProposal(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  preparedHandle: string;
  proposalHash?: string;
}): Promise<Record<string, unknown>> {
  const key = skillProposalKey(options.identity);
  return withKeyedLock(SKILL_COMMIT_LOCK_KEY, async () => {
    const proposal = await options.kv.get<SkillExtractionProposal>(
      KV.skillExtractionProposal(key),
      key,
    );
    if (!proposal) {
      return { success: false, status: "failed", failure: { class: "hard", cause: "proposal_not_found" } };
    }
    const expectedProposalHash = skillProposalHash(proposal);
    if (
      proposal.key !== key
      || proposal.runId !== options.identity.runId
      || proposal.unitId !== options.identity.unitId
      || proposal.inputHash !== options.identity.inputHash
      || proposal.handle !== options.preparedHandle
      || proposal.proposalHash !== expectedProposalHash
      || proposal.handle !== fingerprintId("skph", `${key}:${expectedProposalHash}`)
      || (
        options.proposalHash !== undefined
        && proposal.proposalHash !== options.proposalHash
      )
      || proposal.stage !== "skill_extract"
    ) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "proposal_identity_conflict" },
      };
    }
    if (
      proposal.status !== "committed"
      && proposal.stageContractVersion
      && proposal.sourceVersionKey
      && proposal.sourceSnapshotHash
      && proposal.contributionId
    ) {
      const currentSource = await currentSkillSourceVersionForProposal(options.kv, proposal);
      if (
        !currentSource
        || currentSource.sourceVersionKey !== proposal.sourceVersionKey
        || currentSource.snapshotHash !== proposal.sourceSnapshotHash
      ) {
        const [existingSkill, existingAudit] = proposal.commitIntent
          ? await Promise.all([
              options.kv.get<ProceduralMemory>(KV.procedural, proposal.commitIntent.resultId),
              options.kv.get<AuditEntry>(KV.audit, proposal.commitIntent.auditId),
            ])
          : [null, null];
        if (existingSkill || existingAudit) {
          return skillContributionFailure("skill_extract_contribution_reconciliation_required");
        }
        try {
          await releaseClaimedBatch(options.kv, {
            stage: "skill_extract",
            stageContractVersion: proposal.stageContractVersion,
            contributionId: proposal.contributionId,
            sourceVersionKeys: [proposal.sourceVersionKey],
          });
          await options.kv.delete(KV.skillExtractionProposal(key), key);
        } catch {
          return skillContributionFailure("skill_extract_contribution_reconciliation_required");
        }
        return skillContributionFailure("skill_extract_source_version_conflict");
      }
    }
    if (proposal.status === "committed") {
      const verificationFailure = await verifyCommittedSkillProposal(options.kv, proposal);
      if (verificationFailure) return verificationFailure;
      return proposal.parsed
        ? {
          ...skillProposalResponse(proposal),
          domainEffectEvidence: skillDomainEffectEvidence(proposal),
        }
        : skillProposalResponse(proposal);
    }
    if (!proposal.parsed) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "skill_proposal_missing_candidate" },
      };
    }

    if (!proposal.commitIntent) {
      proposal.commitIntent = {
        resultId: fingerprintId(
          "skill",
          JSON.stringify({
            title: proposal.parsed.title.toLowerCase(),
            trigger: proposal.parsed.trigger.toLowerCase(),
            steps: proposal.parsed.steps.map((step) => step.toLowerCase().trim()),
          }),
        ),
        auditId: fingerprintId("aud", JSON.stringify([key, proposal.proposalHash])),
        createdAt: new Date().toISOString(),
      };
      proposal.status = "committing";
      await options.kv.set(KV.skillExtractionProposal(key), key, proposal);
    }

    const intent = proposal.commitIntent;
    const existing = await options.kv.get<ProceduralMemory>(KV.procedural, intent.resultId).catch(() => null);
    if (existing && !isVerifiableSkill(existing)) {
      return committedSkillFailure("skill_extract_committed_effect_conflict");
    }
    const alreadyReinforced = existing?.sourceSessionIds.includes(proposal.sessionId) ?? false;
    const skill: ProceduralMemory = existing
      ? {
          ...existing,
          strength: alreadyReinforced ? existing.strength : Math.min(1.0, existing.strength + 0.15),
          frequency: alreadyReinforced ? existing.frequency : existing.frequency + 1,
          sourceSessionIds: alreadyReinforced
            ? existing.sourceSessionIds
            : [...existing.sourceSessionIds, proposal.sessionId],
          updatedAt: intent.createdAt,
        }
      : {
          id: intent.resultId,
          name: proposal.parsed.title,
          triggerCondition: proposal.parsed.trigger,
          steps: proposal.parsed.steps,
          expectedOutcome: proposal.parsed.expectedOutcome,
          strength: 0.6,
          frequency: 1,
          tags: proposal.parsed.tags,
          concepts: proposal.concepts,
          sourceSessionIds: [proposal.sessionId],
          sourceObservationIds: proposal.sourceObservationIds,
          createdAt: intent.createdAt,
          updatedAt: intent.createdAt,
        };
    if (skillIdentityId(skill) !== intent.resultId) {
      return committedSkillFailure("skill_extract_committed_effect_conflict");
    }
    const stableResultHash = stableHash(skillStableEffect(skill));
    if (intent.stableResultHash === undefined) {
      intent.stableResultHash = stableResultHash;
      await options.kv.set(KV.skillExtractionProposal(key), key, proposal);
    } else if (intent.stableResultHash !== stableResultHash) {
      return committedSkillFailure("skill_extract_committed_effect_conflict");
    }
    await options.kv.set(KV.procedural, skill.id, skill);
    const audit: AuditEntry = {
      id: intent.auditId,
      timestamp: intent.createdAt,
      operation: "skill_extract",
      functionId: "mem::full-skill-extract-commit",
      targetIds: [skill.id],
      details: {
        skillId: skill.id,
        reinforced: Boolean(existing),
        duplicateSession: alreadyReinforced,
        sessionId: proposal.sessionId,
      },
    };
    await options.kv.set(KV.audit, audit.id, audit);

    proposal.status = "committed";
    proposal.response = {
      success: true,
      status: "succeeded",
      extracted: true,
      reinforced: Boolean(existing),
      proceduralMemoryIds: [skill.id],
      skill,
      promptChars: proposal.promptChars,
      parseFailures: 0,
    };
    await options.kv.set(KV.skillExtractionProposal(key), key, proposal);
    return await verifyCommittedSkillProposal(options.kv, proposal)
      ?? {
        ...skillProposalResponse(proposal),
        domainEffectEvidence: skillDomainEffectEvidence(proposal),
      };
  });
}

export function registerSkillExtractFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::skill-extract-eligibility",
    async (data: { sessionIds: string[] }) => inspectSkillExtractionEligibility(kv, data),
  );
  sdk.registerFunction("mem::skill-extract",
    async (data: { sessionId: string; model?: string }) =>
      runSkillExtract({ kv, provider, ...data }),
  );

  sdk.registerFunction(
    "mem::full-skill-extract-prepare",
    async (data: {
      identity: ExtractionOperationIdentity;
      sessionId: string;
      model?: string;
      stageContractVersion?: string;
      sourceVersionKey?: string;
      operationReceiptManaged?: boolean;
      requireExistingReceipt?: boolean;
      expectedReceiptInputHash?: string;
    }) => withKeyedLock(
      `skill-extract-prepare:${skillProposalKey(data.identity)}`,
      () => runSkillExtract({ kv, provider, ...data, operationIdentity: data.identity }),
    ),
  );

  sdk.registerFunction(
    "mem::full-skill-extract-commit",
    async (data: {
      identity: ExtractionOperationIdentity;
      preparedHandle: string;
      proposalHash?: string;
    }) => commitSkillExtractionProposal({ kv, ...data }),
  );

  sdk.registerFunction("mem::skill-list",
    async (data: { limit?: number }) => {
      const limit = data?.limit ?? 50;
      const skills = await kv.list<ProceduralMemory>(KV.procedural);
      const sorted = skills.sort((a, b) => b.strength - a.strength);
      return {
        success: true,
        skills: sorted.slice(0, limit),
        total: sorted.length,
      };
    },
  );

  sdk.registerFunction("mem::skill-match",
    async (data: { query: string; limit?: number }) => {
      if (!data?.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const limit = data.limit ?? 5;
      const query = data.query.toLowerCase();
      const terms = query.split(/\s+/).filter((t) => t.length > 2);

      const skills = await kv.list<ProceduralMemory>(KV.procedural);

      const scored = skills
        .map((skill) => {
          const text =
            `${skill.name} ${skill.triggerCondition} ${(skill.tags || []).join(" ")} ${skill.steps.join(" ")}`.toLowerCase();
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;
          const relevance = matchCount / terms.length;
          return { skill, score: relevance * skill.strength };
        })
        .filter(Boolean) as Array<{
        skill: ProceduralMemory;
        score: number;
      }>;

      scored.sort((a, b) => b.score - a.score);

      return {
        success: true,
        matches: scored.slice(0, limit),
      };
    },
  );
}
