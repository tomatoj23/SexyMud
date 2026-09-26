import { describe, expect, it, vi } from "vitest";
import { createHostClock } from "../src/game/hostClock.js";

/**
 * The host's wall-to-tick translator (spec/04 §2.3, O5).
 *
 * The numbers here are HOST numbers on purpose: `tickSeconds` is a host
 * parameter (O5 — the engine reads ticks, never seconds) and it lives at the
 * constructor call site, not in `content/`.
 */
describe("the host's wall-to-tick clock (spec/04 §2.3, O5)", () => {
  it("one tick is tickSeconds real seconds, counted from the epoch", () => {
    const clock = createHostClock({ tickSeconds: 2, now: () => 12_500 });
    expect(clock.nowTick()).toBe(6);
  });

  it("floors a partial tick instead of rounding it up", () => {
    let wallMs = 999;
    const clock = createHostClock({ tickSeconds: 1, now: () => wallMs });
    expect(clock.nowTick()).toBe(0);
    wallMs = 1000;
    expect(clock.nowTick()).toBe(1);
    wallMs = 1999;
    expect(clock.nowTick()).toBe(1);
  });

  it("sub-second ticks are allowed — the width is the host's to choose", () => {
    const clock = createHostClock({ tickSeconds: 0.5, now: () => 12_500 });
    expect(clock.nowTick()).toBe(25);
  });

  it("defaults to Date.now — the game glue's single wall read", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(5000);
    const clock = createHostClock({ tickSeconds: 5 });
    expect(clock.nowTick()).toBe(1);
    nowSpy.mockRestore();
  });

  it("a tick rolls exactly at its boundary — no float drift in the width", () => {
    // `16.1 * 1000` is 16100.000000000002: dividing by that noise used to
    // roll the tick one millisecond LATE at every boundary (the regression
    // this pins). The width is whole milliseconds or the clock refuses.
    let wallMs = 16_099;
    const clock = createHostClock({ tickSeconds: 16.1, now: () => wallMs });
    expect(clock.nowTick()).toBe(0);
    wallMs = 16_100;
    expect(clock.nowTick()).toBe(1);
    wallMs = 32_200;
    expect(clock.nowTick()).toBe(2);
  });

  it("fails loudly on a width that cannot divide time (wiring, not play)", () => {
    for (const tickSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createHostClock({ tickSeconds })).toThrow(
        /positive whole number of milliseconds/,
      );
    }
  });

  it("fails loudly on a width finer than a millisecond — the wall clock's resolution", () => {
    // Not rounded to 333ms on purpose: the caller's number would become a
    // lie. 1/3 second is not expressible in milliseconds, and 0.5ms is
    // below the wall clock's own grain.
    for (const tickSeconds of [1 / 3, 0.3333, 0.0015, 0.0005]) {
      expect(() => createHostClock({ tickSeconds })).toThrow(
        /positive whole number of milliseconds/,
      );
    }
  });

  it("an absolute formula recovers the offline span across a reload with no side channel", () => {
    // The whole reason the epoch is absolute (spec/04 §4.2): the difference
    // between two readings IS the offline span, so a save needs no wall
    // clock of its own. Two instances = two sessions — the formula alone
    // carries the span.
    const wallMs = { value: 10_000 };
    const firstSession = createHostClock({ tickSeconds: 1, now: () => wallMs.value });
    const awayAt = firstSession.nowTick();
    expect(awayAt).toBe(10);
    wallMs.value = 10_000 + 80 * 1000; // 80 seconds away — one offline gap
    const secondSession = createHostClock({ tickSeconds: 1, now: () => wallMs.value });
    // The reading taken when the player comes back MINUS the one taken when
    // they left is the offline span — no session anchor carried it over.
    expect(secondSession.nowTick() - awayAt).toBe(80);
  });
});
