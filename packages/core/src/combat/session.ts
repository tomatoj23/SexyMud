import type { ContentRegistry } from "../content/registry.js";
import type { CharacterTable } from "../content/config.js";
import type { EventDraft } from "../command/pipeline.js";
import type { EntitySettleHandler, SettleDraft } from "../time/settle.js";
import type { Rng } from "../types.js";
import { deathEvent, dotTickEvent, strikeEvent } from "../events.js";
import type { EntityState, WorldState } from "../state/tree.js";
import { moveTo } from "../world/move.js";
import type { WorldRuntime } from "../world/runtime.js";
import {
  bandPairOf,
  clampedHp,
  monsterCombatFace,
  readDefenseK,
  requireCharacterTable,
  strikeDamage,
} from "./damage.js";
import { playerBlow } from "./blow.js";
import type { BlowOptions, BlowPorts } from "./blow.js";

/**
 * The combat session's engine-side half (#56, #57): the character-model
 * seeds, the primary-resource read, the NPC's auto-hand, the poison's
 * OBSERVATION-TIME COMPENSATION SETTLEMENT (spec/04 §4.2, D4), and — the C2
 * addition — the RHYTHM ADVANCE that interleaves both sides' auto-hands
 * with the poison's pulses on one timeline.
 *
 * The compensation runs wherever the actor's entity layer is advanced to
 * "now" — every dispatched command's settle, and every actor-bearing beat
 * the host wires (#57 C2-T7) — so the hands and the pulses catch up ACROSS
 * COMMANDS and ACROSS IDLE SPANS through the one mechanism (ADR-0032: one
 * advance function, spans of it). Every hand's and pulse's event carries
 * the tick it was DUE, never the catch-up moment (spec/01 §5.0).
 *
 * The OFFLINE half of the law is NOT here: a reloaded save's owed hands are
 * never settled — `resumeCombatSession` below applies D3's conditional
 * restart at the load point, and this handler only ever advances from the
 * last observation forward.
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

/** What one settle needs to word the NPC's target: id → monster face, loudly. */
function faceOfTarget(registry: ContentRegistry, targetNpcId: string) {
  const npc = registry.npc(targetNpcId);
  // monsterId is the npc entry's own guarantee; the settle path re-asserts
  // it rather than trusting the save's shape alone.
  if (npc.monsterId === undefined) {
    throw new Error(
      `combat: session target "${targetNpcId}" declares no monsterId (content drift)`,
    );
  }
  return { npc, face: monsterCombatFace(registry.monster(npc.monsterId)) };
}

/**
 * The NPC's one auto-hand (#57 D4): the FULL formula — the monster's attack
 * against the player's defenseAttr value, the seat C1 declared and this
 * ticket consumes. No dodge roll (the player rolls nothing — no numeric
 * source until C3's resource system), no effect chain (D5: the npc's effect
 * table is a later ticket's), pure formula damage. A killing hand runs the
 * player-death path: announce, refill, clear the WHOLE session, relocate
 * through the movement orchestration (C1-T6, unchanged).
 */
export function npcStrike(
  runtime: WorldRuntime,
  state: EntityState,
  npcId: string,
  ports: Pick<BlowPorts, "nowTick" | "emit">,
): void {
  const session = state.combat;
  if (session === undefined || session.targetNpcId !== npcId || session.targetDead) {
    throw new Error(
      `combat: no live session for "${state.id}" against "${npcId}" — the npc hand has nowhere to land`,
    );
  }
  const registry = runtime.registry;
  const { face } = faceOfTarget(runtime.registry, npcId);
  const character = requireCharacterTable(registry);
  const defense = state.attrs[character.strike.defenseAttr];
  if (typeof defense !== "number" || !Number.isFinite(defense)) {
    throw new Error(
      `combat: the player's attrs carry no usable defense value (key "${character.strike.defenseAttr}") — seed the character table at startNewGame`,
    );
  }
  const damage = strikeDamage(face.attack, defense, readDefenseK(registry.settings));
  const resource = primaryResourceOf(state, character);
  // F6: one clamped write — the ceiling is the character table's own seed,
  // and a save above a revised ceiling heals itself here too.
  const hp = clampedHp(resource.current - damage, resource.max);
  state.attrs[character.primaryResource.current] = hp;
  const bands = bandPairOf(registry.combatTiers, damage, resource.max, hp);
  ports.emit(state.id, strikeEvent({
    attackerId: npcId,
    defenderId: state.id,
    damage,
    ...bands,
    isDodge: false,
    isCrit: false,
    element: face.element,
    source: face.source,
  }));

  if (hp > character.deathAtOrBelow) {
    return;
  }
  // The player died (C1-T6): announce, refill, clear the WHOLE session —
  // the poison ledger and the NPC's marks go with it — and relocate through
  // the movement orchestration so the announcements ride the same events.
  ports.emit(state.id, deathEvent({ deceasedId: state.id, kind: "player", cause: "strike" }));
  state.attrs[character.primaryResource.current] = resource.max;
  delete state.combat;
  const world = registry.world;
  if (world === undefined) {
    throw new Error("combat: the pack declares no world table — nowhere to send the dead");
  }
  moveTo(
    runtime,
    { entityId: state.id, toLocationId: world.startRoomId, moveType: "teleport" },
    { emit: ports.emit },
  );
}

