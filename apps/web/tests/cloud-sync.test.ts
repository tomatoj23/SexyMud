import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@sexymud/core";
import { CloudSaveError, CloudSaveStore } from "../src/game/cloudSaveStore.js";
import type { CloudSaveRecord, CloudSaveTransport } from "../src/game/cloudSaveStore.js";
import { LocalSaveStore } from "../src/game/localSaveStore.js";
import { CloudSync, type SlotView } from "../src/game/cloudSync.js";
import { memoryStorage, snapshotFixture } from "./support.js";

/**
 * The host's cloud-sync surface (#30): the sync STATUS ("saved / not saved /
 * conflicted / session expired") and the CONFLICT ADJUDICATION the player
 * sees. The seam is the state machine above the REAL `CloudSaveStore` and
 * `LocalSaveStore`, played against a contract-faithful fake transport.
 *
 * What the tests pin is decision D3, D7 and D8 — the "never silently
 * degrade" rules of #29 D5 wearing a UI hat:
 *
 *   - sync is an EXPLICIT action (decision D3): login auto-uploads nothing
 *     and merges nothing; the probe only shows the player both sides;
 *   - a refused save surfaces as `conflict` with BOTH sides visible and
 *     three explicit exits (decision D7): keep local (deliberate replace),
 *     take remote (download), or dismiss and play on locally;
 *   - failures are loud and leave BOTH stores untouched (decision D8):
 *     "not saved" never pretends "saved", never falls back to local-only;
 *   - an `auth` failure ends the instance (decision D6): the re-login guide
 *     comes up and NOTHING retries on its own.
 */

/** A RAM transport keeping the contract's law: `write` is an atomic CAS. */
class FakeTransport implements CloudSaveTransport {
  readonly slots = new Map<string, { text: string; revision: number }>();
  /** When set, both operations reject with this error — the offline / auth-expiry paths. */
  failing: Error | null = null;
  /** When set, only `write` rejects — the session dying mid-flow. */
  failWrite: Error | null = null;
  /** Fires once right after a read — "another device wrote just now". */
  onceAfterRead: (() => void) | null = null;
  /** Call accounting — "no retries, no store pokes" must be provable. */
  reads = 0;
  writes = 0;

  async read(key: string): Promise<CloudSaveRecord | null> {
    this.reads += 1;
    if (this.failing) throw this.failing;
    const slot = this.slots.get(key);
    const record = slot ? { text: slot.text, revision: String(slot.revision) } : null;
    const hook = this.onceAfterRead;
    if (hook) {
      this.onceAfterRead = null;
      hook();
    }
    return record;
  }

  async write(key: string, text: string, expectedRevision: string | null): Promise<string> {
    this.writes += 1;
    if (this.failing) throw this.failing;
    if (this.failWrite) throw this.failWrite;
    const slot = this.slots.get(key);
    const current = slot ? String(slot.revision) : null;
    if (current !== expectedRevision) {
      throw new CloudSaveError("conflict", `transport: revision is ${current}, expected ${expectedRevision}`);
    }
    const revision = (slot?.revision ?? 0) + 1;
    this.slots.set(key, { text, revision });
    return String(revision);
  }
}

const KEY = "save-slot-1";

/** The rig: real stores over a fake transport, a spy for session expiry. */
function rig() {
  const transport = new FakeTransport();
  const local = new LocalSaveStore(KEY);
  const cloud = new CloudSaveStore(transport, KEY);
  const expired: string[] = [];
  const sync = new CloudSync(cloud, local, { markExpired: () => expired.push("expired") });
  return { transport, local, cloud, sync, expired };
}

/** The remote slot's text, or `undefined` when the slot is empty. */
function remoteText(transport: FakeTransport): string | undefined {
  return transport.slots.get(KEY)?.text;
}

