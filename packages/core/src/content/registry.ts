import type { CommandEntry } from "../command/entry.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../world/entry.js";
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
 * Collections are additive: commands arrived with M1-T5; rooms, npcs and
 * id-bearing monster records with M1-T6. Every collection is optional in the
 * input — a host loads what exists — but references are checked against what
 * WAS loaded, so omitting a collection while something references it fails
 * loudly (a dangling reference is a dangling reference).
 *
 * On top of the collections the registry builds the (dimension, key) inverted
 * index (`byTag`, ADR-0029 §2) and, when the host hands it a dimensions
 * table, closes the tag vocabulary against it (ADR-0029 §5) — see the
 * comments on buildTagIndex.
 *
 * The load order is a contract, not an arrangement (spec/03 §6.1):
 *
 *   id de-duplication (one space, entries and exits) → prototype flattening →
 *   referential integrity → build the byTag index
 *
 * Flattening comes BEFORE integrity so that an inherited exit, placement or
 * monsterId is checked like a declared one — otherwise "put it in a prototype"
 * would be a back door around every check below. The index comes LAST so that
 * an inherited tag is as queryable as a declared one.
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
   * `byTag` (ADR-0029 §4).
   */
  tagsOf(id: string): TagMap;
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
 * (`room(id)` included) `tagsOf` hands out an internal reference, and the
 * registry's whole contract is that loaded content is immutable — a host
 * mutating an entry it handed over desyncs everything downstream, not just
 * these two maps.
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
    // typed readonly and content is not supposed to be mutated at runtime.
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
      sortedByKey.set(key, [...ids].sort(compareIds));
    }
    index.set(dimension, sortedByKey);
  }
  return { byPair: index, byEntity };
}

/**
 * Builds a registry from loaded entries. Duplicate ids throw in every
 * collection: two files claiming one id disagree about what that thing IS,
 * and every save and cmdset referencing the id depends on it being one
 * thing.
 *
 * World references are validated in the same spirit: an exit pointing at a
 * room that was never loaded, a room placing an entity no collection knows,
 * or an npc referencing an unknown monster are all broken world graphs, and
 * each throws here rather than surfacing mid-play.
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
  // ONE id space for everything loaded here — the four collections and the
  // exits (see addUnique). Declared before any collection is filled so the
  // first taker of an id is whoever the host handed over first.
  const idOwners = new Map<string, string>();

  let commandsById = new Map<string, CommandEntry>();
  for (const entry of content.commands ?? []) {
    addUnique(commandsById, entry, "command", idOwners);
  }

  let roomsById = new Map<string, RoomEntry>();
  for (const room of content.rooms ?? []) {
    addUnique(roomsById, room, "room", idOwners);
  }

  let npcsById = new Map<string, NpcEntry>();
  for (const npc of content.npcs ?? []) {
    addUnique(npcsById, npc, "npc", idOwners);
  }

  let monstersById = new Map<string, MonsterRecord>();
  for (const monster of content.monsters ?? []) {
    addUnique(monstersById, monster, "monster", idOwners);
  }

  // Flattening: after de-duplication (ids are the keys it resolves parents
  // against, and it changes none of them — the one id space above stays
  // valid), before every check below (spec/03 §6.1). Per collection: parents
  // resolve in the child's own collection and nowhere else (ADR-0030 §3).
  // Exits are NOT flattened — they live inside rooms, arrive through the
  // already-flattened room, and a room's `exits` is replaced wholesale.
  commandsById = byId(flattenCollection([...commandsById.values()], "command"));
  roomsById = byId(flattenCollection([...roomsById.values()], "room"));
  npcsById = byId(flattenCollection([...npcsById.values()], "npc"));
  monstersById = byId(flattenCollection([...monstersById.values()], "monster"));

  // Exits are entities with GLOBAL ids (dispatch keys) living inside room
  // files: index them across all rooms, rejecting duplicates — two exits
  // claiming one id would both answer the verb table's dispatch, and only
  // loud failure keeps that from being resolved by load order.
  const exitsById = new Map<string, ExitEntry>();
  for (const room of roomsById.values()) {
    const directions = new Set<string>();
    for (const exit of room.exits ?? []) {
      addUnique(exitsById, exit, "exit", idOwners);
      // The direction is the edge's key (spec/03 §2): two exits of one room
      // claiming the same direction disagree about where it leads.
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
  // placed in a room must be known — as an npc or a monster here; future
  // placeable collections (items, ...) join this check as they land.
  const placeableIds = new Set<string>([...npcsById.keys(), ...monstersById.keys()]);
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
  for (const npc of npcsById.values()) {
    if (npc.monsterId !== undefined && !monstersById.has(npc.monsterId)) {
      throw new Error(
        `content registry: npc "${npc.id}" references unknown monster "${npc.monsterId}"`,
      );
    }
  }

  // Tag indexing comes LAST: it must see the finished, validated entity set,
  // exits included, and it must come AFTER prototype flattening — a tag can be
  // INHERITED, and an inherited tag has to be as queryable as a declared one,
  // or "put the tag in a prototype" would be a back door around the index.
  // Exits stay as loaded: flattening runs per collection (spec/03 §6).
  const { byPair, byEntity } = buildTagIndex(
    [
      ...commandsById.values(),
      ...roomsById.values(),
      ...npcsById.values(),
      ...monstersById.values(),
      ...exitsById.values(),
    ],
    options.dimensions,
  );

  const commands = sortedValues(commandsById);
  const rooms = sortedValues(roomsById);
  const npcs = sortedValues(npcsById);
  const monsters = sortedValues(monstersById);

  const unknown = (what: string, id: string): Error =>
    new Error(`content registry: unknown ${what} id "${id}"`);

  return {
    commands,
    command(id) {
      const found = commandsById.get(id);
      if (found === undefined) {
        throw unknown("command", id);
      }
      return found;
    },
    rooms,
    room(id) {
      const found = roomsById.get(id);
      if (found === undefined) {
        throw unknown("room", id);
      }
      return found;
    },
    exit(id) {
      const found = exitsById.get(id);
      if (found === undefined) {
        throw unknown("exit", id);
      }
      return found;
    },
    npcs,
    npc(id) {
      const found = npcsById.get(id);
      if (found === undefined) {
        throw unknown("npc", id);
      }
      return found;
    },
    monsters,
    monster(id) {
      const found = monstersById.get(id);
      if (found === undefined) {
        throw unknown("monster", id);
      }
      return found;
    },
    byTag(dimension, key) {
      return byPair.get(dimension)?.get(key) ?? [];
    },
    tagsOf(id) {
      return byEntity.get(id) ?? NO_TAGS;
    },
  };
}
