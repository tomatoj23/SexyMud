import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveStore, Snapshot } from "@sexymud/core";
import { CloudSaveError, CloudSaveStore } from "../src/game/cloudSaveStore.js";
import type { CloudSaveRecord, CloudSaveTransport } from "../src/game/cloudSaveStore.js";
import { LocalSaveStore, LocalSaveUnavailableError } from "../src/game/localSaveStore.js";
import { CloudSync, type ImportSource, type SlotView } from "../src/game/cloudSync.js";
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

    sync.dismiss();

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

    expect(sync.state.phase).toBe("idle"); // the first one landed normally
    expect(sync.last).toBe("saved");
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

describe("CloudSync — unreachable storage is its own word, on both paths (#32 D4)", () => {
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
    const unreachable: SaveStore = {
      load: () => Promise.reject(new LocalSaveUnavailableError("local save: storage is not accessible")),
      save: () => Promise.reject(new Error("unreachable")),
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
    const unreachable: SaveStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new LocalSaveUnavailableError("local save: storage is not accessible")),
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

  it("a verified file lands in the local slot on the CONFIRM — outcome 'imported', view refreshed, and the ORIGINAL bytes stored (the store never migrates)", async () => {
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
    await expect(sync.commitImport()).rejects.toThrow("no import staged");
  });

  it("JSON that is not a snapshot envelope is 'file-corrupt' too — the parse seam is parseSnapshotText (AC1)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();

    await sync.beginImport(pickedFile(JSON.stringify([1, 2, 3])));

    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
    await expect(sync.commitImport()).rejects.toThrow("no import staged");
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
    await expect(sync.commitImport()).rejects.toThrow("no import staged");
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
    const { sync } = rig();
    const oldButBroken = JSON.stringify({ version: 1, data: { entities: [] } });

    await sync.beginImport(pickedFile(oldButBroken));

    expect(sync.state).toEqual({ phase: "failed", failure: "file-corrupt", action: "import" });
  });

  it("a file that cannot be READ is 'file' — the source's own failure, not save damage (AC4)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { sync } = rig();
    const unreadable: ImportSource = { text: () => Promise.reject(new Error("file moved")) };

    await sync.beginImport(unreadable);

    expect(sync.state).toEqual({ phase: "failed", failure: "file", action: "import" });
    await expect(sync.commitImport()).rejects.toThrow("no import staged");
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
    const refusing: SaveStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error("quota exceeded")),
    };
    const sync = new CloudSync(cloud, refusing, { markExpired: () => undefined });
    await sync.beginImport(pickedFile(V1_TEXT));

    await sync.commitImport();

    expect(sync.state).toEqual({ phase: "failed", failure: "local", action: "import" });
    expect(sync.last).not.toBe("imported"); // the verdict never claims a write that did not land
    expect(sync.localView.kind).toBe("unknown"); // and the view is not half-refreshed either
  });

  it("a confirmed import into UNREACHABLE storage reports 'local-unavailable', never quota-worded 'local' (#32 D4 words ride on import too)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { cloud } = rig();
    const unreachable: SaveStore = {
      load: () => Promise.resolve(null),
      save: () =>
        Promise.reject(new LocalSaveUnavailableError("local save: storage is not accessible")),
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

    await expect(sync.beginImport(pickedFile(V1_TEXT))).rejects.toThrow("conflict");

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

    await expect(sync.commitImport()).rejects.toThrow("conflict");
    await expect(local.load()).resolves.toEqual(mine); // no half-write under the refusal

    sync.dismiss();
    await sync.commitImport();

    expect(sync.last).toBe("imported");
    expect(localStorage.getItem(KEY)).toBe(V1_TEXT);
  });
});
