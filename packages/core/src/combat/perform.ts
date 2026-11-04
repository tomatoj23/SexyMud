import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandSpec } from "../command/pipeline.js";
import { customCode } from "../events.js";
import type { ReasonCode } from "../types.js";
import { cooldownReady } from "../time/cooldown.js";
import type { WorldRuntime } from "../world/runtime.js";
import { requireCharacterTable } from "./damage.js";
import { DEFAULT_NPC_ATTACK_INTERVAL_TICKS } from "./damage.js";
import { playerBlow } from "./blow.js";
import type { StrikeSpecOptions } from "./blow.js";
import { martialStrikePlan, secondaryResourceOf } from "./martial.js";
import { martialIdByName } from "./equip.js";
import { refuseExecutionStage } from "./guard.js";

/**
 * The perform command (#58 D5/D14): the cast verb ("perform X") casts the
 * NAMED equipped martial NOW — one hand out of turn that REPLACES the
 * rhythm's upcoming hand (the reschedule is the queue-jump's own price: a
 * next hand that was close gets pushed a little further; the advance is
 * monotonic, a far-off hand is never pulled closer).
 *
 * The hand itself is the SAME blow orchestration every other hand runs
 * (D15: one behaviour, the plan the only difference) — the dodge roll, the
 * entry's effect chain, the cost, the cooldown, the death-clearing. Four
 * refusal faces, all err_*: not in a fight (an out-of-turn hand needs a
 * turn to be out of), not equipped, still cooling, cannot afford.
 *
 * Name matching (C3-T5) is EXACT over the equipped list's display names —
 * the wheel's own priority order walked, so two same-named entries resolve
 * to whichever sits higher. Target resolution stays a generic engine
 * capability this command never touches; martial-name matching is combat
 * domain logic and lives HERE, the D14 ruling.
 */

/** The refusal codes this adapter mints beyond the engine's own literals. */
const NOT_IN_COMBAT: ReasonCode = customCode("notInCombat");
const NOT_EQUIPPED: ReasonCode = customCode("notEquipped");
const ON_COOLDOWN: ReasonCode = customCode("onCooldown");
const OUT_OF_FORCE: ReasonCode = customCode("outOfForce");

/** The shared refusal wording (guard.ts) — the strike adapter's own shape. */
const refuse = refuseExecutionStage;

export function performSpec(
  entry: CommandEntry,
  options: StrikeSpecOptions = {},
): CommandSpec<WorldRuntime> {
  return commandSpecFromEntry<WorldRuntime>(entry, {
    func: (ctx) => {
      const runtime = ctx.world;
      const actorId = ctx.command.actorId;
      const state = runtime.state.entities[actorId];
      if (state === undefined) {
        throw new Error(`combat: unknown actor "${actorId}"`);
      }
      // 1. An out-of-turn hand needs a turn to be out of (D14's premise).
      //    A C1-era dead session clears on sight, the strike adapter's law.
      if (state.combat !== undefined && state.combat.targetDead) {
        delete state.combat;
      }
      if (state.combat === undefined) {
        return refuse(ctx, actorId, entry.id, NOT_IN_COMBAT, "err_notInCombat");
      }

      // 2. The named martial among the EQUIPPED list (C3-T5: exact match,
      //    walked in the wheel's own priority order).
      const martialId = martialIdByName(runtime, state.martial ?? [], String(ctx.args ?? ""));
      if (martialId === undefined) {
        return refuse(ctx, actorId, entry.id, NOT_EQUIPPED, "err_notEquipped");
      }

      const registry = runtime.registry;
      const nowTick = ctx.clock.nowTick();
      // 3. Off cooldown (the same comparison the wheel makes).
      if (!cooldownReady(state.cooldowns, martialId, nowTick)) {
        return refuse(ctx, actorId, entry.id, ON_COOLDOWN, "err_onCooldown");
      }

      // 4. Affordable (the character table's secondary pair, loudly).
      const character = requireCharacterTable(registry);
      const plan = martialStrikePlan(registry, registry.martial(martialId));
      const resource = secondaryResourceOf(state, character);
      if (resource === undefined && plan.cost > 0) {
        throw new Error(
          `combat: martial "${martialId}" costs ${plan.cost} but the character table declares no secondaryResource pair — a cost-bearing pack needs the pair (#58 D18)`,
        );
      }
      if (resource !== undefined && plan.cost > resource.current) {
        return refuse(ctx, actorId, entry.id, OUT_OF_FORCE, "err_outOfForce");
      }

      // 5. The hand (D5): the shared blow NOW — cost, cooldown, dodge and
      //    chain all inside it — then the RESCHEDULE: the rhythm's next hand
      //    advances to at least now + the interval, monotonic (a close hand
      //    is pushed back a little; a far one keeps its place).
      playerBlow(
        runtime,
        state,
        state.combat.targetNpcId,
        { nowTick, rng: ctx.rng, emit: (to, draft) => ctx.emit(to, draft) },
        plan,
        options,
      );
      if (state.combat !== undefined) {
        const interval = character.strikeIntervalTicks;
        const scheduled = state.combat.playerNextStrikeTick;
        state.combat.playerNextStrikeTick = Math.max(scheduled ?? 0, nowTick + interval);
        if (state.combat.npcNextStrikeTick === undefined) {
          // The pair travels together (D13): a rhythm-less session the
          // perform path touched first arms the npc side too.
          const npc = registry.npc(state.combat.targetNpcId);
          const monsterId = npc.monsterId;
          if (monsterId === undefined) {
            throw new Error(
              `combat: session target "${state.combat.targetNpcId}" declares no monsterId (content drift)`,
            );
          }
          state.combat.npcNextStrikeTick =
            nowTick +
            (registry.monster(monsterId).stats?.attackIntervalTicks ??
              DEFAULT_NPC_ATTACK_INTERVAL_TICKS);
        }
      }
    },
  });
}
