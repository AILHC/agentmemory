import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
  MemoryProvider,
  SessionSummary,
  SemanticMemory,
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { parseFactResponse } from "../prompts/facts.js";
import {
  SEMANTIC_MERGE_OUTPUT_CONTRACT,
  SEMANTIC_MERGE_SYSTEM,
} from "../prompts/consolidation.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import {
  getSemanticRollupMaxPromptChars,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";
import {
  callProviderWithTelemetry,
  isProviderPreflightError,
  providerPreflightStatus,
  sortProviderCallTelemetry,
  type ProviderCallTelemetry,
} from "../providers/provider-call-result.js";
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";

const MAX_ROLLUP_SOURCE_IDS = 100;
const SEMANTIC_ROLLUP_COMMIT_SCHEMA = "semantic-rollup-commit/v1";
const SEMANTIC_ROLLUP_RECOVERY_SCHEMA = "semantic-rollup-recovery/v1";

type SemanticRollupHardFailureCause =
  | "configuration_identity_conflict"
  | "semantic_rollup_commit_conflict"
  | "semantic_rollup_recovery_identity_conflict"
  | "semantic_rollup_recovery_receipt_unavailable"
  | "semantic_rollup_runner_input_hash_conflict"
  | "semantic_rollup_source_summary_drifted";

interface SemanticRollupInput {
  runId?: unknown;
  windowId?: unknown;
  mark?: unknown;
  kind?: unknown;
  sessionIds?: unknown;
  semanticMemoryIds?: unknown;
  sourceSummaryHashes?: unknown;
  runnerInputHash?: unknown;
  recoveryIdentity?: unknown;
  model?: unknown;
}

interface SemanticRollupCommitIdentity {
  extractionRunId: string;
  extractionWindowId: string;
  inputHash: string;
  configHash: string;
}

interface ExpectedSemanticFact {
  id: string;
  fact: string;
  confidence: number;
}

interface SemanticRollupCommitPlan {
  identity: SemanticRollupCommitIdentity;
  expectedFacts: ExpectedSemanticFact[];
  effectHash: string;
}

interface SemanticRollupRecoveryIdentity extends SemanticRollupCommitIdentity {
  runId: string;
  unitId: string;
  receiptInputHash: string;
  runnerInputHash: string;
}

interface SemanticRollupRecoveryState {
  schema: typeof SEMANTIC_ROLLUP_RECOVERY_SCHEMA;
  phase: "staged" | "committed";
  identity: SemanticRollupRecoveryIdentity;
  mark: string;
  kind: "window";
  sessionIds: string[];
  sourceSummaryHashes: Record<string, string>;
  expectedFacts: ExpectedSemanticFact[];
  effectHash: string;
  result?: {
    receiptKey: string;
    receiptVersion: 1;
    resultRef: string;
    semanticMemoryIds: string[];
  };
}

type SemanticRecoveryReceipt = ExtractionOperationReceipt<Record<string, unknown>> & {
  semanticRecovery?: SemanticRollupRecoveryState;
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed && !strings.includes(trimmed)) strings.push(trimmed);
  }
  return strings;
}

function parseHashRecord(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length === 0
    || entries.some(([key, hash]) =>
      !key.trim()
      || typeof hash !== "string"
      || !/^[0-9a-f]{64}$/.test(hash.trim()))
  ) return null;
  return Object.fromEntries(entries.map(([key, hash]) => [key.trim(), (hash as string).trim()]));
}

