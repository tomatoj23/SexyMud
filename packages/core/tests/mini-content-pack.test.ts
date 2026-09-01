import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { commandSetSources } from "../src/command/entry.js";
import type { CommandEntry } from "../src/command/entry.js";
import { mergeCmdSets } from "../src/command/cmdset.js";
import { createVerbTable } from "../src/command/parser.js";
import type { CommandResult } from "../src/types.js";
import type { CommandSpec, Message } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import { createEntity } from "../src/world/entity.js";
import { lookSpec } from "../src/world/look.js";
import { saySpec } from "../src/world/say.js";
import { traversalSpec } from "../src/world/traverse.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";
import {
  MINI_PACK_DIR,
  foundIn,
  loadPack,
  packRegistry,
  packVocabulary,
} from "./fixtures/mini-content-pack.js";

/**
 * Acceptance criterion 2, mechanized (issue #12, spec/00, ADR-0026/0028 §2):
 * 「换一套非武侠内容，引擎不改一行代码」.
 *
 * A second, non-wuxia pack on disk (`tests/fixtures/mini-pack/`) runs the
 * SAME engine through the SAME assembly path the wuxia pack uses — directory
 * → registry → merge stack → factory adapters → state tree — and walks the
 * full M2 chain: 走（移动）／看（外观）／说（发言）, including a gated door
 * whose refusal copy lives in the mini pack's own JSON.
 *
 * Nothing here re-implements a behaviour: the three adapters are the engine's
 * factory specs (`traversalSpec` / `lookSpec` / `saySpec`), bound by the host
 * to whatever command id the pack happens to use. Two packs, two id sets, one
 * engine — and the last two tests prove neither pack's vocabulary ever
 * appears in the other's session.
 */

const WUXIA_PACK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content");
const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../schemas");

const RECEIVERS = ["actor-1", "actor-2", "actor-3"];

/**
 * The criterion is 「零武侠词」, which is stronger than "no word the wuxia
 * pack happens to declare": a pack could be steeped in wuxia and still pass
 * the cross-pack scan by using words the village does not contain. These are
 * the give-away words. They live HERE, with the assertion that uses them —
 * they are content-domain vocabulary, so they belong neither in the engine
 * (whose purity scanner guards `src/`, not fixtures) nor in the pack-agnostic
 * loader.
 */
const WUXIA_THEME_WORDS: readonly string[] = [
  "江湖",
  "门派",
  "武功",
  "内功",
  "心法",
  "招式",
  "秘籍",
  "掌门",
  "大侠",
  "少侠",
];

/**
 * A host's behaviour binding: which kernel behaviour each pack's command id
 * runs. The ids differ between packs, the adapters are the same three
 * objects — that binding table is the whole of "porting the engine to a new
 * pack", and it is data the host already owns (content.md: hosts bind
 * behaviour per command key).
 */
type Bindings = Readonly<Record<string, (entry: CommandEntry) => CommandSpec<WorldRuntime>>>;

const WUXIA_BINDINGS: Bindings = { "cmd-look": lookSpec, "cmd-say": saySpec };
const MINI_BINDINGS: Bindings = { "cmd-scan": lookSpec, "cmd-broadcast": saySpec };

interface DispatchOutcome {
  result: CommandResult;
  messages: Message[];
}

interface Session {
  readonly registry: ReturnType<typeof packRegistry>;
  readonly runtime: WorldRuntime;
  dispatch(actorId: string, input: string): DispatchOutcome;
}

/**
 * A host session over a live runtime, for ANY pack: each dispatch re-merges
 * the sources of the actor's current room (sources change with location) and
 * runs the spec the input resolves to — an exit's traversal adapter, or the
 * pack's bound look/say command. The seq counter is session-wide and
 * monotonic, as a real host's would be.
 */
