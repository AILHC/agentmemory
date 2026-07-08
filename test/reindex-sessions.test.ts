import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSearchIndex, reindexSessions } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { StateKV } from "../src/state/kv.js";
import type { CompressedObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeObservation(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs-1",
    sessionId: "session-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "conversation",
    title: "keep",
    subtitle: "",
    facts: [],
    narrative: "old index entry should remain",
    concepts: [],
    files: [],
    importance: 5,
    ...overrides,
  };
}

describe("reindexSessions", () => {
  beforeEach(() => {
    getSearchIndex().clear();
  });

  it("does not remove existing index entries when loading session observations fails", async () => {
    const idx = getSearchIndex();
    idx.add(
      makeObservation({
        id: "stale-target",
        sessionId: "session-read-fails",
        title: "keep",
        narrative: "old index entry should remain",
      }),
    );

    const kv = {
      list: vi.fn(async (scope: string) => {
        if (scope === KV.observations("session-read-fails")) {
          throw new Error("read failed");
        }
        return [];
      }),
    } as unknown as StateKV;

    const result = await reindexSessions(kv, ["session-read-fails"]);

    expect(result.failedSessionIds).toEqual(["session-read-fails"]);
    expect(idx.has("stale-target")).toBe(true);
  });
});
