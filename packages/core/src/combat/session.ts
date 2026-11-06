import type { ContentRegistry } from "../content/registry.js";
import type { CharacterTable } from "../content/config.js";
import type { EventDraft } from "../command/pipeline.js";
import type { EntitySettleHandler, SettleDraft, SettleSpan } from "../time/settle.js";
import type { Rng } from "../types.js";
import { customEvent, deathEvent, dotTickEvent, strikeEvent } from "../events.js";
import type { EntityState, WorldState } from "../state/tree.js";
import { moveTo } from "../world/move.js";
import type { WorldRuntime } from "../world/runtime.js";
import {
  bandPairOf,
  clampedHp,
  monsterCombatFace,
  playerDodgeChance,
  readDefenseK,
  readDodgeTuning,
  readInternalForceTuning,
  readPrimaryRegenPerTick,
  requireCharacterTable,
  strikeDamage,
} from "./damage.js";
import { playerBlow } from "./blow.js";
import type { BlowPorts, StrikePlan, StrikeSpecOptions } from "./blow.js";
import { selectStrikePlan } from "./martial.js";
import { equippedMentalModifiers } from "./mental.js";
import { aggregateModifiers } from "../effects/modifiers.js";
import type { Modifier } from "../effects/modifiers.js";

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
 * table's story. #58 D13: the table's `initialEquipped` rides the SAME
 * seeding — a new game's martial slot is the pack's opening loadout, and
 * the continueGame re-seed path (a pre-#56 save's empty attrs) writes it
 * for the same reason it writes the attrs.
 */
export function seedCharacterAttrs(state: EntityState, table: CharacterTable): void {
  for (const [key, value] of Object.entries(table.attrs)) {
    state.attrs[key] = value;
  }
  if (table.martial !== undefined && table.martial.initialEquipped.length > 0) {
    state.martial = [...table.martial.initialEquipped];
  }
  // #59 D13: the mental block's opening loadout rides the same seeding —
  // the martial precedent, one table two slots.
  if (table.mental !== undefined && table.mental.initialEquipped.length > 0) {
    state.mental = [...table.mental.initialEquipped];
  }
}

/**
 * The player's primary-resource pair as numbers, or the loud wiring failure.
 * #59 D11: the MAX walks the modifier pipeline (the five consumer points'
 * fourth) — every ceiling, band denominator and refill reads the mentals'
 * widened ceiling, while the CURRENT stays the bare stored value (the death
 * check reads it raw; what a save wrote is what a save meant). An empty
 * member list answers `max(0, base)` — identical on the non-negative domain,
 * the C1–C3 arithmetic unchanged.
 */
export function primaryResourceOf(
  state: EntityState,
  table: CharacterTable,
  mental?: ReadonlyMap<string, readonly Modifier[]>,
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
  return { current: currentValue, max: aggregateModifiers(maxValue, mental?.get(maxKey)) };
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
 * The NPC's one auto-hand (#57 D4, #58 D8/D17): the FULL formula — the
 * monster's attack against the defense the monster's OWN delivery word
 * routes (`defenseAttrs[source]`, the two-way formula's declared pair, D17),
 * guarded by the PLAYER's dodge roll (D8: `min(cap, base + dodge/(dodge+k))`,
 * a hit whole-or-nothing at this orchestration level — F2's symmetry, a
 * dodged hand lands nothing at all). No effect chain (D3→C4: the npc's
 * effect table is a later ticket's). A killing hand runs the player-death
 * path: announce, refill, clear the WHOLE session, relocate through the
 * movement orchestration (C1-T6, unchanged).
 */
export function npcStrike(
  runtime: WorldRuntime,
  state: EntityState,
  npcId: string,
  ports: BlowPorts,
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
  // #59 D11: the player-side operands of the npc's hand — defense, dodge and
  // the primary max — walk the modifier pipeline (consumer points ②③④); the
  // monster's own attack stays bare (D5: the monster side's numbers and
  // formula shape are untouched). The map is computed once per hand; an
  // unequipped or undeclared stat answers the empty list, the pipe's own
  // identity degenerate.
  const mental = equippedMentalModifiers(registry, state);
  const defenseKey = character.strike.defenseAttrs[face.source];
  if (typeof defenseKey !== "string" || defenseKey === "") {
    throw new Error(
      `combat: the character table's defenseAttrs carries no key for delivery word "${face.source}" — the pack's defense pair and the dimensions source dimension disagree (D17)`,
    );
  }
  const defenseRaw = state.attrs[defenseKey];
  if (typeof defenseRaw !== "number" || !Number.isFinite(defenseRaw)) {
    throw new Error(
      `combat: the player's attrs carry no usable defense value (key "${defenseKey}") — seed the character table at startNewGame`,
    );
  }
  const defense = aggregateModifiers(defenseRaw, mental.get(defenseKey));
  const resource = primaryResourceOf(state, character, mental);
  const bands = () =>
    bandPairOf(registry.combatTiers, 0, resource.max, resource.current);

  // The player's dodge (D8): one roll for the WHOLE hand — a won roll lands
  // nothing, damage and any future effects sharing one fate (F2's law, this
  // side's symmetry). A zero-probability roll is skipped entirely so the
  // dice stream stands still for packs that fight without dodging.
  const dodgeRaw = state.attrs[character.strike.dodgeAttr];
  if (typeof dodgeRaw !== "number" || !Number.isFinite(dodgeRaw)) {
    throw new Error(
      `combat: the player's attrs carry no usable dodge stat (key "${character.strike.dodgeAttr}") — seed the character table at startNewGame (#58 D8)`,
    );
  }
  const dodgeChance = playerDodgeChance(
    aggregateModifiers(dodgeRaw, mental.get(character.strike.dodgeAttr)),
    readDodgeTuning(registry.settings),
  );
  if (dodgeChance > 0 && ports.rng.next() < dodgeChance) {
    ports.emit(state.id, strikeEvent({
      attackerId: npcId,
      defenderId: state.id,
      damage: 0,
      ...bands(),
      isDodge: true,
      isCrit: false,
      element: face.element,
      source: face.source,
    }));
    return;
  }

  const damage = strikeDamage(face.attack, defense, readDefenseK(registry.settings));
  // F6: one clamped write — the ceiling is the character table's own seed,
  // and a save above a revised ceiling heals itself here too.
  const hp = clampedHp(resource.current - damage, resource.max);
  state.attrs[character.primaryResource.current] = hp;
  ports.emit(state.id, strikeEvent({
    attackerId: npcId,
    defenderId: state.id,
    damage,
    ...bandPairOf(registry.combatTiers, damage, resource.max, hp),
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

/** The settle handler's wiring: the dice, the base chain the wheel falls back to. */
export interface CombatSettleOptions extends StrikeSpecOptions {
  /**
   * The BASE strike's effect chain (#58 D15): what a hand walks when the
   * wheel falls back — the strike command entry's own `effects`, the same
   * chain the typed opening hand walks. Martial hands walk their ENTRY's
   * chain instead; this is only the floor.
   */
  readonly baseEffects: readonly string[];
  /**
   * The session's dice (#57): a scheduled player hand rolls its dodge and
   * its effects' application chances exactly like a typed one, and the
   * settle callback carries no rng of its own — so the host hands in the
   * SAME stream the commands drew from (the one whose state the save
   * carries), at wiring time. Determinism survives: one stream, one order.
   * #58 D8: the npc hand rolls the player's dodge off the same stream.
   */
  readonly rng: Rng;
}

/**
 * The combat settle handler (#56 D4/D11, #57 D3/D6/C2-T4, #58 D4/D15/C3-T8):
 * ONE scheduler for one actor's whole fight over the span the settler hands
 * in — both sides' auto-hands and the poison's pulses advance on ONE
 * timeline, each due item settled in due-tick order (same tick: the player's
 * hand first, then the npc's, then the poison pulse — D9 plus the "poison is
 * state settlement" ordering half), every event stamped with its due tick.
 * #58: every rhythm hand is a WHEEL hand (selectStrikePlan — the assembly
 * order picks the martial, the fallback states carry the two-state ruling),
 * and the RESOURCE REGENERATION pass rides the same handler after the fight
 * (D4: one observation-time compensation settlement, in-combat and out
 * alike; C3-T8's ruling — the C2-T4 "one scheduler" precedent extended, the
 * settler's single entity slot never gains a second handler beside it).
 *
 * Why one scheduler and not a second handler beside the poison's: two
 * handlers emit in REGISTRATION order, not due-tick order — a span owing a
 * hand at 103 and pulses at 102/104 would read dotTick, dotTick, strike on
 * the wire. The interleave is the ticket's own wording (hands and pulses
 * advance interleaved BY due tick), and only one loop can keep it. The
 * regen pass rides the same law: its events are stamped at the span's END
 * (the moment this span's regeneration is complete through — C3-T8), which
 * is chronologically after every due item the loop settled, so the emission
 * order reads as the timeline does.
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
    if (state === undefined) {
      return;
    }
    // The fight half: nothing to advance without a session.
    if (state.combat !== undefined) {
      settleCombatHands(runtime, state, options, span, emit);
    }
    // The regeneration half (D4/D7): runs in-combat and out alike — a pack
    // without a character table has no declared resources and skips it (the
    // same tolerance the fight half keeps for table-less packs).
    const character = runtime.registry.character;
    if (character !== undefined) {
      regenResources(runtime, state, span, emit);
    }
  };
}

/** The fight half: the interleaved advance of hands and pulses over one span. */
function settleCombatHands(
  runtime: WorldRuntime,
  state: EntityState,
  options: CombatSettleOptions,
  span: SettleSpan,
  emit: (to: string, draft: SettleDraft) => void,
): void {
  const session = state.combat;
  if (session === undefined) {
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
    emit(state.id, {
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
      emit(state.id, {
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

  /** One player auto-hand: the WHEEL's plan, the blow's dice, ITS due tick. */
  const playerHand = (dueTick: number): void => {
    const plan: StrikePlan = selectStrikePlan(registry, state, options.baseEffects, dueTick);
    const ports: BlowPorts = {
      nowTick: dueTick,
      rng: options.rng,
      emit: (to, draft: EventDraft) => emit(to, withTick(draft, dueTick)),
    };
    playerBlow(runtime, state, session.targetNpcId, ports, plan, options);
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
    // Due-ticks order; same tick: the player's hand, then the npc's, then
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
        rng: options.rng,
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
}

/** The resource-regeneration event's extension-arm type (the host words it, D16②). */
export const RESOURCE_REGEN_EVENT = "resourceRegen";

/**
 * The RESOURCE REGENERATION pass (#58 D4/D7/C3-T8): the SAME
 * observation-time compensation settlement the poison rides, over the two
 * resource pairs the character table declares — the primary (its rate:
 * `settings.time.primaryRegenPerTick`) and, when the pack declares one, the
 * secondary (`settings.combat.internalForce.regenPerTick`). In-combat and
 * out alike, across offline spans too (ADR-0016's whitelist carries BOTH
 * members by its own words — this is the list's literal reading, not an
 * extension), capped at each pair's max key, one event per resource per
 * span carrying the exact amount. A zero delta (already full, or a zero
 * rate) emits nothing — regeneration nobody owed is not news.
 *
 * The event's `tick` is the span's END (C3-T8): continuous regeneration has
 * no discrete due tick to stamp, and the span's toTick is the moment this
 * span's regeneration is complete through — the caller runs this pass after
 * the fight half, so the emission order reads as the timeline does.
 */
export function regenResources(
  runtime: WorldRuntime,
  state: EntityState,
  span: SettleSpan,
  emit: (to: string, draft: SettleDraft) => void,
): void {
  const registry = runtime.registry;
  const character = requireCharacterTable(registry);
  const ticks = span.toTick - span.fromTick;
  if (ticks <= 0) {
    return;
  }
  const primaryRate = readPrimaryRegenPerTick(registry.settings);
  // #59 D11: both ceilings read the PIPELINED max (consumer points ④⑤) —
  // the cap is the mentals' widened ceiling, and an over-ceiling current
  // (a mental since unequipped) heals itself the F6 way: the cap binds at
  // the read, the stored value is never rewritten down.
  const mental = equippedMentalModifiers(registry, state);
  applyRegen(state, character.primaryResource.current, character.primaryResource.max, primaryRate, mental);
  if (character.secondaryResource !== undefined) {
    applyRegen(
      state,
      character.secondaryResource.current,
      character.secondaryResource.max,
      readInternalForceTuning(registry.settings).regenPerTick,
      mental,
    );
  }

  /** One resource's compensation: rate × span, capped at the max, announced when owed. */
  function applyRegen(
    entity: EntityState,
    currentKey: string,
    maxKey: string,
    rate: number,
    mental: ReadonlyMap<string, readonly Modifier[]>,
  ): void {
    const current = entity.attrs[currentKey];
    const maxRaw = entity.attrs[maxKey];
    if (
      typeof current !== "number" ||
      !Number.isFinite(current) ||
      typeof maxRaw !== "number" ||
      !Number.isFinite(maxRaw)
    ) {
      throw new Error(
        `combat: the player's attrs carry no usable resource pair (keys "${currentKey}"/"${maxKey}") — seed the character table at startNewGame`,
      );
    }
    const max = aggregateModifiers(maxRaw, mental.get(maxKey));
    if (rate <= 0 || current >= max) {
      return;
    }
    // Exact arithmetic: the attrs carry the true (possibly fractional)
    // value; the ceiling caps the top edge in the same write (the F6 clamp
    // family — the value never exceeds what the pair declares).
    const healed = Math.min(rate * ticks, max - current);
    entity.attrs[currentKey] = current + healed;
    emit(state.id, {
      ...customEvent(RESOURCE_REGEN_EVENT, {
        resource: currentKey,
        amount: healed,
        fromTick: span.fromTick,
        toTick: span.toTick,
      }),
      // The span's end — C3-T8's stamping ruling (see regenResources).
      tick: span.toTick,
    } as SettleDraft);
  }
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
