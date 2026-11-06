import type { ContentRegistry, MartialEntry, ModifierDecl } from "../content/registry.js";
import type { Modifier } from "../effects/modifiers.js";
import type { EntityState, WorldState } from "../state/tree.js";

/**
 * The MENTAL half of the martial collection (#59): the entry-face routing,
 * the equipped mentals' modifier supply, and the mental slot's load-point
 * validation. A mental is a martial-kind entry that never produces a hand —
 * its declared `modifiers` ride the player's stat reads instead, the
 * pipeline's FIRST REAL MEMBERS (ADR-0005's two-layer core leaves its empty
 * degenerate form here; the aggregation itself, `(base + Σ flats) × (1 + Σ
 * percents)` floored at 0, is unchanged — the members are new, the pipe is
 * not).
 *
 * The five consumer reads that walk the pipe (D11's closed list): attack
 * (the player hand's strike operand), defense and dodge (the npc hand's
 * operands off the player's attrs), maxHp and maxInternalForce (every
 * ceiling/denominator/refill read). The DoT mount's perTick freeze
 * (primitives.ts) is deliberately NOT a sixth — it freezes an effect entry's
 * content number at application time (C1-T11②'s own ruling), it does not
 * read a player attr.
 */

/**
 * The equip pair's face routing (#59 D9/D12): which slot an entry's id
 * belongs to, read off the entry's own SHAPE — an effect chain names a
 * technique (the wheel's slot), a modifier list names a mental (the breath's
 * slot). The schema's if/then pins the same exclusivity by the kind word
 * (kind is CONTENT vocabulary — the engine writes no word list, the
 * faceDefenseOf precedent's lesson inverted: shape, not spelling). Both
 * faces or neither is a drift the content gate should have caught — it
 * fails loudly here.
 */
export function slotKindOf(entry: MartialEntry): "martial" | "mental" {
  const hasEffects = entry.effects !== undefined;
  const hasModifiers = entry.modifiers !== undefined;
  if (hasEffects && !hasModifiers) {
    return "martial";
  }
  if (hasModifiers && !hasEffects) {
    return "mental";
  }
  throw new Error(
    `combat: martial "${entry.id}" carries ${hasEffects ? "both an effect chain and stat modifiers" : "neither an effect chain nor stat modifiers"} — an entry owns exactly one face (a technique's effects or a mental's modifiers, #59 D9)`,
  );
}

/** A declared number read loudly — content that bypassed the schema fails here, not as a NaN downstream. */
function finiteOf(value: unknown, what: string, id: string, stat: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `combat: mental "${id}" declares ${what} on stat "${stat}" that is not a finite number (#59 D10)`,
    );
  }
  return value;
}

/**
 * One declared row to its pipeline shape(s) — flat/percent's first real
 * construction (D10). A row carrying BOTH layers answers BOTH members: two
 * layers of one declaration pile into the same aggregate exactly as two
 * content rows would.
 */
function membersOf(decl: ModifierDecl, id: string): readonly Modifier[] {
  const members: Modifier[] = [];
  if (decl.flat !== undefined) {
    members.push({ kind: "flat", value: finiteOf(decl.flat, "a flat", id, decl.stat) });
  }
  if (decl.percent !== undefined) {
    members.push({ kind: "percent", value: finiteOf(decl.percent, "a percent", id, decl.stat) });
  }
  if (members.length === 0) {
    throw new Error(
      `combat: mental "${id}" declares a modifier on stat "${String(decl.stat)}" with neither flat nor percent — an empty member is content drift (#59 D10)`,
    );
  }
  return members;
}

/**
 * The equipped mentals' whole supply, GROUPED BY STAT KEY (D10): every
 * equipped mental's declared members, keyed by the stat they widen, in the
 * slot's own order. Computed per call — a slot of at most 3 entries has no
 * caching problem, and equipping/unequipping takes effect on the very next
 * read (D11: a strike's attack answers what is equipped when it lands).
 *
 * An entry found here without a mental's face is the late assertion (the
 * load point validated this already; a drift that bypassed it fails HERE
 * rather than widening a stat with a technique's face).
 */
export function equippedMentalModifiers(
  registry: ContentRegistry,
  state: EntityState,
): ReadonlyMap<string, readonly Modifier[]> {
  const equipped = state.mental;
  if (equipped === undefined || equipped.length === 0) {
    return new Map();
  }
  const byStat = new Map<string, Modifier[]>();
  for (const id of equipped) {
    const entry = registry.martial(id);
    if (slotKindOf(entry) !== "mental") {
      throw new Error(
        `combat: the mental slot carries "${id}", whose face is a technique's (an effect chain, not modifiers) — the equip routing's own drift (content drift)`,
      );
    }
    for (const decl of entry.modifiers ?? []) {
      if (typeof decl.stat !== "string" || decl.stat === "") {
        throw new Error(
          `combat: mental "${id}" declares a modifier without a stat key (#59 D10)`,
        );
      }
      let members = byStat.get(decl.stat);
      if (members === undefined) {
        members = [];
        byStat.set(decl.stat, members);
      }
      members.push(...membersOf(decl, id));
    }
  }
  return byStat;
}

/**
 * One stat's live members — the five consumer reads' shared helper. An
 * unequipped or undeclared stat answers the empty list, and the pipe's
 * answer for an empty list is `max(0, base)` — identical to the base on the
 * five points' non-negative domain, which is the whole C1–C3 arithmetic
 * unchanged (D11's identity guarantee).
 */
export function mentalModifiersFor(
  registry: ContentRegistry,
  state: EntityState,
  stat: string,
): readonly Modifier[] {
  return equippedMentalModifiers(registry, state).get(stat) ?? [];
}

/**
 * The mental slot's load-point validation (#59 D8/D13): every id the save
 * claims equipped must resolve to a martial entry AND carry a mental's face
 * AND sit in the character table's mental known list — the
 * validateEquippedMartials precedent, one slot one law, at the one place a
 * save comes back.
 */
export function validateEquippedMentals(
  state: WorldState,
  registry: ContentRegistry,
): void {
  const known = registry.character?.mental?.known;
  for (const entity of Object.values(state.entities)) {
    for (const id of entity.mental ?? []) {
      const entry = registry.martial(id);
      if (slotKindOf(entry) !== "mental") {
        throw new Error(
          `combat: entity "${entity.id}" has "${id}" in the mental slot, but its face is a technique's (an effect chain, not modifiers) — content drift`,
        );
      }
      if (known !== undefined && !known.includes(id)) {
        throw new Error(
          `combat: entity "${entity.id}" has mental "${id}" equipped, which the character table's known list no longer carries (content drift)`,
        );
      }
    }
  }
}
