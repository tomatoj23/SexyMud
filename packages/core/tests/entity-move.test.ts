import { describe, expect, it } from "vitest";
import type { EventDraft } from "../src/command/pipeline.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { RoomEntry } from "../src/world/entry.js";
import { MOVE_TYPES, createEntity } from "../src/world/entity.js";
import type { Entity, EntityHooks, MoveInfo } from "../src/world/entity.js";
import { moveTo } from "../src/world/move.js";
import type { MovePorts } from "../src/world/move.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";

/**
 * The M2-T1 movement core (issue #7, spec/03 §7): the Entity interface, the
 * eight movement-family hooks and moveTo — the hook orchestration with ZERO
 * permission checks. This slice is engine-only: synthetic rooms, synthetic
 * entities, no content/ files. The full town chain over real content lives
 * in traversal-chain.test.ts.
 */

/** Minimal inline rooms; room-locked carries a deny-all gate to prove moveTo ignores gates. */
function makeRooms(): RoomEntry[] {
  const room = (id: string, preconditions?: RoomEntry["preconditions"]): RoomEntry => ({
    id,
    name: `name-${id}`,
    description: `description-${id}`,
    enterText: `enter-${id}`,
    exits: [],
    ...(preconditions !== undefined ? { preconditions } : {}),
  });
  return [room("room-a"), room("room-b"), room("room-locked", { default: false })];
}

function makeRuntime(): WorldRuntime {
  return createWorldRuntime({ registry: createContentRegistry({ rooms: makeRooms() }) });
}

/** One collected emission: the recipient plus the un-stamped semantic draft. */
interface Emission {
  to: string;
  draft: EventDraft;
}

function makePorts(): { ports: MovePorts; emissions: Emission[] } {
  const emissions: Emission[] = [];
  return {
    emissions,
    ports: {
      emit: (to, draft) => {
        emissions.push({ to, draft });
      },
    },
  };
}

/** An entity that logs every movement-family hook it receives. */
function recorder(id: string, log: string[], hooks: Partial<EntityHooks> = {}): Entity {
  return createEntity(id, {
    at_pre_move: () => {
      log.push(`${id}:at_pre_move`);
    },
    announce_move_from: (ctx) => {
      log.push(`${id}:announce_move_from(${ctx.receivers.join("+")})`);
    },
    announce_move_to: (ctx) => {
      log.push(`${id}:announce_move_to(${ctx.receivers.join("+")})`);
    },
    at_post_move: () => {
      log.push(`${id}:at_post_move`);
    },
    at_pre_object_leave: () => {
      log.push(`${id}:at_pre_object_leave`);
    },
    at_pre_object_receive: () => {
      log.push(`${id}:at_pre_object_receive`);
    },
    at_object_leave: () => {
      log.push(`${id}:at_object_leave`);
    },
    at_object_receive: () => {
      log.push(`${id}:at_object_receive`);
    },
    ...hooks,
  });
}

