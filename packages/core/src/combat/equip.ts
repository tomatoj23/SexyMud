import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandSpec } from "../command/pipeline.js";
import { customCode, customEvent } from "../events.js";
import type { ReasonCode } from "../types.js";
import type { WorldRuntime } from "../world/runtime.js";
import { refuseExecutionStage } from "./guard.js";

/**
 * The equip and unequip commands (#58 D13): out-of-combat management of the
 * equipped slot, TWO entries because the two verbs are opposites no one
 * argForm path could tell apart (the ticket's own ruling). The engine's
 * laws: the cap (4 — the assembly diagram's own breadth), the known-list
 * membership (learning is content's, D2), and the slot's ORDER as the
 * wheel's priority — equipping APPENDS, unequipping REMOVES, and the
 * reorder path is the pair of them (unequip then equip again: no silent
 * reordering face). Both entries declare `notInCombat` in content and ride
 * the engine's guard wrapper at the binding table.
 *
 * Success rides the customEvent precedent (combatEscape, flagGranted): the
 * event is semantic (the id), the words are the host's.
 */

/** The success events' extension-arm types: the host words both. */
export const MARTIAL_EQUIPPED_EVENT = "martialEquipped";
export const MARTIAL_UNEQUIPPED_EVENT = "martialUnequipped";

/** The assembly cap (#58 D13): the slot's breadth, the equip law's own number. */
export const MARTIAL_SLOT_CAP = 4;

/** The refusal codes these adapters mint beyond the engine's own literals. */
const NOT_LEARNED: ReasonCode = customCode("notLearned");
const ALREADY_EQUIPPED: ReasonCode = customCode("alreadyEquipped");
const NOT_EQUIPPED: ReasonCode = customCode("notEquipped");
const SLOT_FULL: ReasonCode = customCode("martialSlotFull");

/** The shared refusal wording (guard.ts) — the strike adapter's own shape. */
const refuse = refuseExecutionStage;

/**
 * The named martial's id among a list, walked in the list's own order
 * (C3-T5: EXACT name match). Shared by the equip pair and perform — the
 * three name-taking commands answer one matcher, never three.
 */
export function martialIdByName(
  runtime: WorldRuntime,
  ids: readonly string[],
  name: string,
): string | undefined {
  return ids.find((id) => runtime.registry.martial(id).name === name);
}

export function equipSpec(entry: CommandEntry): CommandSpec<WorldRuntime> {
  return commandSpecFromEntry<WorldRuntime>(entry, {
    func: (ctx) => {
      const runtime = ctx.world;
      const actorId = ctx.command.actorId;
      const state = runtime.state.entities[actorId];
      if (state === undefined) {
        throw new Error(`combat: unknown actor "${actorId}"`);
      }
      // 1. The named martial must be LEARNED (D2: the known list is the
      //    content-declared truth — an unknown name and an unlearned one
      //    are the same refusal face, the minimal cut).
      const known = runtime.registry.character?.martial?.known ?? [];
      const martialId = martialIdByName(runtime, known, String(ctx.args ?? ""));
      if (martialId === undefined) {
        return refuse(ctx, actorId, entry.id, NOT_LEARNED, "err_notLearned");
      }

      // 2. Not already on (the reorder path is unequip-then-equip, no
      //    silent move-to-end face); 3. under the cap.
      const equipped = state.martial ?? [];
      if (equipped.includes(martialId)) {
        return refuse(ctx, actorId, entry.id, ALREADY_EQUIPPED, "err_alreadyEquipped");
      }
      if (equipped.length >= MARTIAL_SLOT_CAP) {
        return refuse(ctx, actorId, entry.id, SLOT_FULL, "err_martialSlotFull");
      }

      // 4. Append — the slot's tail is the wheel's lowest priority (D6).
      state.martial = [...equipped, martialId];
      ctx.emit(actorId, customEvent(MARTIAL_EQUIPPED_EVENT, { martialId }));
    },
  });
}

export function unequipSpec(entry: CommandEntry): CommandSpec<WorldRuntime> {
  return commandSpecFromEntry<WorldRuntime>(entry, {
    func: (ctx) => {
      const runtime = ctx.world;
      const actorId = ctx.command.actorId;
      const state = runtime.state.entities[actorId];
      if (state === undefined) {
        throw new Error(`combat: unknown actor "${actorId}"`);
      }

      // 1. The named martial among the EQUIPPED list.
      const equipped = state.martial ?? [];
      const martialId = martialIdByName(runtime, equipped, String(ctx.args ?? ""));
      if (martialId === undefined) {
        return refuse(ctx, actorId, entry.id, NOT_EQUIPPED, "err_notEquipped");
      }

      // 2. Remove; an emptied slot DELETES itself — "equipped nothing" and
      //    "never had the slot" stay byte-identical (the combat slot's law).
      const remaining = equipped.filter((id) => id !== martialId);
      if (remaining.length === 0) {
        delete state.martial;
      } else {
        state.martial = remaining;
      }
      ctx.emit(actorId, customEvent(MARTIAL_UNEQUIPPED_EVENT, { martialId }));
    },
  });
}
