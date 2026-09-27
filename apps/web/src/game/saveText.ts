import type { Snapshot } from "@sexymud/core";

/**
 * A stored save's JSON text back into a snapshot envelope — the read half
 * BOTH `SaveStore` implementations share, so "corrupt" means the same thing
 * whichever store the host has plugged in (swap parity, spec/04 §1.6).
 *
 * What is checked HERE is the envelope, and only the envelope: not JSON, or
 * JSON that is not a `{ version, data }` snapshot, fails LOUDLY at load —
 * never a silent fresh start that would autosave over the damage. The payload
 * INSIDE `data` is the engine's nine corruption classes (`restoreWorld`'s
 * job); the two layers name their own damage (decision D3).
 */
export function parseSnapshotText(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("save: stored text is not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as { version?: unknown }).version !== "number" ||
    !("data" in parsed)
  ) {
    throw new Error("save: stored text is not a snapshot envelope");
  }
  return parsed as Snapshot;
}
