import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import { customCode, customEvent } from "../events.js";
import type { ExitEntry } from "../world/entry.js";
import { traversalSpec } from "../world/traverse.js";
import type { WorldRuntime } from "../world/runtime.js";
import { monsterCombatFace, readEscapeChance, requireCharacterTable } from "./damage.js";
import { npcStrike } from "./session.js";

/**
 * The combat-bearing traversal (#57 D11/D14, AC7/AC9): the engine's
 * traversal adapter wrapped with the two behaviours a mid-fight move
 * carries — the ESCAPE roll before the move, the PROACTIVE check after it.
 * Hosts bind this where they bound `traversalSpec` for the fights their
 * pack has; the pure adapter stands unchanged beside it (a pack without
 * combat loses nothing by binding the pure one).
 *
 * The escape roll (D11): a mid-fight move is an escape ATTEMPT against
 * `settings.combat.escapeChance` — one global constant, the `defenseK`
 * family (entity-influenced escape faces are C3+'s). Failure keeps the
 * fight and spends a hand's time (the player's next strike pushes one
 * interval); success DISENGAGES — the whole session clears before the move
 * runs (poison ledger with it), and the move itself is then an ordinary
 * traversal: an enter gate may still refuse the ROOM, and that refusal
 * finds the player already out of the fight (escaping the grip and being
 * barred from a door are two different facts).
 *
 * The proactive edge (D14): after a successful move, the first proactive
 * npc in the new room's static presence opens the fight — HER hand lands
 * immediately (whoever opens strikes first; the player's hands arm from
 * the interval), the strike event itself is the declaration, no new event
 * type. Occupied sessions never trigger it (one fight at a time), and the
 * three non-move arrivals (death teleport, load, new game) never pass
 * through here at all — the ticket's C2-T3 ruling.
 */

/** The escape failure's refusal code (its words live host-side, below). */
const ESCAPE_FAILED: CommandRejection["reason"] = customCode("escapeFailed");

/** The escape event's extension-arm type: the host words both outcomes. */
export const COMBAT_ESCAPE_EVENT = "combatEscape";

export function combatTraversalSpec(exit: ExitEntry): CommandSpec<WorldRuntime> {
  // The pure adapter's func, run as this spec's inner half: enter gate,
  // moveTo, veto wording — unchanged, one implementation.
  const inner = traversalSpec(exit);
  return commandSpecFromEntry<WorldRuntime>(exit, {
    accessType: "traverse",
    func: (ctx) => {
      const runtime = ctx.world;
      const actorId = ctx.command.actorId;
      const state = runtime.state.entities[actorId];
      if (state === undefined) {
        throw new Error(`combat traversal: unknown actor "${actorId}"`);
      }
      const nowTick = ctx.clock.nowTick();

      // 1. The escape attempt (a session free of its target's fight is none
      //    at all — a C1-era dead session clears on sight, D6's late half).
      const session = state.combat;
      if (session !== undefined && session.targetDead) {
        delete state.combat;
      }
      if (state.combat !== undefined) {
        const registry = runtime.registry;
        const character = requireCharacterTable(registry);
        const chance = readEscapeChance(registry.settings);
        if (ctx.rng.next() >= chance) {
          // Failure (D11): the fight holds. The player spends a hand's time
          // — their next strike pushes one interval. A rhythm-less session
          // (a C1-era save never observed) seeds BOTH sides first, so the
          // price survives the next observation's seeding pass instead of
          // being flattened by it.
          const standing = state.combat;
          if (standing.playerNextStrikeTick === undefined) {
            standing.playerNextStrikeTick = nowTick + character.strikeIntervalTicks;
          }
          if (standing.npcNextStrikeTick === undefined) {
            const monsterId = registry.npc(standing.targetNpcId).monsterId;
            if (monsterId === undefined) {
              throw new Error(
                `combat: session target "${standing.targetNpcId}" declares no monsterId (content drift)`,
              );
            }
            standing.npcNextStrikeTick =
              nowTick + monsterCombatFace(registry.monster(monsterId)).attackIntervalTicks;
          }
          standing.playerNextStrikeTick += character.strikeIntervalTicks;
          ctx.emit(
            actorId,
            customEvent(COMBAT_ESCAPE_EVENT, {
              outcome: "pinned",
              npcId: standing.targetNpcId,
            }),
          );
          return { kind: "rejected", reason: ESCAPE_FAILED };
        }
        // Success (D11): disengaged — the whole session clears (poison
        // ledger with it, the npc back at full HP for whoever fights next).
        ctx.emit(
          actorId,
          customEvent(COMBAT_ESCAPE_EVENT, {
            outcome: "escaped",
            npcId: state.combat.targetNpcId,
          }),
        );
        delete state.combat;
      }

      // 2. The move itself: the pure adapter's behaviour, refusals passed
      //    through as-is (the enter gate's own words, the veto's own).
      const rejection = inner.func?.(ctx);
      if (rejection !== undefined) {
        return rejection;
      }

      // 3. The proactive edge (D14): only a successful move into a room
      //    whose static presence carries a proactive npc — the FIRST in the
      //    placement list (multi-aggressor corners ride the multi-target
      //    ticket), never when a session stands (the C1-T3 focus).
      if (state.combat !== undefined) {
        return;
      }
      const registry = runtime.registry;
      const roomId = runtime.locationOf(actorId);
      if (roomId !== exit.targetRoomId) {
        // The inner half did not land the player in the exit's target (a
        // future redirecting moveType); the edge is exit-shaped, not a
        // general arrival hook.
        return;
      }
      const room = registry.room(roomId);
      for (const placement of room.objects ?? []) {
        // `find`, not the throwing `npc(id)`: a placement row may name a
        // monster or a future kind, and those rows simply do not match —
        // the same skip resolveNpcTarget makes (world/target.ts).
        const npc = registry.npcs.find((candidate) => candidate.id === placement.id);
        if (npc === undefined || npc.monsterId === undefined) {
          continue;
        }
        const face = monsterCombatFace(registry.monster(npc.monsterId));
        if (!face.proactive) {
          continue;
        }
        // She opens (D14): her hand lands NOW, the player's hands arm from
        // the interval — the mirror of the player's opening hand (D2/D10).
        const character = requireCharacterTable(registry);
        state.combat = {
          targetNpcId: npc.id,
          targetHp: face.maxHp,
          targetDead: false,
          playerNextStrikeTick: nowTick + character.strikeIntervalTicks,
          npcNextStrikeTick: nowTick + face.attackIntervalTicks,
        };
        npcStrike(runtime, state, npc.id, {
          nowTick,
          emit: (to, draft) => ctx.emit(to, draft),
        });
        return;
      }
    },
  });
}
