import { createServer } from "node:http";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { registerApiTriggers } from "../../src/triggers/api.js";
import { registerExtractionOperationReceiptFunctions } from "../../src/functions/extraction-operation-receipts.js";
import { registerExtractionRunIndexFunction } from "../../src/functions/extraction-run-index.js";
import { registerLessonsFunctions } from "../../src/functions/lessons.js";
import { StateKV } from "../../src/state/kv.js";
import { KV } from "../../src/state/schema.js";
import type { MemoryProvider } from "../../src/types.js";

type Handler = (input: any) => Promise<any>;

type Boundary =
  | "provider response"
  | "generation registry"
  | "generation run binding"
  | "candidate staging before write"
  | "candidate staging"
  | "candidate run binding"
  | "commit plan"
  | "formal lesson watermark"
  | "initial committing receipt"
  | "first progress receipt"
  | "committed receipt"
  | "extraction operation receipt";

interface PersistedRuntime {
  scopes: Record<string, Record<string, unknown>>;
  metadata: { providerCalls: number; faultBoundary?: Boundary };
}

const stateDir = process.env.AGENTMEMORY_TEST_RUNTIME_STATE_DIR;
const secret = process.env.AGENTMEMORY_TEST_RUNTIME_SECRET;
const faultBoundary = process.env.AGENTMEMORY_TEST_RUNTIME_FAULT as Boundary | undefined;
const requestedPort = Number(process.env.AGENTMEMORY_TEST_RUNTIME_PORT || "0");

if (!stateDir || !secret) throw new Error("test_runtime_configuration_missing");

const statePath = join(stateDir, "statekv-substitute.bin");
let persisted: PersistedRuntime = { scopes: {}, metadata: { providerCalls: 0 } };
try {
  persisted = deserialize(await readFile(statePath)) as PersistedRuntime;
} catch (error: any) {
  if (error?.code !== "ENOENT") throw error;
}

const state = new Map<string, Map<string, unknown>>(
  Object.entries(persisted.scopes).map(([scope, values]) => [scope, new Map(Object.entries(values))]),
);
const snapshot = (): PersistedRuntime => ({
  scopes: Object.fromEntries([...state.entries()].map(([scope, values]) => [scope, Object.fromEntries(values)])),
  metadata: persisted.metadata,
});

async function persist() {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(serialize(snapshot()));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, statePath);
}

function matchesBoundary(boundary: Boundary, scope: string, value: any) {
  switch (boundary) {
    case "provider response": return false;
    case "generation registry": return scope.startsWith("mem:lesson-extraction:generation:");
    case "generation run binding":
      return scope === KV.lessonExtractionRuns
        && Number.isSafeInteger(value?.extractionGeneration)
        && value.extractionGeneration > 0
        && value.candidateStagingId === undefined;
    case "candidate staging before write":
    case "candidate staging":
      return scope.startsWith("mem:lesson-extraction:candidates:");
    case "candidate run binding":
      return scope === KV.lessonExtractionRuns
        && value?.status === "succeeded"
        && typeof value?.candidateStagingId === "string";
    case "commit plan": return scope.startsWith("mem:lesson-commit:plans:");
    case "formal lesson watermark": return scope === KV.lessons;
    case "initial committing receipt":
      return scope.startsWith("mem:lesson-commit:receipts:")
        && value?.status === "committing"
        && value?.appliedLessonIds?.length === 0;
    case "first progress receipt":
      return scope.startsWith("mem:lesson-commit:receipts:")
        && value?.status === "committing"
        && value?.appliedLessonIds?.length === 1;
    case "committed receipt": return scope.startsWith("mem:lesson-commit:receipts:") && value?.status === "committed";
    case "extraction operation receipt": return scope.startsWith("mem:extraction-operation-receipt:");
  }
}

let armed = false;
async function terminateAfterObservedBoundary(boundary: Boundary): Promise<never> {
  persisted.metadata.faultBoundary = boundary;
  await persist();
  if (!process.send) throw new Error("test_runtime_ipc_missing");
  await new Promise<void>((resolve, reject) => {
    process.send?.({ type: "fault-observed", boundary }, (error) => error ? reject(error) : resolve());
  });
  process.exit(86);
  return new Promise<never>(() => {});
}

