import { describe, expect, it } from "vitest";
import { SAVE_VERSION } from "../src/save/migrations.js";
import { DERIVED_ENTITY_KEYS, stripDerived } from "../src/state/derived.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import type { SaveDataV2, WorldMeta } from "../src/state/snapshot.js";
import type { EntityState, WorldState } from "../src/state/tree.js";
import type { Snapshot } from "../src/types.js";
import { createContentRegistry } from "../src/content/registry.js";
import { createObject } from "../src/world/creation.js";
import type { NpcEntry, PlacementEntry, RoomEntry } from "../src/world/entry.js";
import { createEntity } from "../src/world/entity.js";
import type { Entity } from "../src/world/entity.js";
import { returnAppearance } from "../src/world/look.js";
import { moveTo } from "../src/world/move.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";

/**
 * The snapshot v1 tests (issue #11, spec/04 §1 and §1.3, ADR-0028 §1): the
 * save shape, its round trip, the derived split, loud failures, NPCs staying
 * out of the save, and restore being a REPLAY of the tree rather than a
 * creation.
 *
 * Everything is synthetic (no content files, no SaveStore — host wiring is
 * explicitly out of the ticket): the tests play the host, which is the only
 * role that knows how to build a player entity and where to store bytes.
 *
 * The NPC cases are the mechanical form of ADR-0028 §1: static presence is
 * content truth, and a field that was never written is never persisted. They
 * are here to go red the day someone materializes placement lists into the
 * tree and silently doubles the size of every save.
 */

/** A player entity: seeded through the creation layer, as a host would. */
function player(id: string, flags: readonly string[] = []): Entity {
  return createEntity(id, {
    at_object_creation: (ctx) => {
      ctx.state.flags.push(...flags);
    },
  });
}

/** room-c places a static NPC twice — the presence that must never be saved. */
function makeRooms(): RoomEntry[] {
  const room = (id: string, objects?: readonly PlacementEntry[]): RoomEntry => ({
    id,
    name: `name-${id}`,
    description: `description-${id}`,
    enterText: `enter-${id}`,
    exits: [],
    ...(objects === undefined ? {} : { objects }),
  });
  return [room("room-a"), room("room-b"), room("room-c", [{ id: "npc-keeper", count: 2 }])];
}

const npcs: readonly NpcEntry[] = [
  { id: "npc-keeper", name: "name-npc-keeper", description: "description-npc-keeper" },
];

/** A runtime over an adopted tree — the host's load path in one call. */
function makeRuntime(state?: WorldState): WorldRuntime {
  return createWorldRuntime({
    registry: createContentRegistry({ rooms: makeRooms(), npcs }),
    ...(state === undefined ? {} : { state }),
  });
}

/** The emit port every orchestration here takes; nothing in these tests reads it. */
const silent = { emit: () => {} };

/** A world with one player carrying one flag, standing in room-b. */
function onePlayerWorld(): WorldState {
  const runtime = makeRuntime();
  createObject(
    runtime,
    { entity: player("player-1", ["lantern-lit"]), locationId: "room-b" },
    silent,
  );
  return runtime.state;
}

/** A v1 payload in the exact shape the wire carries. */
const realPayload = {
  entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [] as string[] } },
};

/**
 * The world scalars travel BESIDE the tree (O9, spec/04 §1.5), so every save
 * and load takes them explicitly. These two helpers keep that out of the way
 * of the assertions that are about the tree.
 */
const NO_META: WorldMeta = { nowTick: 0, rngState: 0, due: [] };
const save = (world: WorldState): Snapshot<SaveDataV2> => serializeWorld(world, NO_META);
const load = (snapshot: Snapshot): WorldState => restoreWorld(snapshot).state;

