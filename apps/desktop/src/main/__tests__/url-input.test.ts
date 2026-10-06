import { describe, expect, it } from "vitest";
import { normalizeUrlInput, titleForUrl, clampViewportBounds } from "../domains/url-input.js";

describe("normalizeUrlInput", () => {
  it("passes through absolute http(s) URLs", () => {
    expect(normalizeUrlInput("https://youtube.com/watch?v=abc")).toEqual({
      url: "https://youtube.com/watch?v=abc",
      kind: "url",
    });
    expect(normalizeUrlInput("http://example.com/x?y=1#z").kind).toBe("url");
  });

  it("adds https to host-like input, http to localhost", () => {
    expect(normalizeUrlInput("example.com")).toEqual({ url: "https://example.com/", kind: "url" });
    expect(normalizeUrlInput("example.com:8080/path").kind).toBe("url");
    expect(normalizeUrlInput("localhost:3000")).toEqual({ url: "http://localhost:3000/", kind: "url" });
    expect(normalizeUrlInput("192.168.1.5/admin").kind).toBe("url");
  });

  it("sends non-host text to DuckDuckGo search", () => {
    const r = normalizeUrlInput("best download manager 2026");
    expect(r.kind).toBe("search");
    expect(r.url).toContain("duckduckgo.com/?q=");
    expect(r.url).toContain("best%20download%20manager%202026");
    const fa = normalizeUrlInput("دانلود منیجر");
    expect(fa.kind).toBe("search");
  });

  it("allows only about:blank/mhtml about variants", () => {
    expect(normalizeUrlInput("about:blank")).toEqual({ url: "about:blank", kind: "url" });
    expect(normalizeUrlInput("about:config").url).toBeNull();
  });

  it("rejects dangerous schemes and garbage", () => {
    expect(normalizeUrlInput("javascript:alert(1)").url).toBeNull();
    expect(normalizeUrlInput("data:text/html,<h1>x</h1>").url).toBeNull();
    expect(normalizeUrlInput("   ").url).toBeNull();
    expect(normalizeUrlInput("ht!tp://weird").kind).toBe("search"); // not a scheme, not hostlike
  });

  it("accepts file: URLs (local documents) and keeps them", () => {
    expect(normalizeUrlInput("file:///home/user/doc.html").kind).toBe("url");
  });
});

describe("titleForUrl", () => {
  it("derives readable placeholders", () => {
    expect(titleForUrl("about:blank")).toBe("New tab");
    expect(titleForUrl("https://example.com/a/b?q=1")).toBe("example.com/a/b");
  });
});

describe("clampViewportBounds", () => {
  it("clamps rect into the window content area", () => {
    const c = { width: 1000, height: 700 };
    expect(clampViewportBounds({ x: 10, y: 20, width: 500, height: 400 }, c)).toEqual({
      x: 10, y: 20, width: 500, height: 400,
    });
    expect(clampViewportBounds({ x: 900, y: 600, width: 500, height: 400 }, c)).toEqual({
      x: 900, y: 600, width: 100, height: 100,
    });
    expect(clampViewportBounds({ x: -5, y: -5, width: 2000, height: 2000 }, c)).toEqual({
      x: 0, y: 0, width: 1000, height: 700,
    });
    expect(clampViewportBounds({ x: 0, y: 0, width: 0, height: 0 }, c)).toEqual({
      x: 0, y: 0, width: 0, height: 0,
    });
  });
});
