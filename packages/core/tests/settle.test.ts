import { describe, expect, it } from "vitest";
import { createTickClock } from "../src/clock.js";
import type { TickClock } from "../src/clock.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import type { Message } from "../src/command/pipeline.js";
import { createCommandHarness } from "../src/command/testing.js";
import type { CommandHarness } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { RoomEntry } from "../src/world/entry.js";
import { createEntity } from "../src/world/entity.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldState } from "../src/state/tree.js";
import { createSettler } from "../src/time/settle.js";
import type {
  EntitySettleHandler,
  SettleRequest,
  SettleSpan,
  Settler,
  WorldSettleHandler,
} from "../src/time/settle.js";

/**
 * The one advance function (spec/04 §4.2–§4.3, ADR-0032 §4, ADR-0034):
 * online heartbeat, offline catch-up and the due bucket are three SPANS of
 * one call, not three mechanisms — and the advance is two-layered, which is
 * the only reason an offline span is ever non-zero.
 *
 * Everything here is SYNTHETIC, after the precedent of entity-seams.test.ts
 * and the still-empty `derived` table: the state tree has no numeric slot
 * worth catching up yet, so both layers are driven by synthetic consumers
 * registered into the seam. The real ones (the due bucket, the pulses
 * formula) ride these seams later without reshaping them.
 */

const RECEIVERS = ["jia", "yi", "broadcast"];

/**
 * 甲 went offline at tick 0, 乙 at tick 100; both come back at 1000. That is
 * the whole point of the entity layer: each catches up over their OWN span.
 */
function offlineWorld(): WorldState {
  return {
    entities: {
      jia: { id: "jia", locationId: "room-a", flags: [], tags: {}, lastSeenTick: 0 },
      yi: { id: "yi", locationId: "room-a", flags: [], tags: {}, lastSeenTick: 100 },
    },
  };
}

interface Rig {
  harness: CommandHarness<WorldState>;
  settler: Settler;
  state: WorldState;
  worldSpans: SettleSpan[];
  entitySpans: { entityId: string; fromTick: number; toTick: number }[];
}

/**
 * The harness IS the side that drives the world here (spec/04 §2.2), so it
 * owns the high-water mark and the settler reads that very clock: "the tick
 * the world is settled to" and "now" are one number, not two.
 */
function rig(options: {
  nowTick?: number;
  state?: WorldState;
  world?: WorldSettleHandler;
  entity?: EntitySettleHandler;
} = {}): Rig {
  const state = options.state ?? offlineWorld();
  const worldSpans: SettleSpan[] = [];
  const entitySpans: { entityId: string; fromTick: number; toTick: number }[] = [];
  const world: WorldSettleHandler = (span, emit) => {
    worldSpans.push(span);
    options.world?.(span, emit);
  };
  const entity: EntitySettleHandler = (entityId, span, emit) => {
    entitySpans.push({ entityId, fromTick: span.fromTick, toTick: span.toTick });
    options.entity?.(entityId, span, emit);
  };
  let settler: Settler | undefined;
  const harness = createCommandHarness<WorldState>({
    world: state,
    receivers: RECEIVERS,
    // Live: the tree is the world's truth, and a state tree must not be
    // deep-copied away from its settler between calls.
    liveWorld: true,
    nowTick: options.nowTick ?? 0,
    settle: (request: SettleRequest): Message[] => settler!.settleTo(request),
  });
  settler = createSettler({ state, clock: harness.clock, world, entity });
  return { harness, settler, state, worldSpans, entitySpans };
}

/** A command that ran: the case the world must be advanced for. */
const fine: CommandSpec<WorldState> = {
  key: "fine",
  func: (ctx) => {
    ctx.emit(ctx.command.actorId, { type: "ran" });
  },
};

/** An input that never becomes a command — the case that must NOT advance. */
const broken: CommandSpec<WorldState> = {
  key: "broken",
  parse: () => ({ ok: false, reason: "badInput" }),
  func: () => {},
};

