import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { commandSetSources } from "../src/command/entry.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { DimensionTable } from "../src/content/registry.js";
import { createEntity } from "../src/world/entity.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../src/world/entry.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";
import { traversalSpec } from "../src/world/traverse.js";

/**
 * Runtime tags (issue #17; spec/03 §5.1, ADR-0029 §1–§2, spec/02 §5.3):
 * the `tags` slot on EntityState, `hasTag(维度, 键)` no longer being a stub,
 * the "own ∪ content entry" union seam, and one gated exit driven through
 * `call()` end to end.
 *
 * Two seams, both pre-existing (the M3 test-seam decision):
 *   1. `WorldRuntime.subjectOf` — the engine's own subject builder, read
 *      from a synthetic state tree;
 *   2. `call()` — the highest seam there is: a synthetic exit carrying a
 *      `has_tag` gate, whose tags the test writes straight into the player's
 *      state (the look ticket's "carrying the lamp writes flags" precedent).
 *
 * Everything here is SYNTHETIC: today only players are dynamic occupants and
 * players have no content entry, so the union's content half is driven by a
 * runtime entity that SHARES an id with an npc entry — the seam exists and
 * answers, waiting for the materialization ticket (items, stateful NPCs) to
 * give it a real consumer.
 *
 * The gated exit's JSON is validated against `schemas/` with Ajv the way
 * content:check does: the two-element `has_tag` argument and the refusal copy
 * are content, and content has to pass the gate offline before the engine
 * ever sees it (spec/06 §4's three-way sync).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schemasDir = resolve(root, "schemas");

/**
 * Two dimensions sharing the key "inner" — the whole reason a tag is a PAIR:
 * collapsing it to one string would either invent a separator or merge two
 * unrelated facts.
 */
const DIMENSIONS: DimensionTable = { zone: ["inner", "outer"], layer: ["inner", "outer"] };

/** Every schema registered by $id, exactly like content:check does. */
function compileSchemas() {
  const ajv = new Ajv({ allErrors: true });
  const parsed = new Map<string, object>();
  for (const name of readdirSync(schemasDir).sort()) {
    if (!name.endsWith(".schema.json")) continue;
    const schema = JSON.parse(readFileSync(resolve(schemasDir, name), "utf8")) as object;
    parsed.set(name, schema);
    ajv.addSchema(schema);
  }
  return { ajv, parsed };
}

const { ajv, parsed } = compileSchemas();

function validateAgainst(schemaName: string) {
  const schema = parsed.get(schemaName);
  if (schema === undefined) throw new Error(`no such schema: ${schemaName}`);
  return ajv.compile(schema);
}

function room(id: string, overrides: Record<string, unknown> = {}): RoomEntry {
  return {
    id,
    name: `name-${id}`,
    description: `description-${id}`,
    enterText: `enter-${id}`,
    exits: [],
    ...overrides,
  } as RoomEntry;
}

/**
 * The one authored fixture of this file, and it is authored as CONTENT: it
 * goes to Ajv first (a room file's shape) and to the registry second (the
 * host's load), so the gate's tuple and its refusal copy are proven to be
 * legal content, not merely accepted by the engine.
 */
const GATED_ROOM = {
  id: "room-tag-001",
  name: "内城门洞",
  description: "一道厚重的木门把内外城隔开。",
  enterText: "你走近门洞，守卫的目光扫了过来。",
  exits: [
    {
      id: "exit-tag-001-north",
      direction: "北",
      targetRoomId: "room-tag-002",
      verbs: ["北", "north"],
      argForm: "none",
      cmdset: "exits",
      priority: 101,
      tags: { zone: ["inner"] },
      preconditions: {
        default: false,
        traverse: { has_tag: ["zone", "inner"] },
      },
      err_traverse: "守卫横刀拦下：内城重地，闲人免进。",
    },
  ],
};

const GATE_TARGET = room("room-tag-002");

