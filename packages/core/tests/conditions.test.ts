import { describe, expect, it } from "vitest";
import {
  checkAccess,
  createPredicateRegistry,
  defaultPredicateEntries,
  evaluateCondition,
} from "../src/conditions.js";
import type {
  AccessRules,
  ConditionExpr,
  ConditionSubject,
  PredicateFn,
} from "../src/conditions.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";

/**
 * The condition contract (spec/02 §5; ADR-0022 §2 as corrected by ADR-0024
 * §8): recursive JSON expressions, an extensible predicate registry, the
 * access map with `default`, and refusals whose copy lives in entry data.
 *
 * Fixture vocabulary below (tags, states, the entry copy) is TEST DATA — the
 * engine itself holds none of it.
 */

interface ActorFixture {
  attrs: Record<string, number>;
  tags: string[];
  flags: string[];
  states: string[];
  locationId?: string;
  skills: string[];
}

const ACTOR: ActorFixture = {
  attrs: { strength: 50 },
  tags: ["outdoors"],
  flags: [],
  states: [],
  locationId: "room-hall",
  skills: ["mrt-basic"],
};

function subjectOf(actor: ActorFixture): ConditionSubject {
  return {
    attr: (name) => actor.attrs[name],
    hasTag: (tag) => actor.tags.includes(tag),
    hasFlag: (flag) => actor.flags.includes(flag),
    hasState: (state) => actor.states.includes(state),
    locationId: () => actor.locationId,
    hasSkill: (id) => actor.skills.includes(id),
  };
}

function subjectWith(overrides: Partial<ActorFixture>): ConditionSubject {
  return subjectOf({ ...ACTOR, ...overrides });
}

/** A host-registered predicate, unknown to the schema whitelist and the engine. */
const wears: PredicateFn = (arg, subject) =>
  typeof arg === "string" && subject.hasTag(`wears:${arg}`);

describe("condition evaluator (spec/02 §5)", () => {
  it("evaluates boolean leaves directly", () => {
    expect(evaluateCondition(true, subjectOf(ACTOR))).toBe(true);
    expect(evaluateCondition(false, subjectOf(ACTOR))).toBe(false);
  });

  it("evaluates a single predicate node", () => {
    expect(evaluateCondition({ has_tag: "outdoors" }, subjectOf(ACTOR))).toBe(true);
    expect(evaluateCondition({ has_tag: "indoors" }, subjectOf(ACTOR))).toBe(false);
  });

  it("evaluates the combinators", () => {
    const subject = subjectOf(ACTOR); // tag: outdoors, strength: 50
    expect(evaluateCondition({ all: [{ has_tag: "outdoors" }, { attr_gte: ["strength", 50] }] }, subject)).toBe(true);
    expect(evaluateCondition({ all: [{ has_tag: "outdoors" }, { attr_gte: ["strength", 51] }] }, subject)).toBe(false);
    expect(evaluateCondition({ any: [{ has_flag: "member" }, { has_tag: "outdoors" }] }, subject)).toBe(true);
    expect(evaluateCondition({ any: [{ has_flag: "member" }, { has_state: "wounded" }] }, subject)).toBe(false);
    expect(evaluateCondition({ not: [{ has_state: "wounded" }] }, subject)).toBe(true);
    expect(evaluateCondition({ not: [{ has_tag: "outdoors" }] }, subject)).toBe(false);
  });

  it("treats multi-child not as 'none of these are true'", () => {
    const wounded = subjectWith({ states: ["wounded"] });
    const woundedAndBlind = subjectWith({ states: ["wounded", "blind"] });
    expect(evaluateCondition({ not: [{ has_state: "wounded" }, { has_state: "blind" }] }, subjectOf(ACTOR))).toBe(true);
    expect(evaluateCondition({ not: [{ has_state: "wounded" }, { has_state: "blind" }] }, wounded)).toBe(false);
    expect(evaluateCondition({ not: [{ has_state: "wounded" }, { has_state: "blind" }] }, woundedAndBlind)).toBe(false);
  });

  it("expresses a AND b OR c through nesting — the case a two-layer grammar cannot (ADR-0024 §8)", () => {
    const expr: ConditionExpr = {
      any: [{ all: [{ has_tag: "a" }, { has_tag: "b" }] }, { has_tag: "c" }],
    };
    expect(evaluateCondition(expr, subjectWith({ tags: ["a", "b"] }))).toBe(true);
    expect(evaluateCondition(expr, subjectWith({ tags: ["c"] }))).toBe(true);
    expect(evaluateCondition(expr, subjectWith({ tags: ["a"] }))).toBe(false);
    expect(evaluateCondition(expr, subjectWith({ tags: ["b"] }))).toBe(false);
    expect(evaluateCondition(expr, subjectWith({ tags: [] }))).toBe(false);
  });

  it("nests arbitrarily deep", () => {
    const expr: ConditionExpr = {
      any: [
        { not: [{ has_state: "blind" }] },
        { all: [{ attr_gte: ["strength", 40] }, { not: [{ has_flag: "banned" }] }] },
      ],
    };
    expect(evaluateCondition(expr, subjectOf(ACTOR))).toBe(true); // not blind
    expect(
      evaluateCondition(expr, subjectWith({ states: ["blind"], attrs: { strength: 40 } })),
    ).toBe(true); // second branch
    expect(
      evaluateCondition(expr, subjectWith({ states: ["blind"], attrs: { strength: 39 } })),
    ).toBe(false);
    expect(
      evaluateCondition(expr, subjectWith({ states: ["blind"], flags: ["banned"] })),
    ).toBe(false);
  });

  it("throws on malformed nodes — loudly, not as a silent grant or denial", () => {
    const subject = subjectOf(ACTOR);
    expect(() => evaluateCondition(42 as unknown as ConditionExpr, subject)).toThrow(/boolean or a single-key object/);
    expect(() => evaluateCondition([{ has_tag: "a" }] as unknown as ConditionExpr, subject)).toThrow(
      /boolean or a single-key object/,
    );
    expect(() => evaluateCondition({ has_tag: "a", has_flag: "b" }, subject)).toThrow(/exactly one key/);
    expect(() => evaluateCondition({ all: [], any: [] }, subject)).toThrow(/exactly one key/);
    expect(() => evaluateCondition({ all: [] }, subject)).toThrow(/non-empty array/);
    expect(() => evaluateCondition({ not: [] }, subject)).toThrow(/non-empty array/);
    expect(() => evaluateCondition({ has_money: "lots" }, subject)).toThrow(/unknown predicate/);
  });
});

