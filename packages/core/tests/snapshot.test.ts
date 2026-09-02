import { describe, expect, it } from "vitest";
import { SAVE_VERSION } from "../src/save/migrations.js";
import { DERIVED_ENTITY_KEYS, stripDerived } from "../src/state/derived.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
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

describe("the snapshot v1 shape (spec/04 §1)", () => {
  it("pins the payload: version + one record per tree state", () => {
    expect(serializeWorld(onePlayerWorld())).toEqual({
      version: SAVE_VERSION,
      data: {
        entities: {
          "player-1": {
            id: "player-1",
            locationId: "room-b",
            flags: ["lantern-lit"],
            tags: {},
          },
        },
      },
    });
  });

  it("stamps SAVE_VERSION, the migration chain's entry point", () => {
    expect(serializeWorld({ entities: {} }).version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(1);
  });

  it("is typed data: the record carries exactly the tree's own fields", () => {
    const snapshot = serializeWorld(onePlayerWorld());
    expect(Object.keys(snapshot.data.entities["player-1"]!)).toEqual([
      "id",
      "locationId",
      "flags",
      "tags",
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

    expect(JSON.stringify(serializeWorld(forward.state))).toBe(
      JSON.stringify(serializeWorld(backward.state)),
    );
    expect(Object.keys(serializeWorld(forward.state).data.entities)).toEqual([
      "player-1",
      "player-2",
    ]);
    expect(serializeWorld(forward.state).data.entities["player-1"]!.flags).toEqual([
      "a-flag",
      "b-flag",
    ]);
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
    const wire = JSON.parse(JSON.stringify(serializeWorld(runtime.state))) as Snapshot;
    const running = makeRuntime(restoreWorld(wire));
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

    const restored = restoreWorld(JSON.parse(JSON.stringify(serializeWorld(runtime.state))) as Snapshot);
    expect(Object.keys(restored.entities)).toEqual(["player-1", "player-2"]);
    expect(restored.entities["player-2"]).toEqual({
      id: "player-2",
      locationId: "room-b",
      flags: ["a-flag", "b-flag"],
      tags: {},
    });
  });

  it("is idempotent: loading a save and saving again yields the same bytes", () => {
    const first = serializeWorld(onePlayerWorld());
    const second = serializeWorld(restoreWorld(first));
    expect(second).toEqual(first);
  });

  it("serializes state, not instances: an unattached tree still saves", () => {
    // Behaviour (the hook carrier) is code and lives in the host; the save
    // is the tree. A tree whose instance was never attached is still a tree.
    const restored = restoreWorld(serializeWorld(onePlayerWorld()));
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
    const wire = JSON.parse(JSON.stringify(serializeWorld(taggedPlayerWorld()))) as Snapshot;
    const restored = restoreWorld(wire);

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
    const record = serializeWorld(taggedPlayerWorld()).data.entities["player-1"]!;
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

    expect(JSON.stringify(serializeWorld(forward.state))).toBe(
      JSON.stringify(serializeWorld(backward.state)),
    );
  });

  it("reads an OLD save that predates the slot: no tags field, no error, empty tags", () => {
    // The save is the shape v1 has always written — a field that was never
    // written is not persisted (ADR-0022), so "absent" means "empty".
    const oldSave = {
      version: SAVE_VERSION,
      data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [] } } },
    } as Snapshot;

    const restored = restoreWorld(JSON.parse(JSON.stringify(oldSave)) as Snapshot);
    expect(restored.entities["player-1"]!.tags).toEqual({});

    const running = makeRuntime(restored);
    running.attachEntity(player("player-1"));
    expect(running.subjectOf("player-1").hasTag("zone", "outdoors")).toBe(false);
  });

  it("is idempotent with tags: saving a restored save yields the same bytes", () => {
    const first = serializeWorld(taggedPlayerWorld());
    expect(serializeWorld(restoreWorld(first))).toEqual(first);
  });

  it("rejects a malformed tags field (present but not a map of string lists)", () => {
    const withTags = (tags: unknown) =>
      ({
        version: SAVE_VERSION,
        data: { entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [], tags } } },
      }) as Snapshot;

    expect(() => restoreWorld(withTags(["zone"]))).toThrow(/entity "player-1"\.tags is not an object/);
    expect(() => restoreWorld(withTags({ zone: [1] }))).toThrow(
      /entity "player-1"\.tags\["zone"\] is not a list of strings/,
    );
    expect(() => restoreWorld(withTags({ zone: "outdoors" }))).toThrow(
      /entity "player-1"\.tags\["zone"\] is not a list of strings/,
    );
  });

  it("keeps flags REQUIRED while tags stay optional — two rules, one reason each", () => {
    // Every v1 save ever written carries flags, so a save without it is
    // corrupt and still fails; no save written before M3-T5 carries tags, so
    // a save without it is merely old (spec/04 §1.4).
    expect(() =>
      restoreWorld({
        version: SAVE_VERSION,
        data: { entities: { "player-1": { id: "player-1", locationId: "room-a", tags: {} } } },
      } as Snapshot),
    ).toThrow(/flags is not a list of strings/);
  });
});

