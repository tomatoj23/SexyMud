import type { CommandEntry } from "../command/entry.js";
import { forEachHasTag } from "../conditions.js";
import type { AccessRules } from "../conditions.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../world/entry.js";
import { assertCalendar, assertSettingsTable } from "./config.js";
import type { Calendar, SettingsTable } from "./config.js";
import type { EntryCommon, TagMap } from "./entry.js";
import { compareIds } from "./order.js";
import { flattenCollection } from "./prototype.js";
import type { FlattenableEntry } from "./prototype.js";

/**
 * The content registry (spec/00, ADR-0003): the single channel through which
 * the engine reads game content.
 *
 * The engine NEVER imports content data — no module under src/ touches a
 * content/ file. Hosts (and tests playing the host role) load and parse the
 * JSON themselves, then hand the entries to the registry. What the registry
 * adds is load-time referential integrity (ADR-0003's division of labour):
 * duplicate ids and unknown id lookups throw loudly, and world references
 * (an exit's target room, a room's placements, an npc's monsterId) must all
 * resolve — a broken content set fails at startup rather than at some
 * player's command. Full shape validation is NOT repeated here — that is
 * content:check's job (the offline schema gate); a host assembling data that
 * bypassed it gets loud failures from the consumers (verb table, cmdset
 * merge, condition evaluator) anyway.
 *
 * Collections are ADDITIVE, and since issue #39 each one is a ROW in a
 * declaration table (see CollectionDecl): the assembly pipeline's per-
 * collection obligations — one shared id space, prototype flattening, the
 * placeable union, the entity feed into the tag index, sorted exposure and
 * the read surface, and the closing deep freeze — are all driven off that
 * table, so a new collection declares itself instead of editing six places
 * of mechanical parallelism. The typed getters stay hand-written (they are
 * the registry's reason to exist, see ContentRegistry); the table derives no
 * compile-time type.
 *
 * Every collection is optional in the input — a host loads what exists — but
 * references are checked against what WAS loaded, so omitting a collection
 * while something references it fails loudly (a dangling reference is a
 * dangling reference).
 *
 * On top of the collections the registry builds the (dimension, key) inverted
 * index (`byTag`, ADR-0029 §2) and, when the host hands it a dimensions
 * table, closes the tag vocabulary against it (ADR-0029 §5) — entry `tags`
 * AND `has_tag` gate arguments, the two ways content names a tag pair (#27).
 * See the comments on buildTagIndex and closeGateTags.
 *
 * The three config tables ride the same channel: `dimensions`, `settings`
 * and `calendar` are all handed over by the host (which read config/ itself)
 * and all validated here for the one thing a schema cannot check —
 * consistency BETWEEN values in one file. None of them is REQUIRED: the
 * registry does not know what the engine needs, and a missing calendar or
 * `time` group is the engine's failure to raise when it first wants time
 * (spec/04 §3.3), not a load-time one.
 *
 * The load order is a contract, not an arrangement (spec/03 §6.1):
 *
 *   id de-duplication (one space, entries and exits) → prototype flattening →
 *   referential integrity → build the byTag index
 *
 * Flattening comes BEFORE integrity so that an inherited exit, placement or
 * monsterId is checked like a declared one — otherwise "put it in a
 * prototype" would be a back door around every check below. The index comes
 * LAST so that an inherited tag is as queryable as a declared one. The build
 * then closes with a deep freeze (issue #39, D3): "loaded content is
 * immutable" used to be a contract kept by hand — `tagsOf` and `room(id)`
 * hand out internal references, and a host mutating one would silently fork
 * `byTag` from `tagsOf` — and is now kept by the machine.
 */

/**
 * The id-bearing shape the registry needs of monster entries. The monster
 * collection itself has not landed as a first-class collection yet (its
 * schema predates the MUD pivot and awaits re-evaluation), but npcs may
 * already reference monsters — so hosts that load monster files hand them
 * over as-is: structurally they carry an id, which is all referential
 * integrity needs. A future full MonsterEntry type deepens this shape
 * compatibly.
 *
 * It extends EntryCommon because a monster is an entry collection like any
 * other: its tags must reach the inverted index (M3-T2) even before the rest
 * of its shape is pinned down.
 */
export interface MonsterRecord extends EntryCommon {
  readonly id: string;
}

/**
 * A dimensions table: dimension → its CLOSED set of keys (ADR-0029 §5).
 * Hosts hand the registry the table their pack declared
 * (content/config/dimensions.json) — the engine never imports content, and a
 * pack's vocabulary is that pack's business. Handing it over is OPTIONAL:
 * with it, every declared tag is checked against it and a stray dimension or
 * key fails at load; without it, nothing is checked and `byTag` still works,
 * because the index is keyed by (dimension, key) and needs no notion of which
 * dimensions are legal.
 */
export interface DimensionTable {
  readonly [dimension: string]: readonly string[] | undefined;
}

