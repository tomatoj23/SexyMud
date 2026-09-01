import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../src/command/pipeline.js";
import { runCommand } from "../src/command/pipeline.js";
import { createCommandHarness, createTestClock } from "../src/command/testing.js";
import { createSeededRng } from "../src/rng.js";
import { createVerbTable, parseArgForm } from "../src/command/parser.js";

/**
 * The Chinese-first parser (spec/02 §1, ADR-0024 §1): longest verb match with
 * no tokenizer, plus declarative arg forms. Verbs below are TEST FIXTURE DATA
 * — the engine itself knows none (the engine-purity suite guards src/).
 */
interface TestWorld {
  room: string;
}

const noopSink = { emit: () => {} };

describe("verb table: longest verb match (spec/02 §1.2)", () => {
  it("matches the longest registered verb and hands the rest over whole as rawArgs", () => {
    const table = createVerbTable([
      { verb: "打", commandKey: "cmd-attack" },
      { verb: "笑", commandKey: "cmd-laugh" },
      { verb: "笑傲江湖", commandKey: "cmd-swordplay" },
    ]);

    expect(table.match("笑傲江湖")).toEqual({
      ok: true,
      verb: "笑傲江湖",
      commandKey: "cmd-swordplay",
      rawArgs: "",
    });
  });

  it("does not let a short verb eat a longer one: 笑 cannot claim 笑傲江湖's input", () => {
    const table = createVerbTable([
      { verb: "笑", commandKey: "cmd-laugh" },
      { verb: "笑傲江湖", commandKey: "cmd-swordplay" },
    ]);

    expect(table.match("笑傲江湖")).toMatchObject({ ok: true, commandKey: "cmd-swordplay" });
    expect(table.match("笑")).toMatchObject({ ok: true, commandKey: "cmd-laugh" });
    expect(table.match("笑哈哈")).toMatchObject({ ok: true, commandKey: "cmd-laugh" });
  });

  it("cuts the verb and returns the remainder whole, without tokenizing it", () => {
    const table = createVerbTable([{ verb: "打", commandKey: "cmd-attack" }]);

    // The remainder stays one string — arg parsing is the command's argForm,
    // never the verb matcher's job.
    expect(table.match("打第二个强盗")).toEqual({
      ok: true,
      verb: "打",
      commandKey: "cmd-attack",
      rawArgs: "第二个强盗",
    });
  });

  it("keeps a canonical, process-stable verb order: length descending then lexicographic", () => {
    // ADR-0024 §2: iteration order must be explicit (length desc + lex asc),
    // never dependent on insertion or hash order.
    const table = createVerbTable([
      { verb: "笑", commandKey: "cmd-laugh" },
      { verb: "north", commandKey: "cmd-north" },
      { verb: "杀", commandKey: "cmd-kill" },
      { verb: "笑傲江湖", commandKey: "cmd-swordplay" },
      { verb: "打", commandKey: "cmd-attack" },
      { verb: "n", commandKey: "cmd-north" },
    ]);

    expect(table.verbs).toEqual(["north", "笑傲江湖", "n", "打", "杀", "笑"]);
  });

  it("accepts Chinese and English verbs side by side for the same command (A4)", () => {
    const table = createVerbTable([
      { verb: "北", commandKey: "cmd-north" },
      { verb: "n", commandKey: "cmd-north" },
      { verb: "north", commandKey: "cmd-north" },
    ]);

    for (const input of ["北", "n", "north"]) {
      expect(table.match(input)).toMatchObject({ ok: true, verb: input, commandKey: "cmd-north" });
    }
  });

  it("trims the input, and the verb/argument separator — including the full-width space", () => {
    const table = createVerbTable([{ verb: "打", commandKey: "cmd-attack" }]);

    expect(table.match("  打第二个强盗  ")).toMatchObject({ ok: true, rawArgs: "第二个强盗" });
    expect(table.match("打 强盗")).toMatchObject({ ok: true, rawArgs: "强盗" });
    expect(table.match("打\u3000强盗")).toMatchObject({ ok: true, rawArgs: "强盗" });
  });

  it("fails with a semantic reason code on empty input and unknown verbs", () => {
    const table = createVerbTable([{ verb: "打", commandKey: "cmd-attack" }]);

    expect(table.match("")).toEqual({ ok: false, reason: "emptyInput" });
    expect(table.match("   ")).toEqual({ ok: false, reason: "emptyInput" });
    expect(table.match("睡觉")).toEqual({ ok: false, reason: "unknownVerb" });
  });

  it("rejects ambiguous registration: the same verb may not point at two commands", () => {
    expect(() =>
      createVerbTable([
        { verb: "打", commandKey: "cmd-attack" },
        { verb: "打", commandKey: "cmd-beat" },
      ]),
    ).toThrow(/cmd-attack.*cmd-beat/);

    // Same verb, same key is an idempotent registration, not a conflict.
    expect(() =>
      createVerbTable([
        { verb: "打", commandKey: "cmd-attack" },
        { verb: "打", commandKey: "cmd-attack" },
      ]),
    ).not.toThrow();
  });

  it("rejects empty verbs and empty command keys at build time", () => {
    expect(() => createVerbTable([{ verb: "  ", commandKey: "cmd-x" }])).toThrow(/empty verb/i);
    expect(() => createVerbTable([{ verb: "打", commandKey: " " }])).toThrow(/empty commandKey/i);
  });

  it("matches against a verb registered with padding by trimming it first", () => {
    const table = createVerbTable([{ verb: " 打 ", commandKey: "cmd-attack" }]);
    expect(table.match("打强盗")).toMatchObject({ ok: true, verb: "打", rawArgs: "强盗" });
  });
});

