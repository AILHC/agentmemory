import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlText } from "../src/replay/jsonl-parser.js";
import { projectTimeline } from "../src/replay/timeline.js";

const fx = (name: string) =>
  readFileSync(join(__dirname, "fixtures/jsonl", name), "utf-8");

describe("parseJsonlText", () => {
  it("parses basic user/assistant exchange", () => {
    const out = parseJsonlText(fx("basic.jsonl"));
    expect(out.sessionId).toBe("sess-basic");
    expect(out.project).toBe("project");
    expect(out.cwd).toBe("/Users/alice/project");
    expect(out.observations).toHaveLength(2);
    expect(out.observations[0].hookType).toBe("prompt_submit");
    expect(out.observations[0].userPrompt).toBe("Fix the login bug");
    expect(out.observations[1].hookType).toBe("stop");
    expect(out.observations[1].assistantResponse).toBe("Looking into it now.");
  });

  it("parses tool_use + tool_result pairs", () => {
    const out = parseJsonlText(fx("tool-use.jsonl"));
    expect(out.sessionId).toBe("sess-tool");
    const kinds = out.observations.map((o) => o.hookType);
    expect(kinds).toEqual([
      "prompt_submit",
      "pre_tool_use",
      "post_tool_use",
      "stop",
    ]);
    const toolCall = out.observations[1];
    expect(toolCall.toolName).toBe("Bash");
    expect((toolCall.toolInput as { command: string }).command).toBe("ls");
    const toolResult = out.observations[2];
    expect(toolResult.toolOutput).toBe("README.md\nsrc\n");
  });

  it("tolerates malformed lines and marks tool errors", () => {
    const out = parseJsonlText(fx("errors.jsonl"));
    const errObs = out.observations.find((o) => o.hookType === "post_tool_failure");
    expect(errObs).toBeDefined();
    expect(errObs?.toolOutput).toBe("exit 1");
  });

  it("falls back to generated sessionId when missing", () => {
    const text = JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const out = parseJsonlText(text);
    expect(out.sessionId).toMatch(/^sess_/);
  });

  it("returns empty observations for blank input", () => {
    const out = parseJsonlText("");
    expect(out.observations).toHaveLength(0);
  });

  it("prefers the file's sessionId over the fallback", () => {
    const text = [
      JSON.stringify({
        type: "user",
        sessionId: "real-session-from-file",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
    ].join("\n");
    const out = parseJsonlText(text, "fallback-should-be-ignored");
    expect(out.sessionId).toBe("real-session-from-file");
    for (const obs of out.observations) {
      expect(obs.sessionId).toBe("real-session-from-file");
    }
  });

  it("returns the same sessionId across repeated parses of one file", () => {
    const text = JSON.stringify({
      type: "user",
      sessionId: "stable-id",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const a = parseJsonlText(text, "fb-1");
    const b = parseJsonlText(text, "fb-2");
    expect(a.sessionId).toBe("stable-id");
    expect(b.sessionId).toBe("stable-id");
  });

  it("uses the fallback only when the file has no sessionId", () => {
    const text = JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const out = parseJsonlText(text, "fb-used");
    expect(out.sessionId).toBe("fb-used");
  });
});

describe("projectTimeline", () => {
  it("preserves ordering and computes offsets from real timestamps", () => {
    const parsed = parseJsonlText(fx("tool-use.jsonl"));
    const tl = projectTimeline(parsed.observations);
    expect(tl.eventCount).toBe(4);
    expect(tl.events[0].kind).toBe("prompt");
    expect(tl.events[1].kind).toBe("tool_call");
    expect(tl.events[2].kind).toBe("tool_result");
    expect(tl.events[3].kind).toBe("response");
    expect(tl.events[0].offsetMs).toBe(0);
    expect(tl.events[3].offsetMs).toBeGreaterThan(0);
  });

  it("synthesizes pacing when all timestamps identical", () => {
    const parsed = parseJsonlText(fx("basic.jsonl"));
    for (const obs of parsed.observations) obs.timestamp = "2026-04-17T10:00:00.000Z";
    const tl = projectTimeline(parsed.observations);
    expect(tl.events[0].offsetMs).toBe(0);
    expect(tl.events[1].offsetMs).toBeGreaterThanOrEqual(300);
  });

  it("returns empty timeline for no observations", () => {
    const tl = projectTimeline([]);
    expect(tl.eventCount).toBe(0);
    expect(tl.totalDurationMs).toBe(0);
    expect(tl.events).toHaveLength(0);
  });

  it("marks errored tool results as tool_error kind", () => {
    const parsed = parseJsonlText(fx("errors.jsonl"));
    const tl = projectTimeline(parsed.observations);
    expect(tl.events.some((e) => e.kind === "tool_error")).toBe(true);
  });

  it("uses one shared fallback timestamp when metadata missing", () => {
    const text = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const out = parseJsonlText(text);
    expect(out.startedAt).toBe(out.endedAt);
  });

  it("returns a bounded page while keeping total event count", () => {
    const observations = Array.from({ length: 1200 }, (_value, index) => ({
      id: `obs-${index}`,
      sessionId: "sess-large",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      hookType: index % 2 === 0 ? "prompt_submit" : "stop",
      userPrompt: index % 2 === 0 ? `Prompt ${index}` : undefined,
      assistantResponse: index % 2 === 1 ? `Response ${index}` : undefined,
      raw: {},
    }));

    const timeline = projectTimeline(observations as any, { offset: 100, limit: 50 });

    expect(timeline.eventCount).toBe(1200);
    expect(timeline.events).toHaveLength(50);
    expect(timeline.events[0].id).toBe("obs-100");
    expect(timeline.page).toEqual({
      offset: 100,
      limit: 50,
      returned: 50,
      hasMore: true,
      nextOffset: 150,
    });
  });

  it("clamps pagination offset past the end to an empty page", () => {
    const parsed = parseJsonlText(fx("basic.jsonl"));
    const timeline = projectTimeline(parsed.observations, { offset: 99, limit: 10 });

    expect(timeline.eventCount).toBe(2);
    expect(timeline.events).toHaveLength(0);
    expect(timeline.page).toEqual({
      offset: 99,
      limit: 10,
      returned: 0,
      hasMore: false,
      nextOffset: null,
    });
  });

  it("normalizes zero limit to one so nextOffset always progresses", () => {
    const parsed = parseJsonlText(fx("basic.jsonl"));
    const timeline = projectTimeline(parsed.observations, { offset: 0, limit: 0 });

    expect(timeline.events).toHaveLength(1);
    expect(timeline.page).toEqual({
      offset: 0,
      limit: 1,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
    });
  });

  it("uses timestamp plus id ordering so pages do not overlap for identical timestamps", () => {
    const observations = ["b", "a", "c"].map((suffix) => ({
      id: `obs-${suffix}`,
      sessionId: "sess-same-ts",
      timestamp: "2026-01-01T00:00:00.000Z",
      hookType: "prompt_submit",
      userPrompt: `Prompt ${suffix}`,
      raw: {},
    }));

    const first = projectTimeline(observations as any, { offset: 0, limit: 2 });
    const second = projectTimeline(observations as any, { offset: 2, limit: 2 });

    expect(first.events.map((event) => event.id)).toEqual(["obs-a", "obs-b"]);
    expect(second.events.map((event) => event.id)).toEqual(["obs-c"]);
  });

  it("truncates large event fields in preview mode and reports truncation", () => {
    const large = "x".repeat(10_000);
    const observations = [{
      id: "obs-large",
      sessionId: "sess-large-fields",
      timestamp: "2026-01-01T00:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: large },
      toolOutput: large,
      raw: {},
    }];

    const timeline = projectTimeline(observations as any, {
      offset: 0,
      limit: 1,
      maxEventPayloadChars: 1200,
    });

    expect(JSON.stringify(timeline.events[0]).length).toBeLessThan(1800);
    expect(timeline.events[0].truncated?.toolInput).toBe(true);
    expect(timeline.events[0].truncated?.toolOutput).toBe(true);
  });
});
