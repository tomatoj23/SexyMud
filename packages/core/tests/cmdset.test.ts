import { describe, expect, it } from "vitest";
import { mergeCmdSets } from "../src/command/cmdset.js";
import type { CmdSetSource } from "../src/command/cmdset.js";
import { createVerbTable } from "../src/command/parser.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import { createCommandHarness } from "../src/command/testing.js";

/**
 * The cmdset merge stack (spec/02 §3, ADR-0021 §1): available commands are
 * the per-dispatch product of merging multiple sources by priority — never
 * a fixed table. All sources, priorities, mergetypes and verbs below are
 * TEST FIXTURE DATA standing in for content; the engine itself knows none
 * of them (the engine-purity suite guards src/).
 *
 * Semantics under test (Evennia's CmdSet fold, made total and deterministic):
 *
 * - sources stable-sorted by priority ascending, folded left onto an EMPTY
 *   accumulator — "group by priority, pairwise within group, ascending
 *   across groups" is exactly this fold; within one group the input order
 *   is the merge order and the later source merges on top
 * - the INCOMING source's mergetype applies to the accumulated result
 * - Union (default) / Intersect / Replace / Remove
 * - merged command order = order of last introduction; verb collisions
 *   between different keys resolve to the LATER-merged command, which is
 *   how an exit source at the top priority stays available
 */

interface TestWorld {
  room: string;
}

/** A character's everyday commands (priority 0, the common baseline). */
const characterSource: CmdSetSource = {
  priority: 0,
  commands: [
    { key: "cmd-look", verbs: ["看", "look"] },
    { key: "cmd-attack", verbs: ["打", "attack"] },
  ],
};

/**
 * The canonical dark room (ADR-0021 §1): a room-level set that REPLACES the
 * character set — modified look plus one way out of the dark.
 */
const darkRoomSource: CmdSetSource = {
  priority: 0,
  mergetype: "Replace",
  commands: [
    { key: "cmd-look", verbs: ["看", "look"] },
    { key: "cmd-light", verbs: ["点灯", "light"] },
  ],
};

/** Exits at the top of the stack: direction words, always available. */
const exitsSource: CmdSetSource = {
  priority: 101,
  commands: [
    { key: "exit-north", verbs: ["北", "n", "north"] },
    { key: "exit-south", verbs: ["南", "s", "south"] },
  ],
};

function keysOf(merged: { commands: ReadonlyArray<{ key: string }> }): string[] {
  return merged.commands.map((command) => command.key);
}

describe("cmdset merge stack: fold order (spec/02 §3)", () => {
  it("merges in ascending priority order, not input order", () => {
    // Sources deliberately listed in the WRONG order: the exit source
    // first, then the character, then the player. Priority, not position,
    // decides the fold — the player's set merges first, the exits last.
    const playerSource: CmdSetSource = {
      priority: -10,
      commands: [{ key: "cmd-alias", verbs: ["别名", "alias"] }],
    };
    const merged = mergeCmdSets([exitsSource, characterSource, playerSource]);

    expect(keysOf(merged)).toEqual([
      "cmd-alias",
      "cmd-look",
      "cmd-attack",
      "exit-north",
      "exit-south",
    ]);
  });

  it("folds same-priority sources pairwise in input order: the later one merges on top", () => {
    // Same-priority group [character, dark room]: the dark room is second,
    // its Replace discards the character commands.
    const withDarkLast = mergeCmdSets([characterSource, darkRoomSource]);
    expect(keysOf(withDarkLast)).toEqual(["cmd-look", "cmd-light"]);

    // Same two sources, input order flipped: now the dark room folds FIRST
    // and the character's Union merges on top — its look payload wins the
    // shared key, its attack is added, and cmd-light survives (with the
    // character's cmd-look re-introduced after it: last-introduction order).
    const withDarkFirst = mergeCmdSets([darkRoomSource, characterSource]);
    expect(keysOf(withDarkFirst)).toEqual(["cmd-light", "cmd-look", "cmd-attack"]);
  });

  it("orders merged commands by last introduction: a same-key override moves to the end", () => {
    const merged = mergeCmdSets([
      {
        priority: 0,
        commands: [
          { key: "cmd-a", verbs: ["a"] },
          { key: "cmd-b", verbs: ["b"] },
        ],
      },
      { priority: 10, commands: [{ key: "cmd-a", verbs: ["a2"] }] },
    ]);

    // cmd-b keeps its earlier position; the incoming cmd-a is introduced
    // later, so it lands after it — merge position drives verb ownership.
    expect(merged.commands).toEqual([
      { key: "cmd-b", verbs: ["b"] },
      { key: "cmd-a", verbs: ["a2"] },
    ]);
  });

  it("merges an empty source list into an empty cmdset", () => {
    const merged = mergeCmdSets([]);
    expect(merged.commands).toEqual([]);
    expect(merged.verbEntries()).toEqual([]);
  });
});