describe("the movement family hook order (spec/03 §7.1)", () => {
  it("runs pre-vetoes, announce-from, leave, the relocation, announce-to, receive, post — in that order", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    // Both ends of the move are ENTITY containers, so all eight hooks fire.
    runtime.addEntity(recorder("box-from", log), "room-a");
    runtime.addEntity(recorder("box-to", log), "room-b");
    runtime.addEntity(recorder("mover-1", log), "box-from");
    const { ports, emissions } = makePorts();

    const result = moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "box-to", moveType: "get" },
      ports,
    );

    expect(result).toEqual({ ok: true });
    expect(log).toEqual([
      "mover-1:at_pre_move",
      "box-from:at_pre_object_leave",
      "box-to:at_pre_object_receive",
      // occupants of the from container at announce time = the mover itself
      "mover-1:announce_move_from(mover-1)",
      "box-from:at_object_leave",
      // occupants of the to container AFTER the relocation = the mover itself
      "mover-1:announce_move_to(mover-1)",
      "box-to:at_object_receive",
      "mover-1:at_post_move",
    ]);
    // The recorder replaced the default announces, so nothing was emitted.
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("mover-1")).toBe("box-to");
  });

  it("aborts at at_pre_move's explicit false: no events, no state change", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("mover-1", { at_pre_move: () => false }), "room-a");
    const { ports, emissions } = makePorts();

    const result = moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "room-b", moveType: "traverse" },
      ports,
    );

    expect(result).toEqual({ ok: false, stage: "at_pre_move" });
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("mover-1")).toBe("room-a");
  });

  it("aborts at the leaving container's at_pre_object_leave", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("box-from", { at_pre_object_leave: () => false }), "room-a");
    runtime.addEntity(createEntity("mover-1"), "box-from");
    const { ports, emissions } = makePorts();

    const result = moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "room-b", moveType: "drop" },
      ports,
    );

    expect(result).toEqual({ ok: false, stage: "at_pre_object_leave" });
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("mover-1")).toBe("box-from");
  });

  it("aborts at the receiving container's at_pre_object_receive", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("box-to", { at_pre_object_receive: () => false }), "room-b");
    runtime.addEntity(createEntity("mover-1"), "room-a");
    const { ports, emissions } = makePorts();

    const result = moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "box-to", moveType: "give" },
      ports,
    );

    expect(result).toEqual({ ok: false, stage: "at_pre_object_receive" });
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("mover-1")).toBe("room-a");
  });

  it("treats void-returning pre hooks as proceed (only an explicit false vetoes)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(
      createEntity("mover-1", {
        at_pre_move: () => {
          // side effects only, no return value
        },
      }),
      "room-a",
    );
    const { ports } = makePorts();

    const result = moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "room-b", moveType: "teleport" },
      ports,
    );

    expect(result).toEqual({ ok: true });
    expect(runtime.locationOf("mover-1")).toBe("room-b");
  });
});

describe("moveTo carries zero permission checks (spec/03 §7.2)", () => {
  it("moves into a deny-all-gated room: gates are the caller's orchestration, never moveTo's", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("mover-1"), "room-a");
    const { ports } = makePorts();

    const result = moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "room-locked", moveType: "teleport" },
      ports,
    );

    expect(result).toEqual({ ok: true });
    expect(runtime.locationOf("mover-1")).toBe("room-locked");
  });
});

describe("default announces emit one event per receiver (non-goals B5)", () => {
  it("same-room occupants hear the departure, the new room hears the arrival — one event each, mover included", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("mover-1"), "room-a");
    runtime.addEntity(createEntity("bystander-1"), "room-a");
    runtime.addEntity(createEntity("far-1"), "room-b");
    const { ports, emissions } = makePorts();

    const result = moveTo(
      runtime,
      {
        entityId: "mover-1",
        toLocationId: "room-b",
        moveType: "traverse",
        viaExitId: "exit-x",
      },
      ports,
    );

    expect(result).toEqual({ ok: true });
    const departed = {
      type: "departed",
      entityId: "mover-1",
      fromLocationId: "room-a",
      toLocationId: "room-b",
      moveType: "traverse",
      viaExitId: "exit-x",
    };
    const arrived = {
      type: "arrived",
      entityId: "mover-1",
      fromLocationId: "room-a",
      toLocationId: "room-b",
      moveType: "traverse",
      viaExitId: "exit-x",
    };
    // Old room first (mover still there, ascending ids — bystandard sorts
    // before mover), then the new room (mover already relocated, ascending
    // ids — far-1 was there all along).
    expect(emissions).toEqual([
      { to: "bystander-1", draft: departed },
      { to: "mover-1", draft: departed },
      { to: "far-1", draft: arrived },
      { to: "mover-1", draft: arrived },
    ]);
  });

  it("leaves viaExitId absent when the move names no exit", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("mover-1"), "room-a");
    const { ports, emissions } = makePorts();

    moveTo(runtime, { entityId: "mover-1", toLocationId: "room-b", moveType: "teleport" }, ports);

    expect(emissions).toEqual([
      {
        to: "mover-1",
        draft: {
          type: "departed",
          entityId: "mover-1",
          fromLocationId: "room-a",
          toLocationId: "room-b",
          moveType: "teleport",
          viaExitId: undefined,
        },
      },
      {
        to: "mover-1",
        draft: {
          type: "arrived",
          entityId: "mover-1",
          fromLocationId: "room-a",
          toLocationId: "room-b",
          moveType: "teleport",
          viaExitId: undefined,
        },
      },
    ]);
  });
});

