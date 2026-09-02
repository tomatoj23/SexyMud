import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../src/command/entry.js";
import { commandSetSources, commandSpecFromEntry } from "../src/command/entry.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { DimensionTable } from "../src/content/registry.js";
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

/**
 * One id space (issue #15 follow-up): entries and exits share it, so a room
 * and an exit claiming one id used to be accepted — silent, because nothing
 * mixed them into one list. `byTag` does, which turns that into a silent
 * merge of two entities into one result row. The registry now rejects it at
 * load, naming BOTH sides, because "which two things collided" is the whole
 * content of the error.
 */
describe("createContentRegistry: one id space (#15 follow-up)", () => {
  it("跨集合重名大声失败，报错点名两侧类型（命令 / 房间 / 出口 / 人物 / 怪物）", () => {
    // Commands load first, so the command is the first taker of the id.
    expect(() =>
      createContentRegistry({
        commands: [entry({ id: "x-shared" })],
        rooms: [roomEntry({ id: "x-shared" })],
      }),
    ).toThrow(/id "x-shared" is claimed by both "command" and "room"/);

    expect(() =>
      createContentRegistry({
        commands: [entry({ id: "x-shared" })],
        rooms: [roomEntry({ exits: [exitEntry({ id: "x-shared" })] })],
      }),
    ).toThrow(/id "x-shared" is claimed by both "command" and "exit"/);

    expect(() =>
      createContentRegistry({
        rooms: [roomEntry({ id: "x-shared", exits: [exitEntry({ id: "x-shared" })] })],
      }),
    ).toThrow(/id "x-shared" is claimed by both "room" and "exit"/);

    expect(() =>
      createContentRegistry({
        npcs: [npcEntry({ id: "x-shared" })],
        monsters: [{ id: "x-shared" }],
      }),
    ).toThrow(/id "x-shared" is claimed by both "npc" and "monster"/);
  });

  it("同集合重名仍是原来那句（跨集合那条没把同集合的文案带偏）", () => {
    expect(() =>
      createContentRegistry({ commands: [entry({ id: "cmd-a" }), entry({ id: "cmd-a" })] }),
    ).toThrow(/duplicate command id "cmd-a"/);
    // Two rooms claiming one id: still a duplicate, not a "claimed by both".
    expect(() => createContentRegistry({ rooms: [roomEntry(), roomEntry()] })).toThrow(
      /duplicate room id "room-x-001"/,
    );
  });

  it("一个 id 被两个不同集合声明时，抛错先于任何引用完整性检查（输入顺序无关）", () => {
    // The exit's target room is missing too — the id clash is reported, not
    // whichever check happens to run first.
    expect(() =>
      createContentRegistry({
        rooms: [
          roomEntry({ id: "x-shared", exits: [exitEntry({ id: "x-shared", targetRoomId: "room-nowhere" })] }),
        ],
      }),
    ).toThrow(/is claimed by both "room" and "exit"/);
  });
});

/** A synthetic dimensions table (ADR-0029 §5): dimension → closed key set. */
const dimensions: DimensionTable = {
  zone: ["town", "wild"],
  elementTag: ["fire", "water"],
};

/**
 * The (dimension, key) inverted index (issue #15; spec/03 §5.1, ADR-0029 §2/§5).
 *
 * Seam: createContentRegistry, driven by synthetic entries (the same
 * factories the rest of this file uses). Two things decided up front shape
 * every case here: the index covers ENTITIES — the four collections' entries
 * AND exits, whose ids share one id space (decided 2026-09-02 on #15) — and
 * `flags` never reaches it. The real content pack declares no tags yet; the
 * mini pack's own dimensions table is #19's work.
 */