describe("cmdset merge stack: the four mergetypes (spec/02 §3)", () => {
  it("Union is the default when mergetype is omitted", () => {
    const merged = mergeCmdSets([
      { priority: -10, commands: [{ key: "cmd-alias", verbs: ["别名"] }] },
      { priority: 0, commands: [{ key: "cmd-attack", verbs: ["打"] }] },
    ]);
    expect(keysOf(merged)).toEqual(["cmd-alias", "cmd-attack"]);
  });

  it("Union keeps both sets' commands, the incoming payload replacing a same-key command WHOLE", () => {
    const merged = mergeCmdSets([
      { priority: 0, commands: [{ key: "cmd-look", verbs: ["看", "look"] }] },
      { priority: 10, commands: [{ key: "cmd-look", verbs: ["摸黑", "grop"] }] },
    ]);

    // Replacement is wholesale: 看 does NOT survive from the lower source,
    // because the incoming entry's verbs are the whole payload.
    expect(merged.commands).toEqual([{ key: "cmd-look", verbs: ["摸黑", "grop"] }]);
    expect(merged.verbEntries()).toEqual([
      { verb: "摸黑", commandKey: "cmd-look" },
      { verb: "grop", commandKey: "cmd-look" },
    ]);
  });

  it("Intersect keeps only keys present in both, taking the incoming versions", () => {
    const merged = mergeCmdSets([
      {
        priority: 0,
        commands: [
          { key: "cmd-look", verbs: ["看"] },
          { key: "cmd-attack", verbs: ["打"] },
        ],
      },
      {
        priority: 10,
        mergetype: "Intersect",
        commands: [
          { key: "cmd-look", verbs: ["摸黑"] },
          { key: "cmd-pray", verbs: ["参拜"] },
        ],
      },
    ]);

    // cmd-attack is only in the accumulated set, cmd-pray only in the
    // incoming one — both drop. The shared cmd-look survives with the
    // incoming payload.
    expect(merged.commands).toEqual([{ key: "cmd-look", verbs: ["摸黑"] }]);
  });

  it("Replace discards the accumulated result, then higher sources still merge on top", () => {
    const merged = mergeCmdSets([
      {
        priority: -10,
        commands: [{ key: "cmd-alias", verbs: ["别名"] }],
      },
      {
        priority: 0,
        mergetype: "Replace",
        commands: [{ key: "cmd-look", verbs: ["摸黑"] }],
      },
      { priority: 101, commands: [{ key: "exit-north", verbs: ["北"] }] },
    ]);

    // The Replace wipes everything below it (alias included) but cannot
    // touch the exit source above it.
    expect(keysOf(merged)).toEqual(["cmd-look", "exit-north"]);
  });

  it("Remove is a pure filter: it drops named keys and contributes nothing", () => {
    const merged = mergeCmdSets([
      {
        priority: 0,
        commands: [
          { key: "cmd-look", verbs: ["看"] },
          { key: "cmd-attack", verbs: ["打"] },
        ],
      },
      {
        priority: 10,
        mergetype: "Remove",
        commands: [{ key: "cmd-attack", verbs: ["打"] }],
      },
    ]);
    expect(merged.commands).toEqual([{ key: "cmd-look", verbs: ["看"] }]);
  });

  it("Remove only affects what is accumulated BELOW it: a later source re-adds the key", () => {
    const merged = mergeCmdSets([
      { priority: 0, commands: [{ key: "cmd-attack", verbs: ["打"] }] },
      { priority: 0, mergetype: "Remove", commands: [{ key: "cmd-attack" }] },
      { priority: 101, commands: [{ key: "cmd-attack", verbs: ["击"] }] },
    ]);

    // Within group 0 the Remove deletes the attack command; the exit-level
    // source merges after and brings it back.
    expect(merged.commands).toEqual([{ key: "cmd-attack", verbs: ["击"] }]);
  });

  it("starts from an empty accumulator, so a lone Remove or Intersect set yields nothing", () => {
    // Divergence from Evennia (whose fold seeds with the first set):
    // against an empty result a filter set filters nothing — its commands
    // are a removal list, not an offering. All four operators stay total.
    const loneRemove = mergeCmdSets([
      { priority: 0, mergetype: "Remove", commands: [{ key: "cmd-attack", verbs: ["打"] }] },
    ]);
    expect(loneRemove.commands).toEqual([]);

    const loneIntersect = mergeCmdSets([
      { priority: 0, mergetype: "Intersect", commands: [{ key: "cmd-look", verbs: ["看"] }] },
    ]);
    expect(loneIntersect.commands).toEqual([]);
  });
});