/** What a host may hand the registry besides the collections themselves. */
export interface ContentRegistryOptions {
  /** Present → tag values are validated against it; absent → skipped. */
  readonly dimensions?: DimensionTable;
  /**
   * The pack's tuning numbers (`config/settings.json`). Present → checked
   * for shape; absent → nothing to check. Which groups EXIST is never
   * asserted here (spec/04 §6 O3).
   */
  readonly settings?: SettingsTable;
  /**
   * The pack's calendar (`config/calendar.json`). Present → ring and
   * segment ids are checked for uniqueness and tick counts for sanity;
   * absent → nothing to check (spec/04 §3.3).
   */
  readonly calendar?: Calendar;
}

/** The read side of loaded content: lookups over validated collections. */
export interface ContentRegistry {
  /**
   * Every command entry, id-ascending. Canonical order makes downstream
   * assembly (cmdset grouping, verb tables) deterministic across processes
   * (ADR-0024 §2) no matter what order the host loaded files in.
   */
  readonly commands: readonly CommandEntry[];
  /**
   * One command by id. Unknown ids throw — a dangling command reference is
   * a broken content set, and "fail loudly at load" beats "silently missing
   * command at dispatch" (ADR-0003).
   */
  command(id: string): CommandEntry;
  /** Every room entry, id-ascending (determinism, as with commands). */
  readonly rooms: readonly RoomEntry[];
  room(id: string): RoomEntry;
  /**
   * One exit by id, searched across all rooms: exits are entities with
   * global ids (dispatch keys), not per-room fields. Unknown ids throw —
   * this lookup is how a renderer resolves a refusal event's commandKey
   * back to the exit's err_* copy.
   */
  exit(id: string): ExitEntry;
  /** Every npc entry, id-ascending. */
  readonly npcs: readonly NpcEntry[];
  npc(id: string): NpcEntry;
  /** Every monster record, id-ascending. Empty when no monsters were loaded. */
  readonly monsters: readonly MonsterRecord[];
  monster(id: string): MonsterRecord;
  /**
   * The inverted tag index: every entity carrying `tags: { dimension: [key] }`
   * is reachable from each of its (dimension, key) pairs, id-ascending and
   * across collections (ADR-0029 §2) — "every room tagged outdoors gets the
   * weather tick" without the engine knowing what a room is.
   *
   * ENTITIES, not entries: exits are in here too. An exit's id is a dispatch
   * key (spec/02 §4), so it shares one id space with entry ids and mixes into
   * results harmlessly — and a tag one could write on an exit but never query
   * would be a dead field (decided 2026-09-02 on #15, spec/03 §5.1).
   *
   * `flags` are NOT in here: a flag is a bare boolean ("is it lit"), not a
   * classification, and is deliberately unqueryable in batches (ADR-0029 §4).
   * An unknown (dimension, key) pair answers an empty array rather than
   * throwing: the index knows nothing about which dimensions exist.
   */
  byTag(dimension: string, key: string): readonly string[];
  /**
   * The DUAL of `byTag`: one entity's own tags, `{ <dimension>: [key…] }` —
   * `byTag` answers "who carries this pair", `tagsOf` answers "what does
   * this one carry". Built in the same pass over the same entity set
   * (entries AND exits), so the two can never disagree.
   *
   * Its consumer is the runtime's `hasTag` union (M3-T5): a dynamic
   * occupant answers "own tags ∪ the tags of the content entry it is" — and
   * today's players HAVE no content entry, so an unknown id answers an EMPTY
   * map rather than throwing. "No entry" is the normal case here, not a
   * wiring bug — unlike every other lookup on this interface.
   *
   * An entity that declared no tags answers an empty map too (it is absent
   * from the map entirely), and `flags` are as absent here as they are from
   * `byTag` (ADR-0029 §4). The answer is frozen either way (issue #39).
   */
  tagsOf(id: string): TagMap;
  /**
   * The pack's calendar, exactly as handed over — `undefined` when the host
   * had none. Read BACK out of the registry rather than kept alongside it so
   * there is ONE validated source (the same object, not a copy): the engine
   * side that turns a tick into a segment (`createGameTime`) takes it from
   * here, and swapping the content directory swaps the calendar with it
   * (spec/04 §3, ADR-0032). The whole registry's contract is that loaded
   * content is immutable — the build deep-freezes every loaded ENTRY (issue
   * #39) so a host mutating one fails in its hands; this table keeps the
   * one-copy arrangement by contract, validated once and read back here.
   */
  readonly calendar: Calendar | undefined;
  /**
   * The pack's tuning numbers, `undefined` when the host had none — the same
   * one-copy arrangement as `calendar`.
   */
  readonly settings: SettingsTable | undefined;
}

