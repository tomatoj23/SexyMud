import { describe, expect, it } from "vitest";
import { commandRefusedEvent, customCode, customEvent, stampEvent } from "../src/events.js";
import type { CmdSetSource } from "../src/command/cmdset.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import {
  createCommandHarness,
  createTestClock,
  expectMessageSequence,
} from "../src/command/testing.js";
import { createSeededRng } from "../src/rng.js";
import { createPredicateRegistry, defaultPredicateRegistry } from "../src/conditions.js";

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
        ctx.emit("actor-1", customEvent("pong"));
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
      events: [{ seq: 1, tick: 0, type: "pong", actorId: "actor-1" }],
    });
    expect(out.messages).toEqual([
      { to: "actor-1", event: { seq: 1, tick: 0, type: "pong", actorId: "actor-1" } },
    ]);
  });

  it("turns an explicit pre-stage veto into a rejected result that consumes the seq", () => {
    const order: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "gate",
      at_pre_cmd: (ctx) => ctx.veto(customCode("gateClosed")),
      parse: () => {
        order.push("parse");
        return { ok: true, args: null };
      },
      func: (ctx) => {
        order.push("func");
        ctx.emit("actor-1", customEvent("shouldNotHappen"));
      },
      at_post_cmd: () => {
        order.push("post");
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "gate");

    expect(order).toEqual([]);
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: customCode("gateClosed") });
    expect(out.messages).toEqual([
      {
        to: "actor-1",
        event: { seq: 1, tick: 0, type: "commandRefused", actorId: "actor-1", reason: customCode("gateClosed") },
      },
    ]);
  });

  it("vetoes with a bare false and a default reason", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "gate",
      at_pre_cmd: () => false,
      func: (ctx) => ctx.emit("actor-1", customEvent("shouldNotHappen")),
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
      func: (ctx) => ctx.emit("actor-1", customEvent("pong")),
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "ping");

    expect(out.result.ok).toBe(true);
  });

  it("maps a failed parse to invalid without consuming the seq or emitting events", () => {
    const order: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "num",
      parse: () => ({ ok: false, reason: customCode("expectedANumber") }),
      func: (ctx) => {
        order.push("func");
        ctx.emit("actor-1", customEvent("shouldNotHappen"));
      },
      at_post_cmd: () => {
        order.push("post");
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "num abc");

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: customCode("expectedANumber") });
    // No event carries seq 1: an invalid command consumes nothing, so the
    // caller knows it may reissue with a corrected input (spec/01 §4).
    expect(out.messages).toEqual([]);
    expect(order).toEqual([]);
  });

  it("records messages to declared receivers in call order and discards undeclared ones", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "shout",
      func: (ctx) => {
        ctx.emit("actor-1", customEvent("heardOwnShout"));
        ctx.emit("bystander-1", customEvent("heardShout"));
        ctx.emit("unlisted", customEvent("dropped"));
        ctx.emit("actor-1", customEvent("heardEcho"));
      },
    };

    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1", "bystander-1"],
    });
    const out = harness.call(spec, "shout");

    expectMessageSequence(out.messages, [
      { to: "actor-1", event: customEvent("heardOwnShout") },
      { to: "bystander-1", event: customEvent("heardShout") },
      { to: "actor-1", event: customEvent("heardEcho") },
    ]);
  });

  it("matches expected fields as a subset, tolerating extra semantic fields", () => {
    // A delivered synthetic event is the extension arm plus the stamped
    // skeleton — built through the engine's own delivery construction
    // (customEvent + stampEvent), the one way a draft becomes a GameEvent.
    const messages = [
      {
        to: "actor-1",
        event: stampEvent(customEvent("damageDealt", { amount: 12, tier: "medium" }), {
          seq: 1,
          tick: 7,
          actorId: "actor-1",
        }),
      },
    ];

    expectMessageSequence(messages, [
      { to: "actor-1", event: customEvent("damageDealt", { tier: "medium" }) },
    ]);
  });

  it("asserts the message count, not just the prefixes (ADR-0023 §1e)", () => {
    // Prefix matching alone would let one extra wrong message slip through.
    const messages = [
      { to: "actor-1", event: stampEvent(customEvent("a"), { seq: 1, tick: 0, actorId: "actor-1" }) },
      { to: "actor-1", event: stampEvent(customEvent("b"), { seq: 1, tick: 0, actorId: "actor-1" }) },
    ];

    expect(() =>
      expectMessageSequence(messages, [{ to: "actor-1", event: customEvent("a") }]),
    ).toThrow(/1 message\(s\) but recorded 2/);
    expect(() =>
      expectMessageSequence(messages, [
        { to: "actor-1", event: customEvent("a") },
        { to: "actor-1", event: customEvent("WRONG") },
      ]),
    ).toThrow(/message 1 does not match/);
  });

  it("stamps the tick on the command: advance moves later commands, not the engine's now", () => {
    const seenTicks: number[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "tickProbe",
      func: (ctx) => {
        // The command carries its own tick (ADR-0031); the engine reads the
        // high-water mark back through ctx.clock.
        seenTicks.push(ctx.command.tick);
        ctx.emit("actor-1", customEvent("probed"));
      },
    };

    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1"],
      session: { clock: createTestClock(100) },
    });
    harness.call(spec, "tickProbe");
    harness.clock.advance(7);
    harness.call(spec, "tickProbe");

    expect(seenTicks).toEqual([100, 107]);
    expect(harness.clock.nowTick()).toBe(107);
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
      const harness = createCommandHarness<TestWorld>({
        world: { rooms: {} },
        receivers: [],
        session: { rng: createSeededRng(42) },
      });
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
    harness.call(spec, { raw: "confirm", inputs: ["yes", "2"] });

    expect(consumed).toEqual(["yes", "2", "<none>"]);
  });

  it("maps an execution-stage rejection to a rejected result; the refusing func words its own refusal", () => {
    const order: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "strike",
      func: (ctx) => {
        order.push("func");
        // The executor owns the refusal semantics: gates beyond the entry's
        // own, hook vetoes — it emits the event itself, with full context,
        // through the engine's own factory (construction in one place).
        ctx.emit(
          "actor-1",
          commandRefusedEvent({ reason: customCode("targetMissing"), commandKey: "strike" }),
        );
        return { kind: "rejected", reason: customCode("targetMissing") };
      },
      at_post_cmd: () => {
        order.push("post");
      },
    };

    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: ["actor-1"] });
    const out = harness.call(spec, "strike");

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: customCode("targetMissing") });
    // Exactly the func's own refusal — the pipeline words no second one.
    expect(out.messages).toEqual([
      {
        to: "actor-1",
        event: {
          seq: 1,
          tick: 0,
          type: "commandRefused",
          actorId: "actor-1",
          reason: customCode("targetMissing"),
          commandKey: "strike",
        },
      },
    ]);
    // A rejected command never reaches the post stage.
    expect(order).toEqual(["func"]);
  });

  it("exposes the predicate registry to the execution stage (gates beyond the entry's own)", () => {
    const seen: string[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "probe",
      func: (ctx) => {
        seen.push(ctx.predicates === defaultPredicateRegistry ? "default" : "custom");
      },
    };

    createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [] }).call(spec, "probe");
    const custom = createPredicateRegistry([["always", () => true]]);
    createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: [],
      access: { predicates: custom },
    }).call(spec, "probe");

    expect(seen).toEqual(["default", "custom"]);
  });

  it("live-world mode shares the world across calls: mutations persist (how a host drives a runtime)", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "mutate",
      func: (ctx) => {
        ctx.world.rooms["room-1"] = { title: "changed" };
      },
    };
    const world: TestWorld = { rooms: {} };

    const harness = createCommandHarness<TestWorld>({ world: { live: world }, receivers: [] });
    harness.call(spec, "mutate");
    harness.call(spec, "mutate");

    // The SHARED object mutated — a live world runtime evolves across a
    // session instead of being re-cloned per command.
    expect(world.rooms["room-1"]).toEqual({ title: "changed" });
  });
});

