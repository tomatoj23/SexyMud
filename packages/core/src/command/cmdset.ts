import type { VerbEntry } from "./parser.js";

/**
 * The cmdset merge stack (spec/02 §3, ADR-0021 §1).
 *
 * Available commands are never a fixed table: they are the per-dispatch
 * product of merging multiple sources — in the content pack's arrangement
 * session, player, character, inventory, room, objects and exits, or
 * anything else a host assembles. The engine provides ONLY the fold below;
 * source slots, priorities and mergetypes are content fields (hard standard
 * 1: a dark room that turns look into groping is one cmdset entry plus one
 * condition, zero engine changes).
 *
 * Semantics (Evennia's CmdSet fold, made total and deterministic):
 *
 * - Sources are stable-sorted by priority ASCENDING, then folded left onto
 *   an EMPTY accumulator. "Group by priority, merge pairwise within a
 *   group, then ascending across groups" (spec/02 §3) is exactly this fold:
 *   within one priority group the input order is the merge order, and the
 *   later source merges on top.
 * - The INCOMING source's mergetype applies to the accumulated result
 *   (Evennia: "A is merged onto B"; on a priority tie the incoming source
 *   wins). Seeding with empty keeps all four operators total — a lone
 *   Remove or Intersect set yields nothing, because its commands are a
 *   filter list, not an offering.
 * - Union (default): accumulated commands whose keys the incoming set does
 *   not carry, then the incoming commands. A same-key command is replaced
 *   WHOLE — the incoming entry's verbs are the entire payload.
 * - Intersect: only the incoming commands whose keys are already
 *   accumulated (the incoming versions).
 * - Replace: the accumulated result is discarded; only the incoming
 *   commands survive.
 * - Remove: the incoming set is a pure filter — accumulated commands whose
 *   keys it names are dropped, and nothing is added.
 * - Merged command order is the order of LAST INTRODUCTION, and verb
 *   collisions between different keys resolve to the later-merged command.
 *   The merge stack, not the verb table builder, decides which command owns
 *   a shared verb before dispatch (parser.ts contract). This is why a
 *   source at a priority above every other source (exits in the content
 *   pack) stays available: it merges last, so nothing below can shadow or
 *   filter its verbs away.
 *
 * Determinism (ADR-0024 §2): the fold has no hash-order or insertion-order
 * accidents — the same input list yields the same merged result across
 * processes. Hosts re-merge per input (sources change with location); the
 * engine keeps no cache (spec/08: Evennia's _CMDSET_MERGE_CACHE is a
 * documented pitfall, not a feature to copy).
 */

/** How one source merges onto the accumulated result (spec/02 §3). */
export type MergeType = "Union" | "Intersect" | "Replace" | "Remove";

const MERGE_TYPES: readonly MergeType[] = ["Union", "Intersect", "Replace", "Remove"];

/**
 * A command as a cmdset member: the spec key it dispatches plus the verbs
 * it offers. `verbs` may be omitted by filter-only sets (Remove needs none).
 * Payloads are replaced whole — a same-key command from a later source wins
 * with ALL of its verbs.
 */
export interface CmdSetCommand {
  key: string;
  verbs?: readonly string[];
}

/**
 * One source in the merge stack: its merge rules plus the commands it
 * offers. Priorities and mergetypes are content data; the engine has no
 * source-kind vocabulary and no magic numbers.
 */
export interface CmdSetSource {
  /** Integer. Ascending merge order: higher merges later, on top. */
  priority: number;
  /** Defaults to "Union". */
  mergetype?: MergeType;
  commands: readonly CmdSetCommand[];
}

/** The merge product: surviving commands in merge order. */
export interface MergedCmdSet {
  /** Surviving commands, ordered by last introduction (module doc). */
  readonly commands: readonly CmdSetCommand[];
  /**
   * The available-verb view — the verb table source for dispatch
   * (spec/02 §3): one entry per verb, colliding verbs owned by the
   * later-merged command. Feed to createVerbTable.
   */
  verbEntries(): readonly VerbEntry[];
}

