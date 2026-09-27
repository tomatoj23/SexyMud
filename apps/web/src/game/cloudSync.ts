import type { SaveStore, Snapshot } from "@sexymud/core";
import { CloudSaveError } from "./cloudSaveStore.js";

/**
 * The host's cloud-sync surface (#30, spec/04 §1.6, ADR-0037): the sync
 * STATUS a player reads ("saved / not saved / conflicted / session expired")
 * and the CONFLICT ADJUDICATION they decide. It sits above the two real
 * stores — `CloudSaveStore` (#29) and `LocalSaveStore` — and turns their
 * outcomes into states; it never talks to a backend itself.
 *
 * **Sync is explicit (decision D3)**: login auto-uploads nothing and merges
 * nothing. The probe only shows both sides; every write is a button. Byte-
 * equal saves are "in sync"; anything else is the player's call, because a
 * snapshot is one whole JSON document with no field-level merge to invent.
 *
 * **Adjudication has three exits (decision D7)**: keep local (the deliberate
 * replace — `load` first observes, then `save` CAS-overwrites the other
 * device's save), take remote (download it into the local slot), or dismiss
 * and play on locally. "Keep both" is not one of them: forking save slots is
 * a slot-management feature this project does not have (#29 refused the same
 * route); the escape hatch is the export path (ADR-0002 §21).
 *
 * **Failures are loud and untouched (decision D8)**: a refused save reports
 * "not saved" with BOTH stores exactly as they were — no silent local
 * fallback, no retry loop. The one deliberate exception is upload over a
 * CORRUPT cloud save: the store's load arms the revision even when the TEXT
 * is damaged (#29's repair path), so upload proceeds and replaces the
 * damage — but when the record's REVISION anchor is the damage, no write can
 * CAS against it and upload reports the corruption instead of a phantom
 * conflict. An `auth` failure ends the INSTANCE (decision D6): the re-login
 * guide comes up and every further action refuses without a backend call —
 * the player's re-login rebuilds the transport around the new session.
 */

/** What one side's slot holds — the comparison the panel renders. */
export type SlotView =
  | { kind: "unknown" }
  | { kind: "empty" }
  | { kind: "save"; snapshot: Snapshot }
  | { kind: "corrupt" };

/** The last sync action's verdict — what the status line says. */
export type SyncOutcome =
  | "none" // nothing synced yet
  | "saved" // "存了" — the cloud save landed
  | "downloaded" // the cloud save came down into the local slot
  | "dismissed" // adjudicated: playing on locally, cloud untouched
  | "remote-empty" // nothing to download — absence is not failure
  | "in-sync"; // both sides byte-equal

export type SyncAction = "probe" | "upload" | "download";

/**
 * The machine's PHASE with just its contextual fields — the comparison and
 * the verdict are orthogonal (see {@link CloudSync.last} and friends), so a
 * phase carries only what makes that phase itself.
 */
export type SyncState =
  | { phase: "idle" }
  | { phase: "busy"; action: SyncAction }
  | {
      phase: "conflict";
      /** `save` = a CAS refusal mid-upload; `compare` = the probe found divergence. */
      cause: "save" | "compare";
    }
  | {
      phase: "failed";
      /** `local` is the rare one: the local write itself refused (quota). */
      failure: "network" | "corrupt" | "local";
      action: SyncAction;
    }
  | { phase: "auth-expired" };

/** The narrow slice of {@link CloudAuth} this machine needs — a dead session is its business. */
export interface SessionExpiry {
  markExpired(): void;
}

export class CloudSync {
  private current: SyncState = { phase: "idle" };
  /**
   * The comparison and the verdict live OUTSIDE the phase: an action in
   * flight (or a failure) must still know what both sides looked like when it
   * started, and the panel renders them through failures too.
   */
  private views: { local: SlotView; remote: SlotView } = {
    local: { kind: "unknown" },
    remote: { kind: "unknown" },
  };
  private outcome: SyncOutcome = "none";
  private listeners = new Set<() => void>();

  constructor(
    private readonly cloud: SaveStore,
    private readonly local: SaveStore,
    private readonly session?: SessionExpiry,
  ) {}

  get state(): SyncState {
    return this.current;
  }

  /** The last verdict — what the status line says. */
  get last(): SyncOutcome {
    return this.outcome;
  }

  /** The local slot as last known — readable in any phase. */
  get localView(): SlotView {
    return this.views.local;
  }

  /** The cloud slot as last known — readable in any phase. */
  get remoteView(): SlotView {
    return this.views.remote;
  }

  /** Notifies on every transition; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Shows both sides (decision D3): empty / save / corrupt per slot. Two
   * byte-equal saves are "in-sync"; two different ones go to the compare
   * conflict — the probe never picks a winner by itself.
   */
  probe(): Promise<SyncState> {
    return this.run("probe", async () => {
      this.views.remote = await this.remoteViewToleratingCorrupt();
      this.views.local = await this.readLocalView();
      if (this.views.local.kind === "save" && this.views.remote.kind === "save") {
        if (JSON.stringify(this.views.local.snapshot) === JSON.stringify(this.views.remote.snapshot)) {
          this.outcome = "in-sync";
          return { phase: "idle" };
        }
        return { phase: "conflict", cause: "compare" };
      }
      return { phase: "idle" };
    });
  }

