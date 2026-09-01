import type { EntityState } from "./tree.js";

/**
 * The derived-field contract (spec/04 §1.3, spec/01 §7): the engine's ONE
 * rule separating "persisted" from "derived / recomputable".
 *
 * A field listed here is
 *   - EXCLUDED from every snapshot — serialization reads this table, never a
 *     hand-written field list, so registering a derived field is ONE line
 *     here and nothing else, and
 *   - RECOMPUTED onto the state right after a load (restore runs the kind's
 *     RecomputeDerived once per restored entity).
 *
 * The KEY table is deliberately NOT runtime-injectable: it decides the
 * snapshot's COMPILE-TIME shape (EntityRecordV1 is an Omit over it), and a
 * type cannot follow a value passed in at runtime. Only the recompute half
 * is injectable (see RecomputeDerived).
 *
 * Everything else is persisted BY DEFAULT. The costs are asymmetric: a fact
 * nobody listed would be silently lost, while a derived field nobody marked
 * only makes saves larger. So the safe direction is opt-out.
 *
 * The alternative this replaces is Evennia's `ndb`: a second API that LOOKS
 * like the persisted one and is silently emptied on every restart — its own
 * docs warn that an object with non-empty nattributes cannot be flushed
 * ("those would get lost!"). Here the split is declared once, in one typed
 * table, and both halves are visible at compile time.
 *
 * EMPTY TODAY: M2's state tree (id, locationId, flags) holds nothing that
 * can be recomputed from anything else. The modifiers system is the first
 * real consumer (a derived stat is the sum of its modifiers) — it registers
 * here, and this table plus a `recompute` body is the ENTIRE change: the
 * snapshot type shrinks by itself (EntityRecordV1 is an Omit over this
 * table) and serialization drops the field without a second edit.
 */
export const DERIVED_ENTITY_KEYS = [] as const satisfies readonly (keyof EntityState)[];

/** The derived field names of entity state — `never` until one registers. */
export type DerivedEntityKey = (typeof DERIVED_ENTITY_KEYS)[number];

/**
 * Fills a state kind's derived fields back in, in place, onto a state that
 * was just rebuilt from a save. Runs once per restored entity.
 *
 * This half is INJECTABLE (unlike the key table): the engine cannot know how
 * to compute a field before the system that owns it lands, so a caller may
 * pass its own — the same reason the command harness takes a predicate
 * registry. Engine defaults, seam open.
 */
export type RecomputeDerived<S extends object> = (state: S) => void;

/**
 * Entity state's recompute: none yet. Every field of EntityState is a fact —
 * an id, a position, a list of markers — and recomputing a fact from nothing
 * is not a thing. The modifiers system writes the first real body, and it
 * needs no change anywhere else.
 */
export const recomputeEntityDerived: RecomputeDerived<EntityState> = () => {};

/**
 * A copy of `value` without its derived fields (spec/04 §1.3). The ONLY
 * place a field is dropped: a field can therefore never be half-excluded —
 * present in the snapshot's type but still in the bytes, or the reverse.
 *
 * Shallow on purpose: the state kinds are flat data (ids, numbers, string
 * lists), and a deep clone would hide which parts the caller still shares.
 */
export function stripDerived<S extends object, K extends readonly (keyof S)[]>(
  value: S,
  keys: K,
): Omit<S, K[number]> {
  // Deleting a REQUIRED property is only expressible through an index
  // signature — which is the point of the cast: the excluded fields are
  // named in `keys`, and the return type restores the precise shape.
  const copy = { ...(value as unknown as Record<string, unknown>) };
  for (const key of keys) {
    delete copy[key as unknown as string];
  }
  return copy as Omit<S, K[number]>;
}
