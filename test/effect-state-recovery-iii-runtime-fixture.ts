import { registerWorker } from "iii-sdk";
import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { registerCrystallizeFunction } from "../src/functions/crystallize.js";
import { registerExtractionOperationReceiptFunctions } from "../src/functions/extraction-operation-receipts.js";
import { registerExtractionRunIndexFunction } from "../src/functions/extraction-run-index.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { registerSemanticRollupFunction } from "../src/functions/semantic-rollup.js";
import { registerSkillExtractFunctions } from "../src/functions/skill-extract.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { MemoryProvider } from "../src/types.js";

type Stage =
  | "summary"
  | "lessons"
  | "memory_consolidate"
  | "semantic_rollup"
  | "skill_extract"
  | "crystal"
  | "consolidation_procedural"
  | "reflect_insight";

const engineUrl = process.env.AGENTMEMORY_TEST_III_ENGINE_URL;
const secret = process.env.AGENTMEMORY_TEST_RUNTIME_SECRET;
const httpPort = Number(process.env.AGENTMEMORY_TEST_RUNTIME_HTTP_PORT || "0");
const faultStage = process.env.AGENTMEMORY_TEST_RUNTIME_FAULT_STAGE as Stage | undefined;
const metadataScope = "test:effect-state-recovery-iii-runtime:metadata";
const sessionId = "temporary-eight-stage-real-iii-session";

if (!engineUrl || !secret || !Number.isSafeInteger(httpPort) || httpPort <= 0) {
  throw new Error("test_iii_runtime_configuration_missing");
}

const sdk = registerWorker(engineUrl, {
  workerName: `agentmemory-eight-stage-iii-${process.pid}`,
  enableMetricsReporting: false,
  invocationTimeoutMs: 10_000,
  reconnectionConfig: {
    maxRetries: 5,
    initialDelay: 50,
    maxDelay: 250,
  },
  otel: { enabled: false },
});

