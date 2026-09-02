import type { Snapshot } from "../types.js";
import type { TagMap } from "../content/entry.js";
import { SAVE_VERSION, migrateSnapshot } from "../save/migrations.js";
import { DERIVED_ENTITY_KEYS, recomputeEntityDerived, stripDerived } from "./derived.js";
import type { DerivedEntityKey, RecomputeDerived } from "./derived.js";
import type { EntityState, WorldState } from "./tree.js";

/**
 * Snapshot v1 — the shape of a save at SAVE_VERSION (spec/04 §1, ADR-0028 §1).
 *
 * The payload IS the state tree, not a parallel structure: one tree, every
 * kind of state in it (spec/01 §7). Serialization adds three things over the
 * tree itself, and nothing else:
 *
 *   1. the VERSION stamp — migrateSnapshot's input, and the reason an old
 *      save can be read at all;
 *   2. the DERIVED split (state/derived.ts) — derived fields excluded here,
 *      recomputed by restore;
 *   3. CANONICAL ORDER — entities id-ascending, flags sorted, tags sorted —
 *      so two worlds that are equal save byte-identical, whatever order they
 *      were built in (ADR-0024 §2). Byte-stable saves are what make a
 *      deterministic engine's history diffable and comparable. The writer is
 *      never asked to keep anything sorted: canonicalization is
 *      serializeWorld's job (ADR-0022: a field that was never written is not
 *      persisted — a missing `tags` means "no tags", not a corrupt save).
 *
 * NPCs are absent BY CONSTRUCTION, not by filtering: they are static
 * presence (ADR-0028 §1), read straight from a room's placement list, and a
 * field that was never written is never persisted. There is no NPC row here
 * to remove, and there must never be one.
 *
 * NOT in v1: the engine tick and the RNG seed. Their consumers are M4
 * (spec/04 §2–§4), the tree grows those slots when they land, and that day
 * is a v2 with a migration — not a silent addition to v1's shape.
 *
 * The migration chain is READY and EMPTY (SAVE_VERSION stays 1): a fake
 * migration today would prove nothing, the first real one arrives with v2.
 */

/**
 * One entity's persisted state: the live shape minus its derived fields.
 *
 * `tags` is OPTIONAL here and required in the live tree: it joined the tree
 * after v1's first save was written, so a save that predates it simply omits
 * it (ADR-0022 — a field that was never written is not persisted) and
 * restore fills an empty map in. Every slot added AFTER the version it lands
 * in is `?` here for exactly that reason; `flags` is not, because every v1
 * save ever written carries it and relaxing that check would drop a
 * corruption detector for nothing (spec/04 §1.4).
 */
export type EntityRecordV1 = Omit<EntityState, DerivedEntityKey | "tags"> & {
  tags?: TagMap;
};

/** The whole v1 payload — the tree, canonical. */
export interface SaveDataV1 {
  entities: Record<string, EntityRecordV1>;
}

export interface RestoreOptions {
  /**
   * Fills every restored entity state's derived fields back in; defaults to
   * the engine's own (recomputeEntityDerived, a no-op until a system
   * registers a derived field). Injection is how the recompute seam is
   * exercised before its first consumer lands — see RecomputeDerived.
   */
  recomputeDerived?: RecomputeDerived<EntityState>;
}

/**
 * A tag set in canonical form: dimensions ascending, keys sorted and
 * de-duplicated. Written by serializeWorld, never required of the writer —
 * the live map may be in any order (a system pushed a key onto a list), and
 * "same world, same bytes" is a promise the SERIALIZER keeps, not one it
 * delegates to every writer (the `flags` precedent).
 */
function canonicalTags(tags: TagMap | undefined): TagMap {
  const canonical: Record<string, string[]> = {};
  for (const dimension of Object.keys(tags ?? {}).sort()) {
    canonical[dimension] = [...new Set(tags?.[dimension] ?? [])].sort();
  }
  return canonical;
}

/**
 * serializeWorld — the tree into a versioned snapshot. Reads nothing but the
 * tree (no registry, no instances): a save carries state, and content is
 * reloaded from content.
 */