describe("built-in predicates (spec/02 §5.3)", () => {
  it("registers exactly the six engine predicates", () => {
    expect(defaultPredicateEntries.map(([name]) => name)).toEqual([
      "attr_gte",
      "has_tag",
      "has_flag",
      "has_state",
      "in_location",
      "has_martial",
    ]);
  });

  it("attr_gte is inclusive and unmet when the attribute is missing", () => {
    expect(evaluateCondition({ attr_gte: ["strength", 50] }, subjectOf(ACTOR))).toBe(true);
    expect(evaluateCondition({ attr_gte: ["strength", 51] }, subjectOf(ACTOR))).toBe(false);
    expect(evaluateCondition({ attr_gte: ["agility", 1] }, subjectOf(ACTOR))).toBe(false);
  });

  it("covers tag / flag / state / location / martial membership", () => {
    expect(evaluateCondition({ has_flag: "member" }, subjectWith({ flags: ["member"] }))).toBe(true);
    expect(evaluateCondition({ has_state: "wounded" }, subjectWith({ states: ["wounded"] }))).toBe(true);
    expect(evaluateCondition({ in_location: "room-hall" }, subjectOf(ACTOR))).toBe(true);
    expect(evaluateCondition({ in_location: "room-cave" }, subjectOf(ACTOR))).toBe(false);
    expect(evaluateCondition({ has_martial: "mrt-basic" }, subjectOf(ACTOR))).toBe(true);
    expect(evaluateCondition({ has_martial: "mrt-advanced" }, subjectOf(ACTOR))).toBe(false);
  });

  it("throws when an argument shape does not match the schema", () => {
    const subject = subjectOf(ACTOR);
    expect(() => evaluateCondition({ has_tag: ["outdoors"] }, subject)).toThrow(/one non-empty string/);
    expect(() => evaluateCondition({ has_tag: "" }, subject)).toThrow(/one non-empty string/);
    expect(() => evaluateCondition({ attr_gte: "strength" }, subject)).toThrow(/\[attrName, minimum\]/);
    expect(() => evaluateCondition({ attr_gte: ["strength"] }, subject)).toThrow(/\[attrName, minimum\]/);
    expect(() => evaluateCondition({ attr_gte: ["strength", "50"] }, subject)).toThrow(/\[attrName, minimum\]/);
    expect(() => evaluateCondition({ attr_gte: [50, "strength"] }, subject)).toThrow(/\[attrName, minimum\]/);
  });

  it("throws when the subject facet violates its own contract", () => {
    const broken: ConditionSubject = {
      ...subjectOf(ACTOR),
      attr: () => "fifty" as unknown as number,
    };
    expect(() => evaluateCondition({ attr_gte: ["strength", 10] }, broken)).toThrow(
      /must return a finite number or undefined/,
    );
  });
});