/**
 * Adds `entry` to `byId`, throwing if its id is already taken — **by
 * anything at all**, not just by another entry of the same collection.
 *
 * `owners` is one id space shared by every collection and by exits, because
 * that is what the ids really are: `byTag` returns entry ids and exit ids
 * MIXED in one list (ADR-0029 §2, #15), so two entities sharing an id would
 * silently collapse into one result row, and an exit id is a dispatch key
 * (spec/02 §4) that already has to be unique across the world. Previously
 * the collections were checked independently, which made "one id, one thing"
 * a content convention; it is now enforced at load.
 */
function addUnique<T extends { id: string }>(
  byId: Map<string, T>,
  entry: T,
  what: string,
  owners: Map<string, string>,
): void {
  if (typeof entry.id !== "string" || entry.id === "") {
    throw new Error(`content registry: ${what} entry with an empty id`);
  }
  const owner = owners.get(entry.id);
  if (owner !== undefined) {
    throw new Error(
      owner === what
        ? `content registry: duplicate ${what} id "${entry.id}"`
        : `content registry: id "${entry.id}" is claimed by both "${owner}" and "${what}"`,
    );
  }
  owners.set(entry.id, what);
  byId.set(entry.id, entry);
}

/** The ids of a collection, id-ascending (the canonical exposure order). */
function sortedValues<T extends { id: string }>(byId: Map<string, T>): readonly T[] {
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

/** Re-indexes a collection by id, keeping the order it came back in. */
function byId<T extends { id: string }>(entries: readonly T[]): Map<string, T> {
  return new Map(entries.map((entry) => [entry.id, entry] as const));
}

/**
 * What the index needs of an entity: an id to return and the tags to index.
 * Collections are irrelevant here — the index holds ENTRIES (commands, rooms,
 * npcs, monsters) and EXITS side by side, which is exactly why this type is
 * not "Entry". It is the same shape the flattener asks for (it is the shape
 * every entry type has), so it is named there and borrowed here.
 */
type TaggedEntity = FlattenableEntry;

/**
 * What `tagsOf` answers for an entity with no tags — and, more importantly,
 * for an id no collection knows: a player has no content entry, and "no
 * entry" must read as "no static tags", not as a wiring bug. One frozen
 * object shared by every such answer.
 */
const NO_TAGS: TagMap = Object.freeze({});

/**
 * What `byTag` answers for a pair no entity carries — the exact dual of
 * NO_TAGS: one frozen empty list shared by every such answer, so an unknown
 * pair is as unforgeable as an unknown id's empty map.
 */
const EMPTY_IDS: readonly string[] = Object.freeze([]);

/** dimension → key → ids, all sorted once at build time. */
type TagIndex = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

/** What buildTagIndex returns: the inverted index plus its dual, id → tags. */
interface TagIndexes {
  readonly byPair: TagIndex;
  readonly byEntity: ReadonlyMap<string, TagMap>;
}

/**
 * Builds the (dimension, key) inverted index over every entity that carries
 * tags, its dual `id → tags`, and — if the host passed a dimensions table —
 * closes the tag vocabulary against it while doing so (ADR-0029 §2/§5).
 *
 * Both maps come out of ONE pass over ONE entity list, which is the whole
 * reason they cannot drift apart: `byTag(d, k)` containing an id and
 * `tagsOf(id)` carrying (d, k) are the same fact stated from both ends
 * (#17 — the runtime's hasTag union reads tagsOf, the batch queries read
 * byTag, and a disagreement between them would be untestable).
 *
 * The claim is scoped to content AS LOADED: like every other getter here
 * (`room(id)` included) `tagsOf` hands out an internal reference. It used to
 * be the host's duty to leave those alone; the build now deep-freezes every
 * entry (issue #39), so the reference is unforgeable at runtime and the two
 * maps physically cannot be forked.
 *
 * Validation lives HERE rather than in the schema because closure is a
 * content-pack fact: a schema cannot read dimensions.json without hardcoding
 * one pack's vocabulary (ADR-0004: no hardcoded enums), so the check moves to
 * load time where the table is in hand. It is therefore conditional — no
 * table, no check, and the index is built all the same.
 *
 * Ordering: buckets are sorted once, at build time, so a query is a lookup
 * and never depends on the order the host loaded files in.
 */
function buildTagIndex(
  entities: Iterable<TaggedEntity>,
  dimensions: DimensionTable | undefined,
): TagIndexes {
  const collected = new Map<string, Map<string, Set<string>>>();
  const byEntity = new Map<string, TagMap>();

  for (const entity of entities) {
    const tags = entity.tags;
    if (tags === undefined) {
      continue;
    }
    // The entry's own map, untouched: entries arrive flattened (so the keys
    // are already sorted and de-duplicated), exits arrive as authored. It is
    // typed readonly and frozen with the entry (issue #39).
    byEntity.set(entity.id, tags);
    for (const [dimension, keys] of Object.entries(tags)) {
      if (dimensions !== undefined) {
        const allowed = dimensions[dimension];
        if (allowed === undefined) {
          throw new Error(
            `content registry: entity "${entity.id}" tags unknown dimension "${dimension}"`,
          );
        }
        for (const key of keys ?? []) {
          if (!allowed.includes(key)) {
            throw new Error(
              `content registry: entity "${entity.id}" tags key "${key}" outside dimension "${dimension}"`,
            );
          }
        }
      }

      let byKey = collected.get(dimension);
      if (byKey === undefined) {
        byKey = new Map<string, Set<string>>();
        collected.set(dimension, byKey);
      }
      for (const key of keys ?? []) {
        let ids = byKey.get(key);
        if (ids === undefined) {
          ids = new Set<string>();
          byKey.set(key, ids);
        }
        ids.add(entity.id);
      }
    }
  }

  const index = new Map<string, Map<string, readonly string[]>>();
  for (const [dimension, byKey] of collected) {
    const sortedByKey = new Map<string, readonly string[]>();
    for (const [key, ids] of byKey) {
      // Frozen like every other answer the registry hands out (issue #39):
      // a bucket is internal index state, and a caller pushing an id into it
      // would silently fork `byTag` from `tagsOf`.
      sortedByKey.set(key, Object.freeze([...ids].sort(compareIds)));
    }
    index.set(dimension, sortedByKey);
  }
  return { byPair: index, byEntity };
}

/**
 * The CONDITION half of the tag-vocabulary closure (issue #27 follow-up):
 * every `has_tag` gate names a `(dimension, key)` pair, and a typo'd dimension
 * there would otherwise evaluate `false` SILENTLY — the gate denies everyone
 * and nothing says why. Same contract as the tags closure above: only when
 * the host handed over a table (ADR-0029 §5), and over the flattened set, so
 * an inherited gate is checked like a declared one.
 */
function closeGateTags(
  entities: Iterable<{ id: string; preconditions?: AccessRules }>,
  dimensions: DimensionTable | undefined,
): void {
  if (dimensions === undefined) {
    return;
  }
  for (const entity of entities) {
    for (const rule of Object.values(entity.preconditions ?? {})) {
      forEachHasTag(rule, (dimension, key) => {
        const allowed = dimensions[dimension];
        if (allowed === undefined) {
          throw new Error(
            `content registry: entity "${entity.id}" has_tag references unknown dimension "${dimension}"`,
          );
        }
        if (!allowed.includes(key)) {
          throw new Error(
            `content registry: entity "${entity.id}" has_tag key "${key}" outside dimension "${dimension}"`,
          );
        }
      });
    }
  }
}

/**
 * One collection as DECLARATION (issue #39, C5): a row of data expressing
 * what the assembly pipeline owes that collection. The pipeline's per-
 * collection obligations — de-duplication into the one id space, prototype
 * flattening, the placeable union, the entity feed, sorted exposure, the
 * getter surface and the closing deep freeze — read these fields and never
 * name a collection, so a new one joins by declaring a row (plus its typed
 * getter pair and its entry type — the thin, hand-written side).
 *
 * The row carries OBLIGATIONS, not types: the table never derives a
 * compile-time type (the C5 review's limit — a mapped-type interface is
 * clever code in a module that owes readability), so typed consumers name
 * their entry type at the call site (see CollectionTable.idMap).
 */
export interface CollectionDecl {
  /**
   * The word naming the collection in error messages ("command", "room", …)
   * — and, for collections with a plural exposure, the singular lookup's
   * method name on the registry (`command(id)`, `room(id)`, …). One word per
   * collection, used everywhere a human is told which collection spoke.
   */
  readonly what: string;
  /**
   * Whether entries inherit WITHIN this collection (ADR-0030 §3) and so go
   * through prototype flattening. `false` for exits: they live inside rooms,
   * arrive through the already-flattened room, and a room's `exits` is
   * replaced wholesale — an exit list is flattened with its room, never on
   * its own. On a `false` row the `prototype*` pair has no consumer and is
   * left untouched (for exits that is constructive, see prototype.ts); a
   * future non-flattening row would inherit the same silence, so declare it
   * knowingly.
   */
  readonly flatten: boolean;
  /**
   * Whether a room's placement list may name this collection's ids (spec/03
   * §2 — a room is a content container). The union of every `placeable`
   * collection's ids is the whole check's universe: a new placeable
   * collection becomes placeable by declaring it, never by editing the
   * check.
   */
  readonly placeable: boolean;
  /**
   * The registry's plural exposure key ("commands", …) — which doubles as
   * the host input key (`content.commands`). `null` = the collection carries
   * neither: the exits row — no plural getter, no host input (its entries
   * are DERIVED from rooms by the build itself, its ids claimed one edge at
   * a time beside the edge checks), and its single `exit(id)` lookup is a
   * non-collection member kept by hand (ContentRegistry: the query face is
   * not the declaration table's business). A `null` row still takes every
   * other obligation once ingested.
   */
  readonly expose: string | null;
}

const COMMANDS: CollectionDecl = Object.freeze({
  what: "command",
  flatten: true,
  placeable: false,
  expose: "commands",
});
const ROOMS: CollectionDecl = Object.freeze({
  what: "room",
  flatten: true,
  placeable: false,
  expose: "rooms",
});
const NPCS: CollectionDecl = Object.freeze({
  what: "npc",
  flatten: true,
  placeable: true,
  expose: "npcs",
});
const MONSTERS: CollectionDecl = Object.freeze({
  what: "monster",
  flatten: true,
  placeable: true,
  expose: "monsters",
});
const EXITS: CollectionDecl = Object.freeze({
  what: "exit",
  flatten: false,
  placeable: false,
  expose: null,
});

/**
 * The declaration table (issue #39): five rows — the four host-input
 * collections in input order and the derived exits row — in LOAD ORDER, which
 * is load-bearing: the first taker of a shared id is whoever comes first here
 * (see addUnique). Not frozen into a narrower type and not consulted for
 * vocabulary: the rows name engine-side collections (typed shapes the engine
 * carries), never pack vocabulary — dimensions and keys stay the pack's
 * business (ADR-0004), and the query side still knows no collections
 * (ADR-0029 §2).
 */
export const COLLECTIONS: readonly CollectionDecl[] = Object.freeze([
  COMMANDS,
  ROOMS,
  NPCS,
  MONSTERS,
  EXITS,
]);

/** One collection's live state during assembly: its declaration and its id map. */
interface CollectionSlot {
  readonly decl: CollectionDecl;
  /** THE live map — replaced wholesale by flattening (obligation 2). */
  byId: Map<string, FlattenableEntry>;
}

/**
 * The declaration table in its live form (issue #39): one slot per ingested
 * collection, in ingest order. Every assembly obligation the pipeline owes a
 * collection is a method here, so the build cannot forget one and a new
 * collection cannot need one edited.
 */
interface CollectionTable {
  /**
   * Obligation 1 — de-duplication into the ONE shared id space (see
   * addUnique): registers the collection's slot and takes its ids.
   */
  ingest(
    decl: CollectionDecl,
    entries: Iterable<FlattenableEntry>,
    idOwners: Map<string, string>,
  ): void;
  /**
   * Obligation 1 at single-entry granularity: claims one id. The exits row
   * uses it because its derivation interleaves claims with the edge's own
   * checks — the interleaving is pinned (an exit's claim precedes its checks
   * and a later exit's claim never preempts an earlier exit's failing check,
   * content-registry.test.ts, the inherited-exit integrity case),
   * so its ids cannot be claimed in a second pass. `ingest` is this, one
   * entry at a time; the row must already be registered.
   */
  claim(decl: CollectionDecl, entry: FlattenableEntry, idOwners: Map<string, string>): void;
  /** Obligation 2 — prototype flattening, for rows that declare it. */
  flattenAll(): void;
  /**
   * A collection's id map, typed by its CONSUMER. A declaration row carries
   * obligations, not types (see CollectionDecl), so the typed world-graph
   * checks name their entry type here; the cast is sound because the host
   * input is typed (`createContentRegistry`'s parameter) and ingest preserves
   * the entries it was handed. Hand out the map only after the row has
   * settled — flattening REPLACES the map, derived rows claim into it — so
   * callers read it after their row's phase, never before.
   */
  idMap<T extends FlattenableEntry>(decl: CollectionDecl): ReadonlyMap<string, T>;
  /** Obligation 3 — the placeable union: every placeable row's ids. */
  placeableIds(): ReadonlySet<string>;
  /**
   * Obligation 4 — the entity feed: every entity of every row, in table
   * order. ONE list for the tag index and the gate closure, so a new
   * collection's tags are indexed and its gates closed by existing (the old
   * hand-maintained list failed SILENTLY when a line was forgotten).
   */
  entities(): readonly FlattenableEntry[];
  /**
   * Obligations 5+6 — sorted exposure and the getter surface, GENERATED from
   * the rows: one plural (`expose` key, id-ascending) and one singular lookup
   * (`what` method, unknown id throws) per exposed row. Computed keys cannot
   * be typed without a mapped type — the derivation route the C5 review
   * rejected — so the result is asserted to the interface it half-implements;
   * the typed face is the hand-written ContentRegistry interface (the thin
   * sugar a new collection adds), and the five non-collection members are
   * added by the caller and type-checked there.
   *
   * Member ENUMERATION order follows the table (a plural/singular pair per
   * row), so `exit` — added after the spread — enumerates AFTER the four
   * pairs rather than between the rooms pair and the npcs pair as the old
   * hand-written literal had it. No consumer enumerates a registry (grep
   * 2026-10-05: zero `Object.keys`/spread/`JSON.stringify` over one in
   * packages/ or apps/), and the interface never promised an order — it is
   * a declared consequence of the generated face, not a silent one.
   */
  surface(): ContentRegistry;
  /** D3 — the closing deep freeze over every row's entities (see deepFreeze). */
  freezeAll(): void;
}

/**
 * Deep freeze (D3, issue #39): recursively freezes an entry and everything
 * hanging off it — `tags`, `exits`, placements, gate rules. Loaded content
 * being immutable is the registry's whole contract; it used to be kept by
 * hand (only `NO_TAGS` was actually frozen) and a runtime write would fork
 * `byTag` from `tagsOf` silently. Frozen, the same write throws in the
 * mutator's hands.
 *
 * Recursion does NOT stop at an already-frozen container: a host that
 * shallow-froze its own entries before handing them over would otherwise
 * keep a mutable graph inside a frozen shell — the exact fork this exists
 * to kill (probed 2026-10-05, /fh). One `seen` memo per freeze pass walks
 * each object once and keeps a cyclic (host-assembled, non-JSON) graph from
 * looping forever. Scope is the JSON-shaped content domain: `Map`/`Set`
 * interiors and functions are outside the content shapes (the schema gate
 * admits none), and `Object.freeze` could not seal those in any case.
 */
function deepFreeze<T>(value: T, seen: Set<object>): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return value;
}