describe("the snapshot v2 shape (spec/04 §1)", () => {
  it("pins the payload: version + one record per tree state + the world scalars", () => {
    expect(serializeWorld(onePlayerWorld(), { nowTick: 900, rngState: 7, due: [] })).toEqual({
      version: SAVE_VERSION,
      data: {
        entities: {
          "player-1": {
            id: "player-1",
            locationId: "room-b",
            flags: ["lantern-lit"],
            tags: {},
            lastSeenTick: 0,
            cooldowns: {},
          },
        },
        nowTick: 900,
        rngState: 7,
        due: [],
      },
    });
  });

  it("stamps SAVE_VERSION, the migration chain's entry point", () => {
    expect(save({ entities: {} }).version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(2);
  });

  it("is typed data: the record carries exactly the tree's own fields", () => {
    const snapshot = save(onePlayerWorld());
    expect(Object.keys(snapshot.data.entities["player-1"]!)).toEqual([
      "id",
      "locationId",
      "flags",
      "tags",
      "lastSeenTick",
      "cooldowns",
    ]);
  });

  it("is byte-stable: two worlds built in different orders save identically", () => {
    // Flags are seeded by the creation layer, so these go through
    // createObject — addEntity writes seed state and runs no hook.
    const forward = makeRuntime();
    createObject(forward, { entity: player("player-2"), locationId: "room-a" }, silent);
    createObject(
      forward,
      { entity: player("player-1", ["b-flag", "a-flag"]), locationId: "room-b" },
      silent,
    );
    const backward = makeRuntime();
    createObject(
      backward,
      { entity: player("player-1", ["a-flag", "b-flag"]), locationId: "room-b" },
      silent,
    );
    createObject(backward, { entity: player("player-2"), locationId: "room-a" }, silent);

    expect(JSON.stringify(save(forward.state))).toBe(JSON.stringify(save(backward.state)));
    expect(Object.keys(save(forward.state).data.entities)).toEqual(["player-1", "player-2"]);
    expect(save(forward.state).data.entities["player-1"]!.flags).toEqual(["a-flag", "b-flag"]);
  });
});

describe("the round trip (serialize → migrate → load)", () => {
  it("keeps the position through a JSON boundary", () => {
    const runtime = makeRuntime();
    createObject(
      runtime,
      { entity: player("player-1", ["lantern-lit"]), locationId: "room-a" },
      silent,
    );
    moveTo(
      runtime,
      { entityId: "player-1", toLocationId: "room-b", moveType: "traverse" },
      silent,
    );

    // The wire: a save crosses a process boundary as JSON, nothing else.
    const wire = JSON.parse(JSON.stringify(save(runtime.state))) as Snapshot;
    const running = makeRuntime(load(wire));
    running.attachEntity(player("player-1"));

    expect(running.locationOf("player-1")).toBe("room-b");
    expect(running.occupantsOf("room-b")).toEqual(["player-1"]);
    expect(running.occupantsOf("room-a")).toEqual([]);
    expect(running.subjectOf("player-1").hasFlag("lantern-lit")).toBe(true);
    expect(running.subjectOf("player-1").locationId()).toBe("room-b");
  });

  it("keeps every entity and every flag", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-2", ["b-flag", "a-flag"]), locationId: "room-b" }, silent);
    createObject(runtime, { entity: player("player-1", ["lantern-lit"]), locationId: "room-a" }, silent);

    const restored = load(JSON.parse(JSON.stringify(save(runtime.state))) as Snapshot);
    expect(Object.keys(restored.entities)).toEqual(["player-1", "player-2"]);
    expect(restored.entities["player-2"]).toEqual({
      id: "player-2",
      locationId: "room-b",
      flags: ["a-flag", "b-flag"],
      tags: {},
      lastSeenTick: 0,
      cooldowns: {},
    });
  });

  it("is idempotent: loading a save and saving again yields the same bytes", () => {
    const first = save(onePlayerWorld());
    const second = save(load(first));
    expect(second).toEqual(first);
  });

  it("serializes state, not instances: an unattached tree still saves", () => {
    // Behaviour (the hook carrier) is code and lives in the host; the save
    // is the tree. A tree whose instance was never attached is still a tree.
    const restored = load(save(onePlayerWorld()));
    expect(restored.entities["player-1"]!.locationId).toBe("room-b");
  });
});

