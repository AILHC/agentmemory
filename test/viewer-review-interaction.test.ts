import { describe, expect, it } from "vitest";
import * as vm from "node:vm";
import { renderViewerDocument } from "../src/viewer/document.js";

type Listener = (event: { type: string; target: MockElement }) => void;

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
  textContent = "";
  value = "";
  className = "";
  scrollTop = 0;
  parent: MockElement | null = null;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private html = "";
  private readonly document: MockDocument;

  constructor(document: MockDocument, id = "") {
    this.document = document;
    this.id = id;
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

  dispatchEvent(event: { type: string; target: MockElement }): void {
    const list = this.listeners.get(event.type) || [];
    list.forEach((listener) => listener(event));
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
    return false;
  }

  querySelectorAll(selector: string): MockElement[] {
    const all = parseTags(this.html).map((node) => {
      const element = new MockElement(this.document);
      element.parent = this;
      element.setParsedAttributes(node.attrs);
      return element;
    }).filter((node) => node.matches(selector));
    return all;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class MockDocument {
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

  dispatchEvent(type: string, target: MockElement): void {
    const list = this.listeners.get(type) || [];
    list.forEach((listener) => listener({ type, target }));
  }

  syncIdsFromHtml(container: MockElement, html: string): void {
    parseTags(html).forEach((node) => {
      const id = node.attrs.get("id");
      if (!id) return;
      const current = this.nodes.get(id);
      const next = current || new MockElement(this, id);
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
  }
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
          return { items: payloads.summaries, total: payloads.summaries.length, returned: payloads.summaries.length, hasMore: false };
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

function createReviewSandbox() {
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

  const api = buildMockFetch({
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
  it("uses backend session-stats and keeps interactions pane-local without re-rendering unrelated panes", async () => {
    const { document, renderEvents, api, sandbox } = createReviewSandbox();

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

    const sessionList = document.getElementById("session-list");
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

    expect(document.getElementById("session-list")).toBe(sessionList);
    expect((document.getElementById("session-list") as MockElement).scrollTop).toBe(77);
    expect(document.getElementById("session-category-pane")).toBe(sessionCategory);
    expect((document.getElementById("session-category-pane") as MockElement).scrollTop).toBe(33);
    expect(document.getElementById("session-content-pane")).toBe(sessionContent);
    expect(renderEvents).toHaveLength(baselineRenderCount);
    await waitFor(() => categoryList.innerHTML.includes("...") || categoryList.innerHTML.includes("!") || /<span>\d+<\/span>/.test(categoryList.innerHTML));

    expect(categoryList.innerHTML).toContain("...");
    expect(categoryList.innerHTML).not.toContain(">0<");

    api.resolveStats({
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
    });
    await flushPromises();

    expect(categoryList.innerHTML).toContain("3");
    expect(categoryList.innerHTML).toContain("4");

    const lessonCategory = (document.getElementById("session-category-list")?.querySelectorAll('[data-ui="session-category"]') || [])
      .find((category) => category.getAttribute("data-category") === "lessons");
    expect(lessonCategory).toBeTruthy();

    click(sandbox, lessonCategory as MockElement);
    await waitFor(() => String(document.getElementById("session-content-list")?.innerHTML || "").includes("lesson-a"));

    expect(document.getElementById("session-list")).toBe(sessionList);
    expect(document.getElementById("session-list")?.scrollTop).toBe(77);
    expect((document.getElementById("session-content-pane") as MockElement).scrollTop).toBe(11);
    expect(renderEvents).toHaveLength(baselineRenderCount);

    const lessonRows = document.getElementById("session-content-list")?.querySelectorAll('[data-ui="select-item"]') || [];
    expect(lessonRows.length).toBeGreaterThan(0);
    click(sandbox, lessonRows[0]);

    expect(document.getElementById("session-list")).toBe(sessionList);
    expect(document.getElementById("session-category-pane")).toBe(sessionCategory);
    expect(renderEvents).toHaveLength(baselineRenderCount);
    const detailDrawer = document.getElementById("detail-drawer-root");
    expect(detailDrawer?.innerHTML).toContain("first lesson");
    expect(detailDrawer?.innerHTML).toContain("Lesson");
    expect(detailDrawer?.innerHTML).toContain("lesson-a");
  });
});
