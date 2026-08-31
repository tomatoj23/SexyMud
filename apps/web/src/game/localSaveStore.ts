import type { SaveStore, Snapshot } from "@idlerpg/core";

/** Browser-local SaveStore implementation. CloudBase arrives with ticket #18. */
export class LocalSaveStore implements SaveStore {
  constructor(private readonly key: string) {}

  async load(): Promise<Snapshot | null> {
    const raw = localStorage.getItem(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Snapshot;
    } catch {
      return null;
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(snapshot));
  }
}
