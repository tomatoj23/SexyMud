import type {
  CmdSetSource,
  CommandSpec,
  DueBucket,
  SettleSpan,
  WorldRuntime,
} from "@sexymud/core";

/**
 * Shared rig pieces for the host tests: the synthetic commands, their verb
 * sources, and the two wrappers every rig here wants (a recordable due
 * bucket, a RAM `localStorage`). Synthetic after the settle.test.ts
 * precedent — M4 lands the mechanism, not the real consumers.
 */

export const greet: CommandSpec<WorldRuntime> = {
  key: "greet",
  func: (ctx) => {
    ctx.emit(ctx.command.actorId, { type: "greeted" });
  },
};

export const veto: CommandSpec<WorldRuntime> = {
  key: "veto",
  at_pre_cmd: (ctx) => ctx.veto("gateClosed"),
  func: () => {},
};

/** An input that never becomes a command — must not move the world at all. */
export const broken: CommandSpec<WorldRuntime> = {
  key: "broken",
  parse: () => ({ ok: false, reason: "badInput" }),
  func: () => {},
};

/** Arms a fuse 60 ticks out — the delayed effect a save must not lose. */
export const arm: CommandSpec<WorldRuntime> = {
  key: "arm",
  func: (ctx) => {
    ctx.due.schedule(ctx.clock.nowTick() + 60, { kind: "fuse" });
    ctx.emit(ctx.command.actorId, { type: "armed" });
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
