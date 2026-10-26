import { describe, expect, it } from "vitest";
import { sanitizePlayerInput } from "../src/input/sanitize.js";

/**
 * The input-hardening mechanism (issue #54, spec/05 §8.1): a player's raw
 * line is REBUILT code point by code point before it may enter the engine —
 * every Unicode Cc (control) and Cf (format) code point is dropped, and the
 * rebuilt line is capped at the host's length. Newlines (the #51 finding:
 * an embedded `\n` rode into an output line and forged an extra visible
 * line under `white-space: pre`) and the bidi family (RLO and friends) are
 * both inside those two categories, so the strip is by CLOSED CATEGORY, not
 * by a hand-listed blacklist of dangerous characters.
 *
 * The ranges below are this test's own copy of the two categories (Unicode
 * 15.0) — same standard the implementation's table is drawn from, kept as a
 * second transcription rather than a shared import so a typo'd range in
 * either place fails against the other. The closure walk pins every range;
 * the exact count (65 + 155) lives in markup-isolation.test.ts as the
 * drift tripwire.
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

describe("sanitizePlayerInput — the strip (§8.1)", () => {
  it("keeps ordinary text verbatim: Chinese, ASCII, punctuation, emoji", () => {
    expect(sanitizePlayerInput("你好，江湖！hello, world! 传送「北」👨", 200)).toBe(
      "你好，江湖！hello, world! 传送「北」👨",
    );
  });

  it("strips an embedded newline — the #51 forgery vector dies at the gate", () => {
    expect(sanitizePlayerInput("甲\n乙", 200)).toBe("甲乙");
    expect(sanitizePlayerInput("甲\r\n乙", 200)).toBe("甲乙");
  });

  it("strips the whole Cc category, not a hand-picked list", () => {
    for (const [lo, hi] of CC_RANGES) {
      for (let cp = lo; cp <= hi; cp++) {
        expect(sanitizePlayerInput(`a${String.fromCodePoint(cp)}b`, 200)).toBe("ab");
      }
    }
  });

  it("strips the whole Cf category, not a hand-picked list", () => {
    for (const [lo, hi] of CF_RANGES) {
      for (let cp = lo; cp <= hi; cp++) {
        expect(sanitizePlayerInput(`a${String.fromCodePoint(cp)}b`, 200)).toBe("ab");
      }
    }
  });

  it("keeps categories OUTSIDE Cc/Cf: PUA, combining marks, lone emoji", () => {
    expect(sanitizePlayerInput("\uE000", 200)).toBe("\uE000"); // private use — not control
    expect(sanitizePlayerInput("e\u0301", 200)).toBe("e\u0301"); // combining acute (Mn)
    expect(sanitizePlayerInput("👨", 200)).toBe("👨"); // surrogate pair survives whole
  });
});

describe("sanitizePlayerInput — the length cap (§8.1)", () => {
  it("truncates at the host's cap, on a code-point boundary (no half emoji)", () => {
    const line = "甲".repeat(5) + "👨" + "乙".repeat(5);
    expect(sanitizePlayerInput(line, 6)).toBe("甲".repeat(5) + "👨");
  });

  it("strips BEFORE capping, so the capped line is already clean", () => {
    expect(sanitizePlayerInput("甲\n乙\n丙\n丁\n戊\n己", 4)).toBe("甲乙丙丁");
  });

  it("an input of nothing but control characters sanitizes to the empty line", () => {
    expect(sanitizePlayerInput("\n\r\x00\x1f\u202e", 200)).toBe("");
  });

  it("rejects a broken cap loudly, the text surface's own guard (foldLine)", () => {
    expect(() => sanitizePlayerInput("甲", 0)).toThrow(/sanitizePlayerInput/);
    expect(() => sanitizePlayerInput("甲", -1)).toThrow(/sanitizePlayerInput/);
    expect(() => sanitizePlayerInput("甲", 1.5)).toThrow(/sanitizePlayerInput/);
  });
});
