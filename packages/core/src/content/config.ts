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
 *
 * The WORLD table (issue #49) rides the same channel for a different spec:
 * it is world-guidance STRUCTURE (spec/03 §6.1 — where a new game starts),
 * not one of spec/04's two tables, but its road is identical: host reads
 * `config/world.json`, hands it over, the registry checks it.
 */

/**
 * One segment of a ring: a named stretch of ticks (one shichen of the day,
 * one season of the year — the engine knows neither, it only knows ids).
 */
export interface CalendarSegment {
  readonly id: string;
  /**
   * The segment's DISPLAY name — the pack's own word, declared with the
   * segment (owner ruling 2026-10-25, issue #51's D2: the hour word rides
   * WITH the content, read verbatim by the renderer). Optional: absent
   * falls back to the raw id. The engine passes it through and reads
   * nothing — the id remains the only key it knows.
   */
  readonly label?: string;
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

/**
 * The pack's world-guidance declaration (`content/config/world.json`,
 * issue #49): where a new game starts. One room id is the whole table — why
 * THAT room is the pack's storytelling, and the engine knows none of it.
 */
export interface WorldTable {
  /** The file's own stamp (the schema pins it to "world"); the engine never reads it. */
  readonly id?: string;
  /** The room a new game lands in — and the fallback when a save's room is gone (#52). */
  readonly startRoomId: string;
}

/**
 * The character-model declaration (`content/config/character.json`, #56
 * T4): the pack's answer to "what numeric attributes does a player have and
 * which keys mean what in combat". STRUCTURE, not tuning — the KEY LIST and
 * the roles live here (spec/06 §6's second row), tuning numbers ride with
 * the seed values themselves. The engine knows NO key: it reads this table
 * and answers with whatever the pack declared (ADR-0009 §10).
 */
export interface CharacterTable {
  /** The file's own stamp (the schema pins it to "character"); the engine never reads it. */
  readonly id?: string;
  /** attr key → the seed value a new game writes into the player's attrs slot. */
  readonly attrs: Readonly<Record<string, number>>;
  /** The primary-resource key pair: which attr is the life bar, and which is its ceiling. */
  readonly primaryResource: {
    readonly current: string;
    readonly max: string;
  };
  /** The death threshold: the primary resource at or below this means death. */
  readonly deathAtOrBelow: number;
  /**
   * The strike operand channels (T4/T10's mandatory field face): which attr
   * key feeds the player→npc formula's attack operand, which would feed a
   * defense operand (declared for C2's two-way formula; C1's retaliation is
   * bare damage and reads no player key — the seat is declared, not used),
   * and the element/source vocabulary words a C1 bare-hand strike carries.
   */
  readonly strike: {
    readonly attackAttr: string;
    readonly defenseAttr: string;
    readonly element: string;
    readonly source: string;
  };
}

/**
 * The combat band table (`content/config/combat-tiers.json`, #56): the
 * NUMBER boundaries behind the band NAMES an event carries — display-tiers'
 * same species (a ratio table, pack-authored). The NAMES themselves are the
 * dimensions table's vocabulary (damageBand/lifeBand); this table only maps
 * ratios to them, so there is no second home for a band name (D6 review
 * note 4: band names belong to the dimensions table alone).
 */
export interface CombatTierBand {
  /** The band's name — a dimensions-table key of the matching dimension. */
  readonly band: string;
  /** The band's inclusive lower ratio bound. */
  readonly min: number;
  /** The band's exclusive upper ratio bound (the last band clamps). */
  readonly max: number;
}

/** dimension → its bands, ascending by min. */
export interface CombatTiersTable {
  /**
   * The file's own `id` stamp is deliberately not typed here — the
   * dimensions table's own arrangement (an index-signature table cannot
   * carry a differently-typed `id`; the schema tolerates and ignores it).
   */
  readonly [dimension: string]: readonly CombatTierBand[] | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load-time consistency checks for a calendar (spec/04 §3.2).
 *
 * Two of them only the registry can make — ring ids unique across the
 * calendar, segment ids unique within a ring — because the values being
 * compared live in one file and no schema can cross-reference them (draft-07
 * has no `uniqueItemProperties`). That is the same reason the tag vocabulary
 * is closed here.
 *
 * The rest (rings non-empty, ids non-empty, ticks a positive integer) DO
 * restate what the schema already says. That is deliberate and is the
 * registry's standing arrangement, not a second implementation of the
 * schema: shape validation belongs to content:check for content on disk,
 * while a host that assembled its data in code and bypassed the gate gets
 * the same failures here instead of a `NaN` period and a silently wrong
 * clock. The check exists for the arithmetic below it — `ringPeriod` divides
 * by Σ ticks — not for its own sake.
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

/**
 * Load-time shape check for the world table (issue #49). Where startRoomId
 * POINTS is the registry's referential-integrity step — it needs the loaded
 * rooms, so it lives in the build beside the exit checks; that it is a
 * non-empty string is checked HERE, so a host that assembled the table in
 * code and bypassed content:check gets the same failure the gate would have
 * given it (the standing arrangement of the checks above).
 */
export function assertWorldTable(world: WorldTable | undefined): void {
  if (world === undefined) {
    return;
  }
  if (!isPlainObject(world)) {
    throw new Error("content registry: world table must be an object");
  }
  if (typeof world.startRoomId !== "string" || world.startRoomId === "") {
    throw new Error("content registry: world table must declare startRoomId as a non-empty string");
  }
}

const isAttrSeeds = (value: unknown): value is Record<string, number> => {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (seed) => typeof seed === "number" && Number.isFinite(seed),
  );
};

/**
 * Load-time shape check for the character table (#56 T4). The checks are the
 * standing arrangement (shape here, cross-reference at the consumer's
 * first read): the key-pair channels must NAME keys, the seed values must be
 * finite numbers. Whether the named keys actually exist in `attrs` is the
 * strike settlement's loud failure to make the moment it reads them — a
 * table that names a key it never seeds is a pack bug either way, and the
 * consumer naming its own missing key is the sharper message.
 */
export function assertCharacterTable(character: CharacterTable | undefined): void {
  if (character === undefined) {
    return;
  }
  if (!isPlainObject(character)) {
    throw new Error("content registry: character table must be an object");
  }
  if (!isAttrSeeds(character.attrs) || Object.keys(character.attrs).length === 0) {
    throw new Error(
      "content registry: character table must declare attrs as a non-empty map of finite numbers",
    );
  }
  const { primaryResource, deathAtOrBelow, strike } = character;
  if (
    !isPlainObject(primaryResource) ||
    typeof primaryResource.current !== "string" ||
    primaryResource.current === "" ||
    typeof primaryResource.max !== "string" ||
    primaryResource.max === ""
  ) {
    throw new Error(
      "content registry: character table must declare primaryResource as { current, max } attr keys",
    );
  }
  if (typeof deathAtOrBelow !== "number" || !Number.isFinite(deathAtOrBelow)) {
    throw new Error("content registry: character table must declare deathAtOrBelow as a finite number");
  }
  if (
    !isPlainObject(strike) ||
    typeof strike.attackAttr !== "string" ||
    strike.attackAttr === "" ||
    typeof strike.defenseAttr !== "string" ||
    strike.defenseAttr === "" ||
    typeof strike.element !== "string" ||
    strike.element === "" ||
    typeof strike.source !== "string" ||
    strike.source === ""
  ) {
    throw new Error(
      "content registry: character table must declare strike as { attackAttr, defenseAttr, element, source }",
    );
  }
}

/**
 * Load-time shape check for the combat band table (#56): every dimension's
 * band list non-empty, band names non-empty, ratios finite, bands ascending
 * and non-overlapping. Whether the band NAMES belong to the dimensions
 * table's vocabulary is closed at the registry proper (the #27 rule: only
 * when a dimensions table was handed over) — a schema cannot read
 * dimensions.json without hardcoding one pack's vocabulary.
 */
export function assertCombatTiersTable(tiers: CombatTiersTable | undefined): void {
  if (tiers === undefined) {
    return;
  }
  if (!isPlainObject(tiers)) {
    throw new Error("content registry: combat tiers table must be an object");
  }
  let declaredAny = false;
  for (const [dimension, bands] of Object.entries(tiers)) {
    if (dimension === "id" || bands === undefined) {
      continue;
    }
    declaredAny = true;
    if (!Array.isArray(bands) || bands.length === 0) {
      throw new Error(`content registry: combat tiers dimension "${dimension}" declares no bands`);
    }
    let previousMax = Number.NEGATIVE_INFINITY;
    for (const band of bands) {
      if (
        !isPlainObject(band) ||
        typeof band.band !== "string" ||
        band.band === "" ||
        typeof band.min !== "number" ||
        !Number.isFinite(band.min) ||
        typeof band.max !== "number" ||
        !Number.isFinite(band.max)
      ) {
        throw new Error(
          `content registry: combat tiers dimension "${dimension}" has a band that is not { band, min, max }`,
        );
      }
      if (band.min >= band.max) {
        throw new Error(
          `content registry: combat tiers dimension "${dimension}" band "${band.band}" has min >= max`,
        );
      }
      if (band.min < previousMax) {
        throw new Error(
          `content registry: combat tiers dimension "${dimension}" bands overlap or descend at "${band.band}"`,
        );
      }
      previousMax = band.max;
    }
  }
  if (!declaredAny) {
    throw new Error("content registry: combat tiers table declares no dimension (an empty table is not a table)");
  }
}
