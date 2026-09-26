import { describe, expect, it } from "vitest";
import {
  SAVE_VERSION,
  createContentRegistry,
  createDueBucket,
  createEntity,
  createSeededRng,
  createWorldRuntime,
} from "@sexymud/core";
import type {
  CmdSetSource,
  CommandResult,
  CommandSpec,
  DueBucket,
  DueItem,
  EventMeta,
  GameEvent,
  Rng,
  SaveDataV2,
  SettleSpan,
  WorldRuntime,
} from "@sexymud/core";
import { createHostClock } from "../src/game/hostClock.js";
import { createLocalAuthority } from "../src/game/localAuthority.js";
import type { LocalAuthority } from "../src/game/localAuthority.js";
import { SPECS, SOURCES, recordingBucket } from "./support.js";

/**
 * The host's `Authority` (ADR-0017, spec/01 §3): the production counterpart
 * of the test harness, driving the same fixed four steps (spec/04 §4.1).
 *
 * Everything here is SYNTHETIC, after the settle.test.ts precedent: the state
 * tree has no numeric slot worth catching up yet (M4 lands the mechanism, not
 * the consumers), so the entity layer is measured through the injected seam
 * and the world layer through the real one — the due bucket. The synthetic
 * commands live in ./support.ts, shared with the end-to-end run.
 */

interface Delivery {
  events: GameEvent[];
  meta: EventMeta;
}

interface Rig {
  authority: LocalAuthority;
  runtime: WorldRuntime;
  rng: Rng;
  bucket: DueBucket;
  fired: DueItem[];
  worldSpans: SettleSpan[];
  entitySpans: { entityId: string; fromTick: number; toTick: number }[];
  deliveries: Delivery[];
  wall: { ms: number };
}

function rig(
  options: {
    specs?: ReadonlyMap<string, CommandSpec<WorldRuntime>>;
    cmdsetsOf?: (actorId: string) => readonly CmdSetSource[];
  } = {},
): Rig {
  const registry = createContentRegistry({
    rooms: [
      {
        id: "room-a",
        name: "name-room-a",
        description: "description-room-a",
        enterText: "enter-room-a",
        exits: [],
      },
    ],
  });
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("jia"), "room-a");
  const wall = { ms: 0 };
  const hostClock = createHostClock({ tickSeconds: 1, now: () => wall.ms });
  const rng = createSeededRng(1);

  const fired: DueItem[] = [];
  const baseBucket = createDueBucket({
    fire: (item, emit) => {
      fired.push(item);
      emit("jia", { type: "fuseFired", kind: (item.payload as { kind: string }).kind });
    },
  });
  const worldSpans: SettleSpan[] = [];
  const bucket = recordingBucket(baseBucket, worldSpans);

  const entitySpans: { entityId: string; fromTick: number; toTick: number }[] = [];
  const deliveries: Delivery[] = [];
  const authority = createLocalAuthority({
    runtime,
    rng,
    hostClock,
    specs: options.specs ?? SPECS,
    cmdsetsOf: options.cmdsetsOf ?? (() => SOURCES),
    bucket,
    entity: (entityId, span) => {
      entitySpans.push({ entityId, fromTick: span.fromTick, toTick: span.toTick });
    },
  });
  authority.subscribe((events, meta) => {
    deliveries.push({ events, meta });
  });
  return { authority, runtime, rng, bucket, fired, worldSpans, entitySpans, deliveries, wall };
}

function eventsOf(result: CommandResult): GameEvent[] {
  return result.ok ? result.events : [];
}