describe("MoveInfo reaches every hook (spec/03 §7.1: moveType on day one)", () => {
  it("hands each hook the full move: entity, from, to, moveType, viaExitId", () => {
    const runtime = makeRuntime();
    const seen: MoveInfo[] = [];
    runtime.addEntity(
      createEntity("mover-1", {
        at_pre_move: (ctx) => {
          seen.push(ctx.move);
        },
        announce_move_from: (ctx) => {
          seen.push(ctx.move);
        },
        at_post_move: (ctx) => {
          seen.push(ctx.move);
        },
      }),
      "room-a",
    );
    const { ports } = makePorts();

    moveTo(
      runtime,
      { entityId: "mover-1", toLocationId: "room-b", moveType: "traverse", viaExitId: "exit-x" },
      ports,
    );

    const expected = {
      entityId: "mover-1",
      fromLocationId: "room-a",
      toLocationId: "room-b",
      moveType: "traverse",
      viaExitId: "exit-x",
    };
    expect(seen).toEqual([expected, expected, expected]);
  });

  it("pins the five moveType semantics", () => {
    expect(MOVE_TYPES).toEqual(["teleport", "traverse", "get", "give", "drop"]);
  });
});

describe("the state tree seed (spec/04 §1: one tree)", () => {
  it("writes the move into the tree: position queryable, occupancy follows both ways", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("p1"), "room-a");
    runtime.addEntity(createEntity("p2"), "room-a");
    expect(runtime.occupantsOf("room-a")).toEqual(["p1", "p2"]);

    moveTo(runtime, { entityId: "p1", toLocationId: "room-b", moveType: "teleport" }, makePorts().ports);

    expect(runtime.locationOf("p1")).toBe("room-b");
    expect(runtime.occupantsOf("room-a")).toEqual(["p2"]);
    expect(runtime.occupantsOf("room-b")).toEqual(["p1"]);
  });

  it("lists occupants ascending regardless of insertion order (ADR-0024 §2)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("zeta"), "room-a");
    runtime.addEntity(createEntity("alpha"), "room-a");
    expect(runtime.occupantsOf("room-a")).toEqual(["alpha", "zeta"]);
  });

  it("builds condition subjects from the tree: flags, tags and location answer, unlanded facets answer none", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("p1"), "room-a");
    runtime.state.entities["p1"]!.flags = ["marker-a"];
    runtime.state.entities["p1"]!.tags = { zone: ["outdoors"] };

    const subject = runtime.subjectOf("p1");
    expect(subject.hasFlag("marker-a")).toBe(true);
    expect(subject.hasFlag("marker-b")).toBe(false);
    expect(subject.locationId()).toBe("room-a");
    // Tags answer from the tree — the pair, not a bare string (ADR-0029 §1).
    expect(subject.hasTag("zone", "outdoors")).toBe(true);
    expect(subject.hasTag("zone", "indoors")).toBe(false);
    expect(subject.hasTag("layer", "outdoors")).toBe(false);
    // Slots that have no consumer yet answer "none" — they arrive with
    // their systems (attrs/states/skills with combat and rest).
    expect(subject.attr("anything")).toBeUndefined();
    expect(subject.hasState("wounded")).toBe(false);
    expect(subject.hasSkill("anything")).toBe(false);
  });
});

describe("loud wiring failures (ADR-0003's spirit: fail at the boundary, not mid-play)", () => {
  it("throws on an unregistered mover, an unresolvable target, duplicate adds, unknown locations and room-id collisions", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();

    expect(() =>
      moveTo(runtime, { entityId: "ghost", toLocationId: "room-b", moveType: "teleport" }, ports),
    ).toThrow(/unknown entity/);

    runtime.addEntity(createEntity("p1"), "room-a");
    expect(() =>
      moveTo(runtime, { entityId: "p1", toLocationId: "nowhere", moveType: "teleport" }, ports),
    ).toThrow(/neither a loaded room nor a registered entity/);

    expect(() => runtime.addEntity(createEntity("p1"), "room-a")).toThrow(/added twice/);
    expect(() => runtime.addEntity(createEntity("p2"), "limbo")).toThrow(
      /neither a loaded room nor a registered entity/,
    );
    // An entity named like a room would make every location ambiguous.
    expect(() => runtime.addEntity(createEntity("room-a"), "room-b")).toThrow(/collides/);
  });
});
