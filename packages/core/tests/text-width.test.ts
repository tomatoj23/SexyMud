import { describe, expect, it } from "vitest";
import { charWidth, displayWidth, splitUnits } from "../src/text/width.js";

/**
 * The display-width half of the text surface (issue #50, spec/05 §5,
 * spec/07 §3.B): self-built, because the CJK reality is that a column is not
 * a character — fullwidth occupies two, combining marks and variation
 * selectors occupy zero, and an emoji ZWJ chain is one glyph, not three.
 * Evennia's 24-line `display_len()` covers none of this and is never even
 * called (spec/05 §5.1) — the two failures this module exists to not repeat.
 *
 * The pinned behaviours are the AC's coverage list verbatim: fullwidth,
 * combining marks, variation selectors (zero), emoji ZWJ, control characters
 * — plus the regional-indicator pairing that flags need, and the atomic-unit
 * split the folder and chunker consume (the width function must be USED, not
 * merely written: spec/05 §5.2).
 */

describe("charWidth", () => {
  it("counts ASCII and Latin letters as one column each", () => {
    expect(charWidth("a".codePointAt(0) as number)).toBe(1);
    expect(charWidth("Z".codePointAt(0) as number)).toBe(1);
    expect(charWidth("0".codePointAt(0) as number)).toBe(1);
    expect(charWidth(" ".codePointAt(0) as number)).toBe(1);
  });

  it("counts Han, kana and Hangul as two columns", () => {
    expect(charWidth("中".codePointAt(0) as number)).toBe(2);
    expect(charWidth("あ".codePointAt(0) as number)).toBe(2);
    expect(charWidth(0xac00)).toBe(2); // Hangul syllable
  });

  it("counts fullwidth forms and CJK punctuation as two columns", () => {
    expect(charWidth(0xff21)).toBe(2); // fullwidth Latin A
    expect(charWidth(0x3002)).toBe(2); // ideographic full stop
    expect(charWidth(0x300c)).toBe(2); // left corner bracket
    expect(charWidth(0x2014)).toBe(2); // em dash — CJK typography runs it double
    expect(charWidth(0x2026)).toBe(2); // ellipsis, same family
    expect(charWidth(0x3000)).toBe(2); // ideographic space
  });

  it("counts combining marks as zero (Mn and Me)", () => {
    expect(charWidth(0x0301)).toBe(0); // combining acute
    expect(charWidth(0x20e3)).toBe(0); // combining enclosing keycap (Me)
    expect(charWidth(0x05b0)).toBe(0); // Hebrew point (Mn)
  });

  it("counts Mc spacing combining marks as one (they take a column)", () => {
    expect(charWidth(0x0903)).toBe(1); // Devanagari sign visarga (Mc)
    expect(charWidth(0x093f)).toBe(1); // Devanagari vowel sign I (Mc)
  });

  it("counts variation selectors as zero", () => {
    expect(charWidth(0xfe0f)).toBe(0); // VS16
    expect(charWidth(0xfe00)).toBe(0); // VS1
    expect(charWidth(0xe0100)).toBe(0); // variation selectors supplement
  });

  it("counts emoji modifiers (skin tones) as zero — they only recolour the base", () => {
    expect(charWidth(0x1f3fb)).toBe(0);
    expect(charWidth(0x1f3ff)).toBe(0);
  });

  it("counts C0, DEL and C1 control characters as zero", () => {
    expect(charWidth(0x00)).toBe(0);
    expect(charWidth(0x09)).toBe(0); // TAB
    expect(charWidth(0x0a)).toBe(0); // LF
    expect(charWidth(0x1f)).toBe(0);
    expect(charWidth(0x7f)).toBe(0); // DEL
    expect(charWidth(0x9f)).toBe(0); // C1
  });

  it("counts a lone surrogate half as one column (it renders as one replacement glyph)", () => {
    expect(charWidth(0xd800)).toBe(1);
    expect(charWidth(0xdfff)).toBe(1);
    // and it does not break the unit split's reassembly
    expect(splitUnits("a\ud800b").map((unit) => unit.text).join("")).toBe("a\ud800b");
  });

  it("counts zero-width format characters as zero", () => {
    expect(charWidth(0x200b)).toBe(0); // zero width space
    expect(charWidth(0x200c)).toBe(0); // ZWNJ
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfeff)).toBe(0); // BOM
  });

  it("counts emoji pictograph blocks as two columns", () => {
    expect(charWidth(0x1f600)).toBe(2); // grinning face
    expect(charWidth(0x1f44d)).toBe(2); // thumbs up
    expect(charWidth(0x1f680)).toBe(2); // rocket
    expect(charWidth(0x1f9e8)).toBe(2); // firecracker (supplemental block)
  });

  it("keeps ambiguous Latin-adjacent symbols narrow (degree sign, plus-minus)", () => {
    expect(charWidth(0xb0)).toBe(1); // degree sign — ambiguous, Latin text carries it
    expect(charWidth(0xb1)).toBe(1); // plus-minus
  });
});