describe("arg forms: declarative, per command entry (spec/02 §1.2–§1.3)", () => {
  it("none: empty arg parses to null; a leftover arg is invalid", () => {
    expect(parseArgForm("none", "")).toEqual({ ok: true, args: null });
    expect(parseArgForm("none", "  ")).toEqual({ ok: true, args: null });
    expect(parseArgForm("none", "多余")).toEqual({ ok: false, reason: "unexpectedArg" });
  });

  it("text: the whole remainder is the argument, untouched", () => {
    expect(parseArgForm("text", " 你好， 世界 ")).toEqual({ ok: true, args: "你好， 世界" });
    expect(parseArgForm("text", "")).toEqual({ ok: true, args: "" });
  });

  it("target: a bare noun defaults to the first match", () => {
    expect(parseArgForm("target", "强盗")).toEqual({ ok: true, args: { noun: "强盗", ordinal: 1 } });
    expect(parseArgForm("target", "")).toEqual({ ok: false, reason: "missingTarget" });
  });

  it("target-ordinal: 「第 N 个 X」 resolves noun and ordinal (A5)", () => {
    expect(parseArgForm("target-ordinal", "第2个强盗")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 2 },
    });
    // Spaces inside the form are tolerated.
    expect(parseArgForm("target-ordinal", "第 2 个 强盗")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 2 },
    });
    // A bare noun still works, defaulting to the first match.
    expect(parseArgForm("target-ordinal", "强盗")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 1 },
    });
  });

  it("target-ordinal: accepts Chinese numerals, Arabic digits and full-width digits", () => {
    expect(parseArgForm("target-ordinal", "第三个强盗")).toMatchObject({ args: { ordinal: 3 } });
    expect(parseArgForm("target-ordinal", "第十一个强盗")).toMatchObject({ args: { ordinal: 11 } });
    expect(parseArgForm("target-ordinal", "第二十三个强盗")).toMatchObject({ args: { ordinal: 23 } });
    expect(parseArgForm("target-ordinal", "第两个强盗")).toMatchObject({ args: { ordinal: 2 } });
    expect(parseArgForm("target-ordinal", "第12个强盗")).toMatchObject({ args: { ordinal: 12 } });
    expect(parseArgForm("target-ordinal", "第１２个强盗")).toMatchObject({ args: { ordinal: 12 } });
  });

  it("target-ordinal: malformed ordinals fail with semantic reason codes", () => {
    expect(parseArgForm("target-ordinal", "第0个强盗")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-ordinal", "第零个强盗")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-ordinal", "第个强盗")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-ordinal", "第百个强盗")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-ordinal", "第-1个强盗")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-ordinal", "第2个")).toEqual({ ok: false, reason: "missingNoun" });
    expect(parseArgForm("target-ordinal", "")).toEqual({ ok: false, reason: "missingTarget" });
  });

  it("target-index: 「X·N」 resolves noun and ordinal (A5)", () => {
    expect(parseArgForm("target-index", "强盗·2")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 2 },
    });
    // The katakana middle dot is accepted as the same separator.
    expect(parseArgForm("target-index", "强盗・3")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 3 },
    });
    // Chinese numerals work here too; spaces around the dot are tolerated.
    expect(parseArgForm("target-index", "强盗 · 三")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 3 },
    });
    // Bare noun defaults to the first match.
    expect(parseArgForm("target-index", "强盗")).toEqual({
      ok: true,
      args: { noun: "强盗", ordinal: 1 },
    });
    // The noun itself may contain a dot: the LAST dot is the separator.
    expect(parseArgForm("target-index", "铁·蛋·2")).toEqual({
      ok: true,
      args: { noun: "铁·蛋", ordinal: 2 },
    });
  });

  it("target-index: malformed indexes fail with semantic reason codes", () => {
    expect(parseArgForm("target-index", "强盗·")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "强盗·x")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "强盗·0")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "强盗·零")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "·2")).toEqual({ ok: false, reason: "missingNoun" });
    expect(parseArgForm("target-index", "")).toEqual({ ok: false, reason: "missingTarget" });
  });

  it("parses Chinese numerals from 一 through 九十九", () => {
    const cases: Record<string, number> = {
      一: 1, 二: 2, 两: 2, 九: 9, 十: 10, 十一: 11, 十九: 19,
      二十: 20, 二十九: 29, 九十九: 99,
    };
    for (const [text, value] of Object.entries(cases)) {
      expect(parseArgForm("target-index", `强盗·${text}`)).toEqual({
        ok: true,
        args: { noun: "强盗", ordinal: value },
      });
    }
    // Beyond 九十九 or otherwise malformed: not a numeral we know.
    expect(parseArgForm("target-index", "强盗·百")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "强盗·十十")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "强盗·二十十")).toEqual({ ok: false, reason: "badOrdinal" });
    expect(parseArgForm("target-index", "强盗·2三")).toEqual({ ok: false, reason: "badOrdinal" });
  });
});