describe("tags in the save (M3-T5, #17; ADR-0029 §1)", () => {
  /** A player carrying a two-dimension tag set, written in a messy order. */
  function taggedPlayerWorld(): WorldState {
    const runtime = makeRuntime();
    runtime.addEntity(player("player-1"), "room-a");
    runtime.state.entities["player-1"]!.tags = {
      elementTag: ["water", "fire", "water"],
      zone: ["outdoors"],
    };
    return runtime.state;
  }

  it("round-trips a tag set through the JSON boundary", () => {
    const wire = JSON.parse(JSON.stringify(save(taggedPlayerWorld()))) as Snapshot;
    const restored = load(wire);

    expect(restored.entities["player-1"]!.tags).toEqual({
      elementTag: ["fire", "water"],
      zone: ["outdoors"],
    });
    // And it answers the condition facet it was saved for.
    const running = makeRuntime(restored);
    running.attachEntity(player("player-1"));
    expect(running.subjectOf("player-1").hasTag("zone", "outdoors")).toBe(true);
    expect(running.subjectOf("player-1").hasTag("elementTag", "water")).toBe(true);
    expect(running.subjectOf("player-1").hasTag("elementTag", "wood")).toBe(false);
  });

  it("canonicalizes: dimensions ascending, keys sorted and de-duplicated", () => {
    // The writer pushed keys in whatever order it liked — canonical order is
    // the SERIALIZER's promise (the `flags` precedent), never the writer's
    // burden.
    const record = save(taggedPlayerWorld()).data.entities["player-1"]!;
    expect(Object.keys(record.tags!)).toEqual(["elementTag", "zone"]);
    expect(record.tags!.elementTag).toEqual(["fire", "water"]);
  });

  it("is byte-stable: the same tags written in another order save identically", () => {
    const forward = makeRuntime();
    forward.addEntity(player("player-1"), "room-a");
    forward.state.entities["player-1"]!.tags = { zone: ["a", "b"], elementTag: ["fire"] };
    const backward = makeRuntime();
    backward.addEntity(player("player-1"), "room-a");
    backward.state.entities["player-1"]!.tags = { elementTag: ["fire"], zone: ["b", "a"] };

    expect(JSON.stringify(save(forward.state))).toBe(JSON.stringify(save(backward.state)));
  });

  it("reads an OLD save that predates the slot: no tags field, no error, empty tags", () => {
    // The save is the shape v1 has always written — a field that was never
    // written is not persisted (ADR-0022), so "absent" means "empty".
    const oldSave = {
      version: SAVE_VERSION,
      data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [] } } },
    } as Snapshot;

    const restored = load(JSON.parse(JSON.stringify(oldSave)) as Snapshot);
    expect(restored.entities["player-1"]!.tags).toEqual({});

    const running = makeRuntime(restored);
    running.attachEntity(player("player-1"));
    expect(running.subjectOf("player-1").hasTag("zone", "outdoors")).toBe(false);
  });

  it("is idempotent with tags: saving a restored save yields the same bytes", () => {
    const first = save(taggedPlayerWorld());
    expect(save(load(first))).toEqual(first);
  });

  it("rejects a malformed tags field (present but not a map of string lists)", () => {
    const withTags = (tags: unknown) =>
      ({
        version: SAVE_VERSION,
        data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [], tags } } },
      }) as Snapshot;

    expect(() => load(withTags(["zone"]))).toThrow(/entity "player-1"\.tags is not an object/);
    expect(() => load(withTags({ zone: [1] }))).toThrow(
      /entity "player-1"\.tags\["zone"\] is not a list of strings/,
    );
    expect(() => load(withTags({ zone: "outdoors" }))).toThrow(
      /entity "player-1"\.tags\["zone"\] is not a list of strings/,
    );
  });

  it("keeps flags REQUIRED while tags stay optional — two rules, one reason each", () => {
    // Every v1 save ever written carries flags, so a save without it is
    // corrupt and still fails; no save written before M3-T5 carries tags, so
    // a save without it is merely old (spec/04 §1.4).
    expect(() =>
      load({
        version: SAVE_VERSION,
        data: { entities: { "player-1": { id: "player-1", locationId: "room-a", tags: {} } } },
      } as Snapshot),
    ).toThrow(/flags is not a list of strings/);
  });
});

