/**
 * The display-width half of the text surface (spec/05 §5, spec/07 §0/§3.B):
 * self-built, because "one character one column" is an English assumption —
 * a fullwidth character occupies two columns, combining marks and variation
 * selectors occupy zero, and an emoji ZWJ chain is one glyph, not three
 * (Evennia's `display_len()` covers none of this, spec/05 §5.1). This module
 * is pure code-point classification: no Unicode data tables, no platform
 * calls — the ranges below are the engine's initial width table, and every
 * consumer of measurement (the folder, the chunker) goes through it, never
 * through string length (spec/05 §5.2: the width function must be USED, not
 * merely written).
 *
 * Classification rules, in one place:
 *
 *   0 columns — control characters (Cc), combining marks Mn/Me, format
 *               characters Cf (ZWJ, ZWNJ, BOM, ...), variation selectors
 *               (a Mn subset), emoji modifiers (skin tones — they recolour
 *               the base, never stand alone), line/paragraph separators.
 *   1 column   — everything else narrow, including AMBIGUOUS Latin-adjacent
 *               symbols (degree sign, plus-minus) and Mc spacing marks.
 *   2 columns  — the East Asian Wide/Fullwidth ranges (Han, kana, Hangul,
 *               fullwidth forms, CJK punctuation, Yi, ext planes) and the
 *               emoji pictograph blocks; plus em dash and ellipsis, which
 *               ambiguous-class tables call 1 but CJK typography sets
 *               double (a Chinese dash occupies four columns).
 *
 * Two folding rules apply ABOVE the per-code-point width, both here and in
 * the unit split the folder consumes: regional indicators pair into one
 * flag (2 columns the pair), and a ZWJ chain is one glyph of the FIRST
 * base's width. Presentation selectors add no columns: a narrow base plus
 * VS16 stays 1 alone (a conservative divergence from Unicode-9 width) and
 * is absorbed into a ZWJ chain only as a continuation.
 */

/** Mn/Me/Cf/Cc/Zl/Zp — property classes, via Unicode property escapes. */
const ZERO_WIDTH_CLASS = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u;

/** Emoji modifiers (skin tones): not a zero-width class, but never stand alone. */
const EMOJI_MODIFIER_LO = 0x1f3fb;
const EMOJI_MODIFIER_HI = 0x1f3ff;

/** Code points that render as part of what precedes them, or as nothing. */
function isZeroWidth(cp: number): boolean {
  if (cp >= EMOJI_MODIFIER_LO && cp <= EMOJI_MODIFIER_HI) {
    return true;
  }
  return ZERO_WIDTH_CLASS.test(String.fromCodePoint(cp));
}

/** The East Asian Wide/Fullwidth ranges plus the emoji blocks (see header). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul jamo (choseong)
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // kana, CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables and radicals
  [0xa960, 0xa97f], // Hangul jamo extension A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji pictographs and emoticons
  [0x1f680, 0x1f6ff], // transport and map
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff], // extended pictographic (chess, symbols)
  [0x20000, 0x2fffd], // CJK extension B
  [0x30000, 0x3fffd], // CJK extensions C and beyond
];

/** Explicit wide singles outside any range above: the CJK typography pair. */
const WIDE_SINGLES: ReadonlySet<number> = new Set([0x2014, 0x2026]);

function isWide(cp: number): boolean {
  if (WIDE_SINGLES.has(cp)) {
    return true;
  }
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) {
      return true;
    }
  }
  return false;
}

/**
 * One code point's width in terminal columns: 0, 1 or 2. Code points outside
 * the BMP are fine — the caller passes the full code point, not a surrogate
 * half.
 */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (isZeroWidth(cp)) {
    return 0;
  }
  return isWide(cp) ? 2 : 1;
}

const REGIONAL_INDICATOR_LO = 0x1f1e6;
const REGIONAL_INDICATOR_HI = 0x1f1ff;

function isRegionalIndicator(cp: number): boolean {
  return cp >= REGIONAL_INDICATOR_LO && cp <= REGIONAL_INDICATOR_HI;
}

const ZWJ = 0x200d;
const VS16 = 0xfe0f;

/**
 * Whether the base at `baseAt` re-merges into a ZWJ chain as a continuation:
 * an emoji-wide base always does, and a narrow base does when a VS16
 * immediately follows — the emoji-presentation request, as in the
 * couple-with-heart sequence (heart + VS16 between two ZWJs). A narrow base
 * without the selector ends the chain: degenerate input stays measured
 * piecewise.
 */
function joinsAfterZwj(cps: readonly number[], baseAt: number): boolean {
  const cp = cps[baseAt] as number;
  if (isWide(cp)) {
    return true;
  }
  return cps[baseAt + 1] === VS16;
}

/**
 * One atomic display unit: a base code point plus every zero-width code
 * point attached to it (combining marks, selectors, the ZWJ links of its
 * chain) — the unit the folder moves and measures. Regional indicators pair
 * into flag units; an odd one left over is its own unit. Unit texts
 * concatenate back to the input exactly (pinned).
 */
export interface WidthUnit {
  readonly text: string;
  readonly width: number;
}

/** Splits text into atomic display units (see WidthUnit). */
export function splitUnits(text: string): WidthUnit[] {
  const cps = [...text].map((char) => char.codePointAt(0) as number);
  const units: WidthUnit[] = [];
  let at = 0;
  while (at < cps.length) {
    const cp = cps[at] as number;
    if (isRegionalIndicator(cp)) {
      // Pair indicators two by two: each pair is one flag glyph (2 columns),
      // an odd leftover renders as one lone indicator glyph.
      const start = at;
      let count = 0;
      while (at < cps.length && isRegionalIndicator(cps[at] as number)) {
        at++;
        count++;
      }
      for (let paired = 0; paired + 1 < count; paired += 2) {
        units.push({
          text: String.fromCodePoint(cps[start + paired] as number, cps[start + paired + 1] as number),
          width: 2,
        });
      }
      if (count % 2 === 1) {
        units.push({ text: String.fromCodePoint(cp), width: 2 });
      }
      continue;
    }
    const start = at;
    at++;
    for (;;) {
      // Zero-width followers (marks, selectors) attach to the base.
      while (at < cps.length && charWidth(cps[at] as number) === 0 && cps[at] !== ZWJ) {
        at++;
      }
      if (cps[at] !== ZWJ) {
        break;
      }
      // A ZWJ whose follower joins extends the glyph; one whose follower
      // does not (or a trailing one) still modifies this base — attach it.
      if (at + 1 < cps.length && joinsAfterZwj(cps, at + 1)) {
        at += 2;
        continue;
      }
      at++;
    }
    units.push({
      text: String.fromCodePoint(...cps.slice(start, at)),
      width: charWidth(cp),
    });
  }
  return units;
}

/**
 * A string's display width in columns: the sum over its atomic units, so
 * combining marks, selectors, ZWJ chains and flag pairs all fold correctly.
 */
export function displayWidth(text: string): number {
  return splitUnits(text).reduce((total, unit) => total + unit.width, 0);
}
