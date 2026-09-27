import type { SaveStore, Snapshot } from "@sexymud/core";
import { parseSnapshotText } from "./saveText.js";

/**
 * The cloud-backed `SaveStore` — the first remote implementation of the port
 * (spec/04 §1.6, ADR-0036, #29): the one ADR-0017 §5 says it is — just
 * another `SaveStore`. Same interface as {@link LocalSaveStore}, swapped in by
 * the host; the snapshot format and the migration chain are untouched, so a
 * local save and a cloud save read each other and the export path is the same
 * JSON document (ADR-0002 §11/§21). `packages/core` sees nothing new.
 *
 * **Identity (decision D1)** lives in the TRANSPORT, not in this class: a
 * transport is constructed already bound to one authenticated session, so
 * "whose save is this" is answered before any save is written. Cross-device
 * continuation needs a cross-device ACCOUNT (a device id only ever covers one
 * machine), and getting one — logging in — is the Auth ticket's work, not the
 * save store's.
 *
 * **Conflicts (decision D2)** are resolved by compare-and-swap, never by
 * last-write-wins: every `save` is a CAS against the revision this instance
 * last OBSERVED. Exactly one of two racing devices lands its write; the other
 * is told, loudly, that the world moved under it. The port has no version
 * slot and never gains one — the concurrency lives here, where a transport
 * can make it atomic.
 *
 * **Failures (decision D5)** reject — offline and auth expiry never return
 * `null` and never fall back to a local mirror. `null` means "no save",
 * nothing else; a player who is told "saved" must have been saved. The host
 * may keep a visible local mirror of its own, but silent degradation is
 * exactly the hole this decision exists to close.
 *
 * **Versions (decision D3)** pass through untouched: this class stores and
 * returns the snapshot verbatim and NEVER migrates. `restoreWorld` runs the
 * one `migrateSnapshot` chain, on this save or any other, and a save from a
 * NEWER client fails there loudly — downgrading one would have to throw the
 * v2 scalars (`nowTick`/`rngState`/`due`) away, and silent loss beats
 * failure only in games that do not notice (ADR-0003: no half-interpreted
 * state).
 */

/**
 * Why a save failed, classified for the HOST's reaction — the difference
 * between "retry when the network returns" and "ask the player to sign in
 * again" is the difference between a spinner and a lie (decision D5).
 */
export type CloudSaveFailureKind =
  /** Offline, timed out, the backend is down — retryable. */
  | "network"
  /** Session expired or revoked — retrying will not help; re-login will. */
  | "auth"
  /** Another device wrote between this instance's observation and its write. */
  | "conflict"
  /** The stored record is not a usable snapshot envelope (transport damage). */
  | "corrupt";

export class CloudSaveError extends Error {
  constructor(
    readonly kind: CloudSaveFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "CloudSaveError";
  }
}

/** What a slot holds: the save as JSON text, plus its compare-and-swap token. */
export interface CloudSaveRecord {
  /** The stored save as JSON text — the exact exportable snapshot document. */
  text: string;
  /** Opaque revision token. Produced by the backend; compared, never edited. */
  revision: string;
}

/**
 * The seam between the store and whatever backend carries it (CloudBase for
 * cloud save, per ADR-0002 §2 — its adapter lands with the Auth ticket).
 * One transport is bound to ONE owner's session at construction (decision
 * D1) and serves every save slot of that owner.
 *
 * Obligations of every implementation:
 * - `write` is an ATOMIC compare-and-swap: it applies only if the slot's
 *   current revision is exactly `expectedRevision` (`null` = the slot must
 *   not exist), and otherwise applies nothing and rejects `conflict`;
 * - failures reject with {@link CloudSaveError} — `network`/`auth` from the
 *   backend, `conflict` from the CAS. An unexpected backend error is a
 *   `network` one (retryable is the safe reading of "unknown").
 */
export interface CloudSaveTransport {
  /** The slot's record, or `null` when the slot is empty (absence is not failure). */
  read(key: string): Promise<CloudSaveRecord | null>;
  /** CAS write; resolves with the NEW revision token. */
  write(key: string, text: string, expectedRevision: string | null): Promise<string>;
}

export class CloudSaveStore implements SaveStore {
  /**
   * The revision this instance last observed — `null` meaning "observed
   * empty", which is also the state of an instance that never loaded. That
   * one is deliberate (decision D2): a save without a prior load may only
   * CREATE, so a fresh session can never blind-overwrite a save another
   * device already made.
   */
  private revision: string | null = null;

  constructor(
    private readonly transport: CloudSaveTransport,
    private readonly key: string,
  ) {}

  async load(): Promise<Snapshot | null> {
    const record = await this.transport.read(this.key);
    if (record === null) {
      this.revision = null;
      return null;
    }
    // Armed BEFORE parsing, and kept even when the text is unusable: a
    // corrupt cloud save must still be repairable by the next `save` (the
    // reset path), and a CAS against "absent" would refuse exactly that.
    this.revision = record.revision;
    // The same envelope check the local store runs (parseSnapshotText) — one
    // verdict for "corrupt" whichever store is plugged in. What it rejects is
    // TRANSPORT damage; the payload inside `data` stays the engine's nine
    // corruption classes (decision D3).
    try {
      return parseSnapshotText(record.text);
    } catch (cause) {
      throw new CloudSaveError(
        "corrupt",
        cause instanceof Error ? cause.message : "cloud save: unreadable record",
      );
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    const revision = await this.transport.write(
      this.key,
      JSON.stringify(snapshot),
      this.revision,
    );
    this.revision = revision;
  }
}