function parseRecoveryIdentity(value: unknown): ExtractionOperationIdentity | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.stage !== "semantic_rollup"
    || typeof record.runId !== "string"
    || !record.runId
    || typeof record.unitId !== "string"
    || !record.unitId
    || typeof record.inputHash !== "string"
    || !/^[0-9a-f]{64}$/.test(record.inputHash)
  ) return null;
  return {
    runId: record.runId,
    stage: "semantic_rollup",
    unitId: record.unitId,
    inputHash: record.inputHash,
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
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

function summaryContentHash(summary: SessionSummary): string {
  return stableHash({
    title: summary.title || "",
    narrative: summary.narrative || "",
    keyDecisions: summary.keyDecisions || [],
    filesModified: summary.filesModified || [],
    concepts: summary.concepts || [],
  });
}

function exactHashRecord(
  sessionIds: string[],
  expected: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const selectedKeys = [...sessionIds].sort();
  return stableStringify(expectedKeys) === stableStringify(selectedKeys)
    && stableStringify(actualKeys) === stableStringify(selectedKeys)
    && sessionIds.every((sessionId) => expected[sessionId] === actual[sessionId]);
}

function runnerInputHashMatches(
  runnerInputHash: string,
  windowId: string,
  sessionIds: string[],
  sourceSummaryHashes: Record<string, string>,
): boolean {
  const sources = sessionIds.map((sessionId) => [sessionId, sourceSummaryHashes[sessionId]]);
  return runnerInputHash === stableHash(sources)
    || runnerInputHash === stableHash({ unitId: windowId, sources });
}

function semanticMemoryId(
  identity: SemanticRollupCommitIdentity,
  mark: string,
  kind: "window" | "corpus",
  fact: string,
): string {
  return fingerprintId("sem", stableStringify({
    runId: identity.extractionRunId,
    windowId: identity.extractionWindowId,
    mark,
    kind,
    inputHash: identity.inputHash,
    fact,
  }));
}

function normalizeExpectedFacts(
  facts: Array<{ fact: string; confidence: number }>,
  identity: SemanticRollupCommitIdentity,
  mark: string,
  kind: "window" | "corpus",
): ExpectedSemanticFact[] {
  const byFact = new Map<string, number>();
  for (const { fact, confidence } of facts) {
    const current = byFact.get(fact);
    if (current === undefined || confidence > current) byFact.set(fact, confidence);
  }
  return [...byFact.entries()].map(([fact, confidence]) => ({
    id: semanticMemoryId(identity, mark, kind, fact),
    fact,
    confidence,
  }));
}

function buildCommitPlan(
  identity: SemanticRollupCommitIdentity,
  facts: ExpectedSemanticFact[],
): SemanticRollupCommitPlan {
  return {
    identity,
    expectedFacts: facts,
    effectHash: stableHash({ identity, expectedFacts: facts }),
  };
}

function isCommitIdentity(value: unknown): value is SemanticRollupCommitIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return [
    "extractionRunId",
    "extractionWindowId",
    "inputHash",
    "configHash",
  ].every((key) => typeof identity[key] === "string" && identity[key].length > 0);
}

function readCommitAudit(entry: {
  operation?: unknown;
  functionId?: unknown;
  targetIds?: unknown;
  details?: unknown;
}): { phase: "prepared" | "committed"; plan: SemanticRollupCommitPlan } | null {
  if (entry.operation !== "semantic_rollup" || entry.functionId !== "mem::semantic-rollup") {
    return null;
  }
  const container = entry.details as Record<string, unknown> | null;
  const value = container?.semanticRollupCommit;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== SEMANTIC_ROLLUP_COMMIT_SCHEMA
    || (record.phase !== "prepared" && record.phase !== "committed")
    || !isCommitIdentity(record.identity)
    || !Array.isArray(record.expectedFacts)
    || !/^[0-9a-f]{64}$/.test(String(record.effectHash ?? ""))
  ) return null;
  const identity = record.identity;
  const expectedFacts: ExpectedSemanticFact[] = [];
  const ids = new Set<string>();
  for (const item of record.expectedFacts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const fact = item as Record<string, unknown>;
    if (
      typeof fact.id !== "string"
      || typeof fact.fact !== "string"
      || !fact.fact
      || typeof fact.confidence !== "number"
      || !Number.isFinite(fact.confidence)
      || fact.confidence < 0
      || fact.confidence > 1
      || ids.has(fact.id)
    ) return null;
    ids.add(fact.id);
    expectedFacts.push({ id: fact.id, fact: fact.fact, confidence: fact.confidence });
  }
  const plan = buildCommitPlan(identity, expectedFacts);
  if (plan.effectHash !== record.effectHash) return null;
  if (record.phase === "committed") {
    if (!Array.isArray(entry.targetIds) || stableStringify(entry.targetIds) !== stableStringify(expectedFacts.map((fact) => fact.id))) {
      return null;
    }
  }
  return { phase: record.phase, plan };
}

