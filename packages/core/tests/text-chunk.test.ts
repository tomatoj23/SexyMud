import { describe, expect, it } from "vitest";
import { chunkOutput } from "../src/text/chunk.js";
import type { Viewport } from "../src/text/chunk.js";
import { lineOf } from "../src/text/line.js";
import type { OutputLine } from "../src/text/line.js";
import { displayWidth } from "../src/text/width.js";

/**
 * The chunking half of the text surface (issue #50, spec/05 §6–§7): paging
 * without modal hijack — the output is an append-only scroll, and a "page"
 * is just the next slice of at most `height` physical lines, each already
 * folded at `width`. Both numbers are INPUTS (the host feeds its terminal's
 * real geometry; the engine writes no column constant anywhere), and the
 * folding inside goes through the width function — a chunker that measured
 * by string length would fold fullwidth text at the wrong column, and the
 * fullwidth case below goes red the moment that happens (spec/05 §5.2: the
 * width function must be USED, not merely written).
 *
 * Span replay at chunk boundaries falls out of the fold: every physical
 * line is a self-contained tiling (the folder closes and reopens straddling
 * spans), so a chunk boundary between physical lines cuts no span open.
 */

const plain = (text: string): OutputLine => lineOf([{ text, style: "plain" }]);
const texts = (chunk: readonly OutputLine[]): string[] => chunk.map((l) => l.text);

describe("chunkOutput", () => {
  it("groups physical lines into consecutive chunks of at most the viewport height", () => {
    const lines = [plain("一"), plain("二"), plain("三"), plain("四"), plain("五")];
    const chunks = chunkOutput(lines, { width: 10, height: 2 });
    expect(chunks.map(texts)).toEqual([["一", "二"], ["三", "四"], ["五"]]);
  });

  it("folds at the width parameter inside the chunker (fullwidth arithmetic, not length)", () => {
    // 五个汉字 is length 5 but 10 columns; at width 6 the chunker must
    // fold it into two physical lines — a length-based fold would emit one
    const chunks = chunkOutput([plain("一二三四五")], { width: 6, height: 10 });
    expect(chunks).toHaveLength(1);
    expect(texts(chunks[0] as readonly OutputLine[])).toEqual(["一二三", "四五"]);
  });

  it("carries a fold across a chunk boundary, replaying the open span per line", () => {
    // One logical line, strong span straddling the fold; height 1 forces
    // the two physical lines into separate chunks, each self-contained
    const l = lineOf([
      { text: "一二", style: "plain" },
      { text: "三四五六", style: "strong" },
    ]);
    const chunks = chunkOutput([l], { width: 6, height: 1 });
    expect(chunks.map(texts)).toEqual([["一二三"], ["四五六"]]);
    expect(chunks[1]?.[0]?.spans).toEqual([{ text: "四五六", style: "strong" }]);
  });

  it("applies kinsoku while folding inside the chunker", () => {
    // The comma must not open the second physical line (B8), even when the
    // fold happens under the chunker
    const chunks = chunkOutput([plain("一二三四，五")], { width: 6, height: 10 });
    for (const line of chunks[0] ?? []) {
      expect(line.text.startsWith("，")).toBe(false);
    }
  });

  it("answers no chunks for no lines", () => {
    expect(chunkOutput([], { width: 10, height: 10 })).toEqual([]);
  });

  it("keeps every line of every chunk within the width parameter", () => {
    const lines = [plain("一二三四五，六七八九十"), lineOf([{ text: "说明", style: "roomName" }])];
    const viewport: Viewport = { width: 8, height: 3 };
    for (const chunk of chunkOutput(lines, viewport)) {
      expect(chunk.length).toBeLessThanOrEqual(viewport.height);
      for (const line of chunk) {
        expect(displayWidth(line.text)).toBeLessThanOrEqual(viewport.width);
      }
    }
  });

  it("throws on a non-positive width or height (a wiring bug, not a chunk)", () => {
    expect(() => chunkOutput([plain("一")], { width: 0, height: 2 })).toThrow(/chunkOutput/);
    expect(() => chunkOutput([plain("一")], { width: 2, height: 0 })).toThrow(/chunkOutput/);
  });
});
