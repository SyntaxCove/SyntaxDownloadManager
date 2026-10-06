/**
 * URL-bar input normalization (pure, shared logic of the browser domain).
 * Rules:
 *  - already-absolute http(s)/file/about URLs pass through;
 *  - "localhost" / host:port / dotted hosts get https:// (http for localhost);
 *  - anything else (spaces, dots-less words, CJK/RTL text) becomes a DuckDuckGo search;
 *  - non-http(s) schemes other than about: are rejected (no javascript:, no data: from the bar).
 */

const ABSOLUTE_SCHEMES = new Set(["http:", "https:", "about:", "file:"]);

export interface NormalizeResult {
  /** Resolved target for the tab, or null when the input must be discarded. */
  url: string | null;
  kind: "url" | "search" | "invalid";
}

export function normalizeUrlInput(raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { url: null, kind: "invalid" };

  // eslint-disable-next-line no-ctrl-characters-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return { url: null, kind: "invalid" };

  const explicit = tryParse(trimmed);
  if (explicit && ABSOLUTE_SCHEMES.has(explicit.protocol)) {
    if (explicit.protocol === "about:" && !/^about:(blank|mhtml)/i.test(explicit.href)) {
      return { url: null, kind: "invalid" };
    }
    return { url: explicit.href, kind: "url" };
  }
  if (explicit && (explicit.protocol === "javascript:" || explicit.protocol === "data:")) {
    return { url: null, kind: "invalid" };
  }

  // Host-like inputs: "example.com", "localhost:3000", "192.168.1.5/path"
  const hostLike = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(trimmed) || /^localhost(:\d+)?([/?#].*)?$/i.test(trimmed);
  if (hostLike) {
    const scheme = trimmed.toLowerCase().startsWith("localhost") ? "http" : "https";
    const parsed = tryParse(`${scheme}://${trimmed}`);
    if (parsed) return { url: parsed.href, kind: "url" };
  }

  const search = tryParse(`https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`);
  return search ? { url: search.href, kind: "search" } : { url: null, kind: "invalid" };
}

function tryParse(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** Derive the initial tab title from a URL (used until the page reports its own title). */
export function titleForUrl(url: string): string {
  if (url === "about:blank") return "New tab";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:") return "New tab";
    return parsed.host + (parsed.pathname !== "/" ? parsed.pathname : "");
  } catch {
    return url;
  }
}

/** Clamp the renderer-reported viewport rect against the window content size (safety net). */
export function clampViewportBounds(
  rect: { x: number; y: number; width: number; height: number },
  content: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(rect.x, content.width));
  const y = Math.max(0, Math.min(rect.y, content.height));
  const width = Math.max(0, Math.min(rect.width, content.width - x));
  const height = Math.max(0, Math.min(rect.height, content.height - y));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
