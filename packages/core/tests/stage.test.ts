import { describe, expect, it } from "vitest";
import { stageAt } from "../src/time/stage.js";
import type { Stage } from "../src/time/stage.js";

/**
 * Pure stage evaluation (spec/04 §4.1, ADR-0025 §三): `f(startTick, nowTick,
 * stages)`. No registration, no state, no callback — a crop that grew while
 * nobody was looking is answered by the same call as one watched the whole
 * time, because nothing "happens" when a stage changes.
 *
 * ⚠️ Stages are LINEAR and CLAMPED here, unlike a calendar ring (§3.2), which
 * is cyclic: a crop ripens and stays ripe, a shichen comes round again.
 */

/** A four-stage crop — ADR-0025's own example, in ticks nobody has to name. */
const CROP: readonly Stage[] = [
  { id: "seed", ticks: 10 },
  { id: "sprout", ticks: 20 },
  { id: "green", ticks: 30 },
  { id: "ripe", ticks: 40 },
];

describe("which stage a tick falls in (spec/04 §4.1)", () => {
  it("walks the stages in order and reports how far into one it is", () => {
    expect(stageAt(0, 0, CROP)).toMatchObject({ index: 0, elapsed: 0, remaining: 10 });
    expect(stageAt(0, 9, CROP)).toMatchObject({ index: 0, elapsed: 9, remaining: 1 });
    expect(stageAt(0, 10, CROP)).toMatchObject({ index: 1, elapsed: 0, remaining: 20 });
    expect(stageAt(0, 29, CROP)).toMatchObject({ index: 1, elapsed: 19, remaining: 1 });
    expect(stageAt(0, 30, CROP)).toMatchObject({ index: 2, elapsed: 0 });
    expect(stageAt(0, 60, CROP)).toMatchObject({ index: 3, elapsed: 0 });
  });

  it("names the stage itself — its id is what a renderer or a gate keys off", () => {
    expect(stageAt(0, 5, CROP).stage).toEqual({ id: "seed", ticks: 10 });
    expect(stageAt(0, 5, CROP).stage.id).toBe("seed");
  });

  it("clamps at the last stage: a ripe crop does not go back to being a seedling", () => {
    const ripe = stageAt(0, 100, CROP);
    expect(ripe).toMatchObject({ index: 3, elapsed: 40, remaining: 0, done: true });

    // Ten million ticks later it is still ripe — this is NOT a ring, and
    // there is no wrap-around to guard against.
    expect(stageAt(0, 10_000_000, CROP)).toMatchObject({ index: 3, done: true });
    expect(stageAt(0, 10_000_000, CROP).index).toBe(CROP.length - 1);
  });

  it("answers at the exactly-`done` tick: the last stage has run its course", () => {
    // Σ ticks = 100. At 99 it is still the last stage, unfinished; at 100 it
    // is done. Half-open again: [arm, done).
    expect(stageAt(0, 99, CROP)).toMatchObject({ index: 3, elapsed: 39, remaining: 1, done: false });
    expect(stageAt(0, 100, CROP)).toMatchObject({ index: 3, done: true });
  });

  it("counts from a start that is not zero", () => {
    expect(stageAt(1000, 1005, CROP)).toMatchObject({ index: 0, elapsed: 5 });
    expect(stageAt(1000, 1030, CROP)).toMatchObject({ index: 2, elapsed: 0 });
  });

  it("reads a start in the future as not started, rather than failing", () => {
    // The pair may legitimately come from data that has not caught up (a save
    // restored ahead of the clock); there is no stage to name before the
    // start, so it is the first one at zero.
    expect(stageAt(500, 100, CROP)).toMatchObject({ index: 0, elapsed: 0, done: false });
  });
});

describe("it is a pure function, not a mechanism (ADR-0025 §三)", () => {
  it("has nothing to advance: a million ticks cost the same as five", () => {
    // The same call answers "how is the crop doing" whether the player stood
    // there or left for a hundred thousand ticks. No registration, no stored
    // progress, nothing to catch up.
    const near = stageAt(0, 5, CROP);
    const far = stageAt(0, 1_000_000, CROP);

    expect(near.index).toBe(0);
    expect(far).toMatchObject({ index: 3, done: true });

    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      stageAt(0, 1_000_000 + i, CROP);
    }
    // A thousand evaluations over a million-tick span: the cost is the span's
    // ZERO, not its size (§4.4).
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("is a function of its arguments alone: the same inputs, the same answer", () => {
    expect(stageAt(7, 42, CROP)).toEqual(stageAt(7, 42, CROP));
  });
});

describe("loud failures", () => {
  it("needs at least one stage — there is no stage to name otherwise", () => {
    expect(() => stageAt(0, 10, [])).toThrow(/at least one stage/);
  });

  it("rejects a stage length that is not a count of ticks", () => {
    expect(() => stageAt(0, 10, [{ id: "bad", ticks: -1 }])).toThrow(/stage "bad" lasts -1 ticks/);
    expect(() => stageAt(0, 10, [{ id: "bad", ticks: 1.5 }])).toThrow(/stage "bad" lasts 1.5 ticks/);
  });

  it("rejects a tick that is not a tick", () => {
    expect(() => stageAt(-1, 10, CROP)).toThrow(/startTick/);
    expect(() => stageAt(0, Number.NaN, CROP)).toThrow(/nowTick/);
  });
});