  /**
   * Uploads a snapshot into the cloud slot — create or the DELIBERATE
   * replace (decision D8: observe first, then CAS). This is also the "keep
   * local" exit of a conflict: same observe-then-write, same explicit
   * overwrite the confirm dialog already named.
   */
  upload(snapshot: Snapshot): Promise<SyncState> {
    return this.run("upload", async () => {
      let damage: CloudSaveError | null = null;
      try {
        await this.cloud.load(); // observe: arm the CAS, see what is there
      } catch (error) {
        // A corrupt cloud save USUALLY still armed its revision (#29's repair
        // path) and the write below replaces the damage. When the damage is
        // in the record's revision anchor nothing is armed, and the write
        // would CAS-create into an occupied slot — the conflict-refresh below
        // tells the two apart and reports the damage honestly instead.
        if (!(error instanceof CloudSaveError && error.kind === "corrupt")) throw error;
        damage = error;
      }
      try {
        await this.cloud.save(snapshot);
      } catch (error) {
        if (error instanceof CloudSaveError && error.kind === "conflict") {
          // Another session wrote under us: show ITS save and let the player
          // choose (decision D7). The refresh re-observes, which is exactly
          // what a later deliberate replace needs anyway.
          this.views.remote = await this.remoteViewToleratingCorrupt();
          if (damage && this.views.remote.kind === "corrupt") {
            // No session wrote — the row is still damaged: its revision anchor
            // was never armed, so no write can CAS against it. Say THAT, not
            // a phantom "another device updated the cloud save".
            throw damage;
          }
          return { phase: "conflict", cause: "save" };
        }
        throw error;
      }
      this.views.remote = { kind: "save", snapshot };
      this.outcome = "saved";
      return { phase: "idle" };
    });
  }

  /** Brings the cloud save down into the local slot — the "keep remote" exit. */
  download(): Promise<SyncState> {
    return this.run("download", async () => {
      let record: Snapshot | null;
      try {
        record = await this.cloud.load();
      } catch (error) {
        if (error instanceof CloudSaveError && error.kind === "corrupt") {
          return { phase: "failed", failure: "corrupt", action: "download" };
        }
        throw error;
      }
      this.views.remote = record === null ? { kind: "empty" } : { kind: "save", snapshot: record };
      if (record === null) {
        this.outcome = "remote-empty";
        return { phase: "idle" };
      }
      try {
        await this.local.save(record);
      } catch {
        return { phase: "failed", failure: "local", action: "download" };
      }
      this.views.local = this.views.remote;
      this.outcome = "downloaded";
      return { phase: "idle" };
    });
  }

  /** The third exit (decision D7): play on locally, cloud untouched. */
  dismiss(): SyncState {
    if (this.current.phase !== "conflict") {
      throw new Error("cloud sync: nothing to dismiss");
    }
    this.outcome = "dismissed";
    return this.transition({ phase: "idle" });
  }

  /** Runs one action through the guard and the failure mapping. */
  private run(action: SyncAction, work: () => Promise<SyncState>): Promise<SyncState> {
    try {
      this.ensureRunnable();
    } catch (error) {
      return Promise.reject(error);
    }
    this.transition({ phase: "busy", action });
    return work().then(
      (next) => this.transition(next),
      (error: unknown) => this.transition(this.failureState(error, action)),
    );
  }

  private ensureRunnable(): void {
    if (this.current.phase === "busy") {
      throw new Error("cloud sync: another sync action is in flight");
    }
    if (this.current.phase === "auth-expired") {
      throw new Error("cloud sync: session expired — sign in again");
    }
  }

  /**
   * The one failure verdict (decision D5/D6): `auth` ends the instance and
   * tells the session; `corrupt` names the damage; everything else — every
   * unknown error included — is `network` (retryable is the safe reading).
   * A `conflict` here is unreachable (upload intercepts its own), mapped to
   * `network` only so the taxonomy stays closed.
   */
  private failureState(error: unknown, action: SyncAction): SyncState {
    if (error instanceof CloudSaveError && error.kind === "auth") {
      this.session?.markExpired();
      return { phase: "auth-expired" };
    }
    return {
      phase: "failed",
      failure: error instanceof CloudSaveError && error.kind === "corrupt" ? "corrupt" : "network",
      action,
    };
  }

  /** The remote slot's view, absorbing `corrupt` into the view instead of failing. */
  private async remoteViewToleratingCorrupt(): Promise<SlotView> {
    try {
      const record = await this.cloud.load();
      return record === null ? { kind: "empty" } : { kind: "save", snapshot: record };
    } catch (error) {
      if (error instanceof CloudSaveError && error.kind === "corrupt") return { kind: "corrupt" };
      throw error;
    }
  }

  /** The local slot's view — any local read failure is visible damage. */
  private async readLocalView(): Promise<SlotView> {
    try {
      const record = await this.local.load();
      return record === null ? { kind: "empty" } : { kind: "save", snapshot: record };
    } catch {
      return { kind: "corrupt" };
    }
  }

  private transition(next: SyncState): SyncState {
    this.current = next;
    for (const listener of this.listeners) listener();
    return next;
  }
}