describe("the name slot (#52 — a display field, persisted verbatim)", () => {
  /** A world with one NAMED player: the host sets the display name at construction (#48 D4). */
  function namedPlayerWorld(): WorldState {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-a" }, silent);
    runtime.state.entities["player-1"]!.name = "张三丰";
    return runtime.state;
  }

  it("round-trips a set name through the JSON boundary, verbatim", () => {
    const wire = JSON.parse(JSON.stringify(save(namedPlayerWorld()))) as Snapshot;
    const restored = load(wire);

    expect(save(namedPlayerWorld()).data.entities["player-1"]!.name).toBe("张三丰");
    expect(restored.entities["player-1"]!.name).toBe("张三丰");
  });

  it("saves a nameless entity nameless — the record carries exactly the tree's own fields", () => {
    // "A field that was never written is not persisted" (ADR-0022): most
    // entities are never named, and their bytes are unchanged by the slot.
    const record = save(onePlayerWorld()).data.entities["player-1"]!;
    expect(Object.keys(record)).toEqual([
      "id",
      "locationId",
      "flags",
      "tags",
      "lastSeenTick",
      "cooldowns",
    ]);
    expect("name" in load(save(onePlayerWorld())).entities["player-1"]!).toBe(false);
  });

  it("reads an OLD save that predates the slot nameless — the default name is the HOST's word", () => {
    // 「少侠」 never appears here: the engine restores nameless and stays
    // silent (Q5 — the default application point is the host, and a theme
    // word would cross the engine-purity red line to say it).
    const oldSave = {
      version: SAVE_VERSION,
      data: realPayload,
    } as Snapshot;

    const restored = load(JSON.parse(JSON.stringify(oldSave)) as Snapshot);
    expect("name" in restored.entities["player-1"]!).toBe(false);
  });

  it("is idempotent: saving a restored save yields the same bytes", () => {
    const first = save(namedPlayerWorld());
    expect(save(load(first))).toEqual(first);
  });

  it("never persists an empty name — the writer makes no nameless claim", () => {
    // A live tree hand-set to "" (no host writes it — they default first)
    // saves NAMELESS: the empty string is not a claim a save may carry, and
    // the read side refuses it outright (the thirteenth class below).
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-a" }, silent);
    runtime.state.entities["player-1"]!.name = "";
    const record = save(runtime.state).data.entities["player-1"]!;
    expect("name" in record).toBe(false);
  });

  it("never persists a NON-STRING name either — garbage in the tree is nameless out", () => {
    // A hand-set name that is not a string (a JS host, an `as any`) is no
    // more a claim than the empty string: persisting one would be the
    // engine writing a key its own load path rejects (owner ruling
    // 2026-10-25, #52 audit N-1) — write-side elision, read-side refusal.
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-a" }, silent);
    runtime.state.entities["player-1"]!.name = 42 as unknown as string;
    expect("name" in save(runtime.state).data.entities["player-1"]!).toBe(false);

    runtime.state.entities["player-1"]!.name = null as unknown as string;
    expect("name" in save(runtime.state).data.entities["player-1"]!).toBe(false);
  });

  it("rejects a malformed name (present but not a non-empty string) — the thirteenth class", () => {
    const withName = (name: unknown) =>
      ({
        version: SAVE_VERSION,
        data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [], name } } },
      }) as Snapshot;

    expect(() => load(withName(42))).toThrow(
      /entity "player-1"\.name is not a non-empty string/,
    );
    // The empty string is a written claim that does not hold, not namelessness.
    expect(() => load(withName(""))).toThrow(
      /entity "player-1"\.name is not a non-empty string/,
    );
  });
});

