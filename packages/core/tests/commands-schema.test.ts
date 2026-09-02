import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";

/**
 * schemas/commands.schema.json (spec/02 §2, issue #5): commands as content —
 * verbs, argForm, cmdset membership, merge rules, preconditions and err_*
 * refusal copy all live in data, and the engine stays verb-free.
 *
 * The schema $refs the condition library across files
 * (condition.schema.json#/definitions/accessRules), so these tests also prove
 * that reference resolves under Ajv strict mode — content:check registers all
 * schemas up front for exactly this purpose (spec/06 §3).
 */

const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../schemas");
const commandsSchema = JSON.parse(readFileSync(resolve(schemasDir, "commands.schema.json"), "utf8"));
const conditionSchema = JSON.parse(readFileSync(resolve(schemasDir, "condition.schema.json"), "utf8"));
// The entry-field library (tags / flags / prototypeKey / prototypeParent) is
// the second cross-file $ref every collection schema makes (M3-T1).
const commonSchema = JSON.parse(readFileSync(resolve(schemasDir, "common.schema.json"), "utf8"));

/** Compiles the commands schema with both libraries pre-registered for $ref. */
function compile() {
  const ajv = new Ajv({ allErrors: true });
  ajv.addSchema(conditionSchema);
  ajv.addSchema(commonSchema);
  return ajv.compile(commandsSchema);
}

describe("commands.schema.json (draft-07, $ref library consumer)", () => {
  const validate = compile();

  const minimal = {
    id: "cmd-look",
    verbs: ["看", "look"],
    argForm: "none",
    cmdset: "character",
    priority: 0,
  };

  it("compiles under Ajv strict mode and resolves the cross-file preconditions $ref", () => {
    expect(typeof validate).toBe("function");
  });

  it("accepts a minimal entry: required fields only", () => {
    expect(validate(minimal)).toBe(true);
  });

  it("accepts a full entry: mergetype + recursive preconditions + err_* copy", () => {
    expect(
      validate({
        ...minimal,
        id: "cmd-rest",
        verbs: ["歇", "歇息", "rest"],
        mergetype: "Union",
        preconditions: {
          default: true,
          use: { not: [{ has_state: "wounded" }] },
        },
        err_use: "你伤势未愈，此刻无法安歇。",
        err_default: "此事眼下行不得。",
      }),
    ).toBe(true);
  });

  it("enforces the accessRules contract THROUGH the $ref (spec/02 §5.2)", () => {
    // default is required — an undeclared accessType must have an answer.
    expect(validate({ ...minimal, preconditions: { use: true } })).toBe(false);
    // Unknown predicates and multi-key nodes are the condition library's to reject.
    expect(
      validate({ ...minimal, preconditions: { default: false, use: { has_money: "lots" } } }),
    ).toBe(false);
    expect(
      validate({
        ...minimal,
        preconditions: {
          default: false,
          use: { all: [{ has_tag: "a" }], any: [{ has_tag: "b" }] },
        },
      }),
    ).toBe(false);
  });

  it("accepts every argForm and mergetype enum value, rejects anything else", () => {
    for (const form of ["none", "text", "target", "target-ordinal", "target-index"]) {
      expect(validate({ ...minimal, argForm: form })).toBe(true);
    }
    expect(validate({ ...minimal, argForm: "quantifier" })).toBe(false);
    expect(validate({ ...minimal, argForm: "None" })).toBe(false);

    for (const type of ["Union", "Intersect", "Replace", "Remove"]) {
      expect(validate({ ...minimal, mergetype: type })).toBe(true);
    }
    // The enum is case-sensitive: the engine's MergeType is capitalized.
    expect(validate({ ...minimal, mergetype: "union" })).toBe(false);
  });

  it("enforces the id rule: cmd- prefix, lowercase alphanumeric segments", () => {
    for (const id of ["cmd-look", "cmd-say-2", "cmd-a1"]) {
      expect(validate({ ...minimal, id })).toBe(true);
    }
    for (const id of [
      "look", // no collection prefix
      "cmd", // no segment
      "cmd-", // empty segment
      "cmd-look-", // trailing hyphen
      "cmd-look--x", // empty segment inside
      "cmd_look", // underscore
      "cmd-Look", // uppercase
      "CMD-look",
    ]) {
      expect(validate({ ...minimal, id })).toBe(false);
    }
  });

  it("requires at least one verb, non-empty, unique (verbs ARE the command)", () => {
    expect(validate({ ...minimal, verbs: [] })).toBe(false);
    expect(validate({ ...minimal, verbs: [""] })).toBe(false);
    expect(validate({ ...minimal, verbs: ["看", "看"] })).toBe(false);
    expect(validate({ ...minimal, verbs: ["look", 42] })).toBe(false);
    expect(validate({ ...minimal, verbs: ["看", "望", "look", "l"] })).toBe(true);
  });

  it("constrains cmdset to a stable lowercase identifier", () => {
    for (const cmdset of ["character", "session", "room", "objects-2"]) {
      expect(validate({ ...minimal, cmdset })).toBe(true);
    }
    for (const cmdset of ["", "Character", "2room", "room command"]) {
      expect(validate({ ...minimal, cmdset })).toBe(false);
    }
  });

  it("requires an integer priority (any sign — the seven-source arrangement is one pack's choice)", () => {
    expect(validate({ ...minimal, priority: 0 })).toBe(true);
    expect(validate({ ...minimal, priority: -20 })).toBe(true);
    expect(validate({ ...minimal, priority: 101 })).toBe(true);
    expect(validate({ ...minimal, priority: 1.5 })).toBe(false);
    expect(validate({ ...minimal, priority: "0" })).toBe(false);
  });

  it("accepts non-empty string err_* keys and rejects anything else in their place", () => {
    expect(validate({ ...minimal, err_use: "你伤势未愈，此刻无法安歇。" })).toBe(true);
    expect(validate({ ...minimal, err_default: "此事眼下行不得。" })).toBe(true);
    expect(validate({ ...minimal, err_traverse: "山门不放行。" })).toBe(true);
    expect(validate({ ...minimal, err_use: "" })).toBe(false);
    expect(validate({ ...minimal, err_use: 42 })).toBe(false);
    expect(validate({ ...minimal, err_: "empty accessType" })).toBe(false);
    expect(validate({ ...minimal, err_USE: "uppercase" })).toBe(false);
  });

  it("rejects unknown fields (additionalProperties: false) while err_* passes (patternProperties)", () => {
    // The draft-07 interplay that matters: additionalProperties:false only
    // bans what neither properties nor patternProperties matched.
    expect(validate({ ...minimal, err_use: "…" })).toBe(true);

    // Superseded field shapes must not sneak back in (aliases folded into
    // verbs by spec/02 §6; effects are a later milestone's field).
    expect(validate({ ...minimal, aliases: ["look"] })).toBe(false);
    expect(validate({ ...minimal, effects: ["eff-001"] })).toBe(false);
    expect(validate({ ...minimal, description: "look around" })).toBe(false);
  });
});
