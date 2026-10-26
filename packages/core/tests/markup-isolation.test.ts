import { describe, expect, it } from "vitest";
import { markupKey, matchMarkupTokens } from "../src/text/markup.js";
import { sanitizePlayerInput } from "../src/input/sanitize.js";
import { sayEvent, stampEvent } from "../src/events.js";
import type { EventSkeleton } from "../src/types.js";
import { renderEvent } from "../src/text/render.js";
import type { RenderContent } from "../src/text/render.js";

/**
 * THE constructive-isolation pin (issue #54 AC, spec/05 §8.2 ★): the set of
 * code points a player can reach (anything that survives the input gate)
 * and the engine's markup alphabet (markupKey's NUL) are DISJOINT — not by
 * a regex standing guard, but by construction: the markup's own code points
 * are Cc, and the gate drops every Cc/Cf code point before the engine sees
 * a line. The assertions below feed a markup token itself through the gate
 * and walk the WHOLE code point space, so the disjointness cannot regress
 * into "the samples pass" while a range leaks.
 */

const SKELETON: EventSkeleton = { seq: 1, tick: 1, actorId: "player-1" };

const CONTENT: RenderContent = {
  copy: {
    you: "你",
    sayLine: "",
    departedLine: "",
    arrivedLine: "",
    appearanceTitle: "",
    appearanceExits: "",
    presenceRow: "",
    appearanceItems: "",
    appearancePeople: "",
    listJoin: "",
  },
  names: {},
  descriptions: {},
  enterTexts: {},
  errCopy: {},
  reasonCopy: {},
};

describe("markup isolation (§8.2 ★, constructive)", () => {
  it("markup tokens are NUL-wrapped — markupKey is the one factory shape", () => {
    expect(markupKey("speaker")).toBe("\x00speaker\x00");
  });

  it("the factory and the recogniser answer each other (one alphabet home)", () => {
    const match = matchMarkupTokens(markupKey("speaker")).next().value as RegExpMatchArray;
    expect(match[1]).toBe("speaker");
    expect([...matchMarkupTokens("plain text")]).toEqual([]);
  });

  it("a markup token fed to the input gate loses its markup: the player cannot type it", () => {
    // THE constructive assertion: the wrapper is Cc, the gate drops Cc —
    // what survives of a markup token is its bare key text, plain data.
    expect(sanitizePlayerInput(markupKey("speaker"), 200)).toBe("speaker");
    expect(sanitizePlayerInput(`甲${markupKey("mover")}乙`, 200)).toBe("甲mover乙");
  });

  it("the whole code point space: nothing the gate keeps is a markup code point", () => {
    // Every legal code point (the surrogate range is not code points) in
    // one line, through the gate with the cap wide open: NUL must not
    // survive — that IS the disjointness. The exact strip COUNT is pinned
    // against the runtime's own category tables in input-sanitize.test.ts
    // (the \p oracle); here only the 65 Cc code points' worth is assumed,
    // NUL among them, as the markup alphabet's home.
    const every: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      every.push(String.fromCodePoint(cp));
    }
    const kept = sanitizePlayerInput(every.join(""), 0x110000);
    expect(kept.includes("\x00")).toBe(false);
    // Background closure: exactly Cc 65 + Cf 170 fall (Unicode 16.0). A
    // runtime Unicode bump that grows either category turns this red — the
    // cue to re-transcribe the tables (the \p oracle in input-sanitize
    // pins them against the runtime).
    expect([...kept].length).toBe(every.length - 65 - 170);
  });

  it("a bare {key} in a template is plain text since #54 — the old alphabet retired", () => {
    // A template accidentally written in the pre-#54 shape must not
    // substitute: the recogniser answers only markupKey's shape, so the
    // retired braces render as the literal text the host wrote.
    const lines = renderEvent(
      stampEvent(sayEvent({ speakerId: "p", text: "喂", locationId: "r" }), SKELETON),
      { observerId: "p" },
      { ...CONTENT, copy: { ...CONTENT.copy, sayLine: "{speaker}说：{text}" } },
    );
    expect(lines.map((line) => line.text)).toEqual(["{speaker}说：{text}"]);
  });
});