describe("predicate registry (engine capability, extensible)", () => {
  it("evaluates through the registry, not hardcoded branches — a custom predicate works", () => {
    const registry = createPredicateRegistry([["wears", wears]]);

    const expr: ConditionExpr = { any: [{ wears: "boots" }] };
    expect(evaluateCondition(expr, subjectWith({ tags: ["wears:boots"] }), registry)).toBe(true);
    expect(evaluateCondition(expr, subjectWith({ tags: [] }), registry)).toBe(false);
    // A hardcoded-branch evaluator would reject "wears" as unknown; the
    // registry is the only dispatch path.
    expect(() => evaluateCondition(expr, subjectOf(ACTOR))).toThrow(/unknown predicate/);
  });

  it("extends the built-ins by composition, immutably", () => {
    const night: PredicateFn = (_arg, subject) => subject.hasState("night");
    const registry = createPredicateRegistry([...defaultPredicateEntries, ["is_night", night]]);
    expect(evaluateCondition({ is_night: true }, subjectWith({ states: ["night"] }), registry)).toBe(true);
    // The built-ins still work in the extended registry.
    expect(evaluateCondition({ has_tag: "outdoors" }, subjectOf(ACTOR), registry)).toBe(true);
  });

  it("rejects duplicate names and non-functions at build time", () => {
    expect(() => createPredicateRegistry([["a", () => true], ["a", () => false]])).toThrow(
      /"a" is registered twice/,
    );
    expect(() => createPredicateRegistry([["a", "not a function" as unknown as PredicateFn]])).toThrow(
      /is not a function/,
    );
    expect(() => createPredicateRegistry([["", () => true]])).toThrow(/empty name/);
  });
});

describe("access map (spec/02 §5.2)", () => {
  const rules: AccessRules = {
    default: false,
    use: { all: [{ attr_gte: ["strength", 50] }] },
    edit: true,
  };

  it("grants when the accessType's expression holds", () => {
    expect(checkAccess(rules, "use", subjectOf(ACTOR))).toEqual({ ok: true });
  });

  it("denies naming the entry's err field: err_<accessType>", () => {
    expect(checkAccess(rules, "use", subjectWith({ attrs: { strength: 49 } }))).toEqual({
      ok: false,
      accessType: "use",
      errKey: "err_use",
    });
  });

  it("falls back to default for an accessType with no expression — err_default on denial", () => {
    expect(checkAccess(rules, "traverse", subjectOf(ACTOR))).toEqual({
      ok: false,
      accessType: "traverse",
      errKey: "err_default",
    });
    expect(checkAccess({ default: true }, "traverse", subjectOf(ACTOR))).toEqual({ ok: true });
  });

  it("evaluates an expression-valued default for undeclared accessTypes", () => {
    const gated: AccessRules = { default: { has_flag: "member" } };
    expect(checkAccess(gated, "edit", subjectWith({ flags: ["member"] }))).toEqual({ ok: true });
    expect(checkAccess(gated, "edit", subjectOf(ACTOR))).toEqual({
      ok: false,
      accessType: "edit",
      errKey: "err_default",
    });
  });

  it("accepts boolean leaves as hard open/closed gates per accessType", () => {
    expect(checkAccess(rules, "edit", subjectOf(ACTOR))).toEqual({ ok: true });
    expect(
      checkAccess({ default: true, learn: false }, "learn", subjectOf(ACTOR)),
    ).toEqual({ ok: false, accessType: "learn", errKey: "err_learn" });
  });
});

