import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../src/command/pipeline.js";
import { mergeCmdSets } from "../src/command/cmdset.js";
import type { CmdSetSource } from "../src/command/cmdset.js";
import { createCommandHarness } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { RoomEntry } from "../src/world/entry.js";
import { createEntity } from "../src/world/entity.js";
import type { Entity, EntityHooks } from "../src/world/entity.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";
import { assembleSources } from "../src/world/cmdset.js";
import { createObject } from "../src/world/creation.js";
import { dropObject, getObject, giveObject } from "../src/world/transfer.js";
import type { EventDraft } from "../src/command/pipeline.js";

/**
 * The M2-T4 seam-completion tests (issue #10, spec/03 §7 items 7–9,
 * ADR-0025 §五, ADR-0028 §1): the three transfer pairs (at_pre_get/give/drop
 * vetoable + at_post_* notification), the creation two-layer seam
 * (at_object_creation seeds code defaults, at_object_post_creation lets JSON
 * content override them — wrong order and content never wins), and the
 * dynamic cmdset timing (at_cmdset_get: entity state changes reshape the
 * action set of the NEXT dispatch).
 *
 * Seams first, features later (the issue's own framing): there is no item
 * system yet, so everything here is SYNTHETIC — synthetic rooms, synthetic
 * entities, synthetic command sources, synthetic "JSON content" applied by a
 * host-side hook. The first real consumer (materialization: items, stateful
 * NPCs) rides these seams in a later ticket without reshaping them.
 *
 * The transfer pairs sit OUTSIDE moveTo (moveTo's own chain — at_pre_move,
 * container vetoes, announces, the write — is M2-T1's, fully tested in
 * entity-move.test.ts): the behaviour-level veto precedes the movement
 * chain, the post notification follows it, exactly like say's pre/broadcast/
 * post sandwich.
 */

function makeRooms(): RoomEntry[] {
  const room = (id: string): RoomEntry => ({
    id,
    name: `name-${id}`,
    description: `description-${id}`,
    enterText: `enter-${id}`,
    exits: [],
  });
  return [room("room-a"), room("room-b")];
}

function makeRuntime(): WorldRuntime {
  return createWorldRuntime({ registry: createContentRegistry({ rooms: makeRooms() }) });
}

/** One collected emission: the recipient plus the un-stamped semantic draft. */
interface Emission {
  to: string;
  draft: EventDraft;
}

/** The emit port every orchestration here consumes (all structurally identical). */
function makePorts(): { ports: { emit: (to: string, draft: EventDraft) => void }; emissions: Emission[] } {
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

/** An entity that logs every movement-family AND transfer-family hook it receives. */
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
    at_pre_get: (ctx) => {
      log.push(`${id}:at_pre_get(by=${ctx.getterId})`);
    },
    at_post_get: (ctx) => {
      log.push(`${id}:at_post_get(by=${ctx.getterId})`);
    },
    at_pre_give: (ctx) => {
      log.push(`${id}:at_pre_give(${ctx.giverId}>${ctx.receiverId})`);
    },
    at_post_give: (ctx) => {
      log.push(`${id}:at_post_give(${ctx.giverId}>${ctx.receiverId})`);
    },
    at_pre_drop: (ctx) => {
      log.push(`${id}:at_pre_drop(by=${ctx.dropperId})`);
    },
    at_post_drop: (ctx) => {
      log.push(`${id}:at_post_drop(by=${ctx.dropperId})`);
    },
    ...hooks,
  });
}

// ---------------------------------------------------------------------------
// The transfer seams: get / give / drop (spec/03 §7 item 7's transfer half)
// ---------------------------------------------------------------------------

