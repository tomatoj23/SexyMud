import { assertTick } from "../clock.js";
import type { Calendar, CalendarRing, CalendarSegment } from "../content/config.js";

/**
 * Game-in-time as a PURE FUNCTION of the tick (spec/04 §3, ADR-0032).
 *
 * The engine knows no calendar word — no shichen, no season, no month. It
 * knows one thing: a ring is a cycle of named segments, and a tick lands on
 * exactly one segment of that cycle. Everything else (how many segments,
 * what they are called, how long each is, how many rings a pack declares)
 * is data the host handed the registry (ADR-0032 §1).
 *
 * Two properties carry the whole design:
 *
 * - **The period is derived, never declared.** `Σ segments[].ticks` is the
 *   only number, so there is no second "ticks per day" to keep in sync with
 *   it — neither in the calendar nor in `settings.time`.
 * - **Intervals are half-open and explicitly ordered.** `[start, start +
 *   ticks)`, segments walked in declaration order, the wrap handled by ONE
 *   modulo. Not Evennia's `extended_room` `if start < end`, under which a
 *   segment crossing the year boundary (winter as `(0.75, 0.25)`) can never
 *   match and only appears to work because the loop falls through to the
 *   last key. Here the wrap is not a case to handle: it is the modulo.
 */

/** Why there is no fallback: a silent foreign calendar is worse than a crash. */
const NO_CALENDAR =
  "game time: no calendar was loaded — a pack must ship content/config/calendar.json " +
  "(spec/04 §3.1: there is no default calendar)";

/** Σ segments[].ticks: the ring's period, and the only place it is computed. */
export function ringPeriod(ring: CalendarRing): number {
  let total = 0;
  for (const segment of ring.segments) {
    total += segment.ticks;
  }
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error(`game time: ring "${ring.id}" has a period of ${String(total)}; it needs at least one segment of at least one tick`);
  }
  return total;
}

/**
 * `f(ring, tick) → segment index`: which segment of the ring a tick falls on.
 *
 * O(segments), segments being a handful. On data that never went through the
 * registry a zero-length segment is simply never selected (its half-open
 * interval is empty) rather than an error — the alternative would be a
 * second validation pass over the same data. A ring whose segments sum to
 * nothing is a different matter: `ringPeriod` rejects it, because there is
 * no period to divide by.
 */
export function segmentIndexAt(ring: CalendarRing, tick: number): number {
  assertTick(tick, "tick");
  let position = tick % ringPeriod(ring);
  for (const [index, segment] of ring.segments.entries()) {
    if (position < segment.ticks) {
      return index;
    }
    position -= segment.ticks;
  }
  // Unreachable: `position` is always below the period, which is the sum of
  // the very lengths subtracted above. Reached only by a ring whose
  // segments changed between the two reads.
  return ring.segments.length - 1;
}

/** The segment itself — the id is what a renderer or a gate keys off. */
export function segmentAt(ring: CalendarRing, tick: number): CalendarSegment {
  const segment = ring.segments[segmentIndexAt(ring, tick)];
  if (segment === undefined) {
    throw new Error(`game time: ring "${ring.id}" has no segment at tick ${String(tick)}`);
  }
  return segment;
}

/**
 * The engine's read side of a pack's calendar: every ring declared, and the
 * segment a tick lands on in any one of them.
 *
 * Rings are INDEPENDENT (ADR-0032 §2): one tick carries a position on every
 * ring at once, and this object never relates one ring to another — whether
 * a day divides evenly into a year is the data's business.
 */
export interface GameTime {
  /** Ids of every ring the calendar declares, in declaration order. */
  readonly ringIds: readonly string[];
  /** The ring's period in ticks (= Σ segment ticks). */
  periodOf(ringId: string): number;
  /** The index of the segment `tick` falls on. */
  segmentIndexOf(ringId: string, tick: number): number;
  /** The segment `tick` falls on. */
  segmentOf(ringId: string, tick: number): CalendarSegment;
}

/**
 * Builds the read side over a calendar that may be ABSENT, and that is not
 * an accident of the signature: a pack with no calendar must still load
 * (the registry does not know what the engine needs), but the first USE of
 * time has to fail loudly rather than answer a default Gregorian-looking
 * segment (spec/04 §3.3). So the object is built either way and throws at
 * the call, not at construction.
 */
export function createGameTime(calendar: Calendar | undefined): GameTime {
  const byId = new Map<string, CalendarRing>();
  for (const ring of calendar?.rings ?? []) {
    // Two rings sharing an id would silently drop one axis — the same class
    // of bug that made entry and exit ids share one space (#15). The
    // registry rejects it at load; this catches a host that built its
    // calendar in code and handed it straight over.
    if (byId.has(ring.id)) {
      throw new Error(`game time: calendar declares ring "${ring.id}" twice`);
    }
    byId.set(ring.id, ring);
  }

  const ringFor = (ringId: string): CalendarRing => {
    if (calendar === undefined) {
      throw new Error(NO_CALENDAR);
    }
    const ring = byId.get(ringId);
    if (ring === undefined) {
      throw new Error(
        `game time: unknown ring "${ringId}" (this calendar declares: ${
          [...byId.keys()].join(", ") || "none"
        })`,
      );
    }
    return ring;
  };

  return {
    get ringIds(): readonly string[] {
      if (calendar === undefined) {
        throw new Error(NO_CALENDAR);
      }
      return [...byId.keys()];
    },
    periodOf: (ringId) => ringPeriod(ringFor(ringId)),
    segmentIndexOf: (ringId, tick) => segmentIndexAt(ringFor(ringId), tick),
    segmentOf: (ringId, tick) => segmentAt(ringFor(ringId), tick),
  };
}
