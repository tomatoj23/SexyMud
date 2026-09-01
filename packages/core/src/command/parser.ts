import type { ParseOutcome } from "./pipeline.js";

/**
 * The Chinese-first command parser (spec/02 §1, ADR-0024 §1).
 *
 * Chinese input has no spaces, so Evennia's whitespace tokenizer cannot be
 * copied. Instead:
 *
 * 1. The verb table matches the LONGEST registered verb at the start of the
 *    input; the remainder is handed over WHOLE as the arg string.
 * 2. Each command entry declares how that arg string is parsed via its
 *    `argForm` — arg parsing is never the verb matcher's job.
 * 3. No tokenizer library is involved: the grammar of MUD commands is a
 *    restricted, declared space, and longest match is more predictable and
 *    more testable than segmentation.
 *
 * This module is engine code: it contains Chinese GRAMMAR (第/个/·, Chinese
 * numerals) but no verbs and no theme vocabulary — verbs are data, supplied
 * by the caller (content registry, tests).
 */

/** One registered verb and the command it invokes. */
export interface VerbEntry {
  verb: string;
  commandKey: string;
}

/**
 * Outcome of matching an input against the verb table. On success the
 * remainder is the WHOLE arg string — one piece, never tokenized further.
 */
export type VerbMatch =
  | { ok: true; verb: string; commandKey: string; rawArgs: string }
  | { ok: false; reason: "emptyInput" | "unknownVerb" };

/**
 * The verb table: all verbs available for one dispatch, pre-sorted.
 *
 * ADR-0024 §2: iteration order must be explicit — length descending, then
 * code-unit lexicographic ascending — so equal-length verb orderings are
 * stable across processes (Python's hash-randomized `list(set(...))` is the
 * counter-example being avoided).
 */
export interface VerbTable {
  /** Canonical order: length descending, then lexicographic ascending. */
  readonly verbs: readonly string[];
  /** Longest verb at the start of the input; remainder as the raw arg string. */
  match(input: string): VerbMatch;
}

