import { migrateSnapshot, restoreWorld, type SaveStore, type Snapshot } from "@sexymud/core";
import { CloudSaveError, type ReplaceResult } from "./cloudSaveStore.js";
import { LocalSaveUnavailableError, type RawLocalRead } from "./localSaveStore.js";
import { parseSnapshotText } from "./saveText.js";

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
 * escape hatch is the export path (ADR-0002 §21) — and since #33 it has a
 * dual: `beginImport` takes the exported JSON back into the local slot, so
 * the salvage channel is no longer one-way. What the export SHIPS is the
 * local slot's original text, read by the machine itself (#34 — #31 D3's
 * corollary: a view can never be the payload); damaged bytes ship too
 * (decision D2: when the save is broken, those bytes are the player's only
 * copy). Importing is a deliberate overwrite of the local slot: the file is
 * read and proven RESTORABLE here before the panel quotes its cost (a
 * damaged or unloadable file is refused loudly and changes nothing), the
 * un-migrated PARSE RESULT is what lands in the slot (the store serializes
 * it and never migrates it — "un-migrated" is the law, not byte fidelity),
 * and the destructive half only runs as the confirm's answer
 * (`commitImport` — the two-step split is where the confirm sits, not a
 * view's).
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
 *
 * **Judgment lives HERE (#45 D1/D2)**: the panel is a thin binding — thin
 * means NO business judgment. What is destructive and its cost ELEMENTS
 * ({@link destructive}), what the status speaks and in what precedence
 * ({@link statusView}), and every guard are this machine's own; the panel
 * draws and reports gestures. A refused action rejects through ONE channel
 * ({@link CloudSyncError}, decision D3 — the old `dismiss` throw was the
 * second shape) and the panel SHOWS the refusal the way AuthPanel does, so
 * no click dies silently behind a greyed-out guess.
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
  | "imported" // a file save landed in the local slot (#33)
  | "exported" // the local slot's own bytes went out as a file (#34)
  | "dismissed" // adjudicated: playing on locally, cloud untouched
  | "remote-empty" // nothing to download — absence is not failure
  | "local-empty" // nothing to upload or export — the same absence, on the local side (#31/#34)
  | "in-sync"; // both sides byte-equal

export type SyncAction = "probe" | "upload" | "download" | "import" | "export";

/** What a FAILED phase names — the word the loud failure speaks with (#32 D4). */
export type SyncFailure =
  | "network"
  | "corrupt"
  | "local"
  | "local-corrupt"
  | "local-unavailable"
  | "file"
  | "file-corrupt"
  | "file-version";

/**
 * The destructive exits of the adjudication (decision D7's judgment, #45 D1):
 * which actions are destructive is a FACT of the machine — the panel only
 * words it.
 */
export type DestructiveAction = "upload" | "download" | "import";

/**
 * One destructive action's cost ELEMENTS (#45 D1): the slot it overwrites and
 * what that slot currently holds. The words a confirm quotes are the render
 * layer's own (engine-purity law); the facts those words hang on live here,
 * so no panel can invent what a button destroys — and no stale reading can
 * make the destroy list itself differ from the machine's (decision D4: the
 * semantics are unchanged, only their HOME moved).
 */
export interface DestructiveView {
  /** The slot the action overwrites — the thing its cost line must name. */
  overwrites: "local" | "remote";
  /**
   * The overwritten slot as last known — a display cache, so its kind is a
   * CLAIM (#31): it may shape the wording, never skip the notice.
   */
  target: SlotView;
}

/**
 * What the status line must speak, in decision D8's precedence (#45 D1): the
 * PHASE first — a standing failure covers the old verdict, the loud-failure
 * law's last sentence — and only then the verdict pair. The precedence IS the
 * judgment; it lives here so a panel cannot re-order it.
 */
export type StatusView =
  | { kind: "busy"; action: SyncAction }
  | { kind: "auth-expired" }
  | { kind: "conflict"; cause: "save" | "compare" }
  | { kind: "failed"; action: SyncAction; failure: SyncFailure }
  | { kind: "verdict"; outcome: SyncOutcome; from: SyncAction | "dismiss" | null };

/**
 * A machine REFUSAL (decision D3, #45): ONE rejection shape for every refused
 * action — the guards (busy / expired / mid-adjudication) and the misuse
 * (commit with nothing staged, dismiss with nothing standing) alike — so a
 * panel adapts at exactly one end. `dismiss`'s synchronous throw was the
 * historical second shape (`dismiss` predates the `run` wording); "one
 * machine, one refusal" is the same law as "failures are loud" (D8).
 */
export type SyncRefusal = "busy" | "auth-expired" | "adjudicating" | "no-staged-import" | "nothing-to-dismiss";

/**
 * The refusal, typed — same law as {@link CloudAuthError}: the message is the
 * machine's own word and the panel SHOWS it (AuthPanel's shape), it never
 * invents words for a judgment it does not own.
 */
export class CloudSyncError extends Error {
  constructor(
    readonly kind: SyncRefusal,
    message: string,
  ) {
    super(message);
    this.name = "CloudSyncError";
  }
}

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
       *
       * The `file` family names the FILE side of the action (#33/#34) — the
       * failure SOURCE is the file, exactly as `local-*` names the local slot
       * and `corrupt` the cloud: `file` is the file's own trouble — the
       * picked file cannot be read (import) or the produced one cannot be
       * made (export: Blob/URL refused) — `file-corrupt` is damage (parse, or
       * payload-class validation — repair is "another file"), `file-version`
       * is a save the migration chain cannot walk (wait for an engine
       * upgrade). Write-side trouble during import reuses `local`/
       * `local-unavailable` unchanged — a full or disabled store is the same
       * exit whichever action got there.
       */
      failure: SyncFailure;
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

/**
 * The narrow slice of the picked file this machine needs (#33) — just its
 * text. The read is part of the IMPORT ACTION (the panel only picks and
 * confirms), which is why a read failure is a machine verdict (`failed`/
 * `"file"`) and not panel noise.
 */
export interface ImportSource {
  text(): Promise<string>;
}

/**
 * The host-side local seam (#34, decision D4): the core `SaveStore` port the
 * machine already drives, plus the RAW read the export path needs — the
 * slot's original text, exactly as stored (byte-faithful, D1). The port
 * itself is untouched (the red line): `readRaw` hangs here, on the host's
 * store, and it is read-only by construction — "corrupt" is never its word
 * (the bytes of a damaged save still read out), the parse that words damage
 * is up here.
 */
export interface LocalSlot extends SaveStore {
  readRaw(): Promise<RawLocalRead>;
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
  /**
   * The door the last verdict came through (#34): a verdict is the PAIR
   * (outcome, action) — `local-empty` is one word for two actions and the
   * status line splits its copy per door. Held HERE because the pair must
   * move atomically: a pick attempt or a refusal that leaves the verdict
   * untouched must leave its attribution untouched too (a panel-side
   * "which button was last pressed" counter cannot know that).
   */
  private outcomeFrom: SyncAction | "dismiss" | null = null;
  /**
   * The import's validated payload, held between the two halves of the
   * action (#33): `beginImport` stages it (parsed AND proven restorable),
   * `commitImport` spends it. NOT a view — views describe the SLOTS; this is
   * the one write awaiting its confirm, so no display cache can ever be the
   * payload source (the #31 law, mirrored). Attempt-spent, both halves: a
   * pick attempt replaces it whether or not the new file verifies, and a
   * commit attempt consumes it whether or not the write lands (the retry is
   * re-importing). Guard refusals (busy / expired / conflict) are not
   * attempts — they leave the escrow exactly as it was.
   */
  private pendingImport: Snapshot | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly cloud: CloudSlot,
    private readonly local: LocalSlot,
    private readonly session?: SessionExpiry,
  ) {}

  get state(): SyncState {
    return this.current;
  }

  /** The last verdict — what the status line says. */
  get last(): SyncOutcome {
    return this.outcome;
  }

  /** The door {@link last} came through — shared verdict words split their copy per action. */
  get lastFrom(): SyncAction | "dismiss" | null {
    return this.outcomeFrom;
  }

  /** The local slot as last known — readable in any phase. */
  get localView(): SlotView {
    return this.views.local;
  }

  /** The cloud slot as last known — readable in any phase. */
  get remoteView(): SlotView {
    return this.views.remote;
  }

  /**
   * The destructive exits' description (decision D7, #45 D1): which actions
   * are destructive and their cost ELEMENTS, straight from the machine — a
   * panel reads this and only WORDS it, so the destroy list can never drift
   * from what the actions actually do.
   */
  get destructive(): Record<DestructiveAction, DestructiveView> {
    return {
      upload: { overwrites: "remote", target: this.views.remote },
      download: { overwrites: "local", target: this.views.local },
      import: { overwrites: "local", target: this.views.local },
    };
  }

  /**
   * What the status line speaks (decision D8, #45 D1): the precedence is
   * resolved HERE — the phase first (a standing failure covers the old
   * verdict), then the verdict pair. The panel receives one of five shapes
   * and words it; it cannot re-order the law, and `last`/`lastFrom` keep the
   * verdict alive underneath a failure for whenever it speaks again.
   */
  get statusView(): StatusView {
    switch (this.current.phase) {
      case "busy":
        return { kind: "busy", action: this.current.action };
      case "auth-expired":
        return { kind: "auth-expired" };
      case "conflict":
        return { kind: "conflict", cause: this.current.cause };
      case "failed":
        return { kind: "failed", action: this.current.action, failure: this.current.failure };
      case "idle":
        return { kind: "verdict", outcome: this.outcome, from: this.outcomeFrom };
    }
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
      this.settle("none", "probe");
      if (this.views.local.kind === "save" && this.views.remote.kind === "save") {
        if (JSON.stringify(this.views.local.snapshot) === JSON.stringify(this.views.remote.snapshot)) {
          this.settle("in-sync", "probe");
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
        this.settle("local-empty", "upload");
        return { phase: "idle" };
      }
      const snapshot = view.snapshot;
      const result = await this.cloud.replace(snapshot);
      if (result.outcome === "saved") {
        this.views.remote = { kind: "save", snapshot };
        this.settle("saved", "upload");
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
        this.settle("remote-empty", "download");
        return { phase: "idle" };
      }
      try {
        await this.local.save(record);
      } catch (error) {
        return {
          phase: "failed",
          failure: this.localWriteFailure(error),
          action: "download",
        };
      }
      this.views.local = this.views.remote;
      this.settle("downloaded", "download");
      return { phase: "idle" };
    });
  }

  /**
   * The escape-hatch export (#34 D1/D2): ships the local slot's ORIGINAL
   * text out as a file. The payload is read HERE — `exportLocal()` takes no
   * argument, so no display view can be the payload source (#31 D3's
   * corollary): the file is the slot's bytes as stored (byte-faithful —
   * damaged bytes ship too, salvage is the point of decision D2) and a slot
   * written behind this machine exports the NEW content. The read IS the
   * view refresh (#31 D3): one read, and the view shows exactly what shipped.
   *
   * Absence and trouble are their own verdicts (decision D2/D3): an empty
   * slot is `"local-empty"` — absence is not failure — an unreachable one is
   * `failed`/`"local-unavailable"` (no bytes, no file), and the file side's
   * own refusal (Blob/URL) is `failed`/`"file"` (#33's word). A SUCCESS or an
   * ABSENCE changes nothing anywhere, so a standing adjudication stands —
   * exporting is not one of decision D7's three exits, and an empty slot is
   * not a failure (D2). Only a FAILURE interrupts a standing adjudication:
   * "a failure covers the old verdict" is the one sanctioned override (the
   * loud-failure law, ADR-0037 D8's last sentence), and even that chooses
   * nothing — both slots stay exactly as they were and a probe re-derives the
   * same comparison. (A standing FAILED phase is cleared by any fresh
   * verdict, upload/probe style — a new verdict supersedes an old failure;
   * that is supersession, not the cover-up the law forbids.)
   */
  exportLocal(): Promise<SyncState> {
    // Captured before `run` parks the machine on "busy": a non-failure export
    // must leave a standing adjudication exactly where it was.
    const standing = this.current.phase === "conflict" ? this.current : { phase: "idle" as const };
    return this.run("export", async () => {
      const raw = await this.readRawLocal();
      this.views.local = this.rawView(raw); // the read is the refresh
      if (raw.kind === "unavailable") {
        return { phase: "failed", failure: "local-unavailable", action: "export" };
      }
      if (raw.kind === "empty") {
        this.settle("local-empty", "export");
        return standing;
      }
      try {
        sendSaveFile(raw.text);
      } catch {
        return { phase: "failed", failure: "file", action: "export" };
      }
      this.settle("exported", "export");
      return standing;
    });
  }

  /**
   * The import's front half (#33 D3/D4): read the picked file, parse it,
   * and prove `restoreWorld` can load it — only then does the panel quote
   * the overwrite's cost. Nothing is written here and no verdict is claimed:
   * a refusal is loud and the slot is untouched (`file` cannot read /
   * `file-corrupt` damaged / `file-version` the chain cannot walk), and the
   * verified payload — **the un-migrated parse result** (the store never
   * migrates; it serializes what it is given) — is staged for
   * {@link commitImport}.
   *
   * Validation is `restoreWorld`'s whole chain, not just the migration
   * walk: an envelope-clean file with a damaged payload would otherwise be
   * welcomed now and explode at the worst time (the actual load). Which
   * class of damage it is, the chain is asked WITHOUT the payload: an empty
   * payload cannot crash a migration step, so the probe fails only when the
   * version itself cannot walk (bad stamp / no step) — `file-version`; a
   * probe that walks leaves the damage in the payload — `file-corrupt`. The
   * probe must never eat the real payload: a hostile shape (`data: null`)
   * CRASHES the v1 step (`data.nowTick` on null), and a real-payload probe
   * once worded that one damage `file-version` on v1 and `file-corrupt` on
   * v2 — the words name the damage, never the version stamp's accident.
   */
  beginImport(source: ImportSource): Promise<SyncState> {
    return this.run("import", async () => {
      // A pick REPLACES the escrow, attempt-spent either way: "the staged
      // payload" and "the last picked file" must never be able to differ —
      // a failed re-pick cannot leave the earlier file to land under the
      // next confirm.
      this.pendingImport = null;
      let text: string;
      try {
        text = await source.text();
      } catch {
        return { phase: "failed", failure: "file", action: "import" };
      }
      let parsed: Snapshot;
      try {
        parsed = parseSnapshotText(text);
      } catch {
        return { phase: "failed", failure: "file-corrupt", action: "import" };
      }
      try {
        restoreWorld(parsed);
      } catch {
        let failure: "file-version" | "file-corrupt" = "file-corrupt";
        try {
          migrateSnapshot({ version: parsed.version, data: {} } as Snapshot);
        } catch {
          failure = "file-version";
        }
        return { phase: "failed", failure, action: "import" };
      }
      this.pendingImport = parsed;
      return { phase: "idle" };
    });
  }

  /**
   * The import's destructive half: the confirmed overwrite of the local
   * slot. Takes no argument — the payload is the staged, verified one (no
   * view can smuggle itself in, #31) — and refuses without one (the
   * confirm's escrow is spent by the attempt: a refused write still counts
   * as answered, loudly, and re-importing is the retry). A write failure is
   * the local store's own classification (#32 D4), and nothing half-writes:
   * the slot, the views and the last verdict are all as they were.
   */
  commitImport(): Promise<SyncState> {
    // The instance guards outrank the precondition (#45 复查): a busy or dead
    // machine refuses EVERY action and must say THAT — never "nothing staged",
    // which would send the player hunting for a file while the truth is "wait".
    const refusal = this.instanceRefusal();
    if (refusal) return Promise.reject(refusal);
    const snapshot = this.pendingImport;
    if (!snapshot) {
      return Promise.reject(new CloudSyncError("no-staged-import", "此操作未执行：没有待确认的导入——请重新选择文件。"));
    }
    return this.run("import", async () => {
      this.pendingImport = null;
      try {
        await this.local.save(snapshot);
      } catch (error) {
        return {
          phase: "failed",
          failure: this.localWriteFailure(error),
          action: "import",
        };
      }
      this.views.local = { kind: "save", snapshot };
      this.settle("imported", "import");
      return { phase: "idle" };
    });
  }

  /**
   * The third exit (decision D7): play on locally, cloud untouched. Refuses
   * through the SAME channel as every other refused action (decision D3) —
   * the synchronous throw is gone: one machine, one refusal shape.
   */
  dismiss(): Promise<SyncState> {
    // Guards first (#45 复查, same ordering as `commitImport`): a busy machine
    // says "busy", not "nothing to dismiss" — the refusals name the REAL reason.
    const refusal = this.instanceRefusal();
    if (refusal) return Promise.reject(refusal);
    if (this.current.phase !== "conflict") {
      return Promise.reject(new CloudSyncError("nothing-to-dismiss", "此操作未执行：当前没有待裁决的冲突。"));
    }
    this.settle("dismissed", "dismiss");
    return Promise.resolve(this.transition({ phase: "idle" }));
  }

  /** Runs one action through the guard and the failure mapping. */
  private run(action: SyncAction, work: () => Promise<SyncState>): Promise<SyncState> {
    try {
      this.ensureRunnable(action);
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

  /**
   * The instance-wide refusals (#45 复查): busy and a dead session refuse
   * EVERY action — they outrank any precondition (`commitImport`'s escrow,
   * `dismiss`'s standing conflict) so a refusal always names the real reason.
   * The message is a verdict on the GESTURE ("此操作未执行…"), which is why it
   * may outlive the situation that caused it.
   */
  private instanceRefusal(): CloudSyncError | null {
    if (this.current.phase === "busy") {
      return new CloudSyncError("busy", "此操作未执行：上一个同步操作还在进行——稍候再试。");
    }
    if (this.current.phase === "auth-expired") {
      return new CloudSyncError("auth-expired", "登录已过期，此操作未执行——重新登录后继续云存档。");
    }
    return null;
  }

  private ensureRunnable(action: SyncAction): void {
    const refusal = this.instanceRefusal();
    if (refusal) throw refusal;
    // Importing may not move the stakes mid-adjudication (#33 D3 — the
    // ADR-0037 D7 law that adjudication is among deliberate exits): an
    // import swaps the very slot the conflict is comparing. The panel's
    // disabled button is a display gate reading this same state — this
    // refusal is the only insurance.
    if (this.current.phase === "conflict" && action === "import") {
      throw new CloudSyncError("adjudicating", "此操作未执行：冲突待裁决——请先选择以哪边继续。");
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
   * The local write's own classification (#32 D4), one mapping for every
   * write path: unreachable storage is its own word — "check settings" is
   * not "free some space".
   */
  private localWriteFailure(error: unknown): "local" | "local-unavailable" {
    return error instanceof LocalSaveUnavailableError ? "local-unavailable" : "local";
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

  /**
   * The raw read (#34), tolerant in exactly one direction: a face that THROWS
   * has still failed to produce bytes — the same verdict as its `unavailable`
   * kind ("a read that failed did not find nothing").
   */
  private async readRawLocal(): Promise<RawLocalRead> {
    try {
      return await this.local.readRaw();
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * The local view out of a RAW read (#34): one read, one truth — the view
   * shows exactly the content the export ships, damage included. "corrupt" is
   * the parse's verdict here, never the raw face's.
   */
  private rawView(raw: RawLocalRead): ReadSlotView {
    if (raw.kind !== "text") return { kind: raw.kind };
    try {
      return { kind: "save", snapshot: parseSnapshotText(raw.text) };
    } catch {
      return { kind: "corrupt" };
    }
  }

  private transition(next: SyncState): SyncState {
    this.current = next;
    for (const listener of this.listeners) listener();
    return next;
  }

  /** The verdict moves as one pair — the outcome and its door, never one without the other. */
  private settle(outcome: SyncOutcome, from: SyncAction | "dismiss"): void {
    this.outcome = outcome;
    this.outcomeFrom = from;
  }
}

/**
 * Ships one save's text out as a file — the player's own copy (ADR-0002 §21),
 * byte-for-byte what the slot holds (#34 D1: no re-serialization in between).
 * Throws when the browser's file side refuses — that throw is the `file`
 * failure's source, nothing about the save itself.
 */
function sendSaveFile(text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sexymud-save.json";
  link.click();
  // Deferred: revoking synchronously can cancel the download itself in some
  // browsers — the salvage channel must not fail on its last step.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
