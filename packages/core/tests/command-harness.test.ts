import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";

/**
 * The command test harness from ADR-0023 §1 — the seam every command test
 * goes through. Stage order, message recording and seq/actorId stamping are
 * the contract under test here; veto/invalid/sink semantics get their own
 * slices below.
 */
interface TestWorld {
  rooms: Record<string, { title: string }>;
}

describe("command test harness (ADR-0023 §1)", () => {
  it("drives a command through the four stages in order and records its events", () => {
    const order: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "ping",
      at_pre_cmd: () => {
        order.push("pre");
      },
      parse: (_ctx, rawArgs) => {
        order.push("parse");
        return { ok: true, args: rawArgs };
      },
      func: (ctx) => {
        order.push("func");
        ctx.emit("actor-1", { type: "pong" });
      },
      at_post_cmd: () => {
        order.push("post");
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "ping");

    expect(order).toEqual(["pre", "parse", "func", "post"]);
    expect(out.result).toEqual({
      ok: true,
      seq: 1,
      events: [{ seq: 1, type: "pong", actorId: "actor-1" }],
    });
    expect(out.messages).toEqual([
      { to: "actor-1", event: { seq: 1, type: "pong", actorId: "actor-1" } },
    ]);
  });

  it("turns an explicit pre-stage veto into a rejected result that consumes the seq", () => {
    const order: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "gate",
      at_pre_cmd: (ctx) => ctx.veto("gateClosed"),
      parse: () => {
        order.push("parse");
        return { ok: true, args: null };
      },
      func: (ctx) => {
        order.push("func");
        ctx.emit("actor-1", { type: "shouldNotHappen" });
      },
      at_post_cmd: () => {
        order.push("post");
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "gate");

    expect(order).toEqual([]);
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "gateClosed" });
    expect(out.messages).toEqual([
      {
        to: "actor-1",
        event: { seq: 1, type: "commandRefused", actorId: "actor-1", reason: "gateClosed" },
      },
    ]);
  });

  it("vetoes with a bare false and a default reason", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "gate",
      at_pre_cmd: () => false,
      func: (ctx) => ctx.emit("actor-1", { type: "shouldNotHappen" }),
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "gate");

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "vetoed" });
  });

  it("treats a void-returning pre hook as proceed (only explicit false vetoes)", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "ping",
      at_pre_cmd: () => {
        // side effects only, no return value
      },
      func: (ctx) => ctx.emit("actor-1", { type: "pong" }),
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "ping");

    expect(out.result.ok).toBe(true);
  });

  it("maps a failed parse to invalid without consuming the seq or emitting events", () => {
    const order: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "num",
      parse: () => ({ ok: false, reason: "expectedANumber" }),
      func: (ctx) => {
        order.push("func");
        ctx.emit("actor-1", { type: "shouldNotHappen" });
      },
      at_post_cmd: () => {
        order.push("post");
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "num abc");

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: "expectedANumber" });
    // No event carries seq 1: an invalid command consumes nothing, so the
    // caller knows it may reissue with a corrected input (spec/01 §4).
    expect(out.messages).toEqual([]);
    expect(order).toEqual([]);
  });

  it("records messages to declared receivers in call order and discards undeclared ones", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "shout",
      func: (ctx) => {
        ctx.emit("actor-1", { type: "heardOwnShout" });
        ctx.emit("bystander-1", { type: "heardShout" });
        ctx.emit("unlisted", { type: "dropped" });
        ctx.emit("actor-1", { type: "heardEcho" });
      },
    };

    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1", "bystander-1"],
    });
    const out = harness.call(spec, "shout");

    expectMessageSequence(out.messages, [
      { to: "actor-1", event: { type: "heardOwnShout" } },
      { to: "bystander-1", event: { type: "heardShout" } },
      { to: "actor-1", event: { type: "heardEcho" } },
    ]);
  });

  it("matches expected fields as a subset, tolerating extra semantic fields", () => {
    const messages = [
      {
        to: "actor-1",
        event: { seq: 1, type: "damageDealt", actorId: "actor-1", amount: 12, tier: "medium" },
      },
    ];

    expectMessageSequence(messages, [
      { to: "actor-1", event: { type: "damageDealt", tier: "medium" } },
    ]);
  });

  it("asserts the message count, not just the prefixes (ADR-0023 §1e)", () => {
    // Prefix matching alone would let one extra wrong message slip through.
    const messages = [
      { to: "actor-1", event: { seq: 1, type: "a", actorId: "actor-1" } },
      { to: "actor-1", event: { seq: 1, type: "b", actorId: "actor-1" } },
    ];

    expect(() =>
      expectMessageSequence(messages, [{ to: "actor-1", event: { type: "a" } }]),
    ).toThrow(/1 message\(s\) but recorded 2/);
    expect(() =>
      expectMessageSequence(messages, [
        { to: "actor-1", event: { type: "a" } },
        { to: "actor-1", event: { type: "WRONG" } },
      ]),
    ).toThrow(/message 1 does not match/);
  });

  it("injects the tick-counting clock: commands read nowTick, advance affects later calls", () => {
    const seenTicks: number[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "tickProbe",
      func: (ctx) => {
        seenTicks.push(ctx.clock.nowTick());
        ctx.emit("actor-1", { type: "probed" });
      },
    };

    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1"],
      nowTick: 100,
    });
    harness.call(spec, "tickProbe");
    harness.clock.advance(7);
    harness.call(spec, "tickProbe");

    expect(seenTicks).toEqual([100, 107]);
  });

  it("replays identical rolls for identical seeds and advances the stream across calls", () => {
    const rollSession = (): number[] => {
      const rolls: number[] = [];
      const spec: CommandSpec<TestWorld> = {
        key: "rollProbe",
        func: (ctx) => {
          rolls.push(ctx.rng.next());
        },
      };
      const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [], seed: 42 });
      harness.call(spec, "roll");
      harness.call(spec, "roll");
      return rolls;
    };

    const first = rollSession();
    const second = rollSession();

    // The fifth injected dependency (ADR-0023 §1): same seed, same session.
    expect(first).toEqual(second);
    // One stream per harness: the second call continues, not restarts, the rolls.
    expect(first[0]).not.toBe(first[1]);
  });

  it("deep-copies the world fixture per call so mutations do not leak", () => {
    const seen: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "mutate",
      func: (ctx) => {
        seen.push(ctx.world.rooms["room-1"]?.title ?? "missing");
        ctx.world.rooms["room-1"] = { title: "changed" };
      },
    };
    const world: TestWorld = { rooms: { "room-1": { title: "pristine" } } };

    const harness = createCommandHarness<TestWorld>({ world, receivers: [] });
    harness.call(spec, "mutate");
    harness.call(spec, "mutate");

    // No transaction rollback (ADR-0024 §2 determinism checklist): each call
    // runs on a fresh deep copy of the fixture.
    expect(seen).toEqual(["pristine", "pristine"]);
    expect(world.rooms["room-1"]?.title).toBe("pristine");
  });

  it("feeds queued player inputs FIFO, not LIFO (ADR-0023 §1d; Evennia pops the tail)", () => {
    const consumed: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "confirm",
      func: (ctx) => {
        for (let i = 0; i < 3; i++) {
          consumed.push(ctx.takeInput() ?? "<none>");
        }
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [] });
    harness.call(spec, "confirm", { inputs: ["yes", "2"] });

    expect(consumed).toEqual(["yes", "2", "<none>"]);
  });
});
