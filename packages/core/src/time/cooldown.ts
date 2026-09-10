import { assertTick } from "../clock.js";

/**
 * Cooldowns (spec/04 §4.6, ADR-0032 §5): a `key → due tick` table, and a
 * TICK COMPARISON — not a timer, not a callback, not a handle.
 *
 * That single sentence is the whole design. "Is my skill back?" is
 * `nowTick >= dueTick`, which is:
 *
 * - **deterministic** — no scheduling jitter, no ordering by who asked first;
 * - **free** — one comparison, no registration, no wake-up;
 * - **trivially storable** — a number, so a long cooldown survives a reload.
 *
 * It costs nothing to answer at any tick, including one a million ticks later,
 * which is why it — unlike the due bucket — needs no advance at all: nothing
 * has to happen for a cooldown to expire. The world simply reaches the tick.
 *
 * The table lives on the entity (§4.6): my skill is not your skill. Absent key
 * means "never used", i.e. ready — not "unknown".
 *
 * ⚠️ It is a READ-ONLY table from the engine's point of view: judgement is a
 * read. Arming one is one assignment by the system that owns the key; there is
 * deliberately no `cancel`, no `extend`, no `query by prefix` — a cooldown is
 * not an object with a lifecycle, and giving it one would reintroduce the
 * per-object timer this replaces (ADR-0025 §三).
 */

/** `key → the tick it becomes available again`. Missing key = ready. */
export type CooldownTable = Record<string, number>;

/**
 * Whether the key is off cooldown at `nowTick`.
 *
 * The comparison is `>=`, not `>`: a cooldown due AT tick 100 is usable at
 * 100 — the tick it names is the first tick it is ready, because the span it
 * covers is `[armed, due)` and intervals in this engine are half-open (§3.2).
 */
export function cooldownReady(cooldowns: CooldownTable, key: string, nowTick: number): boolean {
  assertTick(nowTick, "nowTick");
  const dueTick = cooldowns[key];
  // Missing means never armed: there is no "unknown" state to distinguish
  // from "ready", and inventing one would only add a way to get it wrong.
  if (dueTick === undefined) {
    return true;
  }
  return nowTick >= dueTick;
}

/**
 * How many ticks are left, 0 when ready — "how long until my skill is back",
 * one of the three needs ADR-0025 §三 named for this family.
 * Derived, never stored: a stored remaining count would need the advance to
 * decrement it, which is a per-object timer wearing a cooldown's clothes.
 */
export function cooldownRemaining(cooldowns: CooldownTable, key: string, nowTick: number): number {
  assertTick(nowTick, "nowTick");
  const dueTick = cooldowns[key];
  if (dueTick === undefined) {
    return 0;
  }
  return Math.max(0, dueTick - nowTick);
}
