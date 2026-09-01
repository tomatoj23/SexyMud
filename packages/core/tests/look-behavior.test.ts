import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../src/types.js";
import { commandSetSources } from "../src/command/entry.js";
import type { CommandEntry } from "../src/command/entry.js";
import type { CommandSpec, Message } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { ContentRegistry } from "../src/content/registry.js";
import { createEntity } from "../src/world/entity.js";
import { atLook, lookSpec, returnAppearance } from "../src/world/look.js";
import { traversalSpec } from "../src/world/traverse.js";
import type { NpcEntry, RoomEntry } from "../src/world/entry.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";

/**
 * The M2-T2 look behaviour (issue #8, spec/03 §7.5–§7.6, ADR-0028): the pure
 * appearance assembly (where static presence — the placement list, read
 * straight from content — meets dynamic occupancy — the state tree's
 * positions), the visibility check inside at_look, and the engine's factory
 * look adapter bound to the real cmd-look content entry. As with the
 * traversal chain, this test plays the HOST: real content, live runtime,
 * per-dispatch cmdset re-merge; the second fake player drives the
 * multi-occupant scenes.
 *
 * The veiled (dark) room is synthetic — Liuqing village has no dark rooms,
 * and the visibility gate is deliberately opt-in, so no shipped room carries
 * one (the same precedent as traversal-chain's synthetic ungated exit).
 */

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content");

function loadCollection<T>(name: string): T[] {
  const dir = join(contentDir, name);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => JSON.parse(readFileSync(join(dir, fileName), "utf8")) as T);
}

const RECEIVERS = ["actor-1", "actor-2"];

/** The veiled copy stays in the room's data; the test asserts the event never carries it. */
const VEILED_COPY = "四下漆黑，你什么也看不清。";

/** A synthetic room with an explicit look gate (spec/03 §7.5 landing form). */
const VEILED_ROOM: RoomEntry = {
  id: "room-test-veiled",
  name: "地窖",
  description: "储着过冬菜蔬的地窖，一角有座冷了的灶。",
  enterText: "你摸索着走下地窖的石阶。",
  exits: [],
  preconditions: {
    default: true,
    look: { has_flag: "carries-lantern" },
  },
  err_look: VEILED_COPY,
};

interface DriveOutcome {
  result: CommandResult;
  messages: Message[];
}

/**
 * A host session over the live runtime: each dispatch re-merges the sources
 * of the actor's current room (sources change with location) and runs the
 * given spec for the input. The seq counter is session-wide and monotonic,
 * as a real host's would be.
 */
function makeDriver(registry: ContentRegistry, runtime: WorldRuntime) {
  let seq = 0;
  const call = (actorId: string, input: string, spec: CommandSpec<WorldRuntime>): DriveOutcome => {
    const roomId = runtime.locationOf(actorId);
    const room = registry.room(roomId);
    seq += 1;
    const harness = createCommandHarness<WorldRuntime>({
      world: runtime,
      liveWorld: true,
      receivers: RECEIVERS,
      cmdsets: [...commandSetSources(registry.commands), ...commandSetSources(room.exits)],
      subjectOf: (world, id) => world.subjectOf(id),
    });
    return harness.call(spec, input, { actorId, seq });
  };
  const walk = (actorId: string, input: string): DriveOutcome => {
    const room = registry.room(runtime.locationOf(actorId));
    const exit = room.exits.find((candidate) => candidate.verbs.includes(input));
    if (exit === undefined) {
      throw new Error(`room "${runtime.locationOf(actorId)}" offers no exit carrying the verb "${input}"`);
    }
    return call(actorId, input, traversalSpec(exit));
  };
  const look = (actorId: string, input = "看"): DriveOutcome =>
    call(actorId, input, lookSpec(registry.command("cmd-look")));
  return { walk, look };
}

function loadRegistry(extraRooms: readonly RoomEntry[] = []): ContentRegistry {
  return createContentRegistry({
    commands: loadCollection<CommandEntry>("commands"),
    rooms: [...loadCollection<RoomEntry>("rooms"), ...extraRooms],
    npcs: loadCollection<NpcEntry>("npcs"),
    monsters: loadCollection<{ id: string }>("monster"),
  });
}

/** The standard two-player stage, both fake players constructed in one room. */
function makeStage(roomId: string, extraRooms: readonly RoomEntry[] = []) {
  const registry = loadRegistry(extraRooms);
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("actor-1"), roomId);
  runtime.addEntity(createEntity("actor-2"), roomId);
  return { registry, runtime, drive: makeDriver(registry, runtime) };
}