describe("pipeline integration: access-gated commands through the M1-T1 harness", () => {
  /**
   * A fixture content entry, shaped as commands/ entries will be (M1-T5).
   * The refusal copy lives HERE, in data — the engine reads no err_* field
   * and words no refusal of its own.
   */
  const restEntry = {
    key: "cmd-rest",
    verbs: ["歇息", "rest"],
    argForm: "none" as const,
    preconditions: {
      default: false,
      use: { not: [{ has_state: "wounded" }] },
    },
    err_use: "你伤势未愈，此刻无法安歇。",
  };

  interface ActorWorld {
    actors: Record<string, ActorFixture>;
  }

  /** What the M1-T5 content loader will do: entry data → CommandSpec. */
  function specFromEntry(entry: typeof restEntry): CommandSpec<ActorWorld> {
    return {
      key: entry.key,
      argForm: entry.argForm,
      access: { rules: entry.preconditions, accessType: "use" },
      func: (ctx) => ctx.emit(ctx.command.actorId, { type: "rested" }),
    };
  }

  function harnessWith(actor: ActorFixture) {
    return createCommandHarness<ActorWorld>({
      world: { actors: { "actor-1": actor } },
      receivers: ["actor-1"],
      verbs: restEntry.verbs.map((verb) => ({ verb, commandKey: restEntry.key })),
      subjectOf: (world, actorId) => subjectOf(world.actors[actorId]!),
    });
  }

  it("refuses a gated command and points at the data's refusal copy (spec/02 §5.4)", () => {
    const order: string[] = [];
    const spec: CommandSpec<ActorWorld> = {
      ...specFromEntry(restEntry),
      at_pre_cmd: () => {
        order.push("pre");
      },
      func: (ctx) => {
        order.push("func");
        ctx.emit(ctx.command.actorId, { type: "rested" });
      },
    };

    const out = harnessWith({ ...ACTOR, states: ["wounded"] }).call(spec, "歇息");

    // The gate runs before every stage: nothing executes.
    expect(order).toEqual([]);
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });

    // The event stays semantic — it locates the copy, it never carries it.
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "accessDenied",
          commandKey: "cmd-rest",
          accessType: "use",
          errKey: "err_use",
        },
      },
    ]);

    // The renderer's path, demonstrated: read the field the event names from
    // the entry data. The copy exists ONLY there — the engine holds no text.
    const refusal = out.messages[0]!.event as Record<string, unknown>;
    expect(restEntry[refusal.errKey as keyof typeof restEntry]).toBe("你伤势未愈，此刻无法安歇。");
  });

  it("runs the command when the gate holds", () => {
    const out = harnessWith({ ...ACTOR }).call(specFromEntry(restEntry), "歇息");

    expect(out.result.ok).toBe(true);
    expectMessageSequence(out.messages, [{ to: "actor-1", event: { type: "rested" } }]);
  });

  it("reports err_default when the default gate denies an undeclared accessType", () => {
    const spec: CommandSpec<ActorWorld> = {
      key: "cmd-admin",
      argForm: "none",
      access: { rules: { default: false }, accessType: "edit" },
      func: (ctx) => ctx.emit(ctx.command.actorId, { type: "administered" }),
    };

    const out = harnessWith({ ...ACTOR }).call(spec, "administer");

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
    expectMessageSequence(out.messages, [
      { to: "actor-1", event: { type: "commandRefused", errKey: "err_default" } },
    ]);
  });

  it("fails loudly when a gated spec runs without a subject provider (wiring bug)", () => {
    const harness = createCommandHarness<ActorWorld>({
      world: { actors: {} },
      receivers: ["actor-1"],
      verbs: restEntry.verbs.map((verb) => ({ verb, commandKey: restEntry.key })),
    });
    expect(() => harness.call(specFromEntry(restEntry), "歇息")).toThrow(
      /declares an access gate but no subject provider/,
    );
  });

  it("uses an injected registry end-to-end: a custom predicate gates the command", () => {
    const spec: CommandSpec<ActorWorld> = {
      key: "cmd-delve",
      argForm: "none",
      access: { rules: { default: false, use: { wears: "boots" } }, accessType: "use" },
      func: (ctx) => ctx.emit(ctx.command.actorId, { type: "delved" }),
    };

    const options = (actor: ActorFixture) => ({
      world: { actors: { "actor-1": actor } } as ActorWorld,
      receivers: ["actor-1"],
      verbs: [{ verb: "delve", commandKey: "cmd-delve" }],
      subjectOf: (world: ActorWorld, actorId: string) => subjectOf(world.actors[actorId]!),
      predicates: createPredicateRegistry([...defaultPredicateEntries, ["wears", wears]]),
    });

    const shoddy = createCommandHarness<ActorWorld>(options({ ...ACTOR, tags: [] }));
    expect(shoddy.call(spec, "delve").result.ok).toBe(false);

    const booted = createCommandHarness<ActorWorld>(options({ ...ACTOR, tags: ["wears:boots"] }));
    const out = booted.call(spec, "delve");
    expect(out.result.ok).toBe(true);
    expectMessageSequence(out.messages, [{ to: "actor-1", event: { type: "delved" } }]);
  });
});
