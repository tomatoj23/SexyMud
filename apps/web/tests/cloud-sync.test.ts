import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@sexymud/core";
import { CloudSaveError, CloudSaveStore } from "../src/game/cloudSaveStore.js";
import type { CloudSaveRecord, CloudSaveTransport } from "../src/game/cloudSaveStore.js";
import { LocalSaveStore, LocalSaveUnavailableError } from "../src/game/localSaveStore.js";
import {
  CloudSync,
  CloudSyncError,
  type ImportSource,
  type LocalSlot,
  type SlotView,
  type SyncRefusal,
} from "../src/game/cloudSync.js";
import { anchorDamaged, memoryStorage, snapshotFixture } from "./support.js";

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
 *
 * #32 moves the observe-write-adjudicate dance into the store: `upload()`
 * makes ONE `replace` call and only translates its three-way verdict. The
 * tests therefore feed the store DIRECTLY CONSTRUCTED raw rows (a damaged
 * revision anchor, a damaged text — never a knob through the store's
 * back), and the local side's storage trouble reads "unavailable", not
 * "corrupt" and not "quota".
 *
 * #33 closes the export channel's dual: `beginImport` reads a picked file
 * and proves `restoreWorld` can load it BEFORE any confirm is offered,
 * `commitImport` spends that verified payload on the local slot. The tests
 * pin each refusal as its own word (`file` / `file-corrupt` /
 * `file-version` / the write-side `local` family), the envelope-clean
 * PAYLOAD-damaged file the gate must still refuse (the #33 review's H3),
 * and the store-gets-the-original-bytes law (a v1 file stays v1 in the
 * slot — the store never migrates).
 */

/** A RAM transport keeping the contract's law: `write` is an atomic CAS. */
class FakeTransport implements CloudSaveTransport {
  /**
   * Raw rows exactly as `read` hands them out — a damaged one is seeded
   * AS-IS (bad `revision` or bad `text`), the store's own verdicts being the
   * seam here (#32 D6).
   */
  readonly slots = new Map<string, CloudSaveRecord>();
  /** When set, both operations reject with this error — the offline / auth-expiry paths. */
  failing: Error | null = null;
  /** When set, only `write` rejects — the session dying mid-flow. */
  failWrite: Error | null = null;
  /** Fires once right after a read — "another device wrote just now". */
  onceAfterRead: (() => void) | null = null;
  /** Call accounting — "no retries, no store pokes" must be provable. */
  reads = 0;
  writes = 0;
  private minted = 0;

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
      throw new CloudSaveError("conflict", `transport: revision is ${String(current)}, expected ${String(expectedRevision)}`);
    }
    const revision = `rev-${++this.minted}`;
    this.slots.set(key, { text, revision });
    return revision;
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
  transport.slots.set(KEY, { text: JSON.stringify(snapshot), revision: "seed" });
}

