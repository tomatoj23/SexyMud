import { readFileSync } from "node:fs";
import { customCode, customEvent, stampEvent } from "../src/events.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTickClock } from "../src/clock.js";
import { createSeededRng } from "../src/rng.js";
import { createDispatchDriver } from "../src/command/driver.js";
import type { CommandSpec, Message } from "../src/command/pipeline.js";
import type { SettleRequest } from "../src/time/settle.js";
import type { Command, GameEvent } from "../src/types.js";

/**
 * The dispatch driver (spec/04 §4.1, ADR-0038): THE one implementation of the
 * driver-side fixed four steps and their three rules. Before this module the
 * sequence was hand-copied in the test harness and the host `LocalAuthority`,
 * and a copy that forgets one step freezes the world silently (O10's failure
 * mode). These tests pin the rules at the seam itself — the two adapters'
 * behaviour stays pinned by their own suites, unchanged.
 */

interface TestWorld {
  log: string[];
}

function command(overrides: Partial<Command> = {}): Command {
  return { seq: 1, actorId: "actor-1", tick: 10, raw: "ping", ...overrides };
}

function pongSpec(world: TestWorld): CommandSpec<TestWorld> {
  return {
    key: "ping",
    func: (ctx) => {
      world.log.push("func");
      ctx.emit("actor-1", customEvent("pong"));
    },
  };
}

/** A settle hook that records its request and emits one settlement message. */
function recordingSettle() {
  const requests: SettleRequest[] = [];
  const settle = (request: SettleRequest): Message[] => {
    requests.push(request);
    return [
      {
        to: "actor-1",
        event: stampEvent(customEvent("worldAwake"), { seq: request.seq, actorId: "", tick: request.toTick }),
      },
    ];
  };
  return { requests, settle };
}

describe("createDispatchDriver: the four steps and their rules (spec/04 §4.1)", () => {
  it("runs pre-flight → advance → dispatch → observe, settlement events first", () => {
    const clock = createTickClock(0);
    const world: TestWorld = { log: [] };
    const { requests, settle } = recordingSettle();
    const driver = createDispatchDriver<TestWorld>({ clock, settle });
    const emitted: GameEvent[] = [];
    const { result, settled } = driver.dispatch(command(), pongSpec(world), {
      rng: createSeededRng(1),
      world,
      sink: { emit: (message) => emitted.push(message.event) },
    });

    // The advance saw the same "now" the command runs at, and the actor's id.
    expect(requests).toEqual([{ toTick: 10, seq: 1, actorId: "actor-1" }]);
    expect(world.log).toEqual(["func"]);
    // Rule 3: settlement events ride BEFORE the command's own.
    expect(result.ok && result.events.map((event) => event.type)).toEqual(["worldAwake", "pong"]);
    expect(settled.map((message) => message.event.type)).toEqual(["worldAwake"]);
    // The mark moved: the command reached the execution stage.
    expect(clock.nowTick()).toBe(10);
  });

  it("an input that cannot become a command advances nothing and moves no mark", () => {
    const clock = createTickClock(0);
    const world: TestWorld = { log: [] };
    const { requests, settle } = recordingSettle();
    const driver = createDispatchDriver<TestWorld>({ clock, settle });
    const broken: CommandSpec<TestWorld> = {
      key: "broken",
      parse: () => ({ ok: false, reason: customCode("badInput") }),
      func: () => {
        world.log.push("func");
      },
    };

    const { result, settled } = driver.dispatch(command({ tick: 1000 }), broken, {
      rng: createSeededRng(1),
      world,
      sink: { emit: () => {} },
    });

    // Rule 1 + 2: the pre-flight answers BEFORE the advance — a malformed
    // input must not fast-forward the world, and its tick must not raise the
    // high-water mark (otherwise spamming garbage fast-forwards time).
    expect(requests).toEqual([]);
    expect(result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: customCode("badInput") });
    expect(settled).toEqual([]);
    expect(world.log).toEqual([]);
    expect(clock.nowTick()).toBe(0);
  });

  it("without an advance hook there is no pre-flight — the quirk stands", () => {
    // The pre-flight's job is to protect the advance ("no hook, no world to
    // protect"). Without one, the run's own parse answers — which means the
    // pre-stage hooks of a broken input still run. Observably equivalent for
    // the result shape, NOT for hook side effects; preserved on purpose.
    const clock = createTickClock(0);
    const world: TestWorld = { log: [] };
    const driver = createDispatchDriver<TestWorld>({ clock });
    const broken: CommandSpec<TestWorld> = {
      key: "broken",
      at_pre_cmd: () => {
        world.log.push("pre");
      },
      parse: () => ({ ok: false, reason: customCode("badInput") }),
      func: () => {
        world.log.push("func");
      },
    };

    const { result, settled } = driver.dispatch(command({ tick: 1000 }), broken, {
      rng: createSeededRng(1),
      world,
      sink: { emit: () => {} },
    });

    expect(world.log).toEqual(["pre"]);
    expect(result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: customCode("badInput") });
    expect(settled).toEqual([]);
    // `invalid` moves no mark even without the pre-flight (the observe step's
    // whitelist is the fallback guard).
    expect(clock.nowTick()).toBe(0);
  });

  it("with an advance hook the pre-flight shields the world from broken input", () => {
    const clock = createTickClock(0);
    const world: TestWorld = { log: [] };
    const { settle } = recordingSettle();
    const driver = createDispatchDriver<TestWorld>({ clock, settle });
    const broken: CommandSpec<TestWorld> = {
      key: "broken",
      at_pre_cmd: () => {
        world.log.push("pre");
      },
      parse: () => ({ ok: false, reason: customCode("badInput") }),
      func: () => {
        world.log.push("func");
      },
    };

    const { result } = driver.dispatch(command({ tick: 1000 }), broken, {
      rng: createSeededRng(1),
      world,
      sink: { emit: () => {} },
    });

    // Same invalid shape, but NOTHING ran: the pre-flight answered first.
    expect(world.log).toEqual([]);
    expect(result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: customCode("badInput") });
  });

  it("the command's now is the driver's mark maxed with its own tick", () => {
    const clock = createTickClock(50);
    const world: TestWorld = { log: [] };
    const seen: number[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "probe",
      func: (ctx) => {
        seen.push(ctx.clock.nowTick());
      },
    };
    const driver = createDispatchDriver<TestWorld>({ clock });

    // A backwards tick cannot rewind the world: the mark is the floor.
    driver.dispatch(command({ tick: 30 }), spec, {
      rng: createSeededRng(1),
      world,
      sink: { emit: () => {} },
    });
    // A forward tick raises the floor for this command.
    driver.dispatch(command({ seq: 2, tick: 70 }), spec, {
      rng: createSeededRng(1),
      world,
      sink: { emit: () => {} },
    });

    expect(seen).toEqual([50, 70]);
    expect(clock.nowTick()).toBe(70);
  });
});

