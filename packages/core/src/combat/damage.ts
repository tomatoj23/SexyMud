import type { ContentRegistry, MonsterRecord } from "../content/registry.js";
import type { CharacterTable, CombatTiersTable, SettingsTable } from "../content/config.js";
import { aggregateModifiers } from "../effects/modifiers.js";
import type { Modifier } from "../effects/modifiers.js";

/**
 * The strike kernel's arithmetic (#56, D5): the player→npc formula, the
 * retaliation's bare damage, and the ratio→band reads. Every number a fight
 * produces flows through the modifier pipeline (aggregateModifiers —
 * ADR-0005's minimal core, empty-degenerate in C1, T9): there is no damage
 * path beside it.
 *
 * Zero theme vocabulary beyond the two delivery/element DEFAULTS the ticket
 * itself pinned (T5's "undeclared monster source reads external", and the
 * element's matching default): every other word — band names, attr keys,
 * the K — arrives as data.
 */

/** The undeclared-monster delivery default (T5: content may declare otherwise). */
export const DEFAULT_STRIKE_SOURCE = "external";
/** The undeclared element default — C1's bare-handed strikes carry no element (AC7). */
export const DEFAULT_STRIKE_ELEMENT = "none";
/**
 * The undeclared NPC attack interval in ticks (#57 D8/D12): an engine
 * literal, not a settings number — it is the per-entity rhythm's DEFAULT,
 * the same family as the two delivery defaults above, while `defenseK` is a
 * formula constant (a different thing entirely).
 */
export const DEFAULT_NPC_ATTACK_INTERVAL_TICKS = 2;

/** The monster's combat face: the strike kernel's read of a monster record. */
export interface MonsterCombatFace {
  readonly maxHp: number;
  readonly attack: number;
  readonly externalDefense: number;
  readonly dodge: number;
  readonly source: string;
  readonly element: string;
  /** The NPC's auto-strike interval, the declared value or the engine default. */
  readonly attackIntervalTicks: number;
  /** Whether the monster opens the fight on the player's arrival (#57 D14). */
  readonly proactive: boolean;
}

/**
 * Reads a monster's combat numbers, loudly: an npc that triggers a fight
 * references a monster whose stats the fight needs, and a record without
 * them (host-assembled data that bypassed content:check) fails HERE — at
 * the first strike — rather than as a NaN damage three rooms later.
 * Optional members read their absence as 0 (the schema's own minimum face).
 */
export function monsterCombatFace(monster: MonsterRecord): MonsterCombatFace {
  const stats = monster.stats;
  if (
    stats === undefined ||
    typeof stats.maxHp !== "number" ||
    !Number.isFinite(stats.maxHp) ||
    stats.maxHp <= 0
  ) {
    throw new Error(
      `combat: monster "${monster.id}" declares no usable stats.maxHp — the npc referencing it cannot be fought`,
    );
  }
  const numberOrZero = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const interval = stats.attackIntervalTicks;
  if (
    interval !== undefined &&
    (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1)
  ) {
    throw new Error(
      `combat: monster "${monster.id}" declares stats.attackIntervalTicks of ${String(interval)} — it must be a positive integer`,
    );
  }
  return {
    maxHp: stats.maxHp,
    attack: numberOrZero(stats.attack),
    externalDefense: numberOrZero(stats.externalDefense),
    dodge: numberOrZero(stats.dodge),
    source: monster.source ?? DEFAULT_STRIKE_SOURCE,
    element: monster.element ?? DEFAULT_STRIKE_ELEMENT,
    attackIntervalTicks: interval ?? DEFAULT_NPC_ATTACK_INTERVAL_TICKS,
    proactive: monster.proactive === true,
  };
}

/**
 * `settings.combat.defenseK` — the formula's K (AC4), read the tuning
 * precedent's way (spec/04 §6 O3): a missing key is the consumer's loud
 * failure, never a guessed default.
 */
export function readDefenseK(settings: SettingsTable | undefined): number {
  const value = settings?.["combat"]?.["defenseK"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      "combat: settings.combat.defenseK is missing or not a non-negative number",
    );
  }
  return value;
}

