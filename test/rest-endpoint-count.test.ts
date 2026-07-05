import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf-8");
}

describe("REST endpoint count", () => {
  it("keeps api registration, index log, and README counts consistent", () => {
    const api = read("src/triggers/api.ts");
    const index = read("src/index.ts");
    const readme = read("README.md");

    const apiPaths = [...api.matchAll(/api_path:\s*["'`]([^"'`]+)["'`]/g)].map(
      (match) => match[1],
    );
    const apiCount = apiPaths.length;
    const indexCount = Number(index.match(/REST API:\s*(\d+) endpoints/)?.[1]);
    const readmeCount = Number(readme.match(/(\d+) endpoints on port/)?.[1]);

    expect(apiPaths).toContain("/agentmemory/semantic-rollup");
    expect(apiPaths).toContain("/agentmemory/extraction-runs/record");
    expect(apiPaths).toContain("/agentmemory/runtime-config");
    expect(apiCount).toBeGreaterThan(0);
    expect(indexCount).toBe(apiCount);
    expect(readmeCount).toBe(apiCount);
  });
});