describe("derived fields (spec/04 §1.3)", () => {
  it("registers none today — every field of EntityState is a fact", () => {
    expect(DERIVED_ENTITY_KEYS).toEqual([]);
  });

  it("stripDerived excludes exactly the registered keys, leaving the source alone", () => {
    const state: EntityState = {
      id: "player-1",
      locationId: "room-a",
      flags: ["lantern-lit"],
      tags: {},
      lastSeenTick: 40,
      cooldowns: {},
    };
    expect(stripDerived(state, ["flags", "locationId"])).toEqual({
      id: "player-1",
      tags: {},
      lastSeenTick: 40,
      cooldowns: {},
    });
    expect(state).toEqual({
      id: "player-1",
      locationId: "room-a",
      flags: ["lantern-lit"],
      tags: {},
      lastSeenTick: 40,
      cooldowns: {},
    });
  });

  it("persists exactly the live fields minus the table — the strip is the LAST step", () => {
    // The table cannot be extended at runtime (it decides the snapshot's
    // compile-time shape), so this pins the mechanism from both ends: what
    // serializeWorld drops is what the table names, and nothing re-adds it.
    const state: EntityState = {
      id: "player-1",
      locationId: "room-a",
      flags: ["lantern-lit"],
      tags: { zone: ["outdoors"] },
      lastSeenTick: 40,
      cooldowns: {},
    };
    const record = save({ entities: { "player-1": state } }).data.entities["player-1"]!;
    const expected = Object.keys(state).filter(
      (key) => !(DERIVED_ENTITY_KEYS as readonly string[]).includes(key),
    );
    expect(Object.keys(record)).toEqual(expected);
  });

  it("recompute runs once per restored entity, in id order", () => {
    const runtime = makeRuntime();
    runtime.addEntity(player("player-2"), "room-b");
    runtime.addEntity(player("player-1"), "room-a");

    const seen: string[] = [];
    const restored = restoreWorld(save(runtime.state), {
      recomputeDerived: (state) => {
        seen.push(`${state.id}@${state.locationId}`);
      },
    });
    expect(seen).toEqual(["player-1@room-a", "player-2@room-b"]);
    expect(Object.keys(restored.state.entities)).toEqual(["player-1", "player-2"]);
  });

  it("restores exactly what was saved — no phantom field, no gap", () => {
    // Empty table today, so the recomputed state must equal the saved one
    // field for field. The day a derived field registers, this becomes the
    // place its recompute is pinned.
    expect(load(save(onePlayerWorld()))).toEqual(onePlayerWorld());
  });
});