describe("the get seam (spec/03 §7.7's get half)", () => {
  it("runs at_pre_get, the full movement chain, then at_post_get — in that order", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    // obj-1 lies inside box-1, which stands in room-a beside getter-1: all
    // three hooks sides (transferred entity, leaving container, receiving
    // container) are entity-backed, so every hook in the chain fires.
    runtime.addEntity(recorder("box-1", log), "room-a");
    runtime.addEntity(recorder("getter-1", log), "room-a");
    runtime.addEntity(recorder("obj-1", log), "box-1");
    const { ports, emissions } = makePorts();

    const result = getObject(runtime, { entityId: "obj-1", getterId: "getter-1" }, ports);

    expect(result).toEqual({ ok: true });
    expect(log).toEqual([
      "obj-1:at_pre_get(by=getter-1)",
      // the movement chain underneath (M2-T1), with moveType "get"
      "obj-1:at_pre_move",
      "box-1:at_pre_object_leave",
      "getter-1:at_pre_object_receive",
      "obj-1:announce_move_from(obj-1)",
      "box-1:at_object_leave",
      "obj-1:announce_move_to(obj-1)",
      "getter-1:at_object_receive",
      "obj-1:at_post_move",
      "obj-1:at_post_get(by=getter-1)",
    ]);
    // The recorder replaced the default announces, so nothing was emitted.
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("getter-1");
    expect(runtime.occupantsOf("getter-1")).toEqual(["obj-1"]);
    expect(runtime.occupantsOf("box-1")).toEqual([]);
  });

  it("aborts at at_pre_get's explicit false: before the movement chain, no events, no post hook", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(recorder("getter-1", log), "room-a");
    runtime.addEntity(
      recorder("obj-1", log, { at_pre_get: () => {
        log.push("obj-1:at_pre_get(by=getter-1)");
        return false;
      } }),
      "room-a",
    );
    const { ports, emissions } = makePorts();

    const result = getObject(runtime, { entityId: "obj-1", getterId: "getter-1" }, ports);

    expect(result).toEqual({ ok: false, stage: "at_pre_get" });
    // The veto precedes the movement chain: at_pre_move never ran, the post
    // pair never ran, nothing moved, nothing was emitted.
    expect(log).toEqual(["obj-1:at_pre_get(by=getter-1)"]);
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("room-a");
  });

  it("treats a void-returning at_pre_get as proceed (only an explicit false vetoes)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("getter-1"), "room-a");
    runtime.addEntity(
      createEntity("obj-1", {
        at_pre_get: () => {
          // side effects only, no return value
        },
      }),
      "room-a",
    );
    const { ports } = makePorts();

    const result = getObject(runtime, { entityId: "obj-1", getterId: "getter-1" }, ports);

    expect(result).toEqual({ ok: true });
    expect(runtime.locationOf("obj-1")).toBe("getter-1");
  });

  it("surfaces a container veto from inside the movement chain: at_post_get does not run", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(
      createEntity("getter-1", { at_pre_object_receive: () => false }),
      "room-a",
    );
    runtime.addEntity(recorder("obj-1", log), "room-a");
    const { ports, emissions } = makePorts();

    const result = getObject(runtime, { entityId: "obj-1", getterId: "getter-1" }, ports);

    // The getter's container veto (a full inventory, a weight limit) aborts
    // the move; the transfer reports the movement stage and skips its post.
    expect(result).toEqual({ ok: false, stage: "at_pre_object_receive" });
    expect(log).toEqual(["obj-1:at_pre_get(by=getter-1)", "obj-1:at_pre_move"]);
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("room-a");
  });

  it("announces through the engine defaults with moveType 'get' — narrative splits by cause", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("getter-1"), "room-a");
    runtime.addEntity(createEntity("obj-1"), "room-a");
    const { ports, emissions } = makePorts();

    const result = getObject(runtime, { entityId: "obj-1", getterId: "getter-1" }, ports);

    expect(result).toEqual({ ok: true });
    // The same departed/arrived events the movement family emits, now tagged
    // with the transfer's cause — a renderer words "picked up" differently
    // from "walked away" without any engine change (spec/03 §7.1's payoff).
    // departed reaches room-a's occupants at announce time (getter-1 +
    // obj-1, ascending); arrived reaches the getter's occupants after the
    // write (obj-1 alone).
    expect(emissions).toEqual([
      {
        to: "getter-1",
        draft: {
          type: "departed",
          entityId: "obj-1",
          fromLocationId: "room-a",
          toLocationId: "getter-1",
          moveType: "get",
        },
      },
      {
        to: "obj-1",
        draft: {
          type: "departed",
          entityId: "obj-1",
          fromLocationId: "room-a",
          toLocationId: "getter-1",
          moveType: "get",
        },
      },
      {
        to: "obj-1",
        draft: {
          type: "arrived",
          entityId: "obj-1",
          fromLocationId: "room-a",
          toLocationId: "getter-1",
          moveType: "get",
        },
      },
    ]);
  });

  it("throws loudly on an unknown entity id (wiring bug, not play)", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();
    expect(() => getObject(runtime, { entityId: "ghost", getterId: "anyone" }, ports)).toThrow(
      /unknown entity/,
    );
  });
});

