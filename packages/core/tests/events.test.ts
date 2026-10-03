import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appearanceEvent,
  arrivedEvent,
  commandRefusedEvent,
  customCode,
  customEvent,
  departedEvent,
  sayEvent,
  stampEvent,
} from "../src/events.js";
import type { EventDraft, GameEvent } from "../src/index.js";
import type { ExpectedEvent } from "../src/command/testing.js";

/**
 * The event construction face (issues #41 + #47, spec/01 §5): one factory per
 * engine event type — commandRefused / say / appearance / departed / arrived —
 * plus the extension arm customEvent(type, fields) for synthetic and host
 * events, plus stampEvent, the one construction where a draft becomes a
 * delivered event. The factory unifies ONLY `type`, and stamps it last; the
 * skeleton (seq/actorId/tick) belongs to the stampers (the pipeline stamps
 * its command's seq/actorId and the now it saw, spec/01 §2.2 and §5.0; the
 * settler stamps the due tick, ADR-0034 §3) and is never invented here — a
 * factory returns exactly the fields handed in plus the type.
 *
 * #47 tightens what a factory ACCEPTS: each takes its arm's own field type,
 * so a misspelled engine field, a smuggled `type` or a skeleton key is a
 * compile error (the pins at the bottom hold it). `customEvent`'s fields
 * stay wide on purpose.
 */

describe("the per-type factories (construction in one place — type is the only field they unify)", () => {
  it('commandRefusedEvent stamps type "commandRefused" and carries the refusal semantics verbatim', () => {
    const draft = commandRefusedEvent({
      reason: "accessDenied",
      commandKey: "cmd-look",
      accessType: "look",
      errKey: "err_default",
      roomId: "room-1",
    });
    expect(draft).toEqual({
      type: "commandRefused",
      reason: "accessDenied",
      commandKey: "cmd-look",
      accessType: "look",
      errKey: "err_default",
      roomId: "room-1",
    });
  });

  it("carries the minimal pre-veto shape — type plus reason, nothing invented", () => {
    expect(commandRefusedEvent({ reason: customCode("gateClosed") })).toEqual({
      type: "commandRefused",
      reason: customCode("gateClosed"),
    });
  });

  it('sayEvent stamps type "say" and carries the spoken data verbatim', () => {
    expect(
      sayEvent({ speakerId: "pc-1", text: "hello", locationId: "room-1" }),
    ).toEqual({ type: "say", speakerId: "pc-1", text: "hello", locationId: "room-1" });
  });

  it('appearanceEvent stamps type "appearance" and carries the room digest verbatim', () => {
    expect(
      appearanceEvent({
        roomId: "room-1",
        exits: [{ exitId: "exit-north", direction: "北", verbs: ["北"] }],
        staticPresence: [{ id: "npc-1", count: 1 }],
        occupants: ["pc-2"],
      }),
    ).toEqual({
      type: "appearance",
      roomId: "room-1",
      exits: [{ exitId: "exit-north", direction: "北", verbs: ["北"] }],
      staticPresence: [{ id: "npc-1", count: 1 }],
      occupants: ["pc-2"],
    });
  });

  it("departedEvent and arrivedEvent stamp their own types over the same move semantics", () => {
    const move = {
      entityId: "pc-1",
      fromLocationId: "room-1",
      toLocationId: "room-2",
      moveType: "traverse",
      viaExitId: "exit-north",
    } as const;
    expect(departedEvent(move)).toEqual({ type: "departed", ...move });
    expect(arrivedEvent(move)).toEqual({ type: "arrived", ...move });
  });
});

describe("the factory owns `type`", () => {
  it("a type smuggled into fields never wins — the stamp is the factory's alone", () => {
    // Smuggled through a spread on purpose: a literal `type` in fields is a
    // COMPILE error now (the pin below), and the spread is the non-literal
    // path no pin sees — so this stays the runtime half of the same claim.
    const smuggled: Record<string, unknown> = { type: "bogus", marker: 1 };
    const builds: Array<[EventDraft, string]> = [
      [commandRefusedEvent({ ...smuggled, reason: "accessDenied" }), "commandRefused"],
      [sayEvent({ ...smuggled, speakerId: "pc-1", text: "hi", locationId: "room-1" }), "say"],
      [
        appearanceEvent({
          ...smuggled,
          roomId: "room-1",
          exits: [],
          staticPresence: [],
          occupants: [],
        }),
        "appearance",
      ],
      [
        departedEvent({
          ...smuggled,
          entityId: "pc-1",
          fromLocationId: "room-1",
          toLocationId: "room-2",
          moveType: "traverse",
        }),
        "departed",
      ],
      [
        arrivedEvent({
          ...smuggled,
          entityId: "pc-1",
          fromLocationId: "room-1",
          toLocationId: "room-2",
          moveType: "traverse",
        }),
        "arrived",
      ],
    ];
    for (const [draft, type] of builds) {
      expect(draft.type).toBe(type);
    }
  });

  it("customEvent's type argument wins over any type in fields", () => {
    expect(customEvent("pong", { type: "say" })).toEqual({ type: "pong" });
  });
});

