import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import type { TargetRef } from "../command/parser.js";
import { commandRefusedEvent, customCode, deathEvent, strikeEvent } from "../events.js";
import type { ReasonCode } from "../types.js";
import { moveTo } from "../world/move.js";
import { resolveNpcTarget } from "../world/target.js";
import type { WorldRuntime } from "../world/runtime.js";
import type { EffectExecutionContext, EffectPrimitiveHandler } from "../effects/registry.js";
import { bandPairOf, monsterCombatFace, requireCharacterTable, retaliationDamage } from "./damage.js";
import { defaultEffectPrimitives } from "./primitives.js";
import { primaryResourceOf } from "./session.js";

/**
 * The strike orchestration (#56, AC1): the engine's factory adapter for the
 * strike command — traversal/look/say's sibling (the func belongs with the
 * engine; a host binds `strikeSpec(entry)` into its table and swaps packs by
 * swapping tables). One command = one player attack and one immediate npc
 * retaliation (D1's ruled C1 face — the immediate-retaliation half is
 * provisional by that same ruling).
 *
 * The three target-side checks (same room, a declared monster, not dead)
 * run as EXECUTION-STAGE refusals (the ticket's ruled route): the predicate
 * model evaluates a tree-side PLAYER subject and has no target seat, while
 * target resolution — this command's own first act — produces exactly what
 * the checks need. A refusal words itself through the entry's `err_*` copy
 * (commandKey + errKey), the CommandRejection precedent.
 *
 * Effect references (the entry's `effects`) drive the attack itself: each
 * referenced entry's primitives run through the injected registry
 * (instant-damage settles the strike, damage-over-time may arm a poison —
 * T11), and the retaliation follows unless the target died. A player death
 * refills the primary resource, relocates to the declared start room
 * (moveTo — the announcements ride along), and clears the whole combat
 * session (T6: the poison ledger and the NPC's death mark go with it).
 */

/** The refusal codes this adapter mints beyond the engine's own literals. */
const NOT_COMBATANT = customCode("notCombatant");
const TARGET_DEAD = customCode("targetDead");
const TARGET_LOCKED = customCode("targetLocked");

export interface StrikeSpecOptions {
  /**
   * The primitive implementations to execute effect references with;
   * defaults to the engine's shipped pair (combat/primitives.ts). Hosts
   * extend or replace the table the predicate-registry way.
   */
  readonly primitives?: ReadonlyMap<string, EffectPrimitiveHandler>;
}

/** Words one execution-stage refusal: the semantic event plus the rejection. */
function refuse(
  ctx: { emit(recipientId: string, draft: { type: string; [key: string]: unknown }): void },
  actorId: string,
  entryId: string,
  reason: ReasonCode,
  errKey: string,
): CommandRejection {
  ctx.emit(actorId, commandRefusedEvent({ reason, commandKey: entryId, errKey }));
  return { kind: "rejected", reason };
}

export function strikeSpec(entry: CommandEntry, options: StrikeSpecOptions = {}): CommandSpec<WorldRuntime> {
  const primitives = options.primitives ?? defaultEffectPrimitives;
  return commandSpecFromEntry<WorldRuntime>(entry, {
    func: (ctx) => {
      const runtime = ctx.world;
      const actorId = ctx.command.actorId;
      const registry = runtime.registry;
      const state = runtime.state.entities[actorId];
      if (state === undefined) {
        throw new Error(`combat: unknown actor "${actorId}"`);
      }
      const ref = ctx.args as TargetRef;

      // 1. Target resolution — the room's static presence, by written noun.
      const target = resolveNpcTarget(registry, runtime.locationOf(actorId), ref);
      if (!target.ok) {
        return target.reason === "notCombatant"
          ? refuse(ctx, actorId, entry.id, NOT_COMBATANT, "err_notCombatant")
          : refuse(ctx, actorId, entry.id, "notVisible", "err_notVisible");
      }
      const npc = target.npc;
      // resolveNpcTarget guarantees the monsterId on its ok arm.
      const monsterId = npc.monsterId as string;

      // 2. The session: continue the standing fight, refuse a switch (T3),
      //    refuse a corpse (D7), or open one seeded from the monster's face.
      let session = state.combat;
      if (session !== undefined) {
        if (session.targetNpcId !== npc.id) {
          return refuse(ctx, actorId, entry.id, TARGET_LOCKED, "err_targetLocked");
        }
        if (session.targetDead) {
          return refuse(ctx, actorId, entry.id, TARGET_DEAD, "err_targetDead");
        }
      } else {
        const face = monsterCombatFace(registry.monster(monsterId));
        session = { targetNpcId: npc.id, targetHp: face.maxHp, targetDead: false };
        state.combat = session;
      }

      // 3. The attack: every referenced effect's primitives, in entry order.
      //    A type with no implementation is a wiring miss, loud by design.
      const nowTick = ctx.clock.nowTick();
      for (const effectId of entry.effects ?? []) {
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
            attackerId: actorId,
            targetNpcId: npc.id,
            nowTick,
            rng: ctx.rng,
            emit: ctx.emit,
            effectId,
          };
          handler(primitive, context);
        }
      }

      // 4. The retaliation (T10: bare damage — no formula, no player
      //    defense, no dodge roll) unless the attack already killed.
      if (session.targetDead) {
        return;
      }
      const character = requireCharacterTable(registry);
      const face = monsterCombatFace(registry.monster(monsterId));
      const resource = primaryResourceOf(state, character);
      const damage = retaliationDamage(face.attack);
      const hp = resource.current - damage;
      state.attrs[character.primaryResource.current] = hp;
      const bands = bandPairOf(registry.combatTiers, damage, resource.max, hp);
      ctx.emit(actorId, strikeEvent({
        attackerId: npc.id,
        defenderId: actorId,
        damage,
        ...bands,
        isDodge: false,
        isCrit: false,
        element: face.element,
        source: face.source,
      }));

      // 5. The player's death (D7): announce, refill the primary resource,
      //    clear the WHOLE session (T6 — the NPC's death mark and any poison
      //    go with it), and relocate through the movement orchestration so
      //    the departure/arrival announcements ride the same events.
      if (hp <= character.deathAtOrBelow) {
        ctx.emit(actorId, deathEvent({ deceasedId: actorId, kind: "player", cause: "strike" }));
        state.attrs[character.primaryResource.current] = resource.max;
        delete state.combat;
        const world = registry.world;
        if (world === undefined) {
          throw new Error("combat: the pack declares no world table — nowhere to send the dead");
        }
        moveTo(
          runtime,
          { entityId: actorId, toLocationId: world.startRoomId, moveType: "teleport" },
          { emit: ctx.emit },
        );
      }
    },
  });
}
