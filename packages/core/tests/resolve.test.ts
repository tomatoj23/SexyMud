import { describe, expect, it } from "vitest";
import { mergeCmdSets } from "../src/command/cmdset.js";
import type { CmdSetSource } from "../src/command/cmdset.js";
import { createVerbTable } from "../src/command/parser.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import { resolve, verbTableFrom } from "../src/command/resolve.js";
import type { CommandBinding } from "../src/command/resolve.js";

/**
 * The one resolve step (issue #38): input → which spec — match the verb,
 * look the key up, bind the behaviour (绑行为 / bindSpec). Two faces are
 * pinned here: the failure classification as ONE rule (player typo ⇒
 * `invalid` + reason code, wiring bug ⇒ throw — collected copies inherit it)
 * and the two binding forms on one parameter face (already-built spec /
 * thunk factory, only the matched key's thunk ever runs). The argument half
 * (绑参数 / parseArgs) is the pipeline parse stage's and not this module's.
 *
 * All sources, verbs and keys below are TEST FIXTURE DATA standing in for
 * content; the engine knows none of them (the engine-purity suite guards
 * src/).
 */

const characterSource: CmdSetSource = {
  priority: 0,
  commands: [
    { key: "cmd-look", verbs: ["看", "look"] },
    { key: "cmd-attack", verbs: ["打", "attack"] },
  ],
};

/** Exits on top of the stack; 北 carries the long form too (longest match). */
const exitsSource: CmdSetSource = {
  priority: 101,
  commands: [
    { key: "exit-north", verbs: ["北", "n", "north", "往北走"] },
    { key: "exit-south", verbs: ["南", "s", "south"] },
  ],
};

function specOf(key: string): CommandSpec {
  return { key, argForm: "none", func: () => {} };
}

describe("resolve — match → lookup → bind the behaviour (issue #38 D1/D2)", () => {
  it("an empty input is an invalid outcome, never a throw", () => {
    const outcome = resolve("   ", verbTableFrom([characterSource]), new Map());
    expect(outcome).toEqual({ ok: false, reason: "emptyInput" });
  });

  it("an unknown verb is an invalid outcome carrying its reason", () => {
    const outcome = resolve("摸", verbTableFrom([characterSource]), new Map());
    expect(outcome).toEqual({ ok: false, reason: "unknownVerb" });
  });

  it("binds an already-built spec as-is and carries the matched verb through", () => {
    const spec = specOf("cmd-attack");
    const outcome = resolve("打 张三", verbTableFrom([characterSource]), new Map([
      ["cmd-attack", spec],
    ]));
    expect(outcome).toEqual({
      ok: true,
      match: { ok: true, verb: "打", commandKey: "cmd-attack", rawArgs: "张三" },
      spec,
    });
    if (outcome.ok) {
      expect(outcome.spec).toBe(spec);
    }
  });

  it("instantiates a thunk binding lazily — only the matched key's", () => {
    const built: string[] = [];
    const bindings = new Map<string, CommandBinding>([
      ["cmd-look", () => (built.push("cmd-look"), specOf("cmd-look"))],
      ["cmd-attack", () => (built.push("cmd-attack"), specOf("cmd-attack"))],
    ]);
    const outcome = resolve("看", verbTableFrom([characterSource]), bindings);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.spec.key).toBe("cmd-look");
    }
    expect(built).toEqual(["cmd-look"]);
  });

  it("a matched verb routed to a key with no binding throws — wiring, not play", () => {
    expect(() => resolve("打", verbTableFrom([characterSource]), new Map())).toThrow(
      /no spec bound to command key "cmd-attack"/,
    );
  });

  it("matches the LONGEST registered verb — the engine rule the collected copies now share", () => {
    const outcome = resolve(
      "往北走",
      verbTableFrom([characterSource, exitsSource]),
      new Map([["exit-north", specOf("exit-north")]]),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.match).toEqual({
        ok: true,
        verb: "往北走",
        commandKey: "exit-north",
        rawArgs: "",
      });
    }
  });
});

describe("verbTableFrom — the sources → table chain (issue #38 D5)", () => {
  it("is mergeCmdSets → verbEntries → createVerbTable, edge to edge", () => {
    const sources = [
      characterSource,
      { priority: 0, commands: [{ key: "cmd-push", verbs: ["推"] }] },
      exitsSource,
    ];
    const viaHelper = verbTableFrom(sources);
    const viaChain = createVerbTable(mergeCmdSets(sources).verbEntries());
    expect(viaHelper.verbs).toEqual(viaChain.verbs);
    for (const input of ["看", "打 张三", "推", "北", "摸"]) {
      expect(viaHelper.match(input), input).toEqual(viaChain.match(input));
    }
  });

  it("re-merges per call and never caches: a later call sees the changed sources", () => {
    const sources: CmdSetSource[] = [characterSource];
    const first = verbTableFrom(sources);
    sources.push({
      priority: 5,
      mergetype: "Remove",
      commands: [{ key: "cmd-attack" }],
    });
    const second = verbTableFrom(sources);

    expect(second).not.toBe(first);
    // The later merge lost 打; the table assembled before it is unaffected.
    expect(second.match("打")).toEqual({ ok: false, reason: "unknownVerb" });
    expect(first.match("打")).toMatchObject({ ok: true, commandKey: "cmd-attack" });
  });
});