const functions = new Map<string, Handler>();
const sdk = {
  registerFunction: (idOrOptions: string | { id: string }, handler: Handler) => {
    functions.set(typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id, handler);
  },
  registerTrigger: () => {},
  trigger: async (input: string | { function_id: string; payload: any }, payload?: any) => {
    const id = typeof input === "string" ? input : input.function_id;
    const data = typeof input === "string" ? payload : input.payload;
    if (id === "state::get") return state.get(data.scope)?.get(data.key) ?? null;
    if (id === "state::list") return [...(state.get(data.scope)?.values() ?? [])];
    if (id === "state::delete") {
      state.get(data.scope)?.delete(data.key);
      await persist();
      return undefined;
    }
    if (id === "state::update") {
      const current = state.get(data.scope)?.get(data.key);
      if (!current || typeof current !== "object") throw new Error("test_runtime_update_missing_value");
      const next = structuredClone(current) as Record<string, unknown>;
      for (const operation of data.ops ?? []) {
        if (operation.type !== "set" || typeof operation.path !== "string") throw new Error("test_runtime_update_unsupported");
        next[operation.path] = operation.value;
      }
      if (!state.has(data.scope)) state.set(data.scope, new Map());
      state.get(data.scope)!.set(data.key, next);
      await persist();
      return next;
    }
    if (id === "state::set") {
      if (armed && faultBoundary === "candidate staging before write"
        && !persisted.metadata.faultBoundary
        && matchesBoundary(faultBoundary, data.scope, data.value)) {
        return await terminateAfterObservedBoundary(faultBoundary);
      }
      if (!state.has(data.scope)) state.set(data.scope, new Map());
      state.get(data.scope)!.set(data.key, data.value);
      await persist();
      if (armed && faultBoundary && !persisted.metadata.faultBoundary && matchesBoundary(faultBoundary, data.scope, data.value)) {
        return await terminateAfterObservedBoundary(faultBoundary);
      }
      return data.value;
    }
    const handler = functions.get(id);
    if (!handler) throw new Error(`test_runtime_missing_function:${id}`);
    return handler(data);
  },
};

const kv = new StateKV(sdk as never);
const provider: MemoryProvider = {
  name: "persistent-subprocess-test-provider",
  compress: async () => {
    persisted.metadata.providerCalls += 1;
    await persist();
    const response = [
      "<lessons>",
      '<lesson confidence="0.8"><content>temporary runtime recovery one</content><context>deterministic</context></lesson>',
      '<lesson confidence="0.8"><content>temporary runtime recovery two</content><context>deterministic</context></lesson>',
      "</lessons>",
    ].join("");
    if (armed && faultBoundary === "provider response" && !persisted.metadata.faultBoundary) {
      return terminateAfterObservedBoundary(faultBoundary);
    }
    return response;
  },
  summarize: async () => "",
};

registerExtractionOperationReceiptFunctions(sdk as never, kv);
registerExtractionRunIndexFunction(sdk as never, kv);
registerLessonsFunctions(sdk as never, kv, provider);
registerApiTriggers(sdk as never, kv, secret, undefined, provider as never);

const sessionId = "temporary-runtime-session";
if (await kv.get(KV.sessions, sessionId) === null) {
  await kv.set(KV.sessions, sessionId, {
    id: sessionId, project: "/tmp/temporary-runtime", cwd: "/tmp/temporary-runtime",
    startedAt: "2026-07-29T00:00:00.000Z", status: "completed", observationCount: 1,
  });
  await kv.set(KV.observations(sessionId), "obs-1", {
    id: "obs-1", sessionId, sourceEventIndex: 1, timestamp: "2026-07-29T00:00:00.000Z",
    hookType: "prompt_submit", raw: {}, userPrompt: "Recover the durable lesson commit.",
  });
}

const routes = new Map<string, string>([
  ["GET /agentmemory/sessions", "api::sessions"],
  ["GET /agentmemory/runtime-config", "api::runtime-config"],
  ["POST /agentmemory/lessons/extract", "api::lesson-extract"],
  ["POST /agentmemory/extraction-runs/record", "api::extraction-run-record"],
]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__test/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(snapshot()));
      return;
    }
    const id = routes.get(`${request.method} ${url.pathname}`);
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
    const handler = functions.get(id);
    if (!handler) throw new Error(`test_runtime_missing_http_handler:${id}`);
    const result = await handler({
      headers: request.headers,
      query_params: Object.fromEntries(url.searchParams),
      ...(body ? { body: JSON.parse(body) } : {}),
    });
    response.writeHead(result.status_code, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "test_runtime_error";
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, error: message }));
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_runtime_missing_port");
  armed = true;
  process.send?.({ type: "ready", baseUrl: `http://127.0.0.1:${address.port}` });
});

process.on("message", (message: any) => {
  if (message?.type !== "shutdown") return;
  server.close(() => process.exit(0));
});
