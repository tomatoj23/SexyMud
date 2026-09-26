/**
 * The host's wall-to-tick translator (spec/04 §2.3, ADR-0031, O5).
 *
 * ⚠️ This is NOT the engine's `Clock` port — that one was flipped (ADR-0031)
 * into the engine's high-water READING (`WorldRuntime.clock`). This is the
 * opposite direction: the tick PRODUCER, consulted when a `Command` is built
 * and when the host drives a heartbeat. Same shape (`nowTick()`), different
 * meaning, hence a different name — a host never implements the engine port.
 *
 * The engine stays pure: `Date.now()` lives HERE and nowhere else in the game
 * glue (tests/host-purity.test.ts enforces it mechanically), because a second
 * wall reading would be a second "now" to disagree with this one.
 */

/**
 * How many real seconds one tick is (O5, spec/04 §6).
 *
 * ⚠️ It is a HOST parameter and stays out of `content/` on purpose: the
 * engine never reads it (it speaks ticks only), and `content/` is "the stuff
 * the engine reads" — parking it there would announce a consumption that
 * does not exist. It is not a `settings.json` number either: that table is
 * engine TUNING.
 */
export interface HostClockOptions {
  /**
   * Real seconds per tick. Must resolve to a whole number of milliseconds
   * (the wall clock's own resolution) — `1`, `0.5`, `0.001` all pass, `1/3`
   * fails loudly. See {@link createHostClock} for why a fractional
   * millisecond width is refused instead of rounded.
   */
  tickSeconds: number;
  /**
   * Wall milliseconds source, default `Date.now`. Injected so tests move the
   * wall clock without timers — and so this module owns the only call site.
   */
  now?: () => number;
}

/**
 * "What tick is it on the wall" — the host's translation, nothing else.
 */
export interface HostClock {
  nowTick(): number;
}

/**
 * One tick is `tickSeconds` real seconds, counted from the Unix epoch —
 * `tick = floor(wallMs / tickMs)`.
 *
 * The width is snapped to WHOLE milliseconds and the snap is validated by an
 * exact round trip (`tickMs / 1000 === tickSeconds`), for two reasons that
 * are one reason: the width has to be exact at the boundaries. `16.1 * 1000`
 * is `16100.000000000002`, and a division by that noise rolls the tick one
 * millisecond late at EVERY boundary; a width like `1/3` second is not
 * expressible in milliseconds at all, and quietly rounding it to 333 would
 * make the host's number a lie. So: whole milliseconds or a loud failure —
 * a wiring bug, not play. With an integer width the quotient at
 * `wallMs = k * tickMs` is exactly `k`, so boundaries are exact.
 *
 * The epoch is ABSOLUTE and carries no anchor of its own, and that is the
 * whole point (spec/04 §4.2): the offline span between "went away" and "came
 * back" is just the difference between two readings of this same formula, so
 * a save needs no wall-clock side channel to recover it. A counter anchored
 * at session start would restart at 0 on every reload; the high-water mark
 * would then never see a gap and offline catch-up would silently be zero
 * forever. (The mark still absorbs a backwards jump from a corrected system
 * clock — ticks never rewind the world, spec/04 §2.2.)
 */
export function createHostClock(options: HostClockOptions): HostClock {
  const { tickSeconds } = options;
  const tickMs = Math.round(tickSeconds * 1000);
  if (!Number.isSafeInteger(tickMs) || tickMs <= 0 || tickMs / 1000 !== tickSeconds) {
    // Zero, negative, NaN, Infinity and un-millisecond widths all land here.
    throw new Error(
      `host clock: tickSeconds must resolve to a positive whole number of milliseconds, got ${String(tickSeconds)}`,
    );
  }
  const now = options.now ?? Date.now;
  return {
    nowTick: () => Math.floor(now() / tickMs),
  };
}
