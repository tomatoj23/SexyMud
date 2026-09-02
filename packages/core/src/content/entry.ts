/**
 * The fields every ENTRY collection carries (issue #14; ADR-0029 §1/§3,
 * ADR-0030 §3–§4).
 *
 * Four fields, one shape, declared once — on the schema side they live in
 * `schemas/common.schema.json` (a $ref'd library, exactly like
 * condition.schema.json) rather than being copied into each of the fourteen
 * collection schemas, so "the tag shape is unique" is a structural fact
 * instead of a convention. Here they live once and every entry type extends
 * them; `docs/agents/content.md` states the same contract for authors. That
 * is the three-way sync of spec/06 §4 — change the shape and all three move.
 *
 * The four are all OPTIONAL: today's content declares none of them, and the
 * engine must not require a collection to opt into tagging or inheritance.
 * They are ENTITY-level rather than collection-level: an entry carries them,
 * and so does an exit — an exit is a command (spec/02 §4), so it inherits the
 * whole command shape, this tail included. The one thing in a room that is
 * not an entity and carries none of them is a PLACEMENT ROW.
 *
 * What the engine does with them is the next tickets' work — the inverted
 * index (M3-T2) and load-time prototype flattening (M3-T3). This file only
 * settles the SHAPE those two will read, and it deliberately does not
 * validate: that a dimension is in the dimensions table, or that a
 * prototypeKey equals its entry's id, is the registry's job at load time —
 * a schema (and a type) can only own the shape.
 */

/**
 * A tag set: dimension → keys. The ONE tag shape (ADR-0029 §1) —
 * `{ moveTag: ["sword"], elementTag: ["fire"] }`. A dimension carries many
 * keys; a key is a bare string with no value (values are attributes, not
 * tags). Dimension names and key values are CLOSED by
 * content/config/dimensions.json, but that closure is enforced by the
 * registry when a pack hands it a dimensions table — not by this type, and
 * not by the schema (ADR-0004: no hardcoded enums).
 */
export interface TagMap {
  readonly [dimension: string]: readonly string[] | undefined;
}

/**
 * The tail every content entry type extends: what it IS tagged as, what
 * boolean marks it carries, and where it sits in the prototype graph.
 *
 * `tags` and `flags` are NOT two ways to say the same thing and neither
 * replaces the other (ADR-0029 §4): tags are dimensioned and answer "which
 * class does this fall in, can I query a whole batch of them", flags are
 * bare booleans answering "does it have this" (a lit lamp, a quest item).
 * Only `tags` is indexed — `byTag` will not find a flag.
 */
export interface EntryCommon {
  /**
   * Dimensioned labels, indexed for batch queries ("every room tagged
   * outdoors gets the weather tick"). Shape-only here; membership in the
   * dimensions table is checked at load (M3-T2).
   */
  readonly tags?: TagMap;
  /**
   * Bare boolean marks, unindexed: "is this a quest item", "is it lit".
   * The runtime side keeps the same shape on EntityState.
   */
  readonly flags?: readonly string[];
  /**
   * Declares this entry inheritable; the value IS this entry's own id
   * (ADR-0030 §4). That equality is unrepresentable in a type — it is
   * checked by the flattener at load (M3-T3), loudly. Not inherited: an
   * entry that never declared it has none after flattening, so it cannot be
   * inherited from — a constructive guarantee, not a convention.
   */
  readonly prototypeKey?: string;
  /**
   * The parents this entry inherits from, by id, within its own collection
   * (no cross-collection inheritance). Multiple parents, left → right in
   * increasing precedence. Consumed at load time and therefore ABSENT from
   * a flattened entry — nothing downstream can flatten twice.
   */
  readonly prototypeParent?: readonly string[];
}
