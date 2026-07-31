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
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  completeModelOperationFromVerifiedResult,
  projectExtractionOperationReceiptAbsence,
  withExtractionOperationReceipt,
} from "./extraction-operation-receipts.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import {
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";

const SKILL_EXTRACT_SYSTEM = `You are a skill extraction engine. Given a completed multi-step task session, extract a reusable procedural skill document.

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

  const obsText = observations
    .filter((o) => o.importance >= 4)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(0, 30)
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

function parseSkillXml(
  xml: string,
): {
  trigger: string;
  title: string;
  steps: string[];
  expectedOutcome: string;
  tags: string[];
} | null {
  if (xml.includes("<no-skill/>")) return null;

  const triggerMatch = xml.match(/<trigger>([\s\S]*?)<\/trigger>/);
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  const stepsMatch = xml.match(/<steps>([\s\S]*?)<\/steps>/);
  const outcomeMatch = xml.match(
    /<expected_outcome>([\s\S]*?)<\/expected_outcome>/,
  );
  const tagsMatch = xml.match(/<tags>([\s\S]*?)<\/tags>/);

  if (!triggerMatch || !titleMatch || !stepsMatch) return null;

  const stepRegex = /<step>([\s\S]*?)<\/step>/g;
  const steps: string[] = [];
  let match;
  while ((match = stepRegex.exec(stepsMatch[1])) !== null) {
    const step = match[1].trim();
    if (step) steps.push(step);
  }

  if (steps.length < 2) return null;

  return {
    trigger: triggerMatch[1].trim(),
    title: titleMatch[1].trim(),
    steps,
    expectedOutcome: outcomeMatch?.[1]?.trim() || "",
    tags: tagsMatch?.[1]
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean) || [],
  };
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

function skillProposalHash(options: {
  parsed: ParsedSkill | null;
  sessionId: string;
  concepts: string[];
  sourceObservationIds: string[];
}): string {
  return fingerprintId("skh", stableStringify([
    options.parsed,
    options.sessionId,
    options.concepts,
    options.sourceObservationIds,
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

async function storeSkillProposal(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  sessionId: string;
  parsed: ParsedSkill | null;
  concepts: string[];
  sourceObservationIds: string[];
  promptChars: number;
  responseMetadata: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const key = skillProposalKey(options.identity);
  const proposalHash = skillProposalHash(options);
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

  const verifiedIdentity = options.operationIdentity && options.operationReceiptManaged
    ? {
        ...options.operationIdentity,
        inputHash: stableHash({
          runnerInputHash: options.operationIdentity.inputHash,
          session: {
            id: session.id,
            status: session.status,
            startedAt: session.startedAt,
          },
          summary: {
            sessionId: summary.sessionId,
            title: summary.title,
            narrative: summary.narrative,
            keyDecisions: summary.keyDecisions,
            filesModified: summary.filesModified,
            concepts: summary.concepts,
          },
          observations: observations.map((observation) => ({
            id: observation.id,
            timestamp: observation.timestamp,
            type: observation.type,
            title: observation.title,
            narrative: observation.narrative,
            importance: observation.importance,
          })),
          provider: stageMetadata.provider,
          model: stageMetadata.model ?? null,
          modelSource: stageMetadata.modelSource ?? null,
        }),
      }
    : options.operationIdentity;

  const execute = async (): Promise<Record<string, unknown>> => {
    if (verifiedIdentity) {
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
    const parsed = parseSkillXml(response);

    if (verifiedIdentity) {
      return storeSkillProposal({
        kv: options.kv,
        identity: verifiedIdentity,
        sessionId: options.sessionId,
        parsed,
        concepts: summary.concepts,
        sourceObservationIds: observations.slice(0, 10).map((observation) => observation.id),
        promptChars: prompt.length,
        responseMetadata: responseMetadata(parsed ? "prepared" : "skipped"),
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
  return operation.response ?? {
    success: false,
    status: "failed",
    failure: { class: "hard", cause: "skill_extract_result_reference_missing" },
  };
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
