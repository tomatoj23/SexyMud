import { mergeCmdSets } from "./cmdset.js";
import type { CmdSetSource } from "./cmdset.js";
import { createVerbTable } from "./parser.js";
import type { VerbMatch, VerbTable } from "./parser.js";
import type { CommandSpec } from "./pipeline.js";

/**
 * The ONE "input → which spec" step (spec/04 §4.1): match the verb, look the
 * key up, bind the behaviour. Four copies of this knowledge used to spell it
 * out each its own way — the host's step 0 in front of the driver, a pack
 * session's dispatch loop, and two test drivers that scanned exits for an
 * EXACT verb (a degenerate match, off the engine's longest-match rule) —
 * with two different failure shapes between them. They all call this now.
 *
 * ⚠️ Two acts used to share the word "bind"; they are not one act, and the
 * split is the vocabulary (bindSpec / parseArgs, D1):
 *
 * - **binding the behaviour** (bindSpec) — turning the matched command key
 *   into an executable {@link CommandSpec} — is THIS module's job. One
 *   parameter face carries both binding forms (see {@link CommandBinding});
 *   the host curries whatever entry data a factory needs, so this function
 *   sees no content.
 * - **binding the arguments** (parseArgs) — parsing the raw arg string into
 *   `ctx.args` — stays in the pipeline's parse stage (spec/02 §1): it
 *   deliberately runs twice per command (pre-flight + real, so it must stay
 *   pure) and `spec.parse` custom hooks live there. This module never
 *   touches args; `match.rawArgs` is carried through untouched.
 *
 * Failure shape is ONE rule (D2): the player's typo — empty input, unknown
 * verb — is an `invalid` outcome carrying its reason code, and the caller
 * maps that to its own `invalid` result; the developer's wiring bug — a
 * matched key nobody bound behaviour to — throws loudly. The collected
 * copies inherit this classification instead of each inventing its own.
 */

/**
 * One command key's bound behaviour (bindSpec): an already-built
 * spec, or a thunk factory that builds one on the spot. The thunk form is
 * what keeps "build every spec for every verb" from happening — `resolve`
 * instantiates only the MATCHED key's binding (an exit's traversal adapter
 * costs a build per dispatch otherwise, and there are as many exits as the
 * room has).
 */
export type CommandBinding<W = unknown> = CommandSpec<W> | (() => CommandSpec<W>);

/**
 * Behaviour bound per dispatch key — `resolve`'s one parameter face for both
 * binding forms. A map, not a record: the host's own bookkeeping already is
 * one (`ReadonlyMap<string, CommandSpec>`), and a bare object would answer
 * `bindings[key]` with its prototype's members for keys like "constructor".
 */
export type Bindings<W = unknown> = ReadonlyMap<string, CommandBinding<W>>;

/**
 * The outcome of resolving an input. On success `match` is the matched verb
 * record (verb, dispatch key, and the WHOLE raw arg string) and `spec` is
 * the bound behaviour ready for the pipeline; on failure `reason` is the
 * match failure's own semantic code — a code, not rendered text: the caller
 * answers the player with its `invalid` result and words it (spec/01 §4).
 */
export type ResolveOutcome<W = unknown> =
  | { ok: true; match: Extract<VerbMatch, { ok: true }>; spec: CommandSpec<W> }
  | { ok: false; reason: Extract<VerbMatch, { ok: false }>["reason"] };

/**
 * Resolves one input against this dispatch's verb table: match → lookup →
 * bind the behaviour. Pure over its inputs — the table is per-dispatch (see
 * {@link verbTableFrom}), and nothing here advances or observes the world.
 */
export function resolve<W>(
  input: string,
  table: VerbTable,
  bindings: Bindings<W>,
): ResolveOutcome<W> {
  const match = table.match(input);
  if (!match.ok) {
    return { ok: false, reason: match.reason };
  }
  const bound = bindings.get(match.commandKey);
  if (bound === undefined) {
    // Wiring bug, not play: a verb routed to a key nobody bound behaviour
    // to. Loud, like every unbound seam here.
    throw new Error(
      `resolve: no spec bound to command key "${match.commandKey}" (verb "${match.verb}")`,
    );
  }
  return { ok: true, match, spec: typeof bound === "function" ? bound() : bound };
}

/**
 * The "sources → table" assembly chain — `mergeCmdSets` → `verbEntries()` →
 * `createVerbTable` — collected here so no caller re-copies the three links.
 * The SOURCE RECIPE stays with the caller (registry commands + this room's
 * exits, an entity's `assembleSources` output, a hand-built filter stack):
 * the engine knows no source vocabulary (spec/02 §3).
 *
 * Timing contract (spec/02 §3, spec/08): callers re-merge PER DISPATCH and
 * this function never caches — sources change with location and state, so a
 * table is assembled now and discarded after the dispatch (Evennia's
 * `_CMDSET_MERGE_CACHE` is a documented pitfall, not a feature to copy).
 */
export function verbTableFrom(sources: readonly CmdSetSource[]): VerbTable {
  return createVerbTable(mergeCmdSets(sources).verbEntries());
}
