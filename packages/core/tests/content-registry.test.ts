import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../src/command/entry.js";
import { commandSetSources, commandSpecFromEntry } from "../src/command/entry.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../src/world/entry.js";

/**
 * The content read path (issue #5): the registry's load-time integrity checks
 * (ADR-0003 — duplicate and unknown ids fail loudly), the entries → cmdset
 * sources grouping (spec/02 §3 — merge rules belong to the SET), and the
 * entry → spec adapter (spec/02 §5.5 — preconditions become the access gate).
 *
 * Synthetic entries: the real content pack's own entries are exercised in
 * commands-content.test.ts through these same functions.
 */

function entry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: "cmd-probe",
    verbs: ["probe"],
    argForm: "none",
    cmdset: "character",
    priority: 0,
    ...overrides,
  };
}

describe("createContentRegistry (ADR-0003: integrity at load)", () => {
  it("lists commands id-ascending regardless of the order they were loaded in", () => {
    const registry = createContentRegistry({
      commands: [entry({ id: "cmd-c" }), entry({ id: "cmd-a" }), entry({ id: "cmd-b" })],
    });
    expect(registry.commands.map((command) => command.id)).toEqual(["cmd-a", "cmd-b", "cmd-c"]);
  });

  it("looks commands up by id", () => {
    const probe = entry();
    const registry = createContentRegistry({ commands: [probe] });
    expect(registry.command("cmd-probe")).toBe(probe);
  });

  it("throws on an unknown id — a dangling reference fails loudly, not silently", () => {
    const registry = createContentRegistry({ commands: [entry()] });
    expect(() => registry.command("cmd-nope")).toThrow(/unknown command id "cmd-nope"/);
  });

  it("throws on duplicate ids — two files claiming one id disagree about what it is", () => {
    expect(() =>
      createContentRegistry({ commands: [entry({ id: "cmd-a" }), entry({ id: "cmd-a", verbs: ["other"] })] }),
    ).toThrow(/duplicate command id "cmd-a"/);
  });

  it("throws on an empty id (host-assembled data that bypassed content:check)", () => {
    expect(() => createContentRegistry({ commands: [entry({ id: "" })] })).toThrow(/empty id/);
  });
});

describe("commandSetSources (spec/02 §3: merge rules belong to the set)", () => {
  it("groups entries by cmdset into one source per set, in first-appearance order", () => {
    const sources = commandSetSources([
      entry({ id: "cmd-a", cmdset: "character", verbs: ["a"] }),
      entry({ id: "cmd-b", cmdset: "session", priority: -20, verbs: ["b"] }),
      entry({ id: "cmd-c", cmdset: "character", verbs: ["c", "see"] }),
    ]);

    expect(sources).toEqual([
      {
        priority: 0,
        mergetype: "Union",
        commands: [
          { key: "cmd-a", verbs: ["a"] },
          { key: "cmd-c", verbs: ["c", "see"] },
        ],
      },
      { priority: -20, mergetype: "Union", commands: [{ key: "cmd-b", verbs: ["b"] }] },
    ]);
  });

  it("keeps entry order inside a set (same-key collapse and verb collision resolve to the later entry)", () => {
    const sources = commandSetSources([
      entry({ id: "cmd-first", verbs: ["one"] }),
      entry({ id: "cmd-second", verbs: ["two"] }),
    ]);
    expect(sources[0]?.commands.map((command) => command.key)).toEqual(["cmd-first", "cmd-second"]);
  });

  it("treats an explicit Union and an omitted mergetype as agreeing", () => {
    expect(() =>
      commandSetSources([
        entry({ id: "cmd-a", mergetype: "Union" }),
        entry({ id: "cmd-b" /* omitted → Union */ }),
      ]),
    ).not.toThrow();
  });

  it("throws when entries of one cmdset declare conflicting priorities", () => {
    expect(() =>
      commandSetSources([
        entry({ id: "cmd-a", priority: 0 }),
        entry({ id: "cmd-b", priority: 5 }),
      ]),
    ).toThrow(/conflicting priorities \(0 and 5\)/);
  });

  it("throws when entries of one cmdset declare conflicting mergetypes", () => {
    expect(() =>
      commandSetSources([
        entry({ id: "cmd-a", mergetype: "Union" }),
        entry({ id: "cmd-b", mergetype: "Replace" }),
      ]),
    ).toThrow(/conflicting mergetypes \("Union" and "Replace"\)/);
  });

  it("passes an explicit non-Union mergetype through to the source", () => {
    const sources = commandSetSources([
      entry({ id: "cmd-a", mergetype: "Replace", priority: 30 }),
    ]);
    expect(sources[0]).toEqual({
      priority: 30,
      mergetype: "Replace",
      commands: [{ key: "cmd-a", verbs: ["probe"] }],
    });
  });
});

