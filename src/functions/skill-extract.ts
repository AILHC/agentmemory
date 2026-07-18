import type { ISdk } from "iii-sdk";
import type {
  AuditEntry,
  CompressedObservation,
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
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
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";
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
}

type ParsedSkill = NonNullable<ReturnType<typeof parseSkillXml>>;
const SKILL_COMMIT_LOCK_KEY = "skill-extract-commit";

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
  const proposalHash = fingerprintId("skh", JSON.stringify([
    options.parsed,
    options.sessionId,
    options.concepts,
    options.sourceObservationIds,
  ]));
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
  await options.kv.set(KV.skillExtractionProposals, key, proposal);
  return skillProposalResponse(proposal);
}

async function reconcileSkillPreparation(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
): Promise<Record<string, unknown> | null> {
  const receipt = await kv.get<ExtractionOperationReceipt<Record<string, unknown>>>(
    KV.extractionOperationReceipts,
    buildExtractionOperationKey(identity),
  );
  if (receipt && receipt.inputHash !== identity.inputHash) {
    return {
      success: false,
      status: "failed",
      failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
    };
  }
  if (receipt?.status === "running") {
    return {
      success: false,
      status: "failed",
      failure: { class: "transient_runtime", cause: "extraction_operation_reconciliation_required" },
    };
  }
  if (receipt?.status === "failed") {
    return {
      success: false,
      status: "failed",
      failure: receipt.failure ?? { class: "unit", cause: "extraction_operation_failed" },
    };
  }
  if (receipt?.status === "succeeded" && receipt.response) {
    return {
      ...receipt.response,
      success: true,
      status: typeof receipt.response.status === "string"
        ? receipt.response.status
        : "succeeded",
      replayed: true,
    };
  }
  const proposal = await kv.get<SkillExtractionProposal>(
    KV.skillExtractionProposals,
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
  if (options.operationIdentity) {
    const reconciled = await reconcileSkillPreparation(options.kv, options.operationIdentity);
    if (reconciled) return reconciled;
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

  try {
    const prompt = buildSkillPrompt(summary, observations, session);
    const systemPrompt = withOutputLanguagePolicy(SKILL_EXTRACT_SYSTEM);
    const callOptions = resolveStageModelCallOptions("skill_extract", options.model);
    const response = callOptions
      ? await options.provider.summarize(systemPrompt, prompt, callOptions)
      : await options.provider.summarize(systemPrompt, prompt);
    const parsed = parseSkillXml(response);

    if (options.operationIdentity) {
      return storeSkillProposal({
        kv: options.kv,
        identity: options.operationIdentity,
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
}

export async function commitSkillExtractionProposal(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  preparedHandle: string;
}): Promise<Record<string, unknown>> {
  const key = skillProposalKey(options.identity);
  return withKeyedLock(SKILL_COMMIT_LOCK_KEY, async () => {
    const proposal = await options.kv.get<SkillExtractionProposal>(
      KV.skillExtractionProposals,
      key,
    );
    if (!proposal) {
      return { success: false, status: "failed", failure: { class: "hard", cause: "proposal_not_found" } };
    }
    if (
      proposal.inputHash !== options.identity.inputHash
      || proposal.handle !== options.preparedHandle
      || proposal.stage !== "skill_extract"
    ) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "proposal_identity_conflict" },
      };
    }
    if (proposal.status === "committed" && proposal.response) {
      return skillProposalResponse(proposal);
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
      await options.kv.set(KV.skillExtractionProposals, key, proposal);
    }

    const intent = proposal.commitIntent;
    const existing = await options.kv.get<ProceduralMemory>(KV.procedural, intent.resultId).catch(() => null);
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
    await options.kv.set(KV.skillExtractionProposals, key, proposal);
    return skillProposalResponse(proposal);
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