describe("heartbeat: advance without a command (spec/04 §4.2, ADR-0034 §5)", () => {
  it("advances with the caller's seq and no actor at all", () => {
    const clock = createTickClock(0);
    const { requests, settle } = recordingSettle();
    const driver = createDispatchDriver<TestWorld>({ clock, settle });

    const settled = driver.heartbeat({ toTick: 42, seq: 7 });

    // No `actorId` key at all: a heartbeat is a settle without an actor (the
    // world layer alone), never a forged system command with an empty id.
    // `toStrictEqual`, not `toEqual` — an `actorId: undefined` key would pass
    // a loose match and is exactly the forged-command shape being excluded.
    expect(requests).toStrictEqual([{ toTick: 42, seq: 7 }]);
    expect(settled.map((message) => message.event.type)).toEqual(["worldAwake"]);
    // "The advance IS the mark raise": the beat moves the mark to the host's
    // "now" (spec/04 §4.2).
    expect(clock.nowTick()).toBe(42);
  });

  it("without an advance hook the beat still raises the mark", () => {
    // No world layer hooked means nothing to advance — but the host's "now"
    // still reached the driver, and a mark that silently stays behind is the
    // exact freeze this module exists to make impossible.
    const clock = createTickClock(0);
    const driver = createDispatchDriver<TestWorld>({ clock });

    expect(driver.heartbeat({ toTick: 42, seq: 7 })).toEqual([]);
    expect(clock.nowTick()).toBe(42);
  });
});

describe("the four-step sequence has one home (mechanical scan)", () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/command");

  it("testing.ts delegates — it references none of the four primitives", () => {
    const text = readFileSync(resolve(dir, "testing.ts"), "utf8");
    for (const id of ["parseCommand", "runCommand", "observeDispatch", "effectiveNowTick"]) {
      expect(text, `testing.ts must not reference ${id}`).not.toMatch(
        new RegExp(`\\b${id}\\b`),
      );
    }
    // The advance hook enters as an injected function value and nowhere
    // else: `settleTo` may appear only as `settler.settleTo`, never as an
    // inline call in a hand-rolled sequence.
    const stripped = text.replace(/settler\.settleTo\b/g, "");
    expect(stripped, "settleTo only as the injected function").not.toMatch(/\bsettleTo\b/);
  });

  it("the sequence really lives in driver.ts — the scan above is not vacuous", () => {
    const text = readFileSync(resolve(dir, "driver.ts"), "utf8");
    for (const id of ["parseCommand", "runCommand", "observeDispatch", "effectiveNowTick"]) {
      expect(text, `driver.ts must own ${id}`).toMatch(new RegExp(`\\b${id}\\b`));
    }
    // The nowTick reading enters through the driver alone: the adapters'
    // deps type omits it, so they cannot supply a second "now".
    expect(text).toMatch(/clock\.nowTick\(\)/);
  });

  it("testing.ts drives through the driver, not its own copy", () => {
    const text = readFileSync(resolve(dir, "testing.ts"), "utf8");
    expect(text).toMatch(/createDispatchDriver/);
  });

  it("the ranking rule has one home — adapters never hand-roll the settled spread", () => {
    // Rule 3 ("settlement output ranks before the command's own") is not
    // three coincidental `[...settled, ...]` spreads in three files: it is
    // `settlementFirst`, and every output channel composes through it. A
    // hand-rolled spread in an adapter would be the rule reimplemented.
    const adapter = readFileSync(resolve(dir, "testing.ts"), "utf8");
    expect(adapter).toMatch(/settlementFirst/);
    expect(adapter, "adapters compose, they do not concatenate").not.toMatch(
      /\[\s*\.\.\.(?:settled|settlement)\b/,
    );
    // The rule itself lives in driver.ts — the scan above is not vacuous.
    const driver = readFileSync(resolve(dir, "driver.ts"), "utf8");
    expect(driver).toMatch(/\[\s*\.\.\.settled\b/);
    expect(driver).toMatch(/settlementFirst/);
  });
});

