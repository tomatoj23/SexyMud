import type { Snapshot } from "../types.js";
import type { TagMap } from "../content/entry.js";
import { assertTick } from "../clock.js";
import { SAVE_VERSION, migrateSnapshot } from "../save/migrations.js";
import { DERIVED_ENTITY_KEYS, recomputeEntityDerived, stripDerived } from "./derived.js";
import type { DerivedEntityKey, RecomputeDerived } from "./derived.js";
import {
  asId,
  asRecord,
  fillAbsentSlots,
  SLOT_RULES,
  validateSlots,
} from "./slot-rules.js";
import type { EntityState, WorldState } from "./tree.js";
import type { DueItem } from "../time/due.js";

/**
 * Snapshot v2 — the shape of a save at SAVE_VERSION (spec/04 §1, ADR-0028 §1,
 * ADR-0033).
 *
 * The payload IS the state tree, not a parallel structure: one tree, every
 * kind of state in it (spec/01 §7). Serialization adds four things over the
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
 *      persisted — a missing `tags` means "no tags", not a corrupt save);
 *   4. the WORLD SCALARS (§1.5, ADR-0033 §2) — the engine's "now" and the
 *      random stream's state, plus the due bucket's pending items.
 *
 * NPCs are absent BY CONSTRUCTION, not by filtering: they are static
 * presence (ADR-0028 §1), read straight from a room's placement list, and a
 * field that was never written is never persisted. There is no NPC row here
 * to remove, and there must never be one.
 *
 * **Why the scalars travel beside the tree rather than inside it** (§1.5
 * option (b), O9): the high-water mark lives on the side that DRIVES the
 * world (`WorldRuntime` / the host `Authority`), not in `WorldState`, and the
 * RNG and the due bucket ride with it. Folding them into `WorldState` would
 * turn "the entity tree" into "the entity tree plus some world scalars" and
 * make every tree-typed parameter carry a clock it does not own.
 */

/**
 * One entity's persisted state: the live shape minus its derived fields.
 *
 * ⚠️ Deliberately NOT version-numbered: v1 and v2 write the same per-entity
 * record, because v2 only added TOP-LEVEL slots. What differs between the
 * versions is whether a record is *expected* to carry the newer fields, not
 * the shape of the record.
 *
 * `tags` is OPTIONAL here and required in the live tree: it joined the tree
 * after v1's first save was written, so a save that predates it simply omits
 * it (ADR-0022 — a field that was never written is not persisted) and
 * restore fills an empty map in. Every slot added AFTER the version it lands
 * in is `?` here for exactly that reason; `flags` is not, because every v1
 * save ever written carries it and relaxing that check would drop a
 * corruption detector for nothing (spec/04 §1.4). `lastSeenTick` is the
 * second slot of that kind (M4-T3, #22: the two-layer advance grew it; #24
 * gives it a migration default, so a post-v2 save should carry it — but
 * "absent" is still read as tick 0, never as corruption). `cooldowns` is the
 * third (#23): "absent" means empty, never "the cooldowns were lost".
 *
 * `name` (#52) is the one record slot that is optional BOTH sides and never
 * filled: absent on the wire means NAMELESS (not "the default name") — the
 * default is the host's theme word (Q5) and the engine owns none — so
 * serializeWorld writes it only when set, and restore leaves its absence
 * alone (the "unfilled" row, state/slot-rules.ts).
 *
 * Each optional slot's tolerance is one row in `state/slot-rules.ts`, and
 * the reader half of that row says one thing: a late optional slot is
 * tolerated when ABSENT and refused when MALFORMED. `id` is the one field
 * here with no row — its copy must agree with the map key, a cross-field
 * check rather than a tolerance (spec/04 §1.4).
 */
export type EntityRecord = Omit<
  EntityState,
  DerivedEntityKey | "tags" | "lastSeenTick" | "cooldowns"
> & {
  tags?: TagMap;
  lastSeenTick?: number;
  cooldowns?: Record<string, number>;
};

/** The whole v1 payload — the tree, canonical, and nothing else. */
export interface SaveDataV1 {
  entities: Record<string, EntityRecord>;
}

/**
 * The whole v2 payload — the tree plus the three world scalars (ADR-0033 §2)
 * and the due bucket's pending items (spec/04 §4.5, handed over from #23).
 *
 * All four are REQUIRED in the type and all four are read as "absent means
 * empty" (ADR-0033 §4: no special-casing for v2's new slots). That asymmetry
 * is deliberate: the type describes what the engine WRITES, the reader
 * describes what it TOLERATES — and a late optional slot's reader tolerates
 * ABSENCE only, never malformation (#40: a `nowTick`/`rngState`/`due` that
 * is present but the wrong kind of thing fails at load).
 */
