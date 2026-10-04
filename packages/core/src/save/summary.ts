import { isTickValue } from "../state/slot-rules.js";
import type { SaveDataV2 } from "../state/snapshot.js";
import type { Snapshot } from "../types.js";

/**
 * What one save SHOWS of itself in the slot comparison (#46, W7 — the W7
 * decision table): the display half of the save format, read in ONE module
 * beside the `migrateSnapshot` chain it describes (D2). The panel renders
 * these fields and drills nothing; the cast into the payload shape lives
 * HERE, with the format knowledge it casts against (`SaveDataV2` is the
 * current version's declaration — `state/snapshot.ts` and the serializer
 * write the same name this reader reads).
 */
export interface SaveSummary {
  /** The envelope's version — the slot line's head field. */
  version: number;
  /**
   * The current payload's world tick — the progress suffix's one field.
   * ABSENT (the key is not there) when the save does not carry one legibly.
   */
  nowTick?: number;
}

/**
 * summaryOf — a TOTAL reader (AC3, D3): it never throws on what the save
 * channel hands it. That input is a JSON envelope and nothing else (both
 * stores parse through `parseSnapshotText`), so `data: null` — the payload
 * that crashed the panel's drill before its guard — is just the most
 * hostile of the legal ones, and a throw here would take the whole panel
 * down, salvage button included (M7's law). Exotic JS objects (a throwing
 * getter, a Symbol) are OUTSIDE this contract: they never crossed the JSON
 * boundary this reader fronts.
 *
 * Two tolerances, both DISPLAY ones — judging corruption is the load path's
 * job (`restoreWorld` / C6's "malformed is refused"), never this reader's:
 *
 *   - **absent → no summary**: the field is simply missing from the result.
 *     The load path's "absent means empty" fill (SLOT_RULES' 0) must NOT be
 *     borrowed here — the progress line's law is "missing `nowTick` shows no
 *     suffix", not "shows tick 0" (AC3 keeps the suffix's semantics).
 *   - **malformed → no summary**: a value the current format would not write
 *     (a string, a fraction, a negative) answers the same absence. The kind
 *     is the ONE tick definition the load path validates with
 *     (`state/slot-rules.ts`), so the display never shows a suffix for a
 *     payload the engine itself would refuse.
 *
 * And NO cross-version tolerance (D2): this is the CURRENT version's reader
 * and builds no second version logic. An older save's absent field stays
 * absent — which is exactly what the drill it replaces displayed for it.
 */
export function summaryOf(snapshot: Snapshot): SaveSummary {
  const data: unknown = snapshot.data;
  const raw: unknown =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Partial<SaveDataV2>).nowTick
      : undefined;
  return isTickValue(raw)
    ? { version: snapshot.version, nowTick: raw }
    : { version: snapshot.version };
}