/** Seeds the remote slot directly — the state some other device left behind. */
function seedRemote(transport: FakeTransport, snapshot: Snapshot): void {
  transport.slots.set(KEY, { text: JSON.stringify(snapshot), revision: 1 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudSync — probe shows both sides; sync is never automatic (decision D3)", () => {
  it("both sides empty → idle, no conflict, nothing written anywhere", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();

    await sync.probe();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("none");
    expect(sync.localView).toEqual({ kind: "empty" });
    expect(sync.remoteView).toEqual({ kind: "empty" });
    expect(transport.writes).toBe(0); // the probe never writes
  });

  it("a local save with an empty cloud stays 'idle' — the probe offers, it does not upload", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));

    await sync.probe();

    expect(sync.state.phase).toBe("idle");
    expect(sync.localView.kind).toBe("save");
    expect(sync.remoteView.kind).toBe("empty");
    expect(transport.writes).toBe(0);
  });

  it("two identical saves read as in-sync — byte-equal is no divergence", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const snapshot = snapshotFixture({ nowTick: 20 });
    await local.save(snapshot);
    seedRemote(transport, snapshot);

    await sync.probe();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("in-sync");
  });

  it("two DIFFERENT saves land in the compare conflict — both sides visible, no automatic merge (decisions D3/D7)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const localSnapshot = snapshotFixture({ nowTick: 20 });
    const remoteSnapshot = snapshotFixture({ nowTick: 99 });
    await local.save(localSnapshot);
    seedRemote(transport, remoteSnapshot);

    await sync.probe();

    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" });
    expect(sync.localView).toEqual({ kind: "save", snapshot: localSnapshot });
    expect(sync.remoteView).toEqual({ kind: "save", snapshot: remoteSnapshot });
  });

  it("a corrupt remote is a VISIBLE damage, not a probe failure — the player sees what is there", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    transport.slots.set(KEY, { text: "{not json", revision: 1 });

    await sync.probe();

    expect(sync.state.phase).toBe("idle");
    expect(sync.remoteView).toEqual({ kind: "corrupt" });
  });

  it("an offline probe fails loudly as 'network' — never an empty cloud to quietly assume", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    transport.failing = new TypeError("Failed to fetch");

    await sync.probe();

    expect(sync.state).toEqual({ phase: "failed", failure: "network", action: "probe" });
  });
});

describe("CloudSync — upload: observe then write (decision D8)", () => {
  it("first upload creates the cloud save — the 'enable cross-device' moment", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    const snapshot = snapshotFixture({ nowTick: 20 });

    await sync.upload(snapshot);

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("saved");
    expect(remoteText(transport)).toBe(JSON.stringify(snapshot));
  });

  it("upload over an existing cloud save is the DELIBERATE replace — observe first, then write", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));

    await sync.upload(snapshotFixture({ nowTick: 20 }));

    expect(remoteText(transport)).toBe(JSON.stringify(snapshotFixture({ nowTick: 20 })));
    expect(sync.last).toBe("saved");
  });

  it("upload over a CORRUPT cloud save lands — the repair path #29 deliberately kept open", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    transport.slots.set(KEY, { text: "{not json", revision: 1 });
    const snapshot = snapshotFixture({ nowTick: 20 });

    await sync.upload(snapshot);

    expect(remoteText(transport)).toBe(JSON.stringify(snapshot));
    expect(sync.last).toBe("saved");
  });

  it("a save refused by another session's write surfaces as 'conflict' with the other side visible", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    const theirs = snapshotFixture({ nowTick: 99 });
    // The world moves between our observe and our write — exactly the CAS race.
    transport.onceAfterRead = () => {
      transport.slots.set(KEY, { text: JSON.stringify(theirs), revision: 2 });
    };

    await sync.upload(snapshotFixture({ nowTick: 20 }));

    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });
    expect(sync.remoteView).toEqual({ kind: "save", snapshot: theirs });
  });

  it("offline: upload fails 'network' and BOTH stores are untouched — 'not saved' never pretends 'saved' (decision D8)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    transport.failing = new TypeError("Failed to fetch");

    await sync.upload(snapshotFixture({ nowTick: 20 }));

    expect(sync.state).toEqual({ phase: "failed", failure: "network", action: "upload" });
    expect(transport.slots.has(KEY)).toBe(false); // remote untouched
  });
});

describe("CloudSync — download: cloud into the local slot", () => {
  it("download writes the local slot and reports it", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const snapshot = snapshotFixture({ nowTick: 99 });
    seedRemote(transport, snapshot);

    await sync.download();

    expect(sync.last).toBe("downloaded");
    await expect(local.load()).resolves.toEqual(snapshot);
  });

  it("an empty cloud is 'remote-empty', not a failure — and local is untouched", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);

    await sync.download();

    expect(sync.last).toBe("remote-empty");
    await expect(local.load()).resolves.toEqual(mine);
  });

  it("a corrupt cloud save cannot be downloaded — loud 'corrupt', local untouched", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    transport.slots.set(KEY, { text: "{not json", revision: 1 });
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);

    await sync.download();

    expect(sync.state).toEqual({ phase: "failed", failure: "corrupt", action: "download" });
    await expect(local.load()).resolves.toEqual(mine);
  });
});

