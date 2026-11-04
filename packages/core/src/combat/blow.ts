import type { EventDraft } from "../command/pipeline.js";
import { strikeEvent } from "../events.js";
import type { Rng } from "../types.js";
import type { EntityState } from "../state/tree.js";
import type { WorldRuntime } from "../world/runtime.js";
import type { EffectExecutionContext, EffectPrimitiveHandler } from "../effects/registry.js";
import { bandPairOf, monsterCombatFace, requireCharacterTable } from "./damage.js";
import { defaultEffectPrimitives } from "./primitives.js";

/**
 * ONE player blow (#57 D2/F2, #58 D15): the shared orchestration behind the
 * opening hand (the strike command's own), every auto-hand the settle layer
 * advances, and every perform hand — the same dice, the same effect chain,
 * the same death handling, because a hand is one behaviour whether typed,
 * scheduled, or cast by name.
 *
 * WHAT the hand is arrives as a STRIKE PLAN (#58): the base strike's own
 * face (the entry's effect chain, no cost, no cooldown) or a martial's (the
 * entry's chain, its delivery/element words, its multiplier, its cost and
 * cooldown). The plan is the intent model's payload — an explicit
 * instruction (perform) names it, the strategy layer (the assembly order)
 * picks it, and the bare command carries the base one.
 *
 * The dodge roll lives HERE, at the blow's orchestration level (F2's ruling:
 * a dodge is the WHOLE strike missing, damage and effects sharing one fate).
 * The primitive layer below no longer rolls: a dodged blow never reaches
 * the effect chain, so a dodged poison fist cannot arm its poison — C1's
 * known debt (a ~1.75% corner where it did) is gone with the move. The cost
 * and the cooldown are spent BEFORE the roll (#58): the hand happened, it
 * merely missed.
 *
 * An NPC killed by the blow clears the WHOLE session right here (D6): the
 * poison ledger goes with it, and a fresh strike at the same name opens a
 * brand-new fight at full HP.
 */

/** What one blow needs injected: the now it lands at, the dice, the words' exit. */
export interface BlowPorts {
  readonly nowTick: number;
  readonly rng: Rng;
  emit(recipientId: string, draft: EventDraft): void;
}

export interface StrikeSpecOptions {
  /**
   * The primitive implementations to execute effect references with;
   * defaults to the engine's shipped pair (combat/primitives.ts). Hosts
   * extend or replace the table the predicate-registry way.
   */
  readonly primitives?: ReadonlyMap<string, EffectPrimitiveHandler>;
}

/**
 * What one hand IS (#58 D15): the plan the blow executes. Every field is
 * content's — the entry's numbers and words, or the character table's own
 * for the base strike — chosen by whoever owns the hand's intent (the
 * command, the wheel, the perform spec).
 */
export interface StrikePlan {
  /**
   * The effect ids this hand walks: the martial entry's own, or the base
   * strike chain the host wires (the strike command entry's effects).
   */
  readonly effects: readonly string[];
  /** The delivery word this hand carries and the monster defense it routes (D17). */
  readonly source: string;
  /** The element word this hand carries on its strike event. */
  readonly element: string;
  /** The martial entry id when this hand is one; absent = the basic strike (D16①). */
  readonly martialId?: string;
  /** The quality word (the tier's band) when this hand is one; absent otherwise. */
  readonly rank?: string;
  /**
   * The multiplier on the attack operand (D11): a martial's declared value,
   * 1 for the base strike — or the exhausted ratio when the wheel fell back
   * drained (D18).
   */
  readonly attackMultiplier: number;
  /** The secondary-resource cost this hand deducts; 0 for the base strike. */
  readonly cost: number;
  /** The cooldown this hand arms (`cooldowns[martialId]`); none when absent (D12). */
  readonly cooldownTicks?: number;
}

/** The plan's event-facing half — what the effect chain's context carries. */
function strikeFaceOf(plan: StrikePlan) {
  return {
    martialId: plan.martialId,
    rank: plan.rank,
    source: plan.source,
    element: plan.element,
    attackMultiplier: plan.attackMultiplier,
  };
}

/** The base plan from a command entry's own chain: the C1 face, no cost, no cooldown. */
export function baseStrikePlan(
  effects: readonly string[],
  face: { source: string; element: string },
): StrikePlan {
  return {
    effects,
    source: face.source,
    element: face.element,
    attackMultiplier: 1,
    cost: 0,
  };
}