describe("the local Authority runs the fixed four steps (spec/04 §4.1)", () => {
  it("settles before the command, settlement events in front of its own", async () => {
    const r = rig();
    r.wall.ms = 10_000;
    await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 10, raw: "arm" });

    r.wall.ms = 100_000;
    const result = await r.authority.dispatch({ seq: 2, actorId: "jia", tick: 100, raw: "greet" });

    // The fuse went off in the CATCH-UP, stamped with the tick it was DUE —
    // not the tick it was caught up on (ADR-0034 §3).
    expect(eventsOf(result).map((event) => [event.type, event.tick, event.seq])).toEqual([
      ["fuseFired", 70, 2],
      ["greeted", 100, 2],
    ]);
    // Two spans of one function (spec/04 §4.2), world layer first.
    expect(r.worldSpans).toEqual([
      { fromTick: 0, toTick: 10 },
      { fromTick: 10, toTick: 100 },
    ]);
    expect(r.entitySpans).toEqual([
      { entityId: "jia", fromTick: 0, toTick: 10 },
      { entityId: "jia", fromTick: 10, toTick: 100 },
    ]);
    expect(r.runtime.clock.nowTick()).toBe(100);
  });

  it("an input that cannot become a command moves nothing at all", async () => {
    const r = rig();
    r.wall.ms = 100_000;

    const brokenResult = await r.authority.dispatch({
      seq: 1,
      actorId: "jia",
      tick: 1000,
      raw: "broken",
    });
    expect(brokenResult).toMatchObject({ ok: false, seq: 1, kind: "invalid", reason: "badInput" });
    const unknown = await r.authority.dispatch({ seq: 2, actorId: "jia", tick: 1000, raw: "nonsense" });
    expect(unknown).toMatchObject({ ok: false, seq: 2, kind: "invalid", reason: "unknownVerb" });

    // Not even the advance function ran — a tick=1000 garble must not
    // fast-forward the world (spec/04 §4.1).
    expect(r.worldSpans).toEqual([]);
    expect(r.entitySpans).toEqual([]);
    expect(r.runtime.clock.nowTick()).toBe(0);
    // `invalid` consumes no seq: no delivery, so the caller may reissue it.
    expect(r.deliveries).toEqual([]);
  });

  it("a rejection consumes its seq AND still advances the world", async () => {
    const r = rig();
    r.wall.ms = 50_000;

    const result = await r.authority.dispatch({ seq: 7, actorId: "jia", tick: 50, raw: "veto" });

    expect(result).toMatchObject({ ok: false, seq: 7, kind: "rejected", reason: "gateClosed" });
    expect(r.worldSpans).toEqual([{ fromTick: 0, toTick: 50 }]);
    expect(r.runtime.clock.nowTick()).toBe(50);
    expect(r.deliveries).toHaveLength(1);
    expect(r.deliveries[0]!.meta).toEqual({ fromSeq: 7, toSeq: 7 });
    // The refusal is game content and rides the stream (spec/01 §4).
    expect(r.deliveries[0]!.events.map((event) => event.type)).toEqual(["commandRefused"]);
  });

  it("delivers one batch per consumed seq — empty batches included, invalid none", async () => {
    const r = rig();

    await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 5, raw: "greet" });
    r.authority.heartbeat(2); // nothing due: the seq is spent, the batch is empty
    await r.authority.dispatch({ seq: 3, actorId: "jia", tick: 6, raw: "broken" });
    await r.authority.dispatch({ seq: 4, actorId: "jia", tick: 7, raw: "greet" });

    // 3 is absent on purpose: it was never consumed, so the UI may reissue it.
    expect(r.deliveries.map((delivery) => delivery.meta)).toEqual([
      { fromSeq: 1, toSeq: 1 },
      { fromSeq: 2, toSeq: 2 },
      { fromSeq: 4, toSeq: 4 },
    ]);
    expect(r.deliveries[1]!.events).toEqual([]);
  });

  it("a wall clock that jumps backwards cannot rewind the world", async () => {
    const r = rig();
    r.wall.ms = 100_000;
    await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 100, raw: "greet" });

    r.wall.ms = 30_000; // the user's clock was corrected backwards
    const result = await r.authority.dispatch({ seq: 2, actorId: "jia", tick: 30, raw: "greet" });

    // The command still runs; everything time-shaped reads the high-water
    // mark (spec/04 §2.2), so its event is dated "now" — 100, not 30.
    expect(eventsOf(result).map((event) => event.tick)).toEqual([100]);
    expect(r.runtime.clock.nowTick()).toBe(100);
  });

  it("a verb routed to an unbound key fails loudly — wiring, not play", async () => {
    const r = rig({
      cmdsetsOf: () => [{ priority: 0, commands: [{ key: "ghost", verbs: ["ghost"] }] }],
    });

    await expect(
      r.authority.dispatch({ seq: 1, actorId: "jia", tick: 1, raw: "ghost" }),
    ).rejects.toThrow(/no spec bound to command key "ghost"/);
  });

  it("assembles the actor's sources per dispatch — never a cached table", async () => {
    const r = rig({
      cmdsetsOf: (actorId) => (actorId === "jia" ? SOURCES : []),
    });

    const forJia = await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 1, raw: "greet" });
    expect(forJia.ok).toBe(true);

    const forYi = await r.authority.dispatch({ seq: 2, actorId: "yi", tick: 2, raw: "greet" });
    expect(forYi).toMatchObject({ ok: false, seq: 2, kind: "invalid", reason: "unknownVerb" });
  });

  it("an unsubscribe silences only that listener", async () => {
    const r = rig();
    const extra: Delivery[] = [];
    const stop = r.authority.subscribe((events, meta) => {
      extra.push({ events, meta });
    });
    stop();

    await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 1, raw: "greet" });

    expect(extra).toEqual([]);
    expect(r.deliveries).toHaveLength(1);
  });
});

