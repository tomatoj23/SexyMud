/**
 * The rendering half of the text surface (spec/05 §2–§4, issue #50; the
 * combat arms #56): the engine's eight event types as PURE functions of
 * (event, observer, injected content) — same event, same observer, same
 * content, same lines (ADR-0017). Rendering happens per receiver, never
 * render-then-broadcast: Chinese stance (the second-person pronoun for the
 * actor, a name for everyone else, spec/05 §3) cannot
 * be recovered from an already-rendered string.
 *
 * The engine owns the MECHANISM — stance resolution, template substitution,
 * span structure — and not one word. Every string a line shows comes from
 * the injected content face (Q6/Q7, #48): sentence templates and the
 * pronoun (copy), display names (names), room descriptions and enter texts,
 * and the refusal copy located by (commandKey, errKey) or by reason code
 * (spec/02 §5.4 — a refusal is content). That keeps the renderer pure (zero
 * IO, zero registry reads) and the engine-purity scan honest: not a single
 * CJK character lives in src/.
 *
 * Degradation is visible, not silent: a name the table lacks renders as the
 * raw id, a description or enter text the table lacks skips its line, and a
 * refusal NO table covers throws — a wiring miss the host can see. A typo'd
 * placeholder in a template stays visible in the output for the same
 * reason.
 */

import { lineOf, pushSpan } from "./line.js";
import type { OutputLine, OutputSpan } from "./line.js";
import { isEngineEvent } from "../events.js";
import { matchMarkupTokens } from "./markup.js";
import type {
  AppearanceEvent,
  ArrivedEvent,
  CommandRefusedEvent,
  DeathEvent,
  DepartedEvent,
  DotTickEvent,
  SayEvent,
  StrikeEvent,
} from "../types.js";
import type { GameEvent } from "../types.js";

/** The pronoun and sentence templates — the pack's voice (injected, Q6). */
export interface RenderCopy {
  /** The second-person pronoun an actor's own events read as. */
  readonly you: string;
  /** A say line. Placeholders (markupKey): speaker, text. */
  readonly sayLine: string;
  /** A departure line. Placeholders (markupKey): mover, from, to, exit. */
  readonly departedLine: string;
  /** An arrival line. Placeholders (markupKey): mover, from, to, exit. */
  readonly arrivedLine: string;
  /** The look title line. Placeholders (markupKey): name. */
  readonly appearanceTitle: string;
  /** The look exits line. Placeholders (markupKey): exits. */
  readonly appearanceExits: string;
  /** One placed-entity row. Placeholders (markupKey): name, count. */
  readonly presenceRow: string;
  /** The placed-entities line. Placeholders (markupKey): items. */
  readonly appearanceItems: string;
  /** The occupants line. Placeholders (markupKey): people. */
  readonly appearancePeople: string;
  /**
   * The combat kernel's fixed templates (#56, T7: C1's minimal face lives
   * with the HOST — the keys are the engine's mechanism vocabulary, the
   * words are the host's; a later combat-text slice owns moving the words
   * into content). Placeholders (markupKey): attacker, defender, damage.
   */
  readonly strikeHit: string;
  /** A dodged strike (the defender slipped it). Placeholders: attacker, defender. */
  readonly strikeDodge: string;
  /** The retaliation landing on the player. Placeholders: attacker, damage. */
  readonly strikeTake: string;
  /** One poison pulse. Placeholders: target, damage, applied, total. */
  readonly dotTickLine: string;
  /** An npc death. Placeholders: deceased. */
  readonly deathNpcLine: string;
  /** The player's own death. Placeholders: deceased. */
  readonly deathPlayerLine: string;
  /** The joiner between enumeration members. */
  readonly listJoin: string;
}

/**
 * Everything a render may read from the pack and the host, by id — the
 * injected face Q6/Q7 named. Plain data, no functions, no IO: the host
 * builds it once from its registry and its player state.
 */
export interface RenderContent {
  readonly copy: RenderCopy;
  /** id → display name, for any id a line may mention; unknown id → the id. */
  readonly names: Readonly<Record<string, string>>;
  /** roomId → long description; absent → the description line is skipped. */
  readonly descriptions: Readonly<Record<string, string>>;
  /** roomId → enter text (Q7); absent → the arrival appends no narrative beat. */
  readonly enterTexts: Readonly<Record<string, string>>;
  /** commandKey → errKey → the entry's err_* refusal copy. */
  readonly errCopy: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** reason code → refusal copy, for refusals no entry locates. */
  readonly reasonCopy: Readonly<Record<string, string>>;
}

/** Whose eyes a render is for — the per-receiver walk's one input. */
export interface ObserverState {
  readonly observerId: string;
}

