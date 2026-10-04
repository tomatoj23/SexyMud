import { describe, expect, it } from "vitest";
import { CloudSaveError } from "../src/game/cloudSaveStore.js";
import type { CloudSaveRecord, CloudSaveTransport } from "../src/game/cloudSaveStore.js";
import { backendFailure, expectFailure } from "./support.js";

/**
 * The `CloudSaveTransport` CONTRACT SUITE (#44, decision D1): one case list
 * over the seam's observable behavior, run against three targets — the RAM
 * fake transport, the CloudBase transport over `FakeDb`, and the CloudBase
 * transport against a real backend (env-gated, registered in
 * `cloudbase-e2e.test.ts` — one file owns the real backend so parallel test
 * files never fight over the test account's session). FakeDb is a
 * `CloudBaseDb` fake, NOT a transport implementation of its own: target two
 * is the CloudBase transport over it.
 *
 * The case list is the obligations' observable surface — the
 * {@link CloudSaveTransport} docstring's two obligations plus its `read()` and
 * `revision` field comments (the obligations alone carry only two bullets and
 * cannot cover all four groups; #44 复查修订 M11 made the expanded list the
 * source). Four groups:
 *
 *   1. **read's empty-slot semantics** — absence is not failure, and the
 *      record comes back verbatim (the store owns "corrupt", the transport
 *      never pre-judges);
 *   2. **CAS atomicity** — `null` is the only-create anchor, a matching
 *      revision writes, a mismatch (or an occupied slot under `null`) rejects
 *      `conflict` and applies NOTHING;
 *   3. **revision opacity** — the token is minted per write by the backend,
 *      handed back untouched by reads, compared and never edited;
 *   4. **failure classification** — failures reject with `CloudSaveError`
 *      (`network`/`auth` from the backend, `conflict` from the CAS) and an
 *      unexpected backend error is `network` (the unknown⇒network rule).
 *
 * The classification cases here are the obligation's REPRESENTATIVE shapes;
 * the CloudBase adapter's exhaustive SDK-shape matrix (errorCode 16, status
 * 401, carried codes, the login-vocabulary leak) stays in
 * `cloudbase-transport.test.ts`. The two homes are deliberate: this suite
 * answers "every implementation must classify so" per TARGET; that matrix
 * answers "this adapter reads every documented SDK shape right".
 *
 * Capability gating — a case whose mechanism a target physically cannot
 * express is SKIPPED visibly, never silently passed:
 *
 *   - `faults` (inject a backend failure): the RAM fake and FakeDb can; a
 *     real backend cannot be told to be offline;
 *   - `classify` (raw backend SHAPES run through the classification table):
 *     only the CloudBase adapter targets — the RAM fake's knob already speaks
 *     the contract's vocabulary, so there is nothing left to classify there,
 *     and its host-side dual (the RAW rejection cloud-sync must read
 *     defensively) stays that suite's own case;
 *   - `seedRecord` (forge a raw row, damage included): the two fakes can; a
 *     real backend only ever stores what a `write` put there;
 *   - `liveUnauth` (sign the real session out): only the real backend — its
 *     own unauthenticated signal is the classification law against the real
 *     thing (e2e 校准点①), which no fake can vouch for.
 */
export interface TransportRig {
  /** The slot under test — isolated per case (a fresh backend or a fresh key). */
  key: string;
  /** The device under test. */
  transport: CloudSaveTransport;
  /** A second device over the SAME backend — "another session". */
  other(): CloudSaveTransport;
  /** Seeds a raw row AS-IS (damage included) — `can.seedRecord` targets only. */
  seedRecord?(row: CloudSaveRecord): void;
  /** Makes every operation reject with `error`; `null` restores the backend. */
  failWith?(error: Error | null): void;
  /** Signs the live session out — `can.liveUnauth` targets only. */
  expireSession?(): Promise<void>;
}

export interface TransportTarget {
  /**
   * What this target can express — the gate above. Declared at registration
   * time because `it.skipIf` decides before any case body runs.
   */
  can: { seedRecord?: boolean; faults?: boolean; classify?: boolean; liveUnauth?: boolean };
  /** A fresh, isolated, EMPTY backend for one case. */
  open(): Promise<TransportRig> | TransportRig;
}

