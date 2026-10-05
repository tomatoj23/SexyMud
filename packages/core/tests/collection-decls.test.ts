import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../src/command/entry.js";
import type { AccessRules } from "../src/conditions.js";
import type { EntryCommon, TagMap } from "../src/content/entry.js";
import type { CollectionDecl, ContentRegistry, DimensionTable } from "../src/content/registry.js";
import { COLLECTIONS, buildContentRegistry, createContentRegistry } from "../src/content/registry.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../src/world/entry.js";

/**
 * Collections as a first-class concept (issue #39, C5): the declaration
 * table drives the assembly pipeline's per-collection obligations, so a NEW
 * collection wires itself in by declaring itself — nothing else.
 *
 * This file IS that claim, twice over. The drill below adds a synthetic
 * `quests` collection to the REAL build carrying exactly the three artifacts
 * a new collection needs inside registry.ts:
 *
 *   ① one declaration row   — `QUESTS` below
 *   ② the typed getter pair — `WithQuests` below (the interface side; the
 *      runtime surface is generated from the row)
 *   ③ the entry type        — `QuestEntry` below
 *
 * and then pins that every assembly obligation lights up untouched: the one
 * id space, prototype flattening, the placeable union, the entity feed (tags
 * reach `byTag`), sorted exposure, the getter surface — plus the closing deep
 * freeze. The second half pins the freeze itself (D3): "loaded content is
 * immutable" went from hand-kept convention to machine-kept fact.
 */

/** A synthetic command matching the command entry shape (spec/02 §3). */
function commandEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: "cmd-probe",
    verbs: ["probe"],
    argForm: "none",
    cmdset: "character",
    priority: 0,
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

/** A synthetic exit matching the exit entity shape (spec/02 §4). */
function exitEntry(overrides: Partial<ExitEntry> = {}): ExitEntry {
  return {
    id: "exit-x-001-north",
    direction: "北",
    targetRoomId: "room-x-002",
    verbs: ["北"],
    argForm: "none",
    cmdset: "exits",
    priority: 101,
    ...overrides,
  };
}

/** A synthetic dimensions table (ADR-0029 §5): dimension → closed key set. */
const dimensions: DimensionTable = { zone: ["town", "wild"] };

/** ③ 条目类型一处 — the fake collection's entry type (gates included: an entry is an entry). */
interface QuestEntry extends EntryCommon {
  readonly id: string;
  readonly name: string;
  readonly preconditions?: AccessRules;
}

/** ① 声明一行 — the fake collection's declaration row (the whole edit). */
const QUESTS: CollectionDecl = {
  what: "quest",
  flatten: true,
  placeable: true,
  expose: "quests",
};

/**
 * A second synthetic row for the negative halves: NOT flattened, NOT
 * placeable — the row's flags must bite both ways, not just open doors.
 */
const NOTES: CollectionDecl = {
  what: "note",
  flatten: false,
  placeable: false,
  expose: "notes",
};

/** ② typed getter 两行 — the typed pair a new collection adds (thin sugar). */
type WithQuests = ContentRegistry & {
  readonly quests: readonly QuestEntry[];
  quest(id: string): QuestEntry;
};

/** The real build, plus the sixth row — the drill's only registry-side lever. */
function buildWithQuests(
  content: Readonly<Record<string, readonly (EntryCommon & { id: string })[] | undefined>>,
  options?: Parameters<typeof buildContentRegistry>[2],
): WithQuests {
  return buildContentRegistry([...COLLECTIONS, QUESTS], content, options) as WithQuests;
}

function questEntry(overrides: Partial<QuestEntry> = {}): QuestEntry {
  return { id: "quest-x-001", name: "寻剑", ...overrides };
}

