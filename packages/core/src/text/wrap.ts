/**
 * The folding half of the text surface (spec/05 §5.2, B8 in
 * docs/chinese-mud-concerns.md): a Chinese line may break between ANY two
 * characters — there are no spaces to honour — except where the kinsoku
 * tables (kinsoku, the line-start/line-end rules) forbid it. B8 is a bound
 * acceptance condition: the tables
 * are consulted WHILE deciding the fold, never applied as a post-pass —
 * "fold naive, patch later" is the rewrite of the folder's core that the
 * checklist exists to prevent.
 *
 * The tables below are the first draft #50's acceptance criteria name (B8
 * authorizes implementation-time adjustment): line-START forbiddens are the
 * closing-punctuation family plus the dash's second half; line-END
 * forbiddens are the opening-punctuation family plus the dash's first half;
 * dash pairs and ellipsis pairs are ATOMIC (never split). The fullwidth
 * question mark joins the start-side list as the same-family completion the
 * authorization covers. Characters are written as escapes on purpose: the
 * engine-purity scan bans CJK beyond the parser's grammar charset in src/,
 * and this table is classification data, not prose.
 *
 * The algorithm is greedy with pull-back, over atomic units from the width
 * module: fill a line until the next unit would overflow, then walk the cut
 * point backwards past any position the tables forbid, and if every
 * position is forbidden (an unbreakable run of punctuation), keep the naive
 * cut — progress beats kinsoku, or the folder would loop forever. A unit
 * wider than the whole limit (a four-column dash pair at width two) gets a
 * line of its own for the same reason.
 */

import { lineOf, pushSpan } from "./line.js";
import type { OutputLine, OutputSpan, StyleName } from "./line.js";
import { splitUnits } from "./width.js";

/**
 * May not OPEN a line (line-start rule): closing punctuation, the ellipsis, the
 * wave dash — and a lone dash, whose pair may follow.
 */
const LINE_START_FORBIDDEN: ReadonlySet<string> = new Set([
  "\u3002", // ideographic full stop
  "\u3001", // ideographic comma
  "\uff0c", // fullwidth comma
  "\uff1b", // fullwidth semicolon
  "\uff1a", // fullwidth colon
  "\uff01", // fullwidth exclamation mark
  "\uff1f", // fullwidth question mark (same-family completion, B8)
  "\u300d", // right corner bracket
  "\u300f", // right white corner bracket
  "\uff09", // fullwidth right parenthesis
  "\u3015", // right tortoise shell bracket
  "\u2026", // ellipsis
  "\uff5e", // fullwidth tilde
  "\u2014", // em dash (a lone half; the pair is atomic below)
]);

/** May not CLOSE a line (line-end rule): opening punctuation and a lone dash. */
const LINE_END_FORBIDDEN: ReadonlySet<string> = new Set([
  "\u300c", // left corner bracket
  "\u300e", // left white corner bracket
  "\uff08", // fullwidth left parenthesis
  "\u3014", // left tortoise shell bracket
  "\u300a", // left double angle bracket
  "\u2014", // em dash
]);

const DASH = "\u2014";
const ELLIPSIS = "\u2026";

/** One fold-decision unit: a width unit plus its style and kinsoku flags. */
interface FoldUnit {
  readonly text: string;
  readonly width: number;
  readonly style: StyleName;
  readonly noLineStart: boolean;
  readonly noLineEnd: boolean;
}

/**
 * Splits a line into fold units: the width module's atomic units, each
 * carrying its span's style, with dash pairs and ellipsis pairs grouped
 * (they never split) and the kinsoku flags derived mechanically from the
 * tables — a pair carries both halves' rules, a lone member its own.
 */
function foldUnits(line: OutputLine): FoldUnit[] {
  const units: FoldUnit[] = [];
  for (const span of line.spans) {
    for (const unit of splitUnits(span.text)) {
      units.push({
        text: unit.text,
        width: unit.width,
        style: span.style,
        noLineStart: LINE_START_FORBIDDEN.has(firstRune(unit.text)),
        noLineEnd: LINE_END_FORBIDDEN.has(lastRune(unit.text)),
      });
    }
  }
  // Group the pairs — AFTER the flag pass, so a pair inherits both halves'
  // rules from its own first/last characters (a dash pair: no start, no end;
  // an ellipsis pair: no start, may end). A pair straddling a span boundary
  // keeps the FIRST half's style: pathological input, and the tiling
  // invariant survives either way.
  const grouped: FoldUnit[] = [];
  for (const unit of units) {
    const previous = grouped[grouped.length - 1];
    if (
      (unit.text === DASH && previous?.text === DASH) ||
      (unit.text === ELLIPSIS && previous?.text === ELLIPSIS)
    ) {
      grouped[grouped.length - 1] = {
        text: previous.text + unit.text,
        width: previous.width + unit.width,
        style: previous.style,
        noLineStart: previous.noLineStart || unit.noLineStart,
        noLineEnd: previous.noLineEnd || unit.noLineEnd,
      };
      continue;
    }
    grouped.push(unit);
  }
  return grouped;
}

function firstRune(text: string): string {
  return [...text][0] ?? "";
}

function lastRune(text: string): string {
  const runes = [...text];
  return runes[runes.length - 1] ?? "";
}

/**
 * Folds one logical line to physical lines of at most `limit` display
 * columns, deciding every cut with the kinsoku tables at hand (B8). Spans
 * are rebuilt per physical line as complete tilings — a span straddling the
 * cut is closed by the line's end and reopened on the next (spec/05 §6),
 * and adjacent same-style segments merge back into one span.
 */
export function foldLine(line: OutputLine, limit: number): OutputLine[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`foldLine: limit must be a positive integer of columns, got ${limit}`);
  }
  const units = foldUnits(line);
  if (units.length === 0) {
    return [line];
  }

  const physical: OutputLine[] = [];
  let current: FoldUnit[] = [];
  let currentWidth = 0;

  const emit = (): void => {
    physical.push(lineOf(mergeSpans(current)));
    current = [];
    currentWidth = 0;
  };

  let i = 0;
  while (i < units.length) {
    const unit = units[i] as FoldUnit;
    if (current.length > 0 && currentWidth + unit.width > limit) {
      // Decide the cut: start at the naive position (before `unit`) and walk
      // back while the tables forbid the candidate.
      let cut = current.length;
      while (cut > 0) {
        const nextFirst = cut === current.length ? unit : (current[cut] as FoldUnit);
        if (!nextFirst.noLineStart && !(current[cut - 1] as FoldUnit).noLineEnd) {
          break;
        }
        cut--;
      }
      // Every position forbidden, or a lone too-wide unit: cut anyway —
      // progress beats kinsoku (and keeps a wider-than-limit unit to one
      // line of its own below, because the empty line takes any unit).
      if (cut === 0) {
        cut = current.length;
      }
      const stay = current.slice(0, cut);
      const deferred = current.slice(cut);
      current = stay;
      emit();
      current = deferred;
      currentWidth = current.reduce((total, u) => total + u.width, 0);
      continue; // re-examine the same unit against the pulled-back line
    }
    current.push(unit);
    currentWidth += unit.width;
    i++;
  }
  if (current.length > 0) {
    emit();
  }
  return physical;
}

/** Merges adjacent same-style units back into single spans (line.pushSpan). */
function mergeSpans(units: readonly FoldUnit[]): OutputSpan[] {
  const spans: OutputSpan[] = [];
  for (const unit of units) {
    pushSpan(spans, { text: unit.text, style: unit.style });
  }
  return spans;
}