describe("loud failures", () => {
  it("rejects a save from the future, even with a real v1 payload", () => {
    expect(() => load({ version: SAVE_VERSION + 1, data: realPayload })).toThrow(
      /unsupported save version/,
    );
  });

  it("rejects version 0", () => {
    expect(() => load({ version: 0, data: realPayload })).toThrow(/unsupported save version/);
  });

  it("rejects a non-numeric version", () => {
    const malformed = { version: "1", data: realPayload } as unknown as Snapshot;
    expect(() => load(malformed)).toThrow(/unsupported save version/);
  });

  it("rejects a payload that is not an object", () => {
    expect(() => load({ version: SAVE_VERSION, data: "nonsense" })).toThrow(
      /data is not an object/,
    );
  });

  it("rejects a payload with no entities", () => {
    expect(() => load({ version: SAVE_VERSION, data: {} })).toThrow(
      /data\.entities is not an object/,
    );
  });

  it("rejects an entity record that is not an object", () => {
    const payload = { entities: { "player-1": "gone" } };
    expect(() => load({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1" is not an object/,
    );
  });

  it("rejects an empty entity key", () => {
    const payload = { entities: { "": { locationId: "room-a", flags: [] } } };
    expect(() => load({ version: SAVE_VERSION, data: payload })).toThrow(
      /an entity key in data\.entities is not a non-empty string/,
    );
  });

  it("rejects an entity without a location", () => {
    const payload = { entities: { "player-1": { id: "player-1", flags: [] } } };
    expect(() => load({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1"\.locationId is not a non-empty string/,
    );
  });

  it("rejects flags that are not a list of strings", () => {
    const payload = {
      entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [1] } },
    };
    expect(() => load({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1"\.flags is not a list of strings/,
    );
  });

  it("rejects a record whose id disagrees with its map key", () => {
    const payload = {
      entities: { "player-1": { id: "player-9", locationId: "room-a", flags: [] } },
    };
    expect(() => load({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1" carries a mismatched id "player-9"/,
    );
  });

  it("rejects a malformed lastSeenTick — a record's clock slot is a tick (#40)", () => {
    // `lastSeenTick` used to get no validation of its own; a string one
    // flowed into the tree and the two-layer advance settled against it.
    // The reader tolerates absence only, never malformation (twelfth
    // corruption class, spec/04 §1.4).
    const payload = (lastSeenTick: unknown) => ({
      entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [], lastSeenTick } },
    });

    expect(() => load({ version: SAVE_VERSION, data: payload("late") })).toThrow(
      /entity "player-1"\.lastSeenTick is not a non-negative safe integer/,
    );
    expect(() => load({ version: SAVE_VERSION, data: payload(Number.NaN) })).toThrow(
      /entity "player-1"\.lastSeenTick is not/,
    );
    expect(() => load({ version: SAVE_VERSION, data: payload(-1) })).toThrow(
      /entity "player-1"\.lastSeenTick is not/,
    );
    expect(() => load({ version: SAVE_VERSION, data: payload(1.5) })).toThrow(
      /entity "player-1"\.lastSeenTick is not/,
    );
  });
});

describe("absence is not corruption (#40)", () => {
  it("fills every late slot from its declared default when a save omits it — zero change", () => {
    // The regression pin AC4 asks for: the defensive double-fill (the
    // migration's and restore's hard-coded defaults) collapsed into one
    // declaration per row in state/slot-rules.ts, and a save that omits the
    // slots still lands on exactly the defaults it always did.
    const bare = {
      version: 2,
      data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [] } } },
    } as Snapshot;

    const { state, meta } = restoreWorld(bare);

    // toStrictEqual: a fill that wrote an undefined-valued key is a miss too.
    expect(state.entities["player-1"]).toStrictEqual({
      id: "player-1",
      locationId: "room-a",
      flags: [],
      tags: {},
      lastSeenTick: 0,
      cooldowns: {},
    });
    expect(meta).toStrictEqual({ nowTick: 0, rngState: 0, due: [] });
  });

  it("tolerates absence and refuses malformation on the very same slot", () => {
    // The slogan in one slot: `lastSeenTick` missing reads as tick 0, and
    // the same slot carrying a string fails the load. Either half loosening
    // is the drift this rule exists to end.
    const withLastSeenTick = (lastSeenTick: unknown) =>
      ({
        version: 2,
        data: {
          entities: {
            "player-1": { id: "player-1", locationId: "room-a", flags: [], lastSeenTick },
          },
        },
      }) as Snapshot;

    expect(
      restoreWorld(withLastSeenTick(undefined)).state.entities["player-1"]!.lastSeenTick,
    ).toBe(0);
    expect(() => restoreWorld(withLastSeenTick("late"))).toThrow(/lastSeenTick/);
  });
});

describe("NPCs stay out of the save (ADR-0028 §1)", () => {
  it("never enter the snapshot, however many a room places", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-c" }, silent);

    const snapshot = save(runtime.state);
    expect(Object.keys(snapshot.data.entities)).toEqual(["player-1"]);
    expect(JSON.stringify(snapshot)).not.toContain("npc-keeper");
  });

  it("are still there after a load — read from content, not from the save", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-c" }, silent);
    const restored = load(JSON.parse(JSON.stringify(save(runtime.state))) as Snapshot);
    const running = makeRuntime(restored);
    running.attachEntity(player("player-1"));

    const appearance = returnAppearance(running, "room-c", "player-1");
    expect(appearance.staticPresence).toEqual([{ id: "npc-keeper", count: 2 }]);
    expect(appearance.occupants).toEqual([]);
    expect(Object.keys(restored.entities)).toEqual(["player-1"]);
  });
});