/**
 * The test clock itself (ADR-0031): `TestClock` is a public export for hosts
 * and tests that drive commands WITHOUT the harness, so its three methods get
 * their own cases here — including the claim its comment makes ("an
 * explicitly backwards tick does not drag the following ones back").
 */
describe("createTestClock: the tick the next call carries (ADR-0031)", () => {
  it("nextTick is the default tick and advance moves it — both ways, without moving the mark", () => {
    const clock = createTestClock(100);
    expect(clock.nextTick()).toBe(100);
    clock.advance(7);
    expect(clock.nextTick()).toBe(107);
    // advance moves the DEFAULT only: nothing was observed, so the engine's
    // now — the high-water mark — has not moved.
    expect(clock.nowTick()).toBe(100);
    clock.advance(-3);
    expect(clock.nextTick()).toBe(104);
  });

  it("observe returns the never-decreasing high-water mark", () => {
    const clock = createTestClock(100);
    expect(clock.observe(150)).toBe(150);
    expect(clock.nowTick()).toBe(150);
    // A backwards tick is accepted and changes nothing.
    expect(clock.observe(90)).toBe(150);
    expect(clock.nowTick()).toBe(150);
  });

  it("an explicitly backwards tick does not drag the following defaults back", () => {
    const clock = createTestClock(100);
    clock.observe(150);
    clock.observe(90); // a command explicitly carrying an earlier tick
    // Later default calls continue from the high-water mark, not from that
    // tick — the claim on the observe() implementation.
    expect(clock.nextTick()).toBe(150);
    clock.advance(5);
    expect(clock.nextTick()).toBe(155);
    expect(clock.nowTick()).toBe(150); // still: advance never observes
  });
});