/** Sorts length-descending first, code-unit-lexicographic second. */
function compareVerbs(a: string, b: string): number {
  if (a.length !== b.length) {
    return b.length - a.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds a verb table from registered entries.
 *
 * - Verbs are trimmed; an empty verb or an empty commandKey is a build error.
 * - The same verb registered twice for the SAME key is an idempotent
 *   registration; for DIFFERENT keys it is an ambiguity and throws — the
 *   cmdset merge stack must resolve which command owns a verb before it
 *   reaches dispatch.
 */
export function createVerbTable(entries: Iterable<VerbEntry>): VerbTable {
  const byVerb = new Map<string, string>();
  for (const entry of entries) {
    const verb = entry.verb.trim();
    const commandKey = entry.commandKey.trim();
    if (verb === "") {
      throw new Error("verb table: empty verb");
    }
    if (commandKey === "") {
      throw new Error(`verb table: verb "${verb}" has an empty commandKey`);
    }
    const existing = byVerb.get(verb);
    if (existing !== undefined && existing !== commandKey) {
      throw new Error(
        `verb table: verb "${verb}" is registered for both "${existing}" and "${commandKey}"`,
      );
    }
    byVerb.set(verb, commandKey);
  }

  const verbs = [...byVerb.keys()].sort(compareVerbs);

  return {
    verbs,
    match(input: string): VerbMatch {
      const text = input.trim();
      if (text === "") {
        return { ok: false, reason: "emptyInput" };
      }
      for (const verb of verbs) {
        if (text.startsWith(verb)) {
          // The separator between verb and argument (space, full-width
          // space, etc.) is syntax, not part of the arg string. The
          // remainder itself is handed over whole.
          return {
            ok: true,
            verb,
            commandKey: byVerb.get(verb)!,
            rawArgs: text.slice(verb.length).trimStart(),
          };
        }
      }
      return { ok: false, reason: "unknownVerb" };
    },
  };
}

/**
 * A parsed target reference. Resolving WHICH entity a noun refers to is not
 * the parser's job (ADR-0016: form parsing here, semantics in the command's
 * target-resolution rules) — this is only the written reference.
 */
export interface TargetRef {
  /** The bare noun as written, e.g. an NPC name. */
  noun: string;
  /** 1-based match ordinal: 2 = "the second one named so". */
  ordinal: number;
}

/**
 * The declarative argument forms (spec/02 §1.2–§1.3). Each command entry
 * declares ONE form; the engine parses the arg string accordingly.
 *
 * The Chinese disambiguation forms are first-class enum members, unlike
 * Evennia where `name-N` is baked invisibly into search() (ADR-0024 §1):
 *
 * - `target` — a bare noun, defaulting to the first match
 * - `target-ordinal` — also accepts the ordinal-prefix form 「第 N 个 X」
 * - `target-index` — also accepts the dot-suffix form 「X·N」
 *
 * Both disambiguation forms still accept a bare noun (ordinal defaults to 1).
 * Adding a form (e.g. the quantifier forms of A7) means adding an enum value
 * and its parser here — an engine capability, not content.
 */
export type ArgForm =
  | "none"
  | "text"
  | "target"
  | "target-ordinal"
  | "target-index";

/**
 * Parses the arg string (what remains after the verb was cut) according to
 * the declared form. Failure reasons are semantic codes — the rendering
 * layer maps them to content-side copy (spec/02 §5.4: refusal wording is
 * data).
 */
export function parseArgForm(form: ArgForm, rawArgs: string): ParseOutcome {
  const arg = rawArgs.trim();
  switch (form) {
    case "none":
      return arg === "" ? { ok: true, args: null } : { ok: false, reason: "unexpectedArg" };
    case "text":
      return { ok: true, args: arg };
    case "target":
      return parseTarget(arg, false, false);
    case "target-ordinal":
      return parseTarget(arg, true, false);
    case "target-index":
      return parseTarget(arg, false, true);
  }
}

/**
 * Parses a target reference. With no disambiguation syntax enabled (or none
 * present) the whole arg is the bare noun. Structural markers present but
 * malformed fail loudly with a reason code rather than silently becoming a
 * weird noun — predictability over leniency (spec/02 §1.2).
 */
function parseTarget(
  arg: string,
  allowOrdinalPrefix: boolean,
  allowDotSuffix: boolean,
): ParseOutcome {
  if (arg === "") {
    return { ok: false, reason: "missingTarget" };
  }

  if (allowOrdinalPrefix && arg.startsWith("第")) {
    // 「第 N 个 X」 — the first 个 after the ordinal numeral is the separator.
    const separator = arg.indexOf("个");
    if (separator > 0) {
      return targetOutcome(arg.slice(separator + 1), arg.slice(1, separator));
    }
    // No 个 at all — e.g. a noun that merely starts with 第 — is not the
    // ordinal form: fall through and treat the whole arg as a bare noun.
  }

  if (allowDotSuffix) {
    // 「X·N」 — the LAST middle dot is the separator, so nouns may themselves
    // contain one. U+00B7 (·) and U+30FB (・) are the same separator to the
    // player.
    const dot = lastIndexOfAny(arg, "·", "・");
    if (dot >= 0) {
      return targetOutcome(arg.slice(0, dot), arg.slice(dot + 1));
    }
  }

  return { ok: true, args: { noun: arg, ordinal: 1 } };
}

/**
 * Validates one extracted (noun, ordinal-numeral) pair into a TargetRef —
 * the shared tail of both disambiguation forms. A bad numeral is reported
 * before a missing noun: the player's syntax error, not the noun's, is the
 * actionable one.
 */
function targetOutcome(nounText: string, ordinalText: string): ParseOutcome {
  const ordinal = parseNumeral(ordinalText.trim());
  if (ordinal === null || ordinal < 1) {
    return { ok: false, reason: "badOrdinal" };
  }
  const noun = nounText.trim();
  if (noun === "") {
    return { ok: false, reason: "missingNoun" };
  }
  return { ok: true, args: { noun, ordinal } };
}

function lastIndexOfAny(text: string, ...chars: string[]): number {
  let found = -1;
  for (const char of chars) {
    const index = text.lastIndexOf(char);
    if (index > found) {
      found = index;
    }
  }
  return found;
}

/** Chinese digits. Zero forms are deliberately absent: ordinal zero is invalid. */
const CN_DIGIT: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * Parses a numeral as written by a player: ASCII digits, full-width digits
 * (IME output), or Chinese numerals 一 through 九十九 (两 = 2). Returns null
 * for anything else — callers decide whether that is an error.
 *
 * Range note: a hundred and above are rejected; picking the 100th of
 * anything by hand is not a supported interaction, and a bounded grammar is
 * a testable one.
 */
export function parseNumeral(text: string): number | null {
  const normalized = normalizeFullWidthDigits(text.trim());
  if (normalized === "") {
    return null;
  }

  if (/^[0-9]+$/.test(normalized)) {
    const value = Number.parseInt(normalized, 10);
    return Number.isSafeInteger(value) ? value : null;
  }

  // Chinese numerals: [X]十[Y] with either part optional, or a single digit.
  if (normalized.includes("十")) {
    const parts = normalized.split("十");
    if (parts.length > 2) {
      return null; // 十十, 二十十, etc.
    }
    const tensPart = parts[0] ?? "";
    const onesPart = parts[1] ?? "";
    const tens = tensPart === "" ? 1 : CN_DIGIT[tensPart];
    const ones = onesPart === "" ? 0 : CN_DIGIT[onesPart];
    if (tens === undefined || ones === undefined) {
      return null;
    }
    return tens * 10 + ones;
  }

  if (normalized.length === 1) {
    return CN_DIGIT[normalized] ?? null;
  }
  return null;
}

/** Maps full-width digits (U+FF10-U+FF19, common IME output) to ASCII digits. */
function normalizeFullWidthDigits(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code >= 0xff10 && code <= 0xff19 ? String.fromCharCode(code - 0xfee0) : char;
  }
  return out;
}
