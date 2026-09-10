import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTickClock } from "../src/clock.js";
import { createSeededRng } from "../src/rng.js";
import { runCommand } from "../src/command/pipeline.js";
import type { CommandSpec, MessageSink } from "../src/command/pipeline.js";
import { createCommandHarness } from "../src/command/testing.js";
import type { WorldState } from "../src/state/tree.js";
import { createSettler } from "../src/time/settle.js";
import type { Settler } from "../src/time/settle.js";
import { createDueBucket } from "../src/time/due.js";
import type { DueItem } from "../src/time/due.js";

/**
 * The due bucket (spec/04 §4.5, ADR-0032 §5, ADR-0034 §3): the one primitive
 * that cannot be a pure function, and therefore the one that must be storable.
 *
 * Synthetic throughout, after the `entity-seams.test.ts` precedent: the
 * payloads are shapes no content pack ships, the handlers are closures the
 * test owns, and nothing reads real content. A fuse or a delayed detonation
 * rides this seam without reshaping it.
 */

const RECEIVERS = ["jia", "broadcast"];

function world(): WorldState {
  return {
    entities: {
      jia: {
        id: "jia",
        locationId: "room-a",
        flags: [],
        tags: {},
        lastSeenTick: 0,
        cooldowns: {},
      },
    },
  };
}

/** A recording handler: what fired, in order, and what it was handed. */
function recorder() {
  const fired: DueItem[] = [];
  const bucket = createDueBucket({
    fire: (item) => {
      fired.push(item);
    },
  });
  return { bucket, fired };
}

/** A settler whose world layer is the bucket's. */
function settling(bucket: ReturnType<typeof createDueBucket>, nowTick = 0): Settler {
  return createSettler({ state: world(), clock: createTickClock(nowTick), world: bucket.settle });
}

describe("the due bucket fires what is due (spec/04 §4.5)", () => {
  it("fires an item at its own tick, and nothing before it", () => {
    const { bucket, fired } = recorder();
    const settler = settling(bucket);

    bucket.schedule(50, { kind: "fuse" });
    expect(settler.settleTo({ toTick: 49, seq: 1 })).toEqual([]);
    expect(fired).toEqual([]);

    settler.settleTo({ toTick: 50, seq: 2 });
    expect(fired).toEqual([{ dueTick: 50, payload: { kind: "fuse" } }]);

    // Gone, not merely quiet: a one-shot effect fires once.
    settler.settleTo({ toTick: 500, seq: 3 });
    expect(fired).toHaveLength(1);
  });

  it("fires in ascending dueTick — insertion order is not the order", () => {
    const { bucket, fired } = recorder();
    bucket.schedule(300, "third");
    bucket.schedule(100, "first");
    bucket.schedule(200, "second");

    settling(bucket).settleTo({ toTick: 400, seq: 1 });

    expect(fired.map((item) => item.payload)).toEqual(["first", "second", "third"]);
  });

  it("keeps items sharing one tick in the order they were armed — the stable promise", () => {
    const { bucket, fired } = recorder();
    bucket.schedule(70, "a");
    bucket.schedule(70, "b");
    bucket.schedule(70, "c");
    bucket.schedule(60, "earlier");

    settling(bucket).settleTo({ toTick: 100, seq: 1 });

    expect(fired.map((item) => item.payload)).toEqual(["earlier", "a", "b", "c"]);
  });

  it("fires an item due exactly at the tick being settled to — now >= due, like a cooldown", () => {
    // The span `[fromTick, toTick)` says what ELAPSED; it does not say the
    // tick at its end has not arrived. So "is it due?" reads `to >= dueTick`
    // here and `nowTick >= dueTick` in a cooldown — one rule, not two.
    const { bucket, fired } = recorder();
    bucket.schedule(100, "at-the-edge");
    const settler = settling(bucket);

    settler.settleTo({ toTick: 99, seq: 1 });
    expect(fired).toEqual([]);

    settler.settleTo({ toTick: 100, seq: 2 });
    expect(fired).toEqual([{ dueTick: 100, payload: "at-the-edge" }]);
  });

  it("treats an overdue item as overdue, not lost: it fires at the next settle", () => {
    // Armed for a tick that has already passed. There is no lower bound on
    // the span — an item that is due IS due, whenever it gets noticed.
    const { bucket, fired } = recorder();
    bucket.schedule(5, "late-armed");

    settling(bucket, 100).settleTo({ toTick: 200, seq: 1 });

    expect(fired).toEqual([{ dueTick: 5, payload: "late-armed" }]);
  });

  it("does not fire a follow-up armed by its own handler until the next settle", () => {
    const fired: string[] = [];
    let armed = false;
    const bucket = createDueBucket({
      fire: (item) => {
        fired.push(String(item.payload));
        if (!armed) {
          armed = true;
          bucket.schedule(item.dueTick + 10, "the-second-one");
        }
      },
    });
    const settler = settling(bucket);

    bucket.schedule(10, "the-first-one");
    settler.settleTo({ toTick: 100, seq: 1 });
    // A chain of explosions must not all go off inside the settle that lit
    // the first one: the follow-up belongs to the NEXT span.
    expect(fired).toEqual(["the-first-one"]);

    settler.settleTo({ toTick: 200, seq: 2 });
    expect(fired).toEqual(["the-first-one", "the-second-one"]);
  });

  it("fails loudly on a due tick that is not a tick", () => {
    const { bucket } = recorder();

    expect(() => bucket.schedule(-1, "x")).toThrow(/due bucket: schedule dueTick/);
    expect(() => bucket.schedule(1.5, "x")).toThrow(/due bucket: schedule dueTick/);
    // A NaN due tick compares false against EVERY tick: the item would stay
    // armed forever, which is worse than refusing to arm it.
    expect(() => bucket.schedule(Number.NaN, "x")).toThrow(/due bucket: schedule dueTick/);
  });
});