/** A legitimate refusal: it happened, so the world moves (spec/04 §4.1). */
const vetoed: CommandSpec<WorldState> = {
  key: "vetoed",
  at_pre_cmd: (ctx) => ctx.veto("gateClosed"),
  func: () => {},
};

function rooms(): RoomEntry[] {
  return [
    {
      id: "room-a",
      name: "name-room-a",
      description: "description-room-a",
      enterText: "enter-room-a",
      exits: [],
    },
  ];
}

describe("the two-layer advance (spec/04 §4.3, ADR-0034 §1–§2)", () => {
  it("settles the world to the high-water mark and only the actor's entity layer", () => {
    const { harness, state, worldSpans, entitySpans } = rig();

    harness.call(fine, "go", { seq: 1, actorId: "jia", tick: 1000 });

    // World layer: one span, [last settle point, now) — not one per tick.
    expect(worldSpans).toEqual([{ fromTick: 0, toTick: 1000 }]);
    // Entity layer: the ACTOR only, from the actor's own lastSeenTick.
    expect(entitySpans).toEqual([{ entityId: "jia", fromTick: 0, toTick: 1000 }]);
    expect(state.entities["jia"]!.lastSeenTick).toBe(1000);
    // 乙 is present in the same room but was not asked for: present ≠ online.
    expect(state.entities["yi"]!.lastSeenTick).toBe(100);
  });

  it("gives each player their own span: 甲 back from 0, 乙 back from 100, both at 1000", () => {
    const { harness, state, worldSpans, entitySpans } = rig();

    harness.call(fine, "go", { seq: 1, actorId: "jia", tick: 1000 });
    harness.call(fine, "go", { seq: 2, actorId: "yi", tick: 1000 });

    expect(worldSpans).toEqual([{ fromTick: 0, toTick: 1000 }]);
    expect(entitySpans).toEqual([
      { entityId: "jia", fromTick: 0, toTick: 1000 },
      { entityId: "yi", fromTick: 100, toTick: 1000 },
    ]);
    // Neither player's activity ate the other's offline budget: 乙 still
    // caught up over 900 ticks on the command 乙 came back with.
    expect(state.entities["jia"]!.lastSeenTick).toBe(1000);
    expect(state.entities["yi"]!.lastSeenTick).toBe(1000);
  });

  it("does not re-run the world layer when the mark is already there", () => {
    const { harness, worldSpans, entitySpans } = rig({ nowTick: 1000 });

    harness.call(fine, "go", { seq: 1, actorId: "jia", tick: 1000 });

    // The world is already settled to 1000; only 甲's entity layer is behind.
    expect(worldSpans).toEqual([]);
    expect(entitySpans).toEqual([{ entityId: "jia", fromTick: 0, toTick: 1000 }]);
  });

  it("fails loudly on an entity the world has never seen — wiring, not play", () => {
    const { settler } = rig();

    expect(() => settler.settleTo({ toTick: 10, seq: 1, actorId: "nobody" })).toThrow(
      /unknown entity id "nobody"/,
    );
  });

  it("fails loudly on a settle target that is not a tick", () => {
    const { settler } = rig();

    expect(() => settler.settleTo({ toTick: -1, seq: 1 })).toThrow(/settleTo\.toTick/);
    expect(() => settler.settleTo({ toTick: 1.5, seq: 1 })).toThrow(/settleTo\.toTick/);
  });
});