/**
 * Deducts a hand's cost from the secondary resource (#58 D18): the pair the
 * character table declares, loudly — a cost-bearing plan against a table
 * with no secondary pair is a wiring bug, and a hand that cannot pay is the
 * CALLER's refusal (the wheel and the perform spec both check first), never
 * a silent negative.
 */
function payStrikeCost(state: EntityState, currentKey: string, cost: number): void {
  const value = state.attrs[currentKey];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `combat: the player's attrs carry no usable secondary resource (key "${currentKey}") — seed the character table at startNewGame`,
    );
  }
  state.attrs[currentKey] = value - cost;
}

/**
 * Settles one player blow against the session's standing target. Assumes
 * the session is LIVE (target not dead) and bound to the npc the face is
 * read from; the caller owns target resolution and the session's birth.
 */
export function playerBlow(
  runtime: WorldRuntime,
  state: EntityState,
  npcId: string,
  ports: BlowPorts,
  plan: StrikePlan,
  options: StrikeSpecOptions = {},
): void {
  const registry = runtime.registry;
  const session = state.combat;
  if (session === undefined || session.targetNpcId !== npcId || session.targetDead) {
    // The orchestration (the strike adapter, the settle loop) guarantees a
    // live session bound to this npc; anything else is a wiring bug.
    throw new Error(
      `combat: no live session for "${state.id}" against "${npcId}" — the blow has nowhere to land`,
    );
  }
  const npc = registry.npc(npcId);
  // The monsterId is the npc entry's own guarantee (its reference check ran
  // at load); re-asserted here rather than trusted alone.
  if (npc.monsterId === undefined) {
    throw new Error(`combat: npc "${npcId}" declares no monsterId`);
  }
  const face = monsterCombatFace(registry.monster(npc.monsterId));
  const character = requireCharacterTable(registry);

  // The hand is SPENT before it lands (#58): the cost leaves the secondary
  // resource and the cooldown arms — a dodged or glancing hand has paid all
  // the same, the poison-fist application chance's own law.
  if (plan.cost > 0) {
    const secondary = character.secondaryResource;
    if (secondary === undefined) {
      throw new Error(
        `combat: martial "${plan.martialId ?? "?"}" costs ${plan.cost} but the character table declares no secondaryResource pair — a cost-bearing pack needs the pair (#58 D18)`,
      );
    }
    payStrikeCost(state, secondary.current, plan.cost);
  }
  if (plan.martialId !== undefined && plan.cooldownTicks !== undefined && plan.cooldownTicks > 0) {
    state.cooldowns[plan.martialId] = ports.nowTick + plan.cooldownTicks;
  }

  // The dodge roll — ONE roll for the WHOLE blow (F2): a miss short-circuits
  // the entire effect chain, it does not merely zero one damage number.
  const isDodge = face.dodge > 0 && ports.rng.next() < face.dodge;
  if (isDodge) {
    const bands = bandPairOf(registry.combatTiers, 0, face.maxHp, session.targetHp);
    ports.emit(state.id, strikeEvent({
      attackerId: state.id,
      defenderId: npcId,
      damage: 0,
      ...bands,
      isDodge: true,
      isCrit: false,
      element: plan.element,
      source: plan.source,
      ...(plan.martialId !== undefined ? { martialId: plan.martialId, rank: plan.rank } : {}),
    }));
    return;
  }

  // The effect chain: every referenced entry's primitives, in entry order.
  // A type with no implementation is a wiring miss, loud by design.
  const primitives = options.primitives ?? defaultEffectPrimitives;
  for (const effectId of plan.effects) {
    const effect = registry.effect(effectId);
    for (const primitive of effect.primitives) {
      const handler = primitives.get(primitive.type);
      if (handler === undefined) {
        throw new Error(
          `combat: no implementation registered for primitive type "${primitive.type}" (effect "${effectId}")`,
        );
      }
      const context: EffectExecutionContext = {
        runtime,
        attackerId: state.id,
        targetNpcId: npcId,
        nowTick: ports.nowTick,
        rng: ports.rng,
        emit: ports.emit,
        effectId,
        strike: strikeFaceOf(plan),
      };
      handler(primitive, context);
    }
  }

  // Death clears the WHOLE session (D6) — poison ledger included, the npc
  // side's symmetry of the player-death clearing (C1-T6).
  if (session.targetDead) {
    delete state.combat;
  }
}
