import type { Rng } from "../types.js";
import type { EventDraft } from "../command/pipeline.js";
import type { WorldRuntime } from "../world/runtime.js";
import type { EffectPrimitive } from "./entry.js";

/**
 * The primitive implementation registry (#56, AC3): effect entries name
 * primitive TYPE IDS, and execution resolves each id to its implementation
 * HERE — the predicate registry's exact discipline (conditions.ts): the
 * engine ships implementations, hosts may inject their own table, the same
 * type id twice is a build error (a shadowed primitive must fail loudly,
 * never silently resolve to one of its candidates).
 *
 * The CONTRACT an implementation runs against is the {@link
 * EffectExecutionContext} — everything a combat-facing primitive needs (the
 * runtime holding attrs and the combat session, the registry's content, the
 * strike's participants, the now, the dice, the event port) and nothing
 * more. It is defined HERE, on the contract side, so that `effects/` imports
 * no mechanism module (AC8's pinned direction): the implementations of the
 * shipped types live with their consumer in `combat/` and REGISTER
 * themselves into this shape — the effect contract is the six-cross-cutting
 * "effects" half, and a future mechanism module (skills, items) registers
 * its primitives the same way without either side knowing the other.
 */

/**
 * What a primitive executes against: one strike's whole context. Read-only
 * apart from the world itself — a primitive writes the WORLD (the combat
 * session's HP, a poison ledger) and emits events, never a local result
 * object: the strike orchestration (combat/strike.ts) reads the world back
 * after the walk to decide the retaliation half.
 */
export interface EffectExecutionContext {
  /** The live world: the tree (attrs, the combat session) and the registry. */
  readonly runtime: WorldRuntime;
  /** Who strikes (the command's actor — the player in C1, D12's one-way face). */
  readonly attackerId: string;
  /** The npc entry id struck (single target, D12). */
  readonly targetNpcId: string;
  /** The effect entry this primitive belongs to — the ledger's look-back key. */
  readonly effectId: string;
  /** The engine's now this strike runs at (the command's high-water reading). */
  readonly nowTick: number;
  /** The injected dice (dodge rolls, application chances — ADR-0017). */
  readonly rng: Rng;
  /** How a primitive's events leave: semantic drafts, stamped by the pipeline. */
  emit(recipientId: string, draft: EventDraft): void;
}

/** One primitive type's implementation: runs the primitive against a strike. */
export type EffectPrimitiveHandler = (
  primitive: EffectPrimitive,
  context: EffectExecutionContext,
) => void;

/**
 * Builds a primitive registry. The same type id twice is a build error —
 * the predicate-registry discipline, word for word.
 */
export function createEffectPrimitiveRegistry(
  entries: Iterable<readonly [string, EffectPrimitiveHandler]>,
): ReadonlyMap<string, EffectPrimitiveHandler> {
  const registry = new Map<string, EffectPrimitiveHandler>();
  for (const [type, handler] of entries) {
    if (type.trim() === "") {
      throw new Error("effect primitive registry: empty type id");
    }
    if (typeof handler !== "function") {
      throw new Error(`effect primitive registry: "${type}" is not a function`);
    }
    if (registry.has(type)) {
      throw new Error(`effect primitive registry: "${type}" is registered twice`);
    }
    registry.set(type, handler);
  }
  return registry;
}
