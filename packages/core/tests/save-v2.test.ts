import { describe, expect, it } from "vitest";
import { createSeededRng } from "../src/rng.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import type { SaveDataV2, WorldMeta } from "../src/state/snapshot.js";
import type { WorldState } from "../src/state/tree.js";
import type { Snapshot } from "../src/types.js";
import { createContentRegistry } from "../src/content/registry.js";
import { returnAppearance } from "../src/world/look.js";
import { createEntity } from "../src/world/entity.js";
import type { RoomEntry } from "../src/world/entry.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import { cooldownReady } from "../src/time/cooldown.js";
import { createDueBucket } from "../src/time/due.js";
import { createSettler } from "../src/time/settle.js";

/**
 * Save v2 (ADR-0033, spec/04 §1.5): the engine's "now", the random stream's
 * state and the due bucket's pending items travel with the tree.
 *
 * Without `nowTick` a restored world runs its clock from zero — every pending
 * cooldown reads as "not yet due", forever. Without `rngState` the stream
 * restarts, so a saved fight no longer replays. Without `due` an armed
 * delayed effect simply vanishes. All three are the same argument: a
 * deterministic engine's save has to be a round trip.
 *
 * Synthetic throughout: rooms made in code, one player, a payload no content
 * pack ships.
 */

const ROOMS: RoomEntry[] = [
  {
    id: "room-a",
    name: "name-room-a",
    description: "description-room-a",
    enterText: "enter-room-a",
    exits: [],
  },
];

const registry = () => createContentRegistry({ rooms: ROOMS });

function onePlayer(nowTick = 0): WorldState {
  const runtime = createWorldRuntime({ registry: registry(), nowTick });
  runtime.addEntity(createEntity("player-1"), "room-a");
  return runtime.state;
}

const NO_META: WorldMeta = { nowTick: 0, rngState: 0, due: [] };

describe("Rng.getState() (ADR-0033 §1)", () => {
  it("exports the stream's whole state as one number", () => {
    const rng = createSeededRng(1);

    expect(typeof rng.getState()).toBe("number");
    // mulberry32's state IS one uint32, so this never grows: no counter to
    // keep, no history to replay (the rejected "seed + fast-forward" design
    // was O(age of the save)).
    expect(Number.isSafeInteger(rng.getState())).toBe(true);
    expect(rng.getState()).toBeGreaterThanOrEqual(0);
  });

  it("moves as the stream is consumed — otherwise it would save nothing", () => {
    const rng = createSeededRng(7);
    const before = rng.getState();
    rng.next();
    const after = rng.getState();

    expect(after).not.toBe(before);
  });

  it("resumes the SAME stream: one function for starting and restoring", () => {
    // ADR-0033's consequence: `createSeededRng(state)` is both, because both
    // take the same single number. Two entry points would suggest two
    // meanings where there is one.
    const original = createSeededRng(99);
    original.next();
    original.next();
    const saved = original.getState();

    const resumed = createSeededRng(saved);
    const expected = [original.next(), original.next(), original.next()];

    expect([resumed.next(), resumed.next(), resumed.next()]).toEqual(expected);
  });

  it("gives a different state a different stream — the state is the whole story", () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);

    expect(a.next()).not.toBe(b.next());
  });
});

describe("the world scalars travel beside the tree (O9, spec/04 §1.5)", () => {
  it("round-trips nowTick, rngState and due through a JSON boundary", () => {
    const snapshot = serializeWorld(onePlayer(500), {
      nowTick: 500,
      rngState: 4_294_967_295,
      due: [{ dueTick: 900, payload: { roomId: "room-a", charge: 3 } }],
    });
    const wire = JSON.parse(JSON.stringify(snapshot)) as Snapshot;

    const { state, meta } = restoreWorld(wire);

    expect(Object.keys(state.entities)).toEqual(["player-1"]);
    expect(meta).toEqual({
      nowTick: 500,
      rngState: 4_294_967_295,
      due: [{ dueTick: 900, payload: { roomId: "room-a", charge: 3 } }],
    });
  });

  it("hands the tree and the scalars back as two values, not one — the O9 answer", () => {
    // The high-water mark lives on the side that DRIVES the world, not in
    // `WorldState`; folding it into the tree would make every tree-typed
    // parameter carry a clock it does not own.
    const restored = restoreWorld(serializeWorld(onePlayer(0), NO_META));

    expect(Object.keys(restored)).toEqual(["state", "meta"]);
    expect(Object.keys(restored.state)).toEqual(["entities"]);
  });

  it("canonicalizes due: ascending by dueTick whatever order the host armed", () => {
    const snapshot = serializeWorld(onePlayer(0), {
      nowTick: 0,
      rngState: 0,
      due: [
        { dueTick: 900, payload: "third" },
        { dueTick: 100, payload: "first" },
        { dueTick: 400, payload: "second" },
      ],
    });

    expect((snapshot.data as SaveDataV2).due.map((item) => item.payload)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("is byte-stable: the same due items armed in another order save identically", () => {
    const armed = (order: [number, string][]) =>
      serializeWorld(onePlayer(0), {
        nowTick: 10,
        rngState: 20,
        due: order.map(([dueTick, payload]) => ({ dueTick, payload })),
      });

    expect(
      JSON.stringify(
        armed([
          [900, "later"],
          [100, "sooner"],
        ]),
      ),
    ).toBe(
      JSON.stringify(
        armed([
          [100, "sooner"],
          [900, "later"],
        ]),
      ),
    );
  });

  it("reads missing scalars as empty — no special case for v2's new slots", () => {
    // ADR-0033 §4. The cost is worth stating out loud, and this is where it
    // is pinned: a `nowTick` that is missing or corrupt does NOT fail. The
    // game carries on from tick 0, so `nowTick >= dueTick` is false for every
    // pending cooldown and they are not "broken" — they never come due.
    const v2WithoutScalars = {
      version: 2,
      data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [] } } },
    } as Snapshot;

    const { meta } = restoreWorld(v2WithoutScalars);

    expect(meta).toEqual({ nowTick: 0, rngState: 0, due: [] });
  });

  it("rejects a due field that is present but not a list", () => {
    // Written in, so it must be legal — the `tags` precedent. (The ITEMS are
    // validated by the bucket's own restore(), which owns that shape.)
    const withDue = (due: unknown) =>
      ({
        version: 2,
        data: {
          entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [] } },
          due,
        },
      }) as Snapshot;

    expect(() => restoreWorld(withDue({ dueTick: 5 }))).toThrow(/data\.due is not a list/);
    expect(() => restoreWorld(withDue("soon"))).toThrow(/data\.due is not a list/);
  });

  it("refuses a nowTick that is not a tick — a save without a clock is a wiring bug", () => {
    expect(() => serializeWorld(onePlayer(0), { nowTick: -1, rngState: 0, due: [] })).toThrow(
      /meta\.nowTick/,
    );
    expect(() =>
      serializeWorld(onePlayer(0), { nowTick: Number.NaN, rngState: 0, due: [] }),
    ).toThrow(/meta\.nowTick/);
  });
});

