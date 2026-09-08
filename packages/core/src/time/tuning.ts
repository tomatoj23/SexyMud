import type { SettingsTable } from "../content/config.js";

/**
 * The TUNING half of time: the numbers the calendar does not own. Segment
 * names and lengths are STRUCTURE and live in `calendar.json`; rates,
 * durations and cooldown defaults are TUNING and live in the `time` group of
 * `settings.json` (ADR-0032 §3, C4: structure never goes into settings).
 *
 * One rule is pinned here because it is otherwise re-litigated per system
 * (spec/04 §6 O3):
 *
 *   a missing GROUP fails loudly, a missing KEY fails loudly, and the
 *   ENGINE NEVER SUPPLIES A DEFAULT.
 *
 * The two are distinguished because they have different owners: a pack that
 * ships no `time` group at all has not configured time, and that is this
 * module's error to raise; a group that lacks the one key a system reads is
 * that system's error, raised through this accessor, because only the
 * consumer knows whether "no value" is even meaningful for it. What the
 * engine must never do is pick a number — a guessed rate is a balance
 * change nobody made, and it fails silently forever.
 */

/** Reads one tuning number out of the `time` group. */
export interface TimeTuning {
  number(key: string): number;
}

/**
 * Builds the accessor over a settings table that may be absent — the same
 * lazy shape as `createGameTime`: loading without a settings table is legal,
 * asking it for a number is not (spec/04 §3.3).
 */
export function createTimeTuning(settings: SettingsTable | undefined): TimeTuning {
  return {
    number(key) {
      const group = settings?.time;
      if (group === undefined) {
        throw new Error(
          'time tuning: no settings table carries a "time" group — ' +
            "a missing group fails loudly, the engine has no defaults to fall back on",
        );
      }
      const value = group[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `time tuning: the "time" group has no numeric key "${key}" — ` +
            "the system that consumes it must fail loudly; the engine never guesses a default",
        );
      }
      return value;
    },
  };
}