describe("restore is a replay, not a creation", () => {
  it("attachEntity runs no creation layer", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-b" }, silent);
    const restored = load(save(runtime.state));

    let creationRuns = 0;
    const running = makeRuntime(restored);
    running.attachEntity(
      createEntity("player-1", {
        at_object_creation: () => {
          creationRuns += 1;
        },
        at_object_post_creation: () => {
          creationRuns += 1;
        },
      }),
    );

    expect(creationRuns).toBe(0);
    expect(running.locationOf("player-1")).toBe("room-b");
  });

  it("attaches in any order: a carried entity may precede its carrier", () => {
    const tree: WorldState = {
      entities: {
        "holder-1": {
          id: "holder-1",
          locationId: "room-a",
          flags: [],
          tags: {},
          lastSeenTick: 0,
          cooldowns: {},
        },
        "held-1": {
          id: "held-1",
          locationId: "holder-1",
          flags: [],
          tags: {},
          lastSeenTick: 0,
          cooldowns: {},
        },
      },
    };
    const running = makeRuntime(load(save(tree)));
    running.attachEntity(createEntity("held-1"));
    running.attachEntity(createEntity("holder-1"));

    expect(running.locationOf("held-1")).toBe("holder-1");
    expect(running.occupantsOf("holder-1")).toEqual(["held-1"]);
  });

  it("refuses an instance whose state the tree does not hold", () => {
    expect(() => makeRuntime().attachEntity(player("player-9"))).toThrow(/no state in the tree/);
  });

  it("refuses a second attach", () => {
    const running = makeRuntime(load(save(onePlayerWorld())));
    running.attachEntity(player("player-1"));
    expect(() => running.attachEntity(player("player-1"))).toThrow(/attached twice/);
  });

  it("refuses a restored entity whose location the loaded content no longer has", () => {
    // Content drift: the save remembers room-c, this content set does not.
    // Half-interpreted state is worse than a loud stop (ADR-0003).
    const drifted = createWorldRuntime({
      registry: createContentRegistry({ rooms: [makeRooms()[0]!], npcs }),
      state: load({
        version: SAVE_VERSION,
        data: { entities: { "player-1": { id: "player-1", locationId: "room-c", flags: [] } } },
      }),
    });
    expect(() => drifted.attachEntity(player("player-1"))).toThrow(
      /sits in "room-c", which is neither a loaded room nor a state in the tree/,
    );
  });

  it("keeps playing after a load: the restored tree moves like any other", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-b" }, silent);
    const restored = load(JSON.parse(JSON.stringify(save(runtime.state))) as Snapshot);
    const running = makeRuntime(restored);
    running.attachEntity(player("player-1"));
    expect(
      moveTo(running, { entityId: "player-1", toLocationId: "room-a", moveType: "traverse" }, silent),
    ).toEqual({ ok: true });

    expect(running.locationOf("player-1")).toBe("room-a");
    expect(running.occupantsOf("room-a")).toEqual(["player-1"]);
    expect(running.state).toBe(restored);
  });
});