describe("heartbeat: advance without a command (ADR-0034 §5)", () => {
  it("takes its seq from the caller, in the commands' own monotonic space", async () => {
    const r = rig();
    r.wall.ms = 10_000;
    await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 10, raw: "arm" });

    r.wall.ms = 40_000;
    expect(r.authority.heartbeat(2)).toEqual([]);

    r.wall.ms = 80_000;
    // The fuse is due at 70: the beat that crosses it fires it, stamped 70.
    expect(r.authority.heartbeat(3).map((event) => [event.type, event.tick, event.seq])).toEqual([
      ["fuseFired", 70, 3],
    ]);

    await r.authority.dispatch({ seq: 4, actorId: "jia", tick: 80, raw: "greet" });

    // One seq space across commands and beats, whatever order they land in.
    expect(r.deliveries.map((delivery) => delivery.meta.fromSeq)).toEqual([1, 2, 3, 4]);
  });

  it("runs the world layer alone — no actor, no entity layer, no forged command", async () => {
    const r = rig();
    r.wall.ms = 30_000;

    r.authority.heartbeat(1);

    expect(r.worldSpans).toEqual([{ fromTick: 0, toTick: 30 }]);
    expect(r.entitySpans).toEqual([]);
    // Nobody's `lastSeenTick` moved: a heartbeat is not anybody's activity.
    expect(r.runtime.state.entities["jia"]!.lastSeenTick).toBe(0);
  });
});

describe("snapshot(): the save boundary (ADR-0033, O9)", () => {
  it("carries the three world scalars beside the tree", async () => {
    const r = rig();
    r.wall.ms = 10_000;
    await r.authority.dispatch({ seq: 1, actorId: "jia", tick: 10, raw: "arm" });

    const snapshot = await r.authority.snapshot();
    const data = snapshot.data as SaveDataV2;

    expect(snapshot.version).toBe(SAVE_VERSION);
    expect(data.nowTick).toBe(10);
    expect(data.rngState).toBe(r.rng.getState());
    expect(data.due).toEqual([{ dueTick: 70, payload: { kind: "fuse" } }]);
    expect(data.entities["jia"]?.lastSeenTick).toBe(10);
    expect(r.fired).toEqual([]);
  });
});
