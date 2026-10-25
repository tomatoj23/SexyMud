import { describe, expect, it } from "vitest";
import { lineOf } from "../src/text/line.js";
import type { OutputLine, OutputSpan } from "../src/text/line.js";
import { foldLine } from "../src/text/wrap.js";
import { displayWidth } from "../src/text/width.js";

/**
 * The folding half of the text surface (issue #50, spec/05 §5.2/§10 B8,
 * spec/07 §3.B): Chinese wraps ANYWHERE between characters — there are no
 * spaces to honour — except where the kinsoku tables (避头尾) forbid it.
 * B8's bound acceptance condition: the folding DECIDES with the tables at
 * hand; patching lines after a naive fold would rewrite the folder's core
 * later. Every rule of the first-draft table is parameterized below with
 * the characters spelled out HERE, so a character silently dropped from the
 * engine's table (or a mutation that bypasses it) goes red.
 *
 * Widths in these tests are column counts: one Han character is 2 columns,
 * so "width 6" fits three Han characters — the same fullwidth arithmetic the
 * width module pins.
 */

const plain = (text: string): OutputSpan => ({ text, style: "plain" });
const line = (text: string): OutputLine => lineOf([plain(text)]);

/** The rendered texts of a fold, for assertions that read like lines. */
const texts = (folded: readonly OutputLine[]): string[] => folded.map((l) => l.text);

/** 行首禁则初稿（#50 AC）：closing punctuation + the dash's second half. */
const LINE_START_FORBIDDEN = [
  "\u3002", // 。
  "\u3001", // 、
  "\uff0c", // ，
  "\uff1b", // ；
  "\uff1a", // ：
  "\uff01", // ！
  "\uff1f", // ？ (same-family completion, B8-authorized first-draft addition)
  "\u300d", // 」
  "\u300f", // 』
  "\uff09", // ）
  "\u3015", // 〕
  "\u2026", // …
  "\uff5e", // ～
] as const;

/** 行尾禁则初稿（#50 AC）：opening punctuation + the dash's first half. */
const LINE_END_FORBIDDEN = [
  "\u300c", // 「
  "\u300e", // 『
  "\uff08", // （
  "\u3014", // 〔
  "\u300a", // 《
] as const;

describe("foldLine — width arithmetic", () => {
  it("returns the line unchanged when it fits", () => {
    const folded = foldLine(line("中文"), 6);
    expect(texts(folded)).toEqual(["中文"]);
    expect(folded[0]?.spans).toEqual([plain("中文")]);
  });

  it("returns the line unchanged at an exact boundary fit", () => {
    expect(texts(foldLine(line("一二三"), 6))).toEqual(["一二三"]);
  });

  it("folds fullwidth text at the column limit, not the character count", () => {
    // Five Han characters at width 6: three columns-pairs fit, two carry over
    expect(texts(foldLine(line("一二三四五"), 6))).toEqual(["一二三", "四五"]);
  });

  it("measures mixed-width text with the width function, not string length", () => {
    // "中ab中" is 2+1+1+2 = 6 columns; at limit 6 it fits whole, while its
    // length (4) and a naive split would disagree about where 5 columns land
    expect(texts(foldLine(line("中ab中c"), 6))).toEqual(["中ab中", "c"]);
  });

  it("charges emoji and combining marks by the width function's arithmetic", () => {
    // 6 columns of Han then an emoji (2 columns): the emoji cannot fit at 6
    const folded = foldLine(line("一二三\ud83d\ude00四"), 6);
    expect(texts(folded)).toEqual(["一二三", "\ud83d\ude00四"]);
  });

  it("emits a too-wide unit on a line of its own rather than dropping it", () => {
    // A dash pair is 4 columns; at width 2 nothing fits, yet progress happens
    expect(texts(foldLine(line("一——二"), 2))).toEqual(["一", "——", "二"]);
  });

  it("throws on a limit below one column (a wiring bug, not a fold)", () => {
    expect(() => foldLine(line("中文"), 0)).toThrow(/foldLine/);
    expect(() => foldLine(line("中文"), -3)).toThrow(/foldLine/);
  });

  it("folds an empty line to itself", () => {
    expect(foldLine(lineOf([]), 4)).toEqual([lineOf([])]);
  });
});

