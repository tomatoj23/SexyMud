import type { SaveStore, Snapshot } from "@sexymud/core";
import { parseSnapshotText } from "./saveText.js";

/**
 * Browser-local SaveStore implementation. Its cloud-backed sibling — same
 * interface, same snapshot text — is `CloudSaveStore` (cloudSaveStore.ts,
 * ticket #29); the two stores interchange saves byte-for-byte.
 */
export class LocalSaveStore implements SaveStore {
  constructor(private readonly key: string) {}

  async load(): Promise<Snapshot | null> {
    const raw = localStorage.getItem(this.key);
    if (!raw) return null;
    // Corrupt saves fail loudly instead of silently starting a fresh game
    // (which would overwrite the broken save on the next autosave); the host
    // catches and offers a reset. Same verdict as the cloud store's — one
    // envelope check for both stores (parseSnapshotText).
    return parseSnapshotText(raw);
  }

  async save(snapshot: Snapshot): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(snapshot));
  }
}
