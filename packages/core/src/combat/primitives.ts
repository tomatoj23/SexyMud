import { deathEvent, strikeEvent } from "../events.js";
import type { EffectPrimitive } from "../effects/entry.js";
import { createEffectPrimitiveRegistry } from "../effects/registry.js";
import type {
  EffectExecutionContext,
  EffectPrimitiveHandler,
} from "../effects/registry.js";
import { aggregateModifiers } from "../effects/modifiers.js";
import {
  bandPairOf,
  clampedHp,
  faceDefenseOf,
  monsterCombatFace,
  readDefenseK,
  requireCharacterTable,
  strikeDamage,
} from "./damage.js";
import { mentalModifiersFor } from "./mental.js";

/**
 * The first two primitive implementations (#56 D9, #57 F2): `instant-damage`
 * and `damage-over-time`, the strike's whole effect vocabulary. They live
 * HERE — with the consumer that owns their semantics — and register into the
 * effect contract's registry (effects/registry.ts): the contract side
 * imports no mechanism module (AC8's pinned direction), and a future
 * mechanism module (skills, items) ships its own handlers into the same
 * registry without either side importing the other.
 */

/** What the walk assumes: the attacker's state and a session bound to the target. */
function sessionOf(ctx: EffectExecutionContext) {
  const state = ctx.runtime.state.entities[ctx.attackerId];
  const session = state?.combat;
  if (state === undefined || session === undefined || session.targetNpcId !== ctx.targetNpcId) {
    // The orchestration (combat/blow.ts) builds the session before walking
    // effects; reaching here without one is a wiring bug, not play.
    throw new Error(
      `combat: no combat session for "${ctx.attackerId}" against "${ctx.targetNpcId}"`,
    );
  }
  return { state, session };
}

/**
 * `instant-damage`: the entry TRIGGERS the strike settlement (T11①(a)) —
 * the formula runs with the character table's operands, and the primitive's
 * static `amount` is deliberately unused (the seat stays declared for the
 * day a content-authored flat damage wants it).
 *
 * #57 F2: the dodge roll NO LONGER lives here — it rolled one primitive's
 * damage while the blow's other effects (a poison fist) still landed, C1's
 * known corner. The roll moved UP to the blow's orchestration (combat/
 * blow.ts): a dodged blow never reaches this primitive at all.
 *
 * #58 D11/D15/D17: the hand's strike face (combat/blow.ts's plan, carried
 * on the context) scales the attack operand by the hand's multiplier and
 * routes the monster-side defense by the hand's delivery word — absent is
 * the basic strike's own face (multiplier 1, the table's words, the
 * external defense), the C1/C2 arithmetic unchanged.
 */
export const instantDamage: EffectPrimitiveHandler = (primitive, ctx) => {
  const { state, session } = sessionOf(ctx);
  const registry = ctx.runtime.registry;
  const npc = registry.npc(ctx.targetNpcId);
  if (npc.monsterId === undefined) {
    throw new Error(`combat: npc "${npc.id}" declares no monsterId`);
  }
  const face = monsterCombatFace(registry.monster(npc.monsterId));
  const character = requireCharacterTable(registry);
  const attackRaw = state.attrs[character.strike.attackAttr];
  if (typeof attackRaw !== "number" || !Number.isFinite(attackRaw)) {
    throw new Error(
      `combat: the player's attrs carry no usable attack value (key "${character.strike.attackAttr}") — seed the character table at startNewGame`,
    );
  }
  const hand = ctx.strike;
  const multiplier = hand?.attackMultiplier ?? 1;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error("combat: a strike face carries a non-positive attack multiplier");
  }
  const defense = faceDefenseOf(face, hand?.source ?? character.strike.source);
  // #59 D11: the attack operand walks the modifier pipeline (consumer point
  // ①, the pre-existing call site) — the equipped mentals' declared members
  // on the attack stat key, the pipe's first real members.
  const damage = strikeDamage(
    attackRaw * multiplier,
    defense,
    readDefenseK(registry.settings),
    mentalModifiersFor(registry, state, character.strike.attackAttr),
  );
  // F6: one clamped write — a save's HP above a content-revised ceiling
  // heals itself on the very next settlement.
  session.targetHp = clampedHp(session.targetHp - damage, face.maxHp);
  const bands = bandPairOf(registry.combatTiers, damage, face.maxHp, session.targetHp);
  ctx.emit(ctx.attackerId, strikeEvent({
    attackerId: ctx.attackerId,
    defenderId: ctx.targetNpcId,
    damage,
    ...bands,
    isDodge: false,
    isCrit: false,
    element: hand?.element ?? character.strike.element,
    source: hand?.source ?? character.strike.source,
    ...(hand?.martialId !== undefined
      ? { martialId: hand.martialId, rank: hand.rank }
      : {}),
  }));
  if (session.targetHp <= 0 && !session.targetDead) {
    session.targetDead = true;
    ctx.emit(ctx.attackerId, deathEvent({
      deceasedId: ctx.targetNpcId,
      kind: "npc",
      cause: "strike",
    }));
  }
};

/**
 * `damage-over-time`: rolls the application chance (an absent chance is
 * certainty — the schema's optional-field law), then ARMS the poison by
 * freezing the pulse damage into the session ledger at application time
 * (T11②: `perTick` is computed once — the entry's `amount` walked through
 * the modifier core — and every later pulse reads the ledger, never the
 * entry's numbers). Interval and maxPulses are NOT copied: the ledger
 * carries `effectId`, the look-back channel (D11), and the settle handler
 * re-reads the entry every settlement.
 *
 * ONE instance at a time (implementation-batch ruling, on D4's "the poison
 * hops at most maxPulses times"): a target already poisoned is not
 * re-armed — a re-application neither resets the pulse count nor refreshes
 * the start, so `maxPulses` stays the cap of ONE poisoning, not a cap per
 * strike.
 */
export const damageOverTime: EffectPrimitiveHandler = (primitive, ctx) => {
  const { session } = sessionOf(ctx);
  if (session.dot !== undefined) {
    return;
  }
  const chance = primitive.chance;
  if (typeof chance === "number" && ctx.rng.next() >= chance) {
    return;
  }
  const amount = primitive.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(
      `combat: effect "${ctx.effectId}" declares a damage-over-time primitive without a finite amount`,
    );
  }
  session.dot = {
    effectId: ctx.effectId,
    startTick: ctx.nowTick,
    applied: 0,
    perTick: Math.max(0, Math.round(aggregateModifiers(amount))),
  };
};

/** The shipped primitive implementations as a ready registry. */
export const defaultEffectPrimitives = createEffectPrimitiveRegistry([
  ["instant-damage", instantDamage],
  ["damage-over-time", damageOverTime],
] as const);