/** A `Storage` that throws on access — storage disabled / privacy mode. */
function disabledStorage(): Storage {
  return {
    get length(): number {
      throw new DOMException("denied", "SecurityError");
    },
    clear: () => {
      throw new DOMException("denied", "SecurityError");
    },
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    key: () => {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
}

/**
 * The ONE refusal channel (#45 D3): a refused action rejects — `dismiss`'s
 * synchronous throw is gone — and names its reason as `kind` (the message is
 * the machine's copy; the panel renders it and pins what the player reads).
 */
async function expectRefusal(promise: Promise<unknown>, kind: SyncRefusal): Promise<void> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(CloudSyncError);
  expect((error as CloudSyncError).kind).toBe(kind);
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
    transport.slots.set(KEY, { text: "{not json", revision: "1" });

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

  it("the probe owns the verdict — 'in-sync' never outlives the divergence a later probe finds", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const snapshot = snapshotFixture({ nowTick: 20 });
    await local.save(snapshot);
    seedRemote(transport, snapshot);
    await sync.probe();
    expect(sync.last).toBe("in-sync");

    await local.save(snapshotFixture({ nowTick: 55 })); // the player played on
    await sync.probe();

    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" });
    expect(sync.last).toBe("none"); // no stale "in-sync" beside a divergence
  });

  it("the probe owns the verdict — 'saved' never outlives a cloud save that vanished", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.upload();
    expect(sync.last).toBe("saved");

    transport.slots.delete(KEY); // the cloud save is gone (console, another client)
    await sync.probe();

    expect(sync.last).toBe("none"); // the status line must not claim "已存到云端" beside "无存档"
    expect(sync.remoteView).toEqual({ kind: "empty" });
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
    transport.slots.set(KEY, { text: "{not json", revision: "1" });
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
      transport.slots.set(KEY, { text: JSON.stringify(theirs), revision: "theirs" });
    };

    await sync.upload();

    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });
    expect(sync.remoteView).toEqual({ kind: "save", snapshot: theirs });
  });

  it("offline: upload fails 'network' and BOTH stores are untouched — 'not saved' never pretends 'saved' (decision D8)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);
    transport.failing = new CloudSaveError("network", "offline");

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "network", action: "upload" });
    expect(transport.slots.has(KEY)).toBe(false); // remote untouched
    await expect(local.load()).resolves.toEqual(mine); // local untouched too
    expect(sync.localView).toEqual({ kind: "save", snapshot: mine }); // but the read DID refresh the view
  });

  it("an UNREPAIRABLE corrupt record reports 'corrupt', not a phantom 'another device' conflict (decision D8)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const theirs = snapshotFixture({ nowTick: 99 });
    // The damage is in the revision ANCHOR (bad revision row, seeded raw):
    // nothing can CAS against it, so no write can land — the upload must say
    // THAT, not "another device updated the cloud save".
    transport.slots.set(KEY, anchorDamaged(JSON.stringify(theirs)));
    await local.save(snapshotFixture({ nowTick: 20 }));

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "corrupt", action: "upload" });
    expect(remoteText(transport)).toBe(JSON.stringify(theirs)); // nothing overwrote the damage
    expect(sync.remoteView).toEqual({ kind: "corrupt" }); // the damage, visible in the view
  });

  it("anchor damage PLUS a real race is the RACE — a healthy save appearing mid-flow wins the 'conflict' verdict, not 'corrupt'", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    const theirs = snapshotFixture({ nowTick: 99 });
    transport.slots.set(KEY, anchorDamaged(JSON.stringify(theirs)));
    await local.save(snapshotFixture({ nowTick: 20 }));
    // Our observe sees the damaged anchor; between observe and write another
    // session REPLACES the row with a healthy one — the verdict is the race.
    transport.onceAfterRead = () => {
      transport.slots.set(KEY, { text: JSON.stringify(theirs), revision: "theirs" });
    };

    await sync.upload();

    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });
    expect(sync.remoteView).toEqual({ kind: "save", snapshot: theirs });
  });

  it("a race that writes a NEW damaged row is the RACE — 'conflict' with the damage visible in the view (decision D3 edge)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    transport.slots.set(KEY, anchorDamaged(JSON.stringify(snapshotFixture({ nowTick: 99 }))));
    await local.save(snapshotFixture({ nowTick: 20 }));
    // The racing session's NEW row is broken too — but the damage is theirs,
    // and "somebody wrote" is the truth first: never 'corrupt' pretending
    // nothing happened.
    transport.onceAfterRead = () => {
      transport.slots.set(KEY, anchorDamaged("{their broken row"));
    };

    await sync.upload();

    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });
    expect(sync.remoteView).toEqual({ kind: "corrupt" }); // the damage shows AFTER the race
  });

  it("a race that DELETES the row is the race too — deleting is somebody writing (decision D3 edge)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await local.save(snapshotFixture({ nowTick: 20 }));
    transport.onceAfterRead = () => {
      transport.slots.delete(KEY);
    };

    await sync.upload();

    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });
    expect(sync.remoteView).toEqual({ kind: "empty" }); // the vanished slot, visible in the view
    expect(transport.slots.has(KEY)).toBe(false); // the delete stands — nothing re-created it
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
    expect(sync.localView).toEqual({ kind: "empty" }); // the read is the refresh
    expect(transport.reads).toBe(0); // the payload check is at the very front — no backend at all
    expect(transport.writes).toBe(0);
  });

  it("AC3 damaged slot → failed 'local-corrupt' and ZERO backend calls — the damage is local, never a phantom conflict", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    localStorage.setItem(KEY, "{not json");

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-corrupt", action: "upload" });
    expect(sync.localView).toEqual({ kind: "corrupt" }); // the read is the refresh
    expect(transport.reads).toBe(0);
    expect(transport.writes).toBe(0);
  });

  it("regression net: a STALE save view never becomes the payload — an emptied slot still reports 'local-empty'", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.probe(); // the view now CLAIMS a save
    localStorage.removeItem(KEY); // the slot is emptied behind the machine
    const readsBefore = transport.reads;

    await sync.upload();

    expect(sync.last).toBe("local-empty"); // never the stale view's bytes, never "saved"
    expect(transport.reads).toBe(readsBefore); // the upload itself never reached the backend
  });

  it("regression net: a STALE save view never becomes the payload — a damaged slot still reports 'local-corrupt'", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.probe(); // the view now CLAIMS a save
    localStorage.setItem(KEY, "{not json"); // the slot is damaged behind the machine
    const readsBefore = transport.reads;

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-corrupt", action: "upload" });
    expect(transport.reads).toBe(readsBefore); // the upload itself never reached the backend
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
    expect(sync.localView).toEqual({ kind: "save", snapshot }); // the success path refreshes the local view
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
    transport.slots.set(KEY, { text: "{not json", revision: "1" });
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
    const refusingLocal: LocalSlot = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error("quota exceeded")),
      readRaw: () => Promise.resolve({ kind: "empty" }),
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

    await sync.dismiss();

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

  it("the CAS-race conflict (cause 'save') offers the same three exits — dismiss walks away from it too", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    const theirs = snapshotFixture({ nowTick: 99 });
    // The world moves between our observe and our write — the CAS race.
    transport.onceAfterRead = () => {
      transport.slots.set(KEY, { text: JSON.stringify(theirs), revision: "theirs" });
    };
    await sync.upload();
    expect(sync.state).toEqual({ phase: "conflict", cause: "save" });

    await sync.dismiss();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("dismissed");
    expect(remoteText(transport)).toBe(JSON.stringify(theirs)); // the cloud is untouched
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
    await expectRefusal(sync.upload(), "auth-expired");
    await expectRefusal(sync.download(), "auth-expired");
    await expectRefusal(sync.probe(), "auth-expired");
    await expectRefusal(sync.exportLocal(), "auth-expired");

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
    await expectRefusal(sync.upload(), "busy");
    await first;

    expect(sync.state.phase).toBe("idle"); // the first one landed normally
    expect(sync.last).toBe("saved");
  });

  it("dismiss outside a conflict is a refusal — there is nothing to walk away from", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();

    // The refusal rides the SAME channel as every other one (#45 D3): the old
    // synchronous throw is gone, `dismiss` rejects like `run`'s guards do.
    await expectRefusal(sync.dismiss(), "nothing-to-dismiss");
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

describe("CloudSync — unreachable storage is its own word, on both paths (#32 D4)", () => {
  it("the probe shows 'unavailable', not 'corrupt' — a disabled store is not a damaged save", async () => {
    vi.stubGlobal("localStorage", disabledStorage());
    const { sync } = rig();

    await sync.probe();

    expect(sync.state.phase).toBe("idle"); // the probe shows it; it does not fail on it
    expect(sync.localView).toEqual({ kind: "unavailable" });
  });

  it("upload's front half reports 'local-unavailable' with ZERO backend calls — no bytes, no payload (#31 D2 dual)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, cloud } = rig();
    const unreachable: LocalSlot = {
      load: () => Promise.reject(new LocalSaveUnavailableError("local save: storage is not accessible")),
      save: () => Promise.reject(new Error("unreachable")),
      readRaw: () => Promise.resolve({ kind: "unavailable" }),
    };
    const sync = new CloudSync(cloud, unreachable, { markExpired: () => undefined });

    await sync.upload();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "upload" });
    expect(transport.reads).toBe(0); // never reaches the backend at all
    expect(transport.writes).toBe(0);
  });

  it("a non-parse load rejection (「load 抛非解析错误」) from the REAL LocalSaveStore reads 'unavailable', never 'local-corrupt'", async () => {
    vi.stubGlobal("localStorage", disabledStorage());
    const { transport, sync } = rig();

    await sync.upload(); // LocalSaveStore.load() rejects with LocalSaveUnavailableError

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "upload" });
    expect(transport.reads).toBe(0);
    expect(transport.writes).toBe(0);
  });

  it("a download whose local write cannot reach the storage reports 'local-unavailable', not quota-worded 'local'", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, cloud } = rig();
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    const unreachable: LocalSlot = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new LocalSaveUnavailableError("local save: storage is not accessible")),
      readRaw: () => Promise.resolve({ kind: "empty" }),
    };
    const sync = new CloudSync(cloud, unreachable, { markExpired: () => undefined });

    await sync.download();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "download" });
    expect(sync.last).not.toBe("downloaded");
  });
});

