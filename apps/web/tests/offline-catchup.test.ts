import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContentRegistry,
  createDueBucket,
  createEntity,
  createSeededRng,
  createWorldRuntime,
  restoreWorld,
} from "@sexymud/core";
import type { DueBucket, DueItem, Rng, SaveDataV2, SettleSpan, WorldRuntime } from "@sexymud/core";
import { createHostClock } from "../src/game/hostClock.js";
import { LocalSaveStore } from "../src/game/localSaveStore.js";
import { createLocalAuthority } from "../src/game/localAuthority.js";
import { SPECS, SOURCES, memoryStorage, recordingBucket } from "./support.js";

/**
 * The end-to-end run the host ticket exists for (spec/04 §4.2–§4.3, ADR-0032
 * §4): 上线 → 离线 → 回来补算 — log in, walk away, come back and catch up.
 *
 * The three spans of ONE advance function, in the flesh: online commands are
 * spans of a few ticks, the offline gap is an 80-tick span of the same call,
 * and the due bucket fires whatever falls inside the span being settled. The
 * fuse armed before going away goes off in the catch-up and carries the tick
 * it was DUE (ADR-0034 §3) — the save/reload round trip is the scenario the
 * due bucket was designed not to lose ("the player saves, the player comes
 * back, and there is no bomb").
 *
 * The wall clock is the ONLY clock in play: the offline span is measured,
 * not stored (host-clock.test.ts pins why the formula is absolute). The save
 * boundary is the real one — `LocalSaveStore` (pre-dates this ticket) writing
 * real JSON through a RAM `localStorage`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("end-to-end: 上线 → 离线 → 回来补算", () => {
  it("the fuse armed before going away goes off in the catch-up, stamped with its due tick", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const store = new LocalSaveStore("save-slot-1");
    const wall = { ms: 0 };
    const hostClock = createHostClock({ tickSeconds: 1, now: () => wall.ms });

    const registry = createContentRegistry({
      rooms: [
        {
          id: "room-a",
          name: "name-room-a",
          description: "description-room-a",
          enterText: "enter-room-a",
          exits: [],
        },
      ],
    });

    // One rig per session; spans accumulate across both so the offline gap
    // is visible as the third span of the same function.
    const worldSpans: SettleSpan[] = [];
    const entitySpans: { entityId: string; fromTick: number; toTick: number }[] = [];
    const fired: DueItem[] = [];
    const startSession = (runtime: WorldRuntime, rng: Rng, bucket: DueBucket) => {
      return createLocalAuthority({
        runtime,
        rng,
        hostClock,
        specs: SPECS,
        cmdsetsOf: () => SOURCES,
        bucket: recordingBucket(bucket, worldSpans),
        entity: (entityId, span) => {
          entitySpans.push({ entityId, fromTick: span.fromTick, toTick: span.toTick });
        },
      });
    };
    const makeBucket = () =>
      createDueBucket({
        fire: (item, emit) => {
          fired.push(item);
          emit("jia", { type: "fuseFired", kind: (item.payload as { kind: string }).kind });
        },
      });

    // ---- 上线 (login #1) ----
    const runtime1 = createWorldRuntime({ registry });
    runtime1.addEntity(createEntity("jia"), "room-a");
    const authority1 = startSession(runtime1, createSeededRng(1), makeBucket());

    // ---- 在线：布雷 + 一条普通命令 ----
    wall.ms = 10_000;
    const armed = await authority1.dispatch({ seq: 1, actorId: "jia", tick: 10, raw: "arm" });
    expect(armed.ok).toBe(true);
    wall.ms = 20_000;
    await authority1.dispatch({ seq: 2, actorId: "jia", tick: 20, raw: "greet" });

    // ---- 离线：存档后走开，墙钟走它的 ----
    await store.save(await authority1.snapshot());
    wall.ms = 100_000; // 80 ticks away

    // ---- 回来 (login #2)：读档重挂 ----
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    const { state, meta } = restoreWorld(loaded!);
    // The save's scalars came back whole: the mark, the stream, the bomb.
    expect(meta.nowTick).toBe(20);
    expect(meta.due).toEqual([{ dueTick: 70, payload: { kind: "fuse" } }]);

    const runtime2 = createWorldRuntime({ registry, state, nowTick: meta.nowTick });
    runtime2.attachEntity(createEntity("jia"));
    const authority2 = startSession(runtime2, createSeededRng(meta.rngState), (() => {
      const bucket = makeBucket();
      bucket.restore(meta.due);
      return bucket;
    })());

    // Nothing has moved yet: catch-up happens when the world is OBSERVED,
    // not when a clock ticks (spec/04 §4.2).
    expect(fired).toEqual([]);

    // ---- 回来补算：回来后的第一条命令把两层都补上 ----
    const result = await authority2.dispatch({
      seq: 3,
      actorId: "jia",
      tick: hostClock.nowTick(),
      raw: "greet",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Settlement in front of the command's own events — "what happened while
    // you were away" reads first (ADR-0034 §4). The fuse carries 70, the tick
    // it was DUE — not 100, the tick it was caught up on (ADR-0034 §3).
    expect(result.events.map((event) => [event.type, event.tick, event.seq])).toEqual([
      ["fuseFired", 70, 3],
      ["greeted", 100, 3],
    ]);
    expect(fired).toHaveLength(1);

    // The offline span, measured rather than stored: the same advance
    // function, three spans (spec/04 §4.2).
    expect(worldSpans).toEqual([
      { fromTick: 0, toTick: 10 },
      { fromTick: 10, toTick: 20 },
      { fromTick: 20, toTick: 100 },
    ]);
    expect(entitySpans).toEqual([
      { entityId: "jia", fromTick: 0, toTick: 10 },
      { entityId: "jia", fromTick: 10, toTick: 20 },
      { entityId: "jia", fromTick: 20, toTick: 100 },
    ]);
    // The ENGINE wrote the actor's "last settled" back — the host never does.
    expect(runtime2.state.entities["jia"]!.lastSeenTick).toBe(100);

    // And the bomb is gone for good: a second save round-trips an empty bucket.
    const second = await authority2.snapshot();
    expect((second.data as SaveDataV2).due).toEqual([]);
  });
});
