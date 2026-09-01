import type { CmdSetSource } from "../command/cmdset.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The dynamic cmdset seam (spec/03 §7.9, Evennia's at_cmdset_get, M2-T4):
 * assembleSources is the ONE entry point through which a host asks "what can
 * this entity do RIGHT NOW?" — the base sources it assembled (content
 * commands, this room's exits), passed through the entity's at_cmdset_get
 * with the entity's live state in hand.
 *
 * The timing is the contract: sources are assembled PER DISPATCH, never
 * cached (Evennia's _CMDSET_MERGE_CACHE is a documented pitfall, spec/08).
 * An entity's state changes — a silence lands, a stun, a granted power — and
 * the very next dispatch's action set reflects it, because the next
 * dispatch asks again. Division of labour:
 *
 *   the host          assembles the base sources (registry + location)
 *   at_cmdset_get     adjusts them through the entity's state lens
 *   mergeCmdSets      folds the adjusted sources (command/cmdset.ts — the
 *                     pure merge; this module is the entity-state-driven
 *                     assembly that FEEDS it)
 *
 * A void return (or no hook at all) passes the base sources through
 * untouched — same reference, not a copy — so a hookless entity costs
 * nothing.
 */

/**
 * Assembles the sources for one entity's next dispatch: the host's base
 * sources, adjusted (or not) by the entity's at_cmdset_get against its live
 * tree state. Both context views are defensive copies — the state view
 * (flags, location: the hook may read its entity's state but not mutate the
 * tree through this seam) and the sources view (the hook adjusts by
 * RETURNING; an in-place mutation of ctx.sources reaches only the copy, never
 * the host's assembled base — the same constructive-guarantee stance the
 * input-hardening design takes, over an honor system). Adjustment happens by
 * return value only.
 *
 * The sources copy is TWO levels deep — the source list and each source's
 * command list — which blocks every structural mutation (adding, removing,
 * replacing sources or commands). The command records themselves ({key,
 * verbs}) are treated as immutable values and shared by reference, exactly
 * as every other hook context treats its payloads (the drafts, the move):
 * their readonly TYPES are the compile-time guard, and a hook that casts
 * them away to mutate fields is past what any seam here defends against.
 */
export function assembleSources(
  runtime: WorldRuntime,
  entityId: string,
  sources: readonly CmdSetSource[],
): readonly CmdSetSource[] {
  const entity = runtime.entity(entityId);
  const state = runtime.state.entities[entityId];
  if (state === undefined) {
    // Defensive symmetry with moveTo: entity() resolved, so a missing tree
    // state means the halves diverged — a wiring bug, not play.
    throw new Error(`assembleSources: entity "${entityId}" has no state in the tree`);
  }

  const adjusted = entity.at_cmdset_get?.({
    entityId,
    locationId: state.locationId,
    flags: [...state.flags],
    sources: sources.map((source) => ({ ...source, commands: [...source.commands] })),
  });
  return adjusted ?? sources;
}
