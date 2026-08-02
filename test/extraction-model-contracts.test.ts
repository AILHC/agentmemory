import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SUMMARY_CONTRIBUTION_CONTRACT,
  parseSummaryXml,
} from "../src/functions/summarize.js";
import { LESSONS_CONTRIBUTION_CONTRACT } from "../src/functions/lessons.js";
import {
  CONSOLIDATION_SYSTEM,
  MEMORY_CONSOLIDATE_CONTRACT_VERSION,
  parseMemoryProviderResponse,
} from "../src/functions/consolidate.js";
import {
  SEMANTIC_ROLLUP_CONTRIBUTION_CONTRACT,
} from "../src/functions/semantic-rollup.js";
import {
  SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
  SKILL_EXTRACT_SYSTEM,
  isStrictNoSkillResponse,
  parseSkillXml,
} from "../src/functions/skill-extract.js";
import {
  CRYSTAL_CONTRIBUTION_CONTRACT,
  CRYSTALLIZE_SYSTEM,
  parseDigestStrict,
} from "../src/functions/crystallize.js";
import {
  CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
  parseProceduralRecoveryResponse,
} from "../src/functions/consolidation-pipeline.js";
import {
  REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
  parseReflectInsightResponse,
} from "../src/functions/reflect.js";
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  inspectContributionCandidates,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
} from "../src/functions/extraction-contributions.js";
import {
  REDUCE_SYSTEM,
  SUMMARY_OUTPUT_CONTRACT,
  SUMMARY_SYSTEM,
} from "../src/prompts/summary.js";
import {
  LESSON_EXTRACTION_OUTPUT_CONTRACT,
  LESSON_EXTRACTION_SYSTEM,
  parseLessonExtractionXmlWithRootRecovery,
} from "../src/prompts/lesson-extraction.js";
import {
  PROCEDURAL_EXTRACTION_SYSTEM,
  SEMANTIC_MERGE_OUTPUT_CONTRACT,
  SEMANTIC_MERGE_SYSTEM,
} from "../src/prompts/consolidation.js";
import { parseFactResponse } from "../src/prompts/facts.js";
import {
  REFLECT_OUTPUT_CONTRACT,
  REFLECT_SYSTEM,
} from "../src/prompts/reflect.js";
import { withOutputLanguagePolicy } from "../src/prompts/output-language.js";
import { KV } from "../src/state/schema.js";
import type { ExtractionOperationStage } from "../src/types.js";

type ContractEntry = {
  stage: ExtractionOperationStage;
  compatible_with: string[];
  model: string;
  prompt_hash: string;
};

const contracts = JSON.parse(fs.readFileSync(
  new URL("../ops/scripts/extraction-model-contracts-v1.json", import.meta.url),
  "utf8",
)) as {
  schema_version: number;
  compatibility_basis: string;
  audit_only_fields: string[];
  output_language: string;
  stages: ContractEntry[];
};

const contractVersions: Record<ExtractionOperationStage, string> = {
  summary: SUMMARY_CONTRIBUTION_CONTRACT,
  lessons: LESSONS_CONTRIBUTION_CONTRACT,
  memory_consolidate: MEMORY_CONSOLIDATE_CONTRACT_VERSION,
  semantic_rollup: SEMANTIC_ROLLUP_CONTRIBUTION_CONTRACT,
  skill_extract: SKILL_EXTRACT_CONTRIBUTION_CONTRACT,
  crystal: CRYSTAL_CONTRIBUTION_CONTRACT,
  consolidation_procedural: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
  reflect_insight: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
};

const deployedModels: Record<ExtractionOperationStage, string> = {
  summary: "gpt-5.6-luna",
  lessons: "gpt-5.6-luna",
  memory_consolidate: "gpt-5.6-luna",
  semantic_rollup: "gpt-5.6-terra",
  skill_extract: "gpt-5.6-luna",
  crystal: "gpt-5.6-luna",
  consolidation_procedural: "gpt-5.6-terra",
  reflect_insight: "gpt-5.6-terra",
};

