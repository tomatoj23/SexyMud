import { describe, expect, it } from "vitest";
import { SAVE_VERSION, migrateSnapshot } from "../src/save/migrations.js";
import type { SaveDataV2 } from "../src/state/snapshot.js";
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

/**
 * The FIRST REAL migration (ADR-0033 §3, #24). The chain was ready and empty
 * from M2-T5 because a fake migration would have proved nothing; v2 is what
 * finally exercises it.
 *
 * The rule every later step inherits is stated here and tested here:
 * **a migration fills in only what is ABSENT.** It records "this field did
 * not exist when the save was written" — it does not guess at the player's
 * state, and it must never overwrite a fact the old save actually carried.
 */
describe("v1 → v2: the world scalars arrive (ADR-0033 §2–§3)", () => {
  /** A v1 payload: the tree and nothing else. */
  const v1 = (entities: Record<string, unknown>): Snapshot => ({
    version: 1,
    data: { entities },
  });

  it("fills the three scalars a v1 save could not have written", () => {
    const out = migrateSnapshot<SaveDataV2>(
      v1({ "player-1": { id: "player-1", locationId: "room-a", flags: [] } }),
    );

    expect(out.nowTick).toBe(0);
    expect(out.rngState).toBe(0);
    expect(out.due).toEqual([]);
  });

  it("gives every entity the lastSeenTick the two-layer advance needs", () => {
    const out = migrateSnapshot<SaveDataV2>(
      v1({
        "player-1": { id: "player-1", locationId: "room-a", flags: [] },
        "player-2": { id: "player-2", locationId: "room-b", flags: ["lit"] },
      }),
    );

    // The default is `nowTick` (ADR-0033 §3) — and nowTick's default is 0, so
    // a v1 save records "never settled", exactly as it should.
    expect(out.entities["player-1"]!.lastSeenTick).toBe(0);
    expect(out.entities["player-2"]!.lastSeenTick).toBe(0);
  });

  it("keeps a lastSeenTick the v1 save already carried — it never destroys a fact", () => {
    // v1 saves written after #22 DO carry lastSeenTick (the slot landed mid
    // v1, like `tags`). ADR-0033 §3 predates that and assumes the field is
    // always absent; overwriting 777 with 0 would hand that player a whole
    // world of offline catch-up they never earned.
    const out = migrateSnapshot<SaveDataV2>(
      v1({ "player-1": { id: "player-1", locationId: "room-a", flags: [], lastSeenTick: 777 } }),
    );

    expect(out.entities["player-1"]!.lastSeenTick).toBe(777);
  });

  it("leaves the rest of the record alone: a migration touches nothing else", () => {
    const out = migrateSnapshot<SaveDataV2>(
      v1({
        "player-1": {
          id: "player-1",
          locationId: "room-a",
          flags: ["lit"],
          tags: { zone: ["outdoors"] },
          cooldowns: { doorRelock: 900 },
        },
      }),
    );

    expect(out.entities["player-1"]).toEqual({
      id: "player-1",
      locationId: "room-a",
      flags: ["lit"],
      tags: { zone: ["outdoors"] },
      cooldowns: { doorRelock: 900 },
      lastSeenTick: 0,
    });
  });

  it("does not repair a corrupt entities field — the load still fails loudly", () => {
    // A migration that quietly turned damage into an empty world would be
    // worse than the damage, so the wrong shape passes straight through to
    // the validator.
    const out = migrateSnapshot<SaveDataV2>({ version: 1, data: { entities: "gone" } });

    expect(out.entities).toBe("gone");
  });
});

describe("no v2 → v3 step (ADR-0033 §6)", () => {
  it("rejects a v3 save outright: the chain never migrates two versions at once", () => {
    // "The v2 shape has to be complete" is a promise about the SHAPE, not
    // about the chain's patience: a save from a future version has no path.
    expect(() => migrateSnapshot({ version: SAVE_VERSION + 1, data: {} })).toThrow(
      /unsupported save version/,
    );
  });

  it("is at version 2 — the first time this number ever moved", () => {
    expect(SAVE_VERSION).toBe(2);
    // v1 is still readable (migrated above), v3 is not: exactly one step.
    expect(() => migrateSnapshot({ version: 3, data: {} })).toThrow(/unsupported save version/);
  });
});
