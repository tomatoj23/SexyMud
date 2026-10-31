import type { CharacterTable } from "../content/config.js";
import type { EntitySettleHandler } from "../time/settle.js";
import { deathEvent, dotTickEvent } from "../events.js";
import type { EntityState } from "../state/tree.js";
import type { WorldRuntime } from "../world/runtime.js";
import { bandPairOf, monsterCombatFace } from "./damage.js";

/**
 * The combat session's engine-side half (#56): the character-model seeds,
 * the primary-resource read, and the poison's OBSERVATION-TIME COMPENSATION
 * SETTLEMENT (spec/04 §4.2, D4) — the first real consumer of the entity
 * settle layer, and the first DoT the :421 checklist row waited for.
 *
 * The compensation runs wherever the world is advanced to "now" — every
 * dispatched command's settle and every heartbeat — so the poison's pulses
 * catch up ACROSS COMMANDS and ACROSS OFFLINE SPANS through the one
 * mechanism (ADR-0032: one advance function, spans of it). Each pulse's
 * event carries the tick it was DUE (`startTick + k × interval`), never the
 * catch-up moment (spec/01 §5.0).
 */

/**
 * Seeds a new game's player attrs from the character-model declaration
 * (AC2): the pack's key list and values, written onto the fresh empty slot.
 * The engine copies numbers it cannot name — which keys mean what stays the
 * table's story.
 */
export function seedCharacterAttrs(state: EntityState, table: CharacterTable): void {
  for (const [key, value] of Object.entries(table.attrs)) {
    state.attrs[key] = value;
  }
}

/** The player's primary-resource pair as numbers, or the loud wiring failure. */
export function primaryResourceOf(
  state: EntityState,
  table: CharacterTable,
): { current: number; max: number } {
  const currentKey = table.primaryResource.current;
  const maxKey = table.primaryResource.max;
  const currentValue = state.attrs[currentKey];
  const maxValue = state.attrs[maxKey];
  if (
    typeof currentValue !== "number" ||
    !Number.isFinite(currentValue) ||
    typeof maxValue !== "number" ||
    !Number.isFinite(maxValue) ||
    maxValue <= 0
  ) {
    throw new Error(
      `combat: the player's attrs carry no usable primary resource (keys "${currentKey}"/"${maxKey}") — seed the character table at startNewGame`,
    );
  }
  return { current: currentValue, max: maxValue };
}

/** Reads a positive integer a DoT primitive declares, loudly (0 or garbage is a pack bug). */
function positiveIntegerOf(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`combat: ${what} must be a positive integer`);
  }
  return value;
}

/**
 * The poison settle handler (D4/D11): settles ONE actor's armed poison over
 * the span the settler hands in. Reads the session's dot ledger, walks the
 * pulses that came due (`floor((toTick − startTick) / interval)`, capped at
 * the entry's maxPulses), emits one dotTick per pulse stamped with its due
 * tick, writes `applied` back after each, and stops mid-pile at a kill (T8:
 * the remaining pulses are void — a dead target takes no further poison).
 * A pile that reaches maxPulses ENDS the poison: the ledger is cleared
 * (T11④ — the entry's interval×maxPulses governs, `durationTicks` belongs
 * to the stat-modifier family and is not read here).
 *
 * The entry is re-read through `dot.effectId` every time — the look-back
 * channel (D11): interval and maxPulses are ENTRY data, never persisted, so
 * a save reloaded mid-poison resumes on the entry's terms. A ledger whose
 * entry no longer declares a damage-over-time primitive is content drift
 * and fails loudly (a silent skip would strand the poison forever).
 */
export function createDotSettleHandler(runtime: WorldRuntime): EntitySettleHandler {
  return (entityId, span, emit) => {
    const session = runtime.state.entities[entityId]?.combat;
    const dot = session?.dot;
    if (session === undefined || dot === undefined) {
      return;
    }
    const registry = runtime.registry;
    const entry = registry.effect(dot.effectId);
    const primitive = entry.primitives.find((candidate) => candidate.type === "damage-over-time");
    if (primitive === undefined) {
      throw new Error(
        `combat: poison ledger references effect "${dot.effectId}", which declares no damage-over-time primitive (content drift)`,
      );
    }
    const interval = positiveIntegerOf(
      primitive.tickIntervalTicks,
      `effect "${dot.effectId}" tickIntervalTicks`,
    );
    const maxPulses = positiveIntegerOf(
      primitive.maxPulses,
      `effect "${dot.effectId}" maxPulses`,
    );

    const npc = registry.npc(session.targetNpcId);
    // monsterId is the strike's entry guarantee; the settle path re-asserts
    // it rather than trusting the save's shape alone.
    if (npc.monsterId === undefined) {
      throw new Error(
        `combat: session target "${session.targetNpcId}" declares no monsterId (content drift)`,
      );
    }
    const face = monsterCombatFace(registry.monster(npc.monsterId));
    const total = Math.min(maxPulses, Math.floor((span.toTick - dot.startTick) / interval));
    while (dot.applied < total) {
      if (session.targetDead) {
        // T8: the target died mid-pile — the rest of the pulses are void.
        return;
      }
      dot.applied += 1;
      session.targetHp -= dot.perTick;
      const bands = bandPairOf(registry.combatTiers, dot.perTick, face.maxHp, session.targetHp);
      emit(entityId, {
        ...dotTickEvent({
          effectId: dot.effectId,
          targetId: session.targetNpcId,
          damage: dot.perTick,
          ...bands,
          pulsesApplied: dot.applied,
          pulsesTotal: maxPulses,
        }),
        // The pulse's DUE tick — never the catch-up moment (spec/01 §5.0).
        tick: dot.startTick + dot.applied * interval,
      });
      if (session.targetHp <= 0) {
        session.targetDead = true;
        emit(entityId, {
          ...deathEvent({
            deceasedId: session.targetNpcId,
            kind: "npc",
            cause: "dot",
          }),
          // The death rides the killing pulse's due tick (spec/01 §5.0).
          tick: dot.startTick + dot.applied * interval,
        });
        return;
      }
    }
    if (dot.applied >= maxPulses) {
      // T11④: interval × maxPulses is the poison's whole lifetime.
      delete session.dot;
    }
  };
}
