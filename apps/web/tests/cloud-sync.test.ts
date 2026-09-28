import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveStore, Snapshot } from "@sexymud/core";
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
 *
 * #31 adds the payload rule: an upload SENDS the local slot's current
 * content, read by the machine (`upload()` takes no argument) — and the
 * read is the action's very front, so an empty slot ("local-empty") or a
 * damaged one ("local-corrupt") never reaches the backend at all.
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
  /** When set, reads hand this out as the revision — a damaged record anchor. */
  revisionDamage: unknown = null;
  /** Call accounting — "no retries, no store pokes" must be provable. */
  reads = 0;
  writes = 0;

  async read(key: string): Promise<CloudSaveRecord | null> {
    this.reads += 1;
    if (this.failing) throw this.failing;
    const slot = this.slots.get(key);
    const record = slot
      ? {
          text: slot.text,
          revision: (this.revisionDamage ?? String(slot.revision)) as string,
        }
      : null;
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

  it("a corrupt LOCAL slot is visible damage in the probe, not a probe failure", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();
    localStorage.setItem(KEY, "{not json"); // the local half is damaged too

    await sync.probe();

    expect(sync.state.phase).toBe("idle");
    expect(sync.localView).toEqual({ kind: "corrupt" });
  });

  it("an offline probe fails loudly as 'network' — never an empty cloud to quietly assume", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    transport.failing = new CloudSaveError("network", "offline");

    await sync.probe();

    expect(sync.state).toEqual({ phase: "failed", failure: "network", action: "probe" });
  });
});

describe("CloudSync — upload: observe then write (decision D8)", () => {
  it("first upload creates the cloud save — the 'enable cross-device' moment", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const snapshot = snapshotFixture({ nowTick: 20 });
    await local.save(snapshot);

    await sync.upload();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("saved");
    expect(remoteText(transport)).toBe(JSON.stringify(snapshot));
  });

  it("upload over an existing cloud save is the DELIBERATE replace — observe first, then write", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);

    await sync.upload();

    expect(remoteText(transport)).toBe(JSON.stringify(mine));
    expect(sync.last).toBe("saved");
  });

  it("upload over a CORRUPT cloud save lands — the repair path #29 deliberately kept open", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    transport.slots.set(KEY, { text: "{not json", revision: 1 });
    const snapshot = snapshotFixture({ nowTick: 20 });
    await local.save(snapshot);

    await sync.upload();

    expect(remoteText(transport)).toBe(JSON.stringify(snapshot));
    expect(sync.last).toBe("saved");
  });

  it("a save refused by another session's write surfaces as 'conflict' with the other side visible", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const theirs = snapshotFixture({ nowTick: 99 });
    await local.save(snapshotFixture({ nowTick: 20 }));
    // The world moves between our observe and our write — exactly the CAS race.
    transport.onceAfterRead = () => {
      transport.slots.set(KEY, { text: JSON.stringify(theirs), revision: 2 });
    };

    await sync.upload();

    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });
    expect(sync.remoteView).toEqual({ kind: "save", snapshot: theirs });
  });

  it("offline: upload fails 'network' and BOTH stores are untouched — 'not saved' never pretends 'saved' (decision D8)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    transport.failing = new CloudSaveError("network", "offline");

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "network", action: "upload" });
    expect(transport.slots.has(KEY)).toBe(false); // remote untouched
  });

  it("an UNREPAIRABLE corrupt record reports 'corrupt', not a phantom 'another device' conflict (decision D8)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const theirs = snapshotFixture({ nowTick: 99 });
    transport.slots.set(KEY, { text: JSON.stringify(theirs), revision: 1 });
    await local.save(snapshotFixture({ nowTick: 20 }));
    // The damage is in the revision ANCHOR: the store cannot arm it (#29), so
    // no write can CAS against this row — the upload must say THAT.
    transport.revisionDamage = 17;

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "corrupt", action: "upload" });
    expect(remoteText(transport)).toBe(JSON.stringify(theirs)); // nothing overwrote the damage
  });

  it("an unclassified rejection is 'network' — the host's defensive reading of the unknown", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    transport.failing = new TypeError("Failed to fetch"); // outside the contract's error shape

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "network", action: "upload" });
  });
});