describe("the advance and the dispatch contract (spec/04 §4.1)", () => {
  it("advances for ok and rejected, and never for invalid", () => {
    const { harness, state, worldSpans } = rig();

    // 5000 ticks of unparseable input: the world does not move at all, and
    // neither does any entity's lastSeenTick (otherwise spamming garbage
    // would be a fast-forward button).
    for (let i = 0; i < 5; i += 1) {
      const out = harness.call(broken, "乱码", { seq: 100 + i, actorId: "jia", tick: 1000 });
      expect(out.result).toMatchObject({ ok: false, kind: "invalid" });
    }
    expect(worldSpans).toEqual([]);
    expect(harness.clock.nowTick()).toBe(0);
    expect(state.entities["jia"]!.lastSeenTick).toBe(0);

    // Rejected before the parse stage, yet it happened: the world moves.
    harness.call(vetoed, "go", { seq: 1, actorId: "jia", tick: 40 });
    expect(worldSpans).toEqual([{ fromTick: 0, toTick: 40 }]);
    expect(harness.clock.nowTick()).toBe(40);

    // And so does a command that ran.
    harness.call(fine, "go", { seq: 2, actorId: "jia", tick: 60 });
    expect(worldSpans).toEqual([
      { fromTick: 0, toTick: 40 },
      { fromTick: 40, toTick: 60 },
    ]);
  });

  it("keeps the high-water mark on the side that drives the world", () => {
    // The world layer starts wherever the DRIVER's clock stands: a driver
    // that already raised the mark leaves no world span behind. Settling
    // then moves that same mark — there is no second "settled tick".
    const state = offlineWorld();
    const clock: TickClock = createTickClock(0);
    const worldSpans: SettleSpan[] = [];
    const settler = createSettler({
      state,
      clock,
      world: (span) => {
        worldSpans.push(span);
      },
    });

    clock.observe(200);
    settler.settleTo({ toTick: 200, seq: 1, actorId: "jia" });

    expect(worldSpans).toEqual([]);
    expect(clock.nowTick()).toBe(200);
    expect(state.entities["jia"]!.lastSeenTick).toBe(200);
  });

  it("runs on the runtime's own clock: the mark lives there, not in runCommand", () => {
    const runtime = createWorldRuntime({
      registry: createContentRegistry({ rooms: rooms() }),
      nowTick: 500,
    });

    expect(runtime.clock.nowTick()).toBe(500);
    // A driver that raises the runtime's mark settles the entity layer from
    // there: addEntity seeded 500, so a settle to 500 has no span at all.
    const spans: { entityId: string; fromTick: number; toTick: number }[] = [];
    const settler = createSettler({
      state: runtime.state,
      clock: runtime.clock,
      entity: (entityId, span) => {
        spans.push({ entityId, fromTick: span.fromTick, toTick: span.toTick });
      },
    });
    runtime.addEntity(createEntity("p1"), "room-a");
    settler.settleTo({ toTick: 700, seq: 1, actorId: "p1" });

    expect(spans).toEqual([{ entityId: "p1", fromTick: 500, toTick: 700 }]);
    expect(runtime.clock.nowTick()).toBe(700);
  });
});