/** The contract's texts — the exact literals the merged cases already pinned. */
const EXPORTABLE = '{"version":2,"data":{}}';

/**
 * Runs the contract case list against one target. Every case opens its own
 * isolated rig, so the three registrations (and the cases within one) never
 * share state — the real backend gets a per-case key.
 */
export function cloudSaveTransportContract(name: string, target: TransportTarget): void {
  describe(`CloudSaveTransport contract — ${name}`, () => {
    it("an absent slot reads as null — absence is not failure", async () => {
      const rig = await target.open();
      await expect(rig.transport.read(rig.key)).resolves.toBeNull();
    });

    it("a read creates nothing — absence stays absent, so the create-only write still lands", async () => {
      const rig = await target.open();
      await expect(rig.transport.read(rig.key)).resolves.toBeNull();

      // A read that created the row would make this create-only write refuse
      // "occupied" — the read's very emptiness is what the write observes.
      const revision = await rig.transport.write(rig.key, EXPORTABLE, null);
      expect(typeof revision).toBe("string");
    });

    it("a written row comes back exactly — the write's own text and minted token", async () => {
      const rig = await target.open();
      const revision = await rig.transport.write(rig.key, EXPORTABLE, null);

      await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: EXPORTABLE, revision });
    });

    it.skipIf(!target.can.seedRecord)(
      "a stored row with a FOREIGN token comes back verbatim — text and revision exactly as seeded",
      async () => {
        const rig = await target.open();
        // A token this transport never minted — what a row written by ANOTHER
        // session looks like on the way in. `read` hands it back untouched
        // ("compared, never edited"), so the seed here is a healthy record.
        rig.seedRecord!({ text: EXPORTABLE, revision: "rev-7" });

        await expect(rig.transport.read(rig.key)).resolves.toEqual({
          text: EXPORTABLE,
          revision: "rev-7",
        });
      },
    );

    it.skipIf(!target.can.seedRecord)(
      "a damaged row is passed through UNJUDGED — the store owns the 'corrupt' verdict, not the transport",
      async () => {
        const rig = await target.open();
        rig.seedRecord!({ text: 42, revision: { odd: true } } as unknown as CloudSaveRecord);

        // Values flow as they lie in the row; CloudSaveStore's envelope check
        // is the one verdict for "corrupt" whichever store is plugged in (#29).
        await expect(rig.transport.read(rig.key)).resolves.toEqual({
          text: 42,
          revision: { odd: true },
        } as unknown as CloudSaveRecord);
      },
    );

    it("create lands on an empty slot and returns the minted revision", async () => {
      const rig = await target.open();

      const revision = await rig.transport.write(rig.key, EXPORTABLE, null);

      expect(typeof revision).toBe("string");
      await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: EXPORTABLE, revision });
    });

    it("create on an OCCUPIED slot refuses as 'conflict' and writes nothing — never a blind overwrite", async () => {
      const rig = await target.open();
      const theirs = await rig.other().write(rig.key, "theirs", null);

      await expectFailure(rig.transport.write(rig.key, "mine", null), "conflict");
      await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: "theirs", revision: theirs });
    });

    it("an update guarded on the observed revision lands and advances the revision", async () => {
      const rig = await target.open();
      const first = await rig.transport.write(rig.key, "old", null);

      const revision = await rig.transport.write(rig.key, "new", first);

      await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: "new", revision });
      expect(revision).not.toBe(first); // fresh per write — never derived from the old
    });

    it("an update against a STALE revision refuses as 'conflict' and the row keeps the winner's bytes", async () => {
      const rig = await target.open();
      const observed = await rig.transport.write(rig.key, "old", null);
      const winner = await rig.other().write(rig.key, "theirs", observed); // the world moves

      await expectFailure(rig.transport.write(rig.key, "mine", observed), "conflict");
      await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: "theirs", revision: winner });
    });

    it("two devices racing on one observation: exactly one lands — the loser hears 'conflict'", async () => {
      const rig = await target.open();
      const observed = await rig.transport.write(rig.key, "old", null);
      const deviceA = rig.transport;
      const deviceB = rig.other();
      // Both devices hang their write on the SAME observation — the CAS race.
      const fromA = await deviceA.write(rig.key, "from-A", observed);

      await expectFailure(deviceB.write(rig.key, "from-B", observed), "conflict");
      await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: "from-A", revision: fromA });
    });

    it("the revision is opaque and per-write: every write mints a fresh token and reads hand it back untouched", async () => {
      const rig = await target.open();

      const first = await rig.transport.write(rig.key, "one", null);
      const second = await rig.transport.write(rig.key, "two", first);
      const observed = await rig.transport.read(rig.key);

      expect(second).not.toBe(first); // fresh per write — never derived from the old
      expect(observed?.revision).toBe(second);
      await expectFailure(rig.transport.write(rig.key, "three", first), "conflict"); // the old token is spent
    });

    // The two classified-failure cases pin the SEAM's channel, not the
    // classifier. What bites where: on the RAM fake these are FAKE-conformance
    // teeth (a fake that swallowed a rejection — `read` resolving null — goes
    // red here); on an adapter target F2 is the word-preservation tooth (an
    // `asSaveError` that re-worded a classified rejection would flip its
    // kind), while F1 cannot see a network→network re-wording — its teeth are
    // the rejection surfacing at all and "the failed write applies nothing"
    // (the deep half-write pin is the adapter's failCommit case). A taxonomy
    // collapse to one kind stays green on both and dies on the two `classify`
    // cases after them.
    it.skipIf(!target.can.faults)(
      "a 'network' failure rejects read AND write — never null, and the failed write applies nothing",
      async () => {
        const rig = await target.open();
        const winner = await rig.transport.write(rig.key, EXPORTABLE, null);
        rig.failWith!(new CloudSaveError("network", "offline"));

        await expectFailure(rig.transport.read(rig.key), "network"); // never null: null means "no save"
        await expectFailure(rig.transport.write(rig.key, "mine", winner), "network"); // a matching CAS stopped by the fault

        rig.failWith!(null);
        // The failed write applied nothing — the winner's row still stands.
        await expect(rig.transport.read(rig.key)).resolves.toEqual({ text: EXPORTABLE, revision: winner });
      },
    );

    it.skipIf(!target.can.faults)(
      "an 'auth' failure is its own word — the host re-logins instead of retrying",
      async () => {
        const rig = await target.open();
        rig.failWith!(new CloudSaveError("auth", "session expired"));

        await expectFailure(rig.transport.read(rig.key), "auth");
        await expectFailure(rig.transport.write(rig.key, "mine", null), "auth");
      },
    );

    it.skipIf(!(target.can.faults && target.can.classify))(
      "an unauthenticated-shaped backend failure is 'auth' — the obligation's representative shape",
      async () => {
        const rig = await target.open();
        rig.failWith!(backendFailure({ code: "unauthenticated" }));

        await expectFailure(rig.transport.read(rig.key), "auth");
        await expectFailure(rig.transport.write(rig.key, "mine", null), "auth");
      },
    );

    it.skipIf(!(target.can.faults && target.can.classify))(
      "an unknown backend failure — and a shapeless rejection — is 'network' (unknown⇒network)",
      async () => {
        const rig = await target.open();
        rig.failWith!(backendFailure({ code: "internal" }));
        await expectFailure(rig.transport.write(rig.key, "mine", null), "network");

        rig.failWith!(new TypeError("Failed to fetch")); // outside the contract's error shape
        await expectFailure(rig.transport.read(rig.key), "network");
      },
    );

    it.skipIf(!target.can.liveUnauth)(
      "the live backend's own unauthenticated signal is 'auth' — the real thing, not a fake",
      async () => {
        const rig = await target.open();
        await rig.transport.write(rig.key, "mine", null);
        await rig.expireSession!();

        await expectFailure(rig.transport.read(rig.key), "auth");
        await expectFailure(rig.transport.write(rig.key, "theirs", null), "auth");
      },
    );
  });
}
