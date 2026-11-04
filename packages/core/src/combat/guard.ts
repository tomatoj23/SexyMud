import type { CommandEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import { commandRefusedEvent, customCode } from "../events.js";
import type { ReasonCode } from "../types.js";
import type { WorldRuntime } from "../world/runtime.js";

/**
 * The declarative in-combat gate (#57 D7, AC8): wrap a command spec whose
 * entry declares `notInCombat: true`, and its execution stage refuses
 * mid-fight — the CommandRejection + err_* precedent, the field's own
 * `err_inCombat` copy wording it. The GATE TABLE travels with the content
 * pack (the entry data), because a hardcoded engine table would break the
 * engine/content line — the rejected alternative this wrapper exists to
 * avoid. An entry without the field wraps to itself: absent means allowed.
 *
 * The wrapper is WorldRuntime-shaped on purpose: reading the combat slot is
 * a world capability the generic pipeline cannot have (its `W` is opaque).
 * Hosts wire it at the binding table, beside their factory adapters.
 */

/** The refusal code the gate and the strike adapter's same-target branch share. */
export const IN_COMBAT: ReasonCode = customCode("inCombat");

/**
 * Words one execution-stage refusal — the semantic event plus the rejection
 * — the shape every combat adapter's own refusal faces share (the strike
 * adapter's C2 original, the perform and equip adapters' #58 siblings).
 */
export function refuseExecutionStage(
  ctx: { emit(recipientId: string, draft: { type: string; [key: string]: unknown }): void },
  actorId: string,
  entryId: string,
  reason: ReasonCode,
  errKey: string,
): CommandRejection {
  ctx.emit(actorId, commandRefusedEvent({ reason, commandKey: entryId, errKey }));
  return { kind: "rejected", reason };
}

export function guardNotInCombat<W extends WorldRuntime>(
  entry: CommandEntry,
  spec: CommandSpec<W>,
): CommandSpec<W> {
  if (entry.notInCombat !== true) {
    return spec;
  }
  return {
    ...spec,
    func: (ctx) => {
      const state = ctx.world.state.entities[ctx.command.actorId];
      if (state?.combat !== undefined) {
        ctx.emit(
          ctx.command.actorId,
          commandRefusedEvent({
            reason: IN_COMBAT,
            commandKey: entry.id,
            errKey: "err_inCombat",
          }),
        );
        return { kind: "rejected", reason: IN_COMBAT };
      }
      return spec.func(ctx);
    },
  };
}
