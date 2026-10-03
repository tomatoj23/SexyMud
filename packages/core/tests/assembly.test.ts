import { describe, expect, it } from "vitest";
import { customEvent } from "../src/events.js";
import { assembleWorld, collectMeta } from "../src/state/assembly.js";
import { serializeWorld } from "../src/state/snapshot.js";
import type { Snapshot } from "../src/types.js";
import { createSeededRng } from "../src/rng.js";
import { createDueBucket } from "../src/time/due.js";
import type { DueBucket } from "../src/time/due.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import { createEntity } from "../src/world/entity.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { RoomEntry } from "../src/world/entry.js";

/**
 * The load path's one entry and the save path's symmetric face (#37, spec/04
 * §1.5).
 *
 * What is pinned here is the COMPLETENESS of the five-step checklist
 * (`restoreWorld` → `createWorldRuntime` → `createSeededRng` →
 * `bucket.restore` → `attachEntity` × N) and the COLLECTION of the three world
 * scalars — one assertion per step's effect. ⚠️ Deliberately NO order
 * assertion anywhere: the sequence is the entry's implementation detail (D1),
 * and a test that pinned it would be asserting freedom that does not exist.
 *
 * The hand path is NOT exercised here — it stays legal and stays covered by
 * `snapshot.test.ts` and `cooldown.test.ts`, which still hand-assemble (the
 * additive red line, D2). This file's job is the entry and its symmetric
 * collection face, nothing else.
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

const makeBucket = (): DueBucket =>
  createDueBucket({
    fire: (item, emit) => emit("broadcast", customEvent("wentOff", { id: item.payload })),
  });

/**
 * A world with one player, a relocking door and a bomb — everything the tree
 * cannot carry is armed too (the mark at 500, the stream consumed once, one
 * fuse at 900).
 */
function liveWorld() {
  const runtime = createWorldRuntime({ registry: registry(), nowTick: 500 });
  runtime.addEntity(createEntity("player-1"), "room-a");
  runtime.state.entities["player-1"]!.cooldowns = { doorRelock: 800 };
  const rng = createSeededRng(42);
  rng.next();
  const bucket = makeBucket();
  bucket.schedule(900, "bomb");
  return { runtime, rng, bucket };
}

/**
 * The save those live pieces write, through the JSON boundary for good
 * measure. Collection routes through `collectMeta` on purpose — there is no
 * fifth hand-rolled "world → meta" to keep honest here, because the expected
 * scalars are hand-computed IN the assertions below (test one pins the entry's
 * meta field against values no collection could corrupt silently).
 */
function saveOf(live: ReturnType<typeof liveWorld>): Snapshot {
  const snapshot = serializeWorld(live.runtime.state, collectMeta(live));
  return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
}

