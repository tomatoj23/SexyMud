import type { TargetRef } from "../command/parser.js";
import type { ContentRegistry } from "../content/registry.js";
import type { NpcEntry } from "./entry.js";

/**
 * NPC target resolution (#56, ADR-0028 §2's reserved seat): turning a parsed
 * {@link TargetRef} — a written noun and an ordinal, FORM only — into the
 * npc entry it names among one room's STATIC PRESENCE. The parser never
 * resolved anything (ADR-0016: form parsing there, semantics in the
 * command's target-resolution rules); the strike command ("hit <name>") is
 * this module's first consumer, the reason the seat was reserved.
 *
 * Resolution reads the room's placement list direct — NPCs are static
 * presence and have no tree row (ADR-0028 §1), so "who is here" is content
 * truth, not state truth. A placement may name a MONSTER (or a future item
 * kind), not an npc: those rows simply do not match, the way a noun that
 * names nobody does not match.
 */

/** Why a resolution failed — semantic codes the refusing command words. */
export type TargetFailure = "noMatch" | "notCombatant";

/**
 * One resolution's outcome: the npc entry the noun names (ordinal-selected
 * among the room's placements whose npc is named so), or the failure code.
 * `notCombatant` is resolution SUCCEEDING at the person and failing at the
 * fight: the npc declares no monsterId, so there is nothing to strike —
 * a different refusal from "nobody by that name here".
 */
export type NpcTargetResolution =
  | { ok: true; npc: NpcEntry }
  | { ok: false; reason: TargetFailure };

export function resolveNpcTarget(
  registry: ContentRegistry,
  roomId: string,
  ref: TargetRef,
): NpcTargetResolution {
  const room = registry.room(roomId);
  const matches: NpcEntry[] = [];
  for (const placement of room.objects ?? []) {
    // A placement row may name any placeable entity; only npc rows can match
    // a strike's noun, and an unknown-to-npcs id is a monster's (or a future
    // kind's) row — skipped, not an error.
    const npc = registry.npcs.find((candidate) => candidate.id === placement.id);
    if (npc !== undefined && npc.name === ref.noun) {
      matches.push(npc);
    }
  }
  if (matches.length === 0) {
    return { ok: false, reason: "noMatch" };
  }
  // The ordinal is 1-based and the parser already bounded it (parser.ts's
  // numerals); an out-of-range ordinal over real placements is a MISS, not
  // a wiring bug — the same answer a shorter room would give.
  const chosen = matches[ref.ordinal - 1];
  if (chosen === undefined) {
    return { ok: false, reason: "noMatch" };
  }
  if (chosen.monsterId === undefined) {
    return { ok: false, reason: "notCombatant" };
  }
  return { ok: true, npc: chosen };
}
