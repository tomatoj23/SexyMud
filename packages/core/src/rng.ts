import type { Rng } from "./types.js";

/**
 * Deterministic PRNG (mulberry32).
 *
 * All randomness flows through the Rng port, never through the platform's
 * global source (ADR-0017): the seed lives in the save, so a command
 * sequence replays identically (ADR-0023 §1 — the seed is the fifth
 * injected dependency the test harness must supply).
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
