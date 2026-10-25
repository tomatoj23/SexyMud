/**
 * The output pipeline's line shapes (spec/05 §4): structured tokens, not
 * ANSI and not HTML — a mini-program has no DOM and understands no escape
 * codes. A line is its full plain text (the style-free fallback the same
 * spec demands) plus a COMPLETE tiling of styled spans: every character
 * belongs to exactly one span, which is what lets the folder and chunker
 * cut a line anywhere and rebuild self-contained lines on both sides
 * (spec/05 §6).
 */

/**
 * A semantic style name. The engine emits a closed set of its own ("plain",
 * "roomName", "npcName", ...) and a host maps each to its platform's look;
 * adding a highlight means one dimensions-table row plus one mapping per
 * host, with zero engine change (ADR-0018 §3). "plain" is the engine's
 * no-style word — the fallback every styled span degrades to.
 */
export type StyleName = string;

/** One run of text under one style. */
export interface OutputSpan {
  readonly text: string;
  readonly style: StyleName;
}

/** One logical output line: full text plus its complete span tiling. */
export interface OutputLine {
  readonly text: string;
  readonly spans: readonly OutputSpan[];
}

/**
 * Builds a line from spans, deriving the plain-text fallback from the tiling
 * itself so the two fields cannot disagree.
 */
export function lineOf(spans: readonly OutputSpan[]): OutputLine {
  return { text: spans.map((span) => span.text).join(""), spans };
}

/**
 * Appends a span to a tiling under construction, merging it into the
 * previous one when their styles match — the one merge rule the folder and
 * the renderer both rebuild tilings by (adjacent same-style segments are one
 * span).
 */
export function pushSpan(spans: OutputSpan[], span: OutputSpan): void {
  const previous = spans[spans.length - 1];
  if (previous !== undefined && previous.style === span.style) {
    spans[spans.length - 1] = { text: previous.text + span.text, style: span.style };
    return;
  }
  spans.push(span);
}
