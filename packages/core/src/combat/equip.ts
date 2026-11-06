import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandSpec } from "../command/pipeline.js";
import { customCode, customEvent } from "../events.js";
import type { ReasonCode } from "../types.js";
import type { WorldRuntime } from "../world/runtime.js";
import { refuseExecutionStage } from "./guard.js";
import { slotKindOf } from "./mental.js";

/**
 * The equip and unequip commands (#58 D13, #59 D12): out-of-combat management
 * of the two equipment slots, TWO entries because the two verbs are opposites
 * no one argForm path could tell apart (the ticket's own ruling). The
 * engine's laws: the per-slot caps (4 techniques / 3 mentals — the assembly
 * breadth each slot's own), the known-list membership (learning is content's,
 * D2), and the martial slot's ORDER as the wheel's priority — equipping
 * APPENDS, unequipping REMOVES, and the reorder path is the pair of them
 * (unequip then equip again: no silent reordering face). The mental slot's
 * order carries no meaning (every member always on), so it needs no order
 * face at all. Both entries declare `notInCombat` in content and ride the
 * engine's guard wrapper at the binding table — the mental half inherits the
 * same gate by riding the same entry (C4-T3).
 *
 * #59 D12: ONE verb pair routes BOTH kinds — `jifa` equips a technique to
 * the hand or a mental to the breath, exactly as the xkx corpus's own jifa
 * does (a verb that never distinguished the two). The ENTRY's kind word
 * decides the slot; the error faces are shared verbatim (err_* for
 * not-learned, already-on, slot-full — the codes one family, the wording
 * kind-neutral).
 *
 * Success rides the customEvent precedent (combatEscape, flagGranted): the
 * event is semantic (the id), the words are the host's. The mental pair
 * carries its OWN event types (the twin-key law: an independent key, not an
 * optional slot on the martial's) with the same payload field name — the id
 * is a martial-collection id either way.
 */

/** The success events' extension-arm types: the host words all four. */
export const MARTIAL_EQUIPPED_EVENT = "martialEquipped";
export const MARTIAL_UNEQUIPPED_EVENT = "martialUnequipped";
/** The mental pair's own arms (#59 D12): twin keys, independent not optional. */
export const MENTAL_EQUIPPED_EVENT = "mentalEquipped";
export const MENTAL_UNEQUIPPED_EVENT = "mentalUnequipped";

/** The assembly caps (#58 D13, #59 D12): each slot's breadth, its own law. */
export const MARTIAL_SLOT_CAP = 4;
export const MENTAL_SLOT_CAP = 3;

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
 * name-taking commands answer one matcher, never three.
 */
export function martialIdByName(
  runtime: WorldRuntime,
  ids: readonly string[],
  name: string,
): string | undefined {
  return ids.find((id) => runtime.registry.martial(id).name === name);
}

/** One actor's learnable ids: the techniques first, then the mentals (#59 D12). */
function learnableIds(runtime: WorldRuntime): string[] {
  const character = runtime.registry.character;
  return [...(character?.martial?.known ?? []), ...(character?.mental?.known ?? [])];
}

/** One actor's equipped ids across BOTH slots: the wheel's list, then the breath's. */
function equippedIds(runtime: WorldRuntime, actorId: string): string[] {
  const state = runtime.state.entities[actorId]!;
  return [...(state.martial ?? []), ...(state.mental ?? [])];
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
      // 1. The named martial must be LEARNED (D2: the known lists are the
      //    content-declared truth — an unknown name and an unlearned one are
      //    the same refusal face, the minimal cut). #59: both kinds' lists
      //    answer one match — the kind decides the SLOT, not the verb.
      const martialId = martialIdByName(runtime, learnableIds(runtime), String(ctx.args ?? ""));
      if (martialId === undefined) {
        return refuse(ctx, actorId, entry.id, NOT_LEARNED, "err_notLearned");
      }

      // 2. The entry's FACE routes the slot (#59 D12 — the kind word is
      //    content vocabulary; the engine reads the shape it promises): an
      //    effect chain to the wheel's priority list, a modifiers list to
      //    the breath's passive one. An entry owning both faces or neither
      //    is drift and fails loudly right here (slotKindOf's throw).
      const kind = slotKindOf(runtime.registry.martial(martialId));

      // 3. Not already on (the reorder path is unequip-then-equip, no
      //    silent move-to-end face); under the slot's OWN cap.
      if (kind === "mental") {
        const equipped = state.mental ?? [];
        if (equipped.includes(martialId)) {
          return refuse(ctx, actorId, entry.id, ALREADY_EQUIPPED, "err_alreadyEquipped");
        }
        if (equipped.length >= MENTAL_SLOT_CAP) {
          return refuse(ctx, actorId, entry.id, SLOT_FULL, "err_martialSlotFull");
        }
        state.mental = [...equipped, martialId];
        ctx.emit(actorId, customEvent(MENTAL_EQUIPPED_EVENT, { martialId }));
        return;
      }
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

      // 1. The named martial among BOTH equipped lists (#59 D12) — the
      //    wheel's own order first, the breath's after it.
      const martialId = martialIdByName(
        runtime,
        equippedIds(runtime, actorId),
        String(ctx.args ?? ""),
      );
      if (martialId === undefined) {
        return refuse(ctx, actorId, entry.id, NOT_EQUIPPED, "err_notEquipped");
      }
      const kind = slotKindOf(runtime.registry.martial(martialId));

      // 2. Remove; an emptied slot DELETES itself — "equipped nothing" and
      //    "never had the slot" stay byte-identical (the combat slot's law,
      //    both slots' law now).
      if (kind === "mental") {
        const remaining = (state.mental ?? []).filter((id) => id !== martialId);
        if (remaining.length === 0) {
          delete state.mental;
        } else {
          state.mental = remaining;
        }
        ctx.emit(actorId, customEvent(MENTAL_UNEQUIPPED_EVENT, { martialId }));
        return;
      }
      const remaining = (state.martial ?? []).filter((id) => id !== martialId);
      if (remaining.length === 0) {
        delete state.martial;
      } else {
        state.martial = remaining;
      }
      ctx.emit(actorId, customEvent(MARTIAL_UNEQUIPPED_EVENT, { martialId }));
    },
  });
}
