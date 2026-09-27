import { describe, expect, it } from "vitest";
import type { Snapshot } from "@sexymud/core";
import { CloudSaveError, CloudSaveStore } from "../src/game/cloudSaveStore.js";
import type { CloudSaveRecord } from "../src/game/cloudSaveStore.js";
import { CloudAuthError, type CloudAuthSession } from "../src/game/cloudAuth.js";
import {
  CloudBaseSaveTransport,
  type CloudBaseDb,
  type CloudBaseDbCollection,
  type CloudBaseDbTransaction,
  type CloudBaseDbTransactionDocument,
} from "../src/game/cloudbaseTransport.js";
import { snapshotFixture } from "./support.js";

/**
 * The CloudBase transport — the REAL backend adapter for `CloudSaveTransport`
 * (ADR-0036 D4's obligations, #30). What the contract demands and what these
 * tests pin against a fake that models the documented CloudBase semantics
 * (conditional update reports `updated`; a transaction's `create` is
 * insert-only and reports `already_exists` on a collision):
 *
 *   - `write` is an ATOMIC compare-and-swap (decision D4): the UPDATE path is
 *     a conditional update guarded on `revision` and reads the `updated`
 *     count; the CREATE path is a transaction whose `get` refuses an
 *     occupied slot and whose `create` never overwrites. A refused write
 *     applies NOTHING — the loser of a race hears `conflict`, loudly;
 *   - the revision is an opaque per-write token (decision D4) — minted at
 *     write time and returned; never derived, never read back;
 *   - the slot is namespaced by ACCOUNT (`uid` prefix, decision D4) — one
 *     transport serves one owner's saves, so two accounts never collide;
 *   - failures are classified on the SDK's documented signals (decision D5):
 *     unauthenticated → `auth`, a create collision the backend reports →
 *     `conflict`, everything unknown → `network` (retryable is the safe
 *     reading of "unknown").
 */

const alice: CloudAuthSession = { uid: "uid-alice", account: "阿丽" };
const bob: CloudAuthSession = { uid: "uid-bob", account: "阿波" };

/** A thrown backend failure in SDK shape — `code`/`errorCode`/`statusCode` are its signals. */
function backendFailure(shape: Record<string, unknown>): Error {
  return Object.assign(new Error("backend: boom"), shape);
}

/**
 * A RAM CloudBase whose document operations carry the DOCUMENTED semantics:
 * `where({…}).update(…)` applies only to rows matching the whole filter and
 * reports `updated`; a transaction's `create` is insert-only (an occupied
 * `_id` is `already_exists`), and a rolled-back transaction applies nothing.
 * Revision tokens are minted GLOBALLY (as real UUIDs are), never per device.
 */
class FakeDb implements CloudBaseDb {
  readonly rows = new Map<string, { text: unknown; revision: unknown }>();
  /** When set, every operation throws this — the offline / auth-expiry paths. */
  failing: Error | null = null;
  /** When set, only `commit` throws — the half-written-row path. */
  failCommit: Error | null = null;
  private counter = 0;

  /** The transport's minter: fresh and unique for the whole fake backend. */
  mintRevision(): string {
    return `t${++this.counter}`;
  }

