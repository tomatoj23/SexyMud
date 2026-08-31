import { describe, expect, it } from "vitest";
import { ContentRegistry } from "../src/content/registry.js";
import type { GameContentConfig } from "../src/content/types.js";
import { createGame } from "../src/engine/createGame.js";
import { SAVE_VERSION, type GameStateV1 } from "../src/save/migrations.js";
import type { Clock, GameEvent, Rng, SaveStore, Snapshot } from "../src/types.js";

class FakeClock implements Clock {
  constructor(private nowMs: number) {}
  now(): number {
    return this.nowMs;
  }
  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }
}

const fixedRng: Rng = { next: () => 0.5 };

function makeContent(overrides: Partial<GameContentConfig> = {}): GameContentConfig {
  return {
    realms: [
      { id: "realm-01", index: 1, name: "Realm One", cultivationRequired: 100, next: "realm-02" },
      { id: "realm-02", index: 2, name: "Realm Two", cultivationRequired: 300, next: null },
    ],
    activities: [
      {
        id: "act-alpha",
        name: "Alpha Activity",
        progression: { maxLevel: 1, xpPerCycle: 0 },
        rates: [{ resourceId: "res-a", amountPerCycle: 1 }],
        cycleSeconds: 2,
        offlineCapHours: 1,
      },
    ],
    resources: [{ id: "res-a", name: "Resource A", kind: "progress" }],
    progression: { realmResourceId: "res-a" },
    ...overrides,
  };
}

class MemorySaveStore implements SaveStore {
  public snapshot: Snapshot | null = null;
  async load(): Promise<Snapshot | null> {
    return this.snapshot;
  }
  async save(snapshot: Snapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}

function makeGame(overrides: Partial<GameContentConfig> = {}, clock = new FakeClock(0)) {
  return createGame({
    content: ContentRegistry.from(makeContent(overrides)),
    save: new MemorySaveStore(),
    clock,
    rng: fixedRng,
  });
}

describe("createGame (facade behavior seam)", () => {
  it("creates a fresh state at the starting realm", async () => {
    const clock = new FakeClock(1_000_000);
    const game = await makeGame({}, clock);
    expect(game.currentRealm()).toEqual({ id: "realm-01", index: 1, name: "Realm One" });
    expect(game.resourceAmount("res-a")).toBe(0);
    expect(game.activeActivity()).toBeNull();
  });

  it("picks the starting realm by index, not by array order", async () => {
    const game = await makeGame({
      realms: [
        { id: "realm-02", index: 2, name: "Realm Two", cultivationRequired: 300, next: null },
        { id: "realm-01", index: 1, name: "Realm One", cultivationRequired: 100, next: "realm-02" },
      ],
    });
    expect(game.currentRealm()).toEqual({ id: "realm-01", index: 1, name: "Realm One" });
  });

  it("accrues per completed cycle and carries partial cycles over", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    game.startActivity("act-alpha"); // cycle = 2 seconds
    clock.advance(5); // 2.5 cycles -> 2 complete
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(2);
    clock.advance(1); // the pending half cycle completes
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(3);
  });

  it("does not accrue without an active activity", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    clock.advance(60);
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(0);
  });

