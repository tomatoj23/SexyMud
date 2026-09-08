/**
 * The config channel's two remaining tables (spec/04 §3.3, ADR-0032): the
 * CALENDAR (game-in-time shape) and the SETTINGS table (tuning numbers).
 *
 * Both travel the same road the dimensions table does: a host reads
 * `content/config/*.json` itself — the engine never imports content — and
 * hands the parsed tables to `createContentRegistry`, which is where the
 * checks a schema cannot make are made (ADR-0003's division of labour:
 * shape belongs to content:check, cross-field consistency to the registry).
 *
 * What is deliberately NOT here: any notion of which settings groups the
 * engine needs. The registry validates what it is handed and nothing more —
 * a missing `time` group or a missing calendar is for the ENGINE side to
 * fail loudly about, at the moment it first needs time (spec/04 §3.3). A
 * registry that threw on absence would be encoding engine requirements into
 * the content loader, which is the coupling that rule exists to prevent.
 */

/**
 * One segment of a ring: a named stretch of ticks (one shichen of the day,
 * one season of the year — the engine knows neither, it only knows ids).
 */
export interface CalendarSegment {
  readonly id: string;
  /** Length in ticks. Positive: a zero-length segment would make the period 0. */
  readonly ticks: number;
}

/**
 * One independent time axis. Its period is `Σ segments[].ticks` — there is
 * no second number to keep in sync, on purpose (ADR-0032 §2: a
 * `periodTicks` field would be a second source of truth next to the
 * segments, and next to `settings.time`).
 */
export interface CalendarRing {
  readonly id: string;
  readonly segments: readonly CalendarSegment[];
}

/**
 * A pack's calendar: a SET of rings, not one flat list of segments. One tick
 * lands on every ring at once (which shichen, which season), which is why a
 * flat table — capable of expressing exactly one axis — was rejected.
 */
export interface Calendar {
  /** The file's own stamp (the schema pins it to "calendar"); the engine never reads it. */
  readonly id?: string;
  readonly rings: readonly CalendarRing[];
}

/** One tuning group: an open bag of numbers, plus an optional `formula` note. */
export interface SettingsGroup {
  readonly [key: string]: unknown;
}

/** The settings table: group name → its bag of numbers. */
export interface SettingsTable {
  readonly [group: string]: SettingsGroup | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load-time consistency checks for a calendar — the ones a JSON Schema
 * cannot make: uniqueness of ring ids and of segment ids within a ring, and
 * the tick arithmetic that makes "period > 0" a consequence rather than a
 * separately maintained number (spec/04 §3.2).
 *
 * It is the registry's job and not the schema's for the same reason the tag
 * vocabulary is: the values being compared live in one file and no schema
 * can cross-reference them. Host-assembled data that bypassed
 * content:check gets the same failures here, exactly as the collections do.
 */
export function assertCalendar(calendar: Calendar | undefined): void {
  if (calendar === undefined) {
    return;
  }
  if (!isPlainObject(calendar)) {
    throw new Error("content registry: calendar must be an object");
  }
  const rings = calendar.rings;
  if (!Array.isArray(rings)) {
    throw new Error("content registry: calendar must declare a rings array");
  }
  if (rings.length === 0) {
    throw new Error("content registry: calendar declares no rings");
  }

  const ringIds = new Set<string>();
  for (const ring of rings) {
    if (!isPlainObject(ring)) {
      throw new Error("content registry: calendar has a ring that is not an object");
    }
    if (typeof ring.id !== "string" || ring.id === "") {
      throw new Error("content registry: calendar has a ring with an empty id");
    }
    // Rings are looked up BY id, so two of them sharing one would silently
    // hide one axis — the same reason collection ids share one space (#15).
    if (ringIds.has(ring.id)) {
      throw new Error(`content registry: calendar declares ring "${ring.id}" twice`);
    }
    ringIds.add(ring.id);

    const segments = ring.segments;
    if (!Array.isArray(segments)) {
      throw new Error(`content registry: ring "${ring.id}" must declare a segments array`);
    }
    if (segments.length === 0) {
      throw new Error(`content registry: ring "${ring.id}" declares no segments`);
    }

    const segmentIds = new Set<string>();
    for (const segment of segments) {
      if (!isPlainObject(segment)) {
        throw new Error(`content registry: ring "${ring.id}" has a segment that is not an object`);
      }
      if (typeof segment.id !== "string" || segment.id === "") {
        throw new Error(`content registry: ring "${ring.id}" has a segment with an empty id`);
      }
      if (segmentIds.has(segment.id)) {
        throw new Error(
          `content registry: ring "${ring.id}" declares segment "${segment.id}" twice`,
        );
      }
      segmentIds.add(segment.id);
      const ticks = segment.ticks;
      if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 1) {
        throw new Error(
          `content registry: segment "${segment.id}" of ring "${ring.id}" has a tick count of ${String(ticks)}; it must be a positive integer`,
        );
      }
    }
  }
}

/**
 * Load-time shape check for the settings table: every GROUP must be an
 * object. Nothing else is checked — which groups exist is the pack's
 * business, and a group the engine needs being absent is the engine's error
 * to raise when it misses it (spec/04 §6 O3).
 *
 * `id` is exempt: like the calendar's, it is the file's own stamp
 * (`{"id": "settings"}`), not a group.
 */
export function assertSettingsTable(settings: SettingsTable | undefined): void {
  if (settings === undefined) {
    return;
  }
  if (!isPlainObject(settings)) {
    throw new Error("content registry: settings must be an object");
  }
  for (const [group, value] of Object.entries(settings)) {
    if (group === "id" || value === undefined) {
      continue;
    }
    if (!isPlainObject(value)) {
      throw new Error(`content registry: settings group "${group}" must be an object`);
    }
  }
}
