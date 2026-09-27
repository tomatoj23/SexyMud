import { describe, expect, it } from "vitest";
import { createSeededRng } from "../src/rng.js";

/**
 * The seeded stream (ADR-0017, ADR-0023 §1): every random value in the
 * engine flows through the Rng port, seeded from the save so one command
 * sequence replays identically. The stream's own unit contract lives here;
 * the start-vs-restore equivalence (`getState()` round-trip, ADR-0033 §1) is
 * pinned in save-v2.test.ts where the save's `rngState` is the consumer.
 */
describe("createSeededRng (ADR-0017: randomness through the port)", () => {
  it("seeds through a uint32 — negative, fractional and overflowing seeds truncate", () => {
    // `state >>> 0` is the whole contract: two spellings of one state must
    // roll one stream, or a replay would depend on how the save was written.
    expect(createSeededRng(-1).getState()).toBe(4294967295);
    expect(createSeededRng(1.9).getState()).toBe(1);
    expect(createSeededRng(2 ** 32).getState()).toBe(0);
    expect(createSeededRng(-1).next()).toBe(createSeededRng(4294967295).next());
    expect(createSeededRng(1.9).next()).toBe(createSeededRng(1).next());
    expect(createSeededRng(2 ** 32).next()).toBe(createSeededRng(0).next());
  });

  it("rolls inside [0, 1) — half-open, whatever the seed", () => {
    for (const seed of [0, 1, 42, 4294967295]) {
      const rng = createSeededRng(seed);
      for (let roll = 0; roll < 200; roll++) {
        const value = rng.next();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });
});
