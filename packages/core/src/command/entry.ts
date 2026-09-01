import type { AccessRules } from "../conditions.js";
import type { CommandContext, CommandRejection, CommandSpec } from "./pipeline.js";
import type { ArgForm } from "./parser.js";
import type { CmdSetSource } from "./cmdset.js";
import type { MergeType } from "./cmdset.js";

/**
 * A command as CONTENT data (spec/02 §2): everything a command entry file
 * under content/commands/ carries. The engine knows this SHAPE and nothing
 * about any particular command — verbs, their language, which set a command
 * belongs to and how it merges are all data, which is why adding a command
 * means adding a JSON file, never touching engine code (hard standard 1).
 *
 * Three-way sync (spec/06 §4): this type mirrors schemas/commands.schema.json
 * field-for-field, and docs/agents/content.md documents the field contract
 * for content authors. Changing one means changing all three.
 *
 * The entry is the DECLARATION; the executable half is attached by the host
 * through commandSpecFromEntry() (func) — the engine pipeline consumes
 * CommandSpec, not entries.
 */
export interface CommandEntry {
  /**
   * The content id AND the dispatch key: cmdset members reference it,
   * the verb table maps verbs onto it, CommandSpec.key carries it. ids are
   * immutable once released (asset paths and save references depend on them).
   */
  readonly id: string;
  /**
   * The verbs that trigger this command, Chinese and English abbreviations
   * side by side (spec/02 §2). Verbs are the content-layer alias tier; the
   * player-layer tier lives in saves, not here (spec/02 §6).
   */
  readonly verbs: readonly string[];
  /** How the parse stage shapes the arg string (spec/02 §1.2). */
  readonly argForm: ArgForm;
  /**
   * Which command set (merge source) this command belongs to. Source names
   * are a content-pack convention (the seven-source arrangement of spec/02
   * §3 — session, player, character, ... — is one pack's choice, not engine
   * vocabulary).
   */
  readonly cmdset: string;
  /**
   * The set's merge priority (spec/02 §3): ascending merge order, higher
   * merges later, on top. Merge rules belong to the SET, so every entry of
   * one cmdset must declare the same pair — commandSetSources() enforces
   * that at assembly time.
   */
  readonly priority: number;
  /** The set's merge operator; defaults to "Union". */
  readonly mergetype?: MergeType;
  /**
   * Access gate map (spec/02 §5): accessType → condition expression, with
   * `default` evaluated for accessTypes with no expression. Omitted means
   * no gate at all. Which accessType a command dispatch asks ("use" per the
   * content pack's convention) is supplied by the host when building the
   * spec — the vocabulary is content-side, the engine carries it through.
   */
  readonly preconditions?: AccessRules;
  /**
   * Refusal copy, keyed `err_<accessType>` and `err_default` (spec/02 §5.4):
   * refusal is narrative, so the DATA words it — the engine's refusal event
   * only carries the errKey that locates these fields. Omitted keys fall
   * back to the renderer's generic copy.
   */
  readonly [errKey: `err_${string}`]: string | undefined;
}

/**
 * Groups command entries into cmdset merge sources (spec/02 §3): every entry
 * of one cmdset becomes that source's command payload, in input order.
 * Exits group through here unchanged (each room's exits are one such list —
 * an exit IS a command whose cmdset, per the pack's convention, sits above
 * every regular source).
 *
 * Merge rules belong to the command set, not to a single command, so entries
 * sharing a cmdset must agree on priority and mergetype (an explicit "Union"
 * and an omitted mergetype agree). Disagreement is a content wiring bug and
 * throws loudly — quietly picking one side would make the other a lie.
 *
 * Source order is FIRST APPEARANCE in the input; mergeCmdSets then
 * stable-sorts by priority, so same-priority sources merge in this order.
 * Feed registry.commands (id-ascending) for a deterministic result, or a
 * hand-ordered list when the host controls same-priority order on purpose.
 * Dynamic filter sets (a dark room suppressing verbs, Remove/Intersect) are
 * assembled by the host from world state — this function only folds standing
 * entries into sources.
 */