const zhCn = { AGENTMEMORY_OUTPUT_LANGUAGE: "zh-CN" };
const promptInputs: Record<ExtractionOperationStage, unknown> = {
  summary: {
    map: withOutputLanguagePolicy(SUMMARY_SYSTEM, zhCn, SUMMARY_OUTPUT_CONTRACT),
    reduce: withOutputLanguagePolicy(REDUCE_SYSTEM, zhCn, SUMMARY_OUTPUT_CONTRACT),
  },
  lessons: withOutputLanguagePolicy(
    LESSON_EXTRACTION_SYSTEM,
    zhCn,
    LESSON_EXTRACTION_OUTPUT_CONTRACT,
  ),
  memory_consolidate: withOutputLanguagePolicy(CONSOLIDATION_SYSTEM, zhCn),
  semantic_rollup: withOutputLanguagePolicy(
    SEMANTIC_MERGE_SYSTEM,
    zhCn,
    SEMANTIC_MERGE_OUTPUT_CONTRACT,
  ),
  skill_extract: withOutputLanguagePolicy(SKILL_EXTRACT_SYSTEM, zhCn),
  crystal: withOutputLanguagePolicy(CRYSTALLIZE_SYSTEM, zhCn),
  consolidation_procedural: withOutputLanguagePolicy(PROCEDURAL_EXTRACTION_SYSTEM, zhCn),
  reflect_insight: withOutputLanguagePolicy(REFLECT_SYSTEM, zhCn, REFLECT_OUTPUT_CONTRACT),
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjection);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "createdAt")
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableProjection(entry)]));
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<boolean> =>
      store.get(scope)?.delete(key) ?? false,
    list: async <T>(scope: string): Promise<T[]> =>
      [...(store.get(scope)?.values() ?? [])] as T[],
  };
}

const parserFixtures: Array<{
  stage: ExtractionOperationStage;
  success: () => unknown;
  invalidRejected: () => boolean;
  modelLegalEmpty?: () => unknown;
}> = [
  {
    stage: "summary",
    success: () => parseSummaryXml(
      "<summary><title>合同摘要</title><narrative>稳定输出。</narrative><decisions><decision>保持合同</decision></decisions><files><file>src/a.ts</file></files><concepts><concept>contract</concept></concepts></summary>",
      "session-contract",
      "project-contract",
      3,
    ),
    invalidRejected: () => parseSummaryXml(
      "<summary><title>truncated",
      "session-contract",
      "project-contract",
      3,
    ) === null,
  },
  {
    stage: "lessons",
    success: () => parseLessonExtractionXmlWithRootRecovery(
      "<lessons><lesson confidence=\"0.9\" importance=\"0.8\"><content>先验证合同。</content><context>切换模型时。</context><evidence>固定夹具</evidence><tags><tag>contract</tag></tags></lesson></lessons>",
    ),
    invalidRejected: () => {
      try {
        parseLessonExtractionXmlWithRootRecovery("<lessons><lesson>truncated");
        return false;
      } catch {
        return true;
      }
    },
  },
  {
    stage: "memory_consolidate",
    success: () => parseMemoryProviderResponse(
      "<memory><type>workflow</type><title>合同化切换</title><content>只处理新来源。</content><concepts><concept>contract</concept></concepts><files><file>src/a.ts</file></files><strength>8</strength></memory>",
      ["session-contract"],
      true,
    ),
    invalidRejected: () => parseMemoryProviderResponse(
      "<memory><type>fact</type><title>mixed</title><content>x</content></memory><no_effect><reason_code>no_durable_memory</reason_code></no_effect>",
      ["session-contract"],
      true,
    ) === null,
    modelLegalEmpty: () => parseMemoryProviderResponse(
      "<no_effect><reason_code>no_durable_memory</reason_code></no_effect>",
      ["session-contract"],
      true,
    ),
  },
  {
    stage: "semantic_rollup",
    success: () => parseFactResponse(
      "<facts><fact confidence=\"0.9\">合同兼容时只处理新摘要。</fact></facts>",
    ),
    invalidRejected: () => parseFactResponse("<facts><fact confidence=\"0.9\">truncated").length === 0,
  },
  {
    stage: "skill_extract",
    success: () => parseSkillXml(
      "<skill><trigger>模型切换前</trigger><title>验证合同</title><steps><step>运行固定夹具</step><step>核对业务效果</step></steps><expected_outcome>兼容</expected_outcome><tags>contract,model</tags></skill>",
    ),
    invalidRejected: () => parseSkillXml(
      "<skill><trigger>x</trigger><title>y</title><steps><step>only one</step></steps></skill>",
    ) === null,
    modelLegalEmpty: () => isStrictNoSkillResponse("<no-skill/>")
      ? { kind: "no_effect", reasonCode: "no_reusable_skill" }
      : null,
  },
  {
    stage: "crystal",
    success: () => parseDigestStrict(JSON.stringify({
      narrative: "完成合同验证。",
      keyOutcomes: ["稳定身份"],
      filesAffected: ["src/a.ts"],
      lessons: ["不重开历史贡献"],
    })),
    invalidRejected: () => parseDigestStrict('{"narrative":"truncated"') === null,
  },
  {
    stage: "consolidation_procedural",
    success: () => parseProceduralRecoveryResponse(
      "<procedures><procedure name=\"合同验证\" trigger=\"模型切换时\"><step>运行夹具</step><step>检查效果引用</step></procedure></procedures>",
    ),
    invalidRejected: () => parseProceduralRecoveryResponse(
      "<procedures><procedure name=\"cut\" trigger=\"x\"><step>one</step>",
    ) === null,
    modelLegalEmpty: () => parseProceduralRecoveryResponse("<procedures></procedures>"),
  },
  {
    stage: "reflect_insight",
    success: () => parseReflectInsightResponse(
      "<insights><insight confidence=\"0.9\" title=\"兼容切换\">模型身份与贡献身份必须解耦。</insight></insights>",
      3,
    ),
    invalidRejected: () => {
      try {
        parseReflectInsightResponse("<insights><insight confidence=\"0.9\" title=\"cut\">x", 3);
        return false;
      } catch {
        return true;
      }
    },
    modelLegalEmpty: () => parseReflectInsightResponse("<insights></insights>", 3),
  },
];