function makeSession(
  rootDir: string,
  bindings: Bindings,
  placement: Readonly<Record<string, string>>,
): Session {
  const registry = packRegistry(rootDir);
  const runtime = createWorldRuntime({ registry });
  for (const [actorId, roomId] of Object.entries(placement)) {
    runtime.addEntity(createEntity(actorId), roomId);
  }
  let seq = 0;

  const dispatch = (actorId: string, input: string): DispatchOutcome => {
    const room = registry.room(runtime.locationOf(actorId));
    const sources = [...commandSetSources(registry.commands), ...commandSetSources(room.exits)];
    // The host's own dispatch step: the merged verb table picks the command
    // key, and the key decides which behaviour runs. Exits are commands, so
    // no special case is involved — an exit id and a command id are the same
    // kind of key here.
    const match = createVerbTable(mergeCmdSets(sources).verbEntries()).match(input);
    if (!match.ok) {
      throw new Error(
        `pack "${rootDir}": the verb table of room "${room.id}" does not match ` +
          `"${input}" (${match.reason})`,
      );
    }
    const exit = room.exits.find((candidate) => candidate.id === match.commandKey);
    const command = registry.commands.find((candidate) => candidate.id === match.commandKey);
    const spec =
      exit !== undefined
        ? traversalSpec(exit)
        : command !== undefined
          ? bindings[command.id]?.(command)
          : undefined;
    if (spec === undefined) {
      throw new Error(
        `pack "${rootDir}": no behaviour is bound to "${match.commandKey}" — ` +
          `the host binds the engine's adapters per command id`,
      );
    }
    seq += 1;
    const harness = createCommandHarness<WorldRuntime>({
      world: runtime,
      liveWorld: true,
      receivers: RECEIVERS,
      cmdsets: sources,
      subjectOf: (world, id) => world.subjectOf(id),
    });
    return harness.call(spec, input, { actorId, seq });
  };

  return { registry, runtime, dispatch };
}

/** The standard mini-pack stage: two crew in the docking collar, one in the habitat. */
function miniStage(): Session {
  return makeSession(MINI_PACK_DIR, MINI_BINDINGS, {
    "actor-1": "room-orb-001",
    "actor-2": "room-orb-001",
    "actor-3": "room-orb-002",
  });
}

/** One whole session's recorded output, flattened for the vocabulary scans. */
function transcript(steps: readonly DispatchOutcome[]): string {
  return JSON.stringify(steps.map((step) => step.messages));
}

describe("the mini pack assembles through the same host path (issue #12)", () => {
  it("loads files → registry → merge stack → verb table, reaching every command from its own verbs", () => {
    const registry = packRegistry(MINI_PACK_DIR);

    expect(registry.commands.map((command) => command.id)).toEqual([
      "cmd-broadcast",
      "cmd-scan",
    ]);
    expect(registry.rooms.map((room) => room.id)).toEqual([
      "room-orb-001",
      "room-orb-002",
      "room-orb-003",
    ]);
    expect(registry.npcs.map((npc) => npc.id)).toEqual(["npc-orb-001"]);
    // Exits are entities with global ids, indexed across rooms — not fields.
    expect(registry.exit("exit-orb-002-inboard").targetRoomId).toBe("room-orb-003");

    const room = registry.room("room-orb-002");
    const table = createVerbTable(
      mergeCmdSets([...commandSetSources(registry.commands), ...commandSetSources(room.exits)])
        .verbEntries(),
    );
    for (const entry of [...registry.commands, ...room.exits]) {
      const verb = entry.verbs[0];
      expect(verb, `${entry.id} declares verbs`).toBeDefined();
      const match = table.match(verb!);
      expect(match.ok, `verb "${verb}" of "${entry.id}"`).toBe(true);
      if (match.ok) {
        expect(match.commandKey).toBe(entry.id);
      }
    }
    // The English abbreviation dispatches the same command — verbs are data.
    const scan = table.match("scan");
    expect(scan.ok, "verb \"scan\"").toBe(true);
    if (scan.ok) {
      expect(scan.commandKey).toBe("cmd-scan");
    }
  });

  it("passes the shipped schemas: a second, non-wuxia pack clears the same hard gate", () => {
    const conditionSchema = JSON.parse(
      readFileSync(resolve(schemasDir, "condition.schema.json"), "utf8"),
    );
    const compile = (schema: object) => {
      const ajv = new Ajv({ allErrors: true });
      ajv.addSchema(conditionSchema);
      return ajv.compile(schema);
    };
    const validateCommands = compile(
      JSON.parse(readFileSync(resolve(schemasDir, "commands.schema.json"), "utf8")),
    );
    const validateRooms = compile(
      JSON.parse(readFileSync(resolve(schemasDir, "rooms.schema.json"), "utf8")),
    );
    const validateNpcs = compile(
      JSON.parse(readFileSync(resolve(schemasDir, "npcs.schema.json"), "utf8")),
    );

    const pack = loadPack(MINI_PACK_DIR);
    expect(pack.commands.length + pack.rooms.length + pack.npcs.length).toBe(6);
    for (const command of pack.commands) {
      expect(validateCommands(command), command.id).toBe(true);
    }
    for (const room of pack.rooms) {
      expect(validateRooms(room), room.id).toBe(true);
    }
    for (const npc of pack.npcs) {
      expect(validateNpcs(npc), npc.id).toBe(true);
    }
  });
});

