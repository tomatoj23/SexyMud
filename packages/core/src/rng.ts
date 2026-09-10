import type { Rng } from "./types.js";

/**
 * Deterministic PRNG (mulberry32).
 *
 * All randomness flows through the Rng port, never through the platform's
 * global source (ADR-0017): the seed lives in the save, so a command
 * sequence replays identically (ADR-0023 §1 — the seed is the fifth
 * injected dependency the test harness must supply).
 *
 * **One function, two roles** (ADR-0033 §1): `createSeededRng(state)` both
 * STARTS a stream and RESTORES one. There is no `restoreRng`, because both
 * take the same single uint32 — two entry points would suggest two meanings
 * where there is one. Restoring is O(1) because mulberry32's entire state is
 * that one number; the rejected alternative (store the original seed plus a
 * call count and fast-forward) is O(age of the save), which grows without
 * bound.
 */
export function createSeededRng(state: number): Rng {
  let current = state >>> 0;
  return {
    next(): number {
      current = (current + 0x6d2b79f5) >>> 0;
      let t = current;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState(): number {
      return current;
    },
  };
}
