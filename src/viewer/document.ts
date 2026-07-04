import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VIEWER_NONCE_PLACEHOLDER,
  createViewerNonce,
  buildViewerCsp,
} from "../auth.js";
import { VERSION } from "../version.js";

const VIEWER_VERSION_PLACEHOLDER = "__AGENTMEMORY_VERSION__";
type ViewerDocumentName = "index" | "review";

function loadViewerTemplate(name: ViewerDocumentName = "index"): string | null {
  const base = dirname(fileURLToPath(import.meta.url));
  const filename = name === "review" ? "review.html" : "index.html";
  const candidates = [
    join(base, "..", "src", "viewer", filename),
    join(base, "..", "viewer", filename),
    join(base, "viewer", filename),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {}
  }
  return null;
}

export function renderViewerDocument(
  name: ViewerDocumentName = "index",
):
  | { found: true; html: string; csp: string }
  | { found: false } {
  const template = loadViewerTemplate(name);
  if (!template) {
    return { found: false };
  }

  const nonce = createViewerNonce();
  const html = template
    .replaceAll(VIEWER_NONCE_PLACEHOLDER, nonce)
    .replaceAll(VIEWER_VERSION_PLACEHOLDER, VERSION);
  return {
    found: true,
    html,
    csp: buildViewerCsp(nonce),
  };
}
