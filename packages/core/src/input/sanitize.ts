/**
 * The input-hardening gate (spec/05 §8.1, issue #54): a player's raw line
 * is rebuilt here BEFORE it may enter the engine — the one place the §8.1
 * model ("rebuild, never blacklist-filter") lives. Two laws:
 *
 * - STRIP: every Unicode Cc (control) and Cf (format) code point is
 *   dropped. Cc carries the newline — the #51 finding was an embedded `\n`
 *   riding into an output line and forging an extra visible line under
 *   `white-space: pre`. Cf carries the bidi family (RLO/LRM and friends —
 *   the visual-spoofing vectors) and the invisible-text family (ZWSP, BOM,
 *   tag characters). The two categories are CLOSED sets from the Unicode
 *   standard, so this is a category law, not a hand-listed blacklist of
 *   "dangerous characters" — the blacklist shape is exactly what §8.1
 *   exists to prevent (add a character, and a blacklist is already stale).
 * - CAP: the rebuilt line is truncated at the host's chosen length, on a
 *   code-point boundary (never half a surrogate pair), strip before cap so
 *   the capped line is already clean.
 *
 * Categories OUTSIDE Cc/Cf (PUA, combining marks, emoji) pass untouched —
 * widening the strip to named characters would be the blacklist again.
 */

/** The Cc category's closed ranges (Unicode 15.0, General_Category=Cc). */
const CC_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
];

/** The Cf category's closed ranges (Unicode 15.0, General_Category=Cf). */
const CF_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

const isStripped = (cp: number): boolean =>
  CC_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ||
  CF_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

/**
 * Rebuilds a player's line free of Cc/Cf code points, capped at
 * `maxLength` code points. The host owns the cap's value (spec/05 §8.1);
 * the strip's categories are this module's law. The cap's guard matches the
 * text surface's own (foldLine): a non-positive or fractional cap is a
 * wiring bug, loud beats silently empty.
 */
export function sanitizePlayerInput(raw: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error(
      `sanitizePlayerInput: maxLength must be a positive integer of code points, got ${maxLength}`,
    );
  }
  const kept: string[] = [];
  for (const ch of raw) {
    if (kept.length >= maxLength) break;
    if (!isStripped(ch.codePointAt(0) as number)) kept.push(ch);
  }
  return kept.join("");
}