describe("assembleWorld — the load path's one entry (D1/D2, #37)", () => {
  it("runs all five steps — the completeness checklist, in no asserted order", () => {
    const live = liveWorld();
    const savedState = live.rng.getState();
    const snapshot = saveOf(live);
    const expectedNext = live.rng.next();
    const player = createEntity("player-1");

    const assembled = assembleWorld({
      snapshot,
      registry: registry(),
      bucket: makeBucket(),
      entities: [player],
    });

    // restoreWorld — the tree came back whole: the saved cooldown survived.
    expect(assembled.runtime.state.entities["player-1"]!.cooldowns).toEqual({ doorRelock: 800 });
    // createWorldRuntime — the restored tree is DRIVEN, from the saved mark.
    expect(assembled.runtime.clock.nowTick()).toBe(500);
    expect(assembled.runtime.occupantsOf("room-a")).toEqual(["player-1"]);
    // createSeededRng — the stream resumes where it was saved.
    expect(assembled.rng.next()).toBe(expectedNext);
    // bucket.restore — the bomb is still armed.
    expect(assembled.bucket.snapshot()).toEqual([{ dueTick: 900, payload: "bomb" }]);
    // attachEntity × N — the world answers with the very instance passed in.
    expect(assembled.runtime.entity("player-1")).toBe(player);
    // And the scalars the save carried ride back out in the bundle.
    expect(assembled.meta).toEqual({
      nowTick: 500,
      rngState: savedState,
      due: [{ dueTick: 900, payload: "bomb" }],
    });
  });

  it("attaches every rebuilt instance — the ×N is part of the checklist", () => {
    const live = liveWorld();
    live.runtime.addEntity(createEntity("player-2"), "room-a");
    const snapshot = saveOf(live);
    const player1 = createEntity("player-1");
    const player2 = createEntity("player-2");

    const assembled = assembleWorld({
      snapshot,
      registry: registry(),
      bucket: makeBucket(),
      entities: [player1, player2],
    });

    expect(assembled.runtime.entity("player-1")).toBe(player1);
    expect(assembled.runtime.entity("player-2")).toBe(player2);
  });

  it("hands back THE bucket it was given — the live one, armed and firing", () => {
    // D3's live-bucket rule: the entry restores INTO the host's bucket and
    // returns that same object. A second bucket would lose the fuses.
    const live = liveWorld();
    const bucket = makeBucket();

    const assembled = assembleWorld({
      snapshot: saveOf(live),
      registry: registry(),
      bucket,
      entities: [createEntity("player-1")],
    });

    expect(assembled.bucket).toBe(bucket);
    expect(bucket.snapshot()).toEqual([{ dueTick: 900, payload: "bomb" }]);
  });

  it("passes RestoreOptions through — the recompute seam is reachable from the entry", () => {
    const live = liveWorld();
    const seen: string[] = [];

    assembleWorld({
      snapshot: saveOf(live),
      registry: registry(),
      bucket: makeBucket(),
      entities: [createEntity("player-1")],
      restore: {
        recomputeDerived: (state) => {
          seen.push(`${state.id}@${state.locationId}`);
        },
      },
    });

    expect(seen).toEqual(["player-1@room-a"]);
  });

  it("refuses a half-rebuilt world — every restored entity brings its instance", () => {
    // D1's promise is that OMISSION is impossible: the five steps cannot be
    // skipped, and the ×N must not silently under-count. A restored entity
    // with no instance would play fine until someone asks IT for a hook — the
    // very death the checklist exists to prevent. (The hand path stays free
    // to attach any subset; only the entry is whole.)
    const live = liveWorld();
    live.runtime.addEntity(createEntity("player-2"), "room-a");

    expect(() =>
      assembleWorld({
        snapshot: saveOf(live),
        registry: registry(),
        bucket: makeBucket(),
        entities: [createEntity("player-1")],
      }),
    ).toThrow(/no hook instance: player-2/);
  });

  it("a failed load leaves the host's live fuses armed", () => {
    // The failure contract, deliberately NOT an order assertion: whatever
    // sequence the five steps run in, the caller-owned live bucket — the one
    // mutable piece the entry is handed — must survive a failed load
    // untouched. A load that threw mid-way leaving the save's due items over
    // live fuses would be the half-interpreted state the loud-failure law
    // forbids (spec/04 §1.4).
    const live = liveWorld();
    const armed = makeBucket();
    armed.schedule(50, "live-fuse");

    // Content drift: the restored player sits in a room this registry does
    // not have, so attachEntity throws.
    expect(() =>
      assembleWorld({
        snapshot: saveOf(live),
        registry: createContentRegistry({ rooms: [] }),
        bucket: armed,
        entities: [createEntity("player-1")],
      }),
    ).toThrow(/neither a loaded room/);

    expect(armed.snapshot()).toEqual([{ dueTick: 50, payload: "live-fuse" }]);
  });

  it("a save with malformed due items never half-loads the host's bucket", () => {
    // The same failure contract from the other throw site: `bucket.restore`
    // resolves items in full before replacing (due.ts) and runs only once the
    // world is whole — so a malformed item can neither half-load the bucket
    // nor disarm what was armed.
    const live = liveWorld();
    const snapshot = saveOf(live);
    const tampered = {
      ...snapshot,
      data: { ...(snapshot.data as Record<string, unknown>), due: [{ dueTick: "late" }] },
    } as Snapshot;
    const armed = makeBucket();
    armed.schedule(50, "live-fuse");

    expect(() =>
      assembleWorld({
        snapshot: tampered,
        registry: registry(),
        bucket: armed,
        entities: [createEntity("player-1")],
      }),
    ).toThrow(/due bucket/);

    expect(armed.snapshot()).toEqual([{ dueTick: 50, payload: "live-fuse" }]);
  });
});