describe("pipeline parse stage integration (issue #2: 接入 M1-T1 管线)", () => {
  const world: TestWorld = { room: "room-1" };

  function deps(verbs?: ReturnType<typeof createVerbTable>) {
    return { clock: createTestClock(), rng: createSeededRng(1), world, sink: noopSink, verbs };
  }

  it("cuts the verb inside the pipeline and parses the arg per the spec's argForm", () => {
    const seen: unknown[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "cmd-attack",
      argForm: "target-ordinal",
      func: (ctx) => {
        seen.push(ctx.args);
        ctx.emit("actor-1", { type: "attacked" });
      },
    };
    const table = createVerbTable([
      { verb: "打", commandKey: "cmd-attack" },
      { verb: "杀", commandKey: "cmd-kill" },
    ]);

    const result = runCommand(spec, { seq: 1, actorId: "actor-1", raw: "打第二个强盗" }, deps(table));

    expect(result).toMatchObject({ ok: true, seq: 1 });
    expect(seen).toEqual([{ noun: "强盗", ordinal: 2 }]);
  });

  it("guards the longest-match winner: an input whose verb resolves elsewhere is invalid", () => {
    const spec: CommandSpec<TestWorld> = {
      key: "cmd-laugh",
      argForm: "none",
      func: (ctx) => ctx.emit("actor-1", { type: "shouldNotHappen" }),
    };
    const table = createVerbTable([
      { verb: "笑", commandKey: "cmd-laugh" },
      { verb: "笑傲江湖", commandKey: "cmd-swordplay" },
    ]);

    const result = runCommand(spec, { seq: 1, actorId: "actor-1", raw: "笑傲江湖" }, deps(table));

    // 笑傲江湖 is the longest match and belongs to another command: running
    // cmd-laugh with this input is a dispatch error, reported as invalid.
    expect(result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: "verbMismatch" });
  });

  it("maps unknown verbs and empty input to invalid with the parser's reason codes", () => {
    const spec: CommandSpec<TestWorld> = { key: "cmd-attack", argForm: "none", func: () => {} };
    const table = createVerbTable([{ verb: "打", commandKey: "cmd-attack" }]);

    expect(runCommand(spec, { seq: 1, actorId: "actor-1", raw: "睡觉" }, deps(table))).toEqual({
      ok: false,
      seq: 1,
      kind: "invalid",
      reason: "unknownVerb",
    });
    expect(runCommand(spec, { seq: 2, actorId: "actor-1", raw: "  " }, deps(table))).toEqual({
      ok: false,
      seq: 2,
      kind: "invalid",
      reason: "emptyInput",
    });
  });

  it("rejects an argForm spec when no verb table was wired: programmer error, thrown loudly", () => {
    const spec: CommandSpec<TestWorld> = { key: "cmd-attack", argForm: "none", func: () => {} };

    expect(() => runCommand(spec, { seq: 1, actorId: "actor-1", raw: "打" }, deps())).toThrow(
      /cmd-attack.*argForm.*verb table/,
    );
  });

  it("an explicit parse hook still overrides the engine's argForm parsing", () => {
    const seen: unknown[] = [];
    const spec: CommandSpec<TestWorld> = {
      key: "cmd-attack",
      argForm: "none", // would reject the leftover arg
      parse: (_ctx, rawArgs) => ({ ok: true, args: `custom:${rawArgs}` }),
      func: (ctx) => void seen.push(ctx.args),
    };
    const table = createVerbTable([{ verb: "打", commandKey: "cmd-attack" }]);

    const result = runCommand(spec, { seq: 1, actorId: "actor-1", raw: "打 强盗" }, deps(table));

    expect(result).toMatchObject({ ok: true });
    // The hook receives the FULL raw input — its contract since M1-T1.
    expect(seen).toEqual(["custom:打 强盗"]);
  });

  it("keeps the M1-T1 default: no parse hook and no argForm means whole input is the args", () => {
    const seen: unknown[] = [];
    const spec: CommandSpec<TestWorld> = { key: "cmd-legacy", func: (ctx) => void seen.push(ctx.args) };

    const result = runCommand(spec, { seq: 1, actorId: "actor-1", raw: "原样参数" }, deps());

    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual(["原样参数"]);
  });
});

