/**
 * The state tree seed (spec/04 §1, ADR-0028): ONE tree holding the mutable
 * state of every DYNAMIC OCCUPANT — M2 that is the players. NPCs are static
 * presence and never enter the tree: content is their truth, and a field
 * that was never written is never persisted.
 *
 * This is typed data, not an attribute handler (spec/04 §1.1): the shape is
 * the future snapshot's shape (serialization lands with M2-T5). Facet slots
 * (attrs, states, skills) grow into the tree as their consumers land; flags
 * are here from day one because gates — the engine's traversal adapter
 * checks them — are consumers already, and tags joined them with M3-T5
 * (hasTag, the engine's own condition facet, is their consumer).
 */

import type { TagMap } from "../content/entry.js";

/**
 * One dynamic occupant's state. `flags` are named boolean markers answering
 * the hasFlag condition facet: WHICH flags exist is content vocabulary, the
 * engine only stores and answers them. `tags` answer hasTag — the SAME
 * dimensioned model the content side carries (ADR-0029 §1: both sides live
 * here, and "both sides" is one model, not two same-named ones).
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
  /**
   * Dimensioned labels: which classes this occupant falls in, answered by the
   * hasTag facet as "own tags ∪ the tags of its content entry". The map is
   * written WHOLE (its index signature is readonly) and read by
   * `subjectOf` — as with flags, WHICH dimensions and keys exist is content
   * vocabulary.
   */
  tags: TagMap;
  /**
   * The tick this entity was last settled TO (spec/04 §4.3, ADR-0034 §2) —
   * the start of the entity layer's next advance, and the reason an offline
   * span is ever non-zero. The entity layer advances the ACTOR only, so an
   * offline player's number stays where it was and their catch-up is theirs
   * alone (advancing the whole room would let one player's activity eat
   * another's offline budget).
   *
   * Written by the ENGINE after settling the entity, never by the host: a
   * host clock writing "last seen" would smuggle its own notion of time into
   * the world — the very thing ADR-0031 turned `Clock` inside out to prevent.
   * Seeded by `addEntity` at the CURRENT tick, not 0: a new entity starts now
   * (spec/04 §1.5).
   */
  lastSeenTick: number;
}

/**
 * The one tree. Entities are keyed by id, kind-agnostic: players today,
 * materialized items and stateful NPCs join the same map when their tickets
 * land (ADR-0028 consequences).
 */
export interface WorldState {
  entities: Record<string, EntityState>;
}