describe("derived fields (spec/04 §1.3)", () => {
  it("registers none today — every field of EntityState is a fact", () => {
    expect(DERIVED_ENTITY_KEYS).toEqual([]);
  });

  it("stripDerived excludes exactly the registered keys, leaving the source alone", () => {
    const state: EntityState = { id: "player-1", locationId: "room-a", flags: ["lantern-lit"], tags: {} };
    expect(stripDerived(state, ["flags", "locationId"])).toEqual({ id: "player-1", tags: {} });
    expect(state).toEqual({
      id: "player-1",
      locationId: "room-a",
      flags: ["lantern-lit"],
      tags: {},
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
    };
    const record = serializeWorld({ entities: { "player-1": state } }).data.entities["player-1"]!;
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
    const restored = restoreWorld(serializeWorld(runtime.state), {
      recomputeDerived: (state) => {
        seen.push(`${state.id}@${state.locationId}`);
      },
    });
    expect(seen).toEqual(["player-1@room-a", "player-2@room-b"]);
    expect(Object.keys(restored.entities)).toEqual(["player-1", "player-2"]);
  });

  it("restores exactly what was saved — no phantom field, no gap", () => {
    // Empty table today, so the recomputed state must equal the saved one
    // field for field. The day a derived field registers, this becomes the
    // place its recompute is pinned.
    expect(restoreWorld(serializeWorld(onePlayerWorld()))).toEqual(onePlayerWorld());
  });
});

describe("loud failures", () => {
  it("rejects a save from the future, even with a real v1 payload", () => {
    expect(() => restoreWorld({ version: SAVE_VERSION + 1, data: realPayload })).toThrow(
      /unsupported save version/,
    );
  });

  it("rejects version 0", () => {
    expect(() => restoreWorld({ version: 0, data: realPayload })).toThrow(/unsupported save version/);
  });

  it("rejects a non-numeric version", () => {
    const malformed = { version: "1", data: realPayload } as unknown as Snapshot;
    expect(() => restoreWorld(malformed)).toThrow(/unsupported save version/);
  });

  it("rejects a payload that is not an object", () => {
    expect(() => restoreWorld({ version: SAVE_VERSION, data: "nonsense" })).toThrow(
      /data is not an object/,
    );
  });

  it("rejects a payload with no entities", () => {
    expect(() => restoreWorld({ version: SAVE_VERSION, data: {} })).toThrow(
      /data\.entities is not an object/,
    );
  });

  it("rejects an entity record that is not an object", () => {
    const payload = { entities: { "player-1": "gone" } };
    expect(() => restoreWorld({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1" is not an object/,
    );
  });

  it("rejects an empty entity key", () => {
    const payload = { entities: { "": { locationId: "room-a", flags: [] } } };
    expect(() => restoreWorld({ version: SAVE_VERSION, data: payload })).toThrow(
      /an entity key in data\.entities is not a non-empty string/,
    );
  });

  it("rejects an entity without a location", () => {
    const payload = { entities: { "player-1": { id: "player-1", flags: [] } } };
    expect(() => restoreWorld({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1"\.locationId is not a non-empty string/,
    );
  });

  it("rejects flags that are not a list of strings", () => {
    const payload = {
      entities: { "player-1": { id: "player-1", locationId: "room-a", flags: [1] } },
    };
    expect(() => restoreWorld({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1"\.flags is not a list of strings/,
    );
  });

  it("rejects a record whose id disagrees with its map key", () => {
    const payload = {
      entities: { "player-1": { id: "player-9", locationId: "room-a", flags: [] } },
    };
    expect(() => restoreWorld({ version: SAVE_VERSION, data: payload })).toThrow(
      /entity "player-1" carries a mismatched id "player-9"/,
    );
  });
});

describe("NPCs stay out of the save (ADR-0028 §1)", () => {
  it("never enter the snapshot, however many a room places", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-c" }, silent);

    const snapshot = serializeWorld(runtime.state);
    expect(Object.keys(snapshot.data.entities)).toEqual(["player-1"]);
    expect(JSON.stringify(snapshot)).not.toContain("npc-keeper");
  });

  it("are still there after a load — read from content, not from the save", () => {
    const runtime = makeRuntime();
    createObject(runtime, { entity: player("player-1"), locationId: "room-c" }, silent);
    const restored = restoreWorld(JSON.parse(JSON.stringify(serializeWorld(runtime.state))) as Snapshot);
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
    const restored = restoreWorld(serializeWorld(runtime.state));

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
        "holder-1": { id: "holder-1", locationId: "room-a", flags: [], tags: {} },
        "held-1": { id: "held-1", locationId: "holder-1", flags: [], tags: {} },
      },
    };
    const running = makeRuntime(restoreWorld(serializeWorld(tree)));
    running.attachEntity(createEntity("held-1"));
    running.attachEntity(createEntity("holder-1"));

    expect(running.locationOf("held-1")).toBe("holder-1");
    expect(running.occupantsOf("holder-1")).toEqual(["held-1"]);
  });

  it("refuses an instance whose state the tree does not hold", () => {
    expect(() => makeRuntime().attachEntity(player("player-9"))).toThrow(/no state in the tree/);
  });

  it("refuses a second attach", () => {
    const running = makeRuntime(restoreWorld(serializeWorld(onePlayerWorld())));
    running.attachEntity(player("player-1"));
    expect(() => running.attachEntity(player("player-1"))).toThrow(/attached twice/);
  });

  it("refuses a restored entity whose location the loaded content no longer has", () => {
    // Content drift: the save remembers room-c, this content set does not.
    // Half-interpreted state is worse than a loud stop (ADR-0003).
    const drifted = createWorldRuntime({
      registry: createContentRegistry({ rooms: [makeRooms()[0]!], npcs }),
      state: restoreWorld({
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
    const restored = restoreWorld(JSON.parse(JSON.stringify(serializeWorld(runtime.state))) as Snapshot);
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