/** Shared tail of the two consistency errors below: the rule being broken. */
const SET_RULES_MESSAGE =
  " — merge rules belong to the set, so every entry of one cmdset " +
  "must declare the same priority and mergetype";

export function commandSetSources(entries: readonly CommandEntry[]): CmdSetSource[] {
  interface Group {
    priority: number;
    mergetype: MergeType;
    commands: CommandEntry[];
  }
  const groups = new Map<string, Group>();

  for (const entry of entries) {
    const mergetype = entry.mergetype ?? "Union";
    const existing = groups.get(entry.cmdset);
    if (existing === undefined) {
      groups.set(entry.cmdset, {
        priority: entry.priority,
        mergetype,
        commands: [entry],
      });
      continue;
    }
    if (entry.priority !== existing.priority) {
      throw new Error(
        `cmdset "${entry.cmdset}": entries declare conflicting priorities ` +
          `(${existing.priority} and ${entry.priority})${SET_RULES_MESSAGE}`,
      );
    }
    if (mergetype !== existing.mergetype) {
      throw new Error(
        `cmdset "${entry.cmdset}": entries declare conflicting mergetypes ` +
          `("${existing.mergetype}" and "${mergetype}")${SET_RULES_MESSAGE}`,
      );
    }
    existing.commands.push(entry);
  }

  return [...groups.entries()].map(([cmdset, group]) => ({
    priority: group.priority,
    mergetype: group.mergetype,
    commands: group.commands.map((entry) => ({ key: entry.id, verbs: entry.verbs })),
  }));
}

/** What a host attaches to a content command to make it executable. */
export interface CommandSpecOptions<W = unknown> {
  /**
   * The accessType dispatch asks of the entry's preconditions (spec/02
   * §5.2). The vocabulary is content-side (content.md: commands gate "use"),
   * so the caller supplies it — the engine carries it through, it does not
   * own it. Required when the entry declares preconditions.
   */
  accessType?: string;
  /**
   * The command's behaviour. The engine never words game output itself; func
   * emits semantic events through the context. (A future effects pipeline
   * will resolve behaviour from content references — until then hosts bind
   * behaviour per command key, or bind the engine's factory adapters:
   * traversalSpec for exits.) May return a CommandRejection when the
   * execution legitimately refused — same contract as CommandSpec.func.
   */
  func(ctx: CommandContext<W>): void | CommandRejection;
}

/**
 * Builds the pipeline-facing spec from a content entry: id becomes the
 * dispatch key, argForm drives the parse stage, preconditions become the
 * access gate checked before at_pre_cmd (spec/02 §5.5).
 *
 * Exits flow through here too (spec/02 §4): an exit IS a command — ExitEntry
 * extends CommandEntry — so the same adapter assembles it, with the host
 * asking the exit collection's accessType ("traverse" per content.md) and
 * injecting the traversal behaviour.
 *
 * The behaviour half (func) is injected: an entry alone is data, not
 * executable. Hosts needing the other pipeline hooks (at_pre_cmd, custom
 * parse, at_post_cmd) spread the returned spec and add them.
 */
export function commandSpecFromEntry<W>(
  entry: CommandEntry,
  options: CommandSpecOptions<W>,
): CommandSpec<W> {
  const spec: CommandSpec<W> = {
    key: entry.id,
    argForm: entry.argForm,
    func: options.func,
  };
  if (entry.preconditions !== undefined) {
    if (options.accessType === undefined || options.accessType === "") {
      // Wiring bug, not player input: a declared gate is unevaluable when
      // nothing says which accessType to ask of it — fail loudly instead of
      // silently granting or denying.
      throw new Error(
        `command "${entry.id}" declares preconditions but no accessType was given to ask of them`,
      );
    }
    spec.access = { rules: entry.preconditions, accessType: options.accessType };
  }
  return spec;
}
