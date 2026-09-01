import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConditionSubject } from "../src/conditions.js";
import { checkAccess } from "../src/conditions.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import { createVerbTable } from "../src/command/parser.js";
import { mergeCmdSets } from "../src/command/cmdset.js";
import { commandSetSources, commandSpecFromEntry } from "../src/command/entry.js";
import type { CommandEntry } from "../src/command/entry.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { ExitEntry, NpcEntry, RoomEntry } from "../src/world/entry.js";

/**
 * The M1-T6 tracer bullet (issue #6): the world lands as content — rooms
 * with the four elements, npcs referencing monsters instead of copying
 * numbers, and EXITS AS INDEPENDENT ENTITIES that register themselves as
 * commands. From content/ alone, pushed through the public engine surface:
 * the registry's referential integrity, the cmdset merge with the exit
 * source on top, the verb table, and call() with the traverse gate — where
 * a refusal's copy is read from the exit's own JSON data.
 *
 * The ENGINE never imports content; this test plays the HOST role. What is
 * under test is that the content files alone produce a connected,
 * dispatchable world: 「北」 is a command because a JSON file says so.
 */

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content");

function loadCollection<T>(name: string): T[] {
  const dir = join(contentDir, name);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => JSON.parse(readFileSync(join(dir, fileName), "utf8")) as T);
}

function loadWorld() {
  return createContentRegistry({
    commands: loadCollection<CommandEntry>("commands"),
    rooms: loadCollection<RoomEntry>("rooms"),
    npcs: loadCollection<NpcEntry>("npcs"),
    monsters: loadCollection<{ id: string }>("monster"),
  });
}

interface TracerWorld {
  /** actorId → held flags; feeds the condition subject for the traverse gate. */
  flags: Record<string, readonly string[]>;
}

function subjectOf(world: TracerWorld, actorId: string): ConditionSubject {
  const flags = world.flags[actorId] ?? [];
  return {
    attr: () => undefined,
    hasTag: () => false,
    hasFlag: (flag) => flags.includes(flag),
    hasState: () => false,
    locationId: () => undefined,
    hasSkill: () => false,
  };
}

/** The room the tracer actor stands in: the inn hall, whose north exit is gated. */
const HALL = "room-lq-003";

/**
 * A harness standing in one room: the real command sources merged with THAT
 * room's exit source (a host re-merges per input because sources change
 * with location — see the per-room verb test below).
 */
function roomHarness(world: TracerWorld, roomId: string) {
  const registry = loadWorld();
  return {
    registry,
    room: registry.room(roomId),
    harness: createCommandHarness<TracerWorld>({
      world,
      receivers: ["actor-1"],
      cmdsets: roomSources(registry, roomId),
      subjectOf,
    }),
  };
}

/** The merge sources a host standing in `roomId` assembles: commands + that room's exits. */
function roomSources(
  registry: ReturnType<typeof loadWorld>,
  roomId: string,
): ReturnType<typeof commandSetSources> {
  return [...commandSetSources(registry.commands), ...commandSetSources(registry.room(roomId).exits)];
}

/** The verb table a host standing in `roomId` parses against. */
function roomVerbTable(registry: ReturnType<typeof loadWorld>, roomId: string) {
  return createVerbTable(mergeCmdSets(roomSources(registry, roomId)).verbEntries());
}

/** An exit's traversal behaviour, host-injected: a semantic moved event. */
function traversalSpec<W>(exit: ExitEntry): CommandSpec<W> {
  return commandSpecFromEntry<W>(exit, {
    accessType: "traverse",
    func: (ctx) => {
      ctx.emit(ctx.command.actorId, {
        type: "moved",
        toRoomId: exit.targetRoomId,
        viaExitId: exit.id,
      });
    },
  });
}