export interface SaveDataV2 extends SaveDataV1 {
  /** The engine's high-water mark — without it, time runs backwards (§1.5). */
  nowTick: number;
  /** `Rng.getState()`: mulberry32's whole state is one uint32. */
  rngState: number;
  /** Pending due items, ascending by `dueTick` (canonical order). */
  due: DueItem[];
}

/**
 * What the world carries BESIDE the tree — the answer to O9 (spec/04 §1.5).
 *
 * These live on the side that drives the world, not in `WorldState`, so they
 * are handed to `serializeWorld` and handed back by `restoreWorld` as a
 * separate value. A host that saves collects them off its live bundle, and a
 * host that loads gets them back in the bundle the one load entry returns
 * (state/assembly.ts, #37):
 *
 *   serializeWorld(runtime.state, collectMeta({ runtime, rng, bucket }))
 *
 *   const world = assembleWorld({ snapshot, registry, bucket, entities });
 *   // world = { runtime, rng, bucket, meta } — the four pieces, live again
 *
 * (The five steps behind that entry stay hand-callable — see state/assembly.ts
 * for the checklist; the entry exists so no host has to remember it.)
 */
export interface WorldMeta {
  /** The engine's high-water mark (spec/04 §2.2). */
  nowTick: number;
  /** The random stream's exported state (ADR-0033 §1). */
  rngState: number;
  /** The due bucket's pending items (spec/04 §4.5). */
  due: DueItem[];
}

