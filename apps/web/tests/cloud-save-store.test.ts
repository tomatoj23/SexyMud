import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreWorld } from "@sexymud/core";
import type { EntityState, Snapshot } from "@sexymud/core";
import { CloudSaveError, CloudSaveStore } from "../src/game/cloudSaveStore.js";
import type {
  CloudSaveFailureKind,
  CloudSaveRecord,
  CloudSaveTransport,
} from "../src/game/cloudSaveStore.js";
import { LocalSaveStore } from "../src/game/localSaveStore.js";
import { memoryStorage, snapshotFixture } from "./support.js";

/**
 * The cloud-backed `SaveStore` — the first REMOTE implementation of the port
 * (spec/04 §1.6, ADR-0036, #29). Same interface as `LocalSaveStore`, injected
 * by the host the same way; `packages/core` sees nothing new.
 *
 * The seam under test is the STORE's public contract (`SaveStore.load/save`)
 * played against a contract-faithful fake transport. What the tests pin is
 * therefore the store's semantics, not any backend's:
 *
 *   - the snapshot format is the LOCAL one — the stored record is exactly
 *     `JSON.stringify(serializeWorld(...))`, so a local save and a cloud save
 *     interchange and the export path is unchanged (ADR-0002 §11/§21);
 *   - writes are compare-and-swap against the revision this instance last
 *     OBSERVED (decision D2) — never last-write-wins, never a blind overwrite;
 *   - failures are loud and classified (decision D5) — offline and auth
 *     expiry reject, they never return `null` or a stale snapshot;
 *   - version migration is NOT this class's business (decision D3): the
 *     record round-trips verbatim and `restoreWorld` runs the one
 *     `migrateSnapshot` chain.
 *
 * The real backend adapter (CloudBase) is a transport implementation and
 * lands with the Auth ticket; its obligations (atomic CAS, opaque revision,
 * error classification) are the `CloudSaveTransport` contract itself.
 */

/** A RAM transport that keeps the contract's law: `write` is an atomic CAS. */
class FakeTransport implements CloudSaveTransport {
  readonly slots = new Map<string, { text: string; revision: number }>();
  /** When set, both operations reject with this failure kind — the offline / auth-expiry paths. */
  failing: CloudSaveFailureKind | null = null;

  private maybeFail(): void {
    if (this.failing) throw new CloudSaveError(this.failing, `transport: ${this.failing}`);
  }

  async read(key: string): Promise<CloudSaveRecord | null> {
    this.maybeFail();
    const slot = this.slots.get(key);
    return slot ? { text: slot.text, revision: String(slot.revision) } : null;
  }

  async write(key: string, text: string, expectedRevision: string | null): Promise<string> {
    this.maybeFail();
    const slot = this.slots.get(key);
    const current = slot ? String(slot.revision) : null;
    if (current !== expectedRevision) {
      throw new CloudSaveError(
        "conflict",
        `transport: revision is ${current}, expected ${expectedRevision}`,
      );
    }
    const revision = (slot?.revision ?? 0) + 1;
    this.slots.set(key, { text, revision });
    return String(revision);
  }
}

/** `serializeWorld` output at a chosen tick — the exact same format the local store saves. */
const fixture = (nowTick = 20): Snapshot => snapshotFixture({ nowTick });

/** Seed the slot with a raw record — the state some earlier session left behind. */
function seed(transport: FakeTransport, text: string): void {
  transport.slots.set("save-slot-1", { text, revision: 1 });
}

/**
 * Asserts a call failed the way the contract says it must: a `CloudSaveError`
 * carrying the expected KIND — the host reacts differently to each kind, so a
 * bare "it threw" (or a kind-only match) would survive a taxonomy collapse
 * into plain objects.
 */