/**
 * `settings.combat.escapeChance` — the escape roll's probability (#57 D11,
 * AC7): a combat-group tuning constant beside `defenseK`. Entity-influenced
 * escape faces are C3+'s; today's roll is one global number.
 */
export function readEscapeChance(settings: SettingsTable | undefined): number {
  const value = settings?.["combat"]?.["escapeChance"];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1
  ) {
    throw new Error(
      "combat: settings.combat.escapeChance is missing or not a probability in (0, 1]",
    );
  }
  return value;
}

/**
 * The strike formula (AC4): `max(1, round(attack × (1 − defense/(defense + K))))`.
 * The attack operand is piped through the modifier core FIRST (T9: no
 * damage path bypasses it); the defense is the monster's externalDefense —
 * C1's strikes are all external (D5: bare hands), the internal-defense half
 * is out of this ticket's scope. The floor of 1 keeps a fully-mitigated hit
 * a hit: an unkillable-by-design stalemate is a content bug, not a mechanic
 * (D7's rejected Q7③ in reverse).
 *
 * #57 D4: the NPC→player hand runs the SAME formula — the monster's attack
 * against the player's defenseAttr value — the two-way formula C1's
 * `defenseAttr` seat was declared for.
 */
export function strikeDamage(
  baseAttack: number,
  defense: number,
  defenseK: number,
  modifiers: readonly Modifier[] = [],
): number {
  const attack = aggregateModifiers(baseAttack, modifiers);
  const mitigation = 1 - defense / (defense + defenseK);
  return Math.max(1, Math.round(attack * mitigation));
}

/**
 * The F6 clamp (#57 D8, AC11): one write-point helper for every HP a
 * settlement writes — a save's HP beside a content-revised ceiling heals
 * itself on the next settlement, no migration, no ledger. The death checks
 * read the UNCLAMPED subtraction (this only caps the top edge; a killing
 * blow stays negative).
 */
export function clampedHp(hp: number, maxHp: number): number {
  return Math.min(hp, maxHp);
}

/**
 * One ratio's band name (AC7): the NUMBER travels nowhere on an event — the
 * band NAME does, and this is the read that names it. The ratio is clamped
 * into the table's span (a healed-over-max life bar reads the top band, an
 * overkill hit reads the bottom one); a dimension the table does not carry
 * is a wiring miss and fails loudly, the combat face of the tuning law.
 */
export function bandOf(
  tiers: CombatTiersTable | undefined,
  dimension: string,
  ratio: number,
): string {
  const bands = tiers?.[dimension];
  if (bands === undefined || bands.length === 0) {
    throw new Error(`combat: the combat tiers table carries no "${dimension}" bands`);
  }
  const first = bands[0]!;
  const last = bands[bands.length - 1]!;
  const clamped = Math.min(Math.max(ratio, first.min), last.max);
  for (const band of bands) {
    if (clamped >= band.min && clamped < band.max) {
      return band.band;
    }
  }
  // ratio === the last band's max: the closing band absorbs its own edge.
  return last.band;
}

/** The two band names every strike-shaped event carries, read in one place. */
export function bandPairOf(
  tiers: CombatTiersTable | undefined,
  damage: number,
  maxHp: number,
  hpAfter: number,
): { damageRatio: string; defenderHpRatio: string } {
  return {
    damageRatio: bandOf(tiers, "damageBand", damage / maxHp),
    defenderHpRatio: bandOf(tiers, "lifeBand", Math.max(0, hpAfter) / maxHp),
  };
}

/**
 * The pack's character table, or the loud wiring failure: a pack without
 * one has no strike operands, and the first fight is where that miss names
 * itself (the calendar/settings arrangement — load tolerates absence, the
 * consumer's first read does not).
 */
export function requireCharacterTable(registry: ContentRegistry): CharacterTable {
  const character = registry.character;
  if (character === undefined) {
    throw new Error(
      "combat: the pack declares no character table (content/config/character.json)",
    );
  }
  return character;
}