describe("settlement events (ADR-0034 §3–§4)", () => {
  it("borrows the command's seq and sits in front of the command's own events", () => {
    const { harness } = rig({
      world: (span, emit) => emit("broadcast", { type: "worldSettled", tick: span.fromTick + 1 }),
      entity: (_entityId, span, emit) =>
        emit(_entityId, { type: "caughtUp", tick: span.fromTick + 1 }),
    });

    const out = harness.call(fine, "go", { seq: 9, actorId: "jia", tick: 1000 });
    if (!out.result.ok) {
      throw new Error("expected an ok result");
    }

    // The player reads "what happened while you were away" first, then
    // "you go north" — the world reaches now before the command happens.
    expect(out.result.events.map((event) => event.type)).toEqual([
      "worldSettled",
      "caughtUp",
      "ran",
    ]);
    expect(out.result.events.every((event) => event.seq === 9)).toBe(true);
  });

  it("timestamps an event with the tick it was DUE, never the tick it was caught up on", () => {
    // A due item at 300, only noticed at 1000: the event says 300. Writing
    // 1000 would make event order depend on which player logged in first,
    // and replay would stop being deterministic (ADR-0024 §2).
    const { harness } = rig({
      world: (span, emit) => {
        if (span.fromTick <= 300 && 300 < span.toTick) {
          emit("broadcast", { type: "exploded", tick: 300 });
        }
      },
    });

    const out = harness.call(fine, "go", { seq: 3, actorId: "jia", tick: 1000 });
    if (!out.result.ok) {
      throw new Error("expected an ok result");
    }

    expect(out.result.events[0]).toMatchObject({ type: "exploded", tick: 300 });
    // The command's own event carries the now IT saw — the same 1000, not
    // the due tick: the two stamping rules do not collide.
    expect(out.result.events.at(-1)).toMatchObject({ type: "ran", tick: 1000 });
  });

  it("rejects a settlement event whose tick is not a tick", () => {
    // `tick` is the one field a consumer must get right, so it is validated
    // as a tick on the way out too — a number out of a payload is still a
    // number, and a NaN would poison every downstream judgement silently.
    const { settler } = rig({
      world: (_span, emit) => emit("broadcast", { type: "exploded", tick: -1 }),
    });

    expect(() => settler.settleTo({ toTick: 40, seq: 1 })).toThrow(/settle event tick/);
  });

  it("delivers a rejected command's settlement to the sink — the result carries no events", () => {
    const { harness } = rig({
      world: (span, emit) => emit("broadcast", { type: "worldSettled", tick: span.toTick }),
    });

    const out = harness.call(vetoed, "go", { seq: 4, actorId: "jia", tick: 40 });

    expect(out.result).toMatchObject({ ok: false, kind: "rejected" });
    // `rejected` results carry no event list at all (spec/01 §2.2), so the
    // sink is where a refused command's settlement is seen; it still comes
    // first, and it still rides the command's seq.
    expect(out.messages).toEqual([
      // A settlement riding a command is stamped with that command's actor,
      // exactly like the pipeline stamps its own events; only a heartbeat,
      // which has no actor, leaves the field empty.
      { to: "broadcast", event: { seq: 4, tick: 40, type: "worldSettled", actorId: "jia" } },
      { to: "jia", event: { seq: 4, tick: 40, type: "commandRefused", actorId: "jia", reason: "gateClosed" } },
    ]);
  });
});

describe("the host heartbeat (ADR-0034 §5)", () => {
  it("takes an explicit seq and no actor: the world layer runs, the entity layer does not", () => {
    const { harness, settler, state, worldSpans, entitySpans } = rig({
      world: (span, emit) => emit("broadcast", { type: "worldSettled", tick: span.toTick }),
    });

    const messages = settler.settleTo({ toTick: 900, seq: 7 });

    // No actor means no entity is "asked for", so nobody's offline budget
    // is consumed by a heartbeat.
    expect(worldSpans).toEqual([{ fromTick: 0, toTick: 900 }]);
    expect(entitySpans).toEqual([]);
    expect(state.entities["jia"]!.lastSeenTick).toBe(0);
    // A heartbeat does not forge a system command with an empty actorId: it
    // is a settle with no actor at all, on a seq from the command stream.
    expect(messages[0]?.event).toMatchObject({ seq: 7 });
    // The driver raised its own mark; nothing else did it for them.
    expect(harness.clock.nowTick()).toBe(900);
  });

  it("emits world events with no actor rather than inventing one", () => {
    const { settler } = rig({
      world: (span, emit) => emit("broadcast", { type: "weatherChanged", tick: span.toTick }),
    });

    const messages = settler.settleTo({ toTick: 50, seq: 1 });

    expect(messages).toEqual([
      {
        to: "broadcast",
        event: { seq: 1, tick: 50, type: "weatherChanged", actorId: "" },
      },
    ]);
  });
});

