import type { EventDraft } from "../command/pipeline.js";
import { strikeEvent } from "../events.js";
import type { Rng } from "../types.js";
import type { EntityState } from "../state/tree.js";
import type { WorldRuntime } from "../world/runtime.js";
import type { EffectExecutionContext, EffectPrimitiveHandler } from "../effects/registry.js";
import { bandPairOf, monsterCombatFace, requireCharacterTable } from "./damage.js";
import { defaultEffectPrimitives } from "./primitives.js";

/**
 * ONE player blow (#57 D2/F2): the shared orchestration behind the opening
 * hand (the strike command's own) and every auto-hand the settle layer
 * advances — the same dice, the same effect chain, the same death handling,
 * because the strike verb is one behaviour whether typed or scheduled.
 *
 * The dodge roll lives HERE, at the blow's orchestration level (F2's ruling:
 * a dodge is the WHOLE strike missing, damage and effects sharing one fate).
 * The primitive layer below no longer rolls: a dodged blow never reaches
 * the effect chain, so a dodged poison fist cannot arm its poison — C1's
 * known debt (a ~1.75% corner where it did) is gone with the move.
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

/** The blow's effect vocabulary: which entries a hand walks, through which primitives. */
export interface BlowOptions {
  /**
   * The effect ids a player hand executes — the strike command entry's own
   * `effects`, handed in by whoever wires the command (the settle handler
   * gets it the same way, so typed and scheduled hands stay one behaviour).
   */
  readonly effects: readonly string[];
  /** The primitive implementations; defaults to the engine's shipped pair. */
  readonly primitives?: ReadonlyMap<string, EffectPrimitiveHandler>;
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
  options: BlowOptions,
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
      element: character.strike.element,
      source: character.strike.source,
    }));
    return;
  }

  // The effect chain: every referenced entry's primitives, in entry order.
  // A type with no implementation is a wiring miss, loud by design.
  const primitives = options.primitives ?? defaultEffectPrimitives;
  for (const effectId of options.effects) {
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