/**
 * The member names the read face writes BY HAND (the non-collection members
 * of ContentRegistry). A declaration row may not claim one: its generated
 * member would be overwritten by the hand-written one in the return literal
 * — silently.
 */
const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  "exit",
  "byTag",
  "tagsOf",
  "calendar",
  "settings",
]);

function createAssembly(): CollectionTable {
  const slots: CollectionSlot[] = [];
  /** Member names already claimed by an ingested row (what + expose). */
  const takenNames = new Set<string>();

  const slotOf = (decl: CollectionDecl): CollectionSlot => {
    const slot = slots.find((candidate) => candidate.decl === decl);
    if (slot === undefined) {
      throw new Error(`content registry: collection "${decl.what}" was not ingested`);
    }
    return slot;
  };

  return {
    ingest(decl, entries, idOwners) {
      // Declaration hygiene: `what` and `expose` BECOME member names on the
      // read surface (obligation 6), so an empty name, a hand-written
      // member's name, or another row's name fails HERE instead of silently
      // overwriting a member — or, on a plain object, vanishing into
      // `Object.prototype`. `what` only names a member for exposed rows;
      // the exits row's `exit` is the hand-written lookup itself.
      for (const [field, name] of [
        ["what", decl.what],
        ["expose", decl.expose],
      ] as const) {
        if (name === null) {
          continue;
        }
        if (name === "") {
          throw new Error(`content registry: collection "${decl.what}" declares an empty ${field}`);
        }
        if (decl.expose !== null && RESERVED_MEMBERS.has(name)) {
          throw new Error(
            `content registry: collection "${decl.what}" ${field} "${name}" collides with a hand-written member`,
          );
        }
        if (takenNames.has(name)) {
          throw new Error(
            `content registry: collection "${decl.what}" ${field} "${name}" collides with another collection's member`,
          );
        }
        takenNames.add(name);
      }
      const slot: CollectionSlot = { decl, byId: new Map() };
      slots.push(slot);
      for (const entry of entries) {
        addUnique(slot.byId, entry, decl.what, idOwners);
      }
    },

    claim(decl, entry, idOwners) {
      addUnique(slotOf(decl).byId, entry, decl.what, idOwners);
    },

    flattenAll() {
      for (const slot of slots) {
        if (!slot.decl.flatten) {
          continue;
        }
        slot.byId = byId(flattenCollection([...slot.byId.values()], slot.decl.what));
      }
    },

    idMap<T extends FlattenableEntry>(decl: CollectionDecl): ReadonlyMap<string, T> {
      return slotOf(decl).byId as unknown as ReadonlyMap<string, T>;
    },

    placeableIds() {
      const ids = new Set<string>();
      for (const slot of slots) {
        if (!slot.decl.placeable) {
          continue;
        }
        for (const id of slot.byId.keys()) {
          ids.add(id);
        }
      }
      return ids;
    },

    entities() {
      return slots.flatMap((slot) => [...slot.byId.values()]);
    },

    surface() {
      // Null prototype: a row legitimately named `__proto__` must become an
      // OWN member, not vanish into Object.prototype's setter.
      const members: Record<string, unknown> = Object.create(null);
      for (const slot of slots) {
        const expose = slot.decl.expose;
        if (expose === null) {
          continue;
        }
        // The plural exposure is an ANSWER the registry hands out, so it is
        // frozen like the entries it holds: a caller pushing into
        // `registry.rooms` would fork the plural from `room(id)` silently.
        members[expose] = Object.freeze(sortedValues(slot.byId));
        members[slot.decl.what] = (id: string): FlattenableEntry => {
          const found = slot.byId.get(id);
          if (found === undefined) {
            throw unknownIdError(slot.decl.what, id);
          }
          return found;
        };
      }
      return members as unknown as ContentRegistry;
    },

    freezeAll() {
      // ONE memo across every entity: a sub-graph shared by two entities is
      // walked (and frozen) once.
      const seen = new Set<object>();
      for (const slot of slots) {
        for (const entry of slot.byId.values()) {
          deepFreeze(entry, seen);
        }
      }
    },
  };
}

