import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";

/**
 * The four fields every ENTRY collection shares (issue #14; ADR-0029 §1/§3,
 * ADR-0030 §3–§4):
 *
 *   tags            { <维度>: [<键>…] }  —— 形状唯一，有维度、进倒排索引
 *   flags           [<键>…]              —— 裸布尔标记，无维度、不进索引
 *   prototypeKey    <本条目 id>          —— 显式声明「我可被继承」
 *   prototypeParent [<父条目 id>…]       —— 多亲
 *
 * Shape is what a schema can own; MEANING is not: that the keys come from
 * content/config/dimensions.json is the registry's job (#15), that
 * prototypeKey equals the entry's own id is the flattener's job (#16). This
 * suite therefore asserts the one shape on every collection — one case per
 * collection, because the whole point of the ticket is that the shape does
 * not vary between them.
 *
 * Seam: the schemas themselves, compiled with Ajv the way content:check does
 * (every schema registered up front so cross-file $refs resolve), following
 * commands-schema.test.ts / rooms-npcs-schema.test.ts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schemasDir = resolve(root, "schemas");
const dimensions = JSON.parse(
  readFileSync(resolve(root, "content/config/dimensions.json"), "utf8"),
) as Record<string, unknown>;

/** Registers every schema by $id, exactly like content:check does. */
function loadSchemas() {
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

const { ajv, parsed } = loadSchemas();
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

/** The validator for one schema file, compiled once (Ajv caches by object). */
function validateFor(schemaName: string) {
  const cached = validators.get(schemaName);
  if (cached !== undefined) return cached;
  const schema = parsed.get(schemaName);
  if (schema === undefined) throw new Error(`no such schema: ${schemaName}`);
  const validate = ajv.compile(schema);
  validators.set(schemaName, validate);
  return validate;
}

/** A minimal room — the entry the dimension-shape checks below are read on. */
function room(overrides: Record<string, unknown> = {}) {
  return {
    id: "room-x-001",
    name: "测试房间",
    description: "一间四壁徒然的房间。",
    enterText: "你走进房间。",
    exits: [],
    ...overrides,
  };
}

/** A minimal exit — command-shaped (spec/02 §4), hence an entity. */
function exit(overrides: Record<string, unknown> = {}) {
  return {
    id: "exit-x-001-north",
    direction: "北",
    targetRoomId: "room-x-002",
    verbs: ["北", "north", "n"],
    argForm: "none",
    cmdset: "exits",
    priority: 101,
    ...overrides,
  };
}

/** An equipment affix: its tags are REQUIRED, so it carries them always. */
function affix(overrides: Record<string, unknown> = {}) {
  return {
    id: "affix-x-strength",
    kind: "affix",
    name: "力量",
    tags: { moveTag: ["strength"] },
    tiers: [{ tier: 1, modifiers: [] }],
    ...overrides,
  };
}

/** An equipment base (底材). */
function base(overrides: Record<string, unknown> = {}) {
  return {
    id: "base-x-sword",
    kind: "base",
    name: "铁剑",
    slot: "weapon",
    floorRange: { min: 1, max: 2 },
    tierRange: { min: 1, max: 3 },
    ...overrides,
  };
}

interface EntryFixture {
  /** The content/ collection (and the schema file name is derived from it). */
  collection: string;
  /** The oneOf branch, for schemas that carry more than one entry kind. */
  variant?: string;
  /** A minimal, valid entry of this collection. */
  entry: () => Record<string, unknown>;
}

/**
 * Every ENTRY collection in schemas/, enumerated from the directory rather
 * than from memory: 14 collections as of this ticket (the ticket's "13" came
 * from the design interview — the coverage test at the bottom pins the real
 * list). config 三类（dimensions / display-tiers / settings）与两个被引用库
 *（condition、common）不是条目集合，故不在此列。
 */
const ENTRY_FIXTURES: EntryFixture[] = [
  {
    collection: "beast",
    entry: () => ({ id: "bst-x-bee", name: "毒蜂", slot: "beast", element: "wood" }),
  },
  {
    collection: "combat-text",
    variant: "模板",
    entry: () => ({ id: "tpl-x-001", kind: "template", segments: ["甲", "乙", "丙"] }),
  },
  {
    collection: "combat-text",
    variant: "词库",
    entry: () => ({ id: "pool-x-001", kind: "verb", text: "劈", dims: { motion: "chop" } }),
  },
  {
    collection: "commands",
    entry: () => ({
      id: "cmd-x-look",
      verbs: ["看"],
      argForm: "none",
      cmdset: "character",
      priority: 0,
    }),
  },
  {
    collection: "dungeon",
    entry: () => ({
      id: "dun-x-001",
      name: "测试秘境",
      floors: [
        {
          id: "dun-x-001-f01",
          index: 1,
          guards: { mode: "fixed" },
          respawn: { baseTicks: 10 },
          maxConcurrent: 12,
        },
      ],
    }),
  },
  {
    collection: "effects",
    entry: () => ({ id: "eff-x-001", primitives: [{ type: "damage" }] }),
  },
  { collection: "equipment", variant: "底材", entry: () => base() },
  { collection: "equipment", variant: "词缀", entry: () => affix() },
  { collection: "event", entry: () => ({ id: "evt-x-001", text: "你遇见一位老者。" }) },
  { collection: "herb", entry: () => ({ id: "herb-x-001", name: "七叶灵芝" }) },
  {
    collection: "martial",
    entry: () => ({ id: "mrt-x-001", kind: "招式", name: "白虹贯日", tier: 1, effects: ["eff-x-001"] }),
  },
  {
    collection: "monster",
    entry: () => ({ id: "mon-x-001", name: "黑衣人", stats: { maxHp: 10 } }),
  },
  {
    collection: "npcs",
    entry: () => ({ id: "npc-x-001", name: "店小二", description: "一个抹桌子的店小二。" }),
  },
  {
    collection: "pill",
    variant: "丹方",
    entry: () => ({
      id: "pill-recipe-x",
      kind: "recipe",
      name: "小还丹方",
      inputs: [{ herbId: "herb-x-001", amount: 1 }],
      output: "pill-x",
    }),
  },
  {
    collection: "pill",
    variant: "丹药",
    entry: () => ({ id: "pill-x", kind: "medicine", name: "小还丹" }),
  },
  { collection: "rooms", entry: () => room() },
  { collection: "sect", entry: () => ({ id: "sect-x-001", name: "测试门派" }) },
];

/** The four fields, fully declared — every collection must accept this. */
const DECLARED = {
  tags: { moveTag: ["sword"], elementTag: ["fire"] },
  flags: ["quest"],
  prototypeKey: "x-proto",
  prototypeParent: ["x-proto-parent"],
};

for (const fixture of ENTRY_FIXTURES) {
  const label = fixture.variant === undefined
    ? fixture.collection
    : `${fixture.collection}（${fixture.variant}）`;
  const validate = () => validateFor(`${fixture.collection}.schema.json`);

  describe(`${label} 条目：四个通用字段`, () => {
    it("不声明通用字段时照过（既有内容一个 tags 都没写，必须全部通过）", () => {
      // equipment 词缀的 tags 是它自己的必填字段（M3 之前即是），故该 fixture
      // 自带 tags——这里断言的是「不额外声明也照过」，不是「tags 可省略」。
      expect(validate()(fixture.entry())).toBe(true);
    });

    it("四个字段都可声明：tags / flags / prototypeKey / prototypeParent", () => {
      expect(validate()({ ...fixture.entry(), ...DECLARED })).toBe(true);
    });

    it("标签形状唯一：对象形态，值是非空字符串数组", () => {
      // The whole point of the ticket: there is ONE tag shape. A bare
      // string[] was equipment's lone outlier and must be rejected here too.
      expect(validate()({ ...fixture.entry(), tags: ["quest"] })).toBe(false);
      expect(validate()({ ...fixture.entry(), tags: { moveTag: "sword" } })).toBe(false);
      expect(validate()({ ...fixture.entry(), tags: { moveTag: [1] } })).toBe(false);
      expect(validate()({ ...fixture.entry(), tags: { moveTag: [""] } })).toBe(false);
      // 规范形态（ADR-0030 §6）：合并后的键列表升序且去重，故重复键不是合法输入。
      expect(validate()({ ...fixture.entry(), tags: { moveTag: ["sword", "sword"] } })).toBe(false);
      // 一个维度挂多个键是形状的本意。
      expect(validate()({ ...fixture.entry(), tags: { moveTag: ["sword", "thrust"] } })).toBe(true);
    });

    it("flags 是裸字符串数组；prototypeKey 是字符串；prototypeParent 是字符串数组", () => {
      // flags: 无维度、不进索引（ADR-0029 §3）——裸键列表，不是对象。
      expect(validate()({ ...fixture.entry(), flags: ["quest", "no-drop"] })).toBe(true);
      expect(validate()({ ...fixture.entry(), flags: "quest" })).toBe(false);
      expect(validate()({ ...fixture.entry(), flags: { quest: true } })).toBe(false);
      expect(validate()({ ...fixture.entry(), flags: [1] })).toBe(false);
      expect(validate()({ ...fixture.entry(), flags: [""] })).toBe(false);
      expect(validate()({ ...fixture.entry(), flags: ["quest", "quest"] })).toBe(false);

      // prototypeKey: 值 = 条目 id，但「等于」是注册表的事（#16）；schema 只管它是字符串。
      expect(validate()({ ...fixture.entry(), prototypeKey: "x-proto" })).toBe(true);
      expect(validate()({ ...fixture.entry(), prototypeKey: "" })).toBe(false);
      expect(validate()({ ...fixture.entry(), prototypeKey: 1 })).toBe(false);

      // prototypeParent: 多亲，故是数组。
      expect(validate()({ ...fixture.entry(), prototypeParent: ["a", "b"] })).toBe(true);
      expect(validate()({ ...fixture.entry(), prototypeParent: "a" })).toBe(false);
      expect(validate()({ ...fixture.entry(), prototypeParent: [1] })).toBe(false);
      expect(validate()({ ...fixture.entry(), prototypeParent: [""] })).toBe(false);
    });
  });
}

describe("实体层边界：出口带四字段，放置清单项一个都不带", () => {
  const validate = () => validateFor("rooms.schema.json");
  /** One legal sample per field, reused to probe where they are accepted. */
  const SAMPLES: Record<string, unknown> = {
    tags: { moveTag: ["sword"] },
    flags: ["quest"],
    prototypeKey: "x-proto",
    prototypeParent: ["x-proto-parent"],
  };

  it("出口是命令实体（ExitEntry extends CommandEntry），四字段都可声明", () => {
    // 类型与 schema 必须一致（三处同步）：出口既继承命令形态，就继承这四个字段。
    for (const [field, sample] of Object.entries(SAMPLES)) {
      expect(validate()(room({ exits: [exit({ [field]: sample })] })), field).toBe(true);
    }
    // 形状规则对出口同样生效——裸 string[] 不是标签形态。
    expect(validate()(room({ exits: [exit({ tags: ["quest"] })] }))).toBe(false);
  });

  it("放置清单项不是实体：四字段一个都不收", () => {
    for (const [field, sample] of Object.entries(SAMPLES)) {
      expect(
        validate()(room({ objects: [{ id: "npc-x-001", count: 1, [field]: sample }] })),
        field,
      ).toBe(false);
    }
  });
});

describe("维度名的形状（schema 只管形状，成员合法性归注册表 #15）", () => {
  const validate = () => validateFor("rooms.schema.json");

  it("维度表里每一个真实维度名都写得进 tags", () => {
    // The shape rule must not accidentally exclude a legal dimension: the
    // names below come from the real table, not from this test's imagination.
    for (const dimension of Object.keys(dimensions)) {
      expect(validate()(room({ tags: { [dimension]: ["x"] } })), dimension).toBe(true);
    }
  });

  it("不像维度名的键被拒（维度名是 lowerCamelCase，照 config.dimensions.schema.json）", () => {
    for (const dimension of ["move-tag", "MoveTag", "1tag", "move tag", "move_tag"]) {
      expect(validate()(room({ tags: { [dimension]: ["x"] } })), dimension).toBe(false);
    }
  });

  it("形状合法但不在维度表里的维度，schema 放行——取值封闭是注册表的活", () => {
    // ADR-0029 §5: schema 不写死枚举（ADR-0004 扩展留白），维度表由主机传给
    // 注册表、传了才硬校验。这里断言的是边界本身：形状归 schema，取值归注册表。
    expect(validate()(room({ tags: { notADimension: ["x"] } }))).toBe(true);
  });
});

describe("equipment 词缀：string[] 孤例改齐（ADR-0029 §1）", () => {
  const validate = () => validateFor("equipment.schema.json");

  it("旧形态被拒、新形态通过", () => {
    expect(validate()(affix({ tags: ["sword"] }))).toBe(false);
    expect(validate()(affix({ tags: { moveTag: ["sword"] } }))).toBe(true);
  });

  it("tags 对词缀是必填（底材靠 preferredTags 表达偏好，不是靠自己的 tags）", () => {
    const { tags: _omitted, ...withoutTags } = affix();
    expect(validate()(withoutTags)).toBe(false);
  });

  it("底材的 preferredTags 仍是裸键列表（本次不动，见 #14 收尾说明）", () => {
    expect(validate()(base({ preferredTags: ["sword", "fire"] }))).toBe(true);
    expect(validate()(base({ preferredTags: { moveTag: ["sword"] } }))).toBe(false);
  });
});

describe("覆盖面：schemas/ 下的条目集合一个不漏", () => {
  it("只有 config 三类与两个被引用库不在条目集合之列", () => {
    // Derived from the directory, so adding a schema file forces a decision
    // here instead of letting a collection quietly go without the contract.
    const onDisk = readdirSync(schemasDir).filter((name) => name.endsWith(".schema.json")).sort();
    const covered = new Set(ENTRY_FIXTURES.map((fixture) => `${fixture.collection}.schema.json`));
    expect(onDisk.filter((name) => !covered.has(name))).toEqual([
      "common.schema.json",
      "condition.schema.json",
      "config.dimensions.schema.json",
      "config.display-tiers.schema.json",
      "config.settings.schema.json",
    ]);
  });
});
