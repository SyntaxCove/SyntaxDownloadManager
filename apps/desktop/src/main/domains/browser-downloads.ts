import type { Session, DownloadItem } from "electron";

/**
 * Phase 33 (F-1) — browser-initiated downloads land in the Downloads list.
 *
 * Before this module a click-download inside any browser tab fell through to Chromium's
 * default save dialog: bytes landed outside the app's knowledge and never appeared in
 * Downloads. Now every browser session (default and per-proxy) gets a `will-download`
 * handler that hands the item to the core engine via `download.create` — the job then
 * rides the existing queue/policy/progress machinery and is fully controllable
 * (pause/resume/cancel/retry) from the Downloads page.
 *
 * Honest fallbacks (a download must never be trapped or lost):
 *  - non-http(s) sources (blob:, data:) stay native — the engine cannot re-fetch them;
 *  - a core that is not ready at click time stays native;
 *  - a hand-off that fails AFTER preventDefault re-issues `session.downloadURL` guarded
 *    by a one-shot rescue marker, so the item completes natively exactly once (no loop),
 *    with a log line and an OS notification.
 *
 * Headers: the curated request headers (Cookie / User-Agent / Referer / Origin) are
 * captured for faithful resume — the same contract field the manual Downloads form uses.
 * The session cookie header is rebuilt explicitly from the cookie jar (httpOnly included)
 * and merged over the item's own headers. Cookie values are never logged.
 */

export interface BrowserDownloadDeps {
  /** Sync readiness check — a not-ready core must not trap a click-download. */
  isCoreReady(): boolean;
  /** `download.create` through the supervisor (the same wire the Downloads page uses). */
  createJob(params: {
    url: string;
    destinationDir: string;
    filename?: string;
    overwrite?: boolean;
    headers?: Record<string, string>;
  }): Promise<unknown>;
  getDownloadDir(): string;
  logger: {
    info(component: string, msg: string, data?: Record<string, unknown>): void;
    warn(component: string, msg: string, data?: Record<string, unknown>): void;
    error(component: string, msg: string, data?: Record<string, unknown>): void;
  };
  /** OS notification for the rare hand-off failure (bytes still land natively). */
  notify(title: string, body: string): void;
  now?(): number;
}

/** One-shot native rescue markers: url → expiry (a failed hand-off must not loop). */
const RESCUE_TTL_MS = 30_000;

/** Only sources the engine can honestly re-fetch are routed (blob:/data: stay native). */
export function isRoutableDownloadUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Assemble the request headers for the engine job from session facts: the effective
 * session user-agent (settings override respected), the originating page as Referer, the
 * initiator origin, and the explicit session-cookie header (httpOnly included). These are
 * exactly the headers a hotlink-protected or logged-in source needs for a faithful
 * re-fetch and resume. Cookie values are never logged.
 */