describe("return_appearance — the pure assembly (spec/03 §7.5)", () => {
  it("assembles the hall: content fields, the placement list direct-read, occupancy from the tree minus the viewer", () => {
    const { registry, runtime } = makeStage("room-lq-003");

    const appearance = returnAppearance(runtime, "room-lq-003", "actor-1");

    expect(appearance).toEqual({
      roomId: "room-lq-003",
      name: "迎宾客栈大堂",
      description: registry.room("room-lq-003").description,
      exits: [
        { exitId: "exit-lq-003-east", direction: "东", verbs: ["东", "east", "e", "往东走"] },
        { exitId: "exit-lq-003-north", direction: "北", verbs: ["北", "north", "n", "往北走"] },
      ],
      staticPresence: [{ id: "npc-lq-002", count: 1 }],
      occupants: ["actor-2"],
    });
  });

  it("is pure: no state writes, no messages, stable across calls", () => {
    const { runtime } = makeStage("room-lq-003");
    const before = structuredClone(runtime.state);

    const first = returnAppearance(runtime, "room-lq-003", "actor-1");
    expect(returnAppearance(runtime, "room-lq-003", "actor-1")).toEqual(first);
    expect(runtime.state).toEqual(before);
  });

  it("is the meeting point: the yard shows the placed guard AND the tree occupant together (ADR-0028 §1)", () => {
    const { runtime } = makeStage("room-lq-004");

    const appearance = returnAppearance(runtime, "room-lq-004", "actor-1");

    // Static presence (the placement list: the guard) and dynamic occupancy
    // (the state tree: the second fake player) answer "who is here" together,
    // in one assembly — this function is the only place they join.
    expect(appearance.staticPresence).toEqual([{ id: "npc-lq-003", count: 1 }]);
    expect(appearance.occupants).toEqual(["actor-2"]);
  });
});

describe("at_look — the visibility check lives here, not in the command (spec/03 §7.6)", () => {
  it("leaves ungated rooms visible even when their default denies: default governs enter, not look", () => {
    // The yard's preconditions are { default: false, enter: has_flag } — its
    // default denies ENTRY. Both players are constructed inside (construction
    // is data, not movement), flagless; the room must still be visible to
    // them, or every deny-by-default room would go dark for its own occupants.
    const { runtime } = makeStage("room-lq-004");

    const look = atLook(runtime, "room-lq-004", "actor-1");

    expect(look.ok).toBe(true);
    if (look.ok) {
      expect(look.appearance.roomId).toBe("room-lq-004");
    }
  });

  it("denies the veiled room to the unequipped viewer and admits the equipped one", () => {
    const { runtime } = makeStage("room-test-veiled", [VEILED_ROOM]);

    expect(atLook(runtime, "room-test-veiled", "actor-1")).toEqual({ ok: false, errKey: "err_look" });

    runtime.state.entities["actor-1"]!.flags = ["carries-lantern"];
    const lit = atLook(runtime, "room-test-veiled", "actor-1");
    expect(lit.ok).toBe(true);
  });

  it("rejects locations that are not rooms loudly (container appearance is the materialization ticket's)", () => {
    const { runtime } = makeStage("room-lq-001");
    expect(() => atLook(runtime, "actor-2", "actor-1")).toThrow(/is not a room/);
  });
});