describe("eight-stage extraction model contracts", () => {
  it("pins the deployed model and rendered system-prompt hash without changing contract identity", () => {
    expect(contracts).toMatchObject({
      schema_version: 1,
      compatibility_basis: "compatible_with_only",
      audit_only_fields: ["model", "prompt_hash"],
      output_language: "zh-CN",
    });
    expect(contracts.stages.map(({ stage }) => stage)).toEqual(Object.keys(contractVersions));
    for (const entry of contracts.stages) {
      expect(entry.compatible_with).toEqual([contractVersions[entry.stage]]);
      expect(entry.model).toBe(deployedModels[entry.stage]);
      expect(entry.prompt_hash).toBe(sha256(promptInputs[entry.stage]));
    }
    expect(contracts.stages.filter(({ model }) => model === "gpt-5.6-luna")
      .map(({ stage }) => stage)).toEqual([
      "summary",
      "lessons",
      "memory_consolidate",
      "skill_extract",
      "crystal",
    ]);
    expect(contracts.stages.some(({ model }) => model.includes("5.4-mini"))).toBe(false);
    const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(envExample).toContain("AGENTMEMORY_SUMMARY_MODEL=gpt-5.6-luna");
    expect(envExample).toContain("AGENTMEMORY_LESSON_MODEL=gpt-5.6-luna");
    expect(envExample).toContain("AGENTMEMORY_CRYSTAL_MODEL=gpt-5.6-luna");
  });

  for (const fixture of parserFixtures) {
    it(`${fixture.stage} accepts its fixed structured output and rejects a truncated contract`, () => {
      const first = stableProjection(fixture.success());
      const second = stableProjection(fixture.success());
      expect(first).toBeTruthy();
      expect(second).toEqual(first);
      expect(sha256(second)).toBe(sha256(first));
      expect(fixture.invalidRejected()).toBe(true);
      if (fixture.modelLegalEmpty) expect(fixture.modelLegalEmpty()).toBeTruthy();
    });
  }

  it("keeps stable receipt/effect identities and closed history across an audit-only model switch", async () => {
    const legalEmptyReasons: Record<ExtractionOperationStage, string> = {
      summary: "no_source_observations",
      lessons: "no_novel_lessons",
      memory_consolidate: "no_durable_memory",
      semantic_rollup: "no_eligible_summaries",
      skill_extract: "no_reusable_skill",
      crystal: "no_eligible_actions",
      consolidation_procedural: "no_reusable_procedure",
      reflect_insight: "no_novel_insight",
    };
    for (const entry of contracts.stages) {
      const kv = mockKV();
      const version = entry.compatible_with[0];
      const effectSource = buildSourceVersionKey(entry.stage, "fixture", "effect", "a".repeat(64));
      const emptySource = buildSourceVersionKey(entry.stage, "fixture", "empty", "b".repeat(64));
      const effectClaim = await claimBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        runId: "contract-run-a",
        unitId: `${entry.stage}:effect`,
        sourceVersionKeys: [effectSource],
      });
      expect(effectClaim.status).toBe("claimed");
      const effectReceiptKey = `receipt:${entry.stage}:effect`;
      const [committed] = await commitClaimedBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        contributionId: effectClaim.records[0].contributionId,
        sourceVersionKeys: [effectSource],
        operationReceiptRef: { scope: "receipts", key: effectReceiptKey },
        effectRefs: [{
          scope: `effects:${entry.stage}`,
          key: `result:${entry.stage}`,
          effectHash: sha256(stableProjection(
            parserFixtures.find(({ stage }) => stage === entry.stage)!.success(),
          )),
        }],
      });
      expect(committed).toMatchObject({
        state: "committed",
        operationReceiptRef: { scope: "receipts", key: effectReceiptKey },
        effectRefs: [{ scope: `effects:${entry.stage}`, key: `result:${entry.stage}` }],
      });

      const emptyClaim = await claimBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        runId: "contract-run-a",
        unitId: `${entry.stage}:empty`,
        sourceVersionKeys: [emptySource],
      });
      expect(emptyClaim.status).toBe("claimed");
      const emptyReceiptKey = `receipt:${entry.stage}:empty`;
      const [empty] = await markClaimedBatchNoEffect(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        contributionId: emptyClaim.records[0].contributionId,
        sourceVersionKeys: [emptySource],
        operationReceiptRef: { scope: "receipts", key: emptyReceiptKey },
        receiptKey: emptyReceiptKey,
        reasonCode: legalEmptyReasons[entry.stage],
      });
      expect(empty).toMatchObject({
        state: "no_effect",
        operationReceiptRef: { scope: "receipts", key: emptyReceiptKey },
        effectRefs: [],
        noEffectProof: {
          kind: "strict_legal_empty",
          receiptKey: emptyReceiptKey,
          reasonCode: legalEmptyReasons[entry.stage],
        },
      });

      const replay = await claimBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        runId: "contract-run-after-model-switch",
        unitId: `${entry.stage}:replay`,
        sourceVersionKeys: [effectSource, emptySource],
      });
      expect(replay.status).toBe("already_committed");
      expect(replay.records.map(({ contributionId }) => contributionId).sort()).toEqual([
        committed.contributionId,
        empty.contributionId,
      ].sort());

      const newSource = buildSourceVersionKey(entry.stage, "fixture", "new", "c".repeat(64));
      const next = await claimBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        runId: "contract-run-after-model-switch",
        unitId: `${entry.stage}:new`,
        sourceVersionKeys: [newSource],
      });
      expect(next.status).toBe("claimed");

      for (const failureKind of [
        "provider_failure",
        "response_uncertain",
        "truncated",
        "parse_failure",
      ]) {
        const failureSource = buildSourceVersionKey(
          entry.stage,
          "fixture",
          failureKind,
          sha256(`${entry.stage}:${failureKind}`),
        );
        const failedClaim = await claimBatch(kv as never, {
          stage: entry.stage,
          stageContractVersion: version,
          runId: `contract-${failureKind}`,
          unitId: `${entry.stage}:${failureKind}`,
          sourceVersionKeys: [failureSource],
        });
        expect(failedClaim.status).toBe("claimed");
        await releaseClaimedBatch(kv as never, {
          stage: entry.stage,
          stageContractVersion: version,
          contributionId: failedClaim.records[0].contributionId,
          sourceVersionKeys: [failureSource],
        });
        expect(await inspectContributionCandidates(kv as never, {
          stage: entry.stage,
          stageContractVersion: version,
          sourceVersionKeys: [failureSource],
        })).toEqual([expect.objectContaining({ state: "eligible" })]);
      }
    }
  });

  it("fails closed on a real contract mismatch without activating it or disturbing import and unrelated stages", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "imported-session", { id: "imported-session", status: "completed" });
    for (const [index, entry] of contracts.stages.entries()) {
      const version = contractVersions[entry.stage];
      const original = buildSourceVersionKey(
        entry.stage,
        "fixture",
        `old-${index}`,
        ((index + 2) % 16).toString(16).repeat(64),
      );
      expect((await claimBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        runId: `original-contract-run-${index}`,
        unitId: `${entry.stage}:old`,
        sourceVersionKeys: [original],
      })).status).toBe("claimed");

      const backlogSource = buildSourceVersionKey(
        entry.stage,
        "fixture",
        `backlog-${index}`,
        ((index + 7) % 16).toString(16).repeat(64),
      );
      const incompatibleVersion = version.replace(/\/v1$/, "/v2");
      expect(await claimBatch(kv as never, {
        stage: entry.stage,
        stageContractVersion: incompatibleVersion,
        runId: `incompatible-contract-run-${index}`,
        unitId: `${entry.stage}:backlog`,
        sourceVersionKeys: [backlogSource],
      })).toEqual({ status: "contract_migration_required", records: [] });
      expect(await kv.get(KV.extractionContributionContract(entry.stage), "active"))
        .toMatchObject({ version });
      expect(await kv.list(KV.extractionContributionRecords(entry.stage, incompatibleVersion)))
        .toEqual([]);
      expect(await inspectContributionCandidates(kv as never, {
        stage: entry.stage,
        stageContractVersion: version,
        sourceVersionKeys: [backlogSource],
      })).toEqual([expect.objectContaining({ state: "eligible" })]);

      const unrelated = contracts.stages[(index + 1) % contracts.stages.length];
      const unrelatedSource = buildSourceVersionKey(
        unrelated.stage,
        "fixture",
        `unrelated-${index}`,
        ((index + 11) % 16).toString(16).repeat(64),
      );
      expect((await claimBatch(kv as never, {
        stage: unrelated.stage,
        stageContractVersion: contractVersions[unrelated.stage],
        runId: `unrelated-stage-run-${index}`,
        unitId: `${unrelated.stage}:unrelated-${index}`,
        sourceVersionKeys: [unrelatedSource],
      })).status).toBe("claimed");
    }
    expect(await kv.get(KV.sessions, "imported-session")).toEqual({
      id: "imported-session",
      status: "completed",
    });

    const failureSource = buildSourceVersionKey("crystal", "fixture", "failure", "1".repeat(64));
    const failureClaim = await claimBatch(kv as never, {
      stage: "crystal",
      stageContractVersion: contractVersions.crystal,
      runId: "provider-failure-run",
      unitId: "crystal:failure",
      sourceVersionKeys: [failureSource],
    });
    expect(failureClaim.status).toBe("claimed");
    await releaseClaimedBatch(kv as never, {
      stage: "crystal",
      stageContractVersion: contractVersions.crystal,
      contributionId: failureClaim.records[0].contributionId,
      sourceVersionKeys: [failureSource],
    });
    expect(await inspectContributionCandidates(kv as never, {
      stage: "crystal",
      stageContractVersion: contractVersions.crystal,
      sourceVersionKeys: [failureSource],
    })).toEqual([expect.objectContaining({ state: "eligible" })]);
  });
});
