import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appearanceEvent,
  arrivedEvent,
  commandRefusedEvent,
  customEvent,
  departedEvent,
  sayEvent,
} from "../src/events.js";

/**
 * The event construction face (issue #41, spec/01 §5): one factory per engine
 * event type — commandRefused / say / appearance / departed / arrived — plus
 * the extension arm customEvent(type, fields) for synthetic and host events.
 * The factory unifies ONLY `type`, and stamps it last; the skeleton
 * (seq/actorId/tick) belongs to the stampers (the pipeline stamps its
 * command's seq/actorId and the now it saw, spec/01 §2.2 and §5.0; the
 * settler stamps the due tick, ADR-0034 §3) and is never invented here — a
 * factory returns exactly the fields handed in plus the type.
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
    expect(commandRefusedEvent({ reason: "gateClosed" })).toEqual({
      type: "commandRefused",
      reason: "gateClosed",
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
        exits: [{ id: "exit-north" }],
        staticPresence: [{ id: "npc-1" }],
        occupants: [{ id: "pc-2" }],
      }),
    ).toEqual({
      type: "appearance",
      roomId: "room-1",
      exits: [{ id: "exit-north" }],
      staticPresence: [{ id: "npc-1" }],
      occupants: [{ id: "pc-2" }],
    });
  });

  it("departedEvent and arrivedEvent stamp their own types over the same move semantics", () => {
    const move = {
      entityId: "pc-1",
      fromLocationId: "room-1",
      toLocationId: "room-2",
      moveType: "traverse",
      viaExitId: "exit-north",
    };
    expect(departedEvent(move)).toEqual({ type: "departed", ...move });
    expect(arrivedEvent(move)).toEqual({ type: "arrived", ...move });
  });
});

describe("the factory owns `type`", () => {
  it("a type smuggled into fields never wins — the stamp is the factory's alone", () => {
    const draft = commandRefusedEvent({ type: "bogus", reason: "gateClosed" });
    expect(draft.type).toBe("commandRefused");
    expect(sayEvent({ type: "bogus", speakerId: "pc-1", text: "hi", locationId: "room-1" }).type).toBe("say");
  });

  it("customEvent's type argument wins over any type in fields", () => {
    expect(customEvent("pong", { type: "say" })).toEqual({ type: "pong" });
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
      commandRefusedEvent({ reason: "gateClosed" }),
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
        if (!name.endsWith(".ts") || name === "events.ts") continue;
        // `[{,]` precedes an object-literal stamp (a param ANNOTATION is
        // preceded by `(` — `type: "departed" | "arrived"` stays out) and the
        // `(?=…)` demands the quote run end at a comma or brace. ANY type
        // string, not a closed list: "construction in one place" must hold
        // for the engine event type added next year too (a NON-event `type:`
        // literal would need its own documented exemption here).
        const pattern = /[{,]\s*type:\s*"[^"]*"(?=\s*[,}])/g;
        for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
          offenders.push(`${path.slice(srcRoot.length + 1)}: ${match[0]}`);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
