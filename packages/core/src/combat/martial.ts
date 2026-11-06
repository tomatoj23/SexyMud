import type { ContentRegistry, MartialEntry } from "../content/registry.js";
import type { CharacterTable } from "../content/config.js";
import { cooldownReady } from "../time/cooldown.js";
import type { EntityState, WorldState } from "../state/tree.js";
import { requireCharacterTable } from "./damage.js";
import { readInternalForceTuning } from "./damage.js";
import { bandOf } from "./damage.js";
import { baseStrikePlan } from "./blow.js";
import type { StrikePlan } from "./blow.js";

/**
 * The WHEEL (#58 D6/D15): the engine-side function that answers "what is
 * this hand?" for every rhythm hand the settle layer advances — the
 * assembly-order priority walk over the equipped slot, the cooldowns table
 * and the secondary resource, falling back to the base strike the host
 * wires. No dice (D6's determinism ruling): the wheel is a walk, not a
 * roll, and the only randomness a hand owns is the blow's own dodge.
 *
 * The two fallback STATES are distinct on purpose (the audit's two-state
 * ruling): a wheel whose every martial is merely COOLING DOWN falls to the
 * base strike at FULL power — the cooling state is not a punishment — while
 * a wheel that can afford NONE of its martials falls to the base strike at
 * the EXHAUSTED ratio (D18's zeroCostAttackRatio, the "output drops but
 * never to zero" obligation). An EMPTY wheel is neither: a hand with no
 * martials at all is the base strike at full power, forever.
 *
 * Also here: the load-point validation of the equipped slot's references
 * (D13) — the save-side half of the martial id integrity, beside the
 * registry's content-side half.
 */

/** The equipped list in priority order: the slot's order IS the wheel's (D6). */
export function equippedMartialsOf(state: EntityState): readonly string[] {
  return state.martial ?? [];
}

/** One martial's cost, read loudly: a negative or non-finite cost is a pack bug. */
function costOf(entry: MartialEntry): number {
  const cost = entry.cost ?? 0;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error(`combat: martial "${entry.id}" declares a cost that is not a non-negative number`);
  }
  return cost;
}

/** One martial's cooldown, read the same loud way; absent declares none (D12). */
function cooldownTicksOf(entry: MartialEntry): number {
  const ticks = entry.cooldownTicks ?? 0;
  if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 0) {
    throw new Error(
      `combat: martial "${entry.id}" declares cooldownTicks that is not a non-negative integer`,
    );
  }
  return ticks;
}

/** One martial's multiplier, read the same loud way; absent declares 1 (D11). */
function attackMultiplierOf(entry: MartialEntry): number {
  const multiplier = entry.attackMultiplier ?? 1;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(
      `combat: martial "${entry.id}" declares attackMultiplier that is not a positive number`,
    );
  }
  return multiplier;
}

/** The tier's quality word (C3-T2): the ordinal read through the band table. */
export function rankOfMartial(registry: ContentRegistry, entry: MartialEntry): string {
  const tier = entry.tier;
  if (typeof tier !== "number" || !Number.isSafeInteger(tier) || tier < 1) {
    throw new Error(`combat: martial "${entry.id}" declares a tier that is not a positive integer`);
  }
  return bandOf(registry.combatTiers, "quality", tier);
}

/**
 * The plan one MARTIAL hand runs: the entry's own chain, words, multiplier,
 * cost and cooldown. The rank word rides from the tier through the quality
 * band table (the damageBand key precedent — a band NAME, not a number).
 */
export function martialStrikePlan(registry: ContentRegistry, entry: MartialEntry): StrikePlan {
  const character = requireCharacterTable(registry);
  // A hand needs a chain (#59 D9): a mental declares no effects — reaching
  // here without one means a mental drifted into the wheel's slot, or a
  // technique bypassed the schema without its chain. Either way it fails
  // HERE, loudly, never as a hand that walks nothing.
  const effects = entry.effects;
  if (effects === undefined) {
    throw new Error(
      `combat: martial "${entry.id}" carries no effects — a hand needs an effect chain (a mental in the wheel's slot is content drift, #59 D9)`,
    );
  }
  return {
    effects,
    source: entry.source ?? character.strike.source,
    element: entry.element ?? character.strike.element,
    martialId: entry.id,
    rank: rankOfMartial(registry, entry),
    attackMultiplier: attackMultiplierOf(entry),
    cost: costOf(entry),
    ...(cooldownTicksOf(entry) > 0 ? { cooldownTicks: cooldownTicksOf(entry) } : {}),
  };
}

