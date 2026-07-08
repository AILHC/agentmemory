import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSearchIndex,
  reindexSessions,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/search.js";
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
    setEmbeddingProvider(null);
    setVectorIndex(null);
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

  it("indexes each loaded session before loading the next one", async () => {
    const idx = getSearchIndex();
    const kv = {
      list: vi.fn(async (scope: string) => {
        if (scope === KV.observations("session-1")) {
          return [
            makeObservation({
              id: "obs-session-1",
              sessionId: "session-1",
              title: "alpha",
              narrative: "first session",
            }),
          ];
        }
        if (scope === KV.observations("session-2")) {
          if (!idx.has("obs-session-1")) {
            throw new Error("session observations were buffered before indexing");
          }
          return [
            makeObservation({
              id: "obs-session-2",
              sessionId: "session-2",
              title: "beta",
              narrative: "second session",
            }),
          ];
        }
        return [];
      }),
    } as unknown as StateKV;

    const result = await reindexSessions(kv, ["session-1", "session-2"]);

    expect(result).toEqual({ indexed: 2, failedSessionIds: [] });
    expect(idx.has("obs-session-1")).toBe(true);
    expect(idx.has("obs-session-2")).toBe(true);
  });

  it("can rebuild BM25 for replay imports without touching vectors", async () => {
    const idx = getSearchIndex();
    const removeBySession = vi.fn();
    const embedBatch = vi.fn();
    setVectorIndex({ removeBySession } as never);
    setEmbeddingProvider({
      name: "test-embedder",
      dimensions: 3,
      embed: vi.fn(),
      embedBatch,
    } as never);
    const kv = {
      list: vi.fn(async (scope: string) => {
        if (scope === KV.observations("session-1")) {
          return [
            makeObservation({
              id: "obs-session-1",
              sessionId: "session-1",
              title: "bm25",
              narrative: "replay import avoids vector work",
            }),
          ];
        }
        return [];
      }),
    } as unknown as StateKV;

    const result = await reindexSessions(kv, ["session-1"], {
      includeVector: false,
    });

    expect(result).toEqual({ indexed: 1, failedSessionIds: [] });
    expect(idx.has("obs-session-1")).toBe(true);
    expect(removeBySession).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it("can filter observations during targeted replay reindexing", async () => {
    const idx = getSearchIndex();
    const kv = {
      list: vi.fn(async (scope: string) => {
        if (scope === KV.observations("session-1")) {
          return [
            makeObservation({
              id: "prompt-obs",
              sessionId: "session-1",
              title: "prompt_submit",
              narrative: "user asked for a durable decision",
              type: "conversation",
            }),
            makeObservation({
              id: "tool-obs",
              sessionId: "session-1",
              title: "post_tool_use",
              narrative: "tool output should not enter replay BM25",
              type: "other",
            }),
          ];
        }
        return [];
      }),
    } as unknown as StateKV;

    const result = await reindexSessions(kv, ["session-1"], {
      includeVector: false,
      shouldIndex: (obs) => obs.type === "conversation",
    });

    expect(result).toEqual({ indexed: 1, failedSessionIds: [] });
    expect(idx.has("prompt-obs")).toBe(true);
    expect(idx.has("tool-obs")).toBe(false);
  });
});