describe("新增集合演练（issue #39 AC1：声明一行即接通，六义务零手改）", () => {
  it("义务 1：id 空间——假集合进同一个空间，撞名点名两侧、同集合照旧", () => {
    expect(() =>
      buildWithQuests({
        commands: [commandEntry({ id: "x-shared" })],
        quests: [questEntry({ id: "x-shared" })],
      }),
    ).toThrow(/id "x-shared" is claimed by both "command" and "quest"/);
    expect(() =>
      buildWithQuests({ quests: [questEntry({ id: "q-a" }), questEntry({ id: "q-a" })] }),
    ).toThrow(/duplicate quest id "q-a"/);
    expect(() => buildWithQuests({ quests: [questEntry({ id: "" })] })).toThrow(
      /quest entry with an empty id/,
    );
  });

  it("义务 2：展平——假集合照常同集合继承（tags 互补合并、prototypeParent 剥掉）", () => {
    const registry = buildWithQuests(
      {
        quests: [
          { ...questEntry({ id: "q-base", tags: { zone: ["town"] } }), prototypeKey: "q-base" },
          questEntry({ id: "q-child", prototypeParent: ["q-base"], tags: { zone: ["wild"] } }),
        ],
      },
      { dimensions },
    );

    expect(registry.quest("q-child").tags).toEqual({ zone: ["town", "wild"] });
    expect(registry.quest("q-child").prototypeParent).toBeUndefined();
  });

  it("义务 3：placeable 并集——房间放置假集合 id 自动解析，未知照旧大声失败", () => {
    const wired = buildWithQuests({
      rooms: [roomEntry({ objects: [{ id: "q-a", count: 1 }] })],
      quests: [questEntry({ id: "q-a" })],
    });
    expect(wired.room("room-x-001").objects).toEqual([{ id: "q-a", count: 1 }]);

    expect(() =>
      buildWithQuests({
        rooms: [roomEntry({ objects: [{ id: "q-nowhere", count: 1 }] })],
        quests: [questEntry({ id: "q-a" })],
      }),
    ).toThrow(/places unknown entity "q-nowhere"/);
  });

  it("义务 3 的反面：placeable: false 的行不进并集——放它＝未知实体", () => {
    expect(() =>
      buildContentRegistry([...COLLECTIONS, NOTES], {
        rooms: [roomEntry({ objects: [{ id: "n-a", count: 1 }] })],
        notes: [{ id: "n-a" }],
      }),
    ).toThrow(/places unknown entity "n-a"/);
  });

  it("义务 4：entities 喂表——假集合 tags 自动进 byTag，维度封闭同律生效", () => {
    const registry = buildWithQuests(
      {
        quests: [
          questEntry({ id: "q-b", tags: { zone: ["town"] } }),
          questEntry({ id: "q-a", tags: { zone: ["town"] } }),
        ],
        rooms: [roomEntry({ tags: { zone: ["town"] } })],
      },
      { dimensions },
    );
    expect(registry.byTag("zone", "town")).toEqual(["q-a", "q-b", "room-x-001"]);

    expect(() =>
      buildWithQuests({ quests: [questEntry({ tags: { zone: ["nowhere"] } })] }, { dimensions }),
    ).toThrow(/tags key "nowhere" outside dimension "zone"/);

    // The SAME feed closes the gate vocabulary (one feed, both closures):
    // a typo'd `has_tag` dimension on the fake collection fails at load.
    const gated: QuestEntry = {
      ...questEntry({ id: "q-gate" }),
      preconditions: { default: false, use: { has_tag: ["znou", "town"] } },
    };
    expect(() => buildWithQuests({ quests: [gated] }, { dimensions })).toThrow(
      /has_tag references unknown dimension "znou"/,
    );
  });

  it("义务 5：排序曝光——假集合 plural id 升序、与装载顺序无关", () => {
    const quests = [questEntry({ id: "q-c" }), questEntry({ id: "q-a" }), questEntry({ id: "q-b" })];
    const forward = buildWithQuests({ quests });
    const backward = buildWithQuests({ quests: [...quests].reverse() });
    expect(forward.quests.map((quest) => quest.id)).toEqual(["q-a", "q-b", "q-c"]);
    expect(backward.quests.map((quest) => quest.id)).toEqual(forward.quests.map((quest) => quest.id));
  });

  it("义务 6：getter 委托面——单查随行生成、未知 id 大声失败", () => {
    const registry = buildWithQuests({ quests: [questEntry({ id: "q-a", name: "寻刀" })] });
    expect(registry.quest("q-a").name).toBe("寻刀");
    expect(() => registry.quest("q-nope")).toThrow(/unknown quest id "q-nope"/);
  });

  it("深冻结随表通（D3）：假集合条目 build 后不可写，零手改", () => {
    const registry = buildWithQuests({ quests: [questEntry({ id: "q-a" })] });
    expect(() => {
      (registry.quest("q-a") as unknown as { name: string }).name = "改写";
    }).toThrow(TypeError);
  });

  it("缝契约：表可增行、不可缺行——引擎五路必须在表里（exits 由 build 自己派生）", () => {
    for (const row of COLLECTIONS) {
      expect(
        () => buildContentRegistry(COLLECTIONS.filter((candidate) => candidate !== row), {}),
        `missing ${row.what}`,
      ).toThrow(new RegExp(`table is missing collection "${row.what}"`));
    }
  });

  it("声明卫生：成员名空名/撞手写成员/撞他行当场失败；`__proto__` 之名不蒸发（/fh）", () => {
    // `what`/`expose` BECOME member names — a collision would silently
    // overwrite (or lose) a member of the read surface.
    expect(() =>
      buildContentRegistry(
        [...COLLECTIONS, { what: "byTag", flatten: true, placeable: false, expose: "notes" }],
        {},
      ),
    ).toThrow(/collides with a hand-written member/);
    expect(() =>
      buildContentRegistry(
        [...COLLECTIONS, QUESTS, { what: "note", flatten: true, placeable: false, expose: "quests" }],
        {},
      ),
    ).toThrow(/collides with another collection's member/);
    expect(() =>
      buildContentRegistry([...COLLECTIONS, { what: "", flatten: true, placeable: false, expose: "notes" }], {}),
    ).toThrow(/declares an empty what/);
    // `__proto__` is an ordinary member name on the generated face (null
    // prototype): it must land as a member, not vanish into Object.prototype
    // — and the input lookup must read the OWN key, not the inherited
    // Object.prototype value a plain content object carries for that name.
    const protoRow: CollectionDecl = {
      what: "proto",
      flatten: true,
      placeable: false,
      expose: "__proto__",
    };
    const face = buildContentRegistry([...COLLECTIONS, protoRow], {
      ["__proto__"]: [{ id: "p-1" }],
    }) as unknown as Record<string, unknown>;
    const plural = face["__proto__"] as readonly { id: string }[];
    expect(plural.map((entry) => entry.id)).toEqual(["p-1"]);
    // …and with NO input for that name the lookup must see "absent": the
    // inherited Object.prototype value there is not a collection's entries.
    const empty = buildContentRegistry([...COLLECTIONS, protoRow], {}) as unknown as Record<
      string,
      unknown
    >;
    expect((empty["__proto__"] as readonly unknown[]).length).toBe(0);
  });

  it("结构钉：五路全进表；exits 行的义务只有 id 空间＋entities 喂表（不展平、无 getter 对）", () => {
    expect(
      COLLECTIONS.map((row) => [row.what, row.flatten, row.placeable, row.expose]),
    ).toEqual([
      ["command", true, false, "commands"],
      ["room", true, false, "rooms"],
      ["npc", true, true, "npcs"],
      ["monster", true, true, "monsters"],
      ["exit", false, false, null],
    ]);
  });
});

describe("build 末尾深冻结（issue #39 AC3：honor system 收口）", () => {
  function worldRegistry(): ContentRegistry {
    return createContentRegistry(
      {
        npcs: [npcEntry()],
        rooms: [
          roomEntry({
            tags: { zone: ["town"] },
            objects: [{ id: "npc-x-001", count: 1 }],
            exits: [exitEntry()],
          }),
          roomEntry({ id: "room-x-002", name: "堂屋", description: "一间堂屋。", enterText: "你进了堂屋。" }),
        ],
      },
      { dimensions },
    );
  }

  it("写条目当场失败——顶层与嵌套（tags／exits／放置清单）都冻", () => {
    const registry = worldRegistry();

    // Precision first: every surface written below exists and IS frozen —
    // the throws are about frozen-ness, not about a missing shape.
    expect(Object.isFrozen(registry.room("room-x-001"))).toBe(true);
    expect(Object.isFrozen(registry.room("room-x-001").tags)).toBe(true);
    expect(Object.isFrozen(registry.room("room-x-001").exits)).toBe(true);
    expect(Object.isFrozen(registry.exit("exit-x-001-north"))).toBe(true);

    // A top-level field: the entry object itself is frozen.
    expect(() => {
      (registry.room("room-x-001") as unknown as { name: string }).name = "改写";
    }).toThrow(TypeError);
    // Nested graphs freeze with it — tags is the one that used to fork
    // `byTag` from `tagsOf` silently.
    expect(() => {
      (registry.room("room-x-001").tags as TagMap as { zone: string[] }).zone = ["wild"];
    }).toThrow(TypeError);
    expect(() => {
      (registry.room("room-x-001").exits as unknown as unknown[]).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (registry.room("room-x-001").objects as unknown as unknown[]).length = 0;
    }).toThrow(TypeError);
    // An exit is an entity like any other: `exit(id)` hands out a frozen one.
    expect(() => {
      (registry.exit("exit-x-001-north") as unknown as { direction: string }).direction = "南";
    }).toThrow(TypeError);
  });

  it("tagsOf 的答案冻结；未知 id 的空 map 照旧冻结（NO_TAGS 同律）", () => {
    const registry = worldRegistry();
    expect(Object.isFrozen(registry.tagsOf("room-x-001"))).toBe(true);
    expect(Object.isFrozen(registry.tagsOf("no-such-id"))).toBe(true);
  });

  it("注册表交出的答案数组同律冻结——plural 曝光与 byTag 桶都不可写", () => {
    const registry = worldRegistry();
    // Pushing into the plural would fork it from `room(id)` silently; the
    // array is the registry's answer, so it freezes with the entries in it.
    expect(() => {
      (registry.rooms as unknown as unknown[]).push(roomEntry({ id: "room-forged" }));
    }).toThrow(TypeError);
    expect(() => {
      (registry.byTag("zone", "town") as unknown as unknown[]).push("forged-id");
    }).toThrow(TypeError);
    // The empty answer is frozen too — NO_TAGS' exact dual on the byTag side.
    expect(Object.isFrozen(registry.byTag("zone", "nope"))).toBe(true);
  });

  it("宿主浅冻的条目照样被深冻——外冻内不冻＝分叉后门（/fh 探针钉）", () => {
    // A host that froze its own entries before handing them over must not
    // keep a mutable graph inside a frozen shell: `tags` would fork from
    // `byTag` exactly the way D3 exists to prevent.
    const room = roomEntry({ tags: { zone: ["town"] } });
    Object.freeze(room);
    const registry = createContentRegistry({ rooms: [room] }, { dimensions });
    expect(Object.isFrozen(registry.room("room-x-001").tags)).toBe(true);
    expect(() => {
      (registry.room("room-x-001").tags as TagMap as { zone: string[] }).zone = ["wild"];
    }).toThrow(TypeError);
  });
});