/** A validated command: key trimmed, verbs trimmed and deduped. */
interface NormalizedCommand {
  key: string;
  verbs: readonly string[];
}

/** A validated source: merge rules checked, commands collapsed by key. */
interface NormalizedSource {
  priority: number;
  mergetype: MergeType;
  commands: readonly NormalizedCommand[];
}

/** The command keys of a list, for the membership tests the merges need. */
function keysOf(commands: readonly NormalizedCommand[]): Set<string> {
  return new Set(commands.map((command) => command.key));
}

/**
 * Validates one source and collapses same-key commands within it (the last
 * entry replaces the earlier one — Evennia's CmdSet.add() semantics).
 * Validation is unconditional: even a set the fold would discard is
 * checked, so content wiring bugs fail loudly at merge, not at dispatch.
 */
function normalizeSource(index: number, source: CmdSetSource): NormalizedSource {
  if (!Number.isSafeInteger(source.priority)) {
    throw new Error(
      `cmdset source ${index}: priority must be a safe integer, got ${String(source.priority)}`,
    );
  }
  const mergetype = source.mergetype ?? "Union";
  if (!MERGE_TYPES.includes(mergetype)) {
    throw new Error(
      `cmdset source ${index}: unknown mergetype ${JSON.stringify(source.mergetype)} (expected one of ${MERGE_TYPES.join(", ")})`,
    );
  }

  const byKey = new Map<string, NormalizedCommand>();
  for (const command of source.commands) {
    const key = command.key.trim();
    if (key === "") {
      throw new Error(`cmdset source ${index}: command with an empty key`);
    }
    const verbs: string[] = [];
    for (const verb of command.verbs ?? []) {
      const trimmed = verb.trim();
      if (trimmed === "") {
        throw new Error(`cmdset source ${index}: command "${key}" has an empty verb`);
      }
      if (!verbs.includes(trimmed)) {
        verbs.push(trimmed);
      }
    }
    byKey.set(key, { key, verbs });
  }
  return { priority: source.priority, mergetype, commands: [...byKey.values()] };
}

/**
 * Applies the incoming source's mergetype to the accumulated result. `acc`
 * is the fold so far (lower priorities / earlier input), `incoming` the
 * source being merged on top.
 */
function applyMerge(
  acc: readonly NormalizedCommand[],
  incoming: readonly NormalizedCommand[],
  mergetype: MergeType,
): NormalizedCommand[] {
  switch (mergetype) {
    case "Union": {
      const incomingKeys = keysOf(incoming);
      return [...acc.filter((command) => !incomingKeys.has(command.key)), ...incoming];
    }
    case "Intersect": {
      const accKeys = keysOf(acc);
      return incoming.filter((command) => accKeys.has(command.key));
    }
    case "Replace":
      return [...incoming];
    case "Remove": {
      const removedKeys = keysOf(incoming);
      return acc.filter((command) => !removedKeys.has(command.key));
    }
  }
}

/**
 * Merges command-set sources into the available commands (spec/02 §3).
 * Pure and deterministic: the same input list always yields the same merge.
 */
export function mergeCmdSets(sources: readonly CmdSetSource[]): MergedCmdSet {
  const normalized = sources.map((source, index) => normalizeSource(index, source));
  // Stable ascending sort: same-priority sources keep input order and fold
  // pairwise — the fold IS "group by priority, merge within group, then
  // merge the groups ascending".
  const ordered = [...normalized].sort((a, b) => a.priority - b.priority);

  let acc: NormalizedCommand[] = [];
  for (const source of ordered) {
    acc = applyMerge(acc, source.commands, source.mergetype);
  }

  const commands: readonly NormalizedCommand[] = acc;
  return {
    commands,
    verbEntries(): readonly VerbEntry[] {
      // First-appearance order, last-writer values: the later-merged
      // command owns a colliding verb (module doc).
      const byVerb = new Map<string, string>();
      for (const command of commands) {
        for (const verb of command.verbs) {
          byVerb.set(verb, command.key);
        }
      }
      return [...byVerb].map(([verb, commandKey]) => ({ verb, commandKey }));
    },
  };
}