describe("CloudSync — the store's knowledge stays in the store (#32 AC1)", () => {
  it("cloudSync.ts never re-enacts the arming rules — no arming/anchor vocabulary lives up here", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/game/cloudSync.ts"),
      "utf8",
    );
    // The observe-write-adjudicate dance is the store's business (#32 D1):
    // a caller that could re-derive the arming rules is a caller that WILL,
    // and then the two derivations drift. This scan makes the drift
    // unwritable — the vocabulary simply cannot appear here. The ban is the
    // ARMING family only (revision / 武装 / arm·disarm·rearm / anchor);
    // "CAS" stays legal as the name of the concurrency mechanism.
    expect(source).not.toMatch(/revision/i);
    expect(source).not.toMatch(/武装/);
    expect(source).not.toMatch(/\b(?:re|dis)?arm(?:s|ed|ing)?\b/i);
    expect(source).not.toMatch(/\banchor\b/i);
  });
});

describe("CloudSync — import: the export channel's dual (#33)", () => {
  /** The picked file as the machine sees it — the panel hands the File; its text is all that matters. */
  function pickedFile(text: string): ImportSource {
    return { text: () => Promise.resolve(text) };
  }

  /** A v1 save an old build wrote — the chain walks it, but the slot must keep these exact bytes. */
  const V1_TEXT = JSON.stringify({
    version: 1,
    data: { entities: { jia: { id: "jia", locationId: "room-a", flags: ["seen"] } } },
  });

  it("a verified file lands in the local slot on the CONFIRM — outcome 'imported', view refreshed, and the UN-MIGRATED parse result stored (the store never migrates)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();

    await sync.beginImport(pickedFile(V1_TEXT));

    // AC1/AC3: the front half writes NOTHING — no half-import before the confirm.
    expect(sync.state).toEqual({ phase: "idle" });
    await expect(local.load()).resolves.toBeNull();
    expect(sync.last).toBe("none");

    await sync.commitImport();

    // AC3: the success path refreshes the local view with the imported save.
    expect(sync.last).toBe("imported");
    expect(sync.localView).toEqual({ kind: "save", snapshot: JSON.parse(V1_TEXT) });
    // Stored UNMIGRATED — v1 bytes, none of the v2 scalars added in transit.
    expect(localStorage.getItem(KEY)).toBe(V1_TEXT);
    // A second commit finds no escrow — the confirm is answered once.
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("the classifier words the DAMAGE, never the version stamp's accident — `data: null` is 'file-corrupt' on v1 AND v2", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    // Regression: the v1 migration step CRASHES on `data: null` (its
    // `data.nowTick` access), and a probe fed the real payload once worded
    // that one damage `file-version` on v1 while v2 said `file-corrupt` for
    // it. The chain is asked without the payload, so both stamps agree.
    await sync.beginImport(pickedFile(JSON.stringify({ version: 1, data: null })));
    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });

    await sync.beginImport(pickedFile(JSON.stringify({ version: 2, data: null })));
    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    await expect(local.load()).resolves.toBeNull(); // nothing half-written
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("a failed re-pick SPENDS the escrow — the staged payload and the last picked file can never differ", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    await sync.beginImport(pickedFile(V1_TEXT)); // staged and verified
    await sync.beginImport(pickedFile("{not json")); // the player changed their mind, and that file is bad
    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });

    // The earlier file must not land under a later confirm.
    await expectRefusal(sync.commitImport(), "no-staged-import");
    await expect(local.load()).resolves.toBeNull();
  });

  it("the import payload is never a view: views move between stage and commit, the imported bytes still land", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, sync } = rig();
    await sync.beginImport(pickedFile(V1_TEXT));

    // A probe refreshes both views mid-flow — a display cache is not a payload (#31).
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    await sync.commitImport();

    expect(sync.last).toBe("imported");
    expect(localStorage.getItem(KEY)).toBe(V1_TEXT);
  });

  it("a file that is not JSON is refused 'file-corrupt' — loud, nothing staged, nothing written (AC1)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();

    await sync.beginImport(pickedFile("{not json"));

    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    await expect(local.load()).resolves.toBeNull();
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("JSON that is not a snapshot envelope is 'file-corrupt' too — the parse seam is parseSnapshotText (AC1)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();

    await sync.beginImport(pickedFile(JSON.stringify([1, 2, 3])));

    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    await expect(local.load()).resolves.toBeNull(); // nothing half-written
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("an envelope-clean file with a DAMAGED PAYLOAD is still refused 'file-corrupt' — restoreWorld is the gate, not just the parse (H3 regression)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();
    // The #33 review's H3 case: `{version, data}` present and parseable,
    // but `data.entities` is not an object — a migrate-only check would
    // welcome it and the real load would explode later.
    const envelopeClean = JSON.stringify({ version: 2, data: { entities: [] } });

    await sync.beginImport(pickedFile(envelopeClean));

    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("a save the migration chain cannot walk is 'file-version' — its own word, never blurred into 'file-corrupt' (AC4)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();

    await sync.beginImport(pickedFile(JSON.stringify({ version: 99, data: { entities: {} } })));
    expect(sync.state).toEqual({ phase: "failed", failure: "file-version", action: "import" });

    // A version that is a number but not a step the chain can stand on.
    await sync.beginImport(pickedFile(JSON.stringify({ version: 1.5, data: { entities: {} } })));
    expect(sync.state).toEqual({ phase: "failed", failure: "file-version", action: "import" });
  });

  it("the two file words never blur: an OLD save with a damaged payload is 'file-corrupt' — the chain walks, the payload does not", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    const oldButBroken = JSON.stringify({ version: 1, data: { entities: [] } });

    await sync.beginImport(pickedFile(oldButBroken));

    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    await expect(local.load()).resolves.toBeNull(); // nothing half-written
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("a file that cannot be READ is 'file' — the source's own failure, not save damage (AC4)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();
    const unreadable: ImportSource = { text: () => Promise.reject(new Error("file moved")) };

    await sync.beginImport(unreadable);

    expect(sync.state).toEqual({ phase: "failed", failure: "file", action: "import" });
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("a failure covers the old verdict (decision D8): 'imported' is still the LAST verdict but the phase speaks first", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();
    await sync.beginImport(pickedFile(V1_TEXT));
    await sync.commitImport();
    expect(sync.last).toBe("imported");

    await sync.beginImport(pickedFile("{not json"));

    // The machine keeps the verdict; the panel's status line reads the
    // FAILED phase over it — the old verdict never papers over a failure.
    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    expect(sync.last).toBe("imported");
  });

  it("a confirmed import whose local write refuses (quota) reports 'local' — never 'imported' over a failed write (AC4)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { cloud } = rig();
    const refusing: LocalSlot = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error("quota exceeded")),
      readRaw: () => Promise.resolve({ kind: "empty" }),
    };
    const sync = new CloudSync(cloud, refusing, { markExpired: () => undefined });
    await sync.beginImport(pickedFile(V1_TEXT));

    await sync.commitImport();

    expect(sync.state).toEqual({ phase: "failed", failure: "local", action: "import" });
    expect(sync.last).not.toBe("imported"); // the verdict never claims a write that did not land
    expect(sync.localView.kind).toBe("unknown"); // and the view is not half-refreshed either
    // The confirm was ANSWERED — the attempt spends the escrow even though
    // the write did not land; re-importing is the retry.
    await expectRefusal(sync.commitImport(), "no-staged-import");
  });

  it("commitImport takes NO payload — a smuggled snapshot cannot even be expressed (type pin, the #31 law mirrored)", () => {
    // Never called — this exists to be COMPILED: widen the signature to
    // accept a payload and the call below becomes legal, the
    // `@ts-expect-error` goes unused, and typecheck fails.
    const compileOnly = (machine: CloudSync, smuggled: Snapshot): void => {
      // @ts-expect-error commitImport takes no argument — no view can be the payload
      void machine.commitImport(smuggled);
    };
    void compileOnly;
  });

  it("a confirmed import into UNREACHABLE storage reports 'local-unavailable', never quota-worded 'local' (#32 D4 words ride on import too)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { cloud } = rig();
    const unreachable: LocalSlot = {
      load: () => Promise.resolve(null),
      save: () =>
        Promise.reject(new LocalSaveUnavailableError("local save: storage is not accessible")),
      readRaw: () => Promise.resolve({ kind: "empty" }),
    };
    const sync = new CloudSync(cloud, unreachable, { markExpired: () => undefined });
    await sync.beginImport(pickedFile(V1_TEXT));

    await sync.commitImport();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "import" });
  });

  it("import may not move the stakes mid-adjudication — beginImport refuses while a conflict stands (#33 D3)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" });

    await expectRefusal(sync.beginImport(pickedFile(V1_TEXT)), "adjudicating");

    // The refusal changes nothing — the adjudication stands untouched.
    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" });
  });

  it("a staged import cannot land mid-adjudication — commitImport refuses, the escrow SURVIVES, and lands only after the conflict is resolved", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await sync.beginImport(pickedFile(V1_TEXT)); // staged and answered before the trouble
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    expect(sync.state.phase).toBe("conflict");

    await expectRefusal(sync.commitImport(), "adjudicating");
    await expect(local.load()).resolves.toEqual(mine); // no half-write under the refusal

    await sync.dismiss();
    await sync.commitImport();

    expect(sync.last).toBe("imported");
    expect(localStorage.getItem(KEY)).toBe(V1_TEXT);
  });
});