async function expectFailure(promise: Promise<unknown>, kind: CloudSaveFailureKind): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected the call to reject with "${kind}"`).toBeInstanceOf(CloudSaveError);
  expect((error as CloudSaveError).kind).toBe(kind);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudSaveStore — the remote SaveStore (spec/04 §1.6, ADR-0036)", () => {
  it("save → load round-trips the snapshot, and the stored record is the exportable JSON text", async () => {
    const transport = new FakeTransport();
    const store = new CloudSaveStore(transport, "save-slot-1");
    const snapshot = fixture();

    await store.save(snapshot);

    // The record IS the exportable document — the exit path of ADR-0002 §21
    // is this text, unchanged by the cloud going through it.
    const record = transport.slots.get("save-slot-1");
    expect(record?.text).toBe(JSON.stringify(snapshot));
    await expect(store.load()).resolves.toEqual(snapshot);
  });

  it("an empty cloud slot reads as null — absence is not failure", async () => {
    const store = new CloudSaveStore(new FakeTransport(), "save-slot-1");
    await expect(store.load()).resolves.toBeNull();
  });

  it("local and cloud stores interchange: one serializeWorld output, one JSON text", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const snapshot = fixture();
    const local = new LocalSaveStore("save-slot-1");
    await local.save(snapshot);

    // What the local store wrote, the cloud store reads…
    const transport = new FakeTransport();
    seed(transport, localStorage.getItem("save-slot-1")!);
    const cloud = new CloudSaveStore(transport, "save-slot-1");
    await expect(cloud.load()).resolves.toEqual(snapshot);

    // …and what the cloud store wrote, the local store reads: one format.
    await cloud.save(snapshot);
    localStorage.setItem("save-slot-1", transport.slots.get("save-slot-1")!.text);
    await expect(local.load()).resolves.toEqual(snapshot);
  });
});

describe("CloudSaveStore — writes are compare-and-swap (decision D2)", () => {
  it("two devices racing: exactly one write lands — the loser hears 'conflict', never a silent overwrite", async () => {
    const transport = new FakeTransport();
    const deviceA = new CloudSaveStore(transport, "save-slot-1");
    const deviceB = new CloudSaveStore(transport, "save-slot-1");
    await deviceA.load();
    await deviceB.load();

    await deviceA.save(fixture(20));
    await expectFailure(deviceB.save(fixture(30)), "conflict");

    // The remote still holds exactly what device A wrote.
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(20)));
  });

  it("a save without a prior load may only CREATE — it can never blind-overwrite another device's save", async () => {
    const transport = new FakeTransport();
    seed(transport, JSON.stringify(fixture(20)));
    const store = new CloudSaveStore(transport, "save-slot-1");

    await expectFailure(store.save(fixture(30)), "conflict");
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(20)));
  });

  it("a brand-new game's first save creates the slot", async () => {
    const transport = new FakeTransport();
    const store = new CloudSaveStore(transport, "save-slot-1");

    await store.save(fixture(20));
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(20)));
  });

  it("consecutive autosaves on one session all land — the observation rides along", async () => {
    const store = new CloudSaveStore(new FakeTransport(), "save-slot-1");

    await store.save(fixture(20));
    await store.save(fixture(30));
    await store.save(fixture(40));
    await expect(store.load()).resolves.toEqual(fixture(40));
  });

  it("overlapping saves from one session queue and all land — 'conflict' is ANOTHER session's doing, never your own autosave", async () => {
    const transport = new FakeTransport();
    const store = new CloudSaveStore(transport, "save-slot-1");

    const first = store.save(fixture(20));
    const second = store.save(fixture(30));
    await first;
    await second;

    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(30)));
  });

  it("a load queued behind an in-flight save observes that save — one instance, one order", async () => {
    const store = new CloudSaveStore(new FakeTransport(), "save-slot-1");

    const saved = store.save(fixture(20));
    await expect(store.load()).resolves.toEqual(fixture(20));
    await saved;
  });

  it("load → save overwrites: reading first is how a session deliberately replaces the remote save", async () => {
    const transport = new FakeTransport();
    seed(transport, JSON.stringify(fixture(20)));
    const store = new CloudSaveStore(transport, "save-slot-1");

    await store.load();
    await store.save(fixture(30));
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(30)));
  });

  it("after a conflict the observation stays stale — retrying still conflicts until the host reloads", async () => {
    const transport = new FakeTransport();
    const deviceA = new CloudSaveStore(transport, "save-slot-1");
    const deviceB = new CloudSaveStore(transport, "save-slot-1");
    await deviceA.load();
    await deviceB.load();
    await deviceA.save(fixture(20));

    await expectFailure(deviceB.save(fixture(30)), "conflict");
    await expectFailure(deviceB.save(fixture(30)), "conflict");

    await deviceB.load(); // re-observe the world as it now stands…
    await deviceB.save(fixture(30)); // …and the write lands
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(30)));
  });
});

describe("CloudSaveStore — failures are loud and classified (decision D5)", () => {
  it("offline: load rejects 'network' — never null (null means 'no save', never 'no network')", async () => {
    const transport = new FakeTransport();
    seed(transport, JSON.stringify(fixture(20)));
    transport.failing = "network";
    const store = new CloudSaveStore(transport, "save-slot-1");

    await expectFailure(store.load(), "network");
  });

  it("offline: save rejects 'network' and the remote record is untouched — no silent local fallback", async () => {
    const transport = new FakeTransport();
    transport.failing = "network";
    const store = new CloudSaveStore(transport, "save-slot-1");

    await expectFailure(store.save(fixture(20)), "network");
    expect(transport.slots.has("save-slot-1")).toBe(false);
  });

  it("an expired session rejects 'auth' — distinguishable from offline, so the host re-logins instead of retrying", async () => {
    const transport = new FakeTransport();
    transport.failing = "auth";
    const store = new CloudSaveStore(transport, "save-slot-1");

    await expectFailure(store.load(), "auth");
    await expectFailure(store.save(fixture(20)), "auth");
  });

  it("a corrupt remote record is a loud 'corrupt' — not an empty slot to quietly start over in", async () => {
    const transport = new FakeTransport();
    seed(transport, "{not json");
    const store = new CloudSaveStore(transport, "save-slot-1");

    await expectFailure(store.load(), "corrupt");
  });

  it("JSON that is not a snapshot envelope is 'corrupt' too", async () => {
    for (const text of [JSON.stringify({ hello: "world" }), JSON.stringify({ version: 2 })]) {
      const transport = new FakeTransport();
      seed(transport, text);
      const store = new CloudSaveStore(transport, "save-slot-1");
      await expectFailure(store.load(), "corrupt");
    }
  });

  it("a corrupt record is still repairable: the failed load armed the revision, so the reset save lands", async () => {
    const transport = new FakeTransport();
    seed(transport, "{not json");
    const store = new CloudSaveStore(transport, "save-slot-1");
    await expectFailure(store.load(), "corrupt");

    await store.save(fixture(20));
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(fixture(20)));
  });

  it("a half-typed record is 'corrupt': an unusable revision is never armed, a usable one still arms for repair", async () => {
    const armed: (string | null)[] = [];
    const write = async (_key: string, _text: string, expectedRevision: string | null) => {
      armed.push(expectedRevision);
      return "next";
    };

    // A revision that is not a string cannot anchor a CAS — nothing is armed.
    const noRevision: CloudSaveTransport = {
      read: async () => ({ text: JSON.stringify(fixture(20)), revision: 17 as unknown as string }),
      write,
    };
    const storeA = new CloudSaveStore(noRevision, "save-slot-1");
    await expectFailure(storeA.load(), "corrupt");
    await storeA.save(fixture(30));
    expect(armed).toEqual([null]);

    // A string revision with garbage text still arms — the reset save lands.
    const noText: CloudSaveTransport = {
      read: async () => ({ text: 123 as unknown as string, revision: "7" }),
      write,
    };
    const storeB = new CloudSaveStore(noText, "save-slot-1");
    await expectFailure(storeB.load(), "corrupt");
    await storeB.save(fixture(30));
    expect(armed).toEqual([null, "7"]);
  });
});

describe("CloudSaveStore — versions pass through, the engine migrates (decision D3)", () => {
  it("an older cloud save comes back unmigrated, then goes through the same migrateSnapshot as a local save", async () => {
    const v1: Snapshot = {
      version: 1,
      data: { entities: { jia: { id: "jia", locationId: "room-a", flags: ["seen"] } } },
    };
    const transport = new FakeTransport();
    seed(transport, JSON.stringify(v1));
    const store = new CloudSaveStore(transport, "save-slot-1");

    const loaded = await store.load();
    expect(loaded).toEqual(v1); // verbatim: this class never migrates

    // The one chain, whichever store the save came through (AC3).
    vi.stubGlobal("localStorage", memoryStorage());
    const local = new LocalSaveStore("save-slot-1");
    await local.save(v1);
    expect(restoreWorld(loaded!)).toEqual(restoreWorld((await local.load())!));

    // …and what the chain does to v1 is the migration's own defaults.
    const restored = restoreWorld(loaded!);
    expect(restored.meta).toEqual({ nowTick: 0, rngState: 0, due: [] });
    expect(restored.state.entities["jia"]!.lastSeenTick).toBe(0);
  });

  it("a save from a NEWER client fails loudly — downgrading would have to throw the v2 scalars away", async () => {
    const v3: Snapshot = { version: 3, data: { entities: {} } };
    const transport = new FakeTransport();
    seed(transport, JSON.stringify(v3));
    const store = new CloudSaveStore(transport, "save-slot-1");

    const loaded = await store.load();
    expect(loaded).toEqual(v3); // returned verbatim…
    expect(() => restoreWorld(loaded!)).toThrow("unsupported save version"); // …refused loudly by the chain
  });
});

describe("CloudSaveStore — the text seam round-trips tricky Unicode (G6)", () => {
  it("surrogate pairs, emoji, CJK and a lone surrogate survive save → load unchanged", async () => {
    const snapshot = fixture();
    (snapshot.data as { entities: Record<string, EntityState> }).entities["jia"]!.flags = [
      "少侠",
      "𠮷野家",
      "🎮",
      "\uD800",
    ];
    const transport = new FakeTransport();
    const store = new CloudSaveStore(transport, "save-slot-1");

    await store.save(snapshot);
    expect(transport.slots.get("save-slot-1")!.text).toBe(JSON.stringify(snapshot));
    await expect(store.load()).resolves.toEqual(snapshot);
  });
});
