import type { Clock, Command, CommandResult } from "./types.js";

/**
 * The engine's high-water tick tracker (spec/04 §2.2, ADR-0031).
 *
 * The engine has no clock of its own — a {@link Command} carries the tick it
 * happened at, and the side that *drives* the world (a `WorldRuntime`, a host
 * `Authority`, the test harness) keeps the maximum of the ticks it has let
 * through. That maximum is the only "now" the engine admits: it never
 * decreases, so a command whose tick lies in the past still runs, it just
 * cannot move the world backwards.
 *
 * Hosts do not implement {@link Clock} to model a wall clock here. Translating
 * wall time into a tick is the host's job, and it happens once — when the
 * command is built.
 */

/** A tick is a non-negative safe integer; anything else is a wiring bug. */
export function assertTick(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, got ${String(value)}`);
  }
}

export interface TickClock extends Clock {
  /**
   * Feeds one tick in and returns the (never-decreasing) high-water mark. A
   * tick below the mark is accepted and changes nothing.
   */
  observe(tick: number): number;
}

export function createTickClock(startTick = 0): TickClock {
  assertTick(startTick, "startTick");
  let maxTick = startTick;
  return {
    nowTick: () => maxTick,
    observe(tick) {
      assertTick(tick, "tick");
      if (tick > maxTick) {
        maxTick = tick;
      }
      return maxTick;
    },
  };
}

/**
 * Feeds a dispatch outcome back into the clock: only a command that reached
 * the execution stage advances the world (spec/04 §4.1).
 *
 * An `invalid` input is not a command — it consumes no seq either — so its
 * tick must not raise the high-water mark. Otherwise spamming malformed input
 * would fast-forward the world: due buckets would fire early and offline
 * catch-up spans would grow out of nothing.
 */
export function observeDispatch(
  clock: TickClock,
  command: Command,
  result: CommandResult,
): void {
  const reachedExecution = result.ok ? true : result.kind !== "invalid";
  if (reachedExecution) {
    clock.observe(command.tick);
  }
}