function makeRegistry(npcs?: readonly NpcEntry[]): ReturnType<typeof createContentRegistry> {
  return createContentRegistry(
    {
      rooms: [GATED_ROOM as unknown as RoomEntry, GATE_TARGET],
      ...(npcs === undefined ? {} : { npcs }),
    },
    { dimensions: DIMENSIONS },
  );
}

/** A runtime with one player standing at the gate, plus its registry. */
function makeStage(npcs?: readonly NpcEntry[]) {
  const registry = makeRegistry(npcs);
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("player-1"), "room-tag-001");
  return { registry, runtime };
}

/** One dispatch through `call()`: the host's per-command assembly, live world. */
function drive(runtime: WorldRuntime, input = "北") {
  const here = runtime.registry.room(runtime.locationOf("player-1"));
  const exit = here.exits.find((candidate) => candidate.verbs.includes(input));
  if (exit === undefined) throw new Error(`no exit carries the verb "${input}" here`);
  const harness = createCommandHarness<WorldRuntime>({
    world: runtime,
    liveWorld: true,
    receivers: ["player-1"],
    cmdsets: commandSetSources([exit]),
    subjectOf: (world, actorId) => world.subjectOf(actorId),
  });
  return { out: harness.call(traversalSpec(exit), input, { actorId: "player-1" }), exit };
}

describe("the runtime tags slot (spec/03 §5.1, ADR-0029 §1)", () => {
  it("answers hasTag(维度, 键) from the state tree — not from a stub", () => {
    const { runtime } = makeStage();
    runtime.state.entities["player-1"]!.tags = { zone: ["inner"], layer: ["outer"] };

    const subject = runtime.subjectOf("player-1");
    expect(subject.hasTag("zone", "inner")).toBe(true);
    expect(subject.hasTag("layer", "outer")).toBe(true);
    // A key is only a tag together with its dimension.
    expect(subject.hasTag("layer", "inner")).toBe(false);
    expect(subject.hasTag("zone", "outer")).toBe(false);
    expect(subject.hasTag("zone", "nowhere")).toBe(false);
    expect(subject.hasTag("nowhere", "inner")).toBe(false);
  });

  it("seeds the slot empty: a fresh entity answers no tag, and no `??` anywhere", () => {
    const { runtime } = makeStage();
    expect(runtime.state.entities["player-1"]!.tags).toEqual({});
    expect(runtime.subjectOf("player-1").hasTag("zone", "inner")).toBe(false);
  });

  it("keeps tags and flags from flavouring each other", () => {
    const { runtime } = makeStage();
    runtime.state.entities["player-1"]!.flags = ["inner"];
    expect(runtime.subjectOf("player-1").hasTag("zone", "inner")).toBe(false);
    expect(runtime.subjectOf("player-1").hasFlag("inner")).toBe(true);

    runtime.state.entities["player-1"]!.tags = { zone: ["inner"] };
    expect(runtime.subjectOf("player-1").hasTag("zone", "inner")).toBe(true);
    // Writing tags changed no flag, and vice versa: two layers, not two
    // spellings of one (ADR-0029 §4).
    expect(runtime.subjectOf("player-1").hasFlag("inner")).toBe(true);
    expect(runtime.state.entities["player-1"]!.flags).toEqual(["inner"]);
  });
});

