import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../src/types.js";
import { commandSetSources } from "../src/command/entry.js";
import type { CommandEntry } from "../src/command/entry.js";
import type { Message } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { ContentRegistry } from "../src/content/registry.js";
import { createEntity } from "../src/world/entity.js";
import { traversalSpec } from "../src/world/traverse.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../src/world/entry.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";

/**
 * The M2-T1 tracer bullet (issue #7, ADR-0028): the whole town walk over real
 * content — gate → market → inn hall → yard — driven through the ENGINE's
 * factory traversal adapter, with player positions living in the one state
 * tree and announce events emitted per receiver. This test plays the HOST:
 * it loads content/, builds the runtime, registers player entities and
 * re-merges the command sources for the actor's CURRENT room per dispatch
 * (sources change with location — the M1 precedent, now over a live world).
 *
 * The second fake player (actor-2) drives the multi-receiver scenario; a
 * third player elsewhere (actor-3) proves out-of-room players hear nothing.
 */

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content");

function loadCollection<T>(name: string): T[] {
  const dir = join(contentDir, name);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => JSON.parse(readFileSync(join(dir, fileName), "utf8")) as T);
}

function loadRegistry(): ContentRegistry {
  return createContentRegistry({
    commands: loadCollection<CommandEntry>("commands"),
    rooms: loadCollection<RoomEntry>("rooms"),
    npcs: loadCollection<NpcEntry>("npcs"),
    monsters: loadCollection<{ id: string }>("monster"),
  });
}

const RECEIVERS = ["actor-1", "actor-2", "actor-3"];

interface DriveOutcome {
  result: CommandResult;
  messages: Message[];
}

/**
 * A host session over the live runtime: each dispatch re-merges the sources
 * of the actor's current room and runs the engine's factory traversal spec
 * for the exit whose verbs carry the input. The seq counter is session-wide
 * and monotonic, as a real host's would be.
 */
function makeDriver(registry: ContentRegistry, runtime: WorldRuntime) {
  let seq = 0;
  return (actorId: string, input: string): DriveOutcome => {
    const roomId = runtime.locationOf(actorId);
    const room = registry.room(roomId);
    const exit = room.exits.find((candidate) => candidate.verbs.includes(input));
    if (exit === undefined) {
      throw new Error(`room "${roomId}" offers no exit carrying the verb "${input}"`);
    }
    seq += 1;
    const harness = createCommandHarness<WorldRuntime>({
      world: runtime,
      liveWorld: true,
      receivers: RECEIVERS,
      cmdsets: [...commandSetSources(registry.commands), ...commandSetSources(room.exits)],
      subjectOf: (world, id) => world.subjectOf(id),
    });
    return harness.call(traversalSpec(exit), input, { actorId, seq });
  };
}

/** The standard three-player stage: two at the town gate, one in the inn hall. */
function makeStage() {
  const registry = loadRegistry();
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("actor-1"), "room-lq-001");
  runtime.addEntity(createEntity("actor-2"), "room-lq-001");
  runtime.addEntity(createEntity("actor-3"), "room-lq-003");
  return { registry, runtime, drive: makeDriver(registry, runtime) };
}

