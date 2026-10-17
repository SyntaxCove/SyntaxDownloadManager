import { describe, expect, it } from "vitest";
import {
  JsonlLogger,
  scrub,
  scrubData,
  LOG_MSG_MAX,
  type LoggerFs,
} from "../logging/logger.js";
import {
  parseCoreStderrLine,
  StderrLineSplitter,
  CORE_RAW_COMPONENT,
} from "../logging/core-stderr.js";

/** In-memory LoggerFs — full control over file state for rotation/retention tests. */
function memoryFs(): LoggerFs & { dump(): Map<string, string>; delete(path: string): void } {
  const files = new Map<string, string>();
  return {
    dump: () => files,
    delete: (p) => files.delete(p),
    mkdirSync: () => undefined,
    existsSync: (p) => files.has(p),
    appendFileSync: (p, data) => files.set(p, (files.get(p) ?? "") + data),
    readdirSync: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`))
        .map((k) => k.slice(dir.length + 1)),
    statSync: (p) => ({
      size: (files.get(p) ?? "").length,
      mtimeMs: 0,
      isFile: () => true,
    }),
    unlinkSync: (p) => {
      if (!files.delete(p)) throw new Error(`ENOENT: ${p}`);
    },
  };
}

// Fixed clock: 2026-10-15T12:00:00Z → file day 2026-10-15 (UTC naming).
const NOW = Date.parse("2026-10-15T12:00:00.000Z");

describe("JsonlLogger — levels, ring, scrubbing", () => {
  it("filters by active level; debug passes only when enabled", () => {
    const log = new JsonlLogger({ dir: null, level: "info", now: () => NOW });
    log.debug("main", "hidden");
    log.info("main", "visible");
    expect(log.getRecent().map((r) => r.msg)).toEqual(["visible"]);

    log.setLevel("debug");
    log.debug("main", "now visible");
    expect(log.getRecent().map((r) => r.msg)).toContain("now visible");
  });

  it("keeps the ring bounded and getRecent returns newest-last with a level floor", () => {
    const log = new JsonlLogger({ dir: null, level: "debug", ringCapacity: 5, now: () => NOW });
    for (let i = 0; i < 20; i++) {
      if (i % 4 === 0) log.warn("t", `warn-${i}`);
      else log.info("t", `info-${i}`);
    }
    // Ring keeps the LAST 5: 15..19 → info-15, warn-16, info-17, info-18, info-19.
    const all = log.getRecent();
    expect(all).toHaveLength(5);
    expect(all[0]!.msg).toBe("info-15");
    expect(all[all.length - 1]!.msg).toBe("info-19");

    const warns = log.getRecent({ level: "warn" });
    expect(warns.map((r) => r.msg)).toEqual(["warn-16"]);

    const tail = log.getRecent({ limit: 2 });
    expect(tail.map((r) => r.msg)).toEqual(["info-18", "info-19"]);
  });

  it("scrubs credentials in URLs, secret-looking query values and bearer headers", () => {
    expect(scrub("http://user:hunter2@example.com/file.zip")).toBe("http://[redacted]@example.com/file.zip");
    expect(scrub("https://cdn.example/get?token=abcdef123&x=1")).toBe("https://cdn.example/get?token=[redacted]&x=1");
    expect(scrub('authorization: Bearer eyJhbGciOi.abc')).toContain("[redacted]");
    expect(scrub("GET https://example.com/?api_key=zzz")).toContain("api_key=[redacted]");
    // Normal content is untouched.
    expect(scrub("download resumed at offset 4096")).toBe("download resumed at offset 4096");
  });

  it("scrubs structured data recursively, caps depth, and reduces errors to {name,message}", () => {
    const out = scrubData({
      url: "http://u:p@example.com/",
      a: { b: { c: { d: { e: { secret: "http://u:p@example.com/" } } } } },
      list: ["https://a/?token=t", "clean", 42, null],
      err: new Error("boom http://u:p@example.com/"),
    }) as Record<string, unknown>;
    expect(out.url).toBe("http://[redacted]@example.com/");
    // outer=0 → a=1 → b=2 → c=3 → d=4 → e would be at depth 5 > 4 → truncated.
    expect(out.a).toEqual({ b: { c: { d: { e: "[truncated]" } } } });
    expect(out.err).toEqual({ name: "Error", message: "boom http://[redacted]@example.com/" });
    expect(out.list).toEqual(["https://a/?token=[redacted]", "clean", 42, undefined]);
  });

  it("caps messages at the contract bound", () => {
    const log = new JsonlLogger({ dir: null, now: () => NOW });
    const long = "x".repeat(LOG_MSG_MAX + 5000);
    expect(log.getRecent()).toHaveLength(0);
    log.info("main", long);
    const rec = log.getRecent()[0]!;
    expect(rec.msg.length).toBe(LOG_MSG_MAX);
  });
});

describe("JsonlLogger — file sink", () => {
  it("writes JSONL to the daily file; records parse back with every field", () => {
    const fs = memoryFs();
    const log = new JsonlLogger({ dir: "/u/logs", fs, now: () => NOW });
    log.warn("supervisor", "core exited", { code: 1 });
    const path = "/u/logs/main-2026-10-15.jsonl";
    expect(fs.dump().has(path)).toBe(true);
    const record = JSON.parse(fs.dump().get(path)!.trim());
    expect(record).toMatchObject({ ts: NOW, level: "warn", component: "supervisor", msg: "core exited", data: { code: 1 } });
    expect(log.currentFilePath).toBe("main-2026-10-15.jsonl");
  });

  it("rotates by the per-day size cap (.1, .2 …) and every file stays within the cap", () => {
    const fs = memoryFs();
    const log = new JsonlLogger({ dir: "/u/logs", fs, now: () => NOW, dayCapBytes: 200 });
    for (let i = 0; i < 20; i++) log.info("main", `message number ${i} with some padding`);
    const names = [...fs.dump().keys()].map((p) => p.slice("/u/logs/".length));
    // Numeric rotation order, not lexicographic (.1 sorts before the base name).
    expect(names).toContain("main-2026-10-15.jsonl");
    expect(names).toContain("main-2026-10-15.1.jsonl");
    expect(names.length).toBeGreaterThanOrEqual(2);
    // Cap semantics: a file chosen by rotate never exceeds cap + one record's worth of
    // growth beyond what rotate accounted for — every file here is ≤ cap exactly.
    for (const content of fs.dump().values()) {
      expect(content.length).toBeLessThanOrEqual(200);
    }
    // Every line in every file parses as JSON.
    for (const content of fs.dump().values()) {
      for (const line of content.trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("prunes files older than the retention window (by file-name day)", () => {
    const fs = memoryFs();
    fs.appendFileSync("/u/logs/main-2026-10-01.jsonl", "old\n");
    fs.appendFileSync("/u/logs/main-2026-10-10.jsonl", "recent\n");
    fs.appendFileSync("/u/logs/main-2026-10-15.jsonl", "today\n");
    const log = new JsonlLogger({
      dir: "/u/logs",
      fs,
      now: () => NOW,
      retentionDays: 7,
    });
    // Constructor prune: day-01 is far beyond 7 days back, day-10 is within it.
    expect(fs.dump().has("/u/logs/main-2026-10-01.jsonl")).toBe(false);
    expect(fs.dump().has("/u/logs/main-2026-10-10.jsonl")).toBe(true);
    expect(log.listLogFiles().map((f) => f.name)).toContain("main-2026-10-15.jsonl");
  });

  it("ignores non-log files when listing and survives fs errors without throwing", () => {
    const fs = memoryFs();
    fs.appendFileSync("/u/logs/notes.txt", "unrelated\n");
    const log = new JsonlLogger({ dir: "/u/logs", fs, now: () => NOW });
    log.info("main", "fine");
    expect(log.listLogFiles().every((f) => f.name.endsWith(".jsonl"))).toBe(true);

    const brokenFs = memoryFs();
    brokenFs.appendFileSync = () => {
      throw new Error("disk full");
    };
    const broken = new JsonlLogger({ dir: "/u/logs", fs: brokenFs, now: () => NOW });
    expect(() => broken.error("main", "survives")).not.toThrow();
    expect(broken.getRecent()[0]!.msg).toBe("survives"); // ring still received it
  });
});

describe("core stderr parsing (Phase 20)", () => {
  it("parses tracing JSON lines into records with a core:<target> component", () => {
    const rec = parseCoreStderrLine(
      JSON.stringify({
        timestamp: "2026-10-15T12:00:00.000000Z",
        level: "INFO",
        target: "download_core::engine",
        message: "job started",
        job_id: "01X",
      }),
      NOW,
    )!;
    expect(rec.level).toBe("info");
    expect(rec.component).toBe("core:engine");
    expect(rec.msg).toBe("job started");
    expect(rec.data).toEqual({ job_id: "01X" });
  });

  it("maps TRACE→debug, WARN→warn, ERROR→error", () => {
    const mk = (level: string) =>
      parseCoreStderrLine(
        JSON.stringify({ timestamp: "t", level, target: "x::y", message: "m" }),
        NOW,
      )!.level;
    expect(mk("TRACE")).toBe("debug");
    expect(mk("WARN")).toBe("warn");
    expect(mk("ERROR")).toBe("error");
  });

  it("classifies non-JSON and level-less JSON as raw errors (panics never vanish)", () => {
    const panic = parseCoreStderrLine("thread 'main' panicked at src/engine.rs:99:", NOW)!;
    expect(panic).toMatchObject({ level: "error", component: CORE_RAW_COMPONENT });
    const junk = parseCoreStderrLine('{"foo": 1}', NOW)!;
    expect(junk.level).toBe("error");
    expect(junk.component).toBe(CORE_RAW_COMPONENT);
    expect(parseCoreStderrLine("   \n", NOW)).toBeNull();
  });

  it("StderrLineSplitter reassembles lines across chunk boundaries and flushes the tail", () => {
    const lines: string[] = [];
    const splitter = new StderrLineSplitter((l) => lines.push(l));
    splitter.push('{"a":1}\n{"b"');
    splitter.push(':2}\npartial-no-newline');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "partial-no-newline"]);
  });
});