describe("createContentRegistry: byTag (issue #15)", () => {
  it("跨集合查询：房间与怪物带同一标签，结果合并且 id 升序", () => {
    const registry = createContentRegistry(
      {
        rooms: [
          roomEntry({ id: "room-x-002", tags: { zone: ["town"] } }),
          roomEntry({ tags: { zone: ["town"] } }),
        ],
        monsters: [{ id: "mon-x-001", tags: { zone: ["town"] } }],
      },
      { dimensions },
    );
    expect(registry.byTag("zone", "town")).toEqual(["mon-x-001", "room-x-001", "room-x-002"]);
  });

  it("出口进索引：出口 id 与条目 id 同空间，混排后仍是 id 升序", () => {
    const registry = createContentRegistry(
      {
        rooms: [
          roomEntry({
            id: "room-x-002",
            tags: { zone: ["town"] },
            exits: [
              exitEntry({ id: "exit-x-002-south", targetRoomId: "room-x-001", tags: { zone: ["town"] } }),
            ],
          }),
          roomEntry(),
        ],
      },
      { dimensions },
    );
    expect(registry.byTag("zone", "town")).toEqual(["exit-x-002-south", "room-x-002"]);
  });

  it("四个集合的条目都进索引（命令 / 房间 / 人物 / 怪物）", () => {
    const registry = createContentRegistry(
      {
        commands: [entry({ id: "cmd-tagged", tags: { zone: ["wild"] } })],
        rooms: [roomEntry({ tags: { zone: ["wild"] } })],
        npcs: [npcEntry({ tags: { zone: ["wild"] } })],
        monsters: [{ id: "mon-x-001", tags: { zone: ["wild"] } }],
      },
      { dimensions },
    );
    expect(registry.byTag("zone", "wild")).toEqual([
      "cmd-tagged",
      "mon-x-001",
      "npc-x-001",
      "room-x-001",
    ]);
  });

  it("一维度多键、一键多维度各自独立命中", () => {
    const registry = createContentRegistry(
      {
        rooms: [
          roomEntry({
            id: "room-x-001",
            tags: { zone: ["town", "wild"], elementTag: ["fire"] },
          }),
          roomEntry({ id: "room-x-002", tags: { elementTag: ["fire"] } }),
        ],
      },
      { dimensions },
    );
    expect(registry.byTag("zone", "town")).toEqual(["room-x-001"]);
    expect(registry.byTag("zone", "wild")).toEqual(["room-x-001"]);
    expect(registry.byTag("elementTag", "fire")).toEqual(["room-x-001", "room-x-002"]);
  });

  it("不带 tags 的实体不出现在任何查询结果里", () => {
    const registry = createContentRegistry(
      { rooms: [roomEntry(), roomEntry({ id: "room-x-002" })] },
      { dimensions },
    );
    for (const dimension of Object.keys(dimensions)) {
      for (const key of dimensions[dimension] ?? []) {
        expect(registry.byTag(dimension, key)).toEqual([]);
      }
    }
  });

  it("flags 不进索引 —— 拿 flag 的值去问 byTag，任何维度都问不到（ADR-0029 §4）", () => {
    const registry = createContentRegistry(
      {
        rooms: [
          roomEntry({ id: "room-flagged", flags: ["quest"], tags: { zone: ["town"] } }),
          roomEntry({
            exits: [exitEntry({ id: "exit-flagged", flags: ["lit"], tags: { zone: ["town"] } })],
          }),
        ],
      },
      { dimensions },
    );
    for (const dimension of Object.keys(dimensions)) {
      expect(registry.byTag(dimension, "quest")).toEqual([]);
      expect(registry.byTag(dimension, "lit")).toEqual([]);
    }
    // The same two DO come back through their tags — the emptiness above is
    // about flags being unindexed, not about the entity never being indexed.
    expect(registry.byTag("zone", "town")).toEqual(["exit-flagged", "room-flagged"]);
  });

  it("未知维度与越界键 → 大声失败（拿到维度表才校验）", () => {
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ tags: { zone: ["town"] } })] }, { dimensions: {} }),
    ).toThrow(/entity "room-x-001" tags unknown dimension "zone"/);
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ tags: { zone: ["nowhere"] } })] }, { dimensions }),
    ).toThrow(/entity "room-x-001" tags key "nowhere" outside dimension "zone"/);
  });

  it("维度校验覆盖出口 —— 出口不是绕过维度表的后门", () => {
    expect(() =>
      createContentRegistry(
        { rooms: [roomEntry({ exits: [exitEntry({ tags: { zone: ["nowhere"] } })] })] },
        { dimensions },
      ),
    ).toThrow(/entity "exit-x-001-north" tags key "nowhere" outside dimension "zone"/);
  });

  it("没传维度表 → 不校验取值，但 byTag 照常工作（ADR-0029 §5）", () => {
    const registry = createContentRegistry({
      rooms: [roomEntry({ tags: { whatever: ["anything"] } })],
    });
    expect(registry.byTag("whatever", "anything")).toEqual(["room-x-001"]);
  });

  it("byTag 不依赖维度表：未知的 (维度, 键) 返回空数组而不是抛错", () => {
    const registry = createContentRegistry(
      { rooms: [roomEntry({ tags: { zone: ["town"] } })] },
      { dimensions },
    );
    expect(registry.byTag("zone", "nope")).toEqual([]);
    expect(registry.byTag("nope", "town")).toEqual([]);
  });

  it("确定性：装载顺序不同 → 查询结果相同", () => {
    const commands = [
      entry({ id: "cmd-b", tags: { zone: ["town"] } }),
      entry({ id: "cmd-a", tags: { zone: ["town"] } }),
    ];
    const rooms = [
      roomEntry({
        id: "room-x-003",
        tags: { zone: ["town"] },
        exits: [
          exitEntry({ id: "exit-x-003-north", targetRoomId: "room-x-001", tags: { zone: ["town"] } }),
        ],
      }),
      roomEntry({ id: "room-x-002", tags: { zone: ["town"] } }),
      roomEntry({ tags: { zone: ["town"] } }),
    ];
    const npcs = [npcEntry({ id: "npc-x-002", tags: { zone: ["town"] } }), npcEntry()];
    const monsters = [{ id: "mon-x-001", tags: { zone: ["town"] } }];

    const forward = createContentRegistry({ commands, rooms, npcs, monsters }, { dimensions });
    const backward = createContentRegistry(
      {
        commands: [...commands].reverse(),
        rooms: [...rooms].reverse(),
        npcs: [...npcs].reverse(),
        monsters: [...monsters].reverse(),
      },
      { dimensions },
    );

    expect(forward.byTag("zone", "town")).toEqual([
      "cmd-a",
      "cmd-b",
      "exit-x-003-north",
      "mon-x-001",
      "npc-x-002",
      "room-x-001",
      "room-x-002",
      "room-x-003",
    ]);
    expect(backward.byTag("zone", "town")).toEqual(forward.byTag("zone", "town"));
  });
});