describe("the give seam (spec/03 §7.7's give half)", () => {
  it("runs at_pre_give, the full movement chain between the two parties, then at_post_give", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    // obj-1 is held by giver-1; receiver-1 stands in the same room. Give is
    // the one transfer with a SECOND party: giver and receiver are the
    // leaving/receiving containers of the movement chain.
    runtime.addEntity(recorder("giver-1", log), "room-a");
    runtime.addEntity(recorder("receiver-1", log), "room-a");
    runtime.addEntity(recorder("obj-1", log), "giver-1");
    const { ports, emissions } = makePorts();

    const result = giveObject(runtime, { entityId: "obj-1", giverId: "giver-1", receiverId: "receiver-1" }, ports);

    expect(result).toEqual({ ok: true });
    expect(log).toEqual([
      "obj-1:at_pre_give(giver-1>receiver-1)",
      "obj-1:at_pre_move",
      "giver-1:at_pre_object_leave",
      "receiver-1:at_pre_object_receive",
      "obj-1:announce_move_from(obj-1)",
      "giver-1:at_object_leave",
      "obj-1:announce_move_to(obj-1)",
      "receiver-1:at_object_receive",
      "obj-1:at_post_move",
      "obj-1:at_post_give(giver-1>receiver-1)",
    ]);
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("receiver-1");
    expect(runtime.occupantsOf("giver-1")).toEqual([]);
  });

  it("aborts at at_pre_give's explicit false: the object stays with the giver", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(createEntity("giver-1"), "room-a");
    runtime.addEntity(createEntity("receiver-1"), "room-a");
    runtime.addEntity(
      recorder("obj-1", log, { at_pre_give: () => {
        log.push("obj-1:at_pre_give(giver-1>receiver-1)");
        return false;
      } }),
      "giver-1",
    );
    const { ports, emissions } = makePorts();

    const result = giveObject(runtime, { entityId: "obj-1", giverId: "giver-1", receiverId: "receiver-1" }, ports);

    expect(result).toEqual({ ok: false, stage: "at_pre_give" });
    expect(log).toEqual(["obj-1:at_pre_give(giver-1>receiver-1)"]);
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("giver-1");
  });

  it("aborts when the receiver's container hook refuses the handover", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("giver-1"), "room-a");
    runtime.addEntity(createEntity("receiver-1", { at_pre_object_receive: () => false }), "room-a");
    runtime.addEntity(createEntity("obj-1"), "giver-1");
    const { ports } = makePorts();

    const result = giveObject(runtime, { entityId: "obj-1", giverId: "giver-1", receiverId: "receiver-1" }, ports);

    expect(result).toEqual({ ok: false, stage: "at_pre_object_receive" });
    expect(runtime.locationOf("obj-1")).toBe("giver-1");
  });

  it("aborts when the GIVER's container hook refuses to part with it — all three give refusals named", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("giver-1", { at_pre_object_leave: () => false }), "room-a");
    runtime.addEntity(createEntity("receiver-1"), "room-a");
    runtime.addEntity(createEntity("obj-1"), "giver-1");
    const { ports, emissions } = makePorts();

    const result = giveObject(runtime, { entityId: "obj-1", giverId: "giver-1", receiverId: "receiver-1" }, ports);

    // The third leg of the three-way handover refusal (spec/03 §7.6): the
    // transferred entity, the receiver — and here the giver's side.
    expect(result).toEqual({ ok: false, stage: "at_pre_object_leave" });
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("giver-1");
  });

  it("treats a void-returning at_pre_give as proceed (only an explicit false vetoes)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("giver-1"), "room-a");
    runtime.addEntity(createEntity("receiver-1"), "room-a");
    runtime.addEntity(
      createEntity("obj-1", {
        at_pre_give: () => {
          // side effects only, no return value
        },
      }),
      "giver-1",
    );
    const { ports } = makePorts();

    const result = giveObject(runtime, { entityId: "obj-1", giverId: "giver-1", receiverId: "receiver-1" }, ports);

    expect(result).toEqual({ ok: true });
    expect(runtime.locationOf("obj-1")).toBe("receiver-1");
  });

  it("throws loudly when the receiver resolves to neither room nor entity", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("giver-1"), "room-a");
    runtime.addEntity(createEntity("obj-1"), "giver-1");
    const { ports } = makePorts();
    expect(() =>
      giveObject(runtime, { entityId: "obj-1", giverId: "giver-1", receiverId: "nobody" }, ports),
    ).toThrow(/neither a loaded room nor a registered entity/);
  });
});

