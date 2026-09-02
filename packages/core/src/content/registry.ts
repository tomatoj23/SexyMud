import type { CommandEntry } from "../command/entry.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../world/entry.js";
import type { EntryCommon } from "./entry.js";

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
}

/** Adds `id` to `byId`, throwing on duplicates or an empty id. */
function addUnique<T extends { id: string }>(
  byId: Map<string, T>,
  entry: T,
  what: string,
): void {
  if (typeof entry.id !== "string" || entry.id === "") {
    throw new Error(`content registry: ${what} entry with an empty id`);
  }
  if (byId.has(entry.id)) {
    throw new Error(`content registry: duplicate ${what} id "${entry.id}"`);
  }
  byId.set(entry.id, entry);
}

/** The ids of a collection, id-ascending (the canonical exposure order). */
function sortedValues<T extends { id: string }>(byId: Map<string, T>): readonly T[] {
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
export function createContentRegistry(content: {
  commands?: readonly CommandEntry[];
  rooms?: readonly RoomEntry[];
  npcs?: readonly NpcEntry[];
  monsters?: readonly MonsterRecord[];
}): ContentRegistry {
  const commandsById = new Map<string, CommandEntry>();
  for (const entry of content.commands ?? []) {
    addUnique(commandsById, entry, "command");
  }

  const roomsById = new Map<string, RoomEntry>();
  for (const room of content.rooms ?? []) {
    addUnique(roomsById, room, "room");
  }

  const npcsById = new Map<string, NpcEntry>();
  for (const npc of content.npcs ?? []) {
    addUnique(npcsById, npc, "npc");
  }

  const monstersById = new Map<string, MonsterRecord>();
  for (const monster of content.monsters ?? []) {
    addUnique(monstersById, monster, "monster");
  }

  // Exits are entities with GLOBAL ids (dispatch keys) living inside room
  // files: index them across all rooms, rejecting duplicates — two exits
  // claiming one id would both answer the verb table's dispatch, and only
  // loud failure keeps that from being resolved by load order.
  const exitsById = new Map<string, ExitEntry>();
  for (const room of roomsById.values()) {
    const directions = new Set<string>();
    for (const exit of room.exits ?? []) {
      addUnique(exitsById, exit, "exit");
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
  };
}
