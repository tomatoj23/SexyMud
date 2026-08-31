import { describe, expect, it } from "vitest";
import { SAVE_VERSION, migrateSnapshot } from "../src/save/migrations.js";
import type { Snapshot } from "../src/types.js";

/** The migration chain is content-agnostic, so any shape exercises it. */
interface ExampleState {
  ticks: number;
  entities: Record<string, number>;
  label: string;
}

const currentData: ExampleState = {
  ticks: 5,
  entities: { "ent-a": 1.5 },
  label: "少侠",
};

describe("migrateSnapshot (save migration seam)", () => {
  it("passes through snapshots at the current version", () => {
    const out = migrateSnapshot<ExampleState>({ version: SAVE_VERSION, data: currentData });
    expect(out).toEqual(currentData);
  });

  it("rejects saves from an unsupported future version", () => {
    expect(() => migrateSnapshot({ version: SAVE_VERSION + 1, data: {} })).toThrow(/unsupported save version/);
  });

  it("rejects version 0", () => {
    expect(() => migrateSnapshot({ version: 0, data: {} })).toThrow(/unsupported save version/);
  });

  it("rejects non-numeric versions", () => {
    const malformed = { version: "1", data: {} } as unknown as Snapshot;
    expect(() => migrateSnapshot(malformed)).toThrow(/unsupported save version/);
  });

  it("survives a full serialization roundtrip losslessly, including CJK", () => {
    const snapshot: Snapshot<ExampleState> = { version: SAVE_VERSION, data: currentData };
    const revived = migrateSnapshot<ExampleState>(JSON.parse(JSON.stringify(snapshot)) as Snapshot);
    expect(revived).toEqual(currentData);
    expect(revived.label).toBe("少侠");
  });

  it("clones nothing: migration is data-in, data-out", () => {
    const data = { ...currentData };
    const out = migrateSnapshot<ExampleState>({ version: SAVE_VERSION, data });
    expect(out).toBe(data);
  });
});