describe("the union seam: own tags ∪ the content entry's tags", () => {
  const lanternNpc: NpcEntry = {
    id: "npc-tag-keeper",
    name: "name-npc-tag-keeper",
    description: "description-npc-tag-keeper",
    tags: { zone: ["inner"] },
  };

  it("hits the STATIC tags of the entity's content entry — the half with no real consumer yet", () => {
    const { runtime } = makeStage([lanternNpc]);
    runtime.addEntity(createEntity("npc-tag-keeper"), "room-tag-001");
    // Own tags stay empty: everything answered below comes from content.
    expect(runtime.state.entities["npc-tag-keeper"]!.tags).toEqual({});

    expect(runtime.subjectOf("npc-tag-keeper").hasTag("zone", "inner")).toBe(true);
    expect(runtime.subjectOf("npc-tag-keeper").hasTag("zone", "outer")).toBe(false);
  });

  it("counts an INHERITED content tag as part of the union (flattening precedes indexing)", () => {
    const parent: NpcEntry = {
      id: "npc-tag-parent",
      name: "name-npc-tag-parent",
      description: "description-npc-tag-parent",
      prototypeKey: "npc-tag-parent",
      tags: { zone: ["inner"] },
    };
    const child: NpcEntry = {
      id: "npc-tag-child",
      name: "name-npc-tag-child",
      description: "description-npc-tag-child",
      prototypeParent: ["npc-tag-parent"],
      tags: { layer: ["outer"] },
    };

    const { runtime } = makeStage([parent, child]);
    runtime.addEntity(createEntity("npc-tag-child"), "room-tag-001");

    // The child's own tag AND the one it inherited from its prototype.
    expect(runtime.subjectOf("npc-tag-child").hasTag("layer", "outer")).toBe(true);
    expect(runtime.subjectOf("npc-tag-child").hasTag("zone", "inner")).toBe(true);
  });

  it("lets both halves contribute: the same dimension holding a key from each", () => {
    const { runtime } = makeStage([lanternNpc]);
    runtime.addEntity(createEntity("npc-tag-keeper"), "room-tag-001");
    runtime.state.entities["npc-tag-keeper"]!.tags = { zone: ["outer"] };

    expect(runtime.subjectOf("npc-tag-keeper").hasTag("zone", "outer")).toBe(true); // own
    expect(runtime.subjectOf("npc-tag-keeper").hasTag("zone", "inner")).toBe(true); // entry
  });

  it("is simply the entity's own tags when it has no content entry — today's players", () => {
    const { runtime } = makeStage([lanternNpc]);
    runtime.state.entities["player-1"]!.tags = { layer: ["inner"] };

    expect(runtime.subjectOf("player-1").hasTag("layer", "inner")).toBe(true);
    // No content entry claims the id, so the content half contributes nothing
    // rather than failing: "no entry" is the normal case, not a wiring bug.
    expect(runtime.subjectOf("player-1").hasTag("zone", "inner")).toBe(false);
  });
});

describe("registry.tagsOf — the dual of byTag", () => {
  it("answers the entry's tags, exits included, and an empty map for an unknown id", () => {
    const registry = makeStage().registry;

    expect(registry.tagsOf("exit-tag-001-north")).toEqual({ zone: ["inner"] });
    // A player id is in no collection: empty, not a throw.
    expect(registry.tagsOf("player-1")).toEqual({});
    expect(registry.tagsOf("room-tag-002")).toEqual({});
  });

  it("never disagrees with byTag: every pair it holds is queryable and vice versa", () => {
    const registry = makeStage().registry;

    expect(registry.byTag("zone", "inner")).toContain("exit-tag-001-north");
    for (const [dimension, keys] of Object.entries(registry.tagsOf("exit-tag-001-north"))) {
      for (const key of keys ?? []) {
        expect(registry.byTag(dimension, key)).toContain("exit-tag-001-north");
      }
    }
  });

  it("carries tags, not flags — the two layers stay apart on the content side too", () => {
    const registry = createContentRegistry(
      {
        rooms: [
          room("room-tag-001", {
            exits: [
              {
                id: "exit-tag-001-north",
                direction: "北",
                targetRoomId: "room-tag-002",
                verbs: ["北"],
                argForm: "none",
                cmdset: "exits",
                priority: 101,
                flags: ["lit"],
              },
            ],
          }),
          GATE_TARGET,
        ],
      },
      { dimensions: DIMENSIONS },
    );

    expect(registry.tagsOf("exit-tag-001-north")).toEqual({});
    expect(registry.byTag("zone", "lit")).toEqual([]);
  });
});

