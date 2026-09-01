import type { CommandEntry } from "../command/entry.js";

/**
 * The content registry (spec/00, ADR-0003): the single channel through which
 * the engine reads game content.
 *
 * The engine NEVER imports content data — no module under src/ touches a
 * content/ file. Hosts (and tests playing the host role) load and parse the
 * JSON themselves, then hand the entries to the registry. What the registry
 * adds is load-time referential integrity (ADR-0003's division of labour):
 * duplicate ids and unknown id lookups throw loudly, so a broken content set
 * fails at startup rather than at some player's command. Full shape
 * validation is NOT repeated here — that is content:check's job (the offline
 * schema gate); a host assembling data that bypassed it gets loud failures
 * from the consumers (verb table, cmdset merge, condition evaluator) anyway.
 *
 * Collections are additive: commands arrived with M1-T5; rooms, npcs and the
 * other collections join this registry as they land.
 */

/** The read side of loaded content: lookups over validated collections. */
export interface ContentRegistry {
  /**
   * Every command entry, id-ascending. Canonical order makes downstream
   * assembly (cmdset grouping, verb tables) deterministic across processes
   * (ADR-0024 §2) no matter what order the host loaded files in.
   */
  readonly commands: readonly CommandEntry[];
  /**
   * One command by id. Unknown ids throw — a dangling command reference is
   * a broken content set, and "fail loudly at load" beats "silently missing
   * command at dispatch" (ADR-0003).
   */
  command(id: string): CommandEntry;
}

/**
 * Builds a registry from loaded entries. Duplicate command ids throw: two
 * files claiming one id disagree about what that command IS, and every save
 * and cmdset referencing the id depends on it being one thing.
 */
export function createContentRegistry(content: {
  commands: readonly CommandEntry[];
}): ContentRegistry {
  const byId = new Map<string, CommandEntry>();
  for (const entry of content.commands) {
    if (typeof entry.id !== "string" || entry.id === "") {
      throw new Error("content registry: command entry with an empty id");
    }
    if (byId.has(entry.id)) {
      throw new Error(`content registry: duplicate command id "${entry.id}"`);
    }
    byId.set(entry.id, entry);
  }

  const commands = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    commands,
    command(id) {
      const found = byId.get(id);
      if (found === undefined) {
        throw new Error(`content registry: unknown command id "${id}"`);
      }
      return found;
    },
  };
}