describe("displayWidth", () => {
  it("sums plain text", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("中文abc")).toBe(7);
  });

  it("attaches combining marks to their base at no extra width", () => {
    // e + combining acute + combining grave: one visible letter
    expect(displayWidth("e\u0301\u0300")).toBe(1);
    // Vietnamese ế: e + circumflex + acute
    expect(displayWidth("e\u0302\u0301")).toBe(1);
  });

  it("charges nothing for variation selectors", () => {
    // checkbox + VS16: the selector is presentation, not a column
    expect(displayWidth("\u2611\ufe0f")).toBe(1);
  });

  it("counts an emoji ZWJ chain as one glyph, not the sum of its parts", () => {
    // family: man ZWJ woman ZWJ girl — three pictographs, one rendered glyph
    expect(displayWidth("\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67")).toBe(2);
    // couple with heart: two pictographs + heart, one glyph
    expect(displayWidth("\ud83d\udc68\u200d\u2764\ufe0f\u200d\ud83d\udc68")).toBe(2);
  });

  it("counts a skin-tone modifier as part of its base", () => {
    expect(displayWidth("\ud83d\udc4d\ud83c\udffb")).toBe(2); // thumbs up + tone
  });

  it("pairs regional indicators into one flag", () => {
    const flag = "\ud83c\udde8\ud83c\uddf3"; // CN
    expect(displayWidth(flag)).toBe(2);
    expect(displayWidth(flag + flag)).toBe(4); // two flags, two glyphs
    // an odd one out still renders as a lone glyph
    expect(displayWidth("\ud83c\udde8\ud83c\uddf3\ud83c\udde8")).toBe(4);
  });

  it("charges nothing for control characters", () => {
    expect(displayWidth("a\u0000b\u007fc")).toBe(3);
  });

  it("walks surrogate pairs as single code points", () => {
    expect(displayWidth("\ud83d\ude00")).toBe(2); // one emoji, not two broken halves
  });
});

describe("splitUnits", () => {
  it("splits plain text one unit per code point", () => {
    const units = splitUnits("abc");
    expect(units.map((unit) => unit.text)).toEqual(["a", "b", "c"]);
    expect(units.map((unit) => unit.width)).toEqual([1, 1, 1]);
  });

  it("keeps combining marks and variation selectors inside their base's unit", () => {
    const units = splitUnits("e\u0301\ufe0f");
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe("e\u0301\ufe0f");
    expect(units[0]?.width).toBe(1);
  });

  it("keeps an emoji ZWJ chain as one unit of width 2", () => {
    const units = splitUnits("\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67");
    expect(units).toHaveLength(1);
    expect(units[0]?.width).toBe(2);
  });

  it("keeps a regional-indicator pair as one unit and a stray indicator as its own", () => {
    const units = splitUnits("\ud83c\udde8\ud83c\uddf3\ud83c\udde8");
    expect(units).toHaveLength(2);
    expect(units[0]?.text).toBe("\ud83c\udde8\ud83c\uddf3");
    expect(units[0]?.width).toBe(2);
    expect(units[1]?.text).toBe("\ud83c\udde8");
    expect(units[1]?.width).toBe(2);
  });

  it("does not fold a narrow base across a ZWJ into a wide chain", () => {
    // a ZWJ b is degenerate input; the ZWJ is still zero, b still its own unit
    const units = splitUnits("a\u200db");
    expect(units.map((unit) => unit.text)).toEqual(["a\u200d", "b"]);
  });

  it("reconcatenating unit texts reproduces the input exactly", () => {
    const text = "中文e\u0301\ud83d\udc68\u200d\ud83d\udc69\u0000\ud83c\udde8\ud83c\uddf3x";
    expect(splitUnits(text).map((unit) => unit.text).join("")).toBe(text);
  });

  it("answers zero units for the empty string", () => {
    expect(splitUnits("")).toEqual([]);
  });
});