async function waitForState() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      await sdk.trigger({
        function_id: "state::get",
        payload: { scope: metadataScope, key: "readiness" },
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("test_iii_state_not_ready", { cause: lastError });
}

function stageForBusinessEffect(scope: string, value: any): Stage | null {
  if (scope === KV.summaries) return "summary";
  if (scope === KV.lessons) return "lessons";
  if (scope === KV.memories && value?.title === "Eight-stage durable memory") {
    return "memory_consolidate";
  }
  if (scope === KV.semantic) return "semantic_rollup";
  if (scope === KV.procedural) {
    return Array.isArray(value?.sourceSessionIds) && value.sourceSessionIds.includes(sessionId)
      ? "skill_extract"
      : "consolidation_procedural";
  }
  if (scope === KV.crystals) return "crystal";
  if (scope === KV.insights) return "reflect_insight";
  return null;
}

let armed = false;
let faultTriggered = false;
const rawTrigger = sdk.trigger.bind(sdk);

async function terminateAfterAcknowledgedEffect(
  stage: Stage,
  scope: string,
  key: string,
  value: unknown,
): Promise<never> {
  if (!process.send) throw new Error("test_iii_runtime_ipc_missing");
  await new Promise<void>((resolve, reject) => {
    process.send?.(
      { type: "effect-acknowledged", stage, scope, key, value },
      (error) => error ? reject(error) : resolve(),
    );
  });
  process.exit(86);
  return new Promise<never>(() => {});
}

const runtimeSdk = new Proxy(sdk as any, {
  get(target, property, receiver) {
    if (property !== "trigger") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return async (input: string | { function_id: string; payload: any }, payload?: any) => {
      const functionId = typeof input === "string" ? input : input.function_id;
      const data = typeof input === "string" ? payload : input.payload;
      const result = typeof input === "string"
        ? await rawTrigger(input, payload)
        : await rawTrigger(input);
      if (
        armed
        && !faultTriggered
        && faultStage
        && functionId === "state::set"
        && stageForBusinessEffect(data?.scope, data?.value) === faultStage
      ) {
        faultTriggered = true;
        return terminateAfterAcknowledgedEffect(
          faultStage,
          data.scope,
          data.key,
          data.value,
        );
      }
      return result;
    };
  },
});

await waitForState();
const kv = new StateKV(runtimeSdk);

function providerResponse(system: string) {
  if (system.includes("skill extraction engine")) {
    return [
      "<skill>",
      "<trigger>When durable state recovery must be verified</trigger>",
      "<title>Verify durable recovery</title>",
      "<steps><step>Freeze the operation identity</step><step>Verify the formal effect</step></steps>",
      "<expected_outcome>The effect is committed exactly once</expected_outcome>",
      "<tags>recovery,durability</tags>",
      "</skill>",
    ].join("");
  }
  if (system.includes("procedural memory extractor")) {
    return [
      "<procedures>",
      '<procedure name="Recover a durable effect" trigger="after an interrupted extraction">',
      "<step>Read the durable receipt</step><step>Verify the formal watermark</step>",
      "</procedure>",
      "</procedures>",
    ].join("");
  }
  if (system.includes("higher-order reasoning engine")) {
    return [
      "<insights>",
      '<insight confidence="0.91" title="Durable recovery boundary">',
      "A formal effect and its receipt must be verified together before replay.",
      "</insight>",
      "</insights>",
    ].join("");
  }
  if (system.includes("completed chain of agent actions")) {
    return JSON.stringify({
      narrative: "Verified the eight-stage durable recovery path.",
      keyOutcomes: ["formal state persisted"],
      filesAffected: ["src/recovery.ts"],
      lessons: ["Verify durable effects before replay."],
    });
  }
  if (system.includes("overlapping episodic memories")) {
    return '<facts><fact confidence="0.93">Durable effects require receipt verification</fact></facts>';
  }
  return [
    "<summary>",
    "<title>Eight-stage real III recovery</title>",
    "<narrative>Implemented and verified durable effect recovery.</narrative>",
    "<decisions><decision>Bind every effect to a stable operation identity.</decision></decisions>",
    "<files><file>src/recovery.ts</file></files>",
    "<concepts><concept>recovery</concept><concept>durability</concept></concepts>",
    "</summary>",
  ].join("");
}

const provider: MemoryProvider = {
  name: "deterministic-real-iii-test-provider",
  compress: async (system: string) => {
    if (system.includes("memory consolidation engine")) {
      return [
        "<memory>",
        "<type>pattern</type>",
        "<title>Eight-stage durable memory</title>",
        "<content>Verify the formal effect and receipt before replaying a recovered operation.</content>",
        "<concepts><concept>recovery</concept></concepts>",
        "<files><file>src/recovery.ts</file></files>",
        "<strength>9</strength>",
        "</memory>",
      ].join("");
    }
    return [
      "<lessons>",
      '<lesson confidence="0.9"><content>Verify durable effects before replay.</content><context>recovery</context><importance>0.9</importance><evidence>The session verifies formal effects before replay.</evidence></lesson>',
      '<lesson confidence="0.8"><content>Use stable identities for recovery.</content><context>durability</context><importance>0.8</importance><evidence>The session binds recovery work to stable operation identities.</evidence></lesson>',
      "</lessons>",
    ].join("");
  },
  summarize: async (system: string) => providerResponse(system),
};

if (await kv.get(KV.sessions, sessionId) === null) {
  throw new Error("test_iii_runtime_seed_not_visible");
}

registerSummarizeFunction(runtimeSdk, kv, provider);
registerLessonsFunctions(runtimeSdk, kv, provider);
registerConsolidateFunction(runtimeSdk, kv, provider);
registerSemanticRollupFunction(runtimeSdk, kv, provider);
registerSkillExtractFunctions(runtimeSdk, kv, provider);
registerCrystallizeFunction(runtimeSdk, kv, provider);
registerConsolidationPipelineFunction(runtimeSdk, kv, provider);
registerReflectFunctions(runtimeSdk, kv, provider);
registerExtractionOperationReceiptFunctions(runtimeSdk, kv);
registerExtractionRunIndexFunction(runtimeSdk, kv);
registerApiTriggers(runtimeSdk, kv, secret, undefined, provider as never);

const snapshotScopes = [
  KV.sessions,
  KV.summaries,
  KV.lessons,
  KV.memories,
  KV.semantic,
  KV.procedural,
  KV.crystals,
  KV.insights,
  KV.extractionRunCatalogControl,
];

async function stateSnapshot() {
  const scopes: Record<string, Record<string, any>> = {};
  for (const scope of snapshotScopes) {
    const values = await kv.list<any>(scope);
    scopes[scope] = Object.fromEntries(values.map((value, index) => [
      value.id ?? value.sessionId ?? value.key ?? String(index),
      value,
    ]));
  }
  return { scopes, faultStage };
}

runtimeSdk.registerFunction("test::effect-state-recovery-snapshot", async () => ({
  status_code: 200,
  body: await stateSnapshot(),
}));
runtimeSdk.registerTrigger({
  type: "http",
  function_id: "test::effect-state-recovery-snapshot",
  config: {
    api_path: "/__test/state",
    http_method: "GET",
  },
});

runtimeSdk.registerFunction(
  "test::effect-state-recovery-value",
  async (request: { query_params?: Record<string, string> }) => {
    const scope = request.query_params?.scope;
    const key = request.query_params?.key;
    if (!scope || !key) {
      return { status_code: 400, body: { error: "scope and key are required" } };
    }
    return {
      status_code: 200,
      body: { value: await kv.get(scope, key) },
    };
  },
);
runtimeSdk.registerTrigger({
  type: "http",
  function_id: "test::effect-state-recovery-value",
  config: {
    api_path: "/__test/value",
    http_method: "GET",
  },
});

const baseUrl = `http://127.0.0.1:${httpPort}`;
let lastReadinessError: unknown;
for (let attempt = 0; attempt < 160; attempt += 1) {
  try {
    const [testResponse, productionResponse] = await Promise.all([
      fetch(`${baseUrl}/__test/state`),
      fetch(`${baseUrl}/agentmemory/full/consolidation-procedural-window`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ]);
    if (testResponse.ok && productionResponse.status === 400) {
      armed = true;
      process.send?.({ type: "ready", baseUrl });
      lastReadinessError = undefined;
      break;
    }
    lastReadinessError = new Error(
      `test_iii_http_readiness_${testResponse.status}_${productionResponse.status}`,
    );
  } catch (error) {
    lastReadinessError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (lastReadinessError) {
  throw new Error("test_iii_http_not_ready", { cause: lastReadinessError });
}

process.on("message", async (message: any) => {
  if (message?.type !== "shutdown") return;
  await sdk.shutdown().catch(() => {});
  process.exit(0);
});
