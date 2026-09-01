/**
 * The state tree seed (spec/04 §1, ADR-0028): ONE tree holding the mutable
 * state of every DYNAMIC OCCUPANT — M2 that is the players. NPCs are static
 * presence and never enter the tree: content is their truth, and a field
 * that was never written is never persisted.
 *
 * This is typed data, not an attribute handler (spec/04 §1.1): the shape is
 * the future snapshot's shape (serialization lands with M2-T5). Facet slots
 * (attrs, tags, states, skills) grow into the tree as their consumers land;
 * flags are here from day one because gates — the engine's traversal
 * adapter checks them — are consumers already.
 */

/**
 * One dynamic occupant's state. `flags` are named boolean markers answering
 * the hasFlag condition facet: WHICH flags exist is content vocabulary, the
 * engine only stores and answers them.
 */
export interface EntityState {
  readonly id: string;
  /**
   * Where the entity is: a room id, or the id of another entity acting as a
   * container (get/give/drop move types). Moves change it only through
   * moveTo (the movement orchestration's write point); hosts and tests may
   * assign it directly when CONSTRUCTING state (initial placement, loaded
   * saves) — construction is data, movement is orchestration.
   */
  locationId: string;
  /** Named markers, order irrelevant to every consumer. */
  flags: string[];
}

/**
 * The one tree. Entities are keyed by id, kind-agnostic: players today,
 * materialized items and stateful NPCs join the same map when their tickets
 * land (ADR-0028 consequences).
 */
export interface WorldState {
  entities: Record<string, EntityState>;
}