describe("the factory returns a fresh object", () => {
  it("never aliases or rewrites the caller's fields, and adds no key beyond `type`", () => {
    const fields = { speakerId: "pc-1", text: "hi", locationId: "room-1" };
    const snapshot = { ...fields };
    const draft = sayEvent(fields);
    expect(draft).not.toBe(fields);
    expect(fields).toEqual(snapshot);
    // Exact key set — `toEqual` alone would let an injected `foo: undefined`
    // through (vitest's equals ignores keys whose value is undefined).
    expect([...Object.keys(draft)].sort()).toEqual([...Object.keys(fields), "type"].sort());
  });
});

describe("the skeleton is stamped downstream (EventDraft contract, spec/01 §2.2 + §5.0)", () => {
  it("no factory injects seq/actorId/tick — the draft is exactly fields plus type", () => {
    const draft = sayEvent({ speakerId: "pc-1", text: "hi", locationId: "room-1" });
    expect(draft).toEqual({ type: "say", speakerId: "pc-1", text: "hi", locationId: "room-1" });
    for (const key of ["seq", "actorId", "tick"]) {
      expect(key in draft).toBe(false);
    }
    for (const draft2 of [
      commandRefusedEvent({ reason: customCode("gateClosed") }),
      appearanceEvent({ roomId: "room-1", exits: [], staticPresence: [], occupants: [] }),
      departedEvent({ entityId: "pc-1", fromLocationId: "room-1", toLocationId: "room-2", moveType: "traverse", viaExitId: null }),
      arrivedEvent({ entityId: "pc-1", fromLocationId: "room-1", toLocationId: "room-2", moveType: "traverse", viaExitId: null }),
      customEvent("pong"),
    ]) {
      for (const key of ["seq", "actorId", "tick"]) {
        expect(key in draft2).toBe(false);
      }
    }
  });
});

describe("customEvent — the extension arm's construction point", () => {
  it("carries free fields verbatim under the caller's type", () => {
    expect(customEvent("worldSettled", { span: 5, layer: "world" })).toEqual({
      type: "worldSettled",
      span: 5,
      layer: "world",
    });
  });

  it("allows a bare synthetic event with no semantic fields", () => {
    expect(customEvent("pong")).toEqual({ type: "pong" });
  });

  it("a free field on the extension arm is open carrying — a typo is the deliberate cost (no pin here)", () => {
    // Deliberately NOT a @ts-expect-error pin: the extension arm carries
    // content freedom, so a misspelled free field compiles by design. What
    // is pinned is the skeleton and the ENGINE arms (below).
    expect(customEvent("damageDealt", { ammount: 12 })).toEqual({
      type: "damageDealt",
      ammount: 12,
    });
  });
});

describe("stampEvent — the one construction where a draft becomes a delivered event", () => {
  it("adds exactly the skeleton, and the skeleton wins over a draft's own keys", () => {
    const draft: EventDraft = customEvent("exploded", {
      seq: 99,
      actorId: "forged",
      tick: -1,
      blast: 3,
    });
    const event = stampEvent(draft, { seq: 2, tick: 300, actorId: "" });
    expect(event).toEqual({ seq: 2, tick: 300, actorId: "", type: "exploded", blast: 3 });
    expect(Object.keys(event).sort()).toEqual(["actorId", "blast", "seq", "tick", "type"]);
  });

  it("keeps engine drafts and custom drafts alike — no value is ever altered", () => {
    const fields = {
      reason: "accessDenied",
      commandKey: "cmd-look",
      errKey: "err_use",
    } as const;
    const event = stampEvent(commandRefusedEvent(fields), {
      seq: 7,
      tick: 40,
      actorId: "jia",
    });
    expect(event).toEqual({ ...fields, type: "commandRefused", seq: 7, tick: 40, actorId: "jia" });
  });
});