describe("the drop seam (spec/03 §7.7's drop half)", () => {
  it("runs at_pre_drop, the movement chain out to the dropper's location, then at_post_drop", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    // dropper-1 holds obj-1 while standing in room-a: dropping moves the
    // object from the dropper (entity container) to the dropper's location.
    runtime.addEntity(recorder("dropper-1", log), "room-a");
    runtime.addEntity(recorder("obj-1", log), "dropper-1");
    const { ports, emissions } = makePorts();

    const result = dropObject(runtime, { entityId: "obj-1", dropperId: "dropper-1" }, ports);

    expect(result).toEqual({ ok: true });
    expect(log).toEqual([
      "obj-1:at_pre_drop(by=dropper-1)",
      "obj-1:at_pre_move",
      // room-a is content and carries no hooks: only the entity side fires
      "dropper-1:at_pre_object_leave",
      "obj-1:announce_move_from(obj-1)",
      "dropper-1:at_object_leave",
      // occupants of room-a AFTER the write, ascending: dropper-1 + obj-1
      "obj-1:announce_move_to(dropper-1+obj-1)",
      "obj-1:at_post_move",
      "obj-1:at_post_drop(by=dropper-1)",
    ]);
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("room-a");
    expect(runtime.occupantsOf("dropper-1")).toEqual([]);
  });

  it("aborts at at_pre_drop's explicit false: the object stays held", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(createEntity("dropper-1"), "room-a");
    runtime.addEntity(
      recorder("obj-1", log, { at_pre_drop: () => {
        log.push("obj-1:at_pre_drop(by=dropper-1)");
        return false;
      } }),
      "dropper-1",
    );
    const { ports, emissions } = makePorts();

    const result = dropObject(runtime, { entityId: "obj-1", dropperId: "dropper-1" }, ports);

    expect(result).toEqual({ ok: false, stage: "at_pre_drop" });
    expect(log).toEqual(["obj-1:at_pre_drop(by=dropper-1)"]);
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("dropper-1");
  });

  it("surfaces the holder's container veto from inside the movement chain", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("dropper-1", { at_pre_object_leave: () => false }), "room-a");
    runtime.addEntity(createEntity("obj-1"), "dropper-1");
    const { ports, emissions } = makePorts();

    const result = dropObject(runtime, { entityId: "obj-1", dropperId: "dropper-1" }, ports);

    // A cursed grip: the holder refuses to let go — the movement chain's
    // leaving-container veto surfaces as a failed drop, post hook skipped.
    expect(result).toEqual({ ok: false, stage: "at_pre_object_leave" });
    expect(emissions).toEqual([]);
    expect(runtime.locationOf("obj-1")).toBe("dropper-1");
  });

  it("treats a void-returning at_pre_drop as proceed (only an explicit false vetoes)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("dropper-1"), "room-a");
    runtime.addEntity(
      createEntity("obj-1", {
        at_pre_drop: () => {
          // side effects only, no return value
        },
      }),
      "dropper-1",
    );
    const { ports } = makePorts();

    const result = dropObject(runtime, { entityId: "obj-1", dropperId: "dropper-1" }, ports);

    expect(result).toEqual({ ok: true });
    expect(runtime.locationOf("obj-1")).toBe("room-a");
  });

  it("throws loudly on an unknown dropper (wiring bug, not play)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("obj-1"), "room-a");
    const { ports } = makePorts();
    expect(() => dropObject(runtime, { entityId: "obj-1", dropperId: "ghost" }, ports)).toThrow(
      /unknown entity/,
    );
  });
});