describe("CloudSync — the upload payload is the LOCAL SLOT's current content (#31)", () => {
  it("AC1 fresh payload: the slot updates after the probe and upload pushes the NEW save, not the stale view", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.probe(); // the display view is now last-known "nowTick 20"
    const newer = snapshotFixture({ nowTick: 55 });
    await local.save(newer); // the player played on — the view is stale from here

    await sync.upload();

    expect(sync.last).toBe("saved");
    expect(remoteText(transport)).toBe(JSON.stringify(newer));
  });

  it("AC2 payload self-read: upload() takes no argument and never consults the view — the panel is not the payload source", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);
    expect(sync.localView.kind).toBe("unknown"); // no probe: the display view knows nothing

    await sync.upload();

    expect(remoteText(transport)).toBe(JSON.stringify(mine));
  });

  it("AC3 empty slot → 'local-empty' and ZERO backend calls — absence is not failure (the dual of 'remote-empty')", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();

    await sync.upload();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("local-empty");
    expect(transport.reads).toBe(0); // the payload check is at the very front — no backend at all
    expect(transport.writes).toBe(0);
  });

  it("AC3 damaged slot → failed 'local-corrupt' and ZERO backend calls — the damage is local, never a phantom conflict", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    localStorage.setItem(KEY, "{not json");

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-corrupt", action: "upload" });
    expect(transport.reads).toBe(0);
    expect(transport.writes).toBe(0);
  });

  it("AC4 view symmetry: a successful upload refreshes the local view — stale display data dies here", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.probe(); // the view is last-known "nowTick 20"
    const newer = snapshotFixture({ nowTick: 55 });
    await local.save(newer);

    await sync.upload();

    expect(sync.localView).toEqual({ kind: "save", snapshot: newer });
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

  it("a LOCAL write that refuses (quota) reports 'local' — never 'downloaded' over a failed write", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, cloud } = rig();
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    const refusingLocal: SaveStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error("quota exceeded")),
    };
    const sync = new CloudSync(cloud, refusingLocal, { markExpired: () => undefined });

    await sync.download();

    expect(sync.state).toEqual({ phase: "failed", failure: "local", action: "download" });
    expect(sync.last).not.toBe("downloaded"); // the verdict never claims a write that did not land
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

    await sync.upload();

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
    const { transport, local, sync, expired } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    // The session dies mid-flow: the observe succeeds, the write is refused.
    transport.failWrite = new CloudSaveError("auth", "session expired");

    await sync.upload();

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
    await expect(sync.upload()).rejects.toThrow(/sign in again/i);
    await expect(sync.download()).rejects.toThrow(/sign in again/i);
    await expect(sync.probe()).rejects.toThrow(/sign in again/i);

    expect(transport.reads).toBe(readsBefore); // zero further backend calls
    await expect(local.load()).resolves.toBeNull();
  });
});

describe("CloudSync — busy is a refusal, not a queue", () => {
  it("an overlapping action rejects while one is in flight", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));

    const first = sync.upload();
    await expect(sync.upload()).rejects.toThrow(/in flight/i);
    await first;
  });

  it("dismiss outside a conflict is a refusal — there is nothing to walk away from", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();

    expect(() => sync.dismiss()).toThrow(/nothing to dismiss/i);
    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("none");
  });
});

describe("CloudSync — state changes are observable (the panel follows, never polls)", () => {
  it("every transition notifies subscribers", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    const seen: string[] = [];
    const unsubscribe = sync.subscribe(() => seen.push(sync.state.phase));

    await sync.probe();
    await sync.upload();
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
