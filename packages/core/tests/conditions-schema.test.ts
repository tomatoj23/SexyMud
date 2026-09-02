import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";

/**
 * schemas/condition.schema.json (spec/02 §5, ADR-0024 §8): the recursive
 * draft-07 grammar behind every "may X" question.
 *
 * content:check only compiles schemas that map to a content collection; this
 * schema is a $ref LIBRARY (conditions are embedded in commands / martial /
 * exit entries, there is no content/condition/ directory), so its draft-07
 * legality, its $ref self-recursion and its cross-file referenceability are
 * proven HERE — closing the known gap in spec/06 §3.1 for this file.
 */

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../schemas/condition.schema.json",
);
const conditionSchema = JSON.parse(readFileSync(schemaPath, "utf8"));

/** Compiles `schema` with the condition library pre-registered for $ref. */
function compile(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  ajv.addSchema(conditionSchema);
  return ajv.compile(schema);
}

describe("condition.schema.json (draft-07, recursive)", () => {
  const validate = compile(conditionSchema);

  it("compiles under Ajv strict mode (draft-07 keywords only, spec/06 §5)", () => {
    expect(typeof validate).toBe("function");
  });

  it("accepts the spec's own expression shapes (spec/02 §5)", () => {
    expect(validate({ all: [{ has_tag: ["zone", "outdoors"] }, { attr_gte: ["strength", 50] }] })).toBe(true);
    expect(validate({ any: [{ has_flag: "member" }] })).toBe(true);
    expect(validate({ not: [{ has_state: "wounded" }] })).toBe(true);
  });

  it("accepts all six whitelisted predicates with their argument shapes", () => {
    expect(validate({ attr_gte: ["strength", 50] })).toBe(true);
    // has_tag carries the DIMENSIONED pair (ADR-0029 §1, #17): two non-empty
    // strings, not one.
    expect(validate({ has_tag: ["zone", "outdoors"] })).toBe(true);
    expect(validate({ has_flag: "member" })).toBe(true);
    expect(validate({ has_state: "wounded" })).toBe(true);
    expect(validate({ in_location: "room-hall" })).toBe(true);
    expect(validate({ has_martial: "mrt-hs-001" })).toBe(true);
  });

  it("accepts boolean leaves", () => {
    expect(validate(true)).toBe(true);
    expect(validate(false)).toBe(true);
  });

  it("accepts arbitrary nesting via $ref self-reference — a AND b OR c and deeper (ADR-0024 §8)", () => {
    expect(
      validate({
        any: [{ all: [{ has_tag: ["zone", "a"] }, { has_tag: ["zone", "b"] }] }, { has_tag: ["zone", "c"] }],
      }),
    ).toBe(true);
    expect(
      validate({
        not: [{ any: [{ all: [{ has_flag: "x" }, { not: [{ has_state: "y" }] }] }] }],
      }),
    ).toBe(true);
  });

  it("accepts the accessRules map: default + per-accessType expressions and boolean gates", () => {
    const accessValidate = compile({
      $ref: "condition.schema.json#/definitions/accessRules",
    });
    expect(
      accessValidate({
        default: false,
        use: { all: [{ attr_gte: ["strength", 50] }] },
        edit: true,
      }),
    ).toBe(true);
    // default is a full condition, not just a policy bit.
    expect(
      accessValidate({ default: { has_flag: "member" }, use: { has_tag: ["zone", "outdoors"] } }),
    ).toBe(true);
  });

  it("rejects non-node values and multi-key nodes", () => {
    expect(validate("outdoors")).toBe(false);
    expect(validate(42)).toBe(false);
    expect(validate(null)).toBe(false);
    expect(validate({})).toBe(false);
    expect(validate([])).toBe(false);
    expect(validate({ all: [{ has_tag: ["zone", "a"] }], any: [{ has_tag: ["zone", "b"] }] })).toBe(false);
    expect(validate({ has_tag: ["zone", "a"], has_flag: "b" })).toBe(false);
  });

  it("rejects empty combinator arrays and unknown predicates", () => {
    expect(validate({ all: [] })).toBe(false);
    expect(validate({ not: [] })).toBe(false);
    expect(validate({ has_money: "lots" })).toBe(false);
  });

  it("rejects argument shapes that do not match their predicate", () => {
    // has_tag: the OLD single-string shape is now invalid — this is the
    // rejection that makes #17's shape change real rather than additive.
    expect(validate({ has_tag: "outdoors" })).toBe(false);
    expect(validate({ has_tag: ["zone"] })).toBe(false);
    expect(validate({ has_tag: ["zone", "outdoors", "extra"] })).toBe(false);
    expect(validate({ has_tag: ["zone", 7] })).toBe(false);
    expect(validate({ has_tag: ["", "outdoors"] })).toBe(false);
    expect(validate({ has_tag: ["zone", ""] })).toBe(false);
    expect(validate({ has_tag: { zone: "outdoors" } })).toBe(false);
    expect(validate({ attr_gte: "strength" })).toBe(false);
    expect(validate({ attr_gte: ["strength"] })).toBe(false);
    expect(validate({ attr_gte: ["strength", 50, 10] })).toBe(false);
    expect(validate({ attr_gte: [50, "strength"] })).toBe(false);
  });

  it("rejects accessRules without default, and err_* copy inside the map", () => {
    const accessValidate = compile({
      $ref: "condition.schema.json#/definitions/accessRules",
    });
    // default is required — an undeclared accessType must have an answer.
    expect(accessValidate({ use: { has_tag: ["zone", "outdoors"] } })).toBe(false);
    expect(accessValidate({ default: "no" })).toBe(false);
    // err_* copy is an ENTRY-level field; a string under a gate key is not a
    // condition, so the map cannot silently absorb refusal copy.
    expect(accessValidate({ default: false, err_use: "你伤势未愈。" })).toBe(false);
  });
});

describe("cross-file $ref: what the M1-T5 commands schema will do", () => {
  it("a consumer schema references the library by $id and validates entries", () => {
    const consumer = compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "consumer.commands.schema.json",
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        preconditions: { $ref: "condition.schema.json#/definitions/accessRules" },
        err_use: { type: "string" },
      },
    });

    expect(
      consumer({
        key: "cmd-rest",
        preconditions: { default: false, use: { not: [{ has_state: "wounded" }] } },
        err_use: "你伤势未愈，此刻无法安歇。",
      }),
    ).toBe(true);

    // Bad preconditions fail THROUGH the $ref — the library enforces itself.
    expect(
      consumer({
        key: "cmd-rest",
        preconditions: { use: { not: [{ has_state: "wounded" }] } },
        err_use: "…",
      }),
    ).toBe(false);
    expect(
      consumer({
        key: "cmd-rest",
        preconditions: { default: false, use: { unknown_pred: 1 } },
        err_use: "…",
      }),
    ).toBe(false);
  });

  it("a consumer can also reference the bare expression root (learning prerequisites)", () => {
    const consumer = compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "consumer.martial.schema.json",
      type: "object",
      properties: {
        prerequisites: { $ref: "condition.schema.json" },
      },
    });
    expect(consumer({ prerequisites: { attr_gte: ["root", 30] } })).toBe(true);
    expect(consumer({ prerequisites: { has_money: "lots" } })).toBe(false);
  });
});
