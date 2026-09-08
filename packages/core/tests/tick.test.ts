import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../src/command/pipeline.js";
import { runCommand } from "../src/command/pipeline.js";
import { createCommandHarness } from "../src/command/testing.js";
import { createSeededRng } from "../src/rng.js";
import { createTickClock, observeDispatch } from "../src/clock.js";

/**
 * The engine's "now" (spec/04 §2.2, ADR-0031): a command carries the tick it
 * happened at, the side that drives the world keeps the high-water mark, and
 * every time judgement reads that mark — never the command's raw tick.
 */
interface TestWorld {
  rooms: Record<string, { title: string }>;
}

const noopSink = { emit: () => {} };

function deps(nowTick: number, world: TestWorld = { rooms: {} }) {
  return { nowTick, rng: createSeededRng(1), world, sink: noopSink };
}

function probeSpec(seen: number[]): CommandSpec<TestWorld> {
  return {
    key: "tickProbe",
    func: (ctx) => {
      seen.push(ctx.clock.nowTick());
      ctx.emit("actor-1", { type: "probed", at: ctx.clock.nowTick() });
    },
  };
}

describe("high-water tick clock (spec/04 §2.2)", () => {
  it("never decreases: a backwards tick is accepted and changes nothing", () => {
    const clock = createTickClock(5);

    expect(clock.nowTick()).toBe(5);
    expect(clock.observe(9)).toBe(9);
    expect(clock.observe(3)).toBe(9);
    expect(clock.nowTick()).toBe(9);
  });

  it("fails loudly on a tick that is not a non-negative safe integer", () => {
    const clock = createTickClock();

    expect(() => createTickClock(-1)).toThrow(/startTick/);
    expect(() => clock.observe(1.5)).toThrow(/tick/);
    expect(() => clock.observe(Number.NaN)).toThrow(/tick/);
  });
});

describe("command tick through the pipeline (spec/04 §2.2)", () => {
  it("exposes the high-water mark to the command, not the command's raw tick", () => {
    const seen: number[] = [];

    const result = runCommand(
      probeSpec(seen),
      { seq: 1, actorId: "actor-1", tick: 40, raw: "probe" },
      deps(100),
    );

    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual([100]);
  });

  it("runs a backwards-tick command normally: no throw, judgement at the high-water mark", () => {
    const seen: number[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "backwards",
      func: (ctx) => {
        seen.push(ctx.clock.nowTick());
        ctx.emit("actor-1", { type: "ran", tick: ctx.command.tick });
      },
    };

    const result = runCommand(spec, { seq: 2, actorId: "actor-1", tick: 10, raw: "go" }, deps(500));

    // A backwards tick does not change any fact that already happened: the
    // command runs, and "now" stays at the high-water mark (ADR-0031 §2).
    expect(result).toMatchObject({ ok: true, seq: 2 });
    expect(seen).toEqual([500]);
  });

  it("rejects a malformed tick loudly — a wiring bug, not player input", () => {
    const spec: CommandSpec<TestWorld> = { key: "ping", func: () => {} };

    expect(() =>
      runCommand(spec, { seq: 1, actorId: "actor-1", tick: -1, raw: "ping" }, deps(0)),
    ).toThrow(/command\.tick/);
    expect(() =>
      runCommand(spec, { seq: 1, actorId: "actor-1", tick: 2.5, raw: "ping" }, deps(0)),
    ).toThrow(/command\.tick/);
    // A NaN high-water mark would silently skew every judgement downstream.
    expect(() =>
      runCommand(spec, { seq: 1, actorId: "actor-1", tick: 0, raw: "ping" }, deps(Number.NaN)),
    ).toThrow(/deps\.nowTick/);
  });
});

describe("only commands that run advance the world (spec/04 §4.1)", () => {
  it("feeds ok and rejected into the clock, and nothing at all for invalid", () => {
    const command = { seq: 1, actorId: "actor-1", tick: 50, raw: "go" };

    const afterOk = createTickClock(10);
    observeDispatch(afterOk, command, { ok: true, seq: 1, events: [] });
    expect(afterOk.nowTick()).toBe(50);

    const afterRejected = createTickClock(10);
    observeDispatch(afterRejected, command, {
      ok: false,
      seq: 1,
      kind: "rejected",
      reason: "gateClosed",
    });
    expect(afterRejected.nowTick()).toBe(50);

    const afterInvalid = createTickClock(10);
    observeDispatch(afterInvalid, command, {
      ok: false,
      seq: 1,
      kind: "invalid",
      reason: "unknownVerb",
    });
    expect(afterInvalid.nowTick()).toBe(10);
  });

  it("pins it end to end: spamming invalid input cannot fast-forward the world", () => {
    const broken: CommandSpec<TestWorld> = {
      key: "broken",
      parse: () => ({ ok: false, reason: "badInput" }),
      func: () => {},
    };
    const fine: CommandSpec<TestWorld> = {
      key: "fine",
      func: (ctx) => ctx.emit("actor-1", { type: "ran" }),
    };
    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1"],
      nowTick: 0,
    });

    for (let i = 0; i < 5; i += 1) {
      const out = harness.call(broken, "乱码", { tick: 1000 });
      expect(out.result).toMatchObject({ ok: false, kind: "invalid" });
    }
    // 5000 ticks of malformed input advanced the world by nothing.
    expect(harness.clock.nowTick()).toBe(0);

    harness.call(fine, "go", { tick: 3 });
    expect(harness.clock.nowTick()).toBe(3);
  });
});

describe("seq and tick are independent (spec/04 §6 O2)", () => {
  it("seq orders delivery, tick orders the world: a later seq may carry an earlier tick", () => {
    const seen: { seq: number; now: number; tick: number }[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "probe",
      func: (ctx) => {
        seen.push({ seq: ctx.command.seq, now: ctx.clock.nowTick(), tick: ctx.command.tick });
        ctx.emit("actor-1", { type: "probed" });
      },
    };
    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1"],
      nowTick: 0,
    });

    const first = harness.call(spec, "one", { seq: 1, tick: 50 });
    const second = harness.call(spec, "two", { seq: 2, tick: 10 });

    // The engine neither reorders nor rejects: the caller's seq decides
    // delivery order, each command's tick decides world time.
    expect(first.result).toMatchObject({ ok: true, seq: 1 });
    expect(second.result).toMatchObject({ ok: true, seq: 2 });
    expect(seen).toEqual([
      { seq: 1, now: 50, tick: 50 },
      { seq: 2, now: 50, tick: 10 },
    ]);
  });
});
