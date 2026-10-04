import type { EntityRecord, SaveDataV1, SaveDataV2, WorldMeta } from "./snapshot.js";

/**
 * SLOT_RULES — the ONE table declaring, per save slot, the four tolerances
 * that used to live as three hand-written answers at three consumption sites
 * (readSaveData / restoreWorld / migrations) plus a docstring layer above
 * them (#40, spec/04 §1.4–§1.5):
 *
 *   - **absent** — the ABSENCE POLICY: "required" (absence is corruption) or
 *     a default (absence is tolerated and filled). The default is declared
 *     ONCE here and both fill sites read it (AC5: the migration's fill and
 *     the reader's fill were two hard-coded copies of the same number);
 *     `migrate: true` additionally says the migration RECORDS this slot's
 *     absence — what a migration fills, answered per slot without a second
 *     copy of the value.
 *   - **validate** — the KIND CHECK answered for a PRESENT value.
 *
 * The slogan the three readers share, in one sentence: **a late optional
 * slot's reader tolerates ABSENCE only — never malformation.** A required
 * slot's absence is refused today and stays refused (that half is not being
 * widened); "absent means empty" governs only the slots that landed after
 * the version the save was written in (spec/04 §1.4).
 *
 * Three readers take their fields off each row (one table, three readers): `readSaveData`
 * reads `validate`, `restoreWorld` reads `absent`, `migrations` reads
 * `absent.migrate`. The law above names these three LOAD readers; the
 * display summary (`save/summary.ts`, #46) is deliberately not a fourth —
 * its tolerance is display-only (absent AND malformed both answer "no
 * summary"), and whether a save is damaged stays the load path's verdict.
 * The generic steps below are those three halves; the
 * engine's own consumers always hand them THIS table — the table is not
 * runtime-injectable (`DERIVED_ENTITY_KEYS` law: only its "no injection" half
 * applies here, since these rows do not derive compile-time shapes — the
 * types are separate, hand-edited points).
 *
 * Adding a slot is ONE row here plus (if needed) a validator and a type
 * field — the three consumption points are generic loops and never move
 * (AC1). The row shape is proved against its first real future user, `attrs`
 * (spec/04 §4.1 deliberately refuses to open that slot early), whose four
 * rules must all be expressible: absent → `{}` (`absent.default`), kind
 * check pending its shape (`validate` left unset), migration fills absence
 * only (`absent.migrate` — the steps below fill only what is ABSENT),
 * and its canonicalizer gap stays a documentation item, not a row.
 *
 * Two pieces of the save are STRUCTURE, not slots, and stay hand-written:
 * `id` (the record's copy must agree with its map key — a cross-field check
 * whose "default" IS the key) and `entities` (the map the records live in —
 * validated in hand with the walk that iterates it). Everything else is a
 * row.
 */

/** A slot's kind check, or a loud failure in the `snapshot:` vocabulary. */
export type SlotValidator = (value: unknown, what: string) => void;

/**
 * A slot default is what stands in for a slot the save wrote nothing for —
 * so it is JSON-shaped, like the save itself. Anything richer (a Date, a
 * class instance) could not survive the JSON boundary the save crosses, and
 * `freshDefault` would copy it into a bare object.
 */
export type SlotDefault =
  | string
  | number
  | boolean
  | null
  | readonly SlotDefault[]
  | { readonly [key: string]: SlotDefault };

/**
 * One slot's tolerance policy. A `required` row's validator runs even on
 * `undefined` — its kind check doubles as its presence check (`flags` is "a
 * list of strings", and absent is neither), which is exactly the error class
 * a missing required slot has always produced. A `required` row never gets a
 * migration fill: a migration must not invent the slot it would be guessing.
 */
export type SlotRule =
  | { absent: "required"; validate: SlotValidator }
  | {
      absent: {
        /** The ONE declaration of the default — both fill sites read it. */
        default: SlotDefault;
        /** The migration records this absence too (v1→v2 does, for its four). */
        migrate?: true;
      };
      validate?: SlotValidator;
    };

/** Slots by name, in declaration order — the order the readers answer in. */
export type SlotRuleTable<K extends string = string> = Record<K, SlotRule>;