describe("the gate, end to end through call() (spec/02 §5.4)", () => {
  it("the exit's JSON is legal content: the tuple argument and the refusal copy both pass schemas/", () => {
    // Same fixture, two consumers: content:check's gate (Ajv) and the host's
    // load path (the registry). A shape the engine accepts but the schema
    // rejects would be content nobody could author.
    expect(validateAgainst("rooms.schema.json")(GATED_ROOM)).toBe(true);
    expect(() => makeRegistry()).not.toThrow();
  });

  it("refuses a player with no tags: rejected + a semantic event, copy still in the JSON", () => {
    const { registry, runtime } = makeStage();
    const { out } = drive(runtime);

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
    expectMessageSequence(out.messages, [
      {
        to: "player-1",
        event: {
          type: "commandRefused",
          reason: "accessDenied",
          commandKey: "exit-tag-001-north",
          accessType: "traverse",
          errKey: "err_traverse",
        },
      },
    ]);

    // The renderer's path: read the field the event NAMED, from the exit's
    // data. The engine carries no text (spec/01 §5.1).
    const copy = registry.exit("exit-tag-001-north").err_traverse;
    expect(typeof copy).toBe("string");
    expect(JSON.stringify(out.messages)).not.toContain(copy as string);
    // A refusal moves nobody.
    expect(runtime.locationOf("player-1")).toBe("room-tag-001");
  });

  it("lets the player through once the tag is written to the state tree", () => {
    const { runtime } = makeStage();
    runtime.state.entities["player-1"]!.tags = { zone: ["inner"] };

    const { out } = drive(runtime);

    expect(out.result.ok).toBe(true);
    expect(runtime.locationOf("player-1")).toBe("room-tag-002");
    expectMessageSequence(out.messages.filter((message) => message.to === "player-1"), [
      { event: { type: "departed", entityId: "player-1", fromLocationId: "room-tag-001" } },
      { event: { type: "arrived", entityId: "player-1", toLocationId: "room-tag-002" } },
    ]);
  });

  it("refuses again after the tag is removed — the gate reads live state, not a snapshot", () => {
    const { runtime } = makeStage();
    runtime.state.entities["player-1"]!.tags = { zone: ["inner"] };
    // Back in the gate room: the move above is undone the same way a host
    // would do it (construction is data; here the test is the host).
    runtime.state.entities["player-1"]!.locationId = "room-tag-001";
    runtime.state.entities["player-1"]!.tags = {};

    const { out } = drive(runtime);

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
    expect(runtime.locationOf("player-1")).toBe("room-tag-001");
  });

  it("needs BOTH halves: the same key under another dimension, or another key, is refused", () => {
    const { runtime } = makeStage();

    runtime.state.entities["player-1"]!.tags = { layer: ["inner"] }; // right key, wrong dimension
    expect(drive(runtime).out.result).toMatchObject({ kind: "rejected", reason: "accessDenied" });

    runtime.state.entities["player-1"]!.tags = { zone: ["outer"] }; // right dimension, wrong key
    expect(drive(runtime).out.result).toMatchObject({ kind: "rejected", reason: "accessDenied" });

    runtime.state.entities["player-1"]!.tags = { zone: ["inner"] };
    expect(drive(runtime).out.result.ok).toBe(true);
  });

  it("is not fooled by a flag carrying the same word: the flag layer is not the tag layer", () => {
    const { runtime } = makeStage();
    runtime.state.entities["player-1"]!.flags = ["inner"];

    expect(drive(runtime).out.result).toMatchObject({ kind: "rejected", reason: "accessDenied" });
    expect(runtime.subjectOf("player-1").hasFlag("inner")).toBe(true);
  });

  it("replays identically: the same session twice yields the same results and events (ADR-0017)", () => {
    const runSession = () => {
      const { runtime } = makeStage();
      const refused = drive(runtime).out;
      runtime.state.entities["player-1"]!.tags = { zone: ["inner"] };
      const granted = drive(runtime).out;
      return { refused, granted };
    };

    const first = runSession();
    const second = runSession();

    expect(second).toEqual(first);
    expect(first.refused.result.ok).toBe(false);
    expect(first.granted.result.ok).toBe(true);
  });
});
