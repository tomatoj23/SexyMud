import type { SaveStore, Snapshot } from "@sexymud/core";

/** Browser-local SaveStore implementation. CloudBase arrives with ticket #18. */
export class LocalSaveStore implements SaveStore {
  constructor(private readonly key: string) {}

  async load(): Promise<Snapshot | null> {
    const raw = localStorage.getItem(this.key);
    if (!raw) return null;
    // Corrupt saves fail loudly instead of silently starting a fresh game
    // (which would overwrite the broken save on the next autosave); the host
    // catches and offers a reset.
    return JSON.parse(raw) as Snapshot;
  }

  async save(snapshot: Snapshot): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(snapshot));
  }
}
