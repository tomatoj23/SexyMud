import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import type { TargetRef } from "../command/parser.js";
import { commandRefusedEvent, customCode } from "../events.js";
import type { ReasonCode } from "../types.js";
import { resolveNpcTarget } from "../world/target.js";
import type { WorldRuntime } from "../world/runtime.js";
import { monsterCombatFace, requireCharacterTable } from "./damage.js";
import { playerBlow } from "./blow.js";
import type { StrikeSpecOptions } from "./blow.js";
import { IN_COMBAT } from "./guard.js";

/**
 * The strike command's C2 face (#57, AC1): striking a name OPENS the
 * fight — the first hand settles immediately (C1's feel, kept), the session
 * turns into the AUTO-EXCHANGE both rhythm fields now drive, and the npc's
 * first hand is due at the opening tick + HER interval (D10: C1's immediate
 * retaliation was ruled a provisional reading, and this is its replacement).
 *
 * Striking again mid-fight is refused either way (D2): the same target
 * because the auto-exchange already has the player's hands (`inCombat`), a
 * different target because one fight at a time is the standing rule (T3).
 * A dead session left by a C1-era save is cleared on sight — under D6 death
 * clears the whole session, and a fresh strike at the same name opens a
 * brand-new fight at full HP.
 *
 * The player's death path is NOT here anymore: the npc's hands are the
 * settle layer's now (combat/session.ts), and the settle layer owns the
 * killing hand's consequences.
 */

/** The refusal codes this adapter mints beyond the engine's own literals. */
const NOT_COMBATANT = customCode("notCombatant");
const TARGET_LOCKED = customCode("targetLocked");

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

      // 2. The session: a standing fight refuses the strike either way (D2)
      //    — the same target because the auto-exchange already carries the
      //    player's hands, another target because one fight at a time (T3).
      //    A C1-era dead session is cleared on sight (D6's late half).
      if (state.combat !== undefined) {
        if (state.combat.targetDead) {
          delete state.combat;
        } else if (state.combat.targetNpcId === npc.id) {
          return refuse(ctx, actorId, entry.id, IN_COMBAT, "err_inCombat");
        } else {
          return refuse(ctx, actorId, entry.id, TARGET_LOCKED, "err_targetLocked");
        }
      }

      // 3. Open the fight (D2/D10): both sides' next hands arm at the
      //    opening tick + their own interval — the opening hand below is
      //    the player's NOW, and the npc starts from hers.
      const nowTick = ctx.clock.nowTick();
      const face = monsterCombatFace(registry.monster(monsterId));
      const character = requireCharacterTable(registry);
      state.combat = {
        targetNpcId: npc.id,
        targetHp: face.maxHp,
        targetDead: false,
        playerNextStrikeTick: nowTick + character.strikeIntervalTicks,
        npcNextStrikeTick: nowTick + face.attackIntervalTicks,
      };

      // 4. The opening hand (D2: keep C1's feel): the shared blow — dodge
      //    rolled at the orchestration level, the entry's effect chain, and
      //    D6's session-clearing on a kill, all in combat/blow.ts.
      playerBlow(
        runtime,
        state,
        npc.id,
        {
          nowTick,
          rng: ctx.rng,
          emit: (to, draft) => ctx.emit(to, draft),
        },
        { effects: entry.effects ?? [], primitives: options.primitives },
      );
    },
  });
}
