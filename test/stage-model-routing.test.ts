import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadConfigModule() {
  vi.resetModules();
  return import("../src/config.js");
}

describe("resolveStageModel", () => {
  const homes: string[] = [];

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  function useIsolatedHome() {
    const home = mkdtempSync(join(tmpdir(), "agentmemory-stage-model-"));
    homes.push(home);
    process.env = { ...ORIGINAL_ENV, AGENTMEMORY_HOME: home } as NodeJS.ProcessEnv;
    delete process.env.AGENTMEMORY_SUMMARY_MODEL;
    delete process.env.AGENTMEMORY_LESSON_MODEL;
    delete process.env.AGENTMEMORY_SKILL_EXTRACT_MODEL;
    delete process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MODEL;
    delete process.env.AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL;
    delete process.env.AGENTMEMORY_PROCEDURAL_MODEL;
    delete process.env.AGENTMEMORY_CRYSTAL_MODEL;
    delete process.env.AGENTMEMORY_REFLECT_INSIGHT_MODEL;
    delete process.env.AGENTMEMORY_DEFAULT_STAGE_MODEL;
    delete process.env.PI_AGENT_MODEL;
  }

  it("prefers explicit override over all environment values", async () => {
    useIsolatedHome();
    process.env.AGENTMEMORY_SUMMARY_MODEL = "stage-model";
    process.env.AGENTMEMORY_DEFAULT_STAGE_MODEL = "default-stage-model";
    process.env.PI_AGENT_MODEL = "pi-model";
    const { resolveStageModel } = await loadConfigModule();

    expect(resolveStageModel("summary", " explicit-model ")).toEqual({
      stage: "summary",
      model: "explicit-model",
      source: "explicitModel",
    });
  });

  it("uses stage env before default stage env and PI_AGENT_MODEL", async () => {
    useIsolatedHome();
    process.env.AGENTMEMORY_LESSON_MODEL = "lesson-model";
    process.env.AGENTMEMORY_DEFAULT_STAGE_MODEL = "default-stage-model";
    process.env.PI_AGENT_MODEL = "pi-model";
    const { resolveStageModel } = await loadConfigModule();

    expect(resolveStageModel("lesson")).toEqual({
      stage: "lesson",
      model: "lesson-model",
      source: "AGENTMEMORY_LESSON_MODEL",
    });
  });

  it("resolves independent procedural and crystal stage models", async () => {
    useIsolatedHome();
    process.env.AGENTMEMORY_PROCEDURAL_MODEL = "procedural-model";
    process.env.AGENTMEMORY_CRYSTAL_MODEL = "crystal-model";
    const { resolveStageModel } = await loadConfigModule();

    expect(resolveStageModel("procedural")).toEqual({
      stage: "procedural",
      model: "procedural-model",
      source: "AGENTMEMORY_PROCEDURAL_MODEL",
    });
    expect(resolveStageModel("crystal")).toEqual({
      stage: "crystal",
      model: "crystal-model",
      source: "AGENTMEMORY_CRYSTAL_MODEL",
    });
  });

  it("falls back from default stage env to PI_AGENT_MODEL to provider default", async () => {
    useIsolatedHome();
    process.env.AGENTMEMORY_DEFAULT_STAGE_MODEL = "default-stage-model";
    let mod = await loadConfigModule();
    expect(mod.resolveStageModel("skill_extract")).toEqual({
      stage: "skill_extract",
      model: "default-stage-model",
      source: "AGENTMEMORY_DEFAULT_STAGE_MODEL",
    });

    useIsolatedHome();
    process.env.PI_AGENT_MODEL = "pi-model";
    mod = await loadConfigModule();
    expect(mod.resolveStageModel("semantic_rollup")).toEqual({
      stage: "semantic_rollup",
      model: "pi-model",
      source: "PI_AGENT_MODEL",
    });

    useIsolatedHome();
    mod = await loadConfigModule();
    expect(mod.resolveStageModel("reflect_insight")).toEqual({
      stage: "reflect_insight",
      source: "provider_default",
    });
  });

  it("treats blank values as missing", async () => {
    useIsolatedHome();
    process.env.AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL = "   ";
    process.env.AGENTMEMORY_DEFAULT_STAGE_MODEL = "\t";
    process.env.PI_AGENT_MODEL = "pi-model";
    const { resolveStageModel } = await loadConfigModule();

    expect(resolveStageModel("memory_consolidate")).toEqual({
      stage: "memory_consolidate",
      model: "pi-model",
      source: "PI_AGENT_MODEL",
    });
  });

  it("reports effective model metadata only for supported pi-agent-sdk text routing", async () => {
    useIsolatedHome();
    process.env.AGENTMEMORY_SUMMARY_MODEL = "summary-model";
    const { resolveStageModelMetadata } = await loadConfigModule();

    expect(resolveStageModelMetadata("summary", "pi-agent-sdk")).toEqual({
      stage: "summary",
      provider: "pi-agent-sdk",
      model: "summary-model",
      modelSource: "AGENTMEMORY_SUMMARY_MODEL",
      modelApplied: true,
    });

    expect(resolveStageModelMetadata("summary", "resilient(openai)", "cli-model")).toEqual({
      stage: "summary",
      provider: "openai",
      modelApplied: false,
      providerModelOverride: "unsupported",
    });
  });
});
