import { describe, expect, it } from "vitest";
import {
  delayForFailure,
  shouldGiveUp,
  shouldResetStreak,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_CONSECUTIVE,
  RESET_AFTER_MS,
} from "../core/backoff.js";

describe("backoff policy", () => {
  it("doubles from the base delay and caps at MAX_DELAY_MS", () => {
    expect(delayForFailure(1)).toBe(BASE_DELAY_MS);
    expect(delayForFailure(2)).toBe(BASE_DELAY_MS * 2);
    expect(delayForFailure(3)).toBe(BASE_DELAY_MS * 4);
    expect(delayForFailure(4)).toBe(BASE_DELAY_MS * 8);
    expect(delayForFailure(5)).toBe(BASE_DELAY_MS * 16);
    for (let n = 6; n < 40; n++) {
      expect(delayForFailure(n)).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
    expect(delayForFailure(10)).toBe(MAX_DELAY_MS);
  });

  it("gives up only after MAX_CONSECUTIVE failures", () => {
    expect(shouldGiveUp(MAX_CONSECUTIVE - 1)).toBe(false);
    expect(shouldGiveUp(MAX_CONSECUTIVE)).toBe(true);
    expect(shouldGiveUp(MAX_CONSECUTIVE + 5)).toBe(true);
  });

  it("resets the streak after a long healthy stretch", () => {
    expect(shouldResetStreak(RESET_AFTER_MS - 1)).toBe(false);
    expect(shouldResetStreak(RESET_AFTER_MS)).toBe(true);
  });
});
