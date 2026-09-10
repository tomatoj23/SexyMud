import { describe, expect, it } from "vitest";
import { cooldownReady, cooldownRemaining } from "../src/time/cooldown.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import type { EntityState, WorldState } from "../src/state/tree.js";
import type { Snapshot } from "../src/types.js";
import { createContentRegistry } from "../src/content/registry.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import { createEntity } from "../src/world/entity.js";
import type { RoomEntry } from "../src/world/entry.js";

/**
 * Cooldowns (spec/04 §4.6, ADR-0032 §5): a `key → due tick` table judged by
 * TICK COMPARISON — `nowTick >= dueTick` — not by a timer, a callback or a
 * handle. No registration, nothing to cancel, nothing to advance: nothing has
 * to happen for a cooldown to expire, the world simply reaches the tick.
 *
 * Which is exactly why it has to be storable: a long cooldown ("this door
 * relocks in three days") must still be pending after a reload, and a number
 * survives a save whereas a timer does not.
 */

const ROOMS: RoomEntry[] = [
  { id: "room-a", name: "name-room-a", description: "description-room-a", enterText: "enter-room-a", exits: [] },
];

function runtime(nowTick = 0) {
  return createWorldRuntime({
    registry: createContentRegistry({ rooms: ROOMS }),
    nowTick,
  });
}

/** A save whose entity carries the given cooldowns field (or omits it). */
function saveWith(cooldowns?: unknown): Snapshot {
  return {
    version: 1,
    data: {
      entities: {
        "player-1": {
          id: "player-1",
          locationId: "room-a",
          flags: [],
          ...(cooldowns === undefined ? {} : { cooldowns }),
        },
      },
    },
  } as Snapshot;
}

describe("judgement is a tick comparison, not a callback (spec/04 §4.6)", () => {
  it("is ready exactly AT the due tick — the interval is half-open", () => {
    const cooldowns = { doorRelock: 100 };

    expect(cooldownReady(cooldowns, "doorRelock", 99)).toBe(false);
    // Due AT 100 means usable at 100: the cooldown covers [armed, due), and
    // every interval in this engine is half-open (spec/04 §3.2).
    expect(cooldownReady(cooldowns, "doorRelock", 100)).toBe(true);
    expect(cooldownReady(cooldowns, "doorRelock", 100_000)).toBe(true);
  });

  it("reads an absent key as ready — never armed, not unknown", () => {
    expect(cooldownReady({}, "neverUsed", 0)).toBe(true);
    expect(cooldownRemaining({}, "neverUsed", 0)).toBe(0);
  });

  it("counts the remainder down, never below zero", () => {
    const cooldowns = { skill: 50 };

    expect(cooldownRemaining(cooldowns, "skill", 0)).toBe(50);
    expect(cooldownRemaining(cooldowns, "skill", 20)).toBe(30);
    expect(cooldownRemaining(cooldowns, "skill", 50)).toBe(0);
    // Overdue is not negative: a negative remainder would read as "extra
    // time owed" to anything that added it back on.
    expect(cooldownRemaining(cooldowns, "skill", 9_000)).toBe(0);
  });

  it("keeps one entity's cooldown out of another's — the table is per entity", () => {
    const jia: EntityState["cooldowns"] = { skill: 80 };
    const yi: EntityState["cooldowns"] = {};

    expect(cooldownReady(jia, "skill", 10)).toBe(false);
    expect(cooldownReady(yi, "skill", 10)).toBe(true);
  });

  it("costs nothing to ask a million ticks later — there is nothing to advance", () => {
    // The whole point: unlike the due bucket, a cooldown needs no settle to
    // expire. Asking is one comparison whether the answer is one tick away or
    // a million.
    const cooldowns = { doorRelock: 5 };

    expect(cooldownReady(cooldowns, "doorRelock", 1_000_000)).toBe(true);
    expect(cooldownRemaining(cooldowns, "doorRelock", 1_000_000)).toBe(0);
  });

  it("fails loudly on a now that is not a tick", () => {
    expect(() => cooldownReady({ a: 1 }, "a", -1)).toThrow(/nowTick/);
    expect(() => cooldownRemaining({ a: 1 }, "a", Number.NaN)).toThrow(/nowTick/);
  });
});