describe("commandSpecFromEntry (spec/02 §5.5: entry data becomes pipeline shape)", () => {
  it("maps id to the dispatch key, argForm to the parse stage, and carries func", () => {
    const func = (): void => {};
    const spec = commandSpecFromEntry(entry(), { func });

    expect(spec.key).toBe("cmd-probe");
    expect(spec.argForm).toBe("none");
    expect(spec.func).toBe(func);
    expect(spec.access).toBeUndefined();
  });

  it("turns preconditions into the access gate asking the given accessType", () => {
    const preconditions = { default: true as const, use: { not: [{ has_state: "wounded" }] } };
    const spec = commandSpecFromEntry(entry({ preconditions }), {
      accessType: "use",
      func: (): void => {},
    });

    expect(spec.access).toEqual({ rules: preconditions, accessType: "use" });
  });

  it("throws when a gated entry is assembled without an accessType to ask", () => {
    expect(() =>
      commandSpecFromEntry(entry({ preconditions: { default: true } }), { func: (): void => {} }),
    ).toThrow(/cmd-probe.*declares preconditions but no accessType/);
    expect(() =>
      commandSpecFromEntry(entry({ preconditions: { default: true } }), {
        accessType: "",
        func: (): void => {},
      }),
    ).toThrow(/no accessType/);
  });

  it("ignores a stray accessType on an ungated entry (no gate, nothing to ask)", () => {
    const spec = commandSpecFromEntry(entry(), { accessType: "use", func: (): void => {} });
    expect(spec.access).toBeUndefined();
  });
});

/** A synthetic exit matching the exit entity shape (spec/02 §4). */
function exitEntry(overrides: Partial<ExitEntry> = {}): ExitEntry {
  return {
    id: "exit-x-001-north",
    direction: "北",
    targetRoomId: "room-x-001",
    verbs: ["北", "north", "n"],
    argForm: "none",
    cmdset: "exits",
    priority: 101,
    ...overrides,
  };
}

/** A synthetic room with the four elements (spec/03 §2). */
function roomEntry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    id: "room-x-001",
    name: "耳房",
    description: "一间堆着杂物的耳房。",
    enterText: "你侧身进了耳房。",
    exits: [],
    ...overrides,
  };
}

/** A synthetic npc (spec/03 §4). */
function npcEntry(overrides: Partial<NpcEntry> = {}): NpcEntry {
  return { id: "npc-x-001", name: "灰袍老者", description: "一位倚墙晒太阳的老者。", ...overrides };
}