describe("the host's save/load loop, end to end (spec/04 §1.5)", () => {
  it("reloads a world that keeps its clock, its stream and its armed bomb", () => {
    // The whole point of v2, in one test: everything the tree cannot carry
    // comes back, and the world carries on from where it was left.
    const savedRegistry = registry();
    const first = createWorldRuntime({ registry: savedRegistry, nowTick: 500 });
    first.addEntity(createEntity("player-1"), "room-a");
    first.state.entities["player-1"]!.cooldowns = { doorRelock: 800 };
    const rng = createSeededRng(42);
    rng.next();
    const bucket = createDueBucket({
      fire: (item, emit) => emit("broadcast", { type: "wentOff", id: item.payload }),
    });
    bucket.schedule(900, "bomb");

    // SAVE — the host reads its own runtime, clock, stream and bucket.
    const snapshot = serializeWorld(first.state, {
      nowTick: first.clock.nowTick(),
      rngState: rng.getState(),
      due: bucket.snapshot(),
    });
    const wire = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    const expectedNext = rng.next();

    // LOAD — and the same four pieces go back where they came from.
    const { state, meta } = restoreWorld(wire);
    const second = createWorldRuntime({ registry: registry(), state, nowTick: meta.nowTick });
    const resumedRng = createSeededRng(meta.rngState);
    const reloadedBucket = createDueBucket({
      fire: (item, emit) => emit("broadcast", { type: "wentOff", id: item.payload }),
    });
    reloadedBucket.restore(meta.due);
    second.attachEntity(createEntity("player-1"));

    // The clock: cooldowns still read against the tick the world was saved
    // at, so "relocks at 800" still means "relocks at 800".
    expect(second.clock.nowTick()).toBe(500);
    const cooldowns = second.state.entities["player-1"]!.cooldowns;
    expect(cooldownReady(cooldowns, "doorRelock", 500)).toBe(false);
    expect(cooldownReady(cooldowns, "doorRelock", 800)).toBe(true);
    // The stream: same state in, same number out.
    expect(resumedRng.next()).toBe(expectedNext);
    // The bomb: still armed, and it fires when the world reaches it.
    const settler = createSettler({
      state: second.state,
      clock: second.clock,
      world: reloadedBucket.settle,
    });
    const out = settler.settleTo({ toTick: 900, seq: 1 });
    expect(out).toEqual([
      { to: "broadcast", event: { seq: 1, tick: 900, type: "wentOff", actorId: "", id: "bomb" } },
    ]);
    // And the restored world is a world, not a picture of one.
    expect(returnAppearance(second, "room-a", "player-1").occupants).toEqual([]);
  });

  it("reads a v1 save written before any of this existed", () => {
    // The chain's first real exercise: a v1 payload becomes a playable v2
    // world, with the scalars the v1 author could not have known about.
    const v1 = {
      version: 1,
      data: {
        entities: { "player-1": { id: "player-1", locationId: "room-a", flags: ["lit"] } },
      },
    } as Snapshot;

    const { state, meta } = restoreWorld(v1);

    expect(meta).toEqual({ nowTick: 0, rngState: 0, due: [] });
    expect(state.entities["player-1"]).toMatchObject({
      id: "player-1",
      locationId: "room-a",
      flags: ["lit"],
      tags: {},
      lastSeenTick: 0,
      cooldowns: {},
    });
  });
});