describe("the cooldowns slot in the state tree (spec/04 §4.6, §1.5)", () => {
  it("is seeded empty by addEntity — no `??` in front of every read", () => {
    const world = runtime(300);
    world.addEntity(createEntity("player-1"), "room-a");

    expect(world.state.entities["player-1"]!.cooldowns).toEqual({});
    expect(cooldownReady(world.state.entities["player-1"]!.cooldowns, "skill", 300)).toBe(true);
  });

  it("does not re-seed on the load path: a restored table keeps its numbers", () => {
    const restored = restoreWorld(
      saveWith({ doorRelock: 777 }) as Snapshot,
    );
    const world = createWorldRuntime({
      registry: createContentRegistry({ rooms: ROOMS }),
      state: restored,
    });
    world.attachEntity(createEntity("player-1"));

    // attachEntity replays a tree, it does not create one: emptying the
    // table would be the inversion the two creation layers exist to prevent.
    expect(world.state.entities["player-1"]!.cooldowns).toEqual({ doorRelock: 777 });
  });
});

describe("cooldowns in the save (spec/04 §4.6, §1.4)", () => {
  it("round-trips through a JSON boundary: a long cooldown survives a reload", () => {
    const world = runtime(0);
    world.addEntity(createEntity("player-1"), "room-a");
    // Three days of ticks, armed today — the case that forced this slot into
    // M4 at all (§4.6: it must outlive the process).
    world.state.entities["player-1"]!.cooldowns = { doorRelock: 259_200, skill: 40 };

    const wire = JSON.parse(JSON.stringify(serializeWorld(world.state))) as Snapshot;
    const restored = restoreWorld(wire);

    expect(restored.entities["player-1"]!.cooldowns).toEqual({ doorRelock: 259_200, skill: 40 });
    expect(cooldownReady(restored.entities["player-1"]!.cooldowns, "doorRelock", 259_199)).toBe(
      false,
    );
    expect(cooldownReady(restored.entities["player-1"]!.cooldowns, "doorRelock", 259_200)).toBe(
      true,
    );
  });

  it("canonicalizes: keys ascending, whatever order a system armed them in", () => {
    const world = runtime(0);
    world.addEntity(createEntity("player-1"), "room-a");
    world.state.entities["player-1"]!.cooldowns = { skill: 5, doorRelock: 90, aura: 1 };

    const record = serializeWorld(world.state).data.entities["player-1"]!;

    // Same promise as flags and tags: two equal worlds save byte-identical,
    // and canonical order is the SERIALIZER's job, not the writer's.
    expect(Object.keys(record.cooldowns!)).toEqual(["aura", "doorRelock", "skill"]);
  });

  it("is byte-stable: the same cooldowns armed in another order save identically", () => {
    const armed = (order: [string, number][]): WorldState => {
      const world = runtime(0);
      world.addEntity(createEntity("player-1"), "room-a");
      world.state.entities["player-1"]!.cooldowns = Object.fromEntries(order);
      return world.state;
    };

    expect(JSON.stringify(serializeWorld(armed([["skill", 5], ["aura", 1]])))).toBe(
      JSON.stringify(serializeWorld(armed([["aura", 1], ["skill", 5]]))),
    );
  });

  it("reads an old save that predates the slot: no cooldowns field, no error, empty", () => {
    // A field that was never written is not persisted (ADR-0022), and the
    // slot landed after v1's first save — so "absent" means empty.
    const restored = restoreWorld(saveWith());

    expect(restored.entities["player-1"]!.cooldowns).toEqual({});
    expect(cooldownReady(restored.entities["player-1"]!.cooldowns, "skill", 0)).toBe(true);
  });

  it("is idempotent: saving a restored save yields the same bytes", () => {
    const first = serializeWorld(restoreWorld(saveWith({ skill: 12 })) as WorldState);

    expect(serializeWorld(restoreWorld(first))).toEqual(first);
  });

  it("rejects a malformed cooldowns field present in a save", () => {
    // A tick that is not a tick does not merely misjudge: `NaN >= dueTick` is
    // false for EVERY dueTick, so the skill would never come back. Written
    // in, so it must be legal (the tags precedent, spec/04 §1.4).
    expect(() => restoreWorld(saveWith(["skill"]))).toThrow(
      /entity "player-1"\.cooldowns is not an object/,
    );
    expect(() => restoreWorld(saveWith({ skill: -1 }))).toThrow(
      /entity "player-1"\.cooldowns\["skill"\] is not a non-negative safe integer/,
    );
    expect(() => restoreWorld(saveWith({ skill: 1.5 }))).toThrow(
      /entity "player-1"\.cooldowns\["skill"\] is not a non-negative safe integer/,
    );
    expect(() => restoreWorld(saveWith({ skill: "soon" }))).toThrow(
      /entity "player-1"\.cooldowns\["skill"\] is not a non-negative safe integer/,
    );
  });
});
