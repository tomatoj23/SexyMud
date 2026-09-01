import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../src/command/entry.js";
import { commandSetSources, commandSpecFromEntry } from "../src/command/entry.js";
import { createContentRegistry } from "../src/content/registry.js";

/**
 * The content read path (issue #5): the registry's load-time integrity checks
 * (ADR-0003 — duplicate and unknown ids fail loudly), the entries → cmdset
 * sources grouping (spec/02 §3 — merge rules belong to the SET), and the
 * entry → spec adapter (spec/02 §5.5 — preconditions become the access gate).
 *
 * Synthetic entries: the real content pack's own entries are exercised in
 * commands-content.test.ts through these same functions.
 */

function entry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: "cmd-probe",
    verbs: ["probe"],
    argForm: "none",
    cmdset: "character",
    priority: 0,
    ...overrides,
  };
}

describe("createContentRegistry (ADR-0003: integrity at load)", () => {
  it("lists commands id-ascending regardless of the order they were loaded in", () => {
    const registry = createContentRegistry({
      commands: [entry({ id: "cmd-c" }), entry({ id: "cmd-a" }), entry({ id: "cmd-b" })],
    });
    expect(registry.commands.map((command) => command.id)).toEqual(["cmd-a", "cmd-b", "cmd-c"]);
  });

  it("looks commands up by id", () => {
    const probe = entry();
    const registry = createContentRegistry({ commands: [probe] });
    expect(registry.command("cmd-probe")).toBe(probe);
  });

  it("throws on an unknown id — a dangling reference fails loudly, not silently", () => {
    const registry = createContentRegistry({ commands: [entry()] });
    expect(() => registry.command("cmd-nope")).toThrow(/unknown command id "cmd-nope"/);
  });

  it("throws on duplicate ids — two files claiming one id disagree about what it is", () => {
    expect(() =>
      createContentRegistry({ commands: [entry({ id: "cmd-a" }), entry({ id: "cmd-a", verbs: ["other"] })] }),
    ).toThrow(/duplicate command id "cmd-a"/);
  });

  it("throws on an empty id (host-assembled data that bypassed content:check)", () => {
    expect(() => createContentRegistry({ commands: [entry({ id: "" })] })).toThrow(/empty id/);
  });
});

describe("commandSetSources (spec/02 §3: merge rules belong to the set)", () => {
  it("groups entries by cmdset into one source per set, in first-appearance order", () => {
    const sources = commandSetSources([
      entry({ id: "cmd-a", cmdset: "character", verbs: ["a"] }),
      entry({ id: "cmd-b", cmdset: "session", priority: -20, verbs: ["b"] }),
      entry({ id: "cmd-c", cmdset: "character", verbs: ["c", "see"] }),
    ]);

    expect(sources).toEqual([
      {
        priority: 0,
        mergetype: "Union",
        commands: [
          { key: "cmd-a", verbs: ["a"] },
          { key: "cmd-c", verbs: ["c", "see"] },
        ],
      },
      { priority: -20, mergetype: "Union", commands: [{ key: "cmd-b", verbs: ["b"] }] },
    ]);
  });

  it("keeps entry order inside a set (same-key collapse and verb collision resolve to the later entry)", () => {
    const sources = commandSetSources([
      entry({ id: "cmd-first", verbs: ["one"] }),
      entry({ id: "cmd-second", verbs: ["two"] }),
    ]);
    expect(sources[0]?.commands.map((command) => command.key)).toEqual(["cmd-first", "cmd-second"]);
  });

  it("treats an explicit Union and an omitted mergetype as agreeing", () => {
    expect(() =>
      commandSetSources([
        entry({ id: "cmd-a", mergetype: "Union" }),
        entry({ id: "cmd-b" /* omitted → Union */ }),
      ]),
    ).not.toThrow();
  });

  it("throws when entries of one cmdset declare conflicting priorities", () => {
    expect(() =>
      commandSetSources([
        entry({ id: "cmd-a", priority: 0 }),
        entry({ id: "cmd-b", priority: 5 }),
      ]),
    ).toThrow(/conflicting priorities \(0 and 5\)/);
  });

  it("throws when entries of one cmdset declare conflicting mergetypes", () => {
    expect(() =>
      commandSetSources([
        entry({ id: "cmd-a", mergetype: "Union" }),
        entry({ id: "cmd-b", mergetype: "Replace" }),
      ]),
    ).toThrow(/conflicting mergetypes \("Union" and "Replace"\)/);
  });

  it("passes an explicit non-Union mergetype through to the source", () => {
    const sources = commandSetSources([
      entry({ id: "cmd-a", mergetype: "Replace", priority: 30 }),
    ]);
    expect(sources[0]).toEqual({
      priority: 30,
      mergetype: "Replace",
      commands: [{ key: "cmd-a", verbs: ["probe"] }],
    });
  });
});

describe("commandSpecFromEntry (spec/02 §5.5: entry data becomes pipeline shape)", () => {
  it("maps id to the dispatch key, argForm to the parse stage, and carries func", () => {
    const func = (): void => {};
    const spec = commandSpecFromEntry(entry(), { func });

    expect(spec.key).toBe("cmd-probe");
    expect(spec.argForm).toBe("none");
    expect(spec.func).toBe(func);
    expect(spec.access).toBeUndefined();
  });

  it("turns preconditions into the access gate asking the given accessType", () => {
    const preconditions = { default: true as const, use: { not: [{ has_state: "wounded" }] } };
    const spec = commandSpecFromEntry(entry({ preconditions }), {
      accessType: "use",
      func: (): void => {},
    });

    expect(spec.access).toEqual({ rules: preconditions, accessType: "use" });
  });

  it("throws when a gated entry is assembled without an accessType to ask", () => {
    expect(() =>
      commandSpecFromEntry(entry({ preconditions: { default: true } }), { func: (): void => {} }),
    ).toThrow(/cmd-probe.*declares preconditions but no accessType/);
    expect(() =>
      commandSpecFromEntry(entry({ preconditions: { default: true } }), {
        accessType: "",
        func: (): void => {},
      }),
    ).toThrow(/no accessType/);
  });

  it("ignores a stray accessType on an ungated entry (no gate, nothing to ask)", () => {
    const spec = commandSpecFromEntry(entry(), { accessType: "use", func: (): void => {} });
    expect(spec.access).toBeUndefined();
  });
});