function sameCommitIdentity(
  left: SemanticRollupCommitIdentity,
  right: SemanticRollupCommitIdentity,
): boolean {
  return left.extractionRunId === right.extractionRunId
    && left.extractionWindowId === right.extractionWindowId
    && left.inputHash === right.inputHash
    && left.configHash === right.configHash;
}

function semanticRecoveryIdentity(
  commitIdentity: SemanticRollupCommitIdentity,
  recoveryIdentity: ExtractionOperationIdentity,
  runnerInputHash: string,
): SemanticRollupRecoveryIdentity {
  return {
    runId: recoveryIdentity.runId,
    unitId: recoveryIdentity.unitId,
    receiptInputHash: recoveryIdentity.inputHash,
    runnerInputHash,
    ...commitIdentity,
  };
}

function recoveryCommitIdentity(
  identity: SemanticRollupRecoveryIdentity,
): SemanticRollupCommitIdentity {
  return {
    extractionRunId: identity.extractionRunId,
    extractionWindowId: identity.extractionWindowId,
    inputHash: identity.inputHash,
    configHash: identity.configHash,
  };
}

function sameRecoveryIdentity(
  left: SemanticRollupRecoveryIdentity,
  right: SemanticRollupRecoveryIdentity,
): boolean {
  return left.runId === right.runId
    && left.unitId === right.unitId
    && left.receiptInputHash === right.receiptInputHash
    && left.runnerInputHash === right.runnerInputHash
    && sameCommitIdentity(recoveryCommitIdentity(left), recoveryCommitIdentity(right));
}

function validateRecoveryState(
  recovery: SemanticRollupRecoveryState,
  identity: SemanticRollupRecoveryIdentity,
  mark: string,
  sessionIds: string[],
  sourceSummaryHashes: Record<string, string>,
): SemanticRollupCommitPlan | null {
  if (
    !recovery
    || typeof recovery !== "object"
    || Array.isArray(recovery)
    || !recovery.identity
    || typeof recovery.identity !== "object"
    || Array.isArray(recovery.identity)
    || recovery.schema !== SEMANTIC_ROLLUP_RECOVERY_SCHEMA
    || (recovery.phase !== "staged" && recovery.phase !== "committed")
    || !sameRecoveryIdentity(recovery.identity, identity)
    || recovery.mark !== mark
    || recovery.kind !== "window"
    || stableStringify(recovery.sessionIds) !== stableStringify(sessionIds)
    || stableStringify(recovery.sourceSummaryHashes) !== stableStringify(sourceSummaryHashes)
    || !Array.isArray(recovery.expectedFacts)
  ) return null;
  const ids = new Set<string>();
  for (const fact of recovery.expectedFacts) {
    if (
      !fact
      || typeof fact.id !== "string"
      || typeof fact.fact !== "string"
      || !fact.fact
      || typeof fact.confidence !== "number"
      || !Number.isFinite(fact.confidence)
      || fact.confidence < 0
      || fact.confidence > 1
      || ids.has(fact.id)
      || fact.id !== semanticMemoryId(
        recoveryCommitIdentity(identity),
        mark,
        "window",
        fact.fact,
      )
    ) return null;
    ids.add(fact.id);
  }
  const plan = buildCommitPlan(recoveryCommitIdentity(identity), recovery.expectedFacts);
  if (plan.effectHash !== recovery.effectHash) return null;
  if (recovery.phase === "committed") {
    if (
      !recovery.result
      || typeof recovery.result.receiptKey !== "string"
      || !recovery.result.receiptKey
      || recovery.result.receiptVersion !== 1
      || recovery.result.resultRef !== `mem:audit:${recovery.result.receiptKey}`
      || stableStringify(recovery.result.semanticMemoryIds)
        !== stableStringify(plan.expectedFacts.map((fact) => fact.id))
    ) return null;
  }
  return plan;
}

async function readSemanticRecoveryReceipt(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
): Promise<SemanticRecoveryReceipt | null> {
  const key = buildExtractionOperationKey(identity);
  return kv.get<SemanticRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
}

