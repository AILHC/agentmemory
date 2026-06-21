import type { RawObservation } from "../types.js";

export type TimelineEventKind =
  | "prompt"
  | "response"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "hook"
  | "session_start"
  | "session_end";

export interface TimelineEvent {
  id: string;
  sessionId: string;
  ts: string;
  offsetMs: number;
  durationMs: number;
  kind: TimelineEventKind;
  label: string;
  body?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  truncated?: TimelineEventTruncation;
}

export interface TimelineEventTruncation {
  body?: boolean;
  toolInput?: boolean;
  toolOutput?: boolean;
}

export interface Timeline {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  totalDurationMs: number;
  eventCount: number;
  events: TimelineEvent[];
  page?: TimelinePage;
}

export interface TimelinePage {
  offset: number;
  limit: number | null;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface ProjectTimelineOptions {
  offset?: number;
  limit?: number | null;
  maxEventPayloadChars?: number | null;
}

const DEFAULT_CHARS_PER_SEC = 40;
const MIN_EVENT_MS = 300;
const MAX_EVENT_MS = 20_000;
const DEFAULT_MAX_EVENT_PAYLOAD_CHARS = 1200;

function kindFromHook(obs: RawObservation): TimelineEventKind {
  switch (obs.hookType) {
    case "session_start":
      return "session_start";
    case "session_end":
      return "session_end";
    case "prompt_submit":
      return "prompt";
    case "stop":
      return obs.assistantResponse ? "response" : "hook";
    case "pre_tool_use":
      return "tool_call";
    case "post_tool_use":
      return "tool_result";
    case "post_tool_failure":
      return "tool_error";
    default:
      return "hook";
  }
}

function labelFor(obs: RawObservation, kind: TimelineEventKind): string {
  switch (kind) {
    case "prompt":
      return truncate(obs.userPrompt || "User prompt", 80);
    case "response":
      return truncate(obs.assistantResponse || "Assistant response", 80);
    case "tool_call":
      return `${obs.toolName || "tool"} ▸ call`;
    case "tool_result":
      return `${obs.toolName || "tool"} ▸ result`;
    case "tool_error":
      return `${obs.toolName || "tool"} ▸ error`;
    case "session_start":
      return "Session start";
    case "session_end":
      return "Session end";
    default:
      return obs.hookType;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function bodyFor(obs: RawObservation, kind: TimelineEventKind): string | undefined {
  if (kind === "prompt") return obs.userPrompt;
  if (kind === "response") return obs.assistantResponse;
  return undefined;
}

function normalizePageOptions(
  options: ProjectTimelineOptions | undefined,
  total: number,
): { offset: number; limit: number | null } {
  const rawOffset = Number.isFinite(options?.offset)
    ? Math.trunc(options!.offset!)
    : 0;
  const offset = Math.max(0, rawOffset);

  if (options?.limit === null || options?.limit === undefined) {
    return { offset, limit: null };
  }

  const rawLimit = Number.isFinite(options.limit)
    ? Math.trunc(options.limit)
    : total;
  return { offset, limit: Math.max(1, rawLimit) };
}

function previewValue(
  value: unknown,
  maxChars: number,
): { value: unknown; truncated: boolean } {
  if (value === undefined || value === null) return { value, truncated: false };
  const asString =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (asString.length <= maxChars) return { value, truncated: false };
  return {
    value: asString.slice(0, Math.max(0, maxChars - 32)) + "\n...[truncated for replay preview]",
    truncated: true,
  };
}

function estimateDurationMs(ev: TimelineEvent): number {
  const chars =
    (ev.body?.length || 0) +
    (typeof ev.toolInput === "string" ? ev.toolInput.length : 0) +
    (typeof ev.toolOutput === "string" ? ev.toolOutput.length : 0);
  if (chars === 0) return MIN_EVENT_MS;
  const ms = Math.round((chars / DEFAULT_CHARS_PER_SEC) * 1000);
  return Math.max(MIN_EVENT_MS, Math.min(MAX_EVENT_MS, ms));
}

export function projectTimeline(
  observations: RawObservation[],
  options: ProjectTimelineOptions = {},
): Timeline {
  if (observations.length === 0) {
    const now = new Date().toISOString();
    const pageOptions = normalizePageOptions(options, 0);
    return {
      sessionId: "",
      startedAt: now,
      endedAt: now,
      totalDurationMs: 0,
      eventCount: 0,
      events: [],
      page: {
        offset: pageOptions.offset,
        limit: pageOptions.limit,
        returned: 0,
        hasMore: false,
        nextOffset: null,
      },
    };
  }

  const sorted = [...observations].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  );

  const startedAt = sorted[0].timestamp;
  const startMs = Date.parse(startedAt);
  const maxEventPayloadChars = options.maxEventPayloadChars === null
    ? null
    : Math.max(200, Math.trunc(options.maxEventPayloadChars ?? DEFAULT_MAX_EVENT_PAYLOAD_CHARS));
  const events: TimelineEvent[] = [];

  let syntheticOffset = 0;
  const allSameTs = sorted.every((o) => o.timestamp === startedAt);

  for (const obs of sorted) {
    const kind = kindFromHook(obs);
    const body = bodyFor(obs, kind);
    const obsMs = Date.parse(obs.timestamp);
    const offsetMs = allSameTs
      ? syntheticOffset
      : Number.isFinite(obsMs) && Number.isFinite(startMs)
        ? Math.max(0, obsMs - startMs)
        : syntheticOffset;

    const event: TimelineEvent = {
      id: obs.id,
      sessionId: obs.sessionId,
      ts: obs.timestamp,
      offsetMs,
      durationMs: 0,
      kind,
      label: labelFor(obs, kind),
      body,
      toolName: obs.toolName,
      toolInput: obs.toolInput,
      toolOutput: obs.toolOutput,
    };
    if (maxEventPayloadChars !== null) {
      const perFieldBudget = Math.max(100, Math.floor(maxEventPayloadChars / 3));
      const bodyPreview = previewValue(event.body, perFieldBudget);
      const inputPreview = previewValue(event.toolInput, perFieldBudget);
      const outputPreview = previewValue(event.toolOutput, perFieldBudget);

      event.body = bodyPreview.value as string | undefined;
      event.toolInput = inputPreview.value;
      event.toolOutput = outputPreview.value;

      if (bodyPreview.truncated || inputPreview.truncated || outputPreview.truncated) {
        event.truncated = {
          body: bodyPreview.truncated || undefined,
          toolInput: inputPreview.truncated || undefined,
          toolOutput: outputPreview.truncated || undefined,
        };
      }
    }

    event.durationMs = estimateDurationMs(event);
    events.push(event);
    syntheticOffset += event.durationMs;
  }

  const last = events[events.length - 1];
  const totalDurationMs = last.offsetMs + last.durationMs;

  const pageOptions = normalizePageOptions(options, events.length);
  const pagedEvents =
    pageOptions.limit === null
      ? events.slice(pageOptions.offset)
      : events.slice(pageOptions.offset, pageOptions.offset + pageOptions.limit);
  const returned = pagedEvents.length;
  const nextOffset = pageOptions.offset + returned;
  const hasMore = nextOffset < events.length;

  return {
    sessionId: sorted[0].sessionId,
    startedAt,
    endedAt: sorted[sorted.length - 1].timestamp,
    totalDurationMs,
    eventCount: events.length,
    events: pagedEvents,
    page: {
      offset: pageOptions.offset,
      limit: pageOptions.limit,
      returned,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    },
  };
}