/**
 * One assembly per session (issue #36): a session host re-merges its verb
 * sources per input — they change with location — so the harness takes them
 * through a per-dispatch resolver and re-merges the table EVERY dispatch,
 * never caching it. The rng stream and the local seq counter live on the
 * harness, so a source change must not restart either.
 */
describe("one assembly across per-dispatch verb sources (issue #36)", () => {
  it("keeps the seq counter and the rng stream when the sources change between calls", () => {
    let dispatch = 0;
    const rolls: number[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "probe",
      argForm: "none",
      func: (ctx) => {
        rolls.push(ctx.rng.next());
      },
    };
    // The session pattern: ONE harness, sources re-resolved per dispatch.
    const session = () => {
      dispatch = 0;
      rolls.length = 0;
      return createCommandHarness<TestWorld>({
        world: { rooms: {} },
        receivers: [],
        session: { rng: createSeededRng(42) },
        verbs: () => {
          dispatch += 1;
          return [{ priority: 1, commands: [{ key: "probe", verbs: [`动${dispatch}`] }] }];
        },
      });
    };

    const harness = session();
    const seqs = [
      harness.call(spec, "动1").result.seq,
      harness.call(spec, "动2").result.seq,
      harness.call(spec, "动3").result.seq,
    ];
    // The counter is the harness's, session-wide: no rebuild between inputs,
    // no reset (the old rebuild-per-command pattern restarted at 1 every call).
    expect(seqs).toEqual([1, 2, 3]);
    // One stream per harness: each call continues the previous roll instead
    // of restarting the seeded stream at its first value.
    expect(new Set(rolls).size).toBe(3);
    const firstRolls = [...rolls];

    // Same seed, same session: the whole sequence replays.
    const second = session();
    const replay = [
      second.call(spec, "动1").result.seq,
      second.call(spec, "动2").result.seq,
      second.call(spec, "动3").result.seq,
    ];
    expect(replay).toEqual([1, 2, 3]);
    expect(rolls).toEqual(firstRolls);
  });

  it("re-merges the verb table on every dispatch and never caches it", () => {
    let dispatch = 0;
    const spec: CommandSpec<TestWorld> = {
      key: "probe",
      argForm: "none",
      func: (ctx) => {
        ctx.emit(ctx.command.actorId, customEvent("probed"));
      },
    };
    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1"],
      verbs: () => {
        dispatch += 1;
        return [{ priority: 1, commands: [{ key: "probe", verbs: [`动${dispatch}`] }] }];
      },
    });

    // Each dispatch sees a FRESH merge of the sources it resolved to.
    expect(harness.call(spec, "动1").result.ok).toBe(true);
    expect(harness.call(spec, "动2").result.ok).toBe(true);
    // 动1 was verb 1's — a cached table would still answer it. The fresh
    // merge has moved on, so the stale verb is unknown input.
    const stale = harness.call(spec, "动1");
    expect(stale.result).toMatchObject({ ok: false, kind: "invalid", reason: "unknownVerb" });
    // The resolver ran once per dispatch — nothing was cached.
    expect(dispatch).toBe(3);
  });

  it("carries input only: every way back to an options channel is a compile error", () => {
    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: ["actor-1"],
    });
    const spec: CommandSpec<TestWorld> = {
      key: "ping",
      func: (ctx) => {
        ctx.emit(ctx.command.actorId, customEvent("pong"));
      },
    };
    // Runtime half: the input descriptor is the whole call surface.
    const out = harness.call(spec, { raw: "ping", actorId: "actor-1", tick: 5 });
    expect(out.result.ok).toBe(true);

    // Compile half — tsc IS the runner for these lines; each @ts-expect-error
    // fails the build the moment the channel it guards becomes legal again.
    const neverRun = () => {
      // @ts-expect-error — no third argument: the old CallOptions channel is gone.
      harness.call(spec, "ping", { seq: 1 });
      // @ts-expect-error — no `seq` on the input: the harness owns the counter.
      harness.call(spec, { raw: "ping", seq: 1 });
      // @ts-expect-error — no `liveWorld` switch: the world carries its liveness.
      createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [], liveWorld: true });
      // @ts-expect-error — no `cmdsets`: verbs and cmdsets are one field.
      createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [], cmdsets: [] });
      // @ts-expect-error — no `seed`/`nowTick`: the streams are assembled objects.
      createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [], seed: 7, nowTick: 3 });
    };
    expect(typeof neverRun).toBe("function");
  });

  it("retired channels fail loudly even through a non-literal (复查钉)", () => {
    // The compile pin above only guards OBJECT LITERALS. A stale key riding
    // a wider variable compiles — so the checker's blind spot is covered by
    // a loud runtime answer, the same species as the old XOR throw.
    const stale = { world: { rooms: {} }, receivers: [], cmdsets: [] };
    expect(() => createCommandHarness<TestWorld>(stale)).toThrow(/"cmdsets" was retired/);
    const harness = createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [] });
    const spec: CommandSpec<TestWorld> = { key: "ping", func: () => {} };
    const wide = { raw: "ping", seq: 99 };
    expect(() => harness.call(spec, wide)).toThrow(/seq is harness-owned/);
  });

  it("merges static sources once at creation and loud; the resolver defers to the dispatch", () => {
    const broken: CmdSetSource[] = [{ priority: 1.5, commands: [] }];
    // Static form: a wiring mistake answers at harness creation, not on the
    // third call of a session.
    expect(() =>
      createCommandHarness<TestWorld>({ world: { rooms: {} }, receivers: [], verbs: broken }),
    ).toThrow(/priority must be a safe integer/);
    // Resolver form: creation is quiet — the merge is the dispatch's own.
    const harness = createCommandHarness<TestWorld>({
      world: { rooms: {} },
      receivers: [],
      verbs: () => broken,
    });
    expect(() => harness.call({ key: "probe", func: () => {} }, "x")).toThrow(
      /priority must be a safe integer/,
    );
  });
});
