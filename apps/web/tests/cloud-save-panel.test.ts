import type { Snapshot } from "@sexymud/core";
import { describe, expect, it } from "vitest";
import { slotSummary } from "../src/ui/CloudSavePanel.js";
import type { SlotView } from "../src/game/cloudSync.js";

/**
 * The panel's summary reader at its own seam (#34 复查轮; M7's law): a TOTAL
 * function — whatever the slot view carries, it renders a line and never
 * throws. This is deliberately NOT rendering infrastructure (that is W6's
 * job): the summary is a pure function and pins cleanly on its own, and a
 * crash here would take the whole panel down with it — salvage button
 * included (#34 D2 makes that button the player's escape hatch).
 */

function saveView(snapshot: Snapshot): SlotView {
  return { kind: "save", snapshot };
}

describe("CloudSavePanel — slotSummary is a total reader (M7)", () => {
  it("a hostile payload (`data: null`) never crashes the summary — no progress suffix, panel alive", () => {
    // Envelope-clean but payload-hostile: parseSnapshotText accepts it (the
    // envelope check is only `{version, data}`), so the view is a `save` —
    // and the pre-fix reader died on `data.nowTick` right here.
    const hostile = { version: 2, data: null } as unknown as Snapshot;

    expect(slotSummary(saveView(hostile))).toBe("存档 v2");
  });

  it("a payload without nowTick shows no progress suffix — absence is an empty suffix, not words", () => {
    const quiet = { version: 2, data: {} } as Snapshot;

    expect(slotSummary(saveView(quiet))).toBe("存档 v2");
  });

  it("a normal save shows version and progress; the other kinds keep their own lines", () => {
    const live = { version: 2, data: { nowTick: 42 } } as Snapshot;

    expect(slotSummary(saveView(live))).toBe("存档 v2 · 进度 42 tick");
    expect(slotSummary({ kind: "unknown" })).toBe("未检查");
    expect(slotSummary({ kind: "empty" })).toBe("无存档");
    expect(slotSummary({ kind: "corrupt" })).toBe("存档损坏");
    expect(slotSummary({ kind: "unavailable" })).toBe("存储不可访问");
  });
});
