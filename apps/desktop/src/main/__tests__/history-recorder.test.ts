import { describe, expect, it } from "vitest";
import {
  DEDUPE_MS,
  VisitRecorder,
  isRecordableUrl,
  type VisitCandidate,
} from "../domains/history-recorder.js";

/**
 * Phase 14 — history visit recording decisions: scheme filtering (http/https only) and
 * the per-tab settle dedupe window. These rules are the sole gate between WebContents
 * events and persistent history rows.
 */

const visit = (patch: Partial<VisitCandidate> = {}): VisitCandidate => ({
  tabId: "01JD8W3G5XQ9V4M2K7PZ6N8S0T",
  url: "https://example.com/page",
  title: "Example",
  faviconUrl: null,
  at: 1_000,
  ...patch,
});

describe("isRecordableUrl", () => {
  it("accepts http and https", () => {
    expect(isRecordableUrl("http://example.com/")).toBe(true);
    expect(isRecordableUrl("https://example.com/page?x=1")).toBe(true);
  });

  it("rejects every non-web scheme and unparsable input", () => {
    for (const url of [
      "about:blank",
      "devtools://devtools/bundled/inspector.html",
      "chrome://settings",
      "chrome-extension://abc/popup.html",
      "data:text/html,hello",
      "blob:https://example.com/1234",
      "file:///C:/Windows/notepad.exe",
      "ftp://example.com/file",
      "javascript:void(0)",
      "not a url at all",
      "",
    ]) {
      expect(isRecordableUrl(url), url).toBe(false);
    }
  });
});

describe("VisitRecorder", () => {
  it("admits the first visit of a URL", () => {
    const recorder = new VisitRecorder();
    const admitted = recorder.admit(visit());
    expect(admitted).not.toBeNull();
    expect(admitted?.url).toBe("https://example.com/page");
    expect(admitted?.title).toBe("Example");
    expect(admitted?.visitedAt).toBe(1_000);
  });

  it("collapses a same-URL re-settle inside the dedupe window (per tab)", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ at: 1_000 }))).not.toBeNull();
    expect(recorder.admit(visit({ at: 1_000 + DEDUPE_MS - 1 }))).toBeNull();
  });

  it("admits a same-URL re-settle after the dedupe window", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ at: 1_000 }))).not.toBeNull();
    expect(recorder.admit(visit({ at: 1_000 + DEDUPE_MS }))).not.toBeNull();
  });

  it("does not dedupe across tabs", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ tabId: "tab-a", at: 1_000 }))).not.toBeNull();
    expect(recorder.admit(visit({ tabId: "tab-b", at: 1_000 }))).not.toBeNull();
  });

  it("never records non-http(s) navigations, even repeatedly", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ url: "about:blank", at: 1_000 }))).toBeNull();
    expect(recorder.admit(visit({ url: "about:blank", at: 2_000 }))).toBeNull();
    expect(recorder.admit(visit({ url: "file:///tmp/x.html", at: 3_000 }))).toBeNull();
  });

  it("a rejected visit does not reset the dedupe window", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ at: 1_000 }))).not.toBeNull();
    // A second load of the SAME url inside the window is dropped...
    expect(recorder.admit(visit({ at: 1_500 }))).toBeNull();
    // ...and the window anchors to the FIRST admission, not the dropped attempt.
    expect(recorder.admit(visit({ at: 1_000 + DEDUPE_MS + 1 }))).not.toBeNull();
  });

  it("forget clears the tab's dedupe state", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ tabId: "tab-a", at: 1_000 }))).not.toBeNull();
    recorder.forget("tab-a");
    expect(recorder.admit(visit({ tabId: "tab-a", at: 1_100 }))).not.toBeNull();
  });

  it("different URLs in the same tab both record", () => {
    const recorder = new VisitRecorder();
    expect(recorder.admit(visit({ url: "https://a.example/", at: 1_000 }))).not.toBeNull();
    expect(recorder.admit(visit({ url: "https://b.example/", at: 1_100 }))).not.toBeNull();
  });
});
