import { checkAccess } from "../conditions.js";
import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import type { ExitEntry } from "./entry.js";
import { moveTo } from "./move.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The engine's factory traversal adapter (ADR-0028 §2/§3): walking an exit
 * is a KERNEL behaviour, shipped by the engine, driven by the world runtime
 * and the content registry — a host binds this as the exit's func and a
 * minimal world needs zero host-side game code. The M1 stopgap (hosts
 * injecting behaviour per command key) stays available: the injection seam
 * is commandSpecFromEntry's func option, and a host with special behaviour
 * still overrides this adapter with its own.
 *
 * The orchestration order is fixed (ADR-0028 §3):
 *
 *   exit traverse gate  — the entry's own preconditions, checked by the
 *                         pipeline's access stage (spec.access below)
 *   target room enter gate — the ROOM's preconditions, checked here through
 *                         the same access pipeline, before moveTo
 *   moveTo("traverse") — pure hook chain, zero permission checks
 *
 * Both gate refusals are `rejected` results whose events carry the
 * semantics that LOCATE the refusal copy: commandKey (the exit) and errKey
 * for the traverse gate, plus roomId (the room whose gate denied) for the
 * enter gate. The engine never words a refusal — the renderer reads the
 * err_* field from the named entry's data (spec/02 §5.4).
 *
 * The two accessType literals are the world collections' fixed vocabulary,
 * pinned by the living spec — exits gate "traverse" (spec/02 §4.1), rooms
 * gate "enter" (spec/03 §2) — the same way "teleport/traverse/get/give/
 * drop" are engine semantics. They are not theme vocabulary, and no
 * content-pack knob redefines them.
 */
export function traversalSpec(exit: ExitEntry): CommandSpec<WorldRuntime> {
  return commandSpecFromEntry<WorldRuntime>(exit, {
    accessType: "traverse",
    func: (ctx) => {
      const runtime = ctx.world;
      const actorId = ctx.command.actorId;
      const targetRoomId = exit.targetRoomId;

      const room = runtime.registry.room(targetRoomId);
      if (room.preconditions !== undefined) {
        const check = checkAccess(
          room.preconditions,
          "enter",
          runtime.subjectOf(actorId),
          ctx.predicates,
        );
        if (!check.ok) {
          ctx.emit(actorId, {
            type: "commandRefused",
            reason: "accessDenied",
            commandKey: exit.id,
            accessType: check.accessType,
            errKey: check.errKey,
            roomId: room.id,
          });
          const rejection: CommandRejection = { kind: "rejected", reason: "accessDenied" };
          return rejection;
        }
      }

      const move = moveTo(
        runtime,
        {
          entityId: actorId,
          toLocationId: targetRoomId,
          moveType: "traverse",
          viaExitId: exit.id,
        },
        { emit: ctx.emit },
      );
      if (!move.ok) {
        // A movement hook vetoed (spec/03 §7: an explicit false aborts).
        // The refusal is semantic — stage names the hook, commandKey names
        // the exit — and the move never happened.
        ctx.emit(actorId, {
          type: "commandRefused",
          reason: "moveVetoed",
          commandKey: exit.id,
          stage: move.stage,
        });
        return { kind: "rejected", reason: "moveVetoed" };
      }
    },
  });
}