/** What the poison's entry must declare, read back through the ledger's effectId (D11). */
function dotTermsOf(registry: ContentRegistry, effectId: string) {
  const entry = registry.effect(effectId);
  const primitive = entry.primitives.find((candidate) => candidate.type === "damage-over-time");
  if (primitive === undefined) {
    throw new Error(
      `combat: poison ledger references effect "${effectId}", which declares no damage-over-time primitive (content drift)`,
    );
  }
  return {
    interval: positiveIntegerOf(primitive.tickIntervalTicks, `effect "${effectId}" tickIntervalTicks`),
    maxPulses: positiveIntegerOf(primitive.maxPulses, `effect "${effectId}" maxPulses`),
  };
}

/** The settle handler's wiring: the dice, the effect chain a scheduled hand walks. */
export interface CombatSettleOptions extends BlowOptions {
  /**
   * The session's dice (#57): a scheduled player hand rolls its dodge and
   * its effects' application chances exactly like a typed one, and the
   * settle callback carries no rng of its own — so the host hands in the
   * SAME stream the commands drew from (the one whose state the save
   * carries), at wiring time. Determinism survives: one stream, one order.
   */
  readonly rng: Rng;
}

/**
 * The combat settle handler (#56 D4/D11, #57 D3/D6/C2-T4): ONE scheduler
 * for one actor's whole fight over the span the settler hands in — both
 * sides' auto-hands and the poison's pulses advance on ONE timeline, each
 * due item settled in due-tick order (same tick: the player's hand first,
 * then the npc's, then the poison pulse — D9 plus the "poison is state
 * settlement" ordering half), every event stamped with its due tick.
 *
 * Why one scheduler and not a second handler beside the poison's: two
 * handlers emit in REGISTRATION order, not due-tick order — a span owing a
 * hand at 103 and pulses at 102/104 would read dotTick, dotTick, strike on
 * the wire. The interleave is the ticket's own wording (hands and pulses
 * advance interleaved BY due tick), and only one loop can keep it.
 *
 * A session left dead by a C1-era save (targetDead) is cleared here at the
 * first observation — death clears the session now, and the old mark is the
 * only shape that can still carry one.
 */