describe("createContentRegistry: world collections (issue #6)", () => {
  it("lists rooms, npcs and monsters id-ascending and looks them up by id", () => {
    const registry = createContentRegistry({
      rooms: [roomEntry({ id: "room-x-002" }), roomEntry()],
      npcs: [npcEntry({ id: "npc-x-002" }), npcEntry()],
      monsters: [{ id: "mon-x-002" }, { id: "mon-x-001" }],
    });
    expect(registry.rooms.map((room) => room.id)).toEqual(["room-x-001", "room-x-002"]);
    expect(registry.npcs.map((npc) => npc.id)).toEqual(["npc-x-001", "npc-x-002"]);
    expect(registry.monsters.map((monster) => monster.id)).toEqual(["mon-x-001", "mon-x-002"]);
    expect(registry.room("room-x-001").name).toBe("耳房");
    expect(registry.npc("npc-x-001").name).toBe("灰袍老者");
    expect(registry.monster("mon-x-001").id).toBe("mon-x-001");
  });

  it("makes every collection optional — a host loads what exists", () => {
    const registry = createContentRegistry({});
    expect(registry.commands).toEqual([]);
    expect(registry.rooms).toEqual([]);
    expect(registry.npcs).toEqual([]);
    expect(registry.monsters).toEqual([]);
  });

  it("looks exits up ACROSS rooms by their global id (dispatch keys, not room fields)", () => {
    const registry = createContentRegistry({
      rooms: [
        roomEntry({ exits: [exitEntry({ id: "exit-x-001-north", targetRoomId: "room-x-002" })] }),
        roomEntry({ id: "room-x-002", exits: [exitEntry({ id: "exit-x-002-south" })] }),
      ],
    });
    expect(registry.exit("exit-x-001-north").direction).toBe("北");
    expect(registry.exit("exit-x-002-south").targetRoomId).toBe("room-x-001");
    expect(() => registry.exit("exit-nope")).toThrow(/unknown exit id "exit-nope"/);
  });

  it("throws on duplicate ids in every collection — two files claiming one id disagree", () => {
    for (const [what, content] of [
      ["room", { rooms: [roomEntry(), roomEntry({ exits: [] })] }],
      ["npc", { npcs: [npcEntry(), npcEntry({ name: "另一个" })] }],
      ["monster", { monsters: [{ id: "mon-x-001" }, { id: "mon-x-001" }] }],
    ] as const) {
      expect(() => createContentRegistry(content), what).toThrow(new RegExp(`duplicate ${what} id`));
    }
    expect(() => createContentRegistry({ rooms: [roomEntry({ id: "" })] })).toThrow(/empty id/);
  });

  it("throws on duplicate exit ids across rooms — both would answer one dispatch key", () => {
    expect(() =>
      createContentRegistry({
        rooms: [
          roomEntry({ exits: [exitEntry()] }),
          roomEntry({
            id: "room-x-002",
            exits: [exitEntry({ targetRoomId: "room-x-002" })],
          }),
        ],
      }),
    ).toThrow(/duplicate exit id "exit-x-001-north"/);
  });

  it("throws when one room declares the same direction twice — the direction is the edge's key", () => {
    expect(() =>
      createContentRegistry({
        rooms: [
          roomEntry({
            exits: [
              exitEntry({ id: "exit-a", targetRoomId: "room-x-002" }),
              exitEntry({ id: "exit-b", targetRoomId: "room-x-002" }),
            ],
          }),
          roomEntry({ id: "room-x-002" }),
        ],
      }),
    ).toThrow(/room "room-x-001" declares direction "北" twice/);
  });

  it("throws on exits with an empty direction or a dangling target room", () => {
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ exits: [exitEntry({ direction: "" })] })] }),
    ).toThrow(/empty direction/);
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ exits: [exitEntry({ targetRoomId: "" })] })] }),
    ).toThrow(/empty targetRoomId/);
    expect(() =>
      createContentRegistry({
        rooms: [roomEntry({ exits: [exitEntry({ targetRoomId: "room-nowhere" })] })],
      }),
    ).toThrow(/targets unknown room "room-nowhere"/);
  });

  it("validates placement lists against the loaded collections (rooms are content containers)", () => {
    // npc and monster placements both resolve.
    expect(() =>
      createContentRegistry({
        rooms: [roomEntry({ objects: [{ id: "npc-x-001", count: 1 }] })],
        npcs: [npcEntry()],
        monsters: [{ id: "mon-x-001" }],
      }),
    ).not.toThrow();
    expect(() =>
      createContentRegistry({
        rooms: [roomEntry({ objects: [{ id: "mon-x-001", count: 3 }] })],
        monsters: [{ id: "mon-x-001" }],
      }),
    ).not.toThrow();

    // Unknown entity: a dangling placement fails at load, not mid-play.
    expect(() =>
      createContentRegistry({
        rooms: [roomEntry({ objects: [{ id: "npc-nowhere", count: 1 }] })],
        npcs: [npcEntry()],
      }),
    ).toThrow(/places unknown entity "npc-nowhere"/);
    // Omitting the collection the placement references is the same dangling.
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ objects: [{ id: "npc-x-001", count: 1 }] })] }),
    ).toThrow(/places unknown entity "npc-x-001"/);
    // One row per id: the list is a map (spec/03 §2), duplicates disagree on counts.
    expect(() =>
      createContentRegistry({
        rooms: [
          roomEntry({
            objects: [
              { id: "npc-x-001", count: 1 },
              { id: "npc-x-001", count: 2 },
            ],
          }),
        ],
        npcs: [npcEntry()],
      }),
    ).toThrow(/places entity "npc-x-001" twice/);
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ objects: [{ id: "", count: 1 }] })] }),
    ).toThrow(/places an entry with an empty id/);
  });

  it("validates npc → monster references (combat numbers are referenced, never copied)", () => {
    expect(() =>
      createContentRegistry({
        npcs: [npcEntry({ monsterId: "mon-x-001" })],
        monsters: [{ id: "mon-x-001" }],
      }),
    ).not.toThrow();

    expect(() =>
      createContentRegistry({
        npcs: [npcEntry({ monsterId: "mon-nowhere" })],
        monsters: [{ id: "mon-x-001" }],
      }),
    ).toThrow(/npc "npc-x-001" references unknown monster "mon-nowhere"/);
    // A monsterId with no monsters loaded is equally dangling.
    expect(() => createContentRegistry({ npcs: [npcEntry({ monsterId: "mon-x-001" })] })).toThrow(
      /references unknown monster "mon-x-001"/,
    );
    // Non-combat npcs carry no monsterId and need no monsters.
    expect(() => createContentRegistry({ npcs: [npcEntry()] })).not.toThrow();
  });
});
