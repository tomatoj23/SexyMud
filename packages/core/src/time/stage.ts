import { assertTick } from "../clock.js";

/**
 * Pure stage evaluation (spec/04 §4.1, ADR-0025 §三): `f(startTick, nowTick,
 * stages)` — which stage of a progression a thing is in.
 *
 * ADR-0025 named three needs for it: a door that relocks after N ticks, a crop
 * with four growth stages, and "how long until my skill is back". The first
 * and third are COOLDOWNS (a `nowTick >= dueTick` comparison, see
 * cooldown.ts); this is the second — a progression with named phases.
 *
 * It is a PURE FUNCTION: no registration, no state, no callback, nothing to
 * store and nothing to cancel. Asking costs one subtraction and one walk over
 * a handful of stages, so a player who leaves for a hundred thousand ticks and
 * comes back is answered by the same call as one who never left — there is no
 * advance to run, because nothing "happens" when a stage changes. That is the
 * property Evennia's stage callbacks could not offer: theirs were "not
 * guaranteed to be called", and they ran off a wall clock.
 *
 * ⚠️ Stages are LINEAR and CLAMPED, unlike a calendar ring (§3.2), which is
 * cyclic. A crop ripens and stays ripe; a shichen comes round again. Same
 * `{ id, ticks }` shape, opposite semantics — hence two functions rather than
 * one with a `cyclic` flag.
 */

/** One phase of a progression: a name and how long it lasts. */
export interface Stage {
  readonly id: string;
  readonly ticks: number;
}

export interface StageReadout {
  /** Index into the `stages` the caller passed. */
  readonly index: number;
  /** The stage itself; its id is what a renderer or a gate keys off. */
  readonly stage: Stage;
  /** Ticks already spent inside this stage; equals `stage.ticks` when done. */
  readonly elapsed: number;
  /** Ticks until the next stage begins; 0 when there is no next stage. */
  readonly remaining: number;
  /** True once the last stage has run its course — it does not wrap around. */
  readonly done: boolean;
}

/**
 * Which stage `nowTick` is in, counting from `startTick`.
 *
 * O(1) in the SPAN — one subtraction, no iteration over ticks, which is the
 * class §4.4 cares about — and one walk over the stages, which are a handful
 * of content-sized entries.
 *
 * A `startTick` in the future reads as "not started" (elapsed 0) rather than
 * as an error: the pair may legitimately come from data that has not caught up
 * (a save restored ahead of the clock), and there is no stage to name before
 * the start.
 */
export function stageAt(
  startTick: number,
  nowTick: number,
  stages: readonly Stage[],
): StageReadout {
  assertTick(startTick, "startTick");
  assertTick(nowTick, "nowTick");
  const first = stages[0];
  if (first === undefined) {
    // No stage to name: answering "index -1" would push the failure into
    // every caller instead of the one place that can explain it.
    throw new Error("stage: a progression needs at least one stage");
  }

  let elapsed = Math.max(0, nowTick - startTick);
  for (const [index, stage] of stages.entries()) {
    if (!Number.isSafeInteger(stage.ticks) || stage.ticks < 0) {
      throw new Error(
        `stage: stage "${stage.id}" lasts ${String(stage.ticks)} ticks; it must be a non-negative integer`,
      );
    }
    if (elapsed < stage.ticks) {
      return {
        index,
        stage,
        elapsed,
        remaining: stage.ticks - elapsed,
        done: false,
      };
    }
    elapsed -= stage.ticks;
  }

  // Past the end: the last stage, and it stays there. A ripe crop does not
  // go back to being a seedling.
  const last = stages[stages.length - 1]!;
  return { index: stages.length - 1, stage: last, elapsed: last.ticks, remaining: 0, done: true };
}