export function createCombatSettleHandler(
  runtime: WorldRuntime,
  options: CombatSettleOptions,
): EntitySettleHandler {
  return (entityId, span, emit) => {
    const state = runtime.state.entities[entityId];
    const session = state?.combat;
    if (state === undefined || session === undefined) {
      return;
    }
    // A C1 save's dead session: death clears the WHOLE session under C2 —
    // clear it now (the poison ledger goes with it) and settle nothing.
    if (session.targetDead) {
      delete state.combat;
      return;
    }
    const registry = runtime.registry;
    const character = requireCharacterTable(registry);
    const { face } = faceOfTarget(runtime.registry, session.targetNpcId);
    const playerInterval = character.strikeIntervalTicks;
    const npcInterval = face.attackIntervalTicks;

    // Rhythm data absent (a C1-era save, or a host-assembled session the
    // resume path never touched): seed both sides from THIS observation's
    // now — the same conditional the load-point restart applies, reached
    // the long-span way (C2-T6).
    if (session.playerNextStrikeTick === undefined || session.npcNextStrikeTick === undefined) {
      session.playerNextStrikeTick = span.toTick + playerInterval;
      session.npcNextStrikeTick = span.toTick + npcInterval;
    }
    let playerNext = session.playerNextStrikeTick;
    let npcNext = session.npcNextStrikeTick;

    const dot = session.dot;
    const terms = dot === undefined ? undefined : dotTermsOf(registry, dot.effectId);
    /** The next poison pulse's due tick, when one is still owed. */
    const poisonDue = (): number | undefined => {
      if (dot === undefined || terms === undefined || dot.applied >= terms.maxPulses) {
        return undefined;
      }
      return dot.startTick + (dot.applied + 1) * terms.interval;
    };

    /** One poison pulse, stamped with ITS due tick; a kill clears the session (D6). */
    const poisonPulse = (): void => {
      if (dot === undefined || terms === undefined) return;
      dot.applied += 1;
      session.targetHp = clampedHp(session.targetHp - dot.perTick, face.maxHp);
      const bands = bandPairOf(registry.combatTiers, dot.perTick, face.maxHp, session.targetHp);
      emit(entityId, {
        ...dotTickEvent({
          effectId: dot.effectId,
          targetId: session.targetNpcId,
          damage: dot.perTick,
          ...bands,
          pulsesApplied: dot.applied,
          pulsesTotal: terms.maxPulses,
        }),
        // The pulse's DUE tick — never the catch-up moment (spec/01 §5.0).
        tick: dot.startTick + dot.applied * terms.interval,
      });
      if (session.targetHp <= 0) {
        emit(entityId, {
          ...deathEvent({ deceasedId: session.targetNpcId, kind: "npc", cause: "dot" }),
          // The death rides the killing pulse's due tick (spec/01 §5.0).
          tick: dot.startTick + dot.applied * terms.interval,
        });
        // D6: the whole session goes — the ledger included.
        delete state.combat;
        return;
      }
      if (dot.applied >= terms.maxPulses) {
        // T11④: interval × maxPulses is the poison's whole lifetime.
        delete session.dot;
      }
    };

    const withTick = (draft: EventDraft, tick: number): SettleDraft =>
      ({ ...draft, tick }) as SettleDraft;

    /** One player auto-hand: the blow's dice and chain, stamped with ITS due tick. */
    const playerHand = (dueTick: number): void => {
      const ports: BlowPorts = {
        nowTick: dueTick,
        rng: options.rng,
        emit: (to, draft: EventDraft) => emit(to, withTick(draft, dueTick)),
      };
      playerBlow(runtime, state, session.targetNpcId, ports, options);
    };

    for (;;) {
      if (state.combat === undefined) {
        // The session ended mid-span (either death, or an escape path the
        // caller interleaved): the remaining hands and pulses are void.
        return;
      }
      const playerDue = playerNext <= span.toTick ? playerNext : undefined;
      const npcDue = npcNext <= span.toTick ? npcNext : undefined;
      const dotDueTick = poisonDue();
      const dotLimit = dotDueTick !== undefined && dotDueTick <= span.toTick ? dotDueTick : undefined;
      if (playerDue === undefined && npcDue === undefined && dotLimit === undefined) {
        break;
      }
      // Due-tick order; same tick: the player's hand, then the npc's, then
      // the poison pulse (D9 + the two-laws ordering).
      const playerWins =
        playerDue !== undefined &&
        (npcDue === undefined || playerDue <= npcDue) &&
        (dotLimit === undefined || playerDue <= dotLimit);
      const npcWins =
        !playerWins &&
        npcDue !== undefined &&
        (dotLimit === undefined || npcDue <= dotLimit);
      if (playerWins) {
        playerHand(playerDue!);
        playerNext += playerInterval;
      } else if (npcWins) {
        npcStrike(runtime, state, session.targetNpcId, {
          nowTick: npcDue!,
          emit: (to, draft) => emit(to, withTick(draft, npcDue!)),
        });
        npcNext += npcInterval;
      } else {
        poisonPulse();
      }
    }

    // Write the advanced rhythm back — the save carries where each side's
    // next hand stands (the poison's `applied` was written pulse by pulse).
    session.playerNextStrikeTick = playerNext;
    session.npcNextStrikeTick = npcNext;
  };
}

/**
 * The load-point rhythm restart (#57 D3/C2-T6): applied by the host at the
 * one place a save comes back (continueGame), with the WALL tick it came
 * back at. The owed hands of the offline span are NEVER settled here or
 * after it (ADR-0016: offline fights nobody's fights) — an expired
 * next-strike is reset to now + the interval (fresh start, nothing owed), a
 * still-future one is kept (a short absence must not push the next hand
 * back). A C1-era session with no rhythm pair is seeded the same way, and a
 * dead C1 session is cleared outright. The poison ledger is deliberately
 * untouched — poison is state settlement and catches up across offline
 * spans (the two laws do not mix).
 */
export function resumeCombatSession(
  state: WorldState,
  registry: ContentRegistry,
  nowTick: number,
): void {
  const character = requireCharacterTable(registry);
  for (const entity of Object.values(state.entities)) {
    const session = entity.combat;
    if (session === undefined) {
      continue;
    }
    if (session.targetDead) {
      // A C1 save's dead session: death clears the session under C2.
      delete entity.combat;
      continue;
    }
    const face = faceOfTarget(registry, session.targetNpcId).face;
    const intervals = {
      player: character.strikeIntervalTicks,
      npc: face.attackIntervalTicks,
    };
    if (
      session.playerNextStrikeTick === undefined ||
      session.npcNextStrikeTick === undefined
    ) {
      session.playerNextStrikeTick = nowTick + intervals.player;
      session.npcNextStrikeTick = nowTick + intervals.npc;
      continue;
    }
    if (session.playerNextStrikeTick <= nowTick) {
      session.playerNextStrikeTick = nowTick + intervals.player;
    }
    if (session.npcNextStrikeTick <= nowTick) {
      session.npcNextStrikeTick = nowTick + intervals.npc;
    }
  }
}
