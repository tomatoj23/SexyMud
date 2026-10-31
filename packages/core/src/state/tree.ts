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
   * Numeric attributes (#56, D3): `attr key → value`, the engine's FIRST
   * designed shape for the slot spec/04 §4.3 refused to open early. WHICH
   * keys exist and what they mean is entirely the pack's character-model
   * declaration (content/config/character.json) — the engine stores, seeds
   * and answers them and knows no key (ADR-0009 §10: key lookup and set
   * intersection only). Seeded `{}` by `addEntity`; a NEW GAME seeds the
   * declared table over it (seedCharacterAttrs, combat/character use); an
   * old save's absence means empty (the `tags` precedent, in-version
   * landing — no v3).
   */
  attrs: Record<string, number>;
  /**
   * The combat SESSION (#56, D2/D11): not an HP store — a session bound to
   * one target NPC, persisted with the save (resume the fight, the NPC's
   * death survives the reload) because NPCs are static presence and never
   * enter the tree (ADR-0028), so the player's own state is the only shelf
   * their fight can live on. ABSENT means no fight (the `name` row's
   * "unfilled" policy: absence is a reading of its own — there is no empty
   * session to invent). C1 fills the minimal fields; C2 grows the RHYTHM
   * fields (interval, next-strike tick) on this SAME slot, no rename.
   */
  combat?: CombatSession;
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
  /**
   * The occupant's DISPLAY name (#52; #48 D4): a plain string the engine
   * stores, saves and replays — and never reads. It is a display field, not
   * an identity: the actor id stays what it is, and the engine renders
   * nothing from it (the render voice's `names` face is the host's merge).
   * Absent means NAMELESS, and the default name is the HOST's word (Q5: a
   * theme word like a default player name never crosses into the engine) —
   * which is why this is the one tree slot `addEntity` does not seed and
   * `restoreWorld` does not fill: nameless is a reading of its own, not a
   * stand-in for some engine constant (the `name` row in
   * state/slot-rules.ts, absent "unfilled").
   */
  name?: string;
}

/**
 * One poison instance's ledger, riding the combat session (#56, D11): the
 * observation-time compensation settlement's write-back surface ("write back
 * `applied`", spec/04 §4.2). `effectId` is the look-back channel — interval
 * and maxPulses are deliberately NOT persisted (they are entry data, read
 * back through the id when the poison resumes after a reload); `perTick` is
 * the pulse damage COMPUTED AT APPLICATION (T11②: the number is frozen into
 * the ledger, never re-derived per pulse).
 */
export interface DotLedger {
  /** The effect entry this instance was armed from (the look-back key). */
  readonly effectId: string;
  /** The tick the poison was applied at (pulse 0; pulse k is due at startTick + k×interval). */
  readonly startTick: number;
  /** Pulses already applied — the compensation's resume point. */
  applied: number;
  /** The pulse damage, computed at application time (T11②). */
  readonly perTick: number;
}

/**
 * The combat session's minimal C1 fields (#56, D11): one target NPC (C1 is
 * single-target, D12), their mutable HP and death mark — the NPC's whole
 * fight-side existence, since it has no tree row — and the poison instance
 * on them, when one is armed. C2 grows the rhythm fields here.
 */
export interface CombatSession {
  /** The npc entry id the fight is with (single target, D12). */
  readonly targetNpcId: string;
  /** The target's current HP (seeded from the monster entry's stats at first strike). */
  targetHp: number;
  /** The target's death mark: set when HP reaches the threshold; further strikes are refused. */
  targetDead: boolean;
  /** The poison instance on the target, when one is armed (single instance, C1). */
  dot?: DotLedger;
}

/**
 * The one tree. Entities are keyed by id, kind-agnostic: players today,
 * materialized items and stateful NPCs join the same map when their tickets
 * land (ADR-0028 consequences).
 */
export interface WorldState {
  entities: Record<string, EntityState>;
}