export function assembleHandoffHeaders(input: {
  cookieHeader: string | null;
  userAgent: string | null;
  referer: string | null;
  origin: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.userAgent && input.userAgent.trim() !== "" && input.userAgent.length <= 512) {
    out["User-Agent"] = input.userAgent.trim();
  }
  if (input.referer && /^https?:\/\//i.test(input.referer)) out["Referer"] = input.referer;
  if (input.origin && /^https?:\/\//i.test(input.origin)) out["Origin"] = input.origin;
  if (input.cookieHeader && input.cookieHeader.trim() !== "") {
    out.Cookie = input.cookieHeader.trim();
  }
  return out;
}

/**
 * The session's cookies for `url` as one Cookie header, most-specific path first
 * (the same ordering rule browsers use), bounded to a realistic header size by
 * dropping the least-specific cookies first.
 */
export async function sessionCookieHeader(ses: Session, url: string): Promise<string | null> {
  let cookies: Array<{ name: string; value: string; path?: string }>;
  try {
    cookies = await ses.cookies.get({ url });
  } catch {
    return null; // a failed cookie read must not block the hand-off
  }
  if (cookies.length === 0) return null;
  const sorted = [...cookies].sort(
    (a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0),
  );
  const parts: string[] = [];
  let total = 0;
  for (const c of sorted) {
    const part = `${c.name}=${c.value}`;
    if (total + part.length + (parts.length > 0 ? 2 : 0) > 7_500) break;
    parts.push(part);
    total += part.length + (parts.length > 1 ? 2 : 0);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Derive a download filename: the browser's suggested name (Content-Disposition / URL)
 * when present, otherwise the last decoded URL path segment; sanitized for Windows,
 * bounded, and always non-empty.
 */
export function deriveFilename(url: string, suggested: string | undefined | null): string {
  const sanitize = (name: string): string =>
    name.replace(/[\r\n]+/g, " ").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 200);
  if (suggested && suggested.trim() !== "") return sanitize(suggested);
  try {
    const parsed = new URL(url);
    const segment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (segment && segment.trim() !== "" && segment !== "/") return sanitize(segment);
  } catch {
    // unreachable for validated http(s) URLs — kept total anyway
  }
  return "download.bin";
}

/**
 * Attach the Phase 33 `will-download` routing to one browser session. Called exactly
 * once per session via the TabManager's session-lifecycle observer.
 */
export function attachBrowserDownloadHandling(ses: Session, deps: BrowserDownloadDeps): void {
  const rescue = new Map<string, number>();
  const now = () => deps.now?.() ?? Date.now();
  const pruneRescue = (): void => {
    for (const [url, expiry] of rescue) {
      if (expiry <= now()) rescue.delete(url);
    }
  };

  ses.on(
    "will-download",
    (event: unknown, item: DownloadItem, webContents: Electron.WebContents | undefined) => {
      const url = item.getURL();
      // One-shot native rescue: this will-download is the re-issue of a failed hand-off.
      if (rescue.has(url)) {
        rescue.delete(url);
        deps.logger.info("browser-downloads", "rescued browser download proceeds natively", {
          filename: item.getFilename(),
        });
        return;
      }
      if (!isRoutableDownloadUrl(url)) return; // blob:/data: — native, never trapped
      if (!deps.isCoreReady()) return; // engine unavailable — native keeps bytes flowing

      // Stop Chromium's own fetch; the engine re-downloads with the captured headers.
      (event as { preventDefault(): void }).preventDefault();
      const filename = deriveFilename(url, item.getFilename());

      void (async () => {
        try {
          const cookieHeader = await sessionCookieHeader(ses, url);
          const pageUrl =
            webContents && !webContents.isDestroyed() ? webContents.getURL() : null;
          let origin: string | null = null;
          try {
            origin = item.getInitiatorOrigin() || null;
          } catch {
            origin = null; // initiator origin is best-effort
          }
          const headers = assembleHandoffHeaders({
            cookieHeader,
            userAgent: ses.getUserAgent() ?? null,
            referer: pageUrl,
            origin,
          });
          await deps.createJob({
            url,
            destinationDir: deps.getDownloadDir(),
            filename,
            overwrite: false,
            headers,
          });
          deps.logger.info("browser-downloads", "browser download handed to the download engine", {
            filename,
            urlHost: safeHost(url),
            headerNames: Object.keys(headers).sort(),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.logger.error(
            "browser-downloads",
            "browser download hand-off failed; rescuing natively",
            {
              filename,
              urlHost: safeHost(url),
              error: detail,
            },
          );
          rescue.set(url, now() + RESCUE_TTL_MS);
          pruneRescue();
          try {
            ses.downloadURL(url);
            deps.notify(
              "Download handed to the browser",
              `${filename} could not start in the download engine and was saved via the browser instead.`,
            );
          } catch (rescueErr) {
            deps.logger.error(
              "browser-downloads",
              "native rescue failed as well — the user must retry the download",
              { filename, error: rescueErr instanceof Error ? rescueErr.message : String(rescueErr) },
            );
            deps.notify(
              "Download could not start",
              `${filename} could not be started. Please try the download again.`,
            );
          }
        }
      })();
    },
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}