describe("走 — the mini pack walks through the engine's traversal adapter", () => {
  it("crosses 对接舱 → 生活舱: the move lands, the departure and arrival are announced per receiver", () => {
    const { runtime, dispatch } = miniStage();

    const out = dispatch("actor-1", "前");

    expect(out.result).toEqual({ ok: true, seq: 1, events: expect.any(Array) });
    expect(runtime.locationOf("actor-1")).toBe("room-orb-002");
    expectMessageSequence(
      out.messages.filter((message) => message.to === "actor-1"),
      [
        {
          event: {
            type: "departed",
            entityId: "actor-1",
            fromLocationId: "room-orb-001",
            toLocationId: "room-orb-002",
            moveType: "traverse",
            viaExitId: "exit-orb-001-fore",
          },
        },
        { event: { type: "arrived", entityId: "actor-1", toLocationId: "room-orb-002" } },
      ],
    );
    // Per-receiver: the departure goes to the module the mover LEFT, the
    // arrival to the module they ENTERED — each side hears its own half.
    expectMessageSequence(out.messages.filter((message) => message.to === "actor-2"), [
      { event: { type: "departed", entityId: "actor-1", fromLocationId: "room-orb-001" } },
    ]);
    expectMessageSequence(out.messages.filter((message) => message.to === "actor-3"), [
      { event: { type: "arrived", entityId: "actor-1", toLocationId: "room-orb-002" } },
    ]);
  });

  it("refuses the gated 主控室 to a crew member with no clearance; the copy stays in the mini pack's JSON", () => {
    const { registry, runtime, dispatch } = miniStage();
    expect(dispatch("actor-1", "前").result.ok).toBe(true);

    const out = dispatch("actor-1", "内");

    // The room's enter gate denied (spec/03 §2): rejected consumes the seq,
    // and the refusal is content returned as an event (spec/01 §4).
    expect(out.result).toEqual({ ok: false, seq: 2, kind: "rejected", reason: "accessDenied" });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "accessDenied",
          commandKey: "exit-orb-002-inboard",
          accessType: "enter",
          errKey: "err_enter",
          roomId: "room-orb-003",
        },
      },
    ]);

    // Renderer role: the errKey locates the copy in the ROOM's data, and the
    // event never carries the rendered text (spec/01 §5.1).
    const copy = registry.room("room-orb-003").err_enter;
    expect(typeof copy).toBe("string");
    expect(copy as string).toContain("身份卡");
    expect(JSON.stringify(out.messages)).not.toContain(copy as string);
    // A refusal moves nobody.
    expect(runtime.locationOf("actor-1")).toBe("room-orb-002");
  });

  it("lets a cleared crew member through the very exit that refused the other", () => {
    const { runtime, dispatch } = miniStage();
    runtime.state.entities["actor-1"]!.flags = ["crew-clearance"];
    expect(dispatch("actor-1", "前").result.ok).toBe(true);

    const out = dispatch("actor-1", "内");

    expect(out.result.ok).toBe(true);
    expect(runtime.locationOf("actor-1")).toBe("room-orb-003");
    expectMessageSequence(out.messages.filter((message) => message.to === "actor-1"), [
      { event: { type: "departed", entityId: "actor-1", fromLocationId: "room-orb-002" } },
      { event: { type: "arrived", entityId: "actor-1", toLocationId: "room-orb-003" } },
    ]);
  });
});