describe("content/rooms/ and content/npcs/ as loaded content", () => {
  it("ships one entry per file, the filename being the id (content.md convention)", () => {
    for (const collection of ["rooms", "npcs", "monster"] as const) {
      const names = readdirSync(join(contentDir, collection))
        .filter((fileName) => fileName.endsWith(".json"))
        .sort();
      const ids = loadCollection<{ id: string }>(collection).map((entry) => `${entry.id}.json`);
      expect(names, collection).toEqual(ids);
    }
  });

  it("gives every room the four elements: exit graph, description, placement list, rules", () => {
    const registry = loadWorld();
    expect(registry.rooms.map((room) => room.id)).toEqual([
      "room-lq-001",
      "room-lq-002",
      "room-lq-003",
      "room-lq-004",
    ]);
    for (const room of registry.rooms) {
      expect(room.name.length, `${room.id} has a name`).toBeGreaterThan(0);
      expect(room.description.length, `${room.id} has a description`).toBeGreaterThan(0);
      expect(room.enterText.length, `${room.id} has entry text`).toBeGreaterThan(0);
      expect(Array.isArray(room.exits), `${room.id} declares its exits`).toBe(true);
    }
  });

  it("makes every exit a command: paired Chinese/English direction verbs, exits cmdset above all regular sources", () => {
    const registry = loadWorld();
    for (const room of registry.rooms) {
      for (const exit of room.exits) {
        const label = `${room.id}/${exit.id}`;
        expect(exit.direction.length, `${label} has a direction`).toBeGreaterThan(0);
        expect(
          exit.verbs.some((verb) => /[\u4e00-\u9fff]/.test(verb)),
          `${label} has a Chinese direction verb`,
        ).toBe(true);
        expect(
          exit.verbs.some((verb) => /^[a-z]+$/.test(verb)),
          `${label} has an English abbreviation`,
        ).toBe(true);
        // The pack's convention (content.md): one exits source, merged on
        // top of every regular source (+101) so direction words stay
        // available — the mechanism is the merge order, the value is data.
        expect(exit.cmdset, `${label} joins the exits cmdset`).toBe("exits");
        expect(exit.priority, `${label} sits above the character source`).toBe(101);
        // The registry guaranteed the edge resolves at load:
        expect(registry.room(exit.targetRoomId).id).toBe(exit.targetRoomId);
      }
    }
  });

  it("resolves every placement against the loaded collections (rooms are content containers)", () => {
    const registry = loadWorld();
    const placed = registry.rooms.flatMap((room) =>
      (room.objects ?? []).map((placement) => `${room.id} places ${placement.id} x${placement.count}`),
    );
    // Descriptions and placement lists were aligned by hand (issue #6); the
    // registry guarantees the references resolve — this pins the manifest.
    expect(placed).toEqual([
      "room-lq-001 places npc-lq-001 x1",
      "room-lq-003 places npc-lq-002 x1",
      "room-lq-004 places npc-lq-003 x1",
    ]);
    for (const npc of registry.npcs) {
      expect(registry.npc(npc.id).name.length).toBeGreaterThan(0);
    }
  });

  it("words the room's own enter gate as data (four elements: rules)", () => {
    const registry = loadWorld();
    const yard = registry.room("room-lq-004");
    expect(yard.preconditions).toBeDefined();

    // Deny-by-default with a lodger exception (spec/02 §5.2) — the room
    // collection's enter vocabulary, evaluated through the engine's public
    // condition API exactly as a host's arrival check would.
    const denied = checkAccess(yard.preconditions!, "enter", subjectOf({ flags: {} }, "actor-1"));
    expect(denied).toEqual({ ok: false, accessType: "enter", errKey: "err_enter" });
    const lodger = subjectOf({ flags: { "actor-1": ["inn-lodger"] } }, "actor-1");
    expect(checkAccess(yard.preconditions!, "enter", lodger)).toEqual({ ok: true });
    // An undeclared accessType falls to the default gate: deny (err_default).
    expect(checkAccess(yard.preconditions!, "edit", lodger)).toEqual({
      ok: false,
      accessType: "edit",
      errKey: "err_default",
    });

    // The refusal copy is a room field — the engine only names the key.
    expect(yard.err_enter).toContain("住店客人");
  });

  it("npcs reference monsters by id, never copy combat numbers (spec/03 §4)", () => {
    const registry = loadWorld();
    expect(registry.npcs.map((npc) => npc.id)).toEqual(["npc-lq-001", "npc-lq-002", "npc-lq-003"]);

    // Non-combat figures (shopkeeper, peddler) declare no monsterId.
    expect(registry.npc("npc-lq-001").monsterId).toBeUndefined();
    expect(registry.npc("npc-lq-002").monsterId).toBeUndefined();

    // The combat-capable figure references the monster collection.
    const guard = registry.npc("npc-lq-003");
    expect(guard.monsterId).toBe("mon-lq-001");
    expect(registry.monster("mon-lq-001").id).toBe("mon-lq-001");
  });

  it("assembles deterministically regardless of file load order (ADR-0024 §2)", () => {
    const rooms = loadCollection<RoomEntry>("rooms");
    const forward = loadWorld();
    const reversed = createContentRegistry({
      rooms: [...rooms].reverse(),
      npcs: [...loadCollection<NpcEntry>("npcs")].reverse(),
      monsters: [...loadCollection<{ id: string }>("monster")].reverse(),
    });
    expect(reversed.rooms).toEqual(forward.rooms);
    expect(reversed.npcs).toEqual(forward.npcs);
  });

  it("keeps descriptions and placement lists corroborated (spec/03 §2, automated)", () => {
    const registry = loadWorld();
    // A mention implies presence: any entity whose NAME appears in a room's
    // long description must be placed in that room. One direction only — a
    // placed-but-unmentioned entity is discoverable by look, not a lie.
    //
    // Monster names are skipped when an npc references the monster: the npc
    // is the placed persona, the monster its combat projection — 孙彪 in a
    // description means the npc stands there, not a second body. Standalone
    // monsters (no referencing npc) keep the check: a wolf named in prose
    // must be in the placement list.
    //
    // Caveat kept deliberately: the matcher is a plain substring over names,
    // so past-tense narration of an absent figure ("原是货郎落脚处") would
    // fail here and force either a rewording or an explicit exception — the
    // pack QA test tightens as real cases appear.
    const referencedMonsterIds = new Set(
      registry.npcs.flatMap((npc) => (npc.monsterId !== undefined ? [npc.monsterId] : [])),
    );
    const namedEntities = [
      ...registry.npcs.map((npc) => ({ id: npc.id, name: npc.name })),
      ...loadCollection<{ id: string; name: string }>("monster")
        .filter((monster) => !referencedMonsterIds.has(monster.id))
        .map((monster) => ({ id: monster.id, name: monster.name })),
    ];
    expect(namedEntities.length).toBeGreaterThan(0);

    for (const room of registry.rooms) {
      const placed = new Set((room.objects ?? []).map((placement) => placement.id));
      for (const entity of namedEntities) {
        if (room.description.includes(entity.name)) {
          expect(
            placed.has(entity.id),
            `${room.id}'s description names "${entity.name}" (${entity.id}) — it must be placed there`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("exits as commands through the real dispatch path (spec/02 §4)", () => {
  it("parses 「北」 as the hall's north exit through the real merge + verb table", () => {
    const { registry } = roomHarness({ flags: {} }, HALL);
    const table = roomVerbTable(registry, HALL);

    for (const input of ["北", "n", "north", "往北走"]) {
      const match = table.match(input);
      expect(match.ok, `input "${input}" matches`).toBe(true);
      if (match.ok) {
        expect(match.commandKey, `input "${input}" dispatches the exit`).toBe("exit-lq-003-north");
      }
    }
  });

  it("re-merges per location: the same direction word dispatches a different exit per room", () => {
    const { registry } = roomHarness({ flags: {} }, HALL);
    const gateTable = roomVerbTable(registry, "room-lq-001");
    const match = gateTable.match("北");
    expect(match.ok).toBe(true);
    if (match.ok) {
      // room-lq-001's own north exit — never conflicting with the hall's,
      // because a host never merges two rooms' exits into one table.
      expect(match.commandKey).toBe("exit-lq-001-north");
    }
  });

  it("runs the ungated east exit through call(): parse, gate check and func all real", () => {
    const { harness, registry, room } = roomHarness({ flags: {} }, HALL);
    const east = room.exits.find((exit) => exit.id === "exit-lq-003-east");
    expect(east).toBeDefined();

    const out = harness.call(traversalSpec<TracerWorld>(east!), "东");
    expect(out.result.ok).toBe(true);
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: { type: "moved", toRoomId: "room-lq-002", viaExitId: "exit-lq-003-east" },
      },
    ]);
    // An ungated exit never asks a gate: the traverse accessType was carried,
    // not evaluated (no preconditions on the entry).
    expect(registry.exit("exit-lq-003-east").preconditions).toBeUndefined();
  });

  it("refuses the gated north exit with a semantic event; the copy stays in the exit's JSON", () => {
    const { harness, registry, room } = roomHarness({ flags: {} }, HALL);
    const north = room.exits.find((exit) => exit.id === "exit-lq-003-north");
    expect(north).toBeDefined();

    const out = harness.call(traversalSpec<TracerWorld>(north!), "北");
    // rejected consumes the seq — the refusal is content, returned as an event (spec/01 §4).
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "accessDenied",
          commandKey: "exit-lq-003-north",
          accessType: "traverse",
          errKey: "err_traverse",
        },
      },
    ]);

    // Renderer role: the errKey locates the copy on the EXIT's data, which
    // exists and is worded — refusal copy is a content field (spec/02 §5.4).
    const copy = registry.exit("exit-lq-003-north").err_traverse;
    expect(typeof copy).toBe("string");
    expect((copy as string).length).toBeGreaterThan(0);
    // The event itself never carries the rendered text (spec/01 §5.1).
    expect(JSON.stringify(out.messages)).not.toContain(copy as string);
  });

  it("lets a lodger through the same gate — the condition is evaluated, not hardcoded", () => {
    const { harness, room } = roomHarness({ flags: { "actor-1": ["inn-lodger"] } }, HALL);
    const north = room.exits.find((exit) => exit.id === "exit-lq-003-north");

    for (const input of ["北", "往北走"]) {
      const out = harness.call(traversalSpec<TracerWorld>(north!), input);
      expect(out.result.ok, `input "${input}"`).toBe(true);
    }
    expectMessageSequence(
      harness.call(traversalSpec<TracerWorld>(north!), "北").messages,
      [{ to: "actor-1", event: { type: "moved", toRoomId: "room-lq-004" } }],
    );
  });

  it("keeps direction words available to a Remove filter merged BELOW the exit source (+101)", () => {
    const { registry, room } = roomHarness({ flags: {} }, HALL);
    // A dark-room-style filter trying to suppress the north exit — merged at
    // a priority below the exits source, it cannot touch what merges after it.
    const filtered = mergeCmdSets([
      ...commandSetSources(registry.commands),
      { priority: 0, mergetype: "Remove", commands: [{ key: "exit-lq-003-north" }] },
      ...commandSetSources(room.exits),
    ]);
    const table = createVerbTable(filtered.verbEntries());
    const match = table.match("北");
    expect(match.ok).toBe(true);
    if (match.ok) {
      expect(match.commandKey).toBe("exit-lq-003-north");
    }
  });

  it("still runs regular commands alongside the exit source (the merge is one table)", () => {
    const { harness, registry } = roomHarness({ flags: { "actor-1": [] } }, HALL);
    const seen: unknown[] = [];
    const look = commandSpecFromEntry<TracerWorld>(registry.command("cmd-look"), {
      accessType: "use",
      func: (ctx) => {
        seen.push(ctx.args);
      },
    });
    expect(harness.call(look, "看").result.ok).toBe(true);
    expect(seen).toEqual([null]);
  });

  it("rejects a direction this room does not offer, and a verb dispatching a different exit", () => {
    const { harness, room } = roomHarness({ flags: {} }, HALL);
    const east = room.exits.find((exit) => exit.id === "exit-lq-003-east")!;

    // The hall offers no south exit — that verb belongs to other rooms'
    // tables. The ungated east spec keeps parsing the failing stage: a gated
    // spec would refuse on access first (availability precedes parsing,
    // spec/02 §5.5), which is the gate's call, not the parser's.
    expect(harness.call(traversalSpec<TracerWorld>(east), "南").result).toEqual({
      ok: false,
      seq: 1,
      kind: "invalid",
      reason: "unknownVerb",
    });
    // The table picks the command, not the spec (as with command entries):
    // 「北」 dispatches the gated north exit, not the east spec handed in.
    expect(harness.call(traversalSpec<TracerWorld>(east), "北").result).toEqual({
      ok: false,
      seq: 2,
      kind: "invalid",
      reason: "verbMismatch",
    });
  });
});
