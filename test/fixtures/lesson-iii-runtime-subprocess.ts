import { createServer } from "node:http";
import { registerWorker } from "iii-sdk";
import { registerApiTriggers } from "../../src/triggers/api.js";
import { registerExtractionOperationReceiptFunctions } from "../../src/functions/extraction-operation-receipts.js";
import { registerExtractionRunIndexFunction } from "../../src/functions/extraction-run-index.js";
import { registerLessonsFunctions } from "../../src/functions/lessons.js";
import { StateKV } from "../../src/state/kv.js";
import { KV } from "../../src/state/schema.js";
import type { MemoryProvider } from "../../src/types.js";

type Boundary =
  | "extraction run pending"
  | "generation registry"
  | "generation run binding"
  | "extraction run running"
  | "extraction operation receipt running"
  | "candidate staging"
  | "candidate run binding"
  | "commit plan"
  | "initial committing receipt"
  | "first formal lesson watermark"
  | "first progress receipt"
  | "second formal lesson watermark"
  | "second progress receipt"
  | "formal lesson watermark"
  | "committed receipt"
  | "extraction operation receipt succeeded";

type Handler = (input: any) => Promise<any>;

const observedBoundaryOrder: Boundary[] = [
  "extraction run pending",
  "generation registry",
  "generation run binding",
  "extraction run running",
  "extraction operation receipt running",
  "candidate staging",
  "candidate run binding",
  "commit plan",
  "initial committing receipt",
  "first formal lesson watermark",
  "first progress receipt",
  "second formal lesson watermark",
  "second progress receipt",
  "committed receipt",
  "extraction operation receipt succeeded",
];

const engineUrl = process.env.AGENTMEMORY_TEST_III_ENGINE_URL;
const secret = process.env.AGENTMEMORY_TEST_RUNTIME_SECRET;
const requestedPort = Number(process.env.AGENTMEMORY_TEST_RUNTIME_PORT || "0");
const faultBoundary = process.env.AGENTMEMORY_TEST_RUNTIME_FAULT as Boundary | undefined;
const faultIndex = process.env.AGENTMEMORY_TEST_RUNTIME_FAULT_INDEX === undefined
  ? undefined
  : Number(process.env.AGENTMEMORY_TEST_RUNTIME_FAULT_INDEX);
const pauseBeforeFault = process.env.AGENTMEMORY_TEST_RUNTIME_PAUSE_BEFORE_FAULT === "1";
const metadataScope = "test:lesson-iii-runtime:metadata";

if (!engineUrl || !secret) throw new Error("test_iii_runtime_configuration_missing");

