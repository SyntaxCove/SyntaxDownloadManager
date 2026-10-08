import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS, type AppSettings } from "@unidm/contracts";
import { buildSetPolicyPayload, parseHhMm } from "../policy.js";

/** Phase 8 — queue/scheduler policy translation (settings → download.setPolicy). */

describe("parseHhMm", () => {
  it("parses 24h clock values into minutes-of-day", () => {
    expect(parseHhMm("00:00")).toBe(0);
    expect(parseHhMm("01:30")).toBe(90);
    expect(parseHhMm("13:45")).toBe(825);
    expect(parseHhMm("23:59")).toBe(1439);
  });

  it("falls back to 0 on malformed components (contract already validates)", () => {
    expect(parseHhMm("bad")).toBe(0);
    expect(parseHhMm("x:30")).toBe(30);
  });
});

describe("buildSetPolicyPayload", () => {
  const base = SETTINGS_DEFAULTS;

  it("defaults to always-run, auto-start, unlimited", () => {
    const payload = buildSetPolicyPayload(base);
    expect(payload).toMatchObject({
      autoStartNew: true,
      scheduleMode: "always",
      windowStartMinute: 0,
      windowEndMinute: 0,
      speedLimitKBps: 0,
    });
    expect(Number.isFinite(payload.tzOffsetMinutes)).toBe(true);
    expect(Math.abs(payload.tzOffsetMinutes)).toBeLessThanOrEqual(840);
  });

  it("maps the schedule window and global bandwidth", () => {
    const settings: AppSettings = {
      ...base,
      autoStartNewDownloads: false,
      scheduleEnabled: true,
      scheduleStart: "22:30",
      scheduleEnd: "06:15",
      speedLimitKBps: 512,
    };
    const payload = buildSetPolicyPayload(settings);
    expect(payload).toEqual({
      autoStartNew: false,
      scheduleMode: "window",
      windowStartMinute: 22 * 60 + 30,
      windowEndMinute: 6 * 60 + 15,
      speedLimitKBps: 512,
      tzOffsetMinutes: payload.tzOffsetMinutes,
    });
  });

  it("uses always mode when the schedule toggle is off (bounds ignored)", () => {
    const settings: AppSettings = {
      ...base,
      scheduleEnabled: false,
      scheduleStart: "09:00",
      scheduleEnd: "17:00",
    };
    expect(buildSetPolicyPayload(settings).scheduleMode).toBe("always");
  });
});
