import { describe, expect, it } from "vitest";
import { SAVE_VERSION } from "../src/save/migrations.js";
import { summaryOf } from "../src/save/summary.js";
import { serializeWorld } from "../src/state/snapshot.js";
import type { Snapshot } from "../src/types.js";

/**
 * The slot summary reader (#46, W7): what one save SHOWS of itself — the
 * format knowledge the panel used to drill for (`snapshot.data.nowTick`),
 * now read in ONE place beside the `migrateSnapshot` chain (D1/D2).
 *
 * Three laws are pinned here (AC3, D3):
 *
 *   - **total**: the reader NEVER throws — `data: null` is today's real crash
 *     input (`null.nowTick` TypeError) and it must answer like any other
 *     hostile payload. A throw here would take the whole panel down, salvage
 *     button included (M7's law).
 *   - **display tolerance**: an absent or malformed field answers NO summary
 *     (the key is simply not there) — the progress line's own law, "missing
 *     `nowTick` shows no progress suffix", read one level down. The display
 *     never judges corruption; that verdict belongs to the load path (C6).
 *   - **current-version only**: the reader reads the CURRENT payload shape
 *     and builds no second version logic (D2) — an older save's absent field
 *     stays absent, which is exactly today's display for it.
 */
describe("summaryOf (the current-version summary reader, #46)", () => {
  it("a normal save's summary carries the version and the tick it displays", () => {
    expect(summaryOf({ version: SAVE_VERSION, data: { nowTick: 42 } } as Snapshot)).toEqual({
      version: SAVE_VERSION,
      nowTick: 42,
    });
  });

  it("a payload without nowTick answers no summary — absence is absence, not 0", () => {
    // The load path's "absent means empty" fills 0 (SLOT_RULES); the DISPLAY
    // must not borrow that fill, or every old save would grow a "进度 0 tick"
    // line it never had (AC3: the suffix's semantics are unchanged).
    expect(summaryOf({ version: SAVE_VERSION, data: {} } as Snapshot)).toEqual({
      version: SAVE_VERSION,
    });
  });

  it("a v2 save through the real serializer summarizes exactly what it wrote", () => {
    // The format-knowledge pair: the serializer writes `nowTick`, this reader
    // reads it — one field, two ends, no third copy of the name or the kind.
    const snapshot = serializeWorld({ entities: {} }, {
      nowTick: 7,
      rngState: 1,
      due: [],
    });
    expect(summaryOf(snapshot)).toEqual({ version: SAVE_VERSION, nowTick: 7 });
  });

  it("a hostile payload (`data: null`) never throws — the M7 crash input answers no summary", () => {
    const hostile = { version: SAVE_VERSION, data: null } as unknown as Snapshot;
    expect(summaryOf(hostile)).toEqual({ version: SAVE_VERSION });
  });

  it.each([
    ["a string tick", "42"],
    ["a null tick", null],
    ["NaN", Number.NaN],
    ["a fractional tick", 3.7],
    ["a negative tick", -5],
    ["an infinite tick", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
  ])("a malformed nowTick (%s) answers no summary — display tolerance, never a throw", (_label, nowTick) => {
    const damaged = { version: SAVE_VERSION, data: { nowTick } } as unknown as Snapshot;
    expect(summaryOf(damaged)).toEqual({ version: SAVE_VERSION });
  });

  it.each([
    ["a list", [1, 2]],
    ["a bare value", 7],
    ["undefined", undefined],
  ])("a payload that is not a record (%s) answers no summary — never a throw", (_label, data) => {
    const damaged = { version: SAVE_VERSION, data } as unknown as Snapshot;
    expect(summaryOf(damaged)).toEqual({ version: SAVE_VERSION });
  });

  it("reads the CURRENT shape only — an older payload's absent field stays absent", () => {
    // No cross-version tolerance (D2): a v1 payload carries no nowTick at
    // all, and the summary says so — the display for it is "存档 v1" with no
    // suffix, unchanged from the drill it replaces.
    expect(summaryOf({ version: 1, data: { entities: {} } } as Snapshot)).toEqual({ version: 1 });
  });
});
