import { describe, expect, it } from "vitest";
import type { Snapshot } from "@sexymud/core";
import { CloudSaveStore } from "../src/game/cloudSaveStore.js";
import { CloudAuthError } from "../src/game/cloudAuth.js";
import { CloudBaseSaveTransport } from "../src/game/cloudbaseTransport.js";
import {
  alice,
  backendFailure,
  bob,
  expectFailure,
  FakeDb,
  makeTransport,
  snapshotFixture,
} from "./support.js";

/**
 * The CloudBase transport — the REAL backend adapter for `CloudSaveTransport`
 * (ADR-0036 D4's obligations, #30), pinned against `FakeDb` — the shared fake
 * in `support.ts` that models the documented CloudBase semantics (conditional
 * update reports `updated`; a transaction's `create` is insert-only and
 * reports `already_exists`; a transaction's `get` returns one row or null
 * where a plain `get` returns an array; coded gateway failures RESOLVE
 * carrying `code`).
 *
 * Since #44 the seam's OBLIGATIONS themselves — CAS create/update/refused
 * stale write, revision opacity, read's empty-slot semantics, failure
 * classification — run from the shared contract suite (`transport-contract.ts`)
 * against three targets including this adapter; what lives HERE is the
 * ADAPTER's own machinery, the things only this adapter has:
 *
 *   - the CAS shape's two forms (decision D4): the UPDATE path's conditional
 *     update reading the `updated` count, and the CREATE path's transaction —
 *     including the windows between their steps;
 *   - the slot is namespaced by ACCOUNT (`uid~key`, decision D4) — one
 *     transport serves one owner's saves, so two accounts never collide;
 *   - failures are classified on the SDK's documented signals (decision D5)
 *     — the full shape matrix, and the CARRIED error channel that must never
 *     be read as data (decision D8).
 */

describe("CloudBaseSaveTransport — the CAS machinery's own windows (decision D4)", () => {
  // The obligations' core cases (create lands / occupied refuses / guarded
  // update lands / stale refuses / one of two racers / revision opacity) run
  // against this adapter from the shared contract suite — what stays here are
  // the windows only the ADAPTER's two CAS forms have.
  it("the already_exists window is a 'conflict' — the backend naming the CAS condition after our empty get", async () => {
    const db = new FakeDb();
    const transport = makeTransport(db);
    // The race the pre-check cannot see: absent at `get`, occupied at `create`.
    db.raceCreate = () => {
      db.rows.set("uid-alice~save-slot-1", { text: "from-B", revision: "rev-B" });
    };

    await expectFailure(transport.write("save-slot-1", "mine", null), "conflict");
    expect(db.rows.get("uid-alice~save-slot-1")).toEqual({ text: "from-B", revision: "rev-B" });
    expect(db.rollbacks).toBe(1); // the losing transaction rolled back
  });

  it("an update whose count never came back is a 'conflict', not a phantom success", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice~save-slot-1", { text: "old", revision: "rev-1" });
    const transport = makeTransport(db);
    for (const updateResult of [{}, { updated: 2 }]) {
      db.updateResult = updateResult;
      await expectFailure(transport.write("save-slot-1", "mine", "rev-1"), "conflict");
    }
    expect(db.rows.get("uid-alice~save-slot-1")).toEqual({ text: "old", revision: "rev-1" });
  });

  it("a failure before commit leaves no half-written row — the transaction applies all or nothing", async () => {
    const db = new FakeDb();
    db.failCommit = backendFailure({ code: "unavailable" });
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", null), "network");
    expect(db.rows.has("uid-alice~save-slot-1")).toBe(false);
    expect(db.rollbacks).toBe(1);
  });

  it("a throwing revision minter is a classified failure, not a raw rejection (contract shape)", async () => {
    const db = new FakeDb();
    const transport = new CloudBaseSaveTransport(db, alice, {
      mintRevision: () => {
        throw new Error("no entropy");
      },
    });

    await expectFailure(transport.write("save-slot-1", "mine", null), "network");
  });
});

describe("CloudBaseSaveTransport — the slot is namespaced by account (decision D4)", () => {
  it("two accounts, the same slot key: separate rows — one transport serves one owner", async () => {
    const db = new FakeDb();
    const aliceTransport = makeTransport(db, alice);
    const bobTransport = makeTransport(db, bob);

    await aliceTransport.write("save-slot-1", "alice's save", null);
    await bobTransport.write("save-slot-1", "bob's save", null);

    expect(db.rows.get("uid-alice~save-slot-1")).toMatchObject({ text: "alice's save" });
    expect(db.rows.get("uid-bob~save-slot-1")).toMatchObject({ text: "bob's save" });
    await expect(aliceTransport.read("save-slot-1")).resolves.toMatchObject({ text: "alice's save" });
    await expect(bobTransport.read("save-slot-1")).resolves.toMatchObject({ text: "bob's save" });
  });

  it("a session without identity cannot bind a transport — no uid, no save namespace", () => {
    expect(() => makeTransport(new FakeDb(), { uid: "", account: "无名" })).toThrow(/uid/);
  });

  it("id segments must be url-safe — the SDK puts the doc id raw into its REST path", async () => {
    const db = new FakeDb();
    expect(() => makeTransport(db, { uid: "uid/alice", account: "阿丽" })).toThrow(/url-safe/);
    const transport = makeTransport(db);
    // A bad key is a programmer error — plain, not a classified backend failure.
    await expect(transport.read("slot/1")).rejects.toThrow(/url-safe/);
  });
});

describe("CloudBaseSaveTransport — failures are classified on documented signals (decision D5)", () => {
  // The EXHAUSTIVE shape matrix of this adapter (the obligation's
  // representative shapes run against every classify-capable target from the
  // contract suite; what lives here is "this adapter reads every documented
  // SDK shape right" — errorCode/status faces the table unit-tests, this is
  // their wiring through `SAVE_KIND`).
  it("an unauthenticated backend failure is 'auth' — retrying will not help, re-login will", async () => {
    for (const shape of [
      { errorCode: 16 }, // AuthErrorCode.UNAUTHENTICATED
      { code: "unauthenticated" },
      { code: "UNAUTHENTICATED" },
      { code: "login_required" },
      { statusCode: 401 },
      { status: 401 },
      { status: "401" },
    ]) {
      const db = new FakeDb();
      db.failing = backendFailure(shape);
      const transport = makeTransport(db);

      await expectFailure(transport.read("save-slot-1"), "auth");
      await expectFailure(transport.write("save-slot-1", "mine", null), "auth");
    }
  });

  it("a CARRIED error code is a failure, never 'absent' — a coded read must not flow out as no-save (decision D8)", async () => {
    const db = new FakeDb();
    db.coded = { code: "unauthenticated", message: "token expired" };
    const transport = makeTransport(db);

    // The regression this pins: `result.data?.[0]` on a coded result used to
    // read undefined → "no save" → the host silently starts over.
    await expectFailure(transport.read("save-slot-1"), "auth");
  });

  it("a CARRIED unauthenticated code is 'auth' too — the resolved error channel classifies the same", async () => {
    const db = new FakeDb();
    db.coded = { code: "unauthenticated" };
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", null), "auth");
  });

  it("a CARRIED unknown code is 'network' — and never a misreported conflict", async () => {
    const db = new FakeDb();
    db.rows.set("uid-alice~save-slot-1", { text: "old", revision: "rev-1" });
    db.coded = { code: "internal" };
    const transport = makeTransport(db);

    await expectFailure(transport.write("save-slot-1", "mine", "rev-1"), "network");
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