function semanticRecoveryReceiptMatches(
  receipt: SemanticRecoveryReceipt,
  identity: ExtractionOperationIdentity,
): boolean {
  return receipt.key === buildExtractionOperationKey(identity)
    && receipt.version === 1
    && receipt.runId === identity.runId
    && receipt.stage === "semantic_rollup"
    && receipt.unitId === identity.unitId
    && receipt.inputHash === identity.inputHash
    && (receipt.status === "running" || receipt.status === "succeeded");
}

function semanticMemoryMatchesPlan(
  memory: SemanticMemory,
  expected: ExpectedSemanticFact,
  identity: SemanticRollupCommitIdentity,
  mark: string,
  kind: "window" | "corpus",
  sourceSessionIds: string[],
): boolean {
  return memory.id === expected.id
    && memory.fact === expected.fact
    && memory.confidence === expected.confidence
    && memory.extractionRunId === identity.extractionRunId
    && memory.extractionWindowId === identity.extractionWindowId
    && memory.extractionMark === mark
    && memory.extractionInputHash === identity.inputHash
    && memory.extractionKind === kind
    && stableStringify(memory.sourceSessionIds) === stableStringify(sourceSessionIds)
    && stableStringify(memory.sourceMemoryIds) === stableStringify([]);
}

function buildWindowPrompt(summaries: SessionSummary[]): string {
  const input = summaries
    .map((summary, index) =>
      [
        `[Summary ${index + 1}]`,
        `Session: ${summary.sessionId}`,
        `Title: ${summary.title}`,
        `Narrative: ${summary.narrative}`,
        `Key decisions: ${summary.keyDecisions.join("; ")}`,
        `Concepts: ${summary.concepts.join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n");
  return `Extract durable semantic facts from these session summaries:\n\n${input}`;
}

function failureDetails(
  error: string,
  runId: string,
  windowId: string,
  mark: string,
  kind: "window" | "corpus",
  inputHash: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: false,
    error,
    runId,
    windowId,
    mark,
    kind,
    inputHash,
    ...details,
  };
}

function hardFailureDetails(
  cause: SemanticRollupHardFailureCause,
  runId: string,
  windowId: string,
  mark: string,
  kind: "window" | "corpus",
  inputHash: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...failureDetails(cause, runId, windowId, mark, kind, inputHash, details),
    failure: {
      class: "hard",
      cause,
    },
  };
}

export function registerSemanticRollupFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::semantic-rollup", async (data: SemanticRollupInput) => {
    const startMs = Date.now();
    const telemetry: ProviderCallTelemetry[] = [];
    const runId = asTrimmedString(data?.runId);
    const windowId = asTrimmedString(data?.windowId);
    const mark = asTrimmedString(data?.mark);
    const kind = data?.kind === "window" || data?.kind === "corpus" ? data.kind : null;
    if (!runId || !windowId || !mark || !kind) {
      return {
        success: false,
        error: "runId, windowId, mark, and kind are required",
      };
    }
    if (kind === "corpus") {
      return {
        success: false,
        error: "kind corpus is not supported; use kind window",
        runId,
        windowId,
        mark,
        kind,
        inputHash: stableHash({ kind, mark, windowId, semanticMemoryIds: data.semanticMemoryIds }),
      };
    }

    const sessionIds = parseStringArray(data.sessionIds);
    const semanticMemoryIds = parseStringArray(data.semanticMemoryIds);
    const sourceSummaryHashes = parseHashRecord(data.sourceSummaryHashes);
    const runnerInputHash = asTrimmedString(data.runnerInputHash);
    const recoveryIdentity = parseRecoveryIdentity(data.recoveryIdentity);
    const requestHash = stableHash({
      kind,
      mark,
      windowId,
      sessionIds: kind === "window" ? sessionIds : undefined,
      semanticMemoryIds: undefined,
      sourceSummaryHashes,
      runnerInputHash,
    });
    if (sessionIds === null || semanticMemoryIds === null) {
      return failureDetails(
        "sessionIds and semanticMemoryIds must be string arrays",
        runId,
        windowId,
        mark,
        kind,
        requestHash,
      );
    }
    if (sourceSummaryHashes === null || recoveryIdentity === null) {
      return failureDetails(
        "invalid_semantic_rollup_recovery_binding",
        runId,
        windowId,
        mark,
        kind,
        requestHash,
      );
    }
    if (kind === "window" && (!sessionIds || sessionIds.length === 0)) {
      return failureDetails("sessionIds is required for window rollup", runId, windowId, mark, kind, requestHash);
    }
    const hasRecoveryBinding = recoveryIdentity !== undefined
      || sourceSummaryHashes !== undefined
      || runnerInputHash !== null;
    if (
      hasRecoveryBinding
      && (
        !recoveryIdentity
        || !sourceSummaryHashes
        || !runnerInputHash
        || !/^[0-9a-f]{64}$/.test(runnerInputHash)
        || recoveryIdentity.runId !== runId
        || recoveryIdentity.unitId !== windowId
      )
    ) {
      return hardFailureDetails(
        "semantic_rollup_recovery_identity_conflict",
        runId,
        windowId,
        mark,
        kind,
        requestHash,
      );
    }
    const sourceIds = sessionIds!;
    if (sourceIds.length > MAX_ROLLUP_SOURCE_IDS) {
      return failureDetails("input_too_large", runId, windowId, mark, kind, requestHash, {
        sourceIds: sourceIds.length,
        maxSourceIds: MAX_ROLLUP_SOURCE_IDS,
      });
    }

    const missingSessionIds: string[] = [];
    const missingSemanticMemoryIds: string[] = [];
    let summaries: SessionSummary[] = [];

    summaries = await Promise.all(
      sessionIds!.map(async (sessionId) => {
        const summary = await kv.get<SessionSummary>(KV.summaries, sessionId);
        if (!summary) missingSessionIds.push(sessionId);
        return summary;
      }),
    ).then((items) => items.filter((item): item is SessionSummary => item !== null));

    if (missingSessionIds.length > 0 || missingSemanticMemoryIds.length > 0) {
      return failureDetails("missing_sources", runId, windowId, mark, kind, requestHash, {
        missingSessionIds,
        missingSemanticMemoryIds,
      });
    }

    const currentSummaryHashes = Object.fromEntries(
      summaries.map((summary) => [summary.sessionId, summaryContentHash(summary)]),
    );
    if (
      sourceSummaryHashes
      && !exactHashRecord(sessionIds!, sourceSummaryHashes, currentSummaryHashes)
    ) {
      return hardFailureDetails(
        "semantic_rollup_source_summary_drifted",
        runId,
        windowId,
        mark,
        kind,
        requestHash,
      );
    }
    if (
      runnerInputHash
      && sourceSummaryHashes
      && !runnerInputHashMatches(
        runnerInputHash,
        windowId,
        sessionIds!,
        sourceSummaryHashes,
      )
    ) {
      return hardFailureDetails(
        "semantic_rollup_runner_input_hash_conflict",
        runId,
        windowId,
        mark,
        kind,
        requestHash,
      );
    }

    const inputHash = stableHash({
      kind,
      mark,
      windowId,
      sessionIds: kind === "window" ? sessionIds : undefined,
      semanticMemoryIds: undefined,
      summaries: summaries.map((summary) => ({
        sessionId: summary.sessionId,
        title: summary.title,
        narrative: summary.narrative,
        keyDecisions: summary.keyDecisions,
        filesModified: summary.filesModified,
        concepts: summary.concepts,
      })),
      semanticSources: [],
    });

    const prompt = buildWindowPrompt(summaries);
    const charBudget = getSemanticRollupMaxPromptChars();
    const stageMetadata = resolveStageModelMetadata(
      "semantic_rollup",
      provider,
      asTrimmedString(data.model) ?? undefined,
    );
    const callOptions = resolveStageModelCallOptions(
      "semantic_rollup",
      asTrimmedString(data.model) ?? undefined,
    );
    const configHash = stableHash({
      stage: "semantic_rollup",
      provider: stageMetadata.provider,
      model: stageMetadata.model,
      modelSource: stageMetadata.modelSource,
      modelApplied: stageMetadata.modelApplied,
      charBudget,
      callOptions,
    });
    const commitIdentity: SemanticRollupCommitIdentity = {
      extractionRunId: runId,
      extractionWindowId: windowId,
      inputHash,
      configHash,
    };
    const recoveryPlanIdentity = recoveryIdentity && runnerInputHash
      ? semanticRecoveryIdentity(commitIdentity, recoveryIdentity, runnerInputHash)
      : null;
    const responseMetadata = (status: string, extra: Record<string, unknown> = {}) => ({
      status,
      ...stageMetadata,
      configHash,
      promptChars: prompt.length,
      charBudget,
      durationMs: Date.now() - startMs,
      parseFailures: 0,
      telemetry: sortProviderCallTelemetry(telemetry),
      ...extra,
    });
    if (prompt.length > charBudget) {
      return failureDetails("input_too_large", runId, windowId, mark, kind, inputHash, {
        maxPromptChars: charBudget,
        ...responseMetadata("failed"),
      });
    }

    return withKeyedLock(
      `semantic-rollup:${stableHash(commitIdentity)}`,
      async () => {
        const [auditEntries, semanticMemories, outerReceipt] = await Promise.all([
          kv.list<{ operation?: unknown; functionId?: unknown; targetIds?: unknown; details?: unknown; id?: unknown }>(KV.audit),
          kv.list<SemanticMemory>(KV.semantic),
          recoveryIdentity
            ? readSemanticRecoveryReceipt(kv, recoveryIdentity)
            : Promise.resolve(null),
        ]);
        let plan: SemanticRollupCommitPlan | null = null;
        let committedAuditId: string | null = null;
        for (const entry of auditEntries) {
          const recovered = readCommitAudit(entry);
          if (!recovered) continue;
          const candidate = recovered.plan;
          if (
            candidate.identity.extractionRunId === runId
            && candidate.identity.extractionWindowId === windowId
            && candidate.identity.inputHash === inputHash
            && candidate.identity.configHash !== configHash
          ) {
            return hardFailureDetails(
              "configuration_identity_conflict",
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              responseMetadata("failed", { configHash }),
            );
          }
          if (!sameCommitIdentity(candidate.identity, commitIdentity)) continue;
          if (plan && plan.effectHash !== candidate.effectHash) {
            return hardFailureDetails(
              "semantic_rollup_commit_conflict",
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              responseMetadata("failed", { configHash }),
            );
          }
          plan = candidate;
          if (recovered.phase === "committed" && typeof entry.id === "string") {
            committedAuditId = entry.id;
          }
        }

        if (recoveryIdentity && recoveryPlanIdentity && sourceSummaryHashes) {
          if (!outerReceipt || !semanticRecoveryReceiptMatches(outerReceipt, recoveryIdentity)) {
            return hardFailureDetails(
              "semantic_rollup_recovery_receipt_unavailable",
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              responseMetadata("reconciliation_required", { configHash }),
            );
          }
          if (outerReceipt.semanticRecovery) {
            const recoveredPlan = validateRecoveryState(
              outerReceipt.semanticRecovery,
              recoveryPlanIdentity,
              mark,
              sessionIds!,
              sourceSummaryHashes,
            );
            if (!recoveredPlan || (plan && plan.effectHash !== recoveredPlan.effectHash)) {
              return hardFailureDetails(
                "semantic_rollup_commit_conflict",
                runId,
                windowId,
                mark,
                kind,
                inputHash,
                responseMetadata("failed", { configHash }),
              );
            }
            plan = recoveredPlan;
            if (outerReceipt.semanticRecovery.phase === "committed") {
              const recoveryAuditId = outerReceipt.semanticRecovery.result!.receiptKey;
              if (committedAuditId !== recoveryAuditId) {
                return hardFailureDetails(
                  "semantic_rollup_commit_conflict",
                  runId,
                  windowId,
                  mark,
                  kind,
                  inputHash,
                  responseMetadata("failed", { configHash }),
                );
              }
            }
          } else if (outerReceipt.status !== "running" || plan) {
            return failureDetails(
              "semantic_rollup_reconciliation_required",
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              responseMetadata("reconciliation_required", { configHash }),
            );
          }
        }

        const legacyMemories = semanticMemories.filter((memory) =>
          memory.extractionRunId === runId
          && memory.extractionWindowId === windowId
          && memory.extractionMark === mark
          && memory.extractionKind === kind
          && memory.extractionInputHash === inputHash,
        );
        if (!plan && legacyMemories.length > 0) {
          return failureDetails(
            "semantic_rollup_reconciliation_required",
            runId,
            windowId,
            mark,
            kind,
            inputHash,
            responseMetadata("reconciliation_required", { configHash }),
          );
        }
        if (recoveryIdentity && outerReceipt && !outerReceipt.semanticRecovery && legacyMemories.length > 0) {
          return failureDetails(
            "semantic_rollup_reconciliation_required",
            runId,
            windowId,
            mark,
            kind,
            inputHash,
            responseMetadata("reconciliation_required", { configHash }),
          );
        }

        let facts: Array<{ fact: string; confidence: number }>;
        if (!plan) {
          let response: string;
          try {
            const systemPrompt = withOutputLanguagePolicy(
              SEMANTIC_MERGE_SYSTEM,
              undefined,
              { semantic: [...(SEMANTIC_MERGE_OUTPUT_CONTRACT.semantic ?? [])] },
            );
            response = await callProviderWithTelemetry({
              provider,
              operation: "summarize",
              callRole: "window",
              callIndex: 0,
              systemPrompt,
              userPrompt: prompt,
              callOptions,
              telemetry,
            });
          } catch (error) {
            if (isProviderPreflightError(error)) {
              const status = providerPreflightStatus(error);
              return failureDetails(status, runId, windowId, mark, kind, inputHash, responseMetadata(status));
            }
            return failureDetails("provider_error", runId, windowId, mark, kind, inputHash, responseMetadata("failed"));
          }
          facts = parseFactResponse(response);
          if (facts.length === 0) {
            return failureDetails("empty_facts", runId, windowId, mark, kind, inputHash, responseMetadata("failed", { parseFailures: 1 }));
          }
          const expectedFacts = normalizeExpectedFacts(facts, commitIdentity, mark, kind);
          plan = buildCommitPlan(commitIdentity, expectedFacts);
          facts = expectedFacts.map(({ fact, confidence }) => ({ fact, confidence }));
          if (
            recoveryIdentity
            && recoveryPlanIdentity
            && sourceSummaryHashes
            && outerReceipt
          ) {
            const stagedRecovery: SemanticRollupRecoveryState = {
              schema: SEMANTIC_ROLLUP_RECOVERY_SCHEMA,
              phase: "staged",
              identity: recoveryPlanIdentity,
              mark,
              kind: "window",
              sessionIds: [...sessionIds!],
              sourceSummaryHashes: { ...sourceSummaryHashes },
              expectedFacts: plan.expectedFacts.map((fact) => ({ ...fact })),
              effectHash: plan.effectHash,
            };
            await kv.set(
              KV.extractionOperationReceipt(outerReceipt.key),
              outerReceipt.key,
              { ...outerReceipt, semanticRecovery: stagedRecovery },
            );
          }
          await recordAudit(
            kv,
            "semantic_rollup",
            "mem::semantic-rollup",
            expectedFacts.map((fact) => fact.id),
            {
              semanticRollupCommit: {
                schema: SEMANTIC_ROLLUP_COMMIT_SCHEMA,
                phase: "prepared",
                identity: plan.identity,
                expectedFacts: plan.expectedFacts,
                effectHash: plan.effectHash,
              },
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              configHash,
              facts: expectedFacts.length,
            },
          );
        } else {
          facts = plan.expectedFacts.map(({ fact, confidence }) => ({ fact, confidence }));
        }

        const now = new Date().toISOString();
        const sourceSessionIds = sessionIds!;
        const sourceMemoryIds: string[] = [];
        const missingExpectedIds: string[] = [];
        for (const expected of plan.expectedFacts) {
          const existing = await kv.get<SemanticMemory>(KV.semantic, expected.id);
          if (!existing) missingExpectedIds.push(expected.id);
          else if (!semanticMemoryMatchesPlan(
            existing,
            expected,
            commitIdentity,
            mark,
            kind,
            sessionIds!,
          )) {
            return hardFailureDetails(
              "semantic_rollup_commit_conflict",
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              responseMetadata("failed", { configHash }),
            );
          }
        }
        for (const expected of plan.expectedFacts) {
          const existing = await kv.get<SemanticMemory>(KV.semantic, expected.id);
          if (existing) {
            continue;
          }
          await kv.set(KV.semantic, expected.id, {
            id: expected.id,
            fact: expected.fact,
            confidence: expected.confidence,
            sourceSessionIds,
            sourceMemoryIds,
            extractionRunId: runId,
            extractionWindowId: windowId,
            extractionMark: mark,
            extractionInputHash: inputHash,
            extractionKind: kind,
            accessCount: 1,
            lastAccessedAt: now,
            strength: expected.confidence,
            createdAt: now,
            updatedAt: now,
          } satisfies SemanticMemory);
        }

        let commitAuditId = committedAuditId;
        if (!commitAuditId) {
          const committed = await recordAudit(
            kv,
            "semantic_rollup",
            "mem::semantic-rollup",
            plan.expectedFacts.map((fact) => fact.id),
            {
              semanticRollupCommit: {
                schema: SEMANTIC_ROLLUP_COMMIT_SCHEMA,
                phase: "committed",
                identity: plan.identity,
                expectedFacts: plan.expectedFacts,
                effectHash: plan.effectHash,
              },
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              configHash,
              facts: plan.expectedFacts.length,
            },
          );
          commitAuditId = committed.id;
        }

        let semanticRecoveryEvidence: Record<string, unknown>;
        if (
          recoveryIdentity
          && recoveryPlanIdentity
          && sourceSummaryHashes
        ) {
          const latestReceipt = await readSemanticRecoveryReceipt(kv, recoveryIdentity);
          const currentRecovery = latestReceipt?.semanticRecovery;
          const currentPlan = currentRecovery
            ? validateRecoveryState(
                currentRecovery,
                recoveryPlanIdentity,
                mark,
                sessionIds!,
                sourceSummaryHashes,
              )
            : null;
          if (
            !latestReceipt
            || !semanticRecoveryReceiptMatches(latestReceipt, recoveryIdentity)
            || !currentRecovery
            || !currentPlan
            || currentPlan.effectHash !== plan.effectHash
          ) {
            return hardFailureDetails(
              "semantic_rollup_commit_conflict",
              runId,
              windowId,
              mark,
              kind,
              inputHash,
              responseMetadata("failed", { configHash }),
            );
          }
          const result = {
            receiptKey: commitAuditId,
            receiptVersion: 1 as const,
            resultRef: `mem:audit:${commitAuditId}`,
            semanticMemoryIds: plan.expectedFacts.map((fact) => fact.id),
          };
          const committedRecovery: SemanticRollupRecoveryState = {
            ...currentRecovery,
            phase: "committed",
            result,
          };
          await kv.set(
            KV.extractionOperationReceipt(latestReceipt.key),
            latestReceipt.key,
            { ...latestReceipt, semanticRecovery: committedRecovery },
          );
          semanticRecoveryEvidence = {
            schema: SEMANTIC_ROLLUP_RECOVERY_SCHEMA,
            phase: "committed",
            receiptKey: latestReceipt.key,
            receiptVersion: latestReceipt.version ?? 1,
            resultRef: result.resultRef,
            effectHash: plan.effectHash,
            identity: recoveryPlanIdentity,
            sourceSummaryHashes,
          };
        } else {
          semanticRecoveryEvidence = {
            schema: SEMANTIC_ROLLUP_COMMIT_SCHEMA,
            kind: "committed",
            receiptKey: commitAuditId,
            receiptVersion: 1,
            resultRef: `mem:audit:${commitAuditId}`,
            effectHash: plan.effectHash,
            identity: plan.identity,
          };
        }

        return {
          success: true,
          runId,
          windowId,
          semanticMemoryIds: plan.expectedFacts.map((fact) => fact.id),
          semanticMemoryCharSizes: Object.fromEntries(
            plan.expectedFacts.map((fact) => [fact.id, fact.fact.length]),
          ),
          inputHash,
          ...responseMetadata("succeeded", {
            reused: committedAuditId !== null && missingExpectedIds.length === 0,
            resumed: missingExpectedIds.length > 0,
            semanticRecoveryEvidence,
          }),
          facts,
        };
      },
    );
  });
}
