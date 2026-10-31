import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandSpec } from "../command/pipeline.js";
import { customEvent } from "../events.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The flag-granting factory adapter (#56's T1 route): a command whose whole
 * behaviour is "the actor now carries this flag" — a lodge check-in, a guild
 * oath, whatever a pack words. The engine's traversal/look/say/strike
 * siblings in spirit (kernel behaviour, content-driven), and deliberately
 * GENERIC: the flag is a parameter the binding table carries, so the engine
 * names no flag — the table travels with the pack.
 *
 * The grant is IDEMPOTENT (a second check-in adds no second flag) and
 * announces itself as a `flagGranted` extension event — the C1 rendering seam
 * renders the engine's eight arms only (T7), so the HOST consumes this one
 * at the session layer and words it from its own copy table, the enterText
 * precedent's family (a host-authored line, straight from host data).
 */
export function grantFlagSpec(entry: CommandEntry, flag: string): CommandSpec<WorldRuntime> {
  if (flag === "") {
    // Wiring bug, not play: an empty flag is nobody's word.
    throw new Error(`flag grant: command "${entry.id}" was bound with an empty flag`);
  }
  return commandSpecFromEntry<WorldRuntime>(entry, {
    func: (ctx) => {
      const state = ctx.world.state.entities[ctx.command.actorId];
      if (state === undefined) {
        throw new Error(`flag grant: unknown actor "${ctx.command.actorId}"`);
      }
      if (!state.flags.includes(flag)) {
        state.flags.push(flag);
      }
      ctx.emit(ctx.command.actorId, customEvent("flagGranted", { flag }));
    },
  });
}