const unknownIdError = (what: string, id: string): Error =>
  new Error(`content registry: unknown ${what} id "${id}"`);

/**
 * Builds a registry from loaded entries, driven by the declaration TABLE it
 * is handed (issue #39). Duplicate ids throw in every collection: two files
 * claiming one id disagree about what that thing IS, and every save and
 * cmdset referencing the id depends on it being one thing.
 *
 * World references are validated in the same spirit: an exit pointing at a
 * room that was never loaded, a room placing an entity no collection knows,
 * or an npc referencing an unknown monster are all broken world graphs, and
 * each throws here rather than surfacing mid-play.
 *
 * This is the internal seam — `createContentRegistry` is the typed facade
 * over it with the engine's five rows, and the new-collection drill
 * (tests/collection-decls.test.ts) drives it with a sixth synthetic row to
 * pin "a new collection edits nothing but its declaration". Hosts call
 * `createContentRegistry`. The C5 pin's "no runtime injection" keeps its
 * public half: the table is engine-side data, and this seam is not
 * re-exported from the package root (the `flattenCollection` precedent).
 */
export function buildContentRegistry(
  table: readonly CollectionDecl[],
  content: Readonly<Record<string, readonly FlattenableEntry[] | undefined>>,
  options: ContentRegistryOptions = {},
): ContentRegistry {
  // The config tables are validated FIRST: they are the pack's own
  // declarations and the checks are self-contained, so a bad calendar is
  // reported before any collection work runs. Both are optional — see
  // ContentRegistryOptions.
  assertSettingsTable(options.settings);
  assertCalendar(options.calendar);

  // The build derives the exits row itself (its source is the flattened
  // rooms), so the table it is handed must carry the engine's rows — a
  // caller may APPEND rows (the drill appends one), never drop one.
  for (const required of COLLECTIONS) {
    if (!table.includes(required)) {
      throw new Error(`content registry: table is missing collection "${required.what}"`);
    }
  }

  const assembly = createAssembly();

  // ONE id space for everything loaded here — every collection and the exits
  // (see addUnique). Filled before any collection is flattened so the first
  // taker of an id is whoever the host handed over first (table order).
  const idOwners = new Map<string, string>();

  // Obligation 1 — de-duplication — one step per declaration ROW and nothing
  // else: a new collection joins this loop by existing. A row with
  // `expose: null` has no host input (the exits row is derived from rooms,
  // below) and joins the table where it is derived. The input lookup is an
  // OWN-property read: a plain content object inherits `__proto__` and
  // friends from Object.prototype, and an inherited value must never be
  // read as a collection's entries.
  for (const decl of table) {
    if (decl.expose === null) {
      continue;
    }
    const entries = Object.hasOwn(content, decl.expose) ? content[decl.expose] : undefined;
    assembly.ingest(decl, entries ?? [], idOwners);
  }

  // Obligation 2 — flattening: after de-duplication (ids are the keys it
  // resolves parents against, and it changes none of them — the one id space
  // above stays valid), before every check below (spec/03 §6.1). Per
  // collection: parents resolve in the child's own collection and nowhere
  // else (ADR-0030 §3). Exits are NOT flattened — they live inside rooms,
  // arrive through the already-flattened room, and a room's `exits` is
  // replaced wholesale.
  assembly.flattenAll();

  // The typed shapes of the world graph. A declaration row carries
  // OBLIGATIONS, not types (see CollectionDecl), so the checks below name
  // theirs here — once each, for the collections that HAVE a typed check.
  const roomsById = assembly.idMap<RoomEntry>(ROOMS);

  // Exits are entities with GLOBAL ids (dispatch keys) living inside room
  // files: DERIVED here, across all rooms — an inherited exit list is only
  // visible after flattening replaced the room's `exits`. Their row's
  // id-space obligation is claimed per exit INSIDE the edge loop below (see
  // CollectionTable.claim: the claim/check interleaving is pinned), and their
  // entity feed follows below like every other row's.
  assembly.ingest(EXITS, [], idOwners);
  const exitsById = assembly.idMap<ExitEntry>(EXITS);

  // The edge's referential integrity (bespoke — the table drives assembly
  // obligations, not per-collection validation): two exits of one room
  // claiming the same direction disagree about where it leads (the direction
  // is the edge's key, spec/03 §2), and a target that no room answers is a
  // dangling edge.
  for (const room of roomsById.values()) {
    const directions = new Set<string>();
    for (const exit of room.exits ?? []) {
      assembly.claim(EXITS, exit, idOwners);
      if (typeof exit.direction !== "string" || exit.direction === "") {
        throw new Error(
          `content registry: exit "${exit.id}" of room "${room.id}" has an empty direction`,
        );
      }
      if (directions.has(exit.direction)) {
        throw new Error(
          `content registry: room "${room.id}" declares direction "${exit.direction}" twice`,
        );
      }
      directions.add(exit.direction);
      if (typeof exit.targetRoomId !== "string" || exit.targetRoomId === "") {
        throw new Error(
          `content registry: exit "${exit.id}" of room "${room.id}" has an empty targetRoomId`,
        );
      }
      if (!roomsById.has(exit.targetRoomId)) {
        throw new Error(
          `content registry: exit "${exit.id}" of room "${room.id}" targets unknown room "${exit.targetRoomId}"`,
        );
      }
    }
  }

  // Placement lists reference world entities across collections: an id
  // placed in a room must be known to a PLACEABLE collection (obligation 3 —
  // the union is generated from the table, so a new placeable collection is
  // placeable by declaring it); future placeable collections (items, ...)
  // join the check as they land.
  const placeableIds = assembly.placeableIds();
  for (const room of roomsById.values()) {
    const placedIds = new Set<string>();
    for (const placement of room.objects ?? []) {
      if (typeof placement.id !== "string" || placement.id === "") {
        throw new Error(`content registry: room "${room.id}" places an entry with an empty id`);
      }
      if (!placeableIds.has(placement.id)) {
        throw new Error(
          `content registry: room "${room.id}" places unknown entity "${placement.id}"`,
        );
      }
      // One entry per id (the list IS a map, spec/03 §2): two rows for the
      // same entity silently disagree about the count.
      if (placedIds.has(placement.id)) {
        throw new Error(
          `content registry: room "${room.id}" places entity "${placement.id}" twice`,
        );
      }
      placedIds.add(placement.id);
    }
  }

  // An npc's combat numbers live in the monster collection and are
  // REFERENCED, never copied (spec/03 §4): the reference must resolve.
  const npcsById = assembly.idMap<NpcEntry>(NPCS);
  const monstersById = assembly.idMap<MonsterRecord>(MONSTERS);
  for (const npc of npcsById.values()) {
    if (npc.monsterId !== undefined && !monstersById.has(npc.monsterId)) {
      throw new Error(
        `content registry: npc "${npc.id}" references unknown monster "${npc.monsterId}"`,
      );
    }
  }

  // Tag indexing and the vocabulary closures come LAST: they must see the
  // finished, validated entity set, exits included, and they must come AFTER
  // prototype flattening — a tag (or a gate) can be INHERITED, and an
  // inherited one has to be as valid and as queryable as a declared one, or
  // "put it in a prototype" would be a back door around every check here.
  // ONE entity set feeds both closures (obligation 4 — generated from the
  // table): entries and exits alike (exits are entities, see addUnique).
  const entities = assembly.entities();
  const { byPair, byEntity } = buildTagIndex(entities, options.dimensions);
  // The condition half closes after the tags half, so a stray tag is reported
  // before a stray gate (the tags message is the more common authoring slip).
  closeGateTags(entities, options.dimensions);

  // D3 — the closing deep freeze (issue #39): the last thing the build does,
  // so nothing above ever meets a frozen entry it might have rewritten and
  // every reference the read surface hands out is unforgeable from here on.
  assembly.freezeAll();

  // Obligations 5+6 — the read surface — generated from the table (plural +
  // singular lookup per exposed row); the five non-collection members stay
  // hand-written and type-checked against ContentRegistry right here.
  return {
    ...assembly.surface(),
    exit(id: string): ExitEntry {
      const found = exitsById.get(id);
      if (found === undefined) {
        throw unknownIdError("exit", id);
      }
      return found;
    },
    byTag(dimension: string, key: string): readonly string[] {
      return byPair.get(dimension)?.get(key) ?? EMPTY_IDS;
    },
    tagsOf(id: string): TagMap {
      return byEntity.get(id) ?? NO_TAGS;
    },
    calendar: options.calendar,
    settings: options.settings,
  };
}

/**
 * Builds a registry from loaded entries: the typed facade over
 * `buildContentRegistry` (issue #39). The collection declaration table is
 * fixed engine-side — this is the whole "adding a collection" surface for a
 * host: hand over the entries you loaded. See the module header for the load
 * contract and ContentRegistry for the read face.
 */
export function createContentRegistry(
  content: {
    commands?: readonly CommandEntry[];
    rooms?: readonly RoomEntry[];
    npcs?: readonly NpcEntry[];
    monsters?: readonly MonsterRecord[];
  },
  options: ContentRegistryOptions = {},
): ContentRegistry {
  return buildContentRegistry(COLLECTIONS, content, options);
}
