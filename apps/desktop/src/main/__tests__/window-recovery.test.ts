import { describe, expect, it } from "vitest";
import {
  BASE_BACKOFF_MS,
  MAX_ATTEMPTS,
  WINDOW_MS,
  rendererReloadDecision,
} from "../window-recovery.js";

describe("renderer crash recovery policy (Phase 24)", () => {
  it("clean exit never reloads — the window was closed deliberately", () => {
    expect(rendererReloadDecision("clean-exit", 0, 1000, null)).toEqual({
      reload: false,
      delayMs: 0,
      attempts: 0,
    });
    expect(rendererReloadDecision("clean-exit", 2, 1000, 900)).toEqual({
      reload: false,
      delayMs: 0,
      attempts: 2,
    });
  });

  it("first crash schedules a reload after the base backoff", () => {
    const d = rendererReloadDecision("crashed", 0, 5_000, null);
    expect(d.reload).toBe(true);
    expect(d.delayMs).toBe(BASE_BACKOFF_MS);
    expect(d.attempts).toBe(1);
  });

  it("backoff ladder climbs linearly inside the window", () => {
    expect(rendererReloadDecision("oom", 1, 5_000, 4_000).delayMs).toBe(2 * BASE_BACKOFF_MS);
    expect(rendererReloadDecision("oom", 2, 6_000, 5_000).delayMs).toBe(3 * BASE_BACKOFF_MS);
  });

  it("budget exhausts after MAX_ATTEMPTS inside the window", () => {
    const d = rendererReloadDecision("crashed", MAX_ATTEMPTS, 10_000, 9_000);
    expect(d.reload).toBe(false);
    expect(d.delayMs).toBe(0);
    expect(d.attempts).toBe(MAX_ATTEMPTS);
  });

  it("sliding window empties: a crash after a quiet period resets the budget", () => {
    // last attempt long ago (> WINDOW_MS): attempts restart from zero with full budget
    const d = rendererReloadDecision("crashed", MAX_ATTEMPTS, 10_000 + WINDOW_MS, 10_000);
    expect(d.reload).toBe(true);
    expect(d.attempts).toBe(1);
  });

  it("boundary: exactly WINDOW_MS after the last attempt is outside the window", () => {
    const d = rendererReloadDecision("crashed", MAX_ATTEMPTS, 5_000 + WINDOW_MS, 5_000);
    expect(d.reload).toBe(true);
  });

  it("boundary: 1ms inside the window still counts against the budget", () => {
    const d = rendererReloadDecision("crashed", MAX_ATTEMPTS, 5_000 + WINDOW_MS - 1, 5_000);
    expect(d.reload).toBe(false);
  });
});