const sdk = registerWorker(engineUrl, {
  workerName: "agentmemory-lesson-iii-runtime",
  enableMetricsReporting: false,
  invocationTimeoutMs: 5_000,
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

function matchesBoundary(
  boundary: Boundary,
  scope: string,
  value: any,
  formalLessonWriteCount: number,
) {
  switch (boundary) {
    case "extraction run pending":
      return scope === KV.lessonExtractionRuns
        && value?.status === "pending"
        && value?.extractionGeneration === undefined;
    case "generation registry":
      return scope.startsWith("mem:lesson-extraction:generation:");
    case "generation run binding":
      return scope === KV.lessonExtractionRuns
        && Number.isSafeInteger(value?.extractionGeneration)
        && value.extractionGeneration > 0
        && value?.status === "pending"
        && value.candidateStagingId === undefined;
    case "extraction run running":
      return scope === KV.lessonExtractionRuns
        && value?.status === "running"
        && Number.isSafeInteger(value?.extractionGeneration);
    case "extraction operation receipt running":
      return scope.startsWith("mem:extraction-operation-receipt:")
        && value?.status === "running";
    case "candidate staging":
      return scope.startsWith("mem:lesson-extraction:candidates:");
    case "candidate run binding":
      return scope === KV.lessonExtractionRuns
        && value?.status === "succeeded"
        && typeof value?.candidateStagingId === "string";
    case "commit plan":
      return scope.startsWith("mem:lesson-commit:plans:");
    case "initial committing receipt":
      return scope.startsWith("mem:lesson-commit:receipts:")
        && value?.status === "committing"
        && value?.appliedLessonIds?.length === 0;
    case "first formal lesson watermark":
      return scope === KV.lessons && formalLessonWriteCount === 0;
    case "first progress receipt":
      return scope.startsWith("mem:lesson-commit:receipts:")
        && value?.status === "committing"
        && value?.appliedLessonIds?.length === 1;
    case "second formal lesson watermark":
      return scope === KV.lessons && formalLessonWriteCount === 1;
    case "second progress receipt":
      return scope.startsWith("mem:lesson-commit:receipts:")
        && value?.status === "committing"
        && value?.appliedLessonIds?.length === 2;
    case "formal lesson watermark":
      return scope === KV.lessons;
    case "committed receipt":
      return scope.startsWith("mem:lesson-commit:receipts:")
        && value?.status === "committed";
    case "extraction operation receipt succeeded":
      return scope.startsWith("mem:extraction-operation-receipt:")
        && value?.status === "succeeded";
  }
}

let armed = false;
let faultTriggered = false;
let formalLessonWriteCount = 0;
let stateSetCount = 0;
let continueFault: (() => void) | null = null;
const functions = new Map<string, Handler>();
const rawTrigger = sdk.trigger.bind(sdk);

async function waitUntilFaultMayContinue(
  boundary: string,
  scope: string,
  key: string,
  value: unknown,
) {
  if (!process.send) throw new Error("test_iii_runtime_ipc_missing");
  await new Promise<void>((resolve, reject) => {
    process.send?.(
      { type: "fault-ready", boundary, scope, key, value },
      (error) => error ? reject(error) : resolve(),
    );
  });
  await new Promise<void>((resolve) => {
    continueFault = resolve;
  });
  continueFault = null;
}

async function terminateAfterAcknowledgedBoundary(
  boundary: string,
  scope: string,
  key: string,
  value: unknown,
): Promise<never> {
  if (!process.send) throw new Error("test_iii_runtime_ipc_missing");
  await new Promise<void>((resolve, reject) => {
    process.send?.(
      { type: "fault-acknowledged", boundary, scope, key, value },
      (error) => error ? reject(error) : resolve(),
    );
  });
  process.exit(86);
  return new Promise<never>(() => {});
}

async function reportStateSet(
  index: number,
  scope: string,
  key: string,
  boundaries: Boundary[],
) {
  if (!process.send) throw new Error("test_iii_runtime_ipc_missing");
  await new Promise<void>((resolve, reject) => {
    process.send?.(
      { type: "state-set-observed", index, scope, key, boundaries },
      (error) => error ? reject(error) : resolve(),
    );
  });
}

const faultingSdk = new Proxy(sdk as any, {
  get(target, property, receiver) {
    if (property === "registerFunction") {
      return (idOrOptions: string | { id: string }, handler: Handler) => {
        functions.set(typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id, handler);
      };
    }
    if (property === "registerTrigger") return () => {};
    if (property !== "trigger") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return async (input: string | { function_id: string; payload: any }, payload?: any) => {
      const functionId = typeof input === "string" ? input : input.function_id;
      const data = typeof input === "string" ? payload : input.payload;
      if (!functionId.startsWith("state::")) {
        const handler = functions.get(functionId);
        if (!handler) throw new Error(`test_iii_runtime_missing_function:${functionId}`);
        return handler(data);
      }
      const currentStateSetIndex = functionId === "state::set" && armed
        ? stateSetCount++
        : undefined;
      const observedBoundaries = currentStateSetIndex !== undefined
        ? observedBoundaryOrder.filter((boundary) => matchesBoundary(
            boundary,
            data?.scope,
            data?.value,
            formalLessonWriteCount,
          ))
        : [];
      const shouldFault = Boolean(
        armed
        && !faultTriggered
        && functionId === "state::set"
        && (
          currentStateSetIndex === faultIndex
          || (
            faultBoundary
            && matchesBoundary(
              faultBoundary,
              data?.scope,
              data?.value,
              formalLessonWriteCount,
            )
          )
        )
      );
      const faultLabel = faultBoundary
        ?? `state set #${currentStateSetIndex}`;
      if (shouldFault && pauseBeforeFault) {
        faultTriggered = true;
        await waitUntilFaultMayContinue(
          faultLabel,
          data.scope,
          data.key,
          data.value,
        );
      }
      const result = typeof input === "string"
        ? await rawTrigger(input, payload)
        : await rawTrigger(input);
      if (functionId === "state::set" && armed) {
        await reportStateSet(
          currentStateSetIndex!,
          data.scope,
          data.key,
          observedBoundaries,
        );
      }
      if (functionId === "state::set" && data?.scope === KV.lessons) {
        formalLessonWriteCount += 1;
      }
      if (shouldFault) {
        faultTriggered = true;
        return terminateAfterAcknowledgedBoundary(
          faultLabel,
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

const kv = new StateKV(faultingSdk);
async function reportProviderCall() {
  if (!process.send) throw new Error("test_iii_runtime_ipc_missing");
  await new Promise<void>((resolve, reject) => {
    process.send?.({ type: "provider-call" }, (error) => error ? reject(error) : resolve());
  });
}

const provider: MemoryProvider = {
  name: "real-iii-subprocess-test-provider",
  compress: async () => {
    await reportProviderCall();
    return [
      "<lessons>",
      '<lesson confidence="0.8"><content>real iii runtime recovery one</content><context>deterministic</context></lesson>',
      '<lesson confidence="0.8"><content>real iii runtime recovery two</content><context>deterministic</context></lesson>',
      "</lessons>",
    ].join("");
  },
  summarize: async () => "",
};

const sessionId = "temporary-real-iii-runtime-session";
if (
  await kv.get(KV.sessions, sessionId) === null
  || (await kv.list<any>(KV.sessions)).every((session) => session.id !== sessionId)
) {
  throw new Error("test_iii_runtime_seed_not_visible");
}

registerExtractionOperationReceiptFunctions(faultingSdk, kv);
registerExtractionRunIndexFunction(faultingSdk, kv);
registerLessonsFunctions(faultingSdk, kv, provider);
registerApiTriggers(faultingSdk, kv, secret, undefined, provider as never);

const routes = new Map<string, string>([
  ["GET /agentmemory/sessions", "api::sessions"],
  ["GET /agentmemory/runtime-config", "api::runtime-config"],
  ["POST /agentmemory/lessons/extract", "api::lesson-extract"],
  ["POST /agentmemory/extraction-runs/record", "api::extraction-run-record"],
]);

async function invokeRegistered(id: string, data: any) {
  const handler = functions.get(id);
  if (!handler) throw new Error(`test_iii_runtime_missing_function:${id}`);
  return handler(data);
}

async function stateSnapshot() {
  const runs = await kv.list<any>(KV.lessonExtractionRuns);
  const scopes: Record<string, Record<string, any>> = {};
  const addScope = async (scope: string, keyOf: (value: any) => string) => {
    const values = await kv.list<any>(scope);
    scopes[scope] = Object.fromEntries(values.map((value) => [keyOf(value), value]));
  };
  await addScope(KV.sessions, (value) => value.id);
  await addScope(KV.lessons, (value) => value.id);
  await addScope(KV.lessonExtractionRuns, (value) => value.id);
  await addScope(KV.lessonExtractionGeneration(sessionId), (value) => value.sessionId);
  for (const run of runs) {
    await addScope(KV.lessonExtractionCandidates(run.id), (value) => value.id);
    await addScope(KV.lessonCommitPlans(run.id), (value) => value.id);
    await addScope(KV.lessonCommitReceipts(run.id), (value) => value.key);
  }
  return {
    scopes,
    metadata: {
      providerCalls: 0,
      faultBoundary,
    },
  };
}

const server = createServer(async (request, response) => {
  let currentRoute: string | undefined;
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__test/value") {
      const scope = url.searchParams.get("scope");
      const key = url.searchParams.get("key");
      if (!scope || !key) {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: await kv.get(scope, key) }));
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/__test/value") {
      const scope = url.searchParams.get("scope");
      const key = url.searchParams.get("key");
      if (!scope || !key) {
        response.writeHead(400).end();
        return;
      }
      await kv.delete(scope, key);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/__test/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(await stateSnapshot()));
      return;
    }
    const id = routes.get(`${request.method} ${url.pathname}`);
    currentRoute = id;
    if (!id) {
      response.writeHead(404).end();
      return;
    }
    const body = request.method === "GET" ? undefined : await new Promise<string>((resolve, reject) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => resolve(raw));
      request.on("error", reject);
    });
    const result = await invokeRegistered(id, {
      headers: request.headers,
      query_params: Object.fromEntries(url.searchParams),
      ...(body ? { body: JSON.parse(body) } : {}),
    });
    process.send?.({ type: "api-response", id, result });
    response.writeHead(result.status_code, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "test_iii_runtime_error";
    process.send?.({
      type: "api-error",
      id: currentRoute,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, error: message }));
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_iii_runtime_missing_port");
  armed = true;
  process.send?.({ type: "ready", baseUrl: `http://127.0.0.1:${address.port}` });
});

process.on("message", (message: any) => {
  if (message?.type === "continue-fault") {
    continueFault?.();
    return;
  }
  if (message?.type !== "shutdown") return;
  server.close(async () => {
    await sdk.shutdown().catch(() => {});
    process.exit(0);
  });
});
