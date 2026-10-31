/**
 * The modifier aggregation MINIMAL CORE (ADR-0005:14-15, T9's ruled shape —
 * #56): "combat code walks the modifier pipeline from its first line", so
 * the pipeline EXISTS here even though C1 has no affixes and both layers
 * are therefore always empty — the EMPTY DEGRADATE of the two-layer core
 * (fixed-value flats + additive percentages). Layer members belong to the
 * systems that own them (affixes, buffs); none exists today.
 *
 * ADR-0005 is obeyed to the letter, not overridden: there is no second
 * damage path beside this one, and a strike's every number (base attack,
 * retaliation, a poison's per-tick) flows through this one function.
 *
 * The aggregation itself is the shape 0005 pinned: flats ADD first, then
 * the additive percentages multiply the summed base — one pass, no order
 * dependence among members of one layer (the reason aggregation and
 * application order are different questions, ADR-0009 §9).
 */

/** One fixed-value modifier: added to the base before the percentages. */
export interface FlatModifier {
  readonly kind: "flat";
  readonly value: number;
}

/** One additive-percentage modifier: a fraction of the summed base. */
export interface PercentModifier {
  readonly kind: "percent";
  /** A fraction, not a percentage figure: 0.2 = +20%. */
  readonly value: number;
}

/** The two-layer core's members, in layer order (flats first). */
export type Modifier = FlatModifier | PercentModifier;

/**
 * Aggregates `base` through the minimal core: `(base + Σ flats) × (1 + Σ
 * percents)`, clamped to a floor of 0 (a negative pile may not cross below
 * nothing). Today's callers hand an empty list — the empty degenerate form
 * answers exactly `max(0, base)`, which is the whole point of landing the
 * pipeline before it has members.
 */
export function aggregateModifiers(
  base: number,
  modifiers: readonly Modifier[] = [],
): number {
  let flats = 0;
  let percents = 0;
  for (const modifier of modifiers) {
    if (modifier.kind === "flat") {
      flats += modifier.value;
    } else {
      percents += modifier.value;
    }
  }
  return Math.max(0, (base + flats) * (1 + percents));
}