describe("mechanism and seam, no consumer (spec/04 §4.3)", () => {
  it("opens no numeric slot for catch-up: the tree carries what it carried, plus the tick", () => {
    const { state } = rig();

    // `attrs` would be a promise about a shape nobody has designed — the
    // same reason §4.1 refuses a named effect table for the due bucket.
    expect(Object.keys(state.entities["jia"]!).sort()).toEqual([
      "flags",
      "id",
      "lastSeenTick",
      "locationId",
      "tags",
    ]);
  });

  it("runs once per span, not once per tick — one call for a million ticks", () => {
    const spans: SettleSpan[] = [];
    const state = offlineWorld();
    const settler = createSettler({
      state,
      clock: createTickClock(0),
      world: (span) => {
        spans.push(span);
      },
      entity: () => {},
    });

    settler.settleTo({ toTick: 1_000_000, seq: 1, actorId: "jia" });

    // Constructive, not a numeric cap: no `maxCatchUpTicks` truncates the
    // span, and nothing iterated a million times to get here (§4.4).
    expect(spans).toEqual([{ fromTick: 0, toTick: 1_000_000 }]);
    expect(state.entities["jia"]!.lastSeenTick).toBe(1_000_000);
  });

  it("leaves both layers inert when no consumer is registered", () => {
    const state = offlineWorld();
    // No world, no entity handler: the seam is empty today, and settling
    // still moves the mark and the tick.
    const settler = createSettler({ state, clock: createTickClock(0) });

    expect(settler.settleTo({ toTick: 80, seq: 1, actorId: "jia" })).toEqual([]);
    expect(state.entities["jia"]!.lastSeenTick).toBe(80);
  });
});

describe("addEntity seeds lastSeenTick (spec/04 §1.5)", () => {
  it("seeds it at the CURRENT tick, not 0 — a new entity starts now", () => {
    const runtime = createWorldRuntime({
      registry: createContentRegistry({ rooms: rooms() }),
      nowTick: 300,
    });

    runtime.addEntity(createEntity("late"), "room-a");
    expect(runtime.state.entities["late"]!.lastSeenTick).toBe(300);

    // And the mark moves: an entity added later starts at the later tick,
    // so it is not handed three hundred ticks of catch-up it never earned.
    runtime.clock.observe(450);
    runtime.addEntity(createEntity("later"), "room-a");
    expect(runtime.state.entities["later"]!.lastSeenTick).toBe(450);
  });

  it("seeds 0 on a world that has no ticks yet — which is the same thing", () => {
    const runtime = createWorldRuntime({ registry: createContentRegistry({ rooms: rooms() }) });

    runtime.addEntity(createEntity("first"), "room-a");

    expect(runtime.state.entities["first"]!.lastSeenTick).toBe(0);
  });

  it("does not re-seed on the load path: a restored tree keeps its own number", () => {
    const runtime = createWorldRuntime({
      registry: createContentRegistry({ rooms: rooms() }),
      state: {
        entities: {
          p1: { id: "p1", locationId: "room-a", flags: [], tags: {}, lastSeenTick: 777 },
        },
      },
    });

    // attachEntity replays a tree, it does not create one: overwriting the
    // saved tick would be the same inversion the two creation layers exist
    // to prevent.
    runtime.attachEntity(createEntity("p1"));

    expect(runtime.state.entities["p1"]!.lastSeenTick).toBe(777);
  });
});

describe("O1: every GameEvent carries a tick (spec/01 §5)", () => {
  it("stamps a command's event with the now that command saw", () => {
    const { harness } = rig({ nowTick: 0 });

    const out = harness.call(fine, "go", { seq: 1, actorId: "jia", tick: 40 });
    if (!out.result.ok) {
      throw new Error("expected an ok result");
    }

    expect(out.result.events).toMatchObject([{ type: "ran", tick: 40 }]);
  });

  it("stamps the HIGH-WATER reading, so a backwards tick cannot date an event into the past", () => {
    const { harness } = rig({ nowTick: 0 });

    harness.call(fine, "go", { seq: 1, actorId: "jia", tick: 100 });
    const out = harness.call(fine, "go", { seq: 2, actorId: "jia", tick: 50 });
    if (!out.result.ok) {
      throw new Error("expected an ok result");
    }

    // The command ran normally; only "now" is the high-water mark, so the
    // event is dated 100 — the tick the engine admits — not 50.
    expect(out.result.events).toMatchObject([{ type: "ran", tick: 100 }]);
  });
});