/** What `restoreWorld` hands back: the tree AND the scalars that rode with it. */
export interface RestoredWorld {
  state: WorldState;
  meta: WorldMeta;
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
 * A cooldown table in canonical form: keys ascending. Same promise as
 * canonicalTags — two equal worlds save byte-identical, whatever order a
 * system armed the keys in (the `flags` precedent).
 */
function canonicalCooldowns(cooldowns: Record<string, number> | undefined): Record<string, number> {
  const canonical: Record<string, number> = {};
  for (const key of Object.keys(cooldowns ?? {}).sort()) {
    canonical[key] = cooldowns?.[key] ?? 0;
  }
  return canonical;
}

/**
 * Due items in canonical form: ascending by `dueTick`, stable within one tick
 * (the `flags` precedent again — the promise is the serializer's, never the
 * writer's). `DueBucket.snapshot()` already returns them in this order; the
 * sort here is what makes the promise hold for ANY host-supplied list.
 */
function canonicalDue(due: readonly DueItem[] | undefined): DueItem[] {
  return [...(due ?? [])].sort((left, right) => left.dueTick - right.dueTick);
}

/**
 * serializeWorld — the tree (plus the world scalars) into a versioned
 * snapshot. Reads nothing but the tree and the `meta` it is handed: a save
 * carries state, and content is reloaded from content.
 *
 * `meta` is REQUIRED, not optional: a v2 save without a `nowTick` would
 * restart the world's clock, and a save without `rngState` would restart its
 * random stream — both silently, both unrecoverable (ADR-0033 §2). A caller
 * that has no clock to report has not loaded a world.
 */
export function serializeWorld(world: WorldState, meta: WorldMeta): Snapshot<SaveDataV2> {
  assertTick(meta.nowTick, "meta.nowTick");
  const entities: Record<string, EntityRecord> = {};
  for (const id of Object.keys(world.entities).sort()) {
    // Object.keys just read this map: the lookup cannot miss.
    const state = world.entities[id]!;
    // `name` rides only when it is a NON-EMPTY STRING (#52): a nameless
    // entity's record is byte-identical to what it was before the slot
    // existed ("a field that was never written is not persisted") — and the
    // writer makes no nameless claim of any kind: the empty string is never
    // written (the host defaults before it writes), nor is a non-string (a
    // JS host's garbage) — writing either would be the engine handing its
    // own load path a key it rejects outright (owner ruling 2026-10-25, #52
    // audit N-1: write-side elision, read-side refusal).
    const { name, ...persistent } = state;
    // Canonicalize FIRST, strip LAST: the live arrays' order is untouched,
    // and a field cannot be resurrected by a later step — the strip is the
    // last thing that happens to a record, so the table stays authoritative
    // whichever field it names.
    entities[id] = stripDerived(
      {
        ...persistent,
        ...(typeof name === "string" && name !== "" ? { name } : {}),
        flags: [...state.flags].sort(),
        tags: canonicalTags(state.tags),
        cooldowns: canonicalCooldowns(state.cooldowns),
      },
      DERIVED_ENTITY_KEYS,
    );
  }
  return {
    version: SAVE_VERSION,
    data: {
      entities,
      nowTick: meta.nowTick,
      rngState: meta.rngState,
      due: canonicalDue(meta.due).map((item) => ({ dueTick: item.dueTick, payload: item.payload })),
    },
  };
}

/**
 * restoreWorld — a snapshot back into a live tree. Two steps, in this order:
 * MIGRATE first (only migration can make an old save current), VALIDATE
 * second (the shape a validator reads is the CURRENT one).
 *
 * This is NOT creation. No creation layer runs here (spec/03 §7.8 is
 * createObject's business): restore replays a tree, and hook instances are
 * re-attached to it afterwards — `assembleWorld` (state/assembly.ts) runs
 * that loop over the host's rebuilt instances (the "host re-attaches" step is
 * the entry's job now), or a host runs WorldRuntime.attachEntity itself. Running
 * at_object_creation on load would overwrite saved state with code defaults
 * — the exact inversion of "content wins" that the two-layer seam exists to
 * prevent.
 *
 * A save that fails validation throws: half-interpreted state is worse than
 * no state (ADR-0003).
 *
 * Returns the tree AND the world scalars (O9, §1.5): a restored world is not
 * playable with the tree alone — without `nowTick` every cooldown reads as
 * "not yet", and without `rngState` the stream starts over.
 *
 * ⚠️ The scalars are read "absent means empty" like every other late slot
 * (ADR-0033 §4): a v2 save whose `nowTick` is MISSING still reads as tick 0,
 * so `nowTick >= dueTick` is false for every pending cooldown and they are
 * not "broken", they simply never come due. What does NOT pass any more is a
 * `nowTick` that is present but corrupt — the reader tolerates absence only,
 * never malformation (#40, D2 — ADR-0033 §4's "cheaper without a detector"
 * tradeoff is overturned; the string that used to flow silently into `meta`
 * now fails at load).
 */
export function restoreWorld(snapshot: Snapshot, options: RestoreOptions = {}): RestoredWorld {
  const data = readSaveData(migrateSnapshot<SaveDataV2>(snapshot));
  const recomputeDerived = options.recomputeDerived ?? recomputeEntityDerived;
  const entities: Record<string, EntityState> = {};
  for (const id of Object.keys(data.entities).sort()) {
    // The record is the persisted half, taken as-is — the save is its truth,
    // and re-deriving it would be a second opinion nobody asked for. `id`
    // comes from the map key (the record's own copy was validated to agree
    // with it). Every other tolerated absence — the slots that landed after
    // v1's first save, where "omitted" means "empty" (ADR-0022), not
    // "recompute will fill it in" — fills from its row's one declared
    // default in the slot table, so growing the tree costs one row there and
    // no revalidation here.
    const record = data.entities[id]!;
    const state = Object.assign(
      { ...record, id } as EntityState,
      fillAbsentSlots(record, SLOT_RULES.entity),
    );
    recomputeDerived(state);
    entities[id] = state;
  }
  return {
    state: { entities },
    meta: fillAbsentSlots(data, SLOT_RULES.world) as WorldMeta,
  };
}

/**
 * readSaveData — the payload's shape answered at load. Every absence policy
 * and kind check is a row in `state/slot-rules.ts`; what stays hand-written
 * here is the STRUCTURE around the rows: the root, the entity map, the map
 * key, and the key/record identity agreement (a cross-field check no slot
 * row can express).
 */
function readSaveData(data: unknown): SaveDataV2 {
  const root = asRecord(data, "data");
  const entities = asRecord(root.entities, "data.entities");
  // The rows carry their own kind checks (the `tags` precedent generalized):
  // present but the wrong KIND is answered here — "missing" reads as the
  // row's default and is never answered at all.
  validateSlots(root, SLOT_RULES.world, (slot) => `data.${slot}`);
  for (const [id, record] of Object.entries(entities)) {
    asId(id, "an entity key in data.entities");
    const entry = asRecord(record, `entity "${id}"`);
    // The map key and the record's own id state one fact twice; a
    // disagreement (a hand-edited save, a migration that lost track) has no
    // answer the engine could guess, so it fails instead of picking one.
    // Identity is answered BEFORE the slot rows: a record that is not who
    // it claims to be gets that named first, whatever else is wrong with it.
    if (entry.id !== undefined && entry.id !== id) {
      throw new Error(`snapshot: entity "${id}" carries a mismatched id "${String(entry.id)}"`);
    }
    validateSlots(entry, SLOT_RULES.entity, (slot) => `entity "${id}".${slot}`);
  }
  return data as SaveDataV2;
}
