import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";

/**
 * schemas/rooms.schema.json and schemas/npcs.schema.json (spec/03 §1–§4,
 * issue #6): the world as content — rooms carrying the four elements, exits
 * as independent command-shaped entities, and npcs that REFERENCE monsters
 * instead of copying combat numbers.
 *
 * Both schemas $ref the condition library across files
 * (condition.schema.json#/definitions/accessRules) for their gates, so these
 * tests also prove those references resolve under Ajv strict mode —
 * content:check registers all schemas up front for exactly this purpose
 * (spec/06 §3).
 */

const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../schemas");
const conditionSchema = JSON.parse(readFileSync(resolve(schemasDir, "condition.schema.json"), "utf8"));
const roomsSchema = JSON.parse(readFileSync(resolve(schemasDir, "rooms.schema.json"), "utf8"));
const npcsSchema = JSON.parse(readFileSync(resolve(schemasDir, "npcs.schema.json"), "utf8"));

/** Compiles one world schema with the condition library pre-registered for $ref. */
function compile(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  ajv.addSchema(conditionSchema);
  return ajv.compile(schema);
}

/** A minimal exit matching the pack's convention (exits cmdset, +101). */
function exit(overrides: Record<string, unknown> = {}) {
  return {
    id: "exit-x-001-north",
    direction: "北",
    targetRoomId: "room-x-002",
    verbs: ["北", "north", "n", "往北走"],
    argForm: "none",
    cmdset: "exits",
    priority: 101,
    ...overrides,
  };
}

describe("rooms.schema.json (draft-07, $ref library consumer)", () => {
  const validate = compile(roomsSchema);

  const minimal = {
    id: "room-x-001",
    name: "测试房间",
    description: "一间四壁徒然的房间。",
    enterText: "你走进房间。",
    exits: [],
  };

  it("compiles under Ajv strict mode and resolves the cross-file gate $ref", () => {
    expect(typeof validate).toBe("function");
  });

  it("accepts a minimal room: four required elements, dead end declared explicitly", () => {
    expect(validate(minimal)).toBe(true);
    // The placement list and the room's own gate are optional surfaces.
    expect(validate({ ...minimal, objects: [] })).toBe(true);
    expect(
      validate({ ...minimal, preconditions: { default: true, enter: { has_flag: "key" } } }),
    ).toBe(true);
  });

  it("accepts a full room: gated exit with traverse vocabulary, refusal copy, placement, zoneId", () => {
    expect(
      validate({
        ...minimal,
        exits: [
          exit({
            preconditions: { default: true, traverse: { has_flag: "inn-lodger" } },
            err_traverse: "掌柜的拦住你：客人止步。",
          }),
        ],
        objects: [{ id: "npc-x-001", count: 2 }],
        preconditions: { default: false, enter: { has_state: "wounded" } },
        err_enter: "你伤势未愈，进不得此处。",
        zoneId: "dgn-x-001",
      }),
    ).toBe(true);
  });

  it("treats exits as command entities: verbs, cmdset membership and merge rules are data", () => {
    // Exits carry the full command shape (spec/02 §4: it registers ITSELF).
    expect(validate({ ...minimal, exits: [exit({ mergetype: "Union" })] })).toBe(true);
    // A parameterized exit is not this pack's grammar — argForm is none only.
    expect(validate({ ...minimal, exits: [exit({ argForm: "text" })] })).toBe(false);
    expect(validate({ ...minimal, exits: [exit({ argForm: "None" })] })).toBe(false);
    // Merge rules belong to the set: the four operators, nothing else.
    expect(validate({ ...minimal, exits: [exit({ mergetype: "Replace" })] })).toBe(true);
    expect(validate({ ...minimal, exits: [exit({ mergetype: "union" })] })).toBe(false);
    // Verbs ARE the command: at least one, non-empty, unique.
    expect(validate({ ...minimal, exits: [exit({ verbs: [] })] })).toBe(false);
    expect(validate({ ...minimal, exits: [exit({ verbs: ["北", "北"] })] })).toBe(false);
    // Direction is the edge's key: present and non-empty.
    expect(validate({ ...minimal, exits: [exit({ direction: "" })] })).toBe(false);
    expect(validate({ ...minimal, exits: [exit({ targetRoomId: "" })] })).toBe(false);
  });

  it("enforces the accessRules contract THROUGH the $ref on rooms and exits alike", () => {
    // default is required — an undeclared accessType must have an answer.
    expect(
      validate({ ...minimal, exits: [exit({ preconditions: { traverse: true } })] }),
    ).toBe(false);
    expect(validate({ ...minimal, preconditions: { enter: true } })).toBe(false);
    // Unknown predicates are the condition library's to reject.
    expect(
      validate({
        ...minimal,
        exits: [exit({ preconditions: { default: true, traverse: { has_money: "lots" } } })],
      }),
    ).toBe(false);
    // err_* keys are entry-level fields, not part of the gate map.
    expect(
      validate({
        ...minimal,
        exits: [exit({ preconditions: { default: true, traverse: { err_traverse: "…" } } })],
      }),
    ).toBe(false);
  });

  it("constrains placement list rows: known shape, positive count, no extra fields", () => {
    expect(validate({ ...minimal, objects: [{ id: "npc-x-001", count: 1 }] })).toBe(true);
    expect(validate({ ...minimal, objects: [{ id: "npc-x-001", count: 0 }] })).toBe(false);
    expect(validate({ ...minimal, objects: [{ id: "npc-x-001", count: 1.5 }] })).toBe(false);
    expect(validate({ ...minimal, objects: [{ id: "", count: 1 }] })).toBe(false);
    expect(validate({ ...minimal, objects: [{ id: "npc-x-001" }] })).toBe(false);
    expect(
      validate({ ...minimal, objects: [{ id: "npc-x-001", count: 1, hidden: true }] }),
    ).toBe(false);
  });

  it("enforces the id rules for rooms and exits (room-/exit- prefixed lowercase segments)", () => {
    for (const id of ["room-x-001", "room-village-gate", "room-a1"]) {
      expect(validate({ ...minimal, id })).toBe(true);
    }
    for (const id of ["x-001", "room", "room-", "room_X", "room-X-001"]) {
      expect(validate({ ...minimal, id })).toBe(false);
    }
    for (const id of ["exit-x-001-north", "exit-gate"]) {
      expect(validate({ ...minimal, exits: [exit({ id })] })).toBe(true);
    }
    for (const id of ["north", "exit-", "exit-North"]) {
      expect(validate({ ...minimal, exits: [exit({ id })] })).toBe(false);
    }
  });

  it("accepts non-empty err_* copy and rejects anything else in its place", () => {
    expect(validate({ ...minimal, err_enter: "此处不得擅入。" })).toBe(true);
    expect(validate({ ...minimal, err_default: "此事眼下行不得。" })).toBe(true);
    expect(validate({ ...minimal, err_traverse: "此路过不去。" })).toBe(true);
    expect(validate({ ...minimal, err_enter: "" })).toBe(false);
    expect(validate({ ...minimal, err_enter: 42 })).toBe(false);
    expect(validate({ ...minimal, err_: "empty accessType" })).toBe(false);
    expect(validate({ ...minimal, err_ENTER: "uppercase" })).toBe(false);
  });

  it("rejects unknown fields on rooms, exits and placements (additionalProperties: false)", () => {
    // Superseded shapes must not sneak back in: exits are not a direction map,
    // placements are not an id→count object, rooms carry no combat numbers.
    expect(
      validate({ ...minimal, exits: [{ north: "room-x-002" }] }),
    ).toBe(false);
    expect(validate({ ...minimal, objects: { "npc-x-001": 1 } })).toBe(false);
    expect(validate({ ...minimal, stats: { maxHp: 100 } })).toBe(false);
    expect(validate({ ...minimal, contents: [{ id: "npc-x-001" }] })).toBe(false);
    expect(validate({ ...minimal, exits: [exit({ target: "room-x-002" })] })).toBe(false);
  });
});