describe("collectMeta — the save path's symmetric face (D3, #37)", () => {
  it("reads the three slots off the bundle's LIVE faces", () => {
    const live = liveWorld();
    const twin = createSeededRng(live.rng.getState());
    const assembled = assembleWorld({
      snapshot: saveOf(live),
      registry: registry(),
      bucket: makeBucket(),
      entities: [createEntity("player-1")],
    });

    // The world moves after assembly: the mark rises, the stream is consumed,
    // a second fuse is armed. Collection must report THAT world — not the
    // meta the bundle was assembled with.
    assembled.runtime.clock.observe(520);
    const consumed = assembled.rng.next();
    assembled.bucket.schedule(950, "mine");
    const expectedConsumed = twin.next();
    const expectedState = twin.getState();

    expect(consumed).toBe(expectedConsumed);
    expect(collectMeta(assembled)).toEqual({
      nowTick: 520,
      rngState: expectedState,
      due: [
        { dueTick: 900, payload: "bomb" },
        { dueTick: 950, payload: "mine" },
      ],
    });
  });

  it("eats any same-shaped bundle — the narrow face is the contract, not the entry's return", () => {
    // A host that assembles by hand hands collectMeta exactly what
    // localAuthority.snapshot() hands it: three live objects, no meta.
    const runtime = createWorldRuntime({ registry: registry(), nowTick: 7 });
    const rng = createSeededRng(3);
    const bucket = makeBucket();
    bucket.schedule(10, "short");

    expect(collectMeta({ runtime, rng, bucket })).toEqual({
      nowTick: 7,
      rngState: 3,
      due: [{ dueTick: 10, payload: "short" }],
    });
  });
});

describe("the round trip through the two faces (spec/04 §1.5)", () => {
  it("keeps clock, stream and armed items — the world continues where it was left", () => {
    const live = liveWorld();
    const twin = createSeededRng(live.rng.getState());
    const one = assembleWorld({
      snapshot: saveOf(live),
      registry: registry(),
      bucket: makeBucket(),
      entities: [createEntity("player-1")],
    });

    // World one plays on a little.
    one.runtime.clock.observe(600);
    one.rng.next();
    one.bucket.schedule(990, "mine");

    // Save again — the collection face is the save side of the same round.
    const saved = serializeWorld(one.runtime.state, collectMeta(one));
    const wire = JSON.parse(JSON.stringify(saved)) as Snapshot;
    const two = assembleWorld({
      snapshot: wire,
      registry: registry(),
      bucket: makeBucket(),
      entities: [createEntity("player-1")],
    });

    expect(two.meta).toEqual(collectMeta(one));
    expect(two.runtime.clock.nowTick()).toBe(600);
    // The stream continued: one consumed number, then the next.
    twin.next();
    expect(two.rng.next()).toBe(twin.next());
    expect(two.bucket.snapshot()).toEqual([
      { dueTick: 900, payload: "bomb" },
      { dueTick: 990, payload: "mine" },
    ]);
    // And the tree is the same tree — the cooldown's tick never moved.
    expect(two.runtime.state.entities["player-1"]!.cooldowns).toEqual({ doorRelock: 800 });
    expect(two.runtime.state.entities["player-1"]!.locationId).toBe("room-a");
  });
});