/**
 * Renders one event for one observer. The eight engine types each render
 * their lines — the five command/world types since #50, the combat kernel's
 * three since #56 (spec/05 §2's rendering seam closed with the mechanism
 * module that owns the shapes); the extension arm renders NOTHING by
 * explicit decision (#48 D6) — an explicit branch, not a fallthrough.
 */
export function renderEvent(
  event: GameEvent,
  observer: ObserverState,
  content: RenderContent,
): OutputLine[] {
  if (!isEngineEvent(event)) {
    // customEvent: rendered by nobody, ON PURPOSE (#48 D6) — a host event
    // is worded by its own consumer at the session layer (the flagGranted
    // precedent, #56 T1), never by this engine-side renderer.
    return [];
  }
  switch (event.type) {
    case "say":
      return [sayLine(event, observer, content)];
    case "appearance":
      return appearanceLines(event, content);
    case "departed":
      return [moveLine(event, observer, content, content.copy.departedLine)];
    case "arrived":
      return arrivedLines(event, observer, content);
    case "commandRefused":
      return [refusalLine(event, content)];
    case "strike":
      return [strikeLine(event, observer, content)];
    case "dotTick":
      return [dotTickLine(event, observer, content)];
    case "death":
      return [deathLine(event, observer, content)];
  }
}

/** Display name of an id: the table's entry, or the honest raw id. */
function nameOf(content: RenderContent, id: string): string {
  return content.names[id] ?? id;
}

/** The name a line mentions an entity by: the pronoun for the observer's own action. */
function stanceName(content: RenderContent, observer: ObserverState, actorId: string): string {
  return actorId === observer.observerId ? content.copy.you : nameOf(content, actorId);
}

/** Splits a template into spans: literals plain, markup tokens the part's spans. */
function templateSpans(
  template: string,
  parts: Readonly<Record<string, readonly OutputSpan[]>>,
): OutputSpan[] {
  const spans: OutputSpan[] = [];
  let at = 0;
  // Only markupKey's NUL-wrapped shape is a placeholder (#54, spec/05 §8.2):
  // the player-unreachable alphabet IS the isolation — a bare {key} in a
  // template has been plain text since #54. The walk comes from markup.ts,
  // so the alphabet changes move the factory and the recogniser together.
  for (const match of matchMarkupTokens(template)) {
    const index = match.index as number;
    if (index > at) {
      pushSpan(spans, { text: template.slice(at, index), style: "plain" });
    }
    const part = parts[match[1] as string];
    if (part === undefined) {
      // A placeholder no part answers stays visible — the host's typo, shown.
      pushSpan(spans, { text: match[0], style: "plain" });
    } else {
      for (const span of part) {
        pushSpan(spans, span);
      }
    }
    at = index + match[0].length;
  }
  if (at < template.length) {
    pushSpan(spans, { text: template.slice(at), style: "plain" });
  }
  return spans;
}

function sayLine(
  event: SayEvent,
  observer: ObserverState,
  content: RenderContent,
): OutputLine {
  return lineOf(
    templateSpans(content.copy.sayLine, {
      speaker: [{ text: stanceName(content, observer, event.speakerId), style: "npcName" }],
      text: [{ text: event.text, style: "plain" }],
    }),
  );
}

/** The movement templates' shared placeholders, stance included. */
function moveParts(
  event: DepartedEvent | ArrivedEvent,
  observer: ObserverState,
  content: RenderContent,
): Readonly<Record<string, readonly OutputSpan[]>> {
  return {
    mover: [{ text: stanceName(content, observer, event.entityId), style: "npcName" }],
    from: [{ text: nameOf(content, event.fromLocationId), style: "plain" }],
    to: [{ text: nameOf(content, event.toLocationId), style: "plain" }],
    exit: [
      {
        // Absent (null or missing) names no exit: the placeholder renders
        // empty and the copy's template decides whether to mention one.
        text: event.viaExitId != null ? nameOf(content, event.viaExitId) : "",
        style: "commandHint",
      },
    ],
  };
}

function moveLine(
  event: DepartedEvent | ArrivedEvent,
  observer: ObserverState,
  content: RenderContent,
  template: string,
): OutputLine {
  return lineOf(templateSpans(template, moveParts(event, observer, content)));
}

function arrivedLines(
  event: ArrivedEvent,
  observer: ObserverState,
  content: RenderContent,
): OutputLine[] {
  const lines = [moveLine(event, observer, content, content.copy.arrivedLine)];
  const enterText = content.enterTexts[event.toLocationId];
  if (enterText !== undefined && enterText !== "") {
    // Q7: the destination's arrival narrative rides in with the content
    // face, straight after the sentence — the event carries only ids.
    lines.push(lineOf([{ text: enterText, style: "plain" }]));
  }
  return lines;
}