describe("cmdset merge stack: exits stay available (spec/02 §3, ADR-0021 §1)", () => {
  it("survives a mid-stack Replace: the dark room cannot seal the exits", () => {
    const merged = mergeCmdSets([characterSource, darkRoomSource, exitsSource]);

    // The dark room's Replace wipes the character commands, but the exit
    // source merges last: 北/n/north and 南/s/south all stay addressable.
    expect(keysOf(merged)).toEqual(["cmd-look", "cmd-light", "exit-north", "exit-south"]);
    const table = createVerbTable(merged.verbEntries());
    expect(table.match("北")).toMatchObject({ ok: true, commandKey: "exit-north" });
    expect(table.match("n")).toMatchObject({ ok: true, commandKey: "exit-north" });
    expect(table.match("south")).toMatchObject({ ok: true, commandKey: "exit-south" });
    // And what the Replace removed is really gone.
    expect(table.match("打")).toEqual({ ok: false, reason: "unknownVerb" });
  });

  it("owns a colliding verb over a lower-priority command: the merge stack resolves ownership", () => {
    // A room object tries to claim the direction verb 北 for itself.
    const shadowingSource: CmdSetSource = {
      priority: 0,
      commands: [{ key: "cmd-fight-north", verbs: ["北"] }],
    };
    const merged = mergeCmdSets([shadowingSource, exitsSource]);

    // Both commands survive the Union (different keys)...
    expect(keysOf(merged)).toEqual(["cmd-fight-north", "exit-north", "exit-south"]);

    // ...but the verb table stays unambiguous: the exit, merged last, owns 北.
    expect(merged.verbEntries()).toEqual([
      { verb: "北", commandKey: "exit-north" },
      { verb: "n", commandKey: "exit-north" },
      { verb: "north", commandKey: "exit-north" },
      { verb: "南", commandKey: "exit-south" },
      { verb: "s", commandKey: "exit-south" },
      { verb: "south", commandKey: "exit-south" },
    ]);

    // The hand-built table would have thrown on this pair (parser.ts:
    // the merge stack must resolve which command owns a verb before it
    // reaches dispatch) — the merge product resolves it instead.
    expect(() =>
      createVerbTable([
        { verb: "北", commandKey: "cmd-fight-north" },
        { verb: "北", commandKey: "exit-north" },
      ]),
    ).toThrow();
    expect(() => createVerbTable(merged.verbEntries())).not.toThrow();
  });

  it("resolves a same-priority verb collision by input order: the later source wins", () => {
    const merged = mergeCmdSets([
      { priority: 0, commands: [{ key: "cmd-room-push", verbs: ["推"] }] },
      { priority: 0, commands: [{ key: "cmd-object-push", verbs: ["推"] }] },
    ]);
    expect(merged.verbEntries()).toEqual([{ verb: "推", commandKey: "cmd-object-push" }]);
  });

  it("resolves a within-source verb collision by declaration order: the later entry wins", () => {
    // One rule everywhere: later merge position owns a colliding verb. Within
    // one source the declaration order is that position — the same uniform
    // resolution as same-priority sources, not a special case.
    const merged = mergeCmdSets([
      {
        priority: 0,
        commands: [
          { key: "cmd-room-push", verbs: ["推"] },
          { key: "cmd-object-push", verbs: ["推"] },
        ],
      },
    ]);
    expect(merged.verbEntries()).toEqual([{ verb: "推", commandKey: "cmd-object-push" }]);
  });
});