// ---------------------------------------------------------------------------
// The creation two-layer seam (spec/03 §7.8)
// ---------------------------------------------------------------------------

describe("the creation two-layer seam (spec/03 §7.8)", () => {
  it("runs at_object_creation first, at_object_post_creation second — and the JSON content wins", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    const seenByPost: string[][] = [];
    // The synthetic "JSON content": the data a future materialization ticket
    // reads from a content entry. Here the HOST applies it inside the post
    // layer — the engine's seam guarantees only the ORDER (defaults first,
    // content second), which is the whole point: reverse it and content can
    // never win over code defaults.
    const jsonContent = { flags: ["from-content"] } as const;
    const entity = createEntity("obj-1", {
      at_object_creation: (ctx) => {
        log.push("at_object_creation");
        ctx.state.flags = ["code-default"];
      },
      at_object_post_creation: (ctx) => {
        log.push("at_object_post_creation");
        seenByPost.push([...ctx.state.flags]);
        ctx.state.flags = [...jsonContent.flags];
      },
    });
    const { ports } = makePorts();

    createObject(runtime, { entity, locationId: "room-a" }, ports);

    expect(log).toEqual(["at_object_creation", "at_object_post_creation"]);
    // The post layer SAW the defaults (it runs after them, before replacing):
    // an override decision made with full knowledge of what it overrides.
    expect(seenByPost).toEqual([["code-default"]]);
    // And the tree's truth is the content's value — JSON wins.
    expect(runtime.state.entities["obj-1"]?.flags).toEqual(["from-content"]);
  });

  it("keeps the code defaults where the content does not override", () => {
    const runtime = makeRuntime();
    const entity = createEntity("obj-1", {
      at_object_creation: (ctx) => {
        ctx.state.flags = ["code-default"];
      },
      at_object_post_creation: () => {
        // content declares nothing for flags: no override, defaults stand
      },
    });
    const { ports } = makePorts();

    createObject(runtime, { entity, locationId: "room-a" }, ports);

    expect(runtime.state.entities["obj-1"]?.flags).toEqual(["code-default"]);
  });

  it("registers the entity: occupancy and location answer immediately", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();

    createObject(runtime, { entity: createEntity("obj-1"), locationId: "room-b" }, ports);

    expect(runtime.locationOf("obj-1")).toBe("room-b");
    expect(runtime.occupantsOf("room-b")).toEqual(["obj-1"]);
  });

  it("creates a hookless entity just the same (both layers are opt-in)", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();

    createObject(runtime, { entity: createEntity("plain-1"), locationId: "room-a" }, ports);

    expect(runtime.state.entities["plain-1"]?.flags).toEqual([]);
    expect(runtime.locationOf("plain-1")).toBe("room-a");
  });

  it("lets the creation hooks emit semantic events through the port", () => {
    const runtime = makeRuntime();
    const entity = createEntity("obj-1", {
      at_object_post_creation: (ctx) => {
        ctx.emit("obj-1", { type: "objectCreated", entityId: ctx.entityId });
      },
    });
    const { ports, emissions } = makePorts();

    createObject(runtime, { entity, locationId: "room-a" }, ports);

    expect(emissions).toEqual([{ to: "obj-1", draft: { type: "objectCreated", entityId: "obj-1" } }]);
  });

  it("throws loudly on an unresolvable location (wiring bug, not play)", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();
    expect(() =>
      createObject(runtime, { entity: createEntity("obj-1"), locationId: "nowhere" }, ports),
    ).toThrow(/neither a loaded room nor a registered entity/);
  });
});

