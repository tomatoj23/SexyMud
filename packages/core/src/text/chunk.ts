/**
 * The chunking half of the text surface (spec/05 §6–§7): paging without
 * modal hijack. A chunk is the next slice of at most `height` PHYSICAL
 * lines, each already folded at `width` — both numbers are inputs the host
 * feeds from its terminal's real geometry; the engine pins no column
 * constant. Folding runs inside (through the width function, never string
 * length — spec/05 §5.2), so span replay at chunk boundaries is the fold's
 * own guarantee: every physical line is a self-contained tiling, and a
 * chunk boundary cuts between whole lines, never through a span.
 */

import { foldLine } from "./wrap.js";
import type { OutputLine } from "./line.js";

/** The host terminal's geometry, as the chunker's two inputs. */
export interface Viewport {
  /** Folding width in display columns. */
  readonly width: number;
  /** Chunk height in physical lines. */
  readonly height: number;
}

/**
 * Folds each logical line at the viewport's width, then groups the physical
 * lines into consecutive chunks of at most the viewport's height. No input
 * lines, no chunks. Non-positive width or height is a wiring bug and throws.
 */
export function chunkOutput(
  lines: readonly OutputLine[],
  viewport: Viewport,
): OutputLine[][] {
  const { width, height } = viewport;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(
      `chunkOutput: viewport must be positive integers (width ${width}, height ${height})`,
    );
  }
  const physical = lines.flatMap((line) => foldLine(line, width));
  if (physical.length === 0) {
    return [];
  }
  const chunks: OutputLine[][] = [];
  for (let at = 0; at < physical.length; at += height) {
    chunks.push(physical.slice(at, at + height));
  }
  return chunks;
}