describe("cmdset merge stack: validation", () => {
  it("rejects a non-integer priority", () => {
    expect(() => mergeCmdSets([{ priority: 1.5, commands: [] }])).toThrow(/priority/);
    expect(() => mergeCmdSets([{ priority: Number.NaN, commands: [] }])).toThrow(/priority/);
  });

  it("rejects an unknown mergetype", () => {
    expect(() =>
      mergeCmdSets([
        { priority: 0, mergetype: "union" as unknown as "Union", commands: [] },
      ]),
    ).toThrow(/mergetype/);
  });

  it("rejects an empty key or an empty verb", () => {
    expect(() =>
      mergeCmdSets([{ priority: 0, commands: [{ key: "  ", verbs: ["打"] }] }]),
    ).toThrow(/key/);
    expect(() =>
      mergeCmdSets([{ priority: 0, commands: [{ key: "cmd", verbs: [" "] }] }]),
    ).toThrow(/verb/);
  });

  it("replaces a duplicate key within one source: the last entry wins", () => {
    // Evennia's CmdSet.add(): a same-key command replaces the earlier one.
    const merged = mergeCmdSets([
      {
        priority: 0,
        commands: [
          { key: "cmd-look", verbs: ["看"] },
          { key: "cmd-look", verbs: ["瞧"] },
        ],
      },
    ]);
    expect(merged.commands).toEqual([{ key: "cmd-look", verbs: ["瞧"] }]);
  });

  it("dedupes repeated verbs within one command and trims surrounding whitespace", () => {
    const merged = mergeCmdSets([
      { priority: 0, commands: [{ key: "cmd-attack", verbs: ["打", " 打 ", "attack"] }] },
    ]);
    expect(merged.commands).toEqual([{ key: "cmd-attack", verbs: ["打", "attack"] }]);
    expect(merged.verbEntries()).toEqual([
      { verb: "打", commandKey: "cmd-attack" },
      { verb: "attack", commandKey: "cmd-attack" },
    ]);
  });
});

describe("cmdset merge product as the parser's verb table source (issue #4)", () => {
  const lookSpec: CommandSpec<TestWorld> = {
    key: "cmd-look",
    argForm: "none",
    func: (ctx) => {
      ctx.emit(ctx.command.actorId, { type: "looked" });
    },
  };

  const attackSpec: CommandSpec<TestWorld> = {
    key: "cmd-attack",
    argForm: "target",
    func: (ctx) => {
      ctx.emit(ctx.command.actorId, { type: "attacked" });
    },
  };

  const exitSpec: CommandSpec<TestWorld> = {
    key: "exit-north",
    argForm: "none",
    func: (ctx) => {
      ctx.emit(ctx.command.actorId, { type: "moved", direction: "north" });
    },
  };

  function darkRoomHarness() {
    return createCommandHarness<TestWorld>({
      world: { room: "dark-cellar" },
      receivers: ["actor-1"],
      cmdsets: [characterSource, darkRoomSource, exitsSource],
    });
  }

  it("drives the parse stage end to end through the harness cmdsets option", () => {
    const harness = darkRoomHarness();

    // 看 dispatches the dark room's replacement look.
    expect(harness.call(lookSpec, "看").result).toMatchObject({ ok: true });
    // 北 reaches the exit that survived the mid-stack Replace.
    expect(harness.call(exitSpec, "北").result).toMatchObject({ ok: true });
    expect(harness.call(exitSpec, "north").result).toMatchObject({ ok: true });
    // The character's 打 was wiped by the Replace: unknown verb.
    expect(harness.call(attackSpec, "打 强盗").result).toMatchObject({
      ok: false,
      kind: "invalid",
      reason: "unknownVerb",
    });
    // 北 does not belong to the attack spec: the commandKey guard turns the
    // mismatch into an invalid dispatch instead of running the wrong command.
    expect(harness.call(attackSpec, "北").result).toMatchObject({
      ok: false,
      kind: "invalid",
      reason: "verbMismatch",
    });
  });

  it("parses a target through a verb that survived the merge", () => {
    const harness = createCommandHarness<TestWorld>({
      world: { room: "courtyard" },
      receivers: ["actor-1"],
      cmdsets: [characterSource, exitsSource],
    });
    const outcome = harness.call(attackSpec, "打 张三");
    expect(outcome.result).toMatchObject({ ok: true });
  });

  it("rejects harness options that pass both verbs and cmdsets", () => {
    expect(() =>
      createCommandHarness<TestWorld>({
        world: { room: "x" },
        receivers: [],
        verbs: [{ verb: "打", commandKey: "cmd-attack" }],
        cmdsets: [characterSource],
      }),
    ).toThrow(/verbs.*cmdsets|cmdsets.*verbs/);
  });
});
