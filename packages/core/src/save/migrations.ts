import type { Snapshot } from "../types.js";

export const SAVE_VERSION = 1;

export interface GameStateV1 {
  resources: Record<string, number>;
  activeActivityId: string | null;
  /** Last time accrual was settled (ms epoch). */
  lastSettleTimestamp: number;
}

/**
 * Stepwise save migrations. Key N migrates a snapshot of version N to N+1.
 * Saves from the future (or from a version with no path) must fail loudly
 * rather than load half-interpreted state.
 */
const migrations: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrateSnapshot<T>(snapshot: Snapshot): T {
  let version = snapshot.version;
  let data = snapshot.data as Record<string, unknown>;
  if (typeof version !== "number" || version < 1 || version > SAVE_VERSION) {
    throw new Error(`unsupported save version: ${version}`);
  }
  while (version < SAVE_VERSION) {
    const step = migrations[version];
    if (!step) throw new Error(`missing migration from save version ${version}`);
    data = step(data);
    version += 1;
  }
  return data as T;
}