/**
 * The world slots are named TWICE — once on the wire (`SaveDataV2`) and once
 * on the hand-off (`WorldMeta`) — and the table keys off `WorldMeta`. This
 * asserts the two name sets never drift apart: a field added to either type
 * alone fails compilation here, and one added to both still needs its table
 * row (the annotation on SLOT_RULES.world below) and its `serializeWorld`
 * write (its return type). Every edit path is compiler-guarded.
 */
type WorldSlot = Exclude<keyof SaveDataV2, keyof SaveDataV1>;
type Assert<T extends true> = T;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _WorldMetaNamesEveryWorldSlot = Assert<SameKeys<WorldSlot, keyof WorldMeta>>;

/** An object, or a loud failure. A save crossed a process boundary: every
 * field in it is a CLAIM about the world, not a fact, and a claim that does
 * not fit the current shape is answered here — at load — rather than three
 * hours later as a player standing in a room that does not exist. */
export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`snapshot: ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** A non-empty string, or a loud failure (an empty id locates nothing). */
export function asId(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`snapshot: ${what} is not a non-empty string`);
  }
  return value;
}

const isNonEmptyString: SlotValidator = (value, what) => {
  asId(value, what);
};

const isStringList: SlotValidator = (value, what) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`snapshot: ${what} is not a list of strings`);
  }
};

const isTagMap: SlotValidator = (value, what) => {
  const tags = asRecord(value, what);
  for (const [dimension, keys] of Object.entries(tags)) {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
      throw new Error(`snapshot: ${what}["${dimension}"] is not a list of strings`);
    }
  }
};

/** The tick definition of `clock.ts` assertTick: a non-negative safe integer. */
export const isTickValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * A cooldown is a tick, and a tick that is not a tick does not merely
 * misjudge: `NaN >= dueTick` is false for EVERY dueTick, so a skill armed
 * with it would never come back (spec/04 §1.4, ninth corruption class).
 */
const isCooldownMap: SlotValidator = (value, what) => {
  const table = asRecord(value, what);
  for (const [key, dueTick] of Object.entries(table)) {
    if (!isTickValue(dueTick)) {
      throw new Error(`snapshot: ${what}["${key}"] is not a non-negative safe integer`);
    }
  }
};

const isTick: SlotValidator = (value, what) => {
  if (!isTickValue(value)) {
    throw new Error(`snapshot: ${what} is not a non-negative safe integer`);
  }
};

/** mulberry32's whole state is one uint32 (ADR-0033 §1) — `rng.ts` coerces
 * anything wider through `>>> 0`, silently diverging the saved stream. */
const isUint32: SlotValidator = (value, what) => {
  if (!isTickValue(value) || value > 0xffffffff) {
    throw new Error(`snapshot: ${what} is not a uint32`);
  }
};

/** The due bucket's own restore() validates the ITEMS — a non-list cannot be
 * handed to it at all, so list-ness is answered here (the `tags` precedent —
 * written in, so it must be legal). */
const isDueList: SlotValidator = (value, what) => {
  if (!Array.isArray(value)) {
    throw new Error(`snapshot: ${what} is not a list`);
  }
};

/**
 * The table. Two scopes: one entity record's slots, and the world scalars
 * that ride BESIDE the tree (`WorldMeta`, spec/04 §1.5 O9). Rows are declared
 * in the order the readers answer in.
 */
export const SLOT_RULES: {
  entity: SlotRuleTable<Exclude<keyof EntityRecord, "id">>;
  world: SlotRuleTable<keyof WorldMeta>;
} = {
  entity: {
    // Required since the first save ever written: relaxing either check
    // would drop a corruption detector for nothing (spec/04 §1.4).
    locationId: { absent: "required", validate: isNonEmptyString },
    flags: { absent: "required", validate: isStringList },
    // The mid-version duo: `?` on the wire forever, "absent means empty"
    // (ADR-0022 — a field that was never written is not persisted). Neither
    // is a slot the migration records — their absence is ordinary v1 traffic
    // and the reader's fill is the truth being recorded.
    tags: { absent: { default: {} }, validate: isTagMap },
    // The one record slot the migration DOES record: #24 gave it a default
    // so a post-v2 save carries it, while "absent" still reads as tick 0,
    // never as corruption. The recorded value is the reader's default — the
    // fact being recorded is "never settled"; ADR-0033 §3's
    // `lastSeenTick = nowTick` predates the slot and no longer governs.
    lastSeenTick: { absent: { default: 0, migrate: true }, validate: isTick },
    cooldowns: { absent: { default: {} }, validate: isCooldownMap },
  },
  world: {
    // The scalars a v1 save predates entirely: the migration records "never
    // written" (0 / 0 / []), and a v2 save that still lacks one reads the
    // same default (spec/04 §1.5). Absence is tolerated; MALFORMATION is not
    // (D2, #40 — this is where ADR-0033 §4's "cheaper without a detector"
    // tradeoff was overturned).
    nowTick: { absent: { default: 0, migrate: true }, validate: isTick },
    rngState: { absent: { default: 0, migrate: true }, validate: isUint32 },
    due: { absent: { default: [], migrate: true }, validate: isDueList },
  },
};

/**
 * readSaveData's half, one row at a time: absence policy plus kind check. A
 * fillable slot's absence passes silently (absence is not malformation) and
 * only "present but the wrong kind" is answered; a `required` row's
 * validator runs either way, so a missing required slot keeps the error
 * class it has always had.
 */
export function validateSlots<K extends string>(
  values: object,
  rules: SlotRuleTable<K>,
  what: (slot: K) => string,
): void {
  const slots = values as Record<string, unknown>;
  for (const [slot, rule] of Object.entries(rules) as [K, SlotRule][]) {
    const value = slots[slot];
    if (value === undefined && rule.absent !== "required") continue;
    rule.validate?.(value, what(slot));
  }
}

/**
 * A fresh copy of a declared default. The default is a table constant, but
 * the FILL hands out a per-fill copy: two absences of `tags` must not read
 * and write one shared `{}` (the `?? {}` this replaced allocated per record).
 * Values already present are never copied — the save is their truth.
 */
function freshDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(freshDefault);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freshDefault(item)]));
  }
  return value;
}

/**
 * restoreWorld's half: every tolerated absence filled from its row's ONE
 * declared default (AC5 — the defensive double-fill at two sites dissolves
 * into one declaration here). Returns every row's RESOLVED value: present
 * values as-is — a `required` row included, since consumers like `WorldMeta`
 * build from this object alone and no PRESENT row may go missing from it
 * (its presence is validateSlots' guarantee, so an absent one is simply not
 * written) — and fillable absences filled with a fresh copy of the default.
 */
export function fillAbsentSlots<K extends string>(
  values: object,
  rules: SlotRuleTable<K>,
): Record<K, unknown> {
  const slots = values as Record<string, unknown>;
  const filled = {} as Record<K, unknown>;
  for (const [slot, rule] of Object.entries(rules) as [K, SlotRule][]) {
    if (rule.absent === "required") {
      if (slots[slot] !== undefined) filled[slot] = slots[slot];
      continue;
    }
    filled[slot] = slots[slot] === undefined ? freshDefault(rule.absent.default) : slots[slot];
  }
  return filled;
}

/**
 * migrations' half: the slots whose rows say the migration RECORDS their
 * absence (`absent.migrate`), filled from the row's one declared default and
 * only where the save left the slot ABSENT. Returns only what it actually
 * filled — a slot the save already carried is never rewritten (the iron
 * rule: a migration fills in only what is ABSENT), and a record with nothing
 * to fill keeps its identity.
 */
export function fillMigrationDefaults<K extends string>(
  values: object,
  rules: SlotRuleTable<K>,
): Partial<Record<K, unknown>> {
  const slots = values as Record<string, unknown>;
  const filled: Partial<Record<K, unknown>> = {};
  for (const [slot, rule] of Object.entries(rules) as [K, SlotRule][]) {
    if (rule.absent === "required" || !rule.absent.migrate) continue;
    if (slots[slot] === undefined) filled[slot] = freshDefault(rule.absent.default);
  }
  return filled;
}
