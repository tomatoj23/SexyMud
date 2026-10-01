import type { SaveStore, Snapshot } from "@sexymud/core";
import { CloudSaveError, type ReplaceResult } from "./cloudSaveStore.js";
import { LocalSaveUnavailableError } from "./localSaveStore.js";

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
 * What an upload SENDS is the local slot's current content, read by the
 * machine itself (#31): the views below are last-known display caches and
 * can never be a payload.
 *
 * **Adjudication has three exits (decision D7)**: keep local (the deliberate
 * replace — one `replace` call CAS-overwrites the other device's save), take
 * remote (download it into the local slot), or dismiss and play on locally.
 * "Keep both" is not one of them: forking save slots is a slot-management
 * feature this project does not have (#29 refused the same route); the
 * escape hatch is the export path (ADR-0002 §21).
 *
 * **Failures are loud and untouched (decision D8)**: a refused save reports
 * "not saved" with BOTH stores exactly as they were — no silent local
 * fallback, no retry loop. What the cloud side decides about its own rows is
 * its own business (#32): `replace` returns the verdict (`saved` /
 * `conflict` / `unrepairable`) and this machine only translates it into
 * states — it never re-derives what the store already ruled. An `auth`
 * failure ends the INSTANCE (decision D6): the re-login guide comes up and
 * every further action refuses without a backend call — the player's
 * re-login rebuilds the transport around the new session.
 */

/** What one side's slot holds — the comparison the panel renders. */
export type SlotView =
  | { kind: "unknown" }
  | { kind: "empty" }
  | { kind: "save"; snapshot: Snapshot }
  | { kind: "corrupt" }
  /** The storage itself could not be reached (#32 D4) — there are no bytes to show. */
  | { kind: "unavailable" };

/** What a READ of a slot can produce — `unknown` is "never read", not a read result. */
type ReadSlotView = Exclude<SlotView, { kind: "unknown" }>;

/** The last sync action's verdict — what the status line says. */
export type SyncOutcome =
  | "none" // nothing synced yet
  | "saved" // "存了" — the cloud save landed
  | "downloaded" // the cloud save came down into the local slot
  | "dismissed" // adjudicated: playing on locally, cloud untouched
  | "remote-empty" // nothing to download — absence is not failure
  | "local-empty" // nothing to upload — the same absence, on the local side (#31)
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
      /**
       * `local` is the rare one: the local write itself refused (quota).
       * `local-corrupt` is the upload's front half (#31): the local slot's
       * text is damaged, so there is no payload to send. `local-unavailable`
       * is the same front half — or the download's write — when the STORAGE
       * cannot be reached at all (#32 D4): its own word, because "check
       * settings" and "repair the save" are opposite advice. `corrupt` names
       * cloud damage (whose repair path IS the upload).
       */
      failure: "network" | "corrupt" | "local" | "local-corrupt" | "local-unavailable";
      action: SyncAction;
    }
  | { phase: "auth-expired" };

/** The narrow slice of {@link CloudAuth} this machine needs — a dead session is its business. */
export interface SessionExpiry {
  markExpired(): void;
}

/**
 * The host-side cloud seam (#32, decision D5): the port's `load` plus the
 * store's `replace` — the observe-write-adjudicate dance is the store's own
 * knowledge and is never re-enacted here. (`save` stays on `CloudSaveStore`
 * as its `SaveStore` port method; this surface swaps it out for `replace` —
 * a shape swap, not a widening.)
 */
export interface CloudSlot {
  load(): Promise<Snapshot | null>;
  replace(snapshot: Snapshot): Promise<ReplaceResult>;
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
    private readonly cloud: CloudSlot,
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
   * Shows both sides (decision D3): empty / save / corrupt / unavailable per
   * slot. Two byte-equal saves are "in-sync"; two different ones go to the
   * compare conflict — the probe never picks a winner by itself. The verdict
   * is this comparison's own answer: "in-sync" or nothing — a fresh probe
   * never leaves an older verdict contradicting what it just read.
   */
  probe(): Promise<SyncState> {
    return this.run("probe", async () => {
      this.views.remote = await this.remoteViewToleratingCorrupt();
      this.views.local = await this.readLocalView();
      this.outcome = "none";
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
   * Uploads the LOCAL SLOT's current save into the cloud slot — create or
   * the DELIBERATE replace, one store call either way (#32: the store owns
   * the whole observe-write-adjudicate dance). This is also the "keep local"
   * exit of a conflict: same explicit overwrite the confirm dialog already
   * named.
   *
   * **The payload is the slot's current content, read HERE (#31 D1)**:
   * `upload()` takes no argument, so no display view can be the payload
   * source — "thought it saved, saved the stale one" dies at the signature.
   * Acquisition is the action's very front, before any backend call (#31
   * D2): an empty slot is `"local-empty"` (absence is not failure — the dual
   * of `"remote-empty"`), a damaged one is `failed`/`"local-corrupt"`, and
   * an unreachable one `failed`/`"local-unavailable"` (#32 D4). None is a
   * network problem and none pretends to be an "another device" conflict.
   * The read IS the view refresh (#31 D3): every upload re-reads the local
   * view, success or failure — `download()` refreshes the same view on its
   * success path.
   */
  upload(): Promise<SyncState> {
    return this.run("upload", async () => {
      const view = await this.readLocalView();
      this.views.local = view;
      if (view.kind === "corrupt") {
        return { phase: "failed", failure: "local-corrupt", action: "upload" };
      }
      if (view.kind === "unavailable") {
        return { phase: "failed", failure: "local-unavailable", action: "upload" };
      }
      if (view.kind === "empty") {
        this.outcome = "local-empty";
        return { phase: "idle" };
      }
      const snapshot = view.snapshot;
      const result = await this.cloud.replace(snapshot);
      if (result.outcome === "saved") {
        this.views.remote = { kind: "save", snapshot };
        this.outcome = "saved";
        return { phase: "idle" };
      }
      // Either refusal shows the remote as it NOW stands — damage included —
      // and then names which one it was (decision D2/D3): a real race goes to
      // adjudication (decision D7), a row that refuses every write reports
      // the damage. The two never impersonate each other.
      this.views.remote = await this.remoteViewToleratingCorrupt();
      return result.outcome === "conflict"
        ? { phase: "conflict", cause: "save" }
        : { phase: "failed", failure: "corrupt", action: "upload" };
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
      } catch (error) {
        // The local write's own classification (#32 D4): unreachable storage
        // is its own word — "check settings" is not "free some space".
        return {
          phase: "failed",
          failure: error instanceof LocalSaveUnavailableError ? "local-unavailable" : "local",
          action: "download",
        };
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
      (error: unknown) => {
        const landed = this.transition(this.failureState(error, action));
        // Tell the session only AFTER the state landed: the expiry notifies
        // listeners synchronously, and none of them should read "busy" here.
        if (landed.phase === "auth-expired") this.session?.markExpired();
        return landed;
      },
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
   * The one failure verdict (decision D5/D6): `auth` ends the instance (the
   * session is told by {@link run} once the state has landed); `corrupt`
   * names cloud damage (defensive — the flows map their own damage verdicts
   * today); everything else — every unknown error included — is `network`
   * (retryable is the safe reading). A `conflict` never arrives here (the
   * store hands its race verdict back as a result), mapped to `network` only
   * so the taxonomy stays closed.
   */
  private failureState(error: unknown, action: SyncAction): SyncState {
    if (error instanceof CloudSaveError && error.kind === "auth") {
      return { phase: "auth-expired" };
    }
    return {
      phase: "failed",
      failure: error instanceof CloudSaveError && error.kind === "corrupt" ? "corrupt" : "network",
      action,
    };
  }

  /** The remote slot's view, absorbing `corrupt` into the view instead of failing. */
  private async remoteViewToleratingCorrupt(): Promise<ReadSlotView> {
    try {
      const record = await this.cloud.load();
      return record === null ? { kind: "empty" } : { kind: "save", snapshot: record };
    } catch (error) {
      if (error instanceof CloudSaveError && error.kind === "corrupt") return { kind: "corrupt" };
      throw error;
    }
  }

  /**
   * The local slot's view, by the local store's OWN error classes (#32 D4):
   * unreachable storage is `unavailable`, anything else — damaged text
   * included — stays visible damage (the old blanket reading, kept for
   * stores that do not classify). Never "empty": a read that failed did not
   * find nothing.
   */
  private async readLocalView(): Promise<ReadSlotView> {
    try {
      const record = await this.local.load();
      return record === null ? { kind: "empty" } : { kind: "save", snapshot: record };
    } catch (error) {
      return { kind: error instanceof LocalSaveUnavailableError ? "unavailable" : "corrupt" };
    }
  }

  private transition(next: SyncState): SyncState {
    this.current = next;
    for (const listener of this.listeners) listener();
    return next;
  }
}
