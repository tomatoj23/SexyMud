import { customCode, customEvent, serializeWorld, summaryOf } from "@sexymud/core";
import type {
  CmdSetSource,
  CommandSpec,
  DueBucket,
  EntityState,
  SettleSpan,
  Snapshot,
  WorldMeta,
  WorldRuntime,
  WorldState,
} from "@sexymud/core";
import type { CloudSaveRecord } from "../src/game/cloudSaveStore.js";
import type { SlotView } from "../src/game/cloudSync.js";

/**
 * Shared rig pieces for the host tests: the synthetic commands, their verb
 * sources, and the wrappers every rig here wants (a recordable due bucket, a
 * RAM `localStorage`, a snapshot through the real serializer). Synthetic
 * after the settle.test.ts precedent — M4 lands the mechanism, not the real
 * consumers.
 */

/**
 * A v2 snapshot through the REAL serializer — the exact bytes every save
 * store must round-trip and interchange (spec/04 §1.6). Options pick the two
 * knobs a store test wants to vary: the world's tick, or the entity's flags.
 */
export function snapshotFixture(options: { nowTick?: number; flags?: string[] } = {}): Snapshot {
  const jia: EntityState = {
    id: "jia",
    locationId: "room-a",
    flags: options.flags ?? ["seen"],
    tags: { realm: ["jianghu"] },
    lastSeenTick: 20,
    cooldowns: { "skill-x": 70 },
  };
  const world: WorldState = { entities: { jia } };
  const meta: WorldMeta = {
    nowTick: options.nowTick ?? 20,
    rngState: 12345,
    due: [{ dueTick: 70, payload: { kind: "fuse" } }],
  };
  return serializeWorld(world, meta);
}

/** A `save` view as the machine builds one — snapshot AND summary (#46). */
export function saveView(snapshot: Snapshot): SlotView {
  return { kind: "save", snapshot, summary: summaryOf(snapshot) };
}

export const greet: CommandSpec<WorldRuntime> = {
  key: "greet",
  func: (ctx) => {
    ctx.emit(ctx.command.actorId, customEvent("greeted"));
  },
};

export const veto: CommandSpec<WorldRuntime> = {
  key: "veto",
  at_pre_cmd: (ctx) => ctx.veto(customCode("gateClosed")),
  func: () => {},
};

/** An input that never becomes a command — must not move the world at all. */
export const broken: CommandSpec<WorldRuntime> = {
  key: "broken",
  parse: () => ({ ok: false, reason: customCode("badInput") }),
  func: () => {},
};

/** Arms a fuse 60 ticks out — the delayed effect a save must not lose. */
export const arm: CommandSpec<WorldRuntime> = {
  key: "arm",
  func: (ctx) => {
    ctx.due.schedule(ctx.clock.nowTick() + 60, { kind: "fuse" });
    ctx.emit(ctx.command.actorId, customEvent("armed"));
  },
};

export const SPECS = new Map<string, CommandSpec<WorldRuntime>>([
  ["greet", greet],
  ["veto", veto],
  ["broken", broken],
  ["arm", arm],
]);

export const SOURCES: readonly CmdSetSource[] = [
  {
    priority: 0,
    commands: [
      { key: "greet", verbs: ["greet"] },
      { key: "veto", verbs: ["veto"] },
      { key: "broken", verbs: ["broken"] },
      { key: "arm", verbs: ["arm"] },
    ],
  },
];

/**
 * Wraps a bucket so the spans the settler hands its world layer are
 * observable without a second seam — the bucket IS that layer (spec/04
 * §4.5), so delegation plus recording is the whole wrapper.
 */
export function recordingBucket(bucket: DueBucket, worldSpans: SettleSpan[]): DueBucket {
  return {
    schedule: (dueTick, payload) => bucket.schedule(dueTick, payload),
    settle: (span, emit) => {
      worldSpans.push(span);
      bucket.settle(span, emit);
    },
    snapshot: () => bucket.snapshot(),
    restore: (items) => bucket.restore(items),
  };
}

/** A `Storage` for the test process — the real SaveStore, fake RAM. */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/**
 * A cloud record whose REVISION anchor is damaged — the read hands out a
 * non-string token, so no CAS can ever be armed against it (#32's "bad
 * revision row"; the sibling "bad text row" is seeded as plain unparsable
 * text). A DIRECTLY CONSTRUCTED fake transport row, never a knob reaching
 * through the store (#32 D6) — both store-level and sync-level suites seed
 * damage this way.
 */
export function anchorDamaged(text: string): CloudSaveRecord {
  return { text, revision: 17 as unknown as string };
}