describe("compile-time pins (typecheck-only — `@ts-expect-error` is the assertion)", () => {
  it("rejects a misspelled engine-arm field, a smuggled type and a skeleton key", () => {
    // Each call is ONE line so the directive binds to the whole call; the
    // runtime calls are harmless constructions. If any face loosens, the
    // now-unused directive makes typecheck itself go red.
    // @ts-expect-error — engine arm fields are spelled for you (commandKey)
    commandRefusedEvent({ reason: "accessDenied", comandKey: "cmd-look" });
    // @ts-expect-error — `type` is the factory's alone, never a field's
    commandRefusedEvent({ reason: "accessDenied", type: "say" });
    // @ts-expect-error — the skeleton is the stampers' to give, never a factory's
    commandRefusedEvent({ reason: "accessDenied", seq: 1 });
    // @ts-expect-error — say's fields are speakerId/text/locationId
    sayEvent({ speakerId: "pc-1", text: "hi", location: "room-1" });
    // @ts-expect-error — an exit digest carries exitId/direction/verbs
    appearanceEvent({ roomId: "room-1", exits: [{ id: "x" }], staticPresence: [], occupants: [] });
    // @ts-expect-error — moveType is the engine's fixed vocabulary
    departedEvent({ entityId: "pc-1", fromLocationId: "room-1", toLocationId: "room-2", moveType: "walked" });
    // @ts-expect-error — the skeleton is not a factory field here either
    arrivedEvent({ entityId: "pc-1", fromLocationId: "room-1", toLocationId: "room-2", moveType: "traverse", tick: 3 });
    // @ts-expect-error — a bare string is not a semantic code; customCode() brands it
    commandRefusedEvent({ reason: "gateClosed" });
  });

  it("keeps a hand-written literal out of every arm — the extension arm is brand-only", () => {
    // @ts-expect-error — no brand: a bare literal matches neither arm of ExpectedEvent
    const expectation: ExpectedEvent = { type: "pong" };
    // @ts-expect-error — and a deliverable GameEvent cannot be typed up by hand
    const delivered: GameEvent = { seq: 1, tick: 0, actorId: "jia", type: "pong" };
    // @ts-expect-error — a COMPLETE engine arm plus one typo'd field slips into
    // no arm either: the extension arm's open carrying lives at construction
    // only (an index signature here would waive the union's excess check and
    // let this literal land in `say` — measured, see types.ts).
    const typoArm: GameEvent = { seq: 1, tick: 0, actorId: "jia", type: "say", speakerId: "s", text: "t", locationId: "r", textt: "hi" };
    // @ts-expect-error — an expectation pins spelled fields only, same law
    const typoExpectation: ExpectedEvent = { type: "say", textt: "hi" };
    expect(expectation).toBeDefined();
    expect(delivered).toBeDefined();
    expect(typoArm).toBeDefined();
    expect(typoExpectation).toBeDefined();
  });
});

describe("the delivery claim has one owner (src scan)", () => {
  it("finds no cast to a GameEvent/brand face outside events.ts — laundering a draft into an arm is stampEvent's alone", () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        // Same full-path exemption as the scan above: events.ts IS the owner.
        if (path === join(srcRoot, "events.ts")) continue;
        const pattern = /as (?:unknown as )?(?:GameEvent|CustomEvent|CustomEventDraft|CustomCode)(?![A-Za-z])/g;
        for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
          offenders.push(`${path.slice(srcRoot.length + 1)}: ${match[0]}`);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe("engine construction stays in one place (src scan)", () => {
  it("finds no hand-spliced event construction in core src outside events.ts — any type, not just today's five", () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        // Skip by FULL PATH: a basename exemption would silently cover a
        // future `world/events.ts` wholesale.
        if (path === join(srcRoot, "events.ts")) continue;
        // `[{,]` precedes an object-literal stamp (a param ANNOTATION is
        // preceded by `(` — `type: "departed" | "arrived"` stays out) and the
        // `(?=…)` demands the quote run end at a comma or brace (an `as const`
        // between them is allowed) — a `;`-terminated run is a TYPE position
        // (`{ type: "departed"; }` in types.ts), which cannot be a value
        // literal, so it stays out too. ANY type string, not a closed list:
        // "construction in one place" must hold for the engine event type
        // added next year too (a NON-event `type:` literal would need its own
        // documented exemption here). Documented blind spots: template or
        // computed values (`type: \`${x}\``, `type: someVar`), quoted
        // template forms, and post-hoc assignment (`.type = "x"`) — only a
        // literal stamp is this scan's claim.
        const pattern = /[{,]\s*["']?type["']?\s*:\s*["'][^"']*["'](?=\s*(?:as\s+const\s*)?[,}])/g;
        for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
          offenders.push(`${path.slice(srcRoot.length + 1)}: ${match[0]}`);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