/**
 * A command entry carrying `attrs` — the one field with no schema behind it
 * (ADR-0030 §7): the flattener merges it by the same law as `tags`, so its
 * only exercise is synthetic data that never passes through content:check.
 */
type CommandWithAttrs = CommandEntry & { attrs?: Record<string, unknown> };

/** A prototype: an entry that declares itself inheritable (ADR-0030 §4). */
function protoRoom(overrides: Partial<RoomEntry> = {}): RoomEntry {
  const room = roomEntry(overrides);
  return { ...room, prototypeKey: room.id };
}

/**
 * Load-time prototype flattening (issue #16; spec/03 §6.1, ADR-0030).
 *
 * Seam: createContentRegistry, driven by synthetic entries (the factories
 * above). Flattening is invisible from outside the registry, so every case
 * here asserts on what an entry looks like AFTER the registry hands it back —
 * that is the contract: nothing downstream ever sees an inheritance.
 */
describe("createContentRegistry: 原型展平 (issue #16)", () => {
  it("合并律：tags 互补合并，其余键整体替换，未声明的键从父继承", () => {
    const base = protoRoom({
      id: "room-base",
      zoneId: "zone-lq",
      tags: { zone: ["town"], elementTag: ["fire"] },
      objects: [{ id: "npc-x-001", count: 1 }],
    });
    const child = roomEntry({
      id: "room-child",
      prototypeParent: ["room-base"],
      tags: { zone: ["wild"], elementTag: ["fire", "water"] },
    });
    const registry = createContentRegistry(
      { rooms: [base, child], npcs: [npcEntry()] },
      { dimensions },
    );
    const flattened = registry.room("room-child");

    // Complementary: the parent's town and the child's wild survive together.
    expect(flattened.tags).toEqual({ zone: ["town", "wild"], elementTag: ["fire", "water"] });
    // Every other key: not a union. Undeclared → inherited wholesale...
    expect(flattened.zoneId).toBe("zone-lq");
    expect(flattened.objects).toEqual([{ id: "npc-x-001", count: 1 }]);
    // ...and declared → the child's own value, which is the factory default.
    expect(flattened.name).toBe("耳房");
    expect(flattened.description).toBe("一间堆着杂物的耳房。");
  });

  it("整体替换不是并集：子声明了数组键就整条换掉（放置清单、动词）", () => {
    const base = protoRoom({
      id: "room-base",
      objects: [{ id: "npc-x-001", count: 1 }],
    });
    const child = roomEntry({
      id: "room-child",
      prototypeParent: ["room-base"],
      objects: [{ id: "mon-x-001", count: 2 }],
    });
    const registry = createContentRegistry({
      rooms: [base, child],
      npcs: [npcEntry()],
      monsters: [{ id: "mon-x-001" }],
    });
    // Not [{npc...},{mon...}]: a placement list is replaced, never unioned.
    expect(registry.room("room-child").objects).toEqual([{ id: "mon-x-001", count: 2 }]);

    const baseCommand = entry({ id: "cmd-base", prototypeKey: "cmd-base", verbs: ["look", "see"] });
    const childCommand = entry({ id: "cmd-child", prototypeParent: ["cmd-base"], verbs: ["see"] });
    const commands = createContentRegistry({ commands: [baseCommand, childCommand] });
    expect(commands.command("cmd-child").verbs).toEqual(["see"]);
  });

  it("多亲优先级：左→右递增，最右父赢；自身声明 > 所有父", () => {
    const parents = [
      protoRoom({ id: "room-p1", zoneId: "zone-one" }),
      protoRoom({ id: "room-p2", zoneId: "zone-two" }),
      protoRoom({ id: "room-p3", zoneId: "zone-three" }),
    ];
    const child = roomEntry({
      id: "room-child",
      prototypeParent: ["room-p1", "room-p2", "room-p3"],
    });
    const withOwn = roomEntry({
      id: "room-own",
      prototypeParent: ["room-p1", "room-p2", "room-p3"],
      zoneId: "zone-self",
    });
    const registry = createContentRegistry({ rooms: [...parents, child, withOwn] });

    expect(registry.room("room-child").zoneId).toBe("zone-three");
    expect(registry.room("room-own").zoneId).toBe("zone-self");
  });

  it("attrs 按与 tags 同律合并：键取并集，同键高优先级赢（不进 schema，裸对象行使）", () => {
    const base: CommandWithAttrs = {
      ...entry({ id: "cmd-base", prototypeKey: "cmd-base" }),
      attrs: { hp: 10, faction: "江湖" },
    };
    const child: CommandWithAttrs = {
      ...entry({ id: "cmd-child", prototypeParent: ["cmd-base"] }),
      attrs: { hp: 20 },
    };
    const registry = createContentRegistry({ commands: [base, child] });

    expect((registry.command("cmd-child") as CommandWithAttrs).attrs).toEqual({
      hp: 20,
      faction: "江湖",
    });
  });

  it("字典序 + 去重：合并后的键列表与装载顺序无关", () => {
    const base = protoRoom({
      id: "room-base",
      tags: { zone: ["wild", "town"], elementTag: ["fire"] },
    });
    const child = protoRoom({
      id: "room-child",
      prototypeParent: ["room-base"],
      tags: { zone: ["town", "town", "wild"], elementTag: ["water"] },
    });
    const rooms = [base, child];

    const forward = createContentRegistry({ rooms }, { dimensions });
    const backward = createContentRegistry({ rooms: [...rooms].reverse() }, { dimensions });

    // Order carries no meaning in a tag list — one canonical order, deduped.
    expect(forward.room("room-child").tags).toEqual({
      zone: ["town", "wild"],
      elementTag: ["fire", "water"],
    });
    expect(JSON.stringify(backward.rooms)).toBe(JSON.stringify(forward.rooms));
  });

  it("展平结果不含 prototypeParent；prototypeKey 只留自己声明的那个（构造性不可继承）", () => {
    const grand = protoRoom({ id: "room-grand", zoneId: "zone-lq" });
    const parent = protoRoom({ id: "room-parent", prototypeParent: ["room-grand"] });
    const child = roomEntry({ id: "room-child", prototypeParent: ["room-parent"] });
    const registry = createContentRegistry({ rooms: [grand, parent, child] });

    for (const room of registry.rooms) {
      expect(room.prototypeParent).toBeUndefined();
    }
    // parent declared one; child did not, and did not inherit parent's.
    expect(registry.room("room-parent").prototypeKey).toBe("room-parent");
    expect(registry.room("room-child").prototypeKey).toBeUndefined();
    // Inherited all the same: the key was consumed, the value came through.
    expect(registry.room("room-child").zoneId).toBe("zone-lq");
  });

  it("prototypeParent: [] 也是一条声明：展平后照样剥掉（与「没写」不同）", () => {
    const declaredEmpty = roomEntry({ id: "room-empty", prototypeParent: [] });
    const registry = createContentRegistry({ rooms: [declaredEmpty, roomEntry()] });
    // The key was declared, so it was consumed — leaving it behind would tell
    // a reader there is still inheriting left to do.
    expect("prototypeParent" in registry.room("room-empty")).toBe(false);
    expect(registry.room("room-empty").prototypeParent).toBeUndefined();
  });

  it("展平先于引用完整性：继承来的引用挂在继承者名下报错（继承者先装载）", () => {
    const base = protoRoom({ id: "room-base", objects: [{ id: "npc-nowhere", count: 1 }] });
    const child = roomEntry({ id: "room-child", prototypeParent: ["room-base"] });
    // Child first in the load order: the placement list it INHERITED is
    // reported under the child's id, which is only possible if flattening ran
    // before the check (otherwise the child would have no objects at all).
    expect(() => createContentRegistry({ rooms: [child, base] })).toThrow(
      /room "room-child" places unknown entity "npc-nowhere"/,
    );

    const npcBase = {
      ...npcEntry({ id: "npc-base" }),
      prototypeKey: "npc-base",
      monsterId: "mon-nowhere",
    };
    const npcChild = npcEntry({ id: "npc-child", prototypeParent: ["npc-base"] });
    expect(() => createContentRegistry({ npcs: [npcChild, npcBase] })).toThrow(
      /npc "npc-child" references unknown monster "mon-nowhere"/,
    );
  });

  it("引用未声明 prototypeKey 的条目当父 → 大声失败（显式声明才可被继承）", () => {
    const grand = protoRoom({ id: "room-grand" });
    const parent = roomEntry({ id: "room-parent", prototypeParent: ["room-grand"] });
    const child = roomEntry({ id: "room-child", prototypeParent: ["room-parent"] });

    expect(() => createContentRegistry({ rooms: [grand, parent, child] })).toThrow(
      /room "room-child" inherits from "room-parent", which declares no prototypeKey/,
    );
  });

  it("prototypeKey 不等于自己的 id → 大声失败（schema 表达不了，注册表兜）", () => {
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ id: "room-x-001", prototypeKey: "proto-cabin" })] }),
    ).toThrow(/room "room-x-001" declares prototypeKey "proto-cabin" instead of its own id/);
    // Checked for every entry, not just the ones a walk happens to reach.
    expect(() =>
      createContentRegistry({
        rooms: [roomEntry(), roomEntry({ id: "room-x-002", prototypeKey: "room-x-003" })],
      }),
    ).toThrow(/declares prototypeKey "room-x-003" instead of its own id/);
  });

  it("同集合内继承：父 id 只在本集合里解析，跨集合引用即未知", () => {
    expect(() =>
      createContentRegistry({
        commands: [entry({ id: "cmd-base", prototypeKey: "cmd-base" })],
        rooms: [roomEntry({ prototypeParent: ["cmd-base"] })],
      }),
    ).toThrow(/room "room-x-001" inherits from unknown room id "cmd-base"/);
    expect(() =>
      createContentRegistry({ rooms: [roomEntry({ prototypeParent: ["room-nowhere"] })] }),
    ).toThrow(/inherits from unknown room id "room-nowhere"/);
  });

  it("环：自环 / 二环 / 长环都抛错，且报错指出环", () => {
    const selfLoop = protoRoom({ id: "room-a", prototypeParent: ["room-a"] });
    expect(() => createContentRegistry({ rooms: [selfLoop] })).toThrow(
      /room prototype cycle: room-a → room-a/,
    );

    const twoCycle = [
      protoRoom({ id: "room-a", prototypeParent: ["room-b"] }),
      protoRoom({ id: "room-b", prototypeParent: ["room-a"] }),
    ];
    expect(() => createContentRegistry({ rooms: twoCycle })).toThrow(
      /room prototype cycle: room-a → room-b → room-a/,
    );

    const longCycle = [
      protoRoom({ id: "room-a", prototypeParent: ["room-b"] }),
      protoRoom({ id: "room-b", prototypeParent: ["room-c"] }),
      protoRoom({ id: "room-c", prototypeParent: ["room-a"] }),
    ];
    expect(() => createContentRegistry({ rooms: longCycle })).toThrow(
      /room prototype cycle: room-a → room-b → room-c → room-a/,
    );
  });

  it("菱形不是环：两条路径汇于同一祖先不得误报", () => {
    const diamond = [
      protoRoom({ id: "room-d", tags: { zone: ["town"] } }),
      protoRoom({ id: "room-b", prototypeParent: ["room-d"], tags: { elementTag: ["fire"] } }),
      protoRoom({ id: "room-c", prototypeParent: ["room-d"], tags: { elementTag: ["water"] } }),
      roomEntry({ id: "room-a", prototypeParent: ["room-b", "room-c"] }),
    ];
    const registry = createContentRegistry({ rooms: diamond }, { dimensions });

    // d reached by two routes: merged once, not a cycle.
    expect(registry.room("room-a").tags).toEqual({
      zone: ["town"],
      elementTag: ["fire", "water"],
    });
  });

  it("exits 是整体替换：子声明了 exits 就拿自己的，原型的出口不渗漏进来", () => {
    const base = protoRoom({
      id: "room-base",
      exits: [exitEntry({ id: "exit-base-north", targetRoomId: "room-x-002" })],
    });
    const child = roomEntry({
      id: "room-child",
      prototypeParent: ["room-base"],
      exits: [exitEntry({ id: "exit-child-east", targetRoomId: "room-x-002" })],
    });
    const registry = createContentRegistry({
      rooms: [base, child, roomEntry({ id: "room-x-002", exits: [] })],
    });

    // Not the union of two exit lists: exits is a key like any other.
    expect(registry.room("room-child").exits.map((exit) => exit.id)).toEqual(["exit-child-east"]);
    expect(() => registry.exit("exit-base-north")).not.toThrow();
  });

  it("展平先于建索引：继承来的 tags 进 byTag（把标签放进原型不是绕过索引的后门）", () => {
    const base = protoRoom({ id: "room-base", tags: { zone: ["town"] } });
    const child = roomEntry({ id: "room-child", prototypeParent: ["room-base"] });
    const merged = roomEntry({
      id: "room-merged",
      prototypeParent: ["room-base"],
      tags: { zone: ["wild"] },
    });
    const registry = createContentRegistry({ rooms: [base, child, merged] }, { dimensions });

    expect(registry.byTag("zone", "town")).toEqual(["room-base", "room-child", "room-merged"]);
    expect(registry.byTag("zone", "wild")).toEqual(["room-merged"]);
  });

  it("确定性：同一组条目以不同装载顺序喂入 → 展平结果字节相同", () => {
    const rooms = [
      protoRoom({ id: "room-base", zoneId: "zone-lq", tags: { zone: ["wild"] } }),
      protoRoom({
        id: "room-mid",
        prototypeParent: ["room-base"],
        tags: { zone: ["town"], elementTag: ["fire"] },
      }),
      roomEntry({ id: "room-leaf", prototypeParent: ["room-mid", "room-base"] }),
    ];
    const forward = createContentRegistry({ rooms }, { dimensions });
    const backward = createContentRegistry({ rooms: [...rooms].reverse() }, { dimensions });

    expect(JSON.stringify(backward.rooms)).toBe(JSON.stringify(forward.rooms));
    expect(forward.room("room-leaf").tags).toEqual({ zone: ["town", "wild"], elementTag: ["fire"] });
  });

  it("不带 prototypeParent 的条目原样穿过展平：同一个对象引用（今天的真实内容零原型）", () => {
    const rooms = [roomEntry(), roomEntry({ id: "room-x-002", tags: { zone: ["town"] } })];
    const registry = createContentRegistry({ rooms }, { dimensions });
    // A pack with no prototypes pays nothing: nothing is copied, nothing is
    // rewritten — not even a tag list reordered.
    expect(registry.room("room-x-001")).toBe(rooms[0]);
    expect(registry.room("room-x-002")).toBe(rooms[1]);
    expect(registry.byTag("zone", "town")).toEqual(["room-x-002"]);
  });
});