describe("CloudSync — conflict adjudication: three explicit exits (decision D7)", () => {
  /** Drives the rig into the compare conflict. */
  async function conflictRig() {
    const rig_ = rig();
    const localSnapshot = snapshotFixture({ nowTick: 20 });
    const remoteSnapshot = snapshotFixture({ nowTick: 99 });
    await rig_.local.save(localSnapshot);
    seedRemote(rig_.transport, remoteSnapshot);
    await rig_.sync.probe();
    expect(rig_.sync.state.phase).toBe("conflict");
    return { ...rig_, localSnapshot, remoteSnapshot };
  }

  it("dismiss → play on locally, cloud untouched, and the state says so", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync, remoteSnapshot } = await conflictRig();

    sync.dismiss();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("dismissed");
    expect(remoteText(transport)).toBe(JSON.stringify(remoteSnapshot));
  });

  it("keep local → the deliberate replace: upload overwrites the cloud after re-observing", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync, localSnapshot } = await conflictRig();

    await sync.upload(localSnapshot);

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("saved");
    expect(remoteText(transport)).toBe(JSON.stringify(localSnapshot)); // the other side's is gone — deliberately
  });

  it("keep remote → download lands the cloud save into the local slot", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync, remoteSnapshot } = await conflictRig();

    await sync.download();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("downloaded");
    await expect(local.load()).resolves.toEqual(remoteSnapshot);
  });
});

describe("CloudSync — an auth failure ends the instance (decision D6)", () => {
  it("an expired session → the re-login guide, the expiry sink is told, and nothing retries", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync, expired } = rig();
    // The session dies mid-flow: the observe succeeds, the write is refused.
    transport.failWrite = new CloudSaveError("auth", "session expired");

    await sync.upload(snapshotFixture({ nowTick: 20 }));

    expect(sync.state.phase).toBe("auth-expired");
    expect(expired).toEqual(["expired"]); // CloudAuth flips to its 'expired' prompt
    expect(transport.writes).toBe(1); // one attempt, zero retries — the failure is the end of it
  });

  it("after expiry every action refuses WITHOUT touching the stores — the player's re-login is the only way back", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    transport.failing = new CloudSaveError("auth", "session expired");
    await sync.probe();
    expect(sync.state.phase).toBe("auth-expired");

    const readsBefore = transport.reads;
    await expect(sync.upload(snapshotFixture())).rejects.toThrow(/sign in again/i);
    await expect(sync.download()).rejects.toThrow(/sign in again/i);
    await expect(sync.probe()).rejects.toThrow(/sign in again/i);

    expect(transport.reads).toBe(readsBefore); // zero further backend calls
    await expect(local.load()).resolves.toBeNull();
  });
});

describe("CloudSync — busy is a refusal, not a queue", () => {
  it("an overlapping action rejects while one is in flight", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();

    const first = sync.upload(snapshotFixture({ nowTick: 20 }));
    await expect(sync.upload(snapshotFixture({ nowTick: 30 }))).rejects.toThrow(/in flight/i);
    await first;
  });
});

describe("CloudSync — state changes are observable (the panel follows, never polls)", () => {
  it("every transition notifies subscribers", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();
    const seen: string[] = [];
    const unsubscribe = sync.subscribe(() => seen.push(sync.state.phase));

    await sync.probe();
    await sync.upload(snapshotFixture({ nowTick: 20 }));
    unsubscribe();

    expect(seen).toEqual(["busy", "idle", "busy", "idle"]);
  });
});

describe("CloudSync — the comparison views carry what the dialog shows", () => {
  it("a save view carries the snapshot (version and tick readable for the dialog)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    const snapshot = snapshotFixture({ nowTick: 42 });
    seedRemote(transport, snapshot);

    await sync.probe();

    const view: SlotView = sync.remoteView;
    expect(view).toMatchObject({ kind: "save" });
    if (view.kind === "save") {
      expect(view.snapshot.version).toBe(snapshot.version);
      expect(view.snapshot.data).toMatchObject({ nowTick: 42 });
    }
  });
});