// ---------------------------------------------------------------------------
// The dynamic cmdset seam (spec/03 §7.9, Evennia's at_cmdset_get)
// ---------------------------------------------------------------------------

/** Two synthetic sources: a general source and a higher-priority one. */
const BASE_SOURCES: readonly CmdSetSource[] = [
  {
    priority: 0,
    commands: [
      { key: "cmd-look", verbs: ["look"] },
      { key: "cmd-rest", verbs: ["rest"] },
    ],
  },
  { priority: 10, commands: [{ key: "cmd-say", verbs: ["say"] }] },
];

describe("the dynamic cmdset seam (spec/03 §7.9)", () => {
  it("hands the hook the entity's live state and the host's base sources", () => {
    const runtime = makeRuntime();
    const seen: Array<{ flags: string[]; locationId: string; keys: string[] }> = [];
    runtime.addEntity(
      createEntity("actor-1", {
        at_cmdset_get: (ctx) => {
          seen.push({
            flags: [...ctx.flags],
            locationId: ctx.locationId,
            keys: ctx.sources.flatMap((source) => source.commands.map((command) => command.key)),
          });
        },
      }),
      "room-a",
    );
    runtime.state.entities["actor-1"]!.flags.push("muted");

    const sources = assembleSources(runtime, "actor-1", BASE_SOURCES);

    // The state view is the tree's truth (the filter reads it); the sources
    // are exactly what the host assembled — nothing hidden, nothing added.
    expect(seen).toEqual([
      { flags: ["muted"], locationId: "room-a", keys: ["cmd-look", "cmd-rest", "cmd-say"] },
    ]);
    // A void return means "no adjustment": the base sources pass through
    // untouched — the same reference, not a copy.
    expect(sources).toBe(BASE_SOURCES);
  });

  it("hands the hook a defensive copy: mutating ctx.sources cannot poison the host's base", () => {
    const runtime = makeRuntime();
    const baseCopy = BASE_SOURCES.map((source) => ({
      ...source,
      commands: source.commands.map((command) => ({ ...command })),
    }));
    runtime.addEntity(
      createEntity("actor-1", {
        at_cmdset_get: (ctx) => {
          // A misbehaving hook mutates in place instead of returning: it
          // pushes a whole source, and rewrites one source's commands. The
          // cast is deliberate — the readonly types are the compile-time
          // guard, this is the runtime one.
          (ctx.sources as CmdSetSource[]).push({
            priority: 999,
            commands: [{ key: "cmd-injected", verbs: ["sneak"] }],
          });
          const firstSource = ctx.sources[0]!;
          (firstSource.commands as { key: string; verbs: string[] }[]).push({
            key: "cmd-injected-too",
            verbs: ["sneak2"],
          });
        },
      }),
      "room-a",
    );

    const sources = assembleSources(runtime, "actor-1", baseCopy);

    // The host's assembled base is untouched — both the array and every
    // source's command list — and the void return passes the ORIGINAL
    // reference through, mutations discarded with the copy.
    expect(baseCopy).toEqual(BASE_SOURCES);
    expect(sources).toBe(baseCopy);
  });

  it("re-assembles on state change: the mute takes effect on the NEXT dispatch", () => {
    const runtime = makeRuntime();
    runtime.addEntity(
      createEntity("actor-1", {
        at_cmdset_get: (ctx) =>
          ctx.flags.includes("muted")
            ? ctx.sources.map((source) => ({
                ...source,
                commands: source.commands.filter((command) => command.key !== "cmd-say"),
              }))
            : ctx.sources,
      }),
      "room-a",
    );
    const calls: string[] = [];
    const spec: CommandSpec<WorldRuntime> = {
      key: "cmd-say",
      argForm: "text",
      func: (ctx) => {
        calls.push(ctx.command.actorId);
      },
    };
    // The host's per-dispatch assembly: sources are re-asked EVERY dispatch
    // (the engine keeps no cache — Evennia's merge cache is a documented
    // pitfall, spec/08), so state changes surface on the very next input.
    const dispatch = (input: string) => {
      const sources = assembleSources(runtime, "actor-1", BASE_SOURCES);
      const harness = createCommandHarness<WorldRuntime>({
        world: runtime,
        liveWorld: true,
        receivers: ["actor-1"],
        cmdsets: sources,
      });
      return harness.call(spec, input, { actorId: "actor-1" });
    };

    // Before the state change the verb dispatches.
    expect(dispatch("say hello").result.ok).toBe(true);
    expect(calls).toEqual(["actor-1"]);

    // The state changes between dispatches (an effect lands, a host system
    // writes the tree): no API call, no event — the flag is the whole change.
    runtime.state.entities["actor-1"]!.flags.push("muted");

    // The NEXT dispatch no longer knows the verb: the filtered source set
    // merged without cmd-say, so the parse stage cannot match the input.
    const refused = dispatch("say hello");
    expect(refused.result.ok).toBe(false);
    expect(refused.result).toMatchObject({ kind: "invalid", reason: "unknownVerb" });
    expect(calls).toEqual(["actor-1"]);

    // And the change is reversible: state back, action back.
    runtime.state.entities["actor-1"]!.flags.length = 0;
    expect(dispatch("say hello").result.ok).toBe(true);
    expect(calls).toEqual(["actor-1", "actor-1"]);
  });

  it("lets the hook ADD sources, not just filter (a granted extra action)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(
      createEntity("actor-1", {
        at_cmdset_get: (ctx) => [
          ...ctx.sources,
          { priority: 100, commands: [{ key: "cmd-extra", verbs: ["focus"] }] },
        ],
      }),
      "room-a",
    );

    const merged = mergeCmdSets(assembleSources(runtime, "actor-1", BASE_SOURCES));

    expect(merged.commands.map((command) => command.key)).toEqual([
      "cmd-look",
      "cmd-rest",
      "cmd-say",
      "cmd-extra",
    ]);
    const verbs = merged.verbEntries().map((entry) => entry.verb);
    expect(verbs).toContain("focus");
  });

  it("returns the base sources untouched for a hookless entity", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("actor-1"), "room-a");

    expect(assembleSources(runtime, "actor-1", BASE_SOURCES)).toBe(BASE_SOURCES);
  });

  it("is deterministic: the same state assembles the same sources (ADR-0024 §2)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(
      createEntity("actor-1", {
        at_cmdset_get: (ctx) => ctx.flags.map(() => ctx.sources).flat(),
      }),
      "room-a",
    );
    runtime.state.entities["actor-1"]!.flags.push("muted", "tired");

    const first = assembleSources(runtime, "actor-1", BASE_SOURCES);
    const second = assembleSources(runtime, "actor-1", BASE_SOURCES);

    expect(first).toEqual(second);
  });

  it("throws loudly on an unknown entity id (wiring bug, not play)", () => {
    const runtime = makeRuntime();
    expect(() => assembleSources(runtime, "ghost", BASE_SOURCES)).toThrow(/unknown entity/);
  });
});