describe("npcs.schema.json (draft-07)", () => {
  const validate = compile(npcsSchema);

  const minimal = {
    id: "npc-x-001",
    name: "灰袍老者",
    description: "一位倚墙晒太阳的灰袍老者，眼皮半阖。",
  };

  it("compiles under Ajv strict mode", () => {
    expect(typeof validate).toBe("function");
  });

  it("accepts a non-combat npc: identity only, no monsterId", () => {
    expect(validate(minimal)).toBe(true);
  });

  it("accepts a combat-capable npc that REFERENCES a monster (spec/03 §4)", () => {
    expect(validate({ ...minimal, id: "npc-x-002", monsterId: "mon-x-014" })).toBe(true);
    for (const monsterId of ["mon-x-1", "monster-1", "mon-X-001", "mon-x-0001", "mon-x-14a"]) {
      expect(validate({ ...minimal, monsterId }), monsterId).toBe(false);
    }
  });

  it("gives combat numbers nowhere to live: reference, never copy", () => {
    // The whole point of the npc collection (ADR-0016 §3): duplicating stats
    // here would mean double maintenance — the schema leaves no room for it.
    expect(validate({ ...minimal, stats: { maxHp: 100 } })).toBe(false);
    expect(validate({ ...minimal, maxHp: 100 })).toBe(false);
    expect(validate({ ...minimal, attack: 12 })).toBe(false);
    expect(validate({ ...minimal, affinities: { fire: 30 } })).toBe(false);
    expect(validate({ ...minimal, effects: ["eff-x-001"] })).toBe(false);
  });

  it("enforces the id rule and required identity fields", () => {
    for (const id of ["npc-x-001", "npc-lq-002", "npc-shopkeeper"]) {
      expect(validate({ ...minimal, id })).toBe(true);
    }
    for (const id of ["x-001", "npc", "npc-", "npc_X", "npc-X-001"]) {
      expect(validate({ ...minimal, id })).toBe(false);
    }
    expect(validate({ id: "npc-x-001", name: "", description: "…" })).toBe(false);
    expect(validate({ id: "npc-x-001", name: "灰袍老者" })).toBe(false);
  });
});
