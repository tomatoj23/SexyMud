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
 * (hasTag, the engine's own condition facet, is their consumer). M4 then
 * grew the two time slots: `lastSeenTick` with the two-layer advance (#22)
 * and `cooldowns` (#23).
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
  /**
   * Cooldowns (spec/04 §4.6): `key → the tick it is available again`. Mine is
   * not yours, hence per entity; a number, so a long one survives a reload
   * ("this door relocks in three days" must still be pending after a save).
   *
   * A READ-ONLY table from the engine's side: judgement is `nowTick >=
   * dueTick` (time/cooldown.ts), a comparison — never a callback, never a
   * timer. An absent key means "never armed", which is ready: there is no
   * third state to confuse it with.
   *
   * Empty by default, seeded by `addEntity`; absent in an old save means
   * empty (§1.4), never "recompute will fill it in".
   */
  cooldowns: Record<string, number>;
}

/**
 * The one tree. Entities are keyed by id, kind-agnostic: players today,
 * materialized items and stateful NPCs join the same map when their tickets
 * land (ADR-0028 consequences).
 */
export interface WorldState {
  entities: Record<string, EntityState>;
}
