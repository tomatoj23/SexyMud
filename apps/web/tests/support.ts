import { expect, it } from "vitest";
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
import {
  CloudAuth,
  type AuthState,
  type CloudAuthClient,
  type CloudAuthSession,
} from "../src/game/cloudAuth.js";
import { CloudSaveError } from "../src/game/cloudSaveStore.js";
import type { CloudSaveFailureKind, CloudSaveRecord, CloudSaveTransport } from "../src/game/cloudSaveStore.js";
import { CloudBaseSaveTransport } from "../src/game/cloudbaseTransport.js";
import type {
  CloudBaseDb,
  CloudBaseDbCollection,
  CloudBaseDbResult,
  CloudBaseDbTransaction,
  CloudBaseDbTransactionDocument,
} from "../src/game/cloudbaseTransport.js";
import type { SlotView } from "../src/game/cloudSync.js";

/**
 * Shared rig pieces for the host tests: the synthetic commands, their verb
 * sources, and the wrappers every rig here wants (a recordable due bucket, a
 * RAM `localStorage`, a snapshot through the real serializer). Synthetic
 * after the settle.test.ts precedent — M4 lands the mechanism, not the real
 * consumers.
 *
 * #44 (decision D2) folds the transport-layer fakes and their fault knobs in
 * here too — ONE `FakeTransport` where cloud-sync and cloud-save-store each
 * had a copy, ONE `FakeDb` where cloudbase-transport held its own, and one
 * `expectFailure` where two files spelled the same contract check with two
 * different types. The three suites consume this same set.
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
    attrs: {},
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

/**
 * A RAM transport keeping the contract's law: `write` is an atomic CAS (#44
 * D2 — the ONE fake, where cloud-sync and cloud-save-store each wrote a copy
 * of the same law). Raw rows live in `slots` exactly as `read` hands them out
 * — a damaged one is seeded AS-IS (bad `revision` or bad `text`), because the
 * consumer's own verdicts are the seam here (#32 D6: no knob may reach
 * through the store to fake its internals). Revision tokens are minted
 * GLOBALLY (as real UUIDs are), never per device.
 */
let mintedRevisions = 0;

export class FakeTransport implements CloudSaveTransport {
  /**
   * The backend's rows, raw — pass the SAME map to a second instance to give
   * "another device" a real shared backend (the CAS race then is real).
   */
  readonly slots: Map<string, CloudSaveRecord>;
  /**
   * When set, both operations reject with this error — the offline /
   * auth-expiry paths. It takes the ERROR as-is, not a failure kind: a
   * conforming transport throws {@link CloudSaveError}, and a RAW rejection
   * is how a test drives the host's defensive reading of a contract-violating
   * transport (cloud-sync's "unclassified rejection" case).
   */
  failing: Error | null = null;
  /** When set, only `write` rejects — the session dying mid-flow. */
  failWrite: Error | null = null;
  /** Fires once right after a read — "another device wrote just now". */
  onceAfterRead: (() => void) | null = null;
  /** Call accounting — "no retries, no store pokes" must be provable. */
  reads = 0;
  writes = 0;

  constructor(sharedBackend?: Map<string, CloudSaveRecord>) {
    this.slots = sharedBackend ?? new Map<string, CloudSaveRecord>();
  }

  /** Seeds a raw row AS-IS — the state some earlier session left behind. */
  seed(key: string, text: string, revision = "seed"): void {
    this.slots.set(key, { text, revision });
  }

  async read(key: string): Promise<CloudSaveRecord | null> {
    this.reads += 1;
    if (this.failing) throw this.failing;
    const slot = this.slots.get(key);
    const hook = this.onceAfterRead;
    if (hook) {
      this.onceAfterRead = null;
      hook();
    }
    return slot ? { ...slot } : null;
  }

  async write(key: string, text: string, expectedRevision: string | null): Promise<string> {
    this.writes += 1;
    if (this.failing) throw this.failing;
    if (this.failWrite) throw this.failWrite;
    const slot = this.slots.get(key);
    const current = slot ? slot.revision : null;
    if (current !== expectedRevision) {
      throw new CloudSaveError(
        "conflict",
        `transport: revision is ${String(current)}, expected ${String(expectedRevision)}`,
      );
    }
    const revision = `rev-${++mintedRevisions}`;
    this.slots.set(key, { text, revision });
    return revision;
  }
}

/** A thrown backend failure in SDK shape — `code`/`errorCode`/`statusCode` are its signals. */
export function backendFailure(shape: Record<string, unknown>): Error {
  return Object.assign(new Error("backend: boom"), shape);
}

/**
 * A RAM CloudBase whose document operations carry the DOCUMENTED semantics
 * (#44 D2 — the shared semantic baseline, where cloudbase-transport.test.ts
 * held its own half-copy of the CAS simulation):
 * `where({…}).update(…)` applies only to rows matching the whole filter and
 * reports `updated`; a transaction's `create` is insert-only (an occupied
 * `_id` is `already_exists`), its `get` returns ONE row or null (the real
 * in-transaction shape, unlike the array a plain `get` returns), and a
 * rolled-back transaction applies nothing. Revision tokens are minted
 * GLOBALLY (as real UUIDs are), never per device.
 */
