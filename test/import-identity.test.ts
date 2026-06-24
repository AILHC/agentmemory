import { describe, expect, it } from "vitest";
import {
  buildObservationImportKey,
  buildReplaySourceIdentity,
  classifyClaudeLineage,
  classifyCodexLineage,
  computeSourceFileHash,
  resolveSourceSessionId,
} from "../src/replay/import-identity.js";

describe("replay import identity", () => {
  it("builds stable importKey and observation id from source event identity", () => {
    const context = {
      sourceFormat: "codex" as const,
      sourceFileHash: computeSourceFileHash("same jsonl text"),
    };

    const first = buildReplaySourceIdentity({
      context,
      sourceSessionId: "sess-real",
      sourceEventId: "event-1",
      sourceEventIndex: 3,
      hookType: "post_tool_use",
    });
    const second = buildReplaySourceIdentity({
      context,
      sourceSessionId: "sess-real",
      sourceEventId: "event-1",
      sourceEventIndex: 3,
      hookType: "post_tool_use",
    });

    expect(first.importKey).toBe(second.importKey);
    expect(first.observationId).toBe(first.importKey);
    expect(first.targetSessionId).toBe("sess-real");
  });

  it("hashes JSONL content independently of file path", () => {
    const text = [
      JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
    ].join("\n");

    expect(computeSourceFileHash(text)).toBe(computeSourceFileHash(`${text}`));
  });

  it("uses sourceFormat plus sourceFileHash for session fallback", () => {
    const sourceFileHash = computeSourceFileHash("no real session id");
    const first = resolveSourceSessionId({
      context: { sourceFormat: "claude-code", sourceFileHash },
    });
    const second = resolveSourceSessionId({
      context: { sourceFormat: "claude-code", sourceFileHash },
    });

    expect(first.sourceSessionId).toBe(first.targetSessionId);
    expect(first.sourceSessionId).toBe(second.sourceSessionId);
    expect(first.sourceSessionId).toMatch(/^sess_/);
  });

  it("recognizes Codex parent_thread_id as a child session", () => {
    expect(
      classifyCodexLineage({
        payload: { parent_thread_id: "parent-session" },
      }),
    ).toEqual({ lineage: "child", parentSessionId: "parent-session" });

    expect(
      classifyCodexLineage({
        payload: { meta: { parent_thread_id: "parent-meta-session" } },
      }),
    ).toEqual({ lineage: "child", parentSessionId: "parent-meta-session" });
  });

  it("only treats explicit Claude sidechain markers as sidechain", () => {
    expect(
      classifyClaudeLineage({
        isSidechain: true,
        parentUuid: "parent-event-only",
      }),
    ).toEqual({ lineage: "sidechain", parentSessionId: undefined });

    expect(
      classifyClaudeLineage({
        parentUuid: "parent-event-only",
      }),
    ).toEqual({ lineage: "top-level", parentSessionId: undefined });
  });

  it("builds observation import keys without paths, time, or random inputs", () => {
    const first = buildObservationImportKey({
      sourceFormat: "claude-code",
      sourceFileHash: "hash-1",
      sourceSessionId: "sess-1",
      sourceEventId: "event-1",
      sourceEventIndex: 0,
      hookType: "prompt_submit",
    });
    const second = buildObservationImportKey({
      sourceFormat: "claude-code",
      sourceFileHash: "hash-1",
      sourceSessionId: "sess-1",
      sourceEventId: "event-1",
      sourceEventIndex: 0,
      hookType: "prompt_submit",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^obs_/);
  });

  it("does not include sourceFileHash in observation import keys for real session events", () => {
    const first = buildObservationImportKey({
      sourceFormat: "codex",
      sourceFileHash: "old-file-hash",
      sourceSessionId: "real-session",
      sourceEventId: "same-event",
      sourceEventIndex: 0,
      hookType: "prompt_submit",
    });
    const second = buildObservationImportKey({
      sourceFormat: "codex",
      sourceFileHash: "new-overlap-file-hash",
      sourceSessionId: "real-session",
      sourceEventId: "same-event",
      sourceEventIndex: 0,
      hookType: "prompt_submit",
    });

    expect(first).toBe(second);
  });
});