  collection(name: string): CloudBaseDbCollection {
    const rows = this.rows;
    const maybeFail = () => {
      if (this.failing) throw this.failing;
    };
    return {
      doc(id: string) {
        return {
          async get() {
            maybeFail();
            const row = rows.get(id);
            return { data: row ? [{ _id: id, ...row }] : [] };
          },
        };
      },
      where(filter: Record<string, unknown>) {
        return {
          async update(data: Record<string, unknown>) {
            maybeFail();
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
    if (this.failing) return Promise.reject(this.failing);
    const rows = this.rows;
    const failCommit = this.failCommit;
    const staged: { id: string; row: { text: unknown; revision: unknown } }[] = [];
    const document = (id: string): CloudBaseDbTransactionDocument => ({
      async get() {
        const row = staged.find((s) => s.id === id)?.row ?? rows.get(id);
        return { data: row ? [{ _id: id, ...row }] : [] };
      },
      async create(data: Record<string, unknown>) {
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
        staged.length = 0;
      },
    });
  }
}

/** A transport under test — minter shared with the fake backend (decision D4). */
function makeTransport(db: FakeDb, session: CloudAuthSession = alice): CloudBaseSaveTransport {
  return new CloudBaseSaveTransport(db, session, { mintRevision: () => db.mintRevision() });
}

/**
 * Asserts a call failed the way the contract says: a `CloudSaveError` of the
 * expected KIND — the host reacts differently per kind, so a bare "threw"
 * would survive a taxonomy collapse into plain objects.
 */
async function expectFailure(promise: Promise<unknown>, kind: string): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected the call to reject with "${kind}"`).toBeInstanceOf(CloudSaveError);
  expect((error as CloudSaveError).kind).toBe(kind);
}

describe("CloudBaseSaveTransport — reads are presence, not failure (decision D4)", () => {
  it("an absent slot reads as null — absence is not failure", async () => {
    const transport = makeTransport(new FakeDb());
    await expect(transport.read("save-slot-1")).resolves.toBeNull();
  });

  it("a stored row comes back as the record — text and revision, verbatim", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice/save-slot-1", { text: '{"version":2,"data":{}}', revision: "rev-7" });
    const transport = makeTransport(db);

    await expect(transport.read("save-slot-1")).resolves.toEqual({
      text: '{"version":2,"data":{}}',
      revision: "rev-7",
    });
  });

  it("a damaged row is passed through UNJUDGED — the store owns the 'corrupt' verdict, not the transport", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice/save-slot-1", { text: 42, revision: { odd: true } });
    const transport = makeTransport(db);

    // Values flow as they lie in the row; CloudSaveStore's envelope check is
    // the one verdict for "corrupt" whichever store is plugged in (#29).
    await expect(transport.read("save-slot-1")).resolves.toEqual({
      text: 42,
      revision: { odd: true },
    } as unknown as CloudSaveRecord);
  });
});

describe("CloudBaseSaveTransport — writes are atomic compare-and-swap (decision D4)", () => {
  it("create lands on an empty slot and returns the minted revision", async () => {
    const db = new FakeDb();
    const transport = makeTransport(db);

    const revision = await transport.write("save-slot-1", '{"version":2,"data":{}}', null);

    expect(revision).toBe("t1");
    expect(db.rows.get("uid-alice/save-slot-1")).toEqual({
      text: '{"version":2,"data":{}}',
      revision: "t1",
    });
  });

  it("create on an OCCUPIED slot refuses as 'conflict' and writes nothing — never a blind overwrite", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice/save-slot-1", { text: "theirs", revision: "rev-theirs" });
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", null), "conflict");
    expect(db.rows.get("uid-alice/save-slot-1")).toEqual({ text: "theirs", revision: "rev-theirs" });
  });

  it("an update guarded on the observed revision lands and advances the revision", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice/save-slot-1", { text: "old", revision: "rev-1" });
    const transport = makeTransport(db);

    const revision = await transport.write("save-slot-1", "new", "rev-1");

    expect(revision).toBe("t1");
    expect(db.rows.get("uid-alice/save-slot-1")).toEqual({ text: "new", revision: "t1" });
  });

  it("an update against a STALE revision refuses as 'conflict' and the row keeps the winner's bytes", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice/save-slot-1", { text: "theirs", revision: "rev-theirs" });
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", "rev-stale"), "conflict");
    expect(db.rows.get("uid-alice/save-slot-1")).toEqual({ text: "theirs", revision: "rev-theirs" });
  });

  it("two devices racing on one observation: exactly one lands — the loser hears 'conflict'", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice/save-slot-1", { text: "old", revision: "rev-1" });
    const deviceA = makeTransport(db, alice);
    const deviceB = makeTransport(db, alice);

    await deviceA.write("save-slot-1", "from-A", "rev-1");
    await expectFailure(deviceB.write("save-slot-1", "from-B", "rev-1"), "conflict");
    expect(db.rows.get("uid-alice/save-slot-1")).toEqual({ text: "from-A", revision: "t1" });
  });

  it("a raced CREATE (the other device commits first) is a 'conflict' too — the backend's 'already_exists' names the CAS condition", async () => {
    const db = new FakeDb();
    const deviceA = makeTransport(db, alice);
    const deviceB = makeTransport(db, alice);

    await deviceA.write("save-slot-1", "from-A", null);
    await expectFailure(deviceB.write("save-slot-1", "from-B", null), "conflict");
    expect(db.rows.get("uid-alice/save-slot-1")).toEqual({ text: "from-A", revision: "t1" });
  });

  it("the revision is opaque and per-write: every write mints a fresh token and reads hand it back untouched", async () => {
    const db = new FakeDb();
    const transport = makeTransport(db);

    const first = await transport.write("save-slot-1", "one", null);
    const second = await transport.write("save-slot-1", "two", first);
    const observed = await transport.read("save-slot-1");

    expect(first).toBe("t1");
    expect(second).toBe("t2"); // fresh per write — never derived from the old
    expect(observed?.revision).toBe(second);
    await expectFailure(transport.write("save-slot-1", "three", first), "conflict"); // the old token is spent
  });

  it("a failure before commit leaves no half-written row — the transaction applies all or nothing", async () => {
    const db = new FakeDb();
    db.failCommit = backendFailure({ code: "unavailable" });
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", null), "network");
    expect(db.rows.has("uid-alice/save-slot-1")).toBe(false);
  });
});

describe("CloudBaseSaveTransport — the slot is namespaced by account (decision D4)", () => {
  it("two accounts, the same slot key: separate rows — one transport serves one owner", async () => {
    const db = new FakeDb();
    const aliceTransport = makeTransport(db, alice);
    const bobTransport = makeTransport(db, bob);

    await aliceTransport.write("save-slot-1", "alice's save", null);
    await bobTransport.write("save-slot-1", "bob's save", null);

    expect(db.rows.get("uid-alice/save-slot-1")).toMatchObject({ text: "alice's save" });
    expect(db.rows.get("uid-bob/save-slot-1")).toMatchObject({ text: "bob's save" });
    await expect(aliceTransport.read("save-slot-1")).resolves.toMatchObject({ text: "alice's save" });
    await expect(bobTransport.read("save-slot-1")).resolves.toMatchObject({ text: "bob's save" });
  });

  it("a session without identity cannot bind a transport — no uid, no save namespace", () => {
    expect(() => makeTransport(new FakeDb(), { uid: "", account: "无名" })).toThrow(/uid/);
  });
});

describe("CloudBaseSaveTransport — failures are classified on documented signals (decision D5)", () => {
  it("an unauthenticated backend failure is 'auth' — retrying will not help, re-login will", async () => {
    for (const shape of [{ errorCode: 16 }, { code: "unauthenticated" }, { statusCode: 401 }]) {
      const db = new FakeDb();
      db.failing = backendFailure(shape);
      const transport = makeTransport(db);

      await expectFailure(transport.read("save-slot-1"), "auth");
      await expectFailure(transport.write("save-slot-1", "mine", null), "auth");
    }
  });

  it("an unknown backend failure is 'network' — retryable is the safe reading of 'unknown'", async () => {
    const db = new FakeDb();
    db.failing = backendFailure({ code: "internal" });
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", null), "network");
  });

  it("a plain offline rejection (no shape at all) is 'network' too", async () => {
    const db = new FakeDb();
    db.failing = new TypeError("Failed to fetch");
    const transport = makeTransport(db);

    await expectFailure(transport.read("save-slot-1"), "network");
  });

  it("a login failure leaking through the wire stays 'network' — sign-in errors are not this adapter's vocabulary", async () => {
    const db = new FakeDb();
    db.failing = new CloudAuthError("invalid-credentials", "用户名或密码错误");
    const transport = makeTransport(db);

    await expectFailure(transport.read("save-slot-1"), "network");
  });
});

describe("CloudBaseSaveTransport — the port behind CloudSaveStore (ADR-0036 D4)", () => {
  it("a full store round-trip goes through the adapter: save, load, and a second device's conflict", async () => {
    const db = new FakeDb();
    const snapshot: Snapshot = snapshotFixture({ nowTick: 20 });
    const deviceA = new CloudSaveStore(makeTransport(db, alice), "save-slot-1");
    const deviceB = new CloudSaveStore(makeTransport(db, alice), "save-slot-1");

    await deviceA.save(snapshot);
    await expect(deviceB.load()).resolves.toEqual(snapshot);

    // B observed A's write; A's next save is against a spent revision.
    await deviceB.save(snapshotFixture({ nowTick: 30 }));
    await expectFailure(deviceA.save(snapshotFixture({ nowTick: 40 })), "conflict");
    await expect(deviceB.load()).resolves.toEqual(snapshotFixture({ nowTick: 30 }));
  });
});
