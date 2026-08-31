import { describe, expect, it } from "vitest";
import { SAVE_VERSION, migrateSnapshot } from "../src/save/migrations.js";
import type { GameStateV1 } from "../src/save/migrations.js";
import type { Snapshot } from "../src/types.js";

const currentData: GameStateV1 = {
  realmId: "realm-01",
  resources: { "res-a": 1.5 },
  activeActivityId: null,
  lastSettleTimestamp: 5,
};

describe("migrateSnapshot (save migration seam)", () => {
  it("passes through snapshots at the current version", () => {
    const out = migrateSnapshot<GameStateV1>({ version: SAVE_VERSION, data: currentData });
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

  it("survives a full serialization roundtrip losslessly", () => {
    const snapshot: Snapshot<GameStateV1> = { version: SAVE_VERSION, data: currentData };
    const revived = migrateSnapshot<GameStateV1>(JSON.parse(JSON.stringify(snapshot)) as Snapshot);
    expect(revived).toEqual(currentData);
  });

  it("clones nothing: migration is data-in, data-out", () => {
    const data = { ...currentData };
    const out = migrateSnapshot<GameStateV1>({ version: SAVE_VERSION, data });
    expect(out).toBe(data);
  });
});