describe("the payload is opaque (spec/04 §4.5, ADR-0034 §3)", () => {
  it("hands the payload back exactly as it was given — the engine never reads it", () => {
    const payload = { roomId: "room-a", nested: { charge: 3 }, list: [1, 2] };
    const { bucket, fired } = recorder();

    bucket.schedule(10, payload);
    settling(bucket).settleTo({ toTick: 20, seq: 1 });

    expect(fired[0]!.payload).toEqual(payload);
  });

  it("stamps the event with the DUE tick, and leaves the handler no way to choose one", () => {
    const bucket = createDueBucket({
      fire: (_item, emit) => emit("broadcast", { type: "exploded" }),
    });
    bucket.schedule(300, "bomb");

    const out = settling(bucket).settleTo({ toTick: 1000, seq: 2 });

    // Due at 300, only noticed at 1000: the event says 300. Writing 1000
    // would make event order depend on which player logged in first.
    expect(out).toEqual([
      { to: "broadcast", event: { seq: 2, tick: 300, type: "exploded", actorId: "" } },
    ]);
  });

  it("survives a JSON boundary: an armed bomb is still armed after a reload", () => {
    const { bucket, fired } = recorder();
    bucket.schedule(400, { roomId: "room-c", charge: 9 });
    bucket.schedule(120, { roomId: "room-a", charge: 1 });

    // The wire: opaque runtime data crosses a process boundary as JSON,
    // exactly like a save (spec/04 §4.5 — a closure could not do this).
    const wire = JSON.parse(JSON.stringify(bucket.snapshot())) as DueItem[];
    const reloaded = createDueBucket({ fire: () => {} });
    reloaded.restore(wire);

    expect(reloaded.snapshot()).toEqual(bucket.snapshot());
    // Canonical order survives the boundary too: ascending, whatever order
    // the items were armed in.
    expect(reloaded.snapshot()[0]!.payload).toEqual({ roomId: "room-a", charge: 1 });

    settling(reloaded).settleTo({ toTick: 500, seq: 1 });
    expect(fired).toEqual([]);
    expect(reloaded.snapshot()).toEqual([]);
  });

  it("rejects a corrupt pending set instead of loading half of it", () => {
    const bucket = createDueBucket({ fire: () => {} });

    expect(() =>
      bucket.restore([{ dueTick: 5, payload: 1 }, null as unknown as DueItem]),
    ).toThrow(/due bucket: item 1 is not an object/);
    expect(() => bucket.restore([{ dueTick: -3, payload: 1 }])).toThrow(
      /due bucket: item 0\.dueTick/,
    );
    // Resolved in full before anything is replaced: the bucket is untouched.
    expect(bucket.snapshot()).toEqual([]);
  });
});

describe("O4: the bucket is global and flat (spec/04 §6)", () => {
  it("offers no way to index due items by room, area or entity", () => {
    // Deliberate: "the bomb in this room" is a payload that happens to carry
    // a room id, not a query the engine answers. Pinning the surface stops
    // someone adding the index later and quietly paying for it.
    const bucket = createDueBucket({ fire: () => {} });
    expect(Object.keys(bucket).sort()).toEqual(["restore", "schedule", "settle", "snapshot"]);
  });
});

