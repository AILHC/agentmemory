import { afterEach, describe, expect, it, vi } from "vitest";
import * as vm from "node:vm";
import { renderViewerDocument } from "../src/viewer/document.js";

type Listener = (event: { type: string; target: MockElement; isComposing?: boolean }) => void | Promise<void>;

type ParsedTag = {
  tag: string;
  attrs: Map<string, string>;
};

type MockApiRoute = (route: string, params: Map<string, string>) => { items?: unknown[]; total?: number; hasMore?: boolean; returned?: number; success?: boolean; categories?: Record<string, unknown> } | Promise<{ items?: unknown[]; total?: number; hasMore?: boolean; returned?: number; success?: boolean; categories?: Record<string, unknown> }>;

function parseTagAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z0-9-_:.]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const key = match[1];
    const value = (match[2] || match[3] || match[4] || "").trim();
    if (key && value !== null) {
      attrs.set(key, value);
    }
  }
  return attrs;
}

function parseTags(html: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  const tagRe = /<([a-zA-Z0-9-]+)\s+([^>]*?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const attrsText = match[2] || "";
    const selfClosing = /\/\s*$/.test(match[0]);
    if (!selfClosing && match[1] === "script") continue;
    tags.push({
      tag: match[1],
      attrs: parseTagAttributes(attrsText),
    });
  }
  return tags;
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class MockElement {
  id = "";
  tagName = "";
  textContent = "";
  value = "";
  className = "";
  scrollTop = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  parent: MockElement | null = null;
  private readonly children: MockElement[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private html = "";
  private readonly document: MockDocument;

  constructor(document: MockDocument, id = "", tagName = "") {
    this.document = document;
    this.id = id;
    this.tagName = tagName;
  }

  set _rawHtml(value: string) {
    this.html = value;
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = String(value ?? "");
    if (this.document) {
      this.document.syncIdsFromHtml(this, this.html);
    }
  }

  get parentElement(): MockElement | null {
    return this.parent;
  }

  appendChild(child: MockElement): MockElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  contains(node: MockElement | null): boolean {
    if (!node) return false;
    let current: MockElement | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  getAttribute(name: string): string {
    return this.attrs.get(name) || "";
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  setParsedAttributes(attrs: Map<string, string>): void {
    attrs.forEach((value, key) => {
      this.attrs.set(key, value);
    });
    const classAttr = this.attrs.get("class") || "";
    this.className = classAttr;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  async dispatchEvent(event: { type: string; target: MockElement }): Promise<void> {
    const list = this.listeners.get(event.type) || [];
    await Promise.all(list.map((listener) => listener(event)));
    await flushReviewerTasks();
  }

  closest(selector: string): MockElement | null {
    let node: MockElement | null = this;
    while (node) {
      if (node.matches(selector)) {
        return node;
      }
      node = node.parent;
    }
    return null;
  }

  matches(selector: string): boolean {
    if (selector === 'input[data-ui="filter"]') {
      return this.tagName.toLowerCase() === "input" && this.attrs.get("data-ui") === "filter";
    }
    if (selector === "[data-ui]") {
      return this.attrs.has("data-ui");
    }
    const dataMatch = selector.match(/^\[data-ui=(['"])(.*?)\1\]$/);
    if (dataMatch) {
      return this.attrs.get("data-ui") === dataMatch[2];
    }
    const classMatch = selector.match(/^\[class=(['"])(.*?)\1\]$/);
    if (classMatch) {
      return (this.attrs.get("class") || "").trim() === classMatch[2];
    }
    const tagAttributeMatch = selector.match(/^([a-zA-Z0-9-]+)\[([a-zA-Z0-9-_:.]+)=(['"])(.*?)\3\]$/);
    if (tagAttributeMatch) {
      return this.tagName.toLowerCase() === tagAttributeMatch[1].toLowerCase()
        && this.attrs.get(tagAttributeMatch[2]) === tagAttributeMatch[4];
    }
    return false;
  }

  querySelectorAll(selector: string): MockElement[] {
    const all = parseTags(this.html).map((node) => {
      const element = new MockElement(this.document, "", node.tag);
      element.parent = this;
      element.setParsedAttributes(node.attrs);
      element.value = node.attrs.get("value") || "";
      element.selectionStart = element.value.length;
      element.selectionEnd = element.value.length;
      return element;
    }).filter((node) => node.matches(selector));
    return all;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus(): void {
    this.document.activeElement = this;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class MockDocument {
  activeElement: MockElement | null = null;
  private readonly nodes = new Map<string, MockElement>();
  private readonly listeners = new Map<string, Listener[]>();

  createRoot(id: string): MockElement {
    const node = new MockElement(this, id);
    this.nodes.set(id, node);
    return node;
  }

  getElementById(id: string): MockElement | null {
    return this.nodes.get(id) || null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(type: string, target: MockElement, extra: { isComposing?: boolean } = {}): void {
    const list = this.listeners.get(type) || [];
    list.forEach((listener) => listener({ type, target, ...extra }));
  }

  async dispatchAndWait(type: string, target: MockElement, extra: { isComposing?: boolean } = {}): Promise<void> {
    const list = this.listeners.get(type) || [];
    await Promise.all(list.map((listener) => listener({ type, target, ...extra })));
    await flushReviewerTasks();
  }

  querySelectorAll(selector: string): MockElement[] {
    const all: MockElement[] = [];
    this.nodes.forEach((node) => {
      all.push(...node.querySelectorAll(selector));
    });
    return all;
  }

  syncIdsFromHtml(container: MockElement, html: string): void {
    parseTags(html).forEach((node) => {
      const id = node.attrs.get("id");
      if (!id) return;
      const current = this.nodes.get(id);
      const next = current || new MockElement(this, id);
      next.tagName = node.tag;
      next.parent = container;
      next.setParsedAttributes(node.attrs);
      const escapedId = escapeRegExp(id);
      const openMatch = html.match(new RegExp(`<${node.tag}\\b[^>]*\\sid=["']${escapedId}["'][^>]*>`, "i"));
      if (openMatch && openMatch.index !== undefined) {
        const tagOpenEnd = openMatch.index + openMatch[0].length;
        const tokenRe = /<\/?([a-zA-Z0-9-]+)\b[^>]*>/g;
        tokenRe.lastIndex = tagOpenEnd;
        let depth = 1;
        let matchedCloseIndex = -1;
        let token: RegExpExecArray | null;
        while ((token = tokenRe.exec(html)) !== null) {
          const tokenName = token[1].toLowerCase();
          if (tokenName !== node.tag.toLowerCase()) {
            continue;
          }
          const isClose = token[0].charAt(1) === "/";
          const isSelfClosed = /\/\s*>$/.test(token[0]);
          if (isClose) {
            depth -= 1;
            if (depth === 0) {
              matchedCloseIndex = token.index;
              break;
            }
          } else if (!isSelfClosed) {
            depth += 1;
          }
        }
        if (matchedCloseIndex >= 0) {
          next.innerHTML = html.slice(tagOpenEnd, matchedCloseIndex);
        } else {
          next.innerHTML = "";
        }
      } else {
        next.innerHTML = "";
      }
      this.nodes.set(id, next);
    });

    const stack: MockElement[] = [container];
    const tokenRe = /<\/?([a-zA-Z0-9-]+)\b([^>]*)>/g;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(html)) !== null) {
      const isClose = token[0].charAt(1) === "/";
      if (isClose) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = parseTagAttributes(token[2] || "");
      const id = attrs.get("id") || "";
      const element = id ? this.nodes.get(id) || new MockElement(this, id, token[1]) : new MockElement(this, "", token[1]);
      element.tagName = token[1];
      element.parent = stack[stack.length - 1] || container;
      element.setParsedAttributes(attrs);
      if (id) this.nodes.set(id, element);
      const selfClosing = /\/\s*>$/.test(token[0]) || ["input", "br", "hr", "img", "meta", "link"].includes(token[1].toLowerCase());
      if (!selfClosing) stack.push(element);
    }
  }
}

async function flushReviewerTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type StoreRequest = {
  limit: string | null;
  cursor: string | null;
  query: string | null;
  sessionId: string | null;
};

function reviewApi(options: {
  lessonTotal?: number;
  lessonPageSize?: number;
  lessonSessionId?: string;
  lessonSessionIds?: string[];
  sessionTotal?: number;
  summaryTotal?: number;
} = {}) {
  const requests: Array<{ route: string; type: string; params: StoreRequest }> = [];
  const responses: Array<{ route: string; type: string; total: number; returned: number; bodyBytes: number }> = [];
  const lessonTotal = options.lessonTotal ?? 3;
  const sessionTotal = options.sessionTotal ?? 2;
  const summaryTotal = options.summaryTotal ?? sessionTotal;
  const lessons = Array.from({ length: lessonTotal }, (_, index) => ({
    id: `lesson-${index + 1}`,
    name: `Lesson ${index + 1}`,
    content: `lesson-${index + 1}`,
    ...(options.lessonSessionId
      ? { sessionId: options.lessonSessionId }
      : options.lessonSessionIds?.length
        ? { sessionId: options.lessonSessionIds[index % options.lessonSessionIds.length] }
        : {}),
  }));
  const sessions = Array.from({ length: sessionTotal }, (_, index) => ({
    id: `session-${index + 1}`,
    firstPrompt: `Session ${index + 1}`,
    observationCount: index,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const summaries = Array.from({ length: summaryTotal }, (_, index) => ({
    id: `summary-${index + 1}`,
    sessionId: `session-${index + 1}`,
    narrative: `Summary ${index + 1}`,
  }));
  const stores: Record<string, unknown[]> = { lessons, sessions, summaries };

  const fetch = async (input: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    const url = new URL(input);
    const route = url.pathname.replace(/^\/+agentmemory\//, "");
    if (route !== "viewer/store") {
      requests.push({ route, type: "", params: { limit: null, cursor: null, query: null, sessionId: null } });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    const type = url.searchParams.get("type") || "";
    const params = {
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      query: url.searchParams.get("query"),
      sessionId: url.searchParams.get("sessionId"),
    };
    requests.push({ route, type, params });
    const source = stores[type] || [];
    const scoped = params.sessionId
      ? source.filter((item) => (item as { sessionId?: string; id?: string }).sessionId === params.sessionId || (type === "sessions" && (item as { id?: string }).id === params.sessionId))
      : source;
    const queried = params.query
      ? scoped.filter((item) => JSON.stringify(item).toLowerCase().includes(params.query!.toLowerCase()))
      : scoped;
    const offset = Number(params.cursor || 0);
    const limit = Number(params.limit || options.lessonPageSize || 50);
    const items = queried.slice(offset, offset + limit);
    const payload = { items, total: queried.length, returned: items.length, hasMore: offset + items.length < queried.length };
    responses.push({
      route,
      type,
      total: payload.total,
      returned: payload.returned,
      bodyBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    });
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  };

  return {
    fetch,
    storeRequests: (type: string) => requests.filter((request) => request.route === "viewer/store" && request.type === type).map((request) => request.params),
    requestsFor: (route: string) => requests.filter((request) => request.route === route),
    responseMetadata: () => responses.map((entry) => ({ ...entry })),
  };
}

function reviewApiWithDeferredSessionResponses() {
  const base = reviewApi({ sessionTotal: 120, summaryTotal: 120 });
  const pending: Array<{
    query: string;
    input: string;
    resolve: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
  }> = [];
  return {
    ...base,
    fetch(input: string) {
      const url = new URL(input);
      const query = url.searchParams.get("query");
      if (url.searchParams.get("type") !== "sessions" || !query) return base.fetch(input);
      return new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
        pending.push({ query, input, resolve });
      });
    },
    searchRequests: () => pending.map((request) => request.query),
    async resolveAt(index: number, items: unknown[]) {
      const request = pending[index];
      if (!request) throw new Error(`pending request missing: ${index}`);
      const response = await base.fetch(request.input);
      request.resolve({
        ...response,
        json: async () => ({ items, total: items.length, returned: items.length, hasMore: false }),
      });
    },
  };
}

function reviewApiWithDeferredResponses() {
  const base = reviewApi({ lessonTotal: 3 });
  const pending: Array<{
    query: string;
    resolve: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
  }> = [];
  return {
    ...base,
    fetch(input: string) {
      const url = new URL(input);
      const query = url.searchParams.get("query");
      if (url.searchParams.get("type") !== "lessons" || !query) return base.fetch(input);
      return new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
        pending.push({ query, resolve });
      });
    },
    searchRequests: () => pending.map((request) => request.query),
    resolveNewest(items: unknown[]) {
      const request = pending.at(-1);
      request?.resolve({ ok: true, status: 200, json: async () => ({ items, total: items.length, returned: items.length, hasMore: false }) });
    },
    resolveOldest(items: unknown[]) {
      const request = pending[0];
      request?.resolve({ ok: true, status: 200, json: async () => ({ items, total: items.length, returned: items.length, hasMore: false }) });
    },
    resolveAt(index: number, items: unknown[]) {
      const request = pending[index];
      request?.resolve({ ok: true, status: 200, json: async () => ({ items, total: items.length, returned: items.length, hasMore: false }) });
    },
  };
}

function buildMockFetch(payloads: {
  sessions: unknown[];
  summaries: unknown[];
  lessons: unknown[];
  stats: { success: boolean; sessionId: string; categories: Record<string, unknown> };
}) {
  let pendingResolveStats: ((value: unknown) => void) | null = null;
  const statsPromise = new Promise((resolve) => {
    pendingResolveStats = resolve as (value: unknown) => void;
  });

  const routes: Map<string, MockApiRoute> = new Map([
    [
      "viewer/store",
      (route: string, params: Map<string, string>) => {
        const type = params.get("type") || "";
        if (type === "sessions") {
          return { items: payloads.sessions, total: payloads.sessions.length, returned: payloads.sessions.length, hasMore: false };
        }
        if (type === "summaries") {
          const items = params.get("sessionId")
            ? payloads.summaries.filter((item) => (item as { sessionId?: string }).sessionId === params.get("sessionId"))
            : payloads.summaries;
          return { items, total: items.length, returned: items.length, hasMore: false };
        }
        if (type === "lessons" && params.get("sessionId") === "session-b") {
          return { items: payloads.lessons, total: payloads.lessons.length, returned: payloads.lessons.length, hasMore: false };
        }
        return { items: [], total: 0, returned: 0, hasMore: false };
      },
    ],
    [
      "viewer/stores",
      (_route: string, _params: Map<string, string>) => {
        return { items: [], total: 0, returned: 0, hasMore: false };
      },
    ],
    [
      "viewer/session-stats",
      async () => {
        await statsPromise;
        return payloads.stats;
      },
    ],
  ]);

  const fetch = async (input: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    const url = new URL(input);
    const path = `${url.pathname.replace(/^\/+/, "")}${url.search}`.replace(/^agentmemory\//, "");
    const route = path.startsWith("viewer/session-stats") ? "viewer/session-stats" : path.startsWith("viewer/store") ? "viewer/store" : "viewer/stores";
    const params = url.searchParams;
    const handler = routes.get(route);
    if (!handler) {
      return { ok: false, status: 404, json: async () => ({ success: false }) };
    }
    const payload = await handler(route, params);
    return { ok: true, status: 200, json: async () => payload };
  };

  return {
    fetch,
    resolveStats: (payload: unknown) => {
      if (!pendingResolveStats) return false;
      pendingResolveStats(payload);
      pendingResolveStats = null;
      return true;
    },
  };
}

function createReviewSandbox(apiOverride?: ReturnType<typeof reviewApi>) {
  const rendered = renderViewerDocument("review");
  expect(rendered.found).toBe(true);
  if (!rendered.found) throw new Error("review html not found");

  const scriptMatch = rendered.html.match(/<script nonce=\"[^\"]+\">([\s\S]*?)<\/script>/);
  expect(scriptMatch).not.toBeNull();
  if (!scriptMatch) throw new Error("review script missing");

  const document = new MockDocument();
  const rootTabs = document.createRoot("tabs");
  const rootStatus = document.createRoot("status-line");
  const rootApp = document.createRoot("app");
  const rootShell = document.createRoot("shell");
  const rootDetailDrawer = document.createRoot("detail-drawer-root");
  rootShell._rawHtml = "";
  rootTabs._rawHtml = "";
  rootStatus._rawHtml = "";
  rootApp._rawHtml = "";
  rootDetailDrawer._rawHtml = "";

  const api = apiOverride || buildMockFetch({
    sessions: [
      { id: "session-a", observationCount: 2, firstPrompt: "first prompt", startedAt: "2026-01-01T00:00:00Z" },
      { id: "session-b", observationCount: 1, firstPrompt: "second prompt", startedAt: "2026-02-01T00:00:00Z" },
    ],
    summaries: [
      { id: "summary-a", sessionId: "session-a", narrative: "summary a" },
      { id: "summary-b", sessionId: "session-b", narrative: "summary b" },
    ],
    lessons: [
      { id: "lesson-1", name: "first lesson", content: "lesson-a", sessionId: "session-b" },
      { id: "lesson-2", name: "second lesson", content: "lesson-b", sessionId: "session-b" },
      { id: "lesson-3", name: "third lesson", content: "lesson-c", sessionId: "session-b" },
    ],
    stats: {
      success: true,
      sessionId: "session-b",
      categories: {
        summary: { count: 1, status: "complete", source: "mem:summaries" },
        observations: { count: 4, status: "complete", source: "mem:sessions.observationCount" },
        lessons: { count: 3, status: "complete", source: "mem:lessons" },
        semantic: { count: 0, status: "complete", source: "mem:semantic" },
        procedural: { count: 0, status: "complete", source: "mem:procedural" },
        crystals: { count: 0, status: "complete", source: "mem:crystals" },
        insights: { count: 0, status: "complete", source: "mem:insights" },
      },
    },
  });

  const renderEvents: Array<Record<string, unknown>> = [];
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    document,
    window: {
      __agentmemoryReviewDebug: {
        render(payload: Record<string, unknown>) {
          renderEvents.push(payload);
        },
      },
      location: {
        origin: "http://localhost:3113",
        hash: "",
      },
      addEventListener: (type: string, handler: Listener) => {
        document.addEventListener(type, handler);
      },
      dispatchEvent: (type: string, target: MockElement) => {
        document.dispatchEvent(type, target);
      },
    },
    history: {
      replaceState: () => {},
    },
    location: {
      hash: "",
      pathname: "/agentmemory/viewer/review",
    },
    fetch: api.fetch,
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    Element: MockElement,
    Math,
    Object,
    Array,
    String,
    Number,
    JSON,
    URL,
    URLSearchParams,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };

  vm.createContext(sandbox as unknown as Record<string, unknown>);
  vm.runInContext(scriptMatch[1], sandbox as unknown as Record<string, unknown>);

  return { document, renderEvents, api, sandbox };
}

function click(sandbox: ReturnType<typeof createReviewSandbox>["sandbox"], target: MockElement | null): void {
  if (!target) return;
  sandbox.window.dispatchEvent("click", target);
}

async function clickAndWait(document: MockDocument, target: MockElement | null): Promise<void> {
  if (!target) throw new Error("click target missing");
  await document.dispatchAndWait("click", target);
  await waitFor(() => true);
}

async function bootReviewer(api: ReturnType<typeof reviewApi>) {
  const app = createReviewSandbox(api);
  await waitFor(() => !String(app.document.getElementById("app")?.innerHTML).includes("Loading sessions..."));
  return app;
}

async function clickTab(app: Awaited<ReturnType<typeof bootReviewer>>, tab: string): Promise<void> {
  const target = app.document.getElementById("tabs")?.querySelectorAll('[data-ui="tab"]')
    .find((item) => item.getAttribute("data-tab") === tab) || null;
  await clickAndWait(app.document, target);
}

function typeSearch(app: Awaited<ReturnType<typeof bootReviewer>>, key: string, value: string, isComposing = false): MockElement {
  const input = app.document.querySelectorAll('input[data-ui="filter"]')
    .find((item) => item.getAttribute("data-key") === key);
  if (!input) throw new Error(`search input missing: ${key}`);
  input.value = value;
  input.selectionStart = value.length;
  input.selectionEnd = value.length;
  app.document.dispatchEvent("input", input, { isComposing });
  return input;
}

function useFakeTimersInSandbox(app: Awaited<ReturnType<typeof bootReviewer>>): void {
  vi.useFakeTimers();
  app.sandbox.setTimeout = setTimeout;
  app.sandbox.clearTimeout = clearTimeout;
}

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await flushPromises();
  }
  throw new Error("wait condition not met");
}

describe("review viewer interaction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("enforces the isolated reviewer request, DOM, debounce, and response-size contract", async () => {
    const api = reviewApi({ sessionTotal: 4016, summaryTotal: 4016, lessonTotal: 15000 });
    const app = await bootReviewer(api);
    await waitFor(() => api.storeRequests("summaries").length === 1);

    expect(api.requestsFor("viewer/stores")).toHaveLength(0);
    expect(api.requestsFor("viewer/session-stats")).toHaveLength(0);
    expect(api.storeRequests("sessions")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: null },
    ]);
    expect(api.storeRequests("summaries").filter((request) => request.sessionId === null)).toHaveLength(0);

    const sessionRows = app.document.getElementById("session-list-rows")!;
    const sessionTools = app.document.getElementById("session-list-tools")!;
    const sessionPager = app.document.getElementById("session-list-pager")!;
    expect(sessionRows.querySelectorAll('[data-ui="select-session"]').length).toBeLessThanOrEqual(50);
    expect(sessionRows.contains(sessionTools)).toBe(false);
    expect(sessionRows.contains(sessionPager)).toBe(false);

    const initialResponses = api.responseMetadata();
    expect(initialResponses).toHaveLength(2);
    expect(initialResponses.every((entry) => entry.bodyBytes > 0)).toBe(true);
    expect(initialResponses.reduce((bytes, entry) => bytes + entry.bodyBytes, 0)).toBeGreaterThan(0);
    initialResponses.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual(["bodyBytes", "returned", "route", "total", "type"].sort());
      expect(entry.returned).toBeLessThanOrEqual(50);
    });

    await clickTab(app, "lessons");
    expect(api.storeRequests("lessons")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: null },
    ]);
    const lessonResponses = api.responseMetadata().filter((entry) => entry.type === "lessons");
    expect(lessonResponses).toHaveLength(1);
    expect(lessonResponses[0]).toMatchObject({ total: 15000, returned: 50 });
    expect(lessonResponses[0].bodyBytes).toBeGreaterThan(0);

    const lessonRows = app.document.getElementById("tab-list-rows")!;
    const lessonTools = app.document.getElementById("tab-list-tools")!;
    const lessonPager = app.document.getElementById("tab-list-pager")!;
    expect(lessonRows.querySelectorAll('[data-ui="select-item"]').length).toBeLessThanOrEqual(50);
    expect(lessonRows.contains(lessonTools)).toBe(false);
    expect(lessonRows.contains(lessonPager)).toBe(false);

    useFakeTimersInSandbox(app);
    ["l", "le", "les", "less", "lesso", "lesson"].forEach((value) => {
      typeSearch(app, "lessons", value);
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(api.storeRequests("lessons").filter((request) => request.query !== null)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushReviewerTasks();
    expect(api.storeRequests("lessons").filter((request) => request.query !== null)).toEqual([
      { limit: "50", cursor: "0", query: "lesson", sessionId: null },
    ]);
    expect(api.storeRequests("sessions")).toHaveLength(1);
    expect(api.storeRequests("summaries")).toHaveLength(1);
    ["observations", "semantic", "procedural", "crystals", "insights"].forEach((type) => {
      expect(api.storeRequests(type)).toHaveLength(0);
    });
    expect(api.responseMetadata()).toHaveLength(4);
  });

  it("test harness tracks parent containment and paged requests", async () => {
    const document = new MockDocument();
    const parent = new MockElement(document, "parent", "div");
    const child = new MockElement(document, "child", "div");
    parent.appendChild(child);
    expect(child.parentElement).toBe(parent);
    expect(parent.contains(child)).toBe(true);

    const api = reviewApi({ lessonTotal: 120, lessonPageSize: 50 });
    await api.fetch("http://reviewer/agentmemory/viewer/store?type=lessons&limit=50&cursor=50&query=tool");
    expect(api.storeRequests("lessons")).toEqual([
      { limit: "50", cursor: "50", query: "tool", sessionId: null },
    ]);
  });

  it("loads only the first lessons page and requests the next page on demand", async () => {
    const api = reviewApi({ lessonTotal: 13787, lessonPageSize: 50 });
    const app = await bootReviewer(api);

    await clickTab(app, "lessons");
    expect(api.storeRequests("lessons")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: null },
    ]);
    expect(app.document.getElementById("tab-list-rows")?.querySelectorAll('[data-ui="select-item"]')).toHaveLength(50);
    expect(app.document.getElementById("tab-list-pager")?.innerHTML).toContain("1-50 / 13787");

    const next = app.document.getElementById("tab-list-pager")?.querySelector('[data-ui="page-next"]') || null;
    await clickAndWait(app.document, next);
    expect(api.storeRequests("lessons")[1]).toMatchObject({ cursor: "50" });
    expect(api.storeRequests("lessons").some((request) => request.cursor === "500")).toBe(false);
  });

  it("boots with one sessions page and no aggregate store or stats scan", async () => {
    const api = reviewApi({ sessionTotal: 4016, summaryTotal: 4016 });
    await bootReviewer(api);

    expect(api.storeRequests("sessions")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: null },
    ]);
    expect(api.storeRequests("summaries").every((request) => request.sessionId)).toBe(true);
    expect(api.storeRequests("summaries").some((request) => !request.sessionId)).toBe(false);
    expect(api.requestsFor("viewer/stores")).toHaveLength(0);
    expect(api.requestsFor("viewer/session-stats")).toHaveLength(0);
  });

  it("loads and paginates a selected session category without touching other category scopes", async () => {
    const api = reviewApi({ sessionTotal: 2, summaryTotal: 2, lessonTotal: 120, lessonSessionId: "session-2" });
    const app = await bootReviewer(api);
    expect(api.storeRequests("lessons")).toHaveLength(0);

    const session = app.document.getElementById("session-list-rows")?.querySelectorAll('[data-ui="select-session"]')
      .find((row) => row.getAttribute("data-id") === "session-2") || null;
    await clickAndWait(app.document, session);
    const lessons = app.document.getElementById("session-category-list")?.querySelectorAll('[data-ui="session-category"]')
      .find((row) => row.getAttribute("data-category") === "lessons") || null;
    await clickAndWait(app.document, lessons);
    expect(api.storeRequests("lessons")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: "session-2" },
    ]);
    expect(app.document.getElementById("session-content-list")?.querySelectorAll('[data-ui="select-item"]')).toHaveLength(50);

    const next = app.document.getElementById("session-content-pane")?.querySelector('[data-ui="page-next"]') || null;
    const contentRows = app.document.getElementById("session-content-list")!;
    contentRows.scrollTop = 42;
    await clickAndWait(app.document, next);
    expect(api.storeRequests("lessons")[1]).toMatchObject({ cursor: "50", sessionId: "session-2" });
    expect(app.document.getElementById("session-content-list")?.scrollTop).toBe(0);
  });

  it("lets observation filters navigate the shared sessions page without changing either selection", async () => {
    const api = reviewApi({ sessionTotal: 120, summaryTotal: 120 });
    const app = await bootReviewer(api);
    const debugStore = (app.sandbox.window.__agentmemoryReviewDebug as { store: { selected: { sessionId: string; observationSessionId: string } } }).store;
    const initialSessionId = debugStore.selected.sessionId;
    await clickTab(app, "observations");

    const next = app.document.getElementById("observation-filter-pager")?.querySelector('[data-ui="page-next"]') || null;
    await clickAndWait(app.document, next);
    expect(debugStore.selected.sessionId).toBe(initialSessionId);
    expect(debugStore.selected.observationSessionId).toBe("");
    const target = app.document.getElementById("observation-filter-list")?.querySelectorAll('[data-ui="observation-session"]')[0] || null;
    await clickAndWait(app.document, target);
    expect(debugStore.selected.sessionId).toBe(initialSessionId);
    expect(debugStore.selected.observationSessionId).toBe("session-51");
    expect(api.storeRequests("observations").at(-1)?.sessionId).toBe("session-51");
  });

  it("caches a missing selected-session summary and only requests summaries by sessionId", async () => {
    const api = reviewApi({ sessionTotal: 2, summaryTotal: 1 });
    const app = await bootReviewer(api);
    await waitFor(() => api.storeRequests("summaries").length === 1);

    const sessionRow = (sessionId: string) => app.document.getElementById("session-list-rows")
      ?.querySelectorAll('[data-ui="select-session"]')
      .find((row) => row.getAttribute("data-id") === sessionId) || null;
    await clickAndWait(app.document, sessionRow("session-2"));
    await clickAndWait(app.document, sessionRow("session-1"));
    await clickAndWait(app.document, sessionRow("session-2"));

    expect(api.storeRequests("summaries")).toEqual([
      { limit: "1", cursor: "0", query: null, sessionId: "session-1" },
      { limit: "1", cursor: "0", query: null, sessionId: "session-2" },
    ]);
    const store = (app.sandbox.window.__agentmemoryReviewDebug as {
      store: { summaryBySessionId: Record<string, { loaded: boolean; value: unknown }> };
    }).store;
    expect(store.summaryBySessionId["session-2"]).toMatchObject({ loaded: true, value: null });
    expect(api.storeRequests("lessons")).toHaveLength(0);
    expect(api.storeRequests("observations")).toHaveLength(0);
  });

  it("isolates global and per-session lesson page state", async () => {
    const api = reviewApi({
      sessionTotal: 2,
      summaryTotal: 2,
      lessonTotal: 240,
      lessonSessionIds: ["session-1", "session-2"],
    });
    const app = await bootReviewer(api);

    await clickTab(app, "lessons");
    await clickAndWait(app.document, app.document.getElementById("tab-list-pager")?.querySelector('[data-ui="page-next"]') || null);
    await clickTab(app, "sessions");

    const selectSession = async (sessionId: string) => {
      const row = app.document.getElementById("session-list-rows")?.querySelectorAll('[data-ui="select-session"]')
        .find((item) => item.getAttribute("data-id") === sessionId) || null;
      await clickAndWait(app.document, row);
    };
    const selectLessons = async () => {
      const row = app.document.getElementById("session-category-list")?.querySelectorAll('[data-ui="session-category"]')
        .find((item) => item.getAttribute("data-category") === "lessons") || null;
      await clickAndWait(app.document, row);
    };

    await selectSession("session-1");
    await selectLessons();
    await clickAndWait(app.document, app.document.getElementById("session-content-pane")?.querySelector('[data-ui="page-next"]') || null);
    await selectSession("session-2");
    await selectLessons();

    const store = (app.sandbox.window.__agentmemoryReviewDebug as {
      store: {
        activePageKeyByScope: Record<string, string>;
        pageCache: Record<string, { items: Array<{ id: string }>; page: number; requestSeq: number }>;
        requestSeqByScope: Record<string, number>;
      };
    }).store;
    const globalKey = store.activePageKeyByScope["tab:lessons:"];
    const sessionAKey = store.activePageKeyByScope["session-category:lessons:session-1"];
    const sessionBKey = store.activePageKeyByScope["session-category:lessons:session-2"];
    expect(new Set([globalKey, sessionAKey, sessionBKey]).size).toBe(3);
    expect(store.pageCache[globalKey]).toMatchObject({ page: 1, requestSeq: 2 });
    expect(store.pageCache[sessionAKey]).toMatchObject({ page: 1, requestSeq: 2 });
    expect(store.pageCache[sessionBKey]).toMatchObject({ page: 0, requestSeq: 1 });
    expect(store.pageCache[globalKey].items[0]?.id).toBe("lesson-51");
    expect(store.pageCache[sessionAKey].items[0]?.id).toBe("lesson-101");
    expect(store.pageCache[sessionBKey].items[0]?.id).toBe("lesson-2");
    expect(store.requestSeqByScope).toMatchObject({
      "tab:lessons:": 2,
      "session-category:lessons:session-1": 2,
      "session-category:lessons:session-2": 1,
    });
  });

  it("searches and pages observation filters without coordinating either selection", async () => {
    const api = reviewApi({ sessionTotal: 120, summaryTotal: 120 });
    const app = await bootReviewer(api);
    await waitFor(() => api.storeRequests("summaries").length === 1);
    const store = (app.sandbox.window.__agentmemoryReviewDebug as {
      store: { selected: { sessionId: string; observationSessionId: string } };
    }).store;
    const initialSelection = { ...store.selected };
    const initialSummaryRequests = api.storeRequests("summaries").length;
    await clickTab(app, "observations");
    useFakeTimersInSandbox(app);

    const input = typeSearch(app, "observation-session-filter", "session-88");
    input.selectionStart = 5;
    input.selectionEnd = 5;
    input.focus();
    const rows = app.document.getElementById("observation-filter-list")!;
    rows.scrollTop = 91;
    await vi.advanceTimersByTimeAsync(300);
    await flushReviewerTasks();

    expect(rows.innerHTML).toContain("session-88");
    expect(rows.scrollTop).toBe(0);
    expect(app.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
    expect(app.document.getElementById("status-line")?.innerHTML).toContain("<strong>1</strong> sessions");
    expect(store.selected).toEqual(initialSelection);
    expect(api.storeRequests("summaries")).toHaveLength(initialSummaryRequests);
    expect(api.storeRequests("lessons")).toHaveLength(0);
    expect(api.storeRequests("observations")).toHaveLength(0);

    input.value = "";
    input.selectionStart = 0;
    input.selectionEnd = 0;
    app.document.dispatchEvent("input", input);
    await vi.advanceTimersByTimeAsync(300);
    await flushReviewerTasks();
    rows.scrollTop = 73;
    const next = app.document.getElementById("observation-filter-pager")?.querySelector('[data-ui="page-next"]') || null;
    await clickAndWait(app.document, next);
    expect(rows.innerHTML).toContain("session-51");
    expect(rows.scrollTop).toBe(0);
    expect(app.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(app.document.getElementById("status-line")?.innerHTML).toContain("<strong>120</strong> sessions");
    expect(store.selected).toEqual(initialSelection);
    expect(api.storeRequests("summaries")).toHaveLength(initialSummaryRequests);
    ["lessons", "semantic", "procedural", "crystals", "insights"].forEach((type) => {
      expect(api.storeRequests(type)).toHaveLength(0);
    });
    expect(api.storeRequests("observations")).toHaveLength(0);

    const target = rows.querySelectorAll('[data-ui="observation-session"]')
      .find((row) => row.getAttribute("data-id") === "session-51") || null;
    await clickAndWait(app.document, target);
    expect(store.selected.sessionId).toBe(initialSelection.sessionId);
    expect(store.selected.observationSessionId).toBe("session-51");
    expect(api.storeRequests("observations")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: "session-51" },
    ]);
    expect(api.storeRequests("sessions")).toEqual([
      { limit: "50", cursor: "0", query: null, sessionId: null },
      { limit: "50", cursor: "0", query: "session-88", sessionId: null },
      { limit: "50", cursor: "0", query: null, sessionId: null },
      { limit: "50", cursor: "50", query: null, sessionId: null },
    ]);

    await clickTab(app, "sessions");
    expect(app.document.getElementById("session-list-rows")?.innerHTML).toContain("session-51");
    expect(store.selected.sessionId).toBe(initialSelection.sessionId);
    expect(store.selected.observationSessionId).toBe("session-51");
  });

  it("keeps the newest Sessions query active and does not load stale query details", async () => {
    const api = reviewApiWithDeferredSessionResponses();
    const app = await bootReviewer(api);
    await waitFor(() => api.storeRequests("summaries").length === 1);
    useFakeTimersInSandbox(app);

    typeSearch(app, "sessions", "query-a");
    await vi.advanceTimersByTimeAsync(300);
    typeSearch(app, "sessions", "query-b");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchRequests()).toEqual(["query-a", "query-b"]);

    await api.resolveAt(1, [{ id: "session-b-result", firstPrompt: "newest B" }]);
    await flushReviewerTasks();
    await flushReviewerTasks();
    await api.resolveAt(0, [{ id: "session-a-result", firstPrompt: "stale A" }]);
    await flushReviewerTasks();
    await flushReviewerTasks();

    const store = (app.sandbox.window.__agentmemoryReviewDebug as {
      store: {
        selected: { sessionId: string };
        activePageKeyByScope: Record<string, string>;
        pageCache: Record<string, { query: string }>;
      };
    }).store;
    const activeKey = store.activePageKeyByScope["tab:sessions:"];
    expect(store.selected.sessionId).toBe("session-b-result");
    expect(activeKey.endsWith("\u001fquery-b")).toBe(true);
    expect(store.pageCache[activeKey].query).toBe("query-b");
    expect(app.document.getElementById("session-list-rows")?.innerHTML).toContain("newest B");
    expect(app.document.getElementById("session-list-rows")?.innerHTML).not.toContain("stale A");
    expect(api.storeRequests("summaries").map((request) => request.sessionId)).toEqual([
      "session-1",
      "session-b-result",
    ]);
    ["lessons", "semantic", "procedural", "crystals", "insights"].forEach((type) => {
      expect(api.storeRequests(type)).toHaveLength(0);
    });
    expect(api.storeRequests("observations")).toHaveLength(0);
  });

  it("keeps Observation Filters selections unchanged when queries finish out of order", async () => {
    const api = reviewApiWithDeferredSessionResponses();
    const app = await bootReviewer(api);
    await waitFor(() => api.storeRequests("summaries").length === 1);
    const store = (app.sandbox.window.__agentmemoryReviewDebug as {
      store: {
        selected: { sessionId: string; observationSessionId: string };
        activePageKeyByScope: Record<string, string>;
        pageCache: Record<string, { query: string }>;
      };
    }).store;
    const initialSelection = { ...store.selected };
    const initialSummaryRequests = api.storeRequests("summaries").length;
    await clickTab(app, "observations");
    useFakeTimersInSandbox(app);

    typeSearch(app, "observation-session-filter", "query-a");
    await vi.advanceTimersByTimeAsync(300);
    typeSearch(app, "observation-session-filter", "query-b");
    await vi.advanceTimersByTimeAsync(300);
    await api.resolveAt(1, [{ id: "session-b-result", firstPrompt: "newest B" }]);
    await flushReviewerTasks();
    await flushReviewerTasks();
    await api.resolveAt(0, [{ id: "session-a-result", firstPrompt: "stale A" }]);
    await flushReviewerTasks();
    await flushReviewerTasks();

    const activeKey = store.activePageKeyByScope["tab:sessions:"];
    expect(store.selected).toEqual(initialSelection);
    expect(activeKey.endsWith("\u001fquery-b")).toBe(true);
    expect(store.pageCache[activeKey].query).toBe("query-b");
    expect(app.document.getElementById("observation-filter-list")?.innerHTML).toContain("newest B");
    expect(app.document.getElementById("observation-filter-list")?.innerHTML).not.toContain("stale A");
    expect(api.storeRequests("summaries")).toHaveLength(initialSummaryRequests);
    ["lessons", "semantic", "procedural", "crystals", "insights"].forEach((type) => {
      expect(api.storeRequests(type)).toHaveLength(0);
    });
    expect(api.storeRequests("observations")).toHaveLength(0);
  });

  it("preserves search focus while resetting rows and refreshing status totals", async () => {
    const api = reviewApi({ lessonTotal: 120, sessionTotal: 120, summaryTotal: 120 });
    const app = await bootReviewer(api);
    await clickTab(app, "lessons");
    useFakeTimersInSandbox(app);

    const input = typeSearch(app, "lessons", "lesson-88");
    input.selectionStart = 4;
    input.selectionEnd = 4;
    input.focus();
    const rows = app.document.getElementById("tab-list-rows")!;
    rows.scrollTop = 55;
    await vi.advanceTimersByTimeAsync(300);
    await flushReviewerTasks();
    expect(rows.scrollTop).toBe(0);
    expect(app.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(app.document.getElementById("status-line")?.innerHTML).toContain("<strong>1</strong> lessons");

    input.value = "lesson";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    app.document.dispatchEvent("input", input);
    await vi.advanceTimersByTimeAsync(300);
    await flushReviewerTasks();
    rows.scrollTop = 44;
    const next = app.document.getElementById("tab-list-pager")?.querySelector('[data-ui="page-next"]') || null;
    await clickAndWait(app.document, next);
    expect(rows.scrollTop).toBe(0);
    expect(app.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(app.document.getElementById("status-line")?.innerHTML).toContain("<strong>120</strong> lessons");
  });

  it("preserves Sessions search focus and resets its rows after paging", async () => {
    const app = await bootReviewer(reviewApi({ sessionTotal: 120, summaryTotal: 120 }));
    const input = app.document.querySelectorAll('input[data-ui="filter"]')
      .find((item) => item.getAttribute("data-key") === "sessions")!;
    input.value = "";
    input.selectionStart = 0;
    input.selectionEnd = 0;
    input.focus();
    const rows = app.document.getElementById("session-list-rows")!;
    rows.scrollTop = 66;

    const next = app.document.getElementById("session-list-pager")?.querySelector('[data-ui="page-next"]') || null;
    await clickAndWait(app.document, next);
    expect(rows.scrollTop).toBe(0);
    expect(app.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);

    useFakeTimersInSandbox(app);
    input.value = "session-88";
    input.selectionStart = 5;
    input.selectionEnd = 5;
    rows.scrollTop = 39;
    app.document.dispatchEvent("input", input);
    await vi.advanceTimersByTimeAsync(300);
    await flushReviewerTasks();
    expect(rows.innerHTML).toContain("session-88");
    expect(rows.scrollTop).toBe(0);
    expect(app.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
    expect(app.document.getElementById("status-line")?.innerHTML).toContain("<strong>1</strong> sessions");
  });

  it("keeps search and pager outside the only scrollable rows container", async () => {
    const app = await bootReviewer(reviewApi({ lessonTotal: 13787 }));
    await clickTab(app, "lessons");

    const pane = app.document.getElementById("tab-list-pane")!;
    const tools = app.document.getElementById("tab-list-tools")!;
    const rows = app.document.getElementById("tab-list-rows")!;
    const pager = app.document.getElementById("tab-list-pager")!;
    expect(tools.parentElement).toBe(pane);
    expect(rows.parentElement).toBe(pane);
    expect(pager.parentElement).toBe(pane);
    expect(rows.contains(tools)).toBe(false);
    expect(rows.contains(pager)).toBe(false);
    expect(rows.className).toContain("list-rows");
    expect(tools.querySelector('input[type="search"]')?.getAttribute("aria-label")).toBe("Search lessons");
    expect(rows.getAttribute("aria-busy")).toBe("false");
    expect(app.document.getElementById("tab-list-status")?.getAttribute("aria-live")).toBe("polite");
  });

  it("debounces search and ignores a stale earlier response", async () => {
    const api = reviewApiWithDeferredResponses();
    const app = await bootReviewer(api);
    await clickTab(app, "lessons");
    useFakeTimersInSandbox(app);

    typeSearch(app, "lessons", "tool");
    await vi.advanceTimersByTimeAsync(299);
    expect(api.searchRequests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.searchRequests()).toEqual(["tool"]);
    typeSearch(app, "lessons", "toolbar");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchRequests()).toEqual(["tool", "toolbar"]);

    api.resolveNewest([{ id: "new", content: "new" }]);
    await flushReviewerTasks();
    api.resolveOldest([{ id: "old", content: "old" }]);
    await flushReviewerTasks();
    expect(app.document.getElementById("tab-list-rows")?.innerHTML).toContain("new");
    expect(app.document.getElementById("tab-list-rows")?.innerHTML).not.toContain("old");
  });

  it("does not schedule IME search until composition ends", async () => {
    const api = reviewApiWithDeferredResponses();
    const app = await bootReviewer(api);
    await clickTab(app, "lessons");
    useFakeTimersInSandbox(app);
    const input = typeSearch(app, "lessons", "中", true);
    app.document.dispatchEvent("compositionstart", input);
    await vi.advanceTimersByTimeAsync(500);
    expect(api.searchRequests()).toHaveLength(0);
    input.value = "中文";
    await app.document.dispatchAndWait("compositionend", input);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchRequests()).toEqual(["中文"]);
  });

  it("keeps an old response inactive when a later query reuses the same cache key", async () => {
    const api = reviewApiWithDeferredResponses();
    const app = await bootReviewer(api);
    await clickTab(app, "lessons");
    useFakeTimersInSandbox(app);

    typeSearch(app, "lessons", "tool");
    await vi.advanceTimersByTimeAsync(300);
    typeSearch(app, "lessons", "toolbar");
    await vi.advanceTimersByTimeAsync(300);
    typeSearch(app, "lessons", "tool");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchRequests()).toEqual(["tool", "toolbar", "tool"]);

    api.resolveAt(0, [{ id: "old", content: "old" }]);
    await flushReviewerTasks();
    expect(app.document.getElementById("tab-list-rows")?.innerHTML).not.toContain("old");
    api.resolveAt(2, [{ id: "new", content: "new" }]);
    await flushReviewerTasks();
    await flushReviewerTasks();
    expect(app.document.getElementById("tab-list-rows")?.innerHTML).toContain("new");
  });

  it("keeps search inputs stable while composing IME text", async () => {
    const { document } = createReviewSandbox();

    await flushPromises();
    await waitFor(() => !String(document.getElementById("app")?.innerHTML).includes("Loading sessions..."));
    const beforeRows = document.getElementById("session-list-rows")?.innerHTML || "";
    expect(beforeRows).toContain("first prompt");

    const sessionSearch = document.querySelectorAll('input[data-ui="filter"]')
      .find((input) => input.getAttribute("data-key") === "sessions");
    expect(sessionSearch).toBeTruthy();
    if (!sessionSearch) throw new Error("session search input missing");

    sessionSearch.value = "中文";
    sessionSearch.selectionStart = 2;
    sessionSearch.selectionEnd = 2;
    sessionSearch.focus();

    document.dispatchEvent("compositionstart", sessionSearch);
    document.dispatchEvent("input", sessionSearch, { isComposing: true });

    expect(document.getElementById("session-list-rows")?.innerHTML).toBe(beforeRows);

    await document.dispatchAndWait("compositionend", sessionSearch);

    const focusedSearch = document.activeElement;
    expect(focusedSearch?.getAttribute("data-key")).toBe("sessions");
    expect(focusedSearch?.value).toBe("中文");
    expect(focusedSearch?.selectionStart).toBe(2);
    expect(document.getElementById("session-list-rows")?.innerHTML).toBe(beforeRows);
  });

  it("loads a selected session summary and category on demand without re-rendering unrelated panes", async () => {
    const { document, renderEvents, sandbox } = createReviewSandbox();

    await flushPromises();
    await waitFor(() => !String(document.getElementById("app")?.innerHTML).includes("Loading sessions..."));
    const app = document.getElementById("app");
    const tabs = document.getElementById("tabs");
    const status = document.getElementById("status-line");
    expect(app).toBeTruthy();
    expect(tabs).toBeTruthy();
    expect(status).toBeTruthy();
    const baselineRenderCount = renderEvents.length;
    expect(baselineRenderCount).toBeGreaterThanOrEqual(1);

    const sessionList = document.getElementById("session-list-rows");
    const sessionCategory = document.getElementById("session-category-pane");
    const sessionContent = document.getElementById("session-content-pane");
    expect(sessionList).toBeTruthy();
    expect(sessionCategory).toBeTruthy();
    expect(sessionContent).toBeTruthy();

    const categoryList = document.getElementById("session-category-list");
    expect(categoryList).toBeTruthy();
    if (!categoryList || !sessionList || !sessionCategory || !sessionContent) {
      throw new Error("missing baseline panes");
    }

    const sessionListRows = document.getElementById("session-list-rows");
    if (!sessionListRows) {
      throw new Error(`session-list-rows missing. app=${String(app?.innerHTML)}`);
    }
    if (!sessionListRows.innerHTML.includes("select-session")) {
      throw new Error(`session rows not rendered: ${sessionListRows.innerHTML}`);
    }

    const getSessionRows = () => document.getElementById("session-list-rows")?.querySelectorAll('[data-ui="select-session"]') || [];
    await waitFor(() => getSessionRows().length > 1);
    const sessionRows = getSessionRows();
    const targetSession = sessionRows.find((row) => row.getAttribute("data-id") === "session-b") || sessionRows[0];
    expect(targetSession.getAttribute("data-id")).toBe("session-b");

    sessionList.scrollTop = 77;
    sessionCategory.scrollTop = 33;
    sessionContent.scrollTop = 11;

    click(sandbox, targetSession);

    expect(document.getElementById("session-list-rows")).toBe(sessionList);
    expect((document.getElementById("session-list-rows") as MockElement).scrollTop).toBe(77);
    expect(document.getElementById("session-category-pane")).toBe(sessionCategory);
    expect((document.getElementById("session-category-pane") as MockElement).scrollTop).toBe(33);
    expect(document.getElementById("session-content-pane")).toBe(sessionContent);
    expect(renderEvents).toHaveLength(baselineRenderCount);
    await waitFor(() => categoryList.innerHTML.includes("Summary") && categoryList.innerHTML.includes("Observations"));
    expect(categoryList.innerHTML).toContain("—");
    expect(categoryList.innerHTML).toContain(">1<");

    const lessonCategory = (document.getElementById("session-category-list")?.querySelectorAll('[data-ui="session-category"]') || [])
      .find((category) => category.getAttribute("data-category") === "lessons");
    expect(lessonCategory).toBeTruthy();

    click(sandbox, lessonCategory as MockElement);
    await waitFor(() => String(document.getElementById("session-content-list")?.innerHTML || "").includes("lesson-a"));

    expect(document.getElementById("session-list-rows")).toBe(sessionList);
    expect(document.getElementById("session-list-rows")?.scrollTop).toBe(77);
    expect((document.getElementById("session-content-pane") as MockElement).scrollTop).toBe(11);
    expect(renderEvents).toHaveLength(baselineRenderCount);

    const lessonRows = document.getElementById("session-content-list")?.querySelectorAll('[data-ui="select-item"]') || [];
    expect(lessonRows.length).toBeGreaterThan(0);
    click(sandbox, lessonRows[0]);

    expect(document.getElementById("session-list-rows")).toBe(sessionList);
    expect(document.getElementById("session-category-pane")).toBe(sessionCategory);
    expect(renderEvents).toHaveLength(baselineRenderCount);
    const sessionDetail = document.getElementById("session-detail");
    expect(sessionDetail?.innerHTML).toContain("first lesson");
    expect(sessionDetail?.innerHTML).toContain("Lesson");
    expect(sessionDetail?.innerHTML).toContain("lesson-a");
    expect(document.getElementById("detail-drawer-root")?.innerHTML).toBe("");
  });
});