function appearanceLines(
  event: AppearanceEvent,
  content: RenderContent,
): OutputLine[] {
  const lines: OutputLine[] = [
    lineOf(
      templateSpans(content.copy.appearanceTitle, {
        name: [{ text: nameOf(content, event.roomId), style: "roomName" }],
      }),
    ),
  ];
  const description = content.descriptions[event.roomId];
  if (description !== undefined && description !== "") {
    lines.push(lineOf([{ text: description, style: "plain" }]));
  }
  if (event.exits.length > 0) {
    lines.push(
      lineOf(
        templateSpans(content.copy.appearanceExits, {
          exits: [
            {
              text: event.exits.map((exit) => exit.direction).join(content.copy.listJoin),
              style: "commandHint",
            },
          ],
        }),
      ),
    );
  }
  if (event.staticPresence.length > 0) {
    const rows = event.staticPresence.map((placement) =>
      templateSpans(content.copy.presenceRow, {
        name: [{ text: nameOf(content, placement.id), style: "itemName" }],
        count: [{ text: String(placement.count), style: "plain" }],
      }),
    );
    lines.push(
      lineOf(
        templateSpans(content.copy.appearanceItems, {
          items: rows.reduce<OutputSpan[]>((joined, row, at) => {
            if (at > 0) {
              pushSpan(joined, { text: content.copy.listJoin, style: "plain" });
            }
            for (const span of row) {
              pushSpan(joined, span);
            }
            return joined;
          }, []),
        }),
      ),
    );
  }
  if (event.occupants.length > 0) {
    lines.push(
      lineOf(
        templateSpans(content.copy.appearancePeople, {
          people: [
            {
              text: event.occupants.map((id) => nameOf(content, id)).join(content.copy.listJoin),
              style: "npcName",
            },
          ],
        }),
      ),
    );
  }
  return lines;
}

function refusalLine(
  event: CommandRefusedEvent,
  content: RenderContent,
): OutputLine {
  const entryCopy =
    event.commandKey !== undefined && event.errKey !== undefined
      ? content.errCopy[event.commandKey]?.[event.errKey]
      : undefined;
  const text = entryCopy ?? content.reasonCopy[event.reason];
  if (text === undefined) {
    // Neither face covered this refusal: the host's copy table is wired
    // short. Loud beats a silently missing line.
    throw new Error(
      `renderEvent: no refusal copy for reason "${event.reason}" (commandKey ` +
        `"${event.commandKey ?? "-"}", errKey "${event.errKey ?? "-"}") — the injected copy face does not cover it`,
    );
  }
  return lineOf([{ text, style: "danger" }]);
}

/**
 * One strike, from the observer's stance (#56, T7's fixed templates): the
 * observer being hit reads strikeTake ("…you take N"), everyone else — the
 * attacker themselves AND any third party — reads strikeHit with names
 * substituted (the two-sided law of the movement lines; a bystander is a
 * name-reading party to BOTH sides, the same as moveLine's mover).
 */
function strikeLine(
  event: StrikeEvent,
  observer: ObserverState,
  content: RenderContent,
): OutputLine {
  const attacker = stanceName(content, observer, event.attackerId);
  const defender = stanceName(content, observer, event.defenderId);
  const damage = [{ text: String(event.damage), style: "plain" }] as const;
  if (event.isDodge) {
    return lineOf(
      templateSpans(content.copy.strikeDodge, {
        attacker: [{ text: attacker, style: "npcName" }],
        defender: [{ text: defender, style: "npcName" }],
      }),
    );
  }
  if (event.defenderId === observer.observerId) {
    return lineOf(
      templateSpans(content.copy.strikeTake, {
        attacker: [{ text: attacker, style: "npcName" }],
        damage,
      }),
    );
  }
  return lineOf(
    templateSpans(content.copy.strikeHit, {
      attacker: [{ text: attacker, style: "npcName" }],
      defender: [{ text: defender, style: "npcName" }],
      damage,
    }),
  );
}

/** One poison pulse: who, how much, how far into the instance. */
function dotTickLine(
  event: DotTickEvent,
  observer: ObserverState,
  content: RenderContent,
): OutputLine {
  return lineOf(
    templateSpans(content.copy.dotTickLine, {
      target: [{ text: stanceName(content, observer, event.targetId), style: "npcName" }],
      damage: [{ text: String(event.damage), style: "plain" }],
      applied: [{ text: String(event.pulsesApplied), style: "plain" }],
      total: [{ text: String(event.pulsesTotal), style: "plain" }],
    }),
  );
}

/** One death: the two sides read their own templates, the deceased by stance. */
function deathLine(
  event: DeathEvent,
  observer: ObserverState,
  content: RenderContent,
): OutputLine {
  const template = event.kind === "player" ? content.copy.deathPlayerLine : content.copy.deathNpcLine;
  return lineOf(
    templateSpans(template, {
      deceased: [{ text: stanceName(content, observer, event.deceasedId), style: "npcName" }],
    }),
  );
}