describe("CloudSync — export: the escape hatch ships the SLOT's own bytes (#34)", () => {
  /** The download DOM the machine's file side drives — a fake anchor is all it needs. */
  function stubDownloadDom(): void {
    vi.stubGlobal("document", {
      createElement: () => ({ href: "", download: "", click: () => undefined }),
    });
  }

  /** Stubs the file-out surface and records every file that actually went out. */
  function captureFiles(): { files: Blob[] } {
    const files: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      files.push(blob as Blob);
      return "blob:fake";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    stubDownloadDom();
    return { files };
  }

  /** The file side refusing to produce the download — the `file` failure's source. */
  function refuseFiles(): void {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("download blocked");
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    stubDownloadDom();
  }

  /** The exported file contents, in order — the bytes that actually went out. */
  async function fileTexts(files: Blob[]): Promise<string[]> {
    return Promise.all(files.map((file) => file.text()));
  }

  it("AC1 stale-view regression: the file is the slot's CURRENT bytes — a slot written behind the machine exports the NEW save", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.probe(); // the display view is now last-known "nowTick 20"
    const newer = snapshotFixture({ nowTick: 55 });
    await local.save(newer); // another tab wrote the slot — the view is stale from here

    await sync.exportLocal();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("exported");
    expect(await fileTexts(files)).toEqual([JSON.stringify(newer)]);
    expect(sync.localView).toEqual({ kind: "save", snapshot: newer }); // the read is the refresh
  });

  it("AC1 byte fidelity: the file is the stored TEXT — formatting and all, never a re-serialization", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { sync } = rig();
    const pretty = JSON.stringify(snapshotFixture({ nowTick: 20 }), null, 2);
    localStorage.setItem(KEY, pretty); // a hand-formatted save, exactly as a repair would leave it

    await sync.exportLocal();

    expect(await fileTexts(files)).toEqual([pretty]); // a JSON round-trip would compact it away
    expect(sync.last).toBe("exported");
  });

  it("AC2 salvage: a CORRUPT slot still exports its raw bytes — the damage is the player's to repair (decision D2)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { sync } = rig();
    localStorage.setItem(KEY, "{not json"); // damaged — and these bytes are all the player has

    await sync.exportLocal();

    expect(sync.state.phase).toBe("idle"); // salvage SUCCEEDS — it is not a failure
    expect(sync.last).toBe("exported");
    expect(await fileTexts(files)).toEqual(["{not json"]);
    expect(sync.localView).toEqual({ kind: "corrupt" }); // the view still says the damage
  });

  it("AC2/AC3 unreachable storage fails 'local-unavailable' and NO file goes out", async () => {
    vi.stubGlobal("localStorage", disabledStorage());
    const { files } = captureFiles();
    const { sync } = rig();

    await sync.exportLocal();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "export" });
    expect(files).toHaveLength(0); // no bytes, no file
    expect(sync.localView).toEqual({ kind: "unavailable" }); // the read is the refresh
    expect(sync.last).toBe("none");
  });

  it("AC2 an empty slot is 'local-empty', not a failure — and no file goes out", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { sync } = rig();

    await sync.exportLocal();

    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("local-empty");
    expect(files).toHaveLength(0);
    expect(sync.localView).toEqual({ kind: "empty" });
  });

  it("AC3 a Blob/URL failure is 'file' — its own word, nothing pretends the file went out", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    refuseFiles();
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));

    await sync.exportLocal();

    expect(sync.state).toEqual({ phase: "failed", failure: "file", action: "export" });
    expect(sync.last).toBe("none"); // a refusal claims no verdict of its own
    expect(sync.localView.kind).toBe("save"); // the read refreshed the view before the file side refused
  });

  it("AC3 the failure covers the old verdict (decision D8): 'exported' survives as the verdict but the phase speaks first", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.exportLocal();
    expect(sync.last).toBe("exported");

    refuseFiles();
    await sync.exportLocal();

    expect(sync.state).toEqual({ phase: "failed", failure: "file", action: "export" });
    expect(sync.last).toBe("exported"); // the machine keeps the verdict; the FAILED phase is the loud half
    expect(files).toHaveLength(1); // exactly one file ever went out
  });

  it("exportLocal() takes no argument — the payload self-read, the #31 law mirrored (type pin)", () => {
    // Never called — this exists to be COMPILED: widen the signature to
    // accept a payload and the call below becomes legal, the
    // `@ts-expect-error` goes unused, and typecheck fails.
    const compileOnly = (machine: CloudSync, smuggled: string): void => {
      // @ts-expect-error exportLocal takes no argument — no view can be the payload
      void machine.exportLocal(smuggled);
    };
    void compileOnly;
  });

  it("D7 the escape hatch is live mid-adjudication: the file ships and the adjudication STANDS — exporting is not an exit", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { transport, local, sync } = rig();
    const mine = snapshotFixture({ nowTick: 20 });
    await local.save(mine);
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    expect(sync.state.phase).toBe("conflict");

    await sync.exportLocal();

    expect(await fileTexts(files)).toEqual([JSON.stringify(mine)]);
    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" }); // nothing chose an exit
    expect(sync.last).toBe("exported");
  });

  it("a loud export failure mid-adjudication chooses no exit either — the untouched comparison comes back on a probe", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    refuseFiles();
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    expect(sync.state.phase).toBe("conflict");

    await sync.exportLocal();

    // The failure is loud (the phase speaks first, D8) — and it moved NOTHING:
    // a probe sees the very same comparison again.
    expect(sync.state).toEqual({ phase: "failed", failure: "file", action: "export" });
    await sync.probe();
    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" });
  });

  it("an emptied slot under a standing comparison reports 'local-empty' and moves NO phase — absence is not failure, so it cannot cover the adjudication (D5)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { files } = captureFiles();
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    expect(sync.state.phase).toBe("conflict");
    localStorage.removeItem(KEY); // the local slot vanished behind the machine

    await sync.exportLocal();

    expect(sync.state).toEqual({ phase: "conflict", cause: "compare" }); // "a failure covers the old verdict" is the ONLY override (AC3)
    expect(sync.last).toBe("local-empty"); // the absence verdict is still recorded…
    expect(sync.localView).toEqual({ kind: "empty" }); // …and the row shows why no file went out
    expect(files).toHaveLength(0);
  });

  it("a raw face that THROWS is still 'unavailable' — a read that failed did not find nothing", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    captureFiles();
    const { cloud } = rig();
    const broken: LocalSlot = {
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      readRaw: () => Promise.reject(new Error("raw face exploded")),
    };
    const sync = new CloudSync(cloud, broken, { markExpired: () => undefined });

    await sync.exportLocal();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "export" });
  });

  it("the verdict pair moves atomically (#34 复查回归钉): a pick attempt never re-attributes an earlier verdict", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    captureFiles();
    const { sync } = rig();

    await sync.exportLocal(); // empty slot — the absence verdict through the EXPORT door
    expect(sync.last).toBe("local-empty");
    expect(sync.lastFrom).toBe("export");

    // beginImport succeeds but claims no verdict of its own — the earlier
    // absence verdict must keep its door (a "last button pressed" counter
    // would have re-worded it 可上传 here, calling the export door's verdict
    // the upload door's).
    await sync.beginImport({ text: () => Promise.resolve(JSON.stringify(snapshotFixture())) });
    expect(sync.state.phase).toBe("idle");
    expect(sync.last).toBe("local-empty");
    expect(sync.lastFrom).toBe("export");

    await sync.commitImport(); // a real verdict — the pair moves together
    expect(sync.last).toBe("imported");
    expect(sync.lastFrom).toBe("import");
  });

  it("every verdict keeps its own door (#34 复查回归钉): no door's word borrows another's attribution", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    captureFiles();
    const { transport, local, sync } = rig();

    await sync.upload(); // empty local — the UPLOAD door's absence
    expect([sync.last, sync.lastFrom]).toEqual(["local-empty", "upload"]);

    await sync.download(); // empty cloud — the DOWNLOAD door's absence
    expect([sync.last, sync.lastFrom]).toEqual(["remote-empty", "download"]);

    const same = snapshotFixture({ nowTick: 20 });
    await local.save(same);
    seedRemote(transport, same);
    await sync.probe();
    expect([sync.last, sync.lastFrom]).toEqual(["in-sync", "probe"]);

    await local.save(snapshotFixture({ nowTick: 55 }));
    await sync.probe(); // diverges — the probe's own "no verdict" answer
    expect(sync.state.phase).toBe("conflict");
    expect([sync.last, sync.lastFrom]).toEqual(["none", "probe"]);

    await sync.dismiss();
    expect([sync.last, sync.lastFrom]).toEqual(["dismissed", "dismiss"]);

    await sync.upload(); // keep-local lands a real save verdict
    expect([sync.last, sync.lastFrom]).toEqual(["saved", "upload"]);

    await sync.download(); // and the mirror exit lands its own
    expect([sync.last, sync.lastFrom]).toEqual(["downloaded", "download"]);
  });

  it("a standing FAILED phase is cleared by a later verdict — a fresh outcome replaces an old failure (upload/probe 同律)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    refuseFiles();
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.exportLocal();
    expect(sync.state.phase).toBe("failed");

    captureFiles(); // the file side recovers
    await sync.exportLocal();

    expect(sync.state.phase).toBe("idle"); // the old failure does not stick around
    expect(sync.last).toBe("exported");
    expect(sync.lastFrom).toBe("export");
  });

  it("unreachable storage mid-adjudication lands 'failed' — the one sanctioned override — and moves NOTHING", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    captureFiles();
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));
    await sync.probe();
    expect(sync.state.phase).toBe("conflict");
    vi.stubGlobal("localStorage", disabledStorage()); // the storage dies under the machine

    await sync.exportLocal();

    expect(sync.state).toEqual({ phase: "failed", failure: "local-unavailable", action: "export" });
    expect(transport.writes).toBe(0); // no bytes, no file — and nothing chose an exit
  });

  it("busy is a refusal, not a queue — an export cannot run beside an action in flight", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    captureFiles();
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));

    const first = sync.upload();
    await expectRefusal(sync.exportLocal(), "busy");
    await first;

    expect(sync.last).toBe("saved");
  });
});