describe("the full town chain through the engine's traversal adapter (ADR-0028 §3)", () => {
  it("walks gate → market → hall → yard with the lodger flag; the position is queryable each step", () => {
    const { runtime, drive } = makeStage();
    runtime.state.entities["actor-1"]!.flags = ["inn-lodger"];

    const north = drive("actor-1", "北");
    expect(north.result).toEqual({ ok: true, seq: 1, events: expect.any(Array) });
    expect(runtime.locationOf("actor-1")).toBe("room-lq-002");

    const west = drive("actor-1", "西");
    expect(west.result.ok).toBe(true);
    expect(runtime.locationOf("actor-1")).toBe("room-lq-003");

    // The hall's gated north exit, then the yard's own enter gate — both
    // pass for a lodger, in that order, before moveTo runs.
    const northAgain = drive("actor-1", "北");
    expect(northAgain.result.ok).toBe(true);
    expect(runtime.locationOf("actor-1")).toBe("room-lq-004");
  });

  it("announces per receiver: the same-room player hears the departure, the far player nothing", () => {
    const { drive } = makeStage();

    const out = drive("actor-1", "北");

    // The mover: own departure, then own arrival.
    expectMessageSequence(
      out.messages.filter((message) => message.to === "actor-1"),
      [
        {
          event: {
            type: "departed",
            entityId: "actor-1",
            fromLocationId: "room-lq-001",
            toLocationId: "room-lq-002",
            moveType: "traverse",
            viaExitId: "exit-lq-001-north",
          },
        },
        { event: { type: "arrived", entityId: "actor-1", toLocationId: "room-lq-002" } },
      ],
    );
    // The second player, same room at departure time: the departure only.
    expectMessageSequence(out.messages.filter((message) => message.to === "actor-2"), [
      { event: { type: "departed", entityId: "actor-1", fromLocationId: "room-lq-001" } },
    ]);
    // The third player, in the inn hall: nothing at all.
    expect(out.messages.filter((message) => message.to === "actor-3")).toEqual([]);
  });

  it("refuses the hall's north exit without the flag: rejected + semantics, copy stays in the exit's JSON", () => {
    const { registry, runtime, drive } = makeStage();
    runtime.state.entities["actor-1"]!.locationId = "room-lq-003";

    const out = drive("actor-1", "北");

    // The traverse gate denied (pipeline access stage): rejected consumes
    // the seq — the refusal is content, returned as an event (spec/01 §4).
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "accessDenied",
          commandKey: "exit-lq-003-north",
          accessType: "traverse",
          errKey: "err_traverse",
        },
      },
    ]);

    // Renderer role: the errKey locates the copy on the EXIT's data, and
    // the event never carries the rendered text (spec/01 §5.1).
    const copy = registry.exit("exit-lq-003-north").err_traverse;
    expect(typeof copy).toBe("string");
    expect((copy as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(out.messages)).not.toContain(copy as string);
    // A refusal moves nobody.
    expect(runtime.locationOf("actor-1")).toBe("room-lq-003");
  });

  it("refuses the yard's enter gate through an ungated exit: copy stays in the ROOM's JSON", () => {
    const { registry, runtime } = makeStage();
    runtime.state.entities["actor-1"]!.locationId = "room-lq-003";

    // A test-authored UNGATED exit into the real yard. The shipped north
    // exit carries the same inn-lodger flag as the yard's own enter gate,
    // so a flagless player can never reach the enter gate through real
    // content (the room gate is deliberate defense-in-depth for future
    // entrances) — exercising the adapter's enter check needs an ungated
    // edge, and the REFUSAL COPY under test is still the real room's
    // err_enter JSON. The traverse gate is the exit's business (absent
    // here), the enter gate is the ROOM's — the adapter checks both, in
    // order, before moveTo (ADR-0028 §3).
    const ungated: ExitEntry = {
      id: "exit-test-yard",
      direction: "北",
      targetRoomId: "room-lq-004",
      verbs: ["北"],
      argForm: "none",
      cmdset: "exits",
      priority: 101,
    };
    const harness = createCommandHarness<WorldRuntime>({
      world: runtime,
      liveWorld: true,
      receivers: ["actor-1"],
      cmdsets: [...commandSetSources(registry.commands), ...commandSetSources([ungated])],
      subjectOf: (world, id) => world.subjectOf(id),
    });

    const out = harness.call(traversalSpec(ungated), "北", { actorId: "actor-1" });

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "accessDenied",
          commandKey: "exit-test-yard",
          accessType: "enter",
          errKey: "err_enter",
          roomId: "room-lq-004",
        },
      },
    ]);

    // The enter-gate copy is the ROOM's field; the event names the room so
    // the renderer can find it.
    const copy = registry.room("room-lq-004").err_enter;
    expect(typeof copy).toBe("string");
    expect(copy as string).toContain("住店客人");
    expect(JSON.stringify(out.messages)).not.toContain(copy as string);
    expect(runtime.locationOf("actor-1")).toBe("room-lq-003");
  });

  it("lets a lodger pass both gates on the same path that refused the flagless player", () => {
    const { runtime, drive } = makeStage();
    runtime.state.entities["actor-1"]!.locationId = "room-lq-003";
    runtime.state.entities["actor-1"]!.flags = ["inn-lodger"];

    const out = drive("actor-1", "北");

    expect(out.result.ok).toBe(true);
    expect(runtime.locationOf("actor-1")).toBe("room-lq-004");
    expectMessageSequence(out.messages.filter((message) => message.to === "actor-1"), [
      { event: { type: "departed", entityId: "actor-1", fromLocationId: "room-lq-003" } },
      { event: { type: "arrived", entityId: "actor-1", toLocationId: "room-lq-004" } },
    ]);
  });

  it("surfaces a movement hook veto as a rejected command with the vetoing stage named", () => {
    const { registry, runtime } = makeStage();
    // A player entity whose at_pre_move refuses: the adapter reaches moveTo
    // (both gates open — the gate exit has none, the market neither) and
    // the hook aborts the move itself.
    runtime.addEntity(
      createEntity("stubborn-1", { at_pre_move: () => false }),
      "room-lq-001",
    );
    const harness = createCommandHarness<WorldRuntime>({
      world: runtime,
      liveWorld: true,
      receivers: ["stubborn-1"],
      cmdsets: [
        ...commandSetSources(registry.commands),
        ...commandSetSources(registry.room("room-lq-001").exits),
      ],
      subjectOf: (world, id) => world.subjectOf(id),
    });
    const exit = registry.room("room-lq-001").exits[0]!;

    const out = harness.call(traversalSpec(exit), "北", { actorId: "stubborn-1" });

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "moveVetoed" });
    expectMessageSequence(out.messages, [
      {
        to: "stubborn-1",
        event: {
          type: "commandRefused",
          reason: "moveVetoed",
          commandKey: "exit-lq-001-north",
          stage: "at_pre_move",
        },
      },
    ]);
    expect(runtime.locationOf("stubborn-1")).toBe("room-lq-001");
  });

  it("is deterministic: two identical sessions emit identical event streams (ADR-0017)", () => {
    const runSession = () => {
      const { runtime, drive } = makeStage();
      runtime.state.entities["actor-1"]!.flags = ["inn-lodger"];
      return ["北", "西", "北"].map((input) => {
        const out = drive("actor-1", input);
        return { result: out.result, messages: out.messages };
      });
    };

    const first = runSession();
    const second = runSession();

    expect(second).toEqual(first);
    expect(first.map((step) => step.result.ok)).toEqual([true, true, true]);
  });
});
