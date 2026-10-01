import type { SaveStore, Snapshot } from "@sexymud/core";
import { parseSnapshotText } from "./saveText.js";

/**
 * The storage itself could not be reached — `localStorage` threw on access
 * (browser storage disabled, privacy mode, blocked). This is NOT save damage
 * (#32 D4): the two troubles point at opposite doors — damage means repair /
 * export salvage / import over it, a disabled store means check browser
 * settings and retrying never helps — so they may never share a word.
 */
export class LocalSaveUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalSaveUnavailableError";
  }
}

/**
 * The stored text is damaged — not a usable snapshot envelope (the same
 * verdict the cloud store's parse gives, saveText.ts). The storage is fine;
 * the bytes are what a repair or export works on.
 */
export class LocalSaveCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalSaveCorruptError";
  }
}

/**
 * The quota signal: the standard DOMException word, or its legacy numeric
 * code — an enum word, never a guessed message (the minimal-signal-table law
 * of ADR-0037 D5). Quota is NOT "unavailable" (#32 D4): a full store and a
 * disabled store have opposite exits — delete saves vs change settings — and
 * folding the two would word one of them into the wrong action.
 */
function isQuotaFailure(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.code === 22)
  );
}

/**
 * What a RAW read of the local slot produces (#34, decision D4): the stored
 * bytes exactly as they are, or their absence. "Corrupt" is NEVER this face's
 * word — the bytes of a damaged save still read fine and are all a salvage
 * needs; judging them is the caller's parse, not this read's.
 */
export type RawLocalRead =
  | { kind: "text"; text: string }
  | { kind: "empty" }
  /** The storage itself could not be reached (#32 D4) — there are no bytes to read. */
  | { kind: "unavailable" };

/**
 * Browser-local SaveStore implementation. Its cloud-backed sibling — same
 * interface, same snapshot text — is `CloudSaveStore` (cloudSaveStore.ts,
 * ticket #29); the two stores interchange saves byte-for-byte.
 */
export class LocalSaveStore implements SaveStore {
  constructor(private readonly key: string) {}

  async load(): Promise<Snapshot | null> {
    const raw = this.readText();
    if (!raw) return null;
    // Corrupt saves fail loudly instead of silently starting a fresh game
    // (which would overwrite the broken save on the next autosave); the host
    // catches and offers a reset. Same envelope check as the cloud store's —
    // one verdict for both stores (parseSnapshotText) — wrapped in its own
    // class so "damaged text" and "unreachable storage" stay tellable apart.
    try {
      return parseSnapshotText(raw);
    } catch (cause) {
      throw new LocalSaveCorruptError(
        cause instanceof Error ? cause.message : "local save: unreadable text",
        { cause },
      );
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    try {
      localStorage.setItem(this.key, JSON.stringify(snapshot));
    } catch (cause) {
      // A full store is its own failure (quota stays quota — its exit is
      // deleting saves); everything else the storage layer throws is the
      // unreachable class (#32 D4).
      if (isQuotaFailure(cause)) throw cause;
      throw new LocalSaveUnavailableError("local save: storage is not accessible", { cause });
    }
  }

  /**
   * The slot's ORIGINAL text (#34, decision D4 — the export path's face):
   * bytes out untouched, damage included — a salvage works on exactly what
   * was stored, and so does a repair's diff. The core `SaveStore` port is
   * untouched (the red line); this raw face hangs here, on the host's store,
   * and it never parses: `empty` is absence, `unavailable` is unreachable
   * storage (#32 D4), and everything else is `text` for the caller to judge.
   */
  async readRaw(): Promise<RawLocalRead> {
    let raw: string | null;
    try {
      raw = this.readText();
    } catch {
      return { kind: "unavailable" };
    }
    return raw ? { kind: "text", text: raw } : { kind: "empty" };
  }

  /**
   * The one storage read both faces sit on: the stored text or its absence,
   * and nothing else — an unreachable store throws its own class (#32 D4):
   * a reader that cannot reach the bytes must not send the player repairing
   * a save that is fine.
   */
  private readText(): string | null {
    try {
      return localStorage.getItem(this.key);
    } catch (cause) {
      throw new LocalSaveUnavailableError("local save: storage is not accessible", { cause });
    }
  }
}
