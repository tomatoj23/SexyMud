import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConditionSubject } from "../src/conditions.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import type { CommandSpec } from "../src/command/pipeline.js";
import { createVerbTable } from "../src/command/parser.js";
import { mergeCmdSets } from "../src/command/cmdset.js";
import { commandSetSources, commandSpecFromEntry } from "../src/command/entry.js";
import type { CommandEntry } from "../src/command/entry.js";
import { createContentRegistry } from "../src/content/registry.js";

/**
 * The M1-T5 tracer bullet (issue #5): adding a command means adding a JSON
 * file under content/commands/, and it runs through call() with EVERYTHING
 * real — verbs from content, the cmdset merge, the verb table, argForm
 * parsing and the preconditions gate. No verb is registered in code.
 *
 * The ENGINE never imports content; this test plays the HOST role: it loads
 * the files, builds the registry, assembles the merge sources and binds each
 * entry's behaviour. What is under test is that the content files alone,
 * pushed through the public engine surface, produce a dispatchable command.
 */

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content/commands");

function loadCommandEntries(): CommandEntry[] {
  return readdirSync(contentDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(contentDir, name), "utf8")) as CommandEntry);
}

interface TracerWorld {
  /** actorId → active states; feeds the condition subject for access gates. */
  states: Record<string, readonly string[]>;
}

function subjectOf(world: TracerWorld, actorId: string): ConditionSubject {
  const states = world.states[actorId] ?? [];
  return {
    attr: () => undefined,
    hasTag: () => false,
    hasFlag: () => false,
    hasState: (state) => states.includes(state),
    locationId: () => undefined,
    hasSkill: () => false,
  };
}

/** A harness over the real merge sources, asking the commands-collection accessType ("use" per content.md). */
function tracerHarness(world: TracerWorld) {
  const registry = createContentRegistry({ commands: loadCommandEntries() });
  return {
    registry,
    harness: createCommandHarness<TracerWorld>({
      world,
      receivers: ["actor-1"],
      cmdsets: commandSetSources(registry.commands),
      subjectOf,
    }),
  };
}

/** A spec whose behaviour records its parsed args and emits one semantic event. */
function recorderSpec<W>(entry: CommandEntry, seen: unknown[]): CommandSpec<W> {
  return commandSpecFromEntry<W>(entry, {
    accessType: "use",
    func: (ctx) => {
      seen.push(ctx.args);
      ctx.emit(ctx.command.actorId, { type: "acted", commandKey: ctx.command.raw });
    },
  });
}

describe("content/commands/ entries through the real dispatch path", () => {
  it("ships one entry per file, the filename being the id (content.md convention)", () => {
    const names = readdirSync(contentDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(names).toEqual(loadCommandEntries().map((entry) => `${entry.id}.json`));
  });

  it("pairs Chinese verbs with English abbreviations in every entry (spec/02 §2)", () => {
    for (const command of loadCommandEntries()) {
      expect(
        command.verbs.some((verb) => /[\u4e00-\u9fff]/.test(verb)),
        `${command.id} has a Chinese verb`,
      ).toBe(true);
      expect(
        command.verbs.some((verb) => /^[a-z]+$/.test(verb)),
        `${command.id} has an English abbreviation`,
      ).toBe(true);
    }
  });

  it("reaches every command from its own verbs via the real merge + verb table", () => {
    const registry = createContentRegistry({ commands: loadCommandEntries() });
    const table = createVerbTable(mergeCmdSets(commandSetSources(registry.commands)).verbEntries());

    expect(registry.commands.map((command) => command.id)).toEqual([
      "cmd-examine",
      "cmd-look",
      "cmd-rest",
      "cmd-say",
    ]);
    for (const command of registry.commands) {
      const verb = command.verbs[0];
      expect(verb, `${command.id} declares verbs`).toBeDefined();
      const match = table.match(verb!);
      expect(match.ok, `verb "${verb}" matches`).toBe(true);
      if (match.ok) {
        expect(match.commandKey).toBe(command.id);
      }
    }
  });

  it("assembles deterministically regardless of file load order (ADR-0024 §2)", () => {
    const entries = loadCommandEntries();
    const forward = createContentRegistry({ commands: entries });
    const reversed = createContentRegistry({ commands: [...entries].reverse() });
    expect(commandSetSources(reversed.commands)).toEqual(commandSetSources(forward.commands));
  });
});

describe("call() through content data (parse, merge and gates all real)", () => {
  it("runs the look command from its Chinese and English verbs alike (argForm none)", () => {
    const { harness, registry } = tracerHarness({ states: {} });
    const seen: unknown[] = [];
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-look"), seen);

    for (const input of ["看", "look", "l"]) {
      const out = harness.call(spec, input);
      expect(out.result.ok, `input "${input}"`).toBe(true);
    }
    expect(seen).toEqual([null, null, null]);
  });

  it("runs the say command and hands the whole remainder as text (argForm text)", () => {
    const { harness, registry } = tracerHarness({ states: {} });
    const seen: unknown[] = [];
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-say"), seen);

    expect(harness.call(spec, "说 你好").result.ok).toBe(true);
    expect(harness.call(spec, "say hello there").result.ok).toBe(true);
    expect(seen).toEqual(["你好", "hello there"]);
  });

  it("runs the examine command with both the ordinal form and a bare noun (argForm target-ordinal)", () => {
    const { harness, registry } = tracerHarness({ states: {} });
    const seen: unknown[] = [];
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-examine"), seen);

    expect(harness.call(spec, "端详 第二个 铜像").result.ok).toBe(true);
    expect(harness.call(spec, "打量铜像").result.ok).toBe(true);
    expect(seen).toEqual([
      { noun: "铜像", ordinal: 2 },
      { noun: "铜像", ordinal: 1 },
    ]);
  });

  it("rejects input whose verb dispatches a different command (the table picks, not the spec)", () => {
    const { harness, registry } = tracerHarness({ states: {} });
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-look"), []);

    const out = harness.call(spec, "说 你好");
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: "verbMismatch" });
  });

  it("rejects a trailing argument on a none-form command (content declares the form)", () => {
    const { harness, registry } = tracerHarness({ states: {} });
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-rest"), []);

    // Longest match picks the full verb; the leftover is not accepted by argForm none.
    const out = harness.call(spec, "歇息 一下");
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "invalid", reason: "unexpectedArg" });
  });

  it("lets an unwounded actor rest — the longest verb beats its own prefix alias", () => {
    const { harness, registry } = tracerHarness({ states: {} });
    const seen: unknown[] = [];
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-rest"), seen);

    const out = harness.call(spec, "歇息");
    expect(out.result.ok).toBe(true);
    expect(seen).toEqual([null]);
  });

  it("refuses a wounded actor with a semantic event; the copy stays in the entry data", () => {
    const { harness, registry } = tracerHarness({ states: { "actor-1": ["wounded"] } });
    const spec = recorderSpec<TracerWorld>(registry.command("cmd-rest"), []);

    const out = harness.call(spec, "歇息");

    // rejected consumes the seq — the refusal is content, and it goes back as an event (spec/01 §4).
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "accessDenied" });
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

    // Renderer role: the errKey locates the copy in the entry, which exists and is worded.
    const errKey = out.messages[0]?.event.errKey;
    expect(typeof errKey).toBe("string");
    const copy = registry.command("cmd-rest")[errKey as `err_${string}`];
    expect(typeof copy).toBe("string");
    expect((copy as string).length).toBeGreaterThan(0);
    // The event itself never carries the rendered text (spec/01 §5.1).
    expect(JSON.stringify(out.messages)).not.toContain(copy);
  });
});