export class FakeDb implements CloudBaseDb {
  readonly rows = new Map<string, { text: unknown; revision: unknown }>();
  /** When set, every operation THROWS this — the offline path. */
  failing: Error | null = null;
  /** When set, doc operations RESOLVE carrying this code — the SDK's error channel. */
  coded: { code: string; message?: string } | null = null;
  /** When set, only `commit` throws — the half-written-row path. */
  failCommit: Error | null = null;
  /** When set, `update` reports this count instead — "no count back" / overcount. */
  updateResult: { updated?: number } | null = null;
  /** Fires inside a transaction after its `get`, before its `create` — the other device commits first. */
  raceCreate: (() => void) | null = null;
  rollbacks = 0;
  private counter = 0;

  /** The transport's minter: fresh and unique for the whole fake backend. */
  mintRevision(): string {
    return `t${++this.counter}`;
  }

  collection(name: string): CloudBaseDbCollection {
    const rows = this.rows;
    const fake = this;
    const probe = () => {
      if (fake.failing) throw fake.failing;
      return fake.coded;
    };
    return {
      doc(id: string) {
        return {
          async get() {
            const coded = probe();
            if (coded) return { ...coded };
            const row = rows.get(id);
            return { data: row ? [{ _id: id, ...row }] : [] };
          },
        };
      },
      where(filter: Record<string, unknown>) {
        return {
          async update(data: Record<string, unknown>) {
            const coded = probe();
            if (coded) return { ...coded };
            if (fake.updateResult) return fake.updateResult;
            const id = String(filter["_id"]);
            const row = rows.get(id);
            const matches =
              row !== undefined &&
              Object.entries(filter).every(([field, value]) =>
                field === "_id" ? true : (row as Record<string, unknown>)[field] === value,
              );
            if (!matches) return { updated: 0 };
            rows.set(id, { text: data["text"], revision: data["revision"] });
            return { updated: 1 };
          },
        };
      },
    };
  }

  startTransaction(): Promise<CloudBaseDbTransaction> {
    // Transaction bootstrap THROWS coded failures (verified in the SDK runtime).
    if (this.failing) return Promise.reject(this.failing);
    if (this.coded) return Promise.reject(backendFailure({ code: this.coded.code }));
    const rows = this.rows;
    const failCommit = this.failCommit;
    const raceCreate = this.raceCreate;
    const fake = this;
    const staged: { id: string; row: { text: unknown; revision: unknown } }[] = [];
    const document = (id: string): CloudBaseDbTransactionDocument => ({
      async get() {
        // The REAL in-transaction shape: one row or null — not an array.
        const row = staged.find((s) => s.id === id)?.row ?? rows.get(id);
        return { data: row ? { _id: id, ...row } : null };
      },
      async create(data: Record<string, unknown>) {
        raceCreate?.();
        if (staged.some((s) => s.id === id) || rows.has(id)) {
          throw backendFailure({ code: "already_exists" });
        }
        staged.push({ id, row: { text: data["text"], revision: data["revision"] } });
        return { inserted: 1 };
      },
    });
    return Promise.resolve({
      collection: () => ({ doc: document }),
      async commit() {
        if (failCommit) throw failCommit;
        for (const { id, row } of staged) rows.set(id, row);
      },
      async rollback() {
        fake.rollbacks += 1;
        staged.length = 0;
      },
    });
  }
}

/**
 * Asserts a call failed the way the contract says it must: a `CloudSaveError`
 * carrying the expected KIND — the host reacts differently to each kind, so a
 * bare "it threw" (or a kind-only match) would survive a taxonomy collapse
 * into plain objects (#44 D2: one copy — cloud-save-store and
 * cloudbase-transport each had one, same name, different parameter type).
 */
export async function expectFailure(
  promise: Promise<unknown>,
  kind: CloudSaveFailureKind,
): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected the call to reject with "${kind}"`).toBeInstanceOf(CloudSaveError);
  expect((error as CloudSaveError).kind).toBe(kind);
}

/** The two account fixtures every adapter rig binds transports to (#44 D2). */
export const alice: CloudAuthSession = { uid: "uid-alice", account: "阿丽" };
export const bob: CloudAuthSession = { uid: "uid-bob", account: "阿波" };

/** A transport under test — minter shared with the fake backend (decision D4). */
export function makeTransport(db: FakeDb, session: CloudAuthSession = alice): CloudBaseSaveTransport {
  return new CloudBaseSaveTransport(db, session, { mintRevision: () => db.mintRevision() });
}

/**
 * The failed-probe contract (#43, decision D1/D4) — the seam ruling elevated
 * to a contract BOTH sides of the binding share: a probe that cannot probe is
 * NOT "no session". `restore` REJECTS (the failure's words stay visible) and
 * the state does not move — never "expired", since nothing died. Each side
 * hands in a client whose probe fails its own way — with a failure whose
 * message contains "unreachable": the contract asserts those words survive
 * the trip (the fake rejects raw, the binding wraps without erasing them).
 */
export function probeFailureContract(makeFailingProbeClient: () => CloudAuthClient): void {
  it("a FAILED probe leaves the state alone — an unreachable backend is not a logout", async () => {
    const auth = new CloudAuth(makeFailingProbeClient());
    const moved: AuthState[] = [];
    const unsubscribe = auth.subscribe(() => moved.push(auth.state));

    await expect(auth.restore()).rejects.toThrow("unreachable");
    expect(auth.state).toEqual({ status: "signed-out" }); // unchanged, and never "expired"
    // A state move ALWAYS notifies (transition is the only writer) — nothing
    // moved iff nothing fired. This is the half that bites "transition first,
    // rethrow after" mutations; the deep-equal above alone cannot tell a
    // signed-out→signed-out move from no move at all.
    expect(moved).toEqual([]);
    unsubscribe();
  });
}