describe("看 and 说 — the mini pack's own commands bound to the engine's factory adapters", () => {
  it("scans the docking collar: exits, static presence and occupants all come from the mini pack", () => {
    const { registry, dispatch } = miniStage();

    const out = dispatch("actor-1", "环视");

    expect(out.result).toEqual({ ok: true, seq: 1, events: expect.any(Array) });
    expectMessageSequence(out.messages.filter((message) => message.to === "actor-1"), [
      {
        event: {
          type: "appearance",
          roomId: "room-orb-001",
          exits: [
            { exitId: "exit-orb-001-fore", direction: "前", verbs: ["前", "fore", "f"] },
          ],
          // Static presence is the room's placement list, read straight from
          // content: the mini pack's own service robot.
          staticPresence: [{ id: "npc-orb-001", count: 1 }],
          occupants: ["actor-2"],
        },
      },
    ]);
    // A look is the looker's private perception; the same-module crew hears
    // nothing (unlike movement announcements).
    expect(out.messages.filter((message) => message.to === "actor-2")).toEqual([]);
    // Zero rendered text: room copy and entity names stay in data, reached by id.
    const room = registry.room("room-orb-001");
    expect(JSON.stringify(out.messages)).not.toContain(room.name);
    expect(JSON.stringify(out.messages)).not.toContain(room.description);
    expect(registry.npc("npc-orb-001").name).toBe("巡检机器人");
    expect(JSON.stringify(out.messages)).not.toContain("巡检机器人");
  });

  it("broadcasts to the crew in the same module only; the crew member in the next module hears nothing", () => {
    const { dispatch } = miniStage();

    const out = dispatch("actor-1", "通话 舱压正常，可以对接");

    expect(out.result).toEqual({ ok: true, seq: 1, events: expect.any(Array) });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "say",
          speakerId: "actor-1",
          text: "舱压正常，可以对接",
          locationId: "room-orb-001",
        },
      },
      {
        to: "actor-2",
        event: {
          type: "say",
          speakerId: "actor-1",
          text: "舱压正常，可以对接",
          locationId: "room-orb-001",
        },
      },
    ]);
    expect(out.messages.filter((message) => message.to === "actor-3")).toEqual([]);
    // The spoken line is the player's input verbatim — no stance, no quoting.
    expect(JSON.stringify(out.messages)).not.toContain("接通了");
  });

  it("is deterministic: two identical sessions emit identical streams (ADR-0017)", () => {
    const runSession = () => {
      const { dispatch } = miniStage();
      return ["前", "环视", "通话 舱压正常，可以对接", "内"].map((input) => {
        const out = dispatch("actor-1", input);
        return { result: out.result, messages: out.messages };
      });
    };

    const first = runSession();
    const second = runSession();

    expect(second).toEqual(first);
    expect(first.map((step) => step.result.ok)).toEqual([true, true, true, false]);
  });
});

describe("two packs, one engine, no leakage (spec/00 acceptance criterion 2)", () => {
  it("emits nothing the wuxia pack owns: every direction, id and word is the mini pack's", () => {
    const { dispatch } = miniStage();
    const wuxiaVocabulary = packVocabulary(packRegistry(WUXIA_PACK_DIR));
    const miniVocabulary = packVocabulary(packRegistry(MINI_PACK_DIR));

    const steps = [
      dispatch("actor-1", "前"),
      dispatch("actor-1", "环视"),
      dispatch("actor-1", "通话 舱压正常，可以对接"),
      dispatch("actor-1", "内"),
    ];
    // The scan covers the session AND the pack's own files: a pack's theme
    // lives in its copy as much as in its events.
    const haystack = transcript(steps) + loadPack(MINI_PACK_DIR).text;

    expect(foundIn(haystack, wuxiaVocabulary)).toEqual([]);
    expect(WUXIA_THEME_WORDS.filter((word) => haystack.includes(word))).toEqual([]);
    // The mini pack's own vocabulary is what fills the session instead.
    expect(foundIn(haystack, miniVocabulary)).toEqual(
      expect.arrayContaining(["前", "内", "room-orb-001", "npc-orb-001", "巡检机器人"]),
    );
  });

  it("keeps the two packs apart in one file: neither pack's vocabulary appears in the other's session", () => {
    const wuxiaVocabulary = packVocabulary(packRegistry(WUXIA_PACK_DIR));
    const miniVocabulary = packVocabulary(packRegistry(MINI_PACK_DIR));

    // Disjoint id spaces: no id can mean one thing in one pack and another in
    // the other, which is what lets both fixtures coexist in one test file.
    const wuxiaIds = new Set(wuxiaVocabulary.ids);
    expect(miniVocabulary.ids.filter((id) => wuxiaIds.has(id))).toEqual([]);

    const wuxia = makeSession(WUXIA_PACK_DIR, WUXIA_BINDINGS, {
      "actor-1": "room-lq-001",
      "actor-2": "room-lq-001",
      "actor-3": "room-lq-003",
    });
    const mini = miniStage();

    const wuxiaSession = transcript([
      wuxia.dispatch("actor-1", "看"),
      wuxia.dispatch("actor-1", "说 今夜风大"),
    ]);
    const miniSession = transcript([
      mini.dispatch("actor-1", "环视"),
      mini.dispatch("actor-1", "通话 舱压正常，可以对接"),
    ]);

    expect(foundIn(miniSession, wuxiaVocabulary)).toEqual([]);
    expect(foundIn(wuxiaSession, miniVocabulary)).toEqual([]);
    // Each session does carry its own pack's words — the scan is not
    // vacuously green on both sides.
    expect(foundIn(miniSession, miniVocabulary)).toEqual(
      expect.arrayContaining(["前", "room-orb-001", "npc-orb-001"]),
    );
    expect(foundIn(wuxiaSession, wuxiaVocabulary)).toEqual(
      expect.arrayContaining(["北", "room-lq-001", "npc-lq-001"]),
    );
  });
});