describe("call() full chain through the harness (issue #2: 全链路可用)", () => {
  const verbs = [
    { verb: "打", commandKey: "cmd-attack" },
    { verb: "杀", commandKey: "cmd-attack" },
    { verb: "笑", commandKey: "cmd-laugh" },
    { verb: "笑傲江湖", commandKey: "cmd-swordplay" },
  ];

  function attackSpec(seen: unknown[]): CommandSpec<TestWorld> {
    return {
      key: "cmd-attack",
      argForm: "target-ordinal",
      func: (ctx) => {
        seen.push(ctx.args);
        ctx.emit("actor-1", { type: "attackLaunched", args: ctx.args });
      },
    };
  }

  it("drives 打第二个强盗 from raw input to events with parsed args", () => {
    const seen: unknown[] = [];
    const harness = createCommandHarness<TestWorld>({
      world: { room: "room-1" },
      receivers: ["actor-1"],
      verbs,
    });

    const out = harness.call(attackSpec(seen), "打第二个强盗");

    expect(out.result).toMatchObject({ ok: true, seq: 1 });
    expect(seen).toEqual([{ noun: "强盗", ordinal: 2 }]);
    expect(out.messages).toEqual([
      {
        to: "actor-1",
        event: {
          seq: 1,
          type: "attackLaunched",
          actorId: "actor-1",
          args: { noun: "强盗", ordinal: 2 },
        },
      },
    ]);
  });

  it("the collision demo through call(): 笑傲江湖 reaches the swordplay spec, not the laugh spec", () => {
    const laughRan: string[] = [];
    const swordplayRan: string[] = [];
    const laugh: CommandSpec<TestWorld> = {
      key: "cmd-laugh",
      argForm: "none",
      func: (ctx) => {
        laughRan.push("ran");
        ctx.emit("actor-1", { type: "laughed" });
      },
    };
    const swordplay: CommandSpec<TestWorld> = {
      key: "cmd-swordplay",
      argForm: "none",
      func: (ctx) => {
        swordplayRan.push("ran");
        ctx.emit("actor-1", { type: "swordplay" });
      },
    };
    const harness = createCommandHarness<TestWorld>({
      world: { room: "room-1" },
      receivers: ["actor-1"],
      verbs,
    });

    const wrongCall = harness.call(laugh, "笑傲江湖");
    const rightCall = harness.call(swordplay, "笑傲江湖");

    expect(wrongCall.result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: "verbMismatch" });
    expect(wrongCall.messages).toEqual([]);
    expect(laughRan).toEqual([]);

    expect(rightCall.result).toMatchObject({ ok: true, seq: 2 });
    expect(swordplayRan).toEqual(["ran"]);
  });

  it("an unparseable input returns invalid, emits nothing and runs nothing", () => {
    const seen: unknown[] = [];
    const harness = createCommandHarness<TestWorld>({
      world: { room: "room-1" },
      receivers: ["actor-1"],
      verbs,
    });

    const out = harness.call(attackSpec(seen), "打第个强盗");

    expect(out.result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: "badOrdinal" });
    expect(out.messages).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("English verbs route the same full chain (A4: 中英并列)", () => {
    const seen: unknown[] = [];
    const localVerbs = [
      { verb: "北", commandKey: "cmd-north" },
      { verb: "n", commandKey: "cmd-north" },
    ];
    const north: CommandSpec<TestWorld> = {
      key: "cmd-north",
      argForm: "none",
      func: (ctx) => {
        seen.push("moved");
        ctx.emit("actor-1", { type: "moved", to: "room-2" });
      },
    };
    const harness = createCommandHarness<TestWorld>({
      world: { room: "room-1" },
      receivers: ["actor-1"],
      verbs: localVerbs,
    });

    expect(harness.call(north, "n").result).toMatchObject({ ok: true });
    expect(harness.call(north, "北").result).toMatchObject({ ok: true });
    expect(seen).toEqual(["moved", "moved"]);
  });
});