/** The player's secondary resource as numbers, or undefined when the pack declares none. */
export function secondaryResourceOf(
  state: EntityState,
  character: CharacterTable,
): { current: number; max: number } | undefined {
  const secondary = character.secondaryResource;
  if (secondary === undefined) {
    return undefined;
  }
  const current = state.attrs[secondary.current];
  const max = state.attrs[secondary.max];
  if (
    typeof current !== "number" ||
    !Number.isFinite(current) ||
    typeof max !== "number" ||
    !Number.isFinite(max)
  ) {
    throw new Error(
      `combat: the player's attrs carry no usable secondary resource (keys "${secondary.current}"/"${secondary.max}") — seed the character table at startNewGame`,
    );
  }
  return { current, max };
}

/**
 * The wheel's answer for the hand due at `nowTick` (D6): the first equipped
 * martial that is OFF COOLDOWN and AFFORDABLE at that tick, else the base
 * strike — full-power when the misses are cooldown-caused (or the wheel is
 * empty), at the EXHAUSTED ratio when not one equipped martial is
 * affordable. The wheel reads NO dice: which hand happens is a function of
 * the slot's order, the cooldowns table and the resource, nothing else.
 */
export function selectStrikePlan(
  registry: ContentRegistry,
  state: EntityState,
  baseEffects: readonly string[],
  nowTick: number,
): StrikePlan {
  const character = requireCharacterTable(registry);
  const base = baseStrikePlan(baseEffects, character.strike);
  const equipped = equippedMartialsOf(state);
  if (equipped.length === 0) {
    return base;
  }
  const known = character.martial?.known;
  let affordable = false;
  for (const id of equipped) {
    const entry = registry.martial(id);
    if (known !== undefined && !known.includes(id)) {
      // The late assertion (D13): the load point validated this already; a
      // drift that bypassed it fails HERE rather than casting an unlearned
      // hand.
      throw new Error(
        `combat: equipped martial "${id}" is not in the character table's known list (content drift)`,
      );
    }
    const cost = costOf(entry);
    const resource = secondaryResourceOf(state, character);
    if (resource !== undefined && cost > resource.current) {
      continue;
    }
    affordable = true;
    if (cooldownReady(state.cooldowns, id, nowTick)) {
      return martialStrikePlan(registry, entry);
    }
  }
  if (!affordable) {
    // The EXHAUSTED state (D18): not one equipped martial is castable for
    // resource reasons — the base strike lands at the drained ratio.
    return {
      ...base,
      attackMultiplier: readInternalForceTuning(registry.settings).zeroCostAttackRatio,
    };
  }
  // Cooldown-caused: the full-power base strike, the C1 chain as it stood.
  return base;
}

/**
 * The equipped slot's load-point validation (#58 D13): every id the save
 * claims equipped must resolve to a martial entry AND sit in the character
 * table's known list — content drift answers HERE, loudly, at the one place
 * a save comes back (the resumeCombatSession precedent for
 * `targetNpcId`; the registry's own check covers only the content-side
 * half, the known/initialEquipped lists).
 */
export function validateEquippedMartials(
  state: WorldState,
  registry: ContentRegistry,
): void {
  const character = registry.character;
  const known = character?.martial?.known;
  for (const entity of Object.values(state.entities)) {
    for (const id of entity.martial ?? []) {
      // The getter's own throw names an unknown id; the known-list check
      // names a drifted one — two different content troubles, two messages.
      registry.martial(id);
      if (known !== undefined && !known.includes(id)) {
        throw new Error(
          `combat: entity "${entity.id}" has martial "${id}" equipped, which the character table's known list no longer carries (content drift)`,
        );
      }
    }
  }
}
