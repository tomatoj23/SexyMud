import type { Snapshot } from "../types.js";

export const SAVE_VERSION = 2;

/**
 * Stepwise save migrations. Key N migrates a snapshot of version N to N+1.
 * Saves from the future (or from a version with no path) must fail loudly
 * rather than load half-interpreted state.
 *
 * ⚠️ This chain was READY AND EMPTY from M2-T5 until v2 (ADR-0003: no fake
 * migrations). Version 1 is therefore the first real entry in it, and the
 * one rule it establishes for every step after it:
 *
 *   **A migration fills in only what is ABSENT.** It records the fact that
 *   "this field did not exist when the save was written" — it does not guess
 *   what the player's state was. Overwriting a field the old save actually
 *   carried would destroy a fact, which is the one thing a migration must
 *   never do.
 */
const migrations: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {
  /**
   * v1 → v2: the world scalars arrive (ADR-0033 §2) plus the due bucket's
   * pending items (spec/04 §4.5, handed over from #23).
   *
   * - `nowTick = 0`, `rngState = 0`, `due = []`: a v1 save predates all
   *   three, so "never written" is the truth being recorded.
   * - `lastSeenTick` defaults to `nowTick` (0) **only when the record omits
   *   it** — v1 saves written after #22 DO carry it, and overwriting 777
   *   with 0 would hand that player a whole world of offline catch-up they
   *   never earned. ADR-0033 §3 predates #22 and assumes the field is always
   *   absent; the rule above is what actually governs.
   */
  1: (data) => {
    const withScalars = {
      ...data,
      nowTick: data.nowTick ?? 0,
      rngState: data.rngState ?? 0,
      due: data.due ?? [],
    };
    const raw = data.entities;
    // Walked only when it really is a record: a save whose `entities` is
    // missing or the wrong shape must still fail LOUDLY in readSaveData. A
    // migration that quietly repaired damage into an empty world would be
    // worse than the damage.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return withScalars;
    }
    const entities: Record<string, unknown> = {};
    for (const [id, record] of Object.entries(raw as Record<string, unknown>)) {
      const entry = typeof record === "object" && record !== null ? record : {};
      const typed = entry as Record<string, unknown>;
      entities[id] = typed.lastSeenTick === undefined ? { ...typed, lastSeenTick: 0 } : typed;
    }
    return { ...withScalars, entities };
  },
};

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
