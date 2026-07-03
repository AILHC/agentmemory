import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAllTools } from "../src/mcp/tools-registry.js";
import { VERSION } from "../src/version.js";

const ROOT = join(import.meta.dirname, "..");

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

function countRestApiEndpoints(): number {
  const src = readText("src/triggers/api.ts");
  return Array.from(src.matchAll(/api_path:\s*["`]/g)).length;
}

function listRestApiEndpoints(): string[] {
  const src = readText("src/triggers/api.ts");
  const endpoints: string[] = [];
  for (const match of src.matchAll(/api_path:\s*["`]([^"`]+)["`]/g)) {
    const index = match.index ?? 0;
    const window = src.slice(Math.max(0, index - 140), index + 140);
    const method = /http_method:\s*["`]([A-Z]+)["`]/.exec(window)?.[1] ?? "POST";
    endpoints.push(`${method} ${match[1]}`);
  }
  return [...new Set(endpoints)].sort((a, b) => {
    const [, pathA] = a.split(" ");
    const [, pathB] = b.split(" ");
    return pathA === pathB ? a.localeCompare(b) : pathA.localeCompare(pathB);
  });
}

describe("Consistency checks", () => {
  const toolCount = getAllTools().length;
  const restEndpointCount = countRestApiEndpoints();

  it("version.ts matches package.json", () => {
    const pkg = JSON.parse(readText("package.json"));
    expect(VERSION).toBe(pkg.version);
  });

  it("plugin.json version matches package.json", () => {
    const pkg = JSON.parse(readText("package.json"));
    const plugin = JSON.parse(readText("plugin/.claude-plugin/plugin.json"));
    expect(plugin.version).toBe(pkg.version);
  });

  it("export-import.ts supports current version", () => {
    const src = readText("src/functions/export-import.ts");
    expect(src).toContain(`"${VERSION}"`);
  });

  it("README mentions correct MCP tool count", () => {
    const readme = readText("README.md");
    const toolCountPattern = new RegExp(`${toolCount}\\s+MCP tools`);
    expect(readme).toMatch(toolCountPattern);
    const toolResourcePattern = new RegExp(`${toolCount}\\s+tools,\\s+6\\s+resources`);
    expect(readme).toMatch(toolResourcePattern);
  });

  it("documented REST endpoint counts match registered API paths", () => {
    const readme = readText("README.md");
    const agents = readText("AGENTS.md");
    const index = readText("src/index.ts");

    expect(restEndpointCount).toBeGreaterThan(0);
    expect(readme).toContain(`${restEndpointCount} endpoints on port`);
    expect(agents).toContain(`${restEndpointCount} REST endpoints`);
    expect(index).toContain(`REST API: ${restEndpointCount} endpoints`);
  });

  it("REST skill reference matches registered method/path API endpoints", () => {
    const reference = readText("plugin/skills/agentmemory-rest-api/REFERENCE.md");
    const endpoints = listRestApiEndpoints();

    expect(reference).toContain(`${endpoints.length} registered endpoints`);
    for (const endpoint of endpoints) {
      const [method, path] = endpoint.split(" ");
      expect(reference).toContain(`| ${method} | \`${path}\` |`);
    }

    expect(reference).toContain("| GET | `/agentmemory/slot` |");
    expect(reference).toContain("| POST | `/agentmemory/slot` |");
    expect(reference).toContain("| DELETE | `/agentmemory/slot` |");
  });

  it("REST and MCP skills document task-style REST-only flows", () => {
    const restSkill = readText("plugin/skills/agentmemory-rest-api/SKILL.md");
    const mcpSkill = readText("plugin/skills/agentmemory-mcp-tools/SKILL.md");
    const taskFlowEndpoints = [
      "/agentmemory/graph/build",
      "/agentmemory/graph/build/process",
      "/agentmemory/graph/build/task",
      "/agentmemory/lessons/extract",
      "/agentmemory/lessons/extract/process",
      "/agentmemory/lessons/extract/runs",
      "/agentmemory/lessons/extract/run",
    ];

    for (const text of ["graph build task", "lessons extraction", ...taskFlowEndpoints]) {
      expect(restSkill).toContain(text);
    }

    expect(mcpSkill).toContain("REST-only");
    for (const endpoint of taskFlowEndpoints) {
      expect(mcpSkill).toContain(endpoint);
    }
  });

  it("all tool names are unique", () => {
    const tools = getAllTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
  });

  it("all tools have name, description, and inputSchema", () => {
    for (const tool of getAllTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("every host-path bind mount in docker-compose.yml is in the published files list (#136)", () => {
    // Regression guard for #136: docker-compose.yml references
    // ./iii-config.docker.yaml as a read-only bind mount, but the file
    // was missing from the published tarball. Docker silently creates
    // missing bind sources as empty directories, so the engine crashed
    // with "Is a directory (os error 21)" at /app/config.yaml.
    const compose = readText("docker-compose.yml");
    const pkg = JSON.parse(readText("package.json"));
    const files: string[] = pkg.files ?? [];

    // Match `./<path>:<container-path>` style bind mounts. We only care
    // about files that live in the repo root (so they'd be shipped via
    // the `files` field). `iii-data:/data` (a named volume) has no `./`
    // prefix and is correctly skipped.
    const bindRe = /^\s*-\s+\.\/([^\s:]+):[^\s]+/gm;
    const sources: string[] = [];
    for (const m of compose.matchAll(bindRe)) sources.push(m[1]!);

    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      // Any nested path would need a directory entry in `files` (e.g.
      // `dist/`); for top-level files, the exact name must be listed.
      const topLevel = src.split("/")[0]!;
      const covered =
        files.includes(src) ||
        files.includes(topLevel) ||
        files.includes(`${topLevel}/`);
      expect(
        covered,
        `docker-compose.yml mounts ./${src} but package.json "files" does not ship it — ${topLevel} would be auto-created as an empty dir on install, breaking \`npx @agentmemory/agentmemory\``,
      ).toBe(true);
    }
  });
});