describe("the look factory adapter over real content (ADR-0028 §2)", () => {
  it("runs the full chain through call(): one semantic appearance event, to the looker only", () => {
    const { registry, drive } = makeStage("room-lq-003");

    const out = drive.look("actor-1");

    expect(out.result).toEqual({ ok: true, seq: 1, events: expect.any(Array) });
    expectMessageSequence(
      out.messages.filter((message) => message.to === "actor-1"),
      [
        {
          event: {
            type: "appearance",
            roomId: "room-lq-003",
            exits: [
              { exitId: "exit-lq-003-east", direction: "东", verbs: ["东", "east", "e", "往东走"] },
              { exitId: "exit-lq-003-north", direction: "北", verbs: ["北", "north", "n", "往北走"] },
            ],
            staticPresence: [{ id: "npc-lq-002", count: 1 }],
            occupants: ["actor-2"],
          },
        },
      ],
    );
    // A look is the looker's private perception: the same-room player hears
    // nothing (unlike movement announcements).
    expect(out.messages.filter((message) => message.to === "actor-2")).toEqual([]);
    // Zero rendered text holds for the hall too: the innkeeper's name stays
    // in data — the event references npc-lq-002 by id only.
    expect(JSON.stringify(out.messages)).not.toContain(registry.npc("npc-lq-002").name);
  });

  it("carries zero rendered text: room copy and entity names stay in data, reached by id", () => {
    const { registry, drive } = makeStage("room-lq-004");

    const out = drive.look("actor-1");

    const room = registry.room("room-lq-004");
    expect(JSON.stringify(out.messages)).not.toContain(room.name);
    expect(JSON.stringify(out.messages)).not.toContain(room.description);
    // The guard's name resolves through the registry — the renderer's job,
    // exactly like err_* copy; the event carries the id, never the name.
    expect(registry.npc("npc-lq-003").name).toBe("孙彪");
    expect(JSON.stringify(out.messages)).not.toContain("孙彪");
  });

  it("shows the yard scene: the placed guard and the second fake player both present (issue #8 demo)", () => {
    const { drive } = makeStage("room-lq-004");

    const out = drive.look("actor-1");

    expectMessageSequence(
      out.messages.filter((message) => message.to === "actor-1"),
      [
        {
          event: {
            type: "appearance",
            roomId: "room-lq-004",
            exits: [{ exitId: "exit-lq-004-south", direction: "南", verbs: ["南", "south", "s", "往南走"] }],
            staticPresence: [{ id: "npc-lq-003", count: 1 }],
            occupants: ["actor-2"],
          },
        },
      ],
    );
  });

  it("refuses the veiled room: rejected with the refusal semantics, copy stays in the room's JSON", () => {
    const { drive } = makeStage("room-test-veiled", [VEILED_ROOM]);

    const out = drive.look("actor-1");

    // A visibility refusal is a legitimate mid-execution refusal (the
    // CommandRejection channel): rejected consumes the seq — the refusal is
    // game content, returned as an event (spec/01 §4).
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "notVisible" });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "notVisible",
          commandKey: "cmd-look",
          accessType: "look",
          errKey: "err_look",
          roomId: "room-test-veiled",
        },
      },
    ]);
    expect(JSON.stringify(out.messages)).not.toContain(VEILED_COPY);
  });

  it("lifts the veil within one session when the viewer picks up the flag (live world)", () => {
    const { runtime, drive } = makeStage("room-test-veiled", [VEILED_ROOM]);

    const blind = drive.look("actor-1");
    expect(blind.result.ok).toBe(false);

    runtime.state.entities["actor-1"]!.flags = ["carries-lantern"];
    const lit = drive.look("actor-1");
    expect(lit.result.ok).toBe(true);
    expectMessageSequence(
      lit.messages.filter((message) => message.to === "actor-1"),
      [{ event: { type: "appearance", roomId: "room-test-veiled", staticPresence: [] } }],
    );
  });

  it("follows the actor: walk north, then look shows the market", () => {
    const { drive } = makeStage("room-lq-001");

    const walk = drive.walk("actor-1", "北");
    expect(walk.result.ok).toBe(true);

    // The English verb dispatches the same command — verbs are data.
    const out = drive.look("actor-1", "look");
    expectMessageSequence(
      out.messages.filter((message) => message.to === "actor-1"),
      [
        {
          event: {
            type: "appearance",
            roomId: "room-lq-002",
            exits: [
              { exitId: "exit-lq-002-south", direction: "南" },
              { exitId: "exit-lq-002-west", direction: "西" },
            ],
            staticPresence: [],
            occupants: [],
          },
        },
      ],
    );
  });

  it("is deterministic: two identical sessions emit identical streams (ADR-0017)", () => {
    const runSession = () => {
      const { drive } = makeStage("room-lq-001");
      return [drive.look("actor-1"), drive.walk("actor-1", "北"), drive.look("actor-1")].map(
        (out) => ({ result: out.result, messages: out.messages }),
      );
    };

    expect(runSession()).toEqual(runSession());
  });

  it("fails loudly when bound to an entry that takes arguments (wiring bug, not play)", () => {
    const base = loadCollection<CommandEntry>("commands").find((c) => c.id === "cmd-look")!;
    const entry: CommandEntry = { ...base, argForm: "text" };
    expect(() => lookSpec(entry)).toThrow(/argForm/);
  });
});