describe("CloudSync — the judgment faces a thin panel renders from (#45 D1)", () => {
  it("D7 the destructive face is the whole destroy list, and each entry names the slot it OVERWRITES", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));

    // The judgment — WHICH actions are destructive — is the machine's: the
    // map's keys are exactly the destructive exits (probe / dismiss / export
    // are absent by judgment, not by omission) and each says what it kills.
    expect(Object.keys(sync.destructive).sort()).toEqual(["download", "import", "upload"]);
    expect(sync.destructive.upload.overwrites).toBe("remote");
    expect(sync.destructive.download.overwrites).toBe("local");
    expect(sync.destructive.import.overwrites).toBe("local");
  });

  it("D7 the cost ELEMENT is the overwritten slot as last known — a claim, so a cost line words it conditionally", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    seedRemote(transport, snapshotFixture({ nowTick: 99 }));

    expect(sync.destructive.upload.target).toEqual({ kind: "unknown" });
    await sync.probe();
    expect(sync.state.phase).toBe("conflict"); // both slots known, and they differ

    expect(sync.destructive.upload.target).toEqual(sync.remoteView);
    expect(sync.destructive.download.target).toEqual(sync.localView);
    expect(sync.destructive.import.target).toEqual(sync.localView);
    expect(sync.destructive.upload.target.kind).toBe("save");
  });

  it("D8 the status view resolves the precedence — a standing FAILURE covers the old verdict (the loud-failure law)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { transport, local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));
    await sync.upload();
    expect(sync.statusView).toEqual({ kind: "verdict", outcome: "saved", from: "upload" });

    transport.failing = new Error("backend down");
    await sync.probe();

    // The phase speaks first — and the verdict pair survives underneath, for
    // the day it may speak again (a fresh verdict replaces, never the reverse).
    expect(sync.statusView).toEqual({ kind: "failed", action: "probe", failure: "network" });
    expect(sync.last).toBe("saved");
    expect(sync.lastFrom).toBe("upload");
  });

  it("D8 busy speaks before anything else — the phase, not the verdict, is what the line reads", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { local, sync } = rig();
    await local.save(snapshotFixture({ nowTick: 20 }));

    const first = sync.upload();
    expect(sync.statusView).toEqual({ kind: "busy", action: "upload" });
    await first;

    expect(sync.statusView).toEqual({ kind: "verdict", outcome: "saved", from: "upload" });
  });
});