describe("foldLine — kinsoku, decided while folding", () => {
  it.each(LINE_START_FORBIDDEN)("never opens a line with %s", (char) => {
    // 一二三 fill the width-6 line exactly (three Han characters = six
    // columns); the punctuation would be the next line's FIRST character —
    // the fold pulls back instead. (Four characters would be eight columns
    // and never reach the boundary — the construction, not the comment,
    // decides what the case proves.)
    const folded = foldLine(line(`一二三${char}四`), 6);
    for (const text of texts(folded).slice(1)) {
      expect(text.startsWith(char)).toBe(false);
    }
    // and the pull-back kept the text whole
    expect(folded.map((l) => l.text).join("")).toBe(`一二三${char}四`);
  });

  it.each(LINE_END_FORBIDDEN)("never closes a line with %s", (char) => {
    // The opening punctuation lands as the LAST character of the naive fold
    const folded = foldLine(line(`一二${char}三四`), 6);
    for (const text of texts(folded).slice(0, -1)) {
      expect(text.endsWith(char)).toBe(false);
    }
    expect(folded.map((l) => l.text).join("")).toBe(`一二${char}三四`);
  });

  it("pulls back a whole run of line-start-forbidden punctuation, not one step", () => {
    // ！！ would both land on the new line; the fold backs up past 三
    const folded = foldLine(line("一二三！！四"), 6);
    expect(texts(folded)).toEqual(["一二", "三！！", "四"]);
  });

  it("never splits a dash pair across lines (成组符号不拆)", () => {
    const folded = foldLine(line("一二三——四"), 8);
    expect(texts(folded)).toEqual(["一二", "三——四"]);
    // At width 10 the naive cut lands BETWEEN the two dashes; the atomic
    // pair pulls the cut past itself instead (an ungrouped fold would emit
    // the pair as a line-opening here)
    const wide = foldLine(line("一二三——五"), 10);
    expect(texts(wide)).toEqual(["一二", "三——五"]);
  });

  it("never splits an ellipsis pair across lines (成组符号不拆)", () => {
    const folded = foldLine(line("一二三……四"), 8);
    expect(texts(folded)).toEqual(["一二", "三……四"]);
  });

  it("does not open a line with a lone dash (破折号前半 keeps its tail company)", () => {
    // At width 8 the naive fold ends line 1 at exactly 四, leaving —五 next
    const folded = foldLine(line("一二三四—五"), 8);
    expect(texts(folded)).toEqual(["一二三", "四—五"]);
  });

  it("does not close a line with a lone dash either", () => {
    const folded = foldLine(line("一二三—四"), 6);
    expect(texts(folded)).toEqual(["一二", "三—四"]);
  });

  it("breaks the naive way when every legal position is forbidden (progress beats kinsoku)", () => {
    // An unbreakable run of ！！！ has no legal cut; the fold still finishes
    const folded = foldLine(line("！！！"), 2);
    expect(folded.map((l) => l.text).join("")).toBe("！！！");
  });

  it("respects kinsoku across a span boundary as one text stream", () => {
    // The comma sits in the SECOND span; the fold must still not open with it
    const l = lineOf([plain("一二三四"), { text: "，五", style: "strong" }]);
    const folded = foldLine(l, 6);
    for (const text of texts(folded).slice(1)) {
      expect(text.startsWith("，")).toBe(false);
    }
  });
});

describe("foldLine — span tiling on both sides of the cut", () => {
  it("rebuilds complete span tilings per physical line", () => {
    const l = lineOf([
      { text: "一二", style: "plain" },
      { text: "三四", style: "strong" },
      { text: "五六", style: "plain" },
    ]);
    const folded = foldLine(l, 4);
    expect(texts(folded)).toEqual(["一二", "三四", "五六"]);
    for (const physical of folded) {
      expect(physical.spans.map((span) => span.text).join("")).toBe(physical.text);
    }
  });

  it("replays an unclosed span: closes it at the line's end, reopens it on the next", () => {
    // The strong span covers 三四五六 and straddles the fold
    const l = lineOf([
      { text: "一二", style: "plain" },
      { text: "三四五六", style: "strong" },
    ]);
    const folded = foldLine(l, 6);
    expect(texts(folded)).toEqual(["一二三", "四五六"]);
    // line 1: plain 一二 + the strong half that reached the fold
    expect(folded[0]?.spans).toEqual([
      { text: "一二", style: "plain" },
      { text: "三", style: "strong" },
    ]);
    // line 2: the strong span REOPENED for the remainder
    expect(folded[1]?.spans).toEqual([{ text: "四五六", style: "strong" }]);
  });

  it("merges adjacent same-style units back into one span", () => {
    const folded = foldLine(line("一二三四"), 8);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.spans).toEqual([{ text: "一二三四", style: "plain" }]);
  });

  it("keeps every physical line within the limit (or a single too-wide unit)", () => {
    const l = line("一二三——四五六七八九十");
    for (const physical of foldLine(l, 6)) {
      const width = displayWidth(physical.text);
      expect(width <= 6 || physical.spans.length === 1).toBe(true);
    }
  });
});
