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
 * What {@link CloudSaveStore.replace} decided — the verdict rides the RESULT
 * (#32, decision D2), never an exception: `saved` covers create, deliberate
 * replace AND damage repair (whether it repaired is visible in the view);
 * `conflict` is a real race and nothing else; `unrepairable` is a row that
 * refuses every write and did not move — no save can ever land on it. One
 * channel, one vocabulary — judgment and dance never split across a return
 * value and a throw.
 */
export type ReplaceResult =
  | { outcome: "saved" }
  | { outcome: "conflict" }
  | { outcome: "unrepairable" };

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

  /**
   * This instance's operations run ONE AT A TIME (#29 复查). Two overlapping
   * saves from the same session — an autosave firing while the previous write
   * is still in the air — used to race on the same observed revision, and the
   * loser was told "conflict" about ITS OWN session's write. Queued, the
   * second save CASes against the first one's result and both land, so
   * `conflict` now means exactly one thing: ANOTHER session wrote.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: CloudSaveTransport,
    private readonly key: string,
  ) {}

  /** Runs `operation` after every operation already queued on this instance. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Arms the CAS anchor from a raw record — the #29 rule in ONE place (#32):
   * a usable revision is armed, and kept even when the text is damaged (that
   * is the repair path); an unusable one arms NOTHING — it cannot anchor a
   * CAS, and it does not DISARM either (an earlier observation stands until a
   * readable row replaces it); an absent row arms "empty", so the next write
   * may only CREATE.
   */
  private arm(record: CloudSaveRecord | null): void {
    if (record === null) {
      this.revision = null;
      return;
    }
    if (typeof record.revision === "string") this.revision = record.revision;
  }

  load(): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      const record = await this.transport.read(this.key);
      // A usable revision is armed BEFORE parsing, and kept even when the
      // text is unusable: a corrupt cloud save must still be repairable by
      // the next write (the reset path), and a CAS against "absent" would
      // refuse exactly that.
      this.arm(record);
      if (record === null) return null;
      // The record is a claim about the backend row, checked like one: a
      // revision that is not a string cannot anchor a CAS, so NOTHING is
      // armed (see {@link arm}) and the read fails loudly instead of
      // half-trusting the row.
      if (typeof record.revision !== "string") {
        throw new CloudSaveError("corrupt", "cloud save: stored record has no usable revision");
      }
      if (typeof record.text !== "string") {
        throw new CloudSaveError("corrupt", "cloud save: stored record text is not a string");
      }
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
    });
  }

  save(snapshot: Snapshot): Promise<void> {
    return this.enqueue(async () => {
      const revision = await this.transport.write(
        this.key,
        JSON.stringify(snapshot),
        this.revision,
      );
      this.revision = revision;
    });
  }

  /**
   * The observe-write-adjudicate dance as ONE call (#32, decision D1):
   * create, deliberate replace and damage repair are the same operation, and
   * what happened rides the result — a caller never re-enacts the arming
   * rules, because they never leave this class.
   *
   * A refused write — or an anchor no faithful CAS can be expressed against —
   * is adjudicated by re-observing the RAW row (decision D3): the same row —
   * revision token and text both unchanged — means nothing moved and nothing
   * ever CAN land (`unrepairable`); anything else — a new row, even a damaged
   * one, or a vanished slot — is somebody writing, i.e. a real `conflict`.
   * That identity is the ONLY exception; there is no gray zone where damage
   * impersonates a race or a race impersonates damage.
   *
   * An unusable anchor is therefore never written against at all: the only
   * write its absence could express is a blind CREATE, which lands exactly
   * when somebody deleted the row mid-dance — winning by clobbering the very
   * race decision D3 assigns to `conflict` (and the verdict would otherwise
   * depend on whatever an earlier operation left armed). No write, no
   * clobber, no history-dependence.
   *
   * One enqueue unit (the #29 serialization law) that talks to the transport
   * DIRECTLY — never the public `load`/`save`, whose own enqueue would park
   * behind this very call and deadlock it, and whose interleaving would break
   * "`conflict` is another session's doing".
   */
  replace(snapshot: Snapshot): Promise<ReplaceResult> {
    return this.enqueue(async () => {
      const text = JSON.stringify(snapshot);
      const observed = await this.transport.read(this.key);
      this.arm(observed);
      // An empty slot anchors a CREATE, a usable token anchors a CAS —
      // nothing else can anchor any write.
      const anchored = observed === null || typeof observed.revision === "string";
      if (anchored) {
        try {
          const revision = await this.transport.write(this.key, text, this.revision);
          this.revision = revision;
          return { outcome: "saved" };
        } catch (error) {
          if (!(error instanceof CloudSaveError && error.kind === "conflict")) throw error;
        }
      }
      const now = await this.transport.read(this.key);
      this.arm(now);
      if (sameRow(observed, now)) return { outcome: "unrepairable" };
      return { outcome: "conflict" };
    });
  }
}

/**
 * The identity of a raw row — decision D3's verdict key: the SAME row means
 * token and text BOTH unchanged. Anything else (a re-minted token, different
 * text, or a vanished slot) is somebody writing. Compared by VALUE, not
 * reference: a damaged row's fields can be non-strings, and two reads of one
 * stored row come back as fresh objects — reference comparison would then
 * misread UNMOVED damage as somebody writing.
 */
function sameRow(before: CloudSaveRecord | null, now: CloudSaveRecord | null): boolean {
  return (
    before !== null &&
    now !== null &&
    sameValue(before.revision, now.revision) &&
    sameValue(before.text, now.text)
  );
}

/** Value equality over whatever a damaged record field happens to hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