export function serializeWorld(world: WorldState): Snapshot<SaveDataV1> {
  const entities: Record<string, EntityRecordV1> = {};
  for (const id of Object.keys(world.entities).sort()) {
    // Object.keys just read this map: the lookup cannot miss.
    const state = world.entities[id]!;
    // Canonicalize FIRST, strip LAST: the live arrays' order is untouched,
    // and a field cannot be resurrected by a later step — the strip is the
    // last thing that happens to a record, so the table stays authoritative
    // whichever field it names.
    entities[id] = stripDerived(
      { ...state, flags: [...state.flags].sort(), tags: canonicalTags(state.tags) },
      DERIVED_ENTITY_KEYS,
    );
  }
  return { version: SAVE_VERSION, data: { entities } };
}

/**
 * restoreWorld — a snapshot back into a live tree. Two steps, in this order:
 * MIGRATE first (only migration can make an old save current), VALIDATE
 * second (the shape a validator reads is the CURRENT one).
 *
 * This is NOT creation. No creation layer runs here (spec/03 §7.8 is
 * createObject's business): restore replays a tree and the host re-attaches
 * hook instances to it through WorldRuntime.attachEntity. Running
 * at_object_creation on load would overwrite saved state with code defaults
 * — the exact inversion of "content wins" that the two-layer seam exists to
 * prevent.
 *
 * A save that fails validation throws: half-interpreted state is worse than
 * no state (ADR-0003).
 */
export function restoreWorld(snapshot: Snapshot, options: RestoreOptions = {}): WorldState {
  const data = readSaveData(migrateSnapshot<SaveDataV1>(snapshot));
  const recomputeDerived = options.recomputeDerived ?? recomputeEntityDerived;
  const entities: Record<string, EntityState> = {};
  for (const id of Object.keys(data.entities).sort()) {
    // The record is the persisted half, taken as-is — the save is its truth,
    // and re-deriving it would be a second opinion nobody asked for. `id`
    // comes from the map key (the record's own copy was validated to agree
    // with it). `tags` is the ONE field named here, and only because it was
    // added after v1's first save: an older save omits it, and "omitted"
    // means "no tags" (ADR-0022), not "recompute will fill it in". Every
    // slot that lands after the version it joins costs exactly this one line
    // — growing the tree is not free, but it costs no revalidation.
    const record = data.entities[id]!;
    const state: EntityState = { ...record, id, tags: record.tags ?? {} };
    recomputeDerived(state);
    entities[id] = state;
  }
  return { entities };
}

/**
 * An object, or a loud failure. A save crossed a process boundary: every
 * field in it is a CLAIM about the world, not a fact, and a claim that does
 * not fit the current shape is answered here — at load — rather than three
 * hours later as a player standing in a room that does not exist.
 */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`snapshot: ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** A non-empty string, or a loud failure (an empty id locates nothing). */
function asId(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`snapshot: ${what} is not a non-empty string`);
  }
  return value;
}

function readSaveData(data: unknown): SaveDataV1 {
  const root = asRecord(data, "data");
  const entities = asRecord(root.entities, "data.entities");
  for (const [id, record] of Object.entries(entities)) {
    asId(id, "an entity key in data.entities");
    const entry = asRecord(record, `entity "${id}"`);
    asId(entry.locationId, `entity "${id}".locationId`);
    // The map key and the record's own id state one fact twice; a
    // disagreement (a hand-edited save, a migration that lost track) has no
    // answer the engine could guess, so it fails instead of picking one.
    if (entry.id !== undefined && entry.id !== id) {
      throw new Error(`snapshot: entity "${id}" carries a mismatched id "${String(entry.id)}"`);
    }
    // `flags` is REQUIRED: every v1 save ever written carries it (spec/04
    // §1.4). `tags` is OPTIONAL for the opposite reason — no save written
    // before M3-T5 has it, so demanding it would reject every old save for
    // nothing. Present but malformed is still rejected: a save is a claim
    // about the world, and a half-typed one is worse than none.
    const flags = entry.flags;
    if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string")) {
      throw new Error(`snapshot: entity "${id}".flags is not a list of strings`);
    }
    if (entry.tags !== undefined) {
      const tags = asRecord(entry.tags, `entity "${id}".tags`);
      for (const [dimension, keys] of Object.entries(tags)) {
        if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
          throw new Error(`snapshot: entity "${id}".tags["${dimension}"] is not a list of strings`);
        }
      }
    }
  }
  return data as SaveDataV1;
}
