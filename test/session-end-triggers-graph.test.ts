import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #666: api::session::end must publish the session-stopped lifecycle so
// summarize + slot-reflect + graph extraction actually fire. Before this
// fix the `event::session::stopped` handler in events.ts was a dead
// subscriber — no code published `agentmemory.session.stopped`, so graph
// nodes / lessons / crystals never materialized despite the handler
// existing. Direct fire-and-forget trigger keeps the HTTP response fast
// (kv.update runs synchronously, downstream pipeline fan-outs without
// blocking).
describe("api::session::end → event::session::stopped (#666)", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("api::session::end fires event::session::stopped after kv.update", () => {
    expect(api).toMatch(
      /api::session::end[\s\S]*?kv\.update\(KV\.sessions[\s\S]*?function_id:\s*"event::session::stopped"/,
    );
  });

  it("event::session::stopped trigger payload includes sessionId", () => {
    expect(api).toMatch(
      /function_id:\s*"event::session::stopped",\s*payload:\s*\{\s*sessionId\s*\}/,
    );
  });

  it("event::session::stopped uses TriggerAction.Void for fire-and-forget", () => {
    expect(api).toMatch(
      /function_id:\s*"event::session::stopped"[\s\S]*?action:\s*TriggerAction\.Void\(\)/,
    );
  });
});

// #666: viewer's "Build Graph" button used to POST /agentmemory/graph/build
// which returned 404 because the endpoint was never registered. The
// endpoint now creates a persistent task; a separate process endpoint
// advances the backfill in bounded batches.
describe("api::graph-build endpoint (#666)", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("registers api::graph-build function", () => {
    expect(api).toMatch(/registerFunction\("api::graph-build"/);
  });

  it("registers HTTP trigger at /agentmemory/graph/build", () => {
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/build",\s*http_method:\s*"POST"/,
    );
  });

  it("creates a graph build task instead of doing the full build in the REST handler", () => {
    expect(api).toMatch(
      /sdk\.trigger\(\{\s*function_id:\s*"mem::graph-build-task-create"/,
    );
    const graphBuildHandler = api.match(
      /sdk\.registerFunction\("api::graph-build"[\s\S]*?sdk\.registerTrigger\(\{\s*type:\s*"http",\s*function_id:\s*"api::graph-build"/,
    )?.[0] ?? "";
    expect(graphBuildHandler).not.toMatch(/KV\.observations/);
    expect(graphBuildHandler).not.toMatch(/mem::graph-extract/);
  });

  it("registers process and task status endpoints", () => {
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/build\/process",\s*http_method:\s*"POST"/,
    );
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/build\/task",\s*http_method:\s*"GET"/,
    );
  });

  it("respects batchSize override with a 100-item upper bound", () => {
    expect(api).toMatch(/Math\.min\(100,\s*Number\(.*batchSize/);
  });

  it("whitelists task API payload fields", () => {
    expect(api).toMatch(/allowedGraphBuildCreateKeys/);
    expect(api).toMatch(/allowedGraphBuildProcessKeys/);
  });

  it("viewer advances graph build tasks instead of only creating them", () => {
    expect(viewer).toMatch(/async function runGraphBuildTask/);
    expect(viewer).toMatch(/apiPost\('graph\/build',\s*\{\}\)/);
    expect(viewer).toMatch(/apiPost\('graph\/build\/process',\s*\{\s*taskId:\s*taskId,\s*maxBatches:\s*1\s*\}\)/);
    expect(viewer).not.toMatch(/buildResult\.nodes/);
  });
});

// #666: `agentmemory status` showed Memories/Observations as 0 because it
// fetched /agentmemory/export which times out on iii-engine's file-based
// KV under concurrent kv.list() pressure. Switch to /memories for the
// memory count and derive observation count from sessions[].observationCount.
describe("agentmemory status no longer depends on /export (#666)", () => {
  const cli = readFileSync("src/cli.ts", "utf-8");

  it("status uses count-only memories endpoint instead of export", () => {
    expect(cli).toMatch(/apiFetch<any>\(base,\s*"memories\?count=true"\)/);
    expect(cli).not.toMatch(/apiFetch<any>\(base,\s*"export"\)/);
  });

  it("status derives obsCount from sessions[].observationCount", () => {
    expect(cli).toMatch(
      /sessionList\.reduce\([\s\S]*?observationCount/,
    );
  });

  it("status reads memCount from memoriesRes.latestCount (count endpoint)", () => {
    expect(cli).toMatch(/memoriesRes\?\.latestCount\s*\?\?\s*memoriesRes\?\.total/);
  });
});