describe("O8: the host's handler reaches the engine through a dependency (spec/04 §6)", () => {
  const arming: CommandSpec<WorldState> = {
    key: "lightFuse",
    func: (ctx) => {
      ctx.due.schedule(ctx.clock.nowTick() + 50, { roomId: "room-a" });
      ctx.emit(ctx.command.actorId, { type: "fuseLit" });
    },
  };

  it("lets a command arm an item through deps.due — injected by the host, not read from a registry", () => {
    const { bucket, fired } = recorder();
    const harness = createCommandHarness<WorldState>({
      world: world(),
      receivers: RECEIVERS,
      liveWorld: true,
      due: bucket,
    });

    harness.call(arming, "light", { seq: 1, actorId: "jia", tick: 10 });
    expect(bucket.snapshot()).toEqual([{ dueTick: 60, payload: { roomId: "room-a" } }]);
    expect(fired).toEqual([]);

    settling(bucket).settleTo({ toTick: 60, seq: 2 });
    expect(fired).toEqual([{ dueTick: 60, payload: { roomId: "room-a" } }]);
  });

  it("fails loudly when a command arms without a bucket — a lost fuse, not a quiet no-op", () => {
    const sink: MessageSink = { emit: () => {} };

    expect(() =>
      runCommand(
        arming,
        { seq: 1, actorId: "jia", tick: 10, raw: "light" },
        { nowTick: 10, rng: createSeededRng(1), world: world(), sink },
      ),
    ).toThrow(/no due bucket was provided \(deps\.due\)/);
  });
});

describe("invalid input never fires the bucket (spec/04 §4.1)", () => {
  it("does not even call the advance: a bomb cannot be fast-forwarded with garbage", () => {
    const { bucket, fired } = recorder();
    bucket.schedule(30, "bomb");

    let settleCalls = 0;
    let settler: Settler | undefined;
    const state = world();
    const harness = createCommandHarness<WorldState>({
      world: state,
      receivers: RECEIVERS,
      liveWorld: true,
      settle: (request) => {
        settleCalls += 1;
        return settler!.settleTo(request);
      },
    });
    settler = createSettler({ state, clock: harness.clock, world: bucket.settle });

    const broken: CommandSpec<WorldState> = {
      key: "broken",
      parse: () => ({ ok: false, reason: "badInput" }),
      func: () => {},
    };
    for (let i = 0; i < 5; i += 1) {
      const out = harness.call(broken, "乱码", { seq: 10 + i, actorId: "jia", tick: 1000 });
      expect(out.result).toMatchObject({ ok: false, kind: "invalid" });
    }

    // 5000 ticks of malformed input: the advance was never called, so
    // nothing was due and nothing fired.
    expect(settleCalls).toBe(0);
    expect(fired).toEqual([]);
    expect(harness.clock.nowTick()).toBe(0);
  });
});

describe("the constructive guarantee (spec/04 §4.4, ADR-0032 §6)", () => {
  it("settles a million ticks in one call and three items — no per-tick loop", () => {
    let worldCalls = 0;
    let handlerCalls = 0;
    const bucket = createDueBucket({
      fire: (_item, emit) => {
        handlerCalls += 1;
        emit("broadcast", { type: "wentOff" });
      },
    });
    bucket.schedule(250_000, 1);
    bucket.schedule(750_000, 2);
    bucket.schedule(999_999, 3);

    const settler = createSettler({
      state: world(),
      clock: createTickClock(0),
      world: (span, emit) => {
        worldCalls += 1;
        bucket.settle(span, emit);
      },
    });

    const started = performance.now();
    const messages = settler.settleTo({ toTick: 1_000_000, seq: 1 });
    const elapsedMs = performance.now() - started;

    // The iteration bound: a span of a million ticks costs ONE world-layer
    // call and three handler calls. Anything that walks ticks shows up here
    // first, and as a million events a moment later.
    expect(worldCalls).toBe(1);
    expect(handlerCalls).toBe(3);
    expect(messages).toHaveLength(3);
    // The time bound behind it: a per-tick loop would allocate a million
    // events and blow past this by orders of magnitude.
    expect(elapsedMs).toBeLessThan(100);
  });

  it("has no numeric catch-up cap anywhere — the guarantee is structural, not a knob", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];

    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? files(full) : [full];
      });

    for (const file of [...files(resolve(here, "../src")), ...files(resolve(here, "../../../content/config"))]) {
      if (readFileSync(file, "utf8").includes("maxCatchUpTicks")) {
        offenders.push(file);
      }
    }

    // A truncation knob would make the world depend on how often a player
    // logs in — and it would be a hard-coded number that changes what the
    // game MEANS. The bound above is what replaces it.
    expect(offenders).toEqual([]);
  });
});