  it("settles pending cycles when the activity stops, then stops accruing", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    game.startActivity("act-alpha");
    clock.advance(3);
    game.stopActivity(); // settles 1 cycle on the way out
    expect(game.resourceAmount("res-a")).toBe(1);
    clock.advance(10);
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(1);
  });

  it("rejects unknown activities", async () => {
    const game = await makeGame();
    expect(() => game.startActivity("act-nope")).toThrow(/unknown activity/);
  });

  it("caps a single gap at the activity's offline maximum", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    game.startActivity("act-alpha");
    clock.advance(3600 * 100); // 100 hours away, cap is 1 hour
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(1800); // 3600s / 2s per cycle
    // Further ticks accrue normally — the capped window is never re-settled.
    clock.advance(4);
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(1802);
  });

  it("reports progress against the current realm requirement", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    game.startActivity("act-alpha");
    clock.advance(50);
    game.sync();
    expect(game.progress()).toEqual({ resourceId: "res-a", current: 25, required: 100 });
  });

  it("emits context-rich events for activity changes and accrual", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    const events: GameEvent[] = [];
    game.subscribe((event) => events.push(event));

    game.startActivity("act-alpha");
    clock.advance(4);
    game.sync();

    expect(events[0]).toEqual({
      type: "activityStarted",
      activityId: "act-alpha",
      activityName: "Alpha Activity",
    });
    const accrual = events[1];
    if (accrual?.type !== "resourcesAccrued") throw new Error("expected an accrual event");
    expect(accrual.amounts["res-a"]).toBe(2);
    expect(accrual.totals["res-a"]).toBe(2);
    expect(accrual.cycles).toBe(2);
    expect(accrual.settledSeconds).toBe(4);
    expect(accrual.capped).toBe(false);
    expect(accrual.timestamp).toBe(4_000);

    game.stopActivity();
    expect(events[2]).toEqual({
      type: "activityStopped",
      activityId: "act-alpha",
      activityName: "Alpha Activity",
    });
  });

  it("flags capped offline settlements in the event", async () => {
    const clock = new FakeClock(0);
    const game = await makeGame({}, clock);
    const events: GameEvent[] = [];
    game.subscribe((event) => events.push(event));
    game.startActivity("act-alpha");
    clock.advance(3600 * 100);
    game.sync();
    const accrual = events.at(-1);
    if (accrual?.type !== "resourcesAccrued") throw new Error("expected an accrual event");
    expect(accrual.capped).toBe(true);
    expect(accrual.settledSeconds).toBe(3600);
  });

  it("produces a versioned snapshot and restores from it deterministically", async () => {
    const clock = new FakeClock(0);
    const store = new MemorySaveStore();
    const game = await createGame({
      content: ContentRegistry.from(makeContent()),
      save: store,
      clock,
      rng: fixedRng,
    });
    game.startActivity("act-alpha");
    clock.advance(20);
    game.sync();
    expect(game.resourceAmount("res-a")).toBe(10);

    const snapshot = game.snapshot();
    expect(snapshot.version).toBe(SAVE_VERSION);
    await store.save(snapshot);

    clock.advance(30); // offline gap of 30 seconds while "away"
    const restored = await createGame({
      content: ContentRegistry.from(makeContent()),
      save: store,
      clock,
      rng: fixedRng,
    });
    restored.sync();
    expect(restored.resourceAmount("res-a")).toBe(25); // 10 + 15 cycles
    expect(restored.activeActivity()).toEqual({ id: "act-alpha", name: "Alpha Activity" });
    expect(restored.currentRealm()).toEqual({ id: "realm-01", index: 1, name: "Realm One" });
  });

  it("keeps the settle timestamp in the past from a travelling save", async () => {
    const clock = new FakeClock(1_000_000);
    const store = new MemorySaveStore();
    const futureState: GameStateV1 = {
      realmId: "realm-01",
      resources: {},
      activeActivityId: null,
      lastSettleTimestamp: 99_000_000, // ahead of the current clock
    };
    await store.save({ version: SAVE_VERSION, data: futureState });
    const game = await createGame({
      content: ContentRegistry.from(makeContent()),
      save: store,
      clock,
      rng: fixedRng,
    });
    game.sync(); // must not accrue from a future timestamp
    expect(game.resourceAmount("res-a")).toBe(0);
  });

  it("rejects restored states referencing unknown content entries", async () => {
    const store = new MemorySaveStore();
    await store.save({
      version: SAVE_VERSION,
      data: { realmId: "realm-404", resources: {}, activeActivityId: null, lastSettleTimestamp: 0 },
    });
    await expect(makeGameWithStore(store)).rejects.toThrow(/unknown realm/);

    const store2 = new MemorySaveStore();
    await store2.save({
      version: SAVE_VERSION,
      data: { realmId: "realm-01", resources: {}, activeActivityId: "act-ghost", lastSettleTimestamp: 0 },
    });
    await expect(makeGameWithStore(store2)).rejects.toThrow(/unknown activity/);
  });
});

function makeGameWithStore(store: SaveStore, clock = new FakeClock(1_000_000)) {
  return createGame({ content: ContentRegistry.from(makeContent()), save: store, clock, rng: fixedRng });
}

describe("ContentRegistry integrity", () => {
  it("rejects duplicate realm ids", () => {
    const content = makeContent({
      realms: [
        { id: "realm-01", index: 1, name: "A", cultivationRequired: 10, next: "realm-01b" },
        { id: "realm-01", index: 2, name: "B", cultivationRequired: 20, next: null },
        { id: "realm-01b", index: 3, name: "C", cultivationRequired: 30, next: null },
      ],
    });
    expect(() => ContentRegistry.from(content)).toThrow(/duplicate realm id/);
  });

  it("rejects duplicate activity ids", () => {
    const activity = makeContent().activities[0];
    if (!activity) throw new Error("fixture activity missing");
    const content = makeContent({ activities: [activity, activity] });
    expect(() => ContentRegistry.from(content)).toThrow(/duplicate activity id/);
  });

  it("rejects unknown resource references in rates", () => {
    const content = makeContent({
      activities: [
        {
          id: "act-alpha",
          name: "X",
          progression: { maxLevel: 1 },
          rates: [{ resourceId: "res-ghost", amountPerCycle: 1 }],
          cycleSeconds: 1,
        },
      ],
    });
    expect(() => ContentRegistry.from(content)).toThrow(/unknown resource/);
  });

  it("rejects an unknown progression resource", () => {
    const content = makeContent({ progression: { realmResourceId: "res-ghost" } });
    expect(() => ContentRegistry.from(content)).toThrow(/progression\.realmResourceId references unknown resource/);
  });

  it("rejects non-consecutive realm indexes", () => {
    const content = makeContent({
      realms: [
        { id: "realm-01", index: 1, name: "A", cultivationRequired: 10, next: "realm-03" },
        { id: "realm-03", index: 3, name: "C", cultivationRequired: 30, next: null },
      ],
    });
    expect(() => ContentRegistry.from(content)).toThrow(/consecutive/);
  });

  it("rejects rates without a cycle length", () => {
    const content = makeContent({
      activities: [
        {
          id: "act-alpha",
          name: "X",
          progression: { maxLevel: 1 },
          rates: [{ resourceId: "res-a", amountPerCycle: 1 }],
        },
      ],
    });
    expect(() => ContentRegistry.from(content)).toThrow(/cycleSeconds/);
  });

  it("rejects an unknown next realm", () => {
    const content = makeContent({
      realms: [{ id: "realm-01", index: 1, name: "A", cultivationRequired: 10, next: "realm-404" }],
    });
    expect(() => ContentRegistry.from(content)).toThrow(/unknown next realm/);
  });
});
