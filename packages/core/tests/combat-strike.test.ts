import { describe, expect, it } from "vitest";
import { createSettler } from "../src/time/settle.js";
import type { SettleRequest } from "../src/time/settle.js";
import type { Message } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence, testClockOver } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { MonsterRecord } from "../src/content/registry.js";
import type {
  CharacterTable,
  CombatTiersTable,
  SettingsTable,
} from "../src/content/config.js";
import type { CommandEntry } from "../src/command/entry.js";
import type { EffectEntry } from "../src/effects/entry.js";
import type { NpcEntry, RoomEntry } from "../src/world/entry.js";
import { createEntity } from "../src/world/entity.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";
import {
  createCombatSettleHandler,
  primaryResourceOf,
  resumeCombatSession,
  seedCharacterAttrs,
} from "../src/combat/session.js";
import { strikeSpec } from "../src/combat/strike.js";
import { createEffectPrimitiveRegistry } from "../src/effects/registry.js";
import { aggregateModifiers } from "../src/effects/modifiers.js";
import { resolveNpcTarget } from "../src/world/target.js";
import { createSeededRng } from "../src/rng.js";
import type { Rng, Snapshot } from "../src/types.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import { commandSetSources } from "../src/command/entry.js";

/**
 * The combat kernel's C2 tests (#57 over #56): the opening hand and the
 * rhythm it arms, the dodge roll's promotion to the orchestration level (a
 * dodged fist arms no poison), the auto-exchange the settle layer advances
 * (due-tick stamps, same-tick player-first, the death clears), the NPC's
 * formula hand (no more bare damage), the load-point restart, the poison's
 * unchanged compensation, and the save round-trip of everything including
 * the rhythm pair.
 *
 * The fixture is SYNTHETIC on purpose — a two-guard courtyard with pinned
 * numbers (attack 30, defense 6, K 10 ⇒ 19 damage; the guard's hand
 * 15 × (1 − 3/13) ⇒ 12; both intervals 2; poison 10×5 every 2 ticks at
 * 0.35; escape 0.5) — so every assertion reads arithmetic, not a pack's
 * tuning. The wuxia pack's own numbers are pinned end-to-end in apps/web's
 * combat tests.
 */

const SETTINGS: SettingsTable = { combat: { formula: "", defenseK: 10, escapeChance: 0.5 } };

const CHARACTER: CharacterTable = {
  attrs: { maxHp: 200, hp: 200, attack: 30, externalDefense: 3 },
  primaryResource: { current: "hp", max: "maxHp" },
  deathAtOrBelow: 0,
  strikeIntervalTicks: 2,
  strike: {
    attackAttr: "attack",
    defenseAttr: "externalDefense",
    element: "none",
    source: "external",
  },
};

const TIERS: CombatTiersTable = {
  damageBand: [
    { band: "light", min: 0, max: 0.08 },
    { band: "medium", min: 0.08, max: 0.2 },
    { band: "heavy", min: 0.2, max: 0.45 },
    { band: "nearDeath", min: 0.45, max: 1.01 },
  ],
  lifeBand: [
    { band: "critical", min: 0, max: 0.15 },
    { band: "low", min: 0.15, max: 0.4 },
    { band: "half", min: 0.4, max: 0.6 },
    { band: "high", min: 0.6, max: 0.85 },
    { band: "full", min: 0.85, max: 1.01 },
  ],
};

const ROOMS: RoomEntry[] = [
  {
    id: "room-start",
    name: "start",
    description: "start",
    enterText: "start",
    exits: [],
  },
  {
    id: "room-yard",
    name: "yard",
    description: "yard",
    enterText: "yard",
    exits: [],
    objects: [
      { id: "npc-guard", count: 1 },
      { id: "npc-boss", count: 1 },
      { id: "npc-keeper", count: 1 },
    ],
  },
];

const NPCS: NpcEntry[] = [
  {
    id: "npc-guard",
    name: "Guard",
    description: "guard",
    monsterId: "mon-guard",
  },
  { id: "npc-boss", name: "Boss", description: "boss", monsterId: "mon-boss" },
  { id: "npc-keeper", name: "Keeper", description: "keeper" },
];

const MONSTERS: MonsterRecord[] = [
  {
    id: "mon-guard",
    stats: { maxHp: 140, attack: 15, externalDefense: 6, dodge: 0.05, attackIntervalTicks: 2 },
    source: "external",
  },
  {
    // No attackIntervalTicks: the engine default (2) is the rhythm.
    id: "mon-boss",
    stats: { maxHp: 400, attack: 15, externalDefense: 6, dodge: 0 },
  },
];

const EFFECTS: EffectEntry[] = [
  { id: "eff-hit", primitives: [{ type: "instant-damage" }] },
  {
    id: "eff-poison",
    primitives: [
      { type: "damage-over-time", amount: 10, tickIntervalTicks: 2, maxPulses: 5, chance: 0.35 },
    ],
  },
];

const STRIKE: CommandEntry = {
  id: "cmd-strike",
  verbs: ["strike"],
  argForm: "target",
  cmdset: "character",
  priority: 0,
  effects: ["eff-hit", "eff-poison"],
};

/**
 * A dice script: the values `next()` answers, in order, then a tail. Every
 * roll the kernel makes (dodge, application chance) is therefore pinned per
 * assertion — the determinism AC's whole trick.
 */
function scriptedRng(values: readonly number[], tail = 0.999): Rng {
  let at = 0;
  return {
    next(): number {
      const value = at < values.length ? values[at]! : tail;
      at += 1;
      return value;
    },
    getState(): number {
      return 0;
    },
  };
}

interface Rig {
  runtime: WorldRuntime;
  call(
    raw: string,
    options?: { tick?: number; rng?: Rng },
  ): ReturnType<ReturnType<typeof createCommandHarness>["call"]>;
  /** One actor-bearing beat at a tick — the idle-fight's engine face. */
  beat(tick: number): Message[];
}

function rig(options: { seedAttrs?: boolean } = {}): Rig {
  const registry = createContentRegistry(
    { commands: [STRIKE], rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS },
    { settings: SETTINGS, character: CHARACTER, combatTiers: TIERS, world: { startRoomId: "room-start" } },
  );
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("player"), "room-yard");
  if (options.seedAttrs !== false) {
    seedCharacterAttrs(runtime.state.entities["player"]!, CHARACTER);
  }
  // ONE stream for the command channel and the settle layer alike (#57):
  // a scheduled hand rolls on the same dice the typed one did.
  let rng: Rng = scriptedRng([]);
  const stream: Rng = { next: () => rng.next(), getState: () => 0 };
  const settler = createSettler({
    state: runtime.state,
    clock: runtime.clock,
    entity: createCombatSettleHandler(runtime, { rng: stream, effects: STRIKE.effects ?? [] }),
  });
  const harness = createCommandHarness<WorldRuntime>({
    world: { live: runtime },
    receivers: ["player"],
    session: {
      clock: testClockOver(runtime.clock),
      rng: stream,
      settle: (request: SettleRequest) => settler.settleTo(request),
    },
    verbs: () => commandSetSources([STRIKE]),
  });
  const spec = strikeSpec(STRIKE);
  return {
    runtime,
    beat(tick) {
      return harness.beat({ tick, actorId: "player" });
    },
    call(raw, callOptions) {
      rng = callOptions?.rng ?? scriptedRng([]);
      return harness.call(spec, { raw, actorId: "player", tick: callOptions?.tick });
    },
  };
}

describe("the opening hand (#57 AC1)", () => {
  it("opens the fight: the first hand settles now, the rhythm arms, NO immediate retaliation", () => {
    const world = rig();
    // dodge roll 0.9 ≥ 0.05 (no dodge), chance roll 0.9 ≥ 0.35 (no poison).
    const out = world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.9]) });

    expect(out.result.ok).toBe(true);
    // 30 × (1 − 6/16) = 18.75 → 19; the guard's 140 HP read 121 (140−19),
    // a 0.864 life ratio → band "full"; the hit is 19/140 = 0.136 → "medium".
    expectMessageSequence(out.messages, [
      {
        to: "player",
        event: {
          type: "strike",
          attackerId: "player",
          defenderId: "npc-guard",
          damage: 19,
          damageRatio: "medium",
          defenderHpRatio: "full",
          isDodge: false,
          isCrit: false,
          element: "none",
          source: "external",
        },
      },
    ]);
    // The session the opening strike armed, BOTH rhythm fields from the
    // opening tick (D2/D10): the player's next hand and the guard's both
    // due at 102 — C1's immediate retaliation is retired.
    const session = world.runtime.state.entities["player"]!.combat!;
    expect(session.targetNpcId).toBe("npc-guard");
    expect(session.targetHp).toBe(121);
    expect(session.targetDead).toBe(false);
    expect(session.playerNextStrikeTick).toBe(102);
    expect(session.npcNextStrikeTick).toBe(102);
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(200);
  });

  it("leaves rank absent (the C1 placeholder — no martial arts yet)", () => {
    const world = rig();
    const out = world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.9]) });
    const strike = out.messages[0]!.event as Record<string, unknown>;
    expect("rank" in strike).toBe(false);
  });

  it("dodges at the ORCHESTRATION level: the whole blow misses, no poison arms (F2)", () => {
    const world = rig();
    // dodge roll 0.01 < 0.05 → dodged; the chain never runs, so the poison
    // chance never even rolls (one roll spent, not two).
    const out = world.call("strike Guard", { tick: 100, rng: scriptedRng([0.01]) });

    expectMessageSequence(out.messages, [
      { event: { type: "strike", damage: 0, isDodge: true, defenderHpRatio: "full" } },
    ]);
    const session = world.runtime.state.entities["player"]!.combat!;
    expect(session.targetHp).toBe(140);
    expect(session.dot).toBeUndefined();
  });

  it("replays identically under the same seed — the determinism pin (AC4)", () => {
    const first = rig();
    const second = rig();
    const rolls = [0.42, 0.2, 0.5, 0.5];
    const a = first.call("strike Guard", { tick: 100, rng: scriptedRng(rolls) });
    const b = second.call("strike Guard", { tick: 100, rng: scriptedRng(rolls) });
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(first.runtime.state.entities["player"]!.combat).toEqual(
      second.runtime.state.entities["player"]!.combat,
    );
  });

  it("refuses a nobody, a non-combatant, the same target mid-fight, and a switch (AC1/T3)", () => {
    const world = rig();
    // Nobody by that name.
    const ghost = world.call("strike Ghost", { tick: 100, rng: scriptedRng([0.9, 0.9]) });
    expect(ghost.result.ok).toBe(false);
    if (!ghost.result.ok && ghost.result.kind === "rejected") {
      expect(ghost.result.reason).toBe("notVisible");
    }
    // Present, but no monsterId.
    const keeper = world.call("strike Keeper", { tick: 100, rng: scriptedRng([0.9, 0.9]) });
    expect(keeper.result.ok).toBe(false);
    if (!keeper.result.ok && keeper.result.kind === "rejected") {
      expect(keeper.result.reason).toBe("notCombatant");
    }
    // Open the fight, then strike the SAME guard: the auto-exchange already
    // has the player's hands (D2 — `inCombat`, not the old corpse branch).
    world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.9]) });
    const again = world.call("strike Guard", { tick: 101, rng: scriptedRng([0.9]) });
    expect(again.result.ok).toBe(false);
    if (!again.result.ok && again.result.kind === "rejected") {
      expect(again.result.reason).toBe("inCombat");
    }
    // A different npc mid-fight: one fight at a time (T3).
    const switched = world.call("strike Boss", { tick: 102, rng: scriptedRng([0.9]) });
    expect(switched.result.ok).toBe(false);
    if (!switched.result.ok && switched.result.kind === "rejected") {
      expect(switched.result.reason).toBe("targetLocked");
    }
  });
});

describe("the rhythm advance (#57 AC2, the settle layer)", () => {
  it("settles both due hands at the next observation, player first, stamped with due ticks", () => {
    const world = rig();
    world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.9]) });

    // Beat at 103: both hands due at 102 (span [100, 103)), the player's
    // first (D9). Player hand: dodge 0.9, chance 0.9 → 19 more (121→102).
    // Guard hand: the FULL formula now — 15 × (1 − 3/13) = 11.54 → 12
    // (C2-D4; C1's bare 15 is retired with the immediate retaliation).
    const settled = world.beat(103);
    expect(settled.map((m) => [m.event.type, (m.event as Record<string, unknown>)["attackerId"], m.event.tick]))
      .toEqual([
        ["strike", "player", 102],
        ["strike", "npc-guard", 102],
      ]);
    expect(world.runtime.state.entities["player"]!.combat!.targetHp).toBe(102);
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(188);
    // Both nexts advanced past the observation point.
    expect(world.runtime.state.entities["player"]!.combat!.playerNextStrikeTick).toBe(104);
    expect(world.runtime.state.entities["player"]!.combat!.npcNextStrikeTick).toBe(104);
  });

  it("catches a whole span at once: hands and pulses interleaved in due-tick order", () => {
    const world = rig();
    // Open at 10 and arm the poison (chance 0.2 < 0.35).
    world.call("strike Guard", { tick: 10, rng: scriptedRng([0.9, 0.2]) });

    // Beat at 15: the span [10, 15) owes player hands at 12/14, guard hands
    // at 12/14, and poison pulses at 12/14 — one timeline, same tick reads
    // player → npc → poison (D9 + the two-laws ordering). The rig's
    // standing stream answers 0.999 from here: hands hit, no re-arm.
    const settled = world.beat(15);
    const rows = settled.map((m) => {
      const event = m.event as Record<string, unknown>;
      return [event["type"], event["attackerId"] ?? event["targetId"], m.event.tick];
    });
    expect(rows).toEqual([
      ["strike", "player", 12],
      ["strike", "npc-guard", 12],
      ["dotTick", "npc-guard", 12],
      ["strike", "player", 14],
      ["strike", "npc-guard", 14],
      ["dotTick", "npc-guard", 14],
    ]);
    // 140 − 19 (opening) − 19 − 10 (12) − 19 − 10 (14) = 63 on the guard;
    // 200 − 12 − 12 = 176 on the player.
    expect(world.runtime.state.entities["player"]!.combat!.targetHp).toBe(63);
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(176);
  });

  it("a killing player hand cancels the same-tick npc hand and pulses (D6/D9)", () => {
    const world = rig();
    // 19 HP left: the player's hand due at 12 kills outright, and the
    // guard's same-tick hand plus any pulse is void (D6/D9).
    world.runtime.state.entities["player"]!.combat = {
      targetNpcId: "npc-guard",
      targetHp: 19,
      targetDead: false,
      playerNextStrikeTick: 12,
      npcNextStrikeTick: 12,
    };

    const settled = world.beat(13);
    const types = settled.map((m) => m.event.type);
    expect(types).toEqual(["strike", "death"]);
    const death = settled[1]!.event as Record<string, unknown>;
    expect(death["deceasedId"]).toBe("npc-guard");
    expect(death["tick"]).toBe(12);
    // D6: the WHOLE session is gone — a fresh strike opens a new fight.
    expect(world.runtime.state.entities["player"]!.combat).toBeUndefined();
    // The guard's cancelled hand never wrote the player's HP.
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(200);
  });

  it("a fresh strike at the slain name opens a NEW fight at full HP (D6, AC6)", () => {
    const world = rig();
    // A C1-era save's dead session: the strike clears it on sight and the
    // command is an OPENER — the corpse-refusal branch the C1 tests pinned
    // is unreachable under D6.
    world.runtime.state.entities["player"]!.combat = {
      targetNpcId: "npc-guard",
      targetHp: 0,
      targetDead: true,
    };

    const out = world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.9]) });
    expectMessageSequence(out.messages, [
      { event: { type: "strike", damage: 19, defenderHpRatio: "full" } },
    ]);
    const fresh = world.runtime.state.entities["player"]!.combat!;
    expect(fresh.targetHp).toBe(121); // a brand-new 140-HP fight, 19 in.
    expect(fresh.playerNextStrikeTick).toBe(102);
    expect(fresh.targetDead).toBe(false);
  });

  it("the npc's formula hand can kill the player: announce, refill, clear, relocate (C1-T6 in the settle layer)", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    state.attrs["hp"] = 10;
    state.combat = {
      targetNpcId: "npc-guard",
      targetHp: 100,
      targetDead: false,
      playerNextStrikeTick: 12,
      npcNextStrikeTick: 12,
      dot: { effectId: "eff-poison", startTick: 10, applied: 1, perTick: 10 },
    };

    const settled = world.beat(13);
    const rows = settled.map((m) => m.event.type);
    // The player's 12-hand first (19 on the guard), then the guard's 12-hand
    // does 12 → −2 ≤ 0: dead. The same-tick poison pulse is cancelled with
    // the session (D6).
    expect(rows).toEqual(["strike", "strike", "death", "departed", "arrived"]);
    const death = settled[2]!.event as Record<string, unknown>;
    expect(death["kind"]).toBe("player");
    expect(state.attrs["hp"]).toBe(200);
    expect(state.combat).toBeUndefined();
    expect(world.runtime.locationOf("player")).toBe("room-start");
  });
});

describe("the load-point restart (#57 AC3/D3)", () => {
  it("resets an expired next-strike to now + interval and keeps a still-future one", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    // Expired: due at 30, the wall reads 1000 — the owed hands are void,
    // the next hand is 1002 (nothing settled in between).
    state.combat = {
      targetNpcId: "npc-guard",
      targetHp: 100,
      targetDead: false,
      playerNextStrikeTick: 30,
      npcNextStrikeTick: 30,
    };
    resumeCombatSession(world.runtime.state, world.runtime.registry, 1000);
    expect(state.combat!.playerNextStrikeTick).toBe(1002);
    expect(state.combat!.npcNextStrikeTick).toBe(1002);

    // Still future: due at 1005 — kept as-is (a short absence must not
    // push the next hand back).
    state.combat!.playerNextStrikeTick = 1005;
    state.combat!.npcNextStrikeTick = 1006;
    resumeCombatSession(world.runtime.state, world.runtime.registry, 1000);
    expect(state.combat!.playerNextStrikeTick).toBe(1005);
    expect(state.combat!.npcNextStrikeTick).toBe(1006);

    // A beat right after the restart settles NOTHING of the offline span
    // (the hands are 1002/1002, both past a 1001 observation).
    const settled = world.beat(1001);
    expect(settled).toEqual([]);
  });

  it("seeds a rhythm-less C1 session and clears a dead one", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    state.combat = { targetNpcId: "npc-guard", targetHp: 100, targetDead: false };
    resumeCombatSession(world.runtime.state, world.runtime.registry, 1000);
    expect(state.combat!.playerNextStrikeTick).toBe(1002);
    expect(state.combat!.npcNextStrikeTick).toBe(1002);

    state.combat = { targetNpcId: "npc-guard", targetHp: 0, targetDead: true };
    resumeCombatSession(world.runtime.state, world.runtime.registry, 1000);
    expect(state.combat).toBeUndefined();
  });

  it("the settle layer clears a dead C1 session at its first observation too", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    state.combat = { targetNpcId: "npc-guard", targetHp: 0, targetDead: true };
    const settled = world.beat(50);
    expect(settled).toEqual([]);
    expect(state.combat).toBeUndefined();
  });
});

describe("the poison (DoT, observation-time compensation — unchanged)", () => {
  it("arms on the roll and freezes perTick into the ledger (T11②)", () => {
    const world = rig();
    // dodge 0.9 (hit), chance 0.2 < 0.35 (armed).
    world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.2]) });
    expect(world.runtime.state.entities["player"]!.combat!.dot).toEqual({
      effectId: "eff-poison",
      startTick: 100,
      applied: 0,
      perTick: 10,
    });
  });

  it("does not re-arm an armed target — maxPulses caps ONE poisoning, not one strike", () => {
    const world = rig();
    world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.2]) });
    // A second opening-shaped strike whose chance roll would arm again: the
    // standing instance keeps its startTick and its pulse count.
    const state = world.runtime.state.entities["player"]!;
    const before = state.combat!.dot!.applied;
    world.beat(105); // pulses 102 and 104 land on the rig's standing stream
    expect(state.combat!.dot!.startTick).toBe(100);
    expect(state.combat!.dot!.applied).toBe(before + 2);
  });

  it("catches an offline span in one settlement — capped at maxPulses, then cleared (D4/T11④)", () => {
    const world = rig();
    world.call("strike Guard", { tick: 10, rng: scriptedRng([0.9, 0.2]) });
    // The load path ran first (the ONLY way a span this large owes no
    // hands): the restart pushed both nexts past the wall, the poison —
    // state settlement, the other law — lands its whole remaining lifetime.
    resumeCombatSession(world.runtime.state, world.runtime.registry, 10_010);
    const settled = world.beat(10_010);
    const dots = settled.map((m) => m.event as Record<string, unknown>).filter((e) => e["type"] === "dotTick");
    expect(dots).toHaveLength(5);
    expect(dots.map((event) => event.tick)).toEqual([12, 14, 16, 18, 20]);
    expect(world.runtime.state.entities["player"]!.combat!.dot).toBeUndefined();
    // The player's HP never moved: no hands settled across the span.
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(200);
  });

  it("stops mid-pile at a kill — the session clears with the ledger (T8/D6)", () => {
    const world = rig();
    // 21 HP, a fresh pile: pulses 1 (−10 → 11) and 2 (−10 → 1) land, pulse
    // 3 kills mid-pile; the hands are parked far out so the pile is the
    // only thing settling.
    world.runtime.state.entities["player"]!.combat = {
      targetNpcId: "npc-guard",
      targetHp: 21,
      targetDead: false,
      playerNextStrikeTick: 100,
      npcNextStrikeTick: 100,
      dot: { effectId: "eff-poison", startTick: 0, applied: 0, perTick: 10 },
    };

    const settled = world.beat(6);
    const events = settled.map((m) => m.event as Record<string, unknown>);
    const dots = events.filter((e) => e["type"] === "dotTick");
    const deaths = events.filter((e) => e["type"] === "death");
    expect(dots).toHaveLength(3);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]!).toMatchObject({ deceasedId: "npc-guard", kind: "npc", cause: "dot", tick: 6 });
    // D6: dead clears the WHOLE session — the ledger went with it.
    expect(world.runtime.state.entities["player"]!.combat).toBeUndefined();
  });
});

describe("the F6 clamp (#57 AC11)", () => {
  it("heals an over-ceiling HP on the next settlement — the npc side", () => {
    const world = rig();
    // A save's 300 HP against a content-revised 140 ceiling: the first
    // settlement writes min(300 − 19, 140) = 140.
    world.runtime.state.entities["player"]!.combat = {
      targetNpcId: "npc-guard",
      targetHp: 300,
      targetDead: false,
      playerNextStrikeTick: 12,
      npcNextStrikeTick: 200,
    };
    world.beat(13);
    expect(world.runtime.state.entities["player"]!.combat!.targetHp).toBe(140);
  });

  it("heals an over-ceiling HP on the next settlement — the player side", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    state.combat = {
      targetNpcId: "npc-guard",
      targetHp: 100,
      targetDead: false,
      playerNextStrikeTick: 12,
      npcNextStrikeTick: 12,
    };
    state.attrs["maxHp"] = 100; // content revised the ceiling downward
    world.beat(13); // the guard's 12-hand lands: min(200 − 12, 100) = 100
    expect(state.attrs["hp"]).toBe(100);
  });
});

describe("the save round-trip (attrs + combat + rhythm pair + poison ledger)", () => {
  const roundTrip = (runtime: WorldRuntime): Snapshot =>
    JSON.parse(JSON.stringify(serializeWorld(runtime.state, { nowTick: 50, rngState: 7, due: [] }))) as Snapshot;

  it("persists the session mid-poison with BOTH rhythm fields and resumes on the entry's terms", () => {
    const world = rig();
    world.call("strike Guard", { tick: 10, rng: scriptedRng([0.9, 0.2]) });

    const restored = restoreWorld(roundTrip(world.runtime));
    const session = restored.state.entities["player"]!.combat!;
    expect(session.targetNpcId).toBe("npc-guard");
    expect(session.playerNextStrikeTick).toBe(12);
    expect(session.npcNextStrikeTick).toBe(12);
    expect(session.dot).toEqual({ effectId: "eff-poison", startTick: 10, applied: 0, perTick: 10 });
    // The attrs ride whole.
    expect(restored.state.entities["player"]!.attrs["hp"]).toBe(200);
    expect(restored.state.entities["player"]!.attrs["attack"]).toBe(30);
  });

  it("canonicalizes attrs keys ascending — same world, same bytes", () => {
    const world = rig();
    const attrs = world.runtime.state.entities["player"]!.attrs;
    attrs["zeal"] = 1;
    attrs["armor"] = 2;
    const snapshot = serializeWorld(world.runtime.state, { nowTick: 0, rngState: 0, due: [] });
    const saved = snapshot.data.entities["player"]!.attrs as Record<string, number>;
    expect(Object.keys(saved)).toEqual([
      "armor",
      "attack",
      "externalDefense",
      "hp",
      "maxHp",
      "zeal",
    ]);
  });

  it("tolerates absence and refuses malformation on the slots (#40 discipline, D13)", () => {
    // Absent attrs and combat: the pre-#56 save reads empty and fightless.
    const bare = restoreWorld({
      version: 2,
      data: { entities: { p: { id: "p", locationId: "room-start", flags: [] } } },
    });
    expect(bare.state.entities["p"]!.attrs).toEqual({});
    expect(bare.state.entities["p"]!.combat).toBeUndefined();

    // Malformed attrs: present but not a map of finite numbers.
    expect(() =>
      restoreWorld({
        version: 2,
        data: { entities: { p: { id: "p", locationId: "room-start", flags: [], attrs: { hp: "x" } } } },
      }),
    ).toThrow(/attrs/);
    // Malformed combat: a session is a claim about a fight.
    expect(() =>
      restoreWorld({
        version: 2,
        data: {
          entities: {
            p: { id: "p", locationId: "room-start", flags: [], combat: { targetNpcId: 5 } },
          },
        },
      }),
    ).toThrow(/combat|targetNpcId/);
    // Malformed ledger: applied must be a non-negative integer.
    expect(() =>
      restoreWorld({
        version: 2,
        data: {
          entities: {
            p: {
              id: "p",
              locationId: "room-start",
              flags: [],
              combat: {
                targetNpcId: "npc-guard",
                targetHp: 10,
                targetDead: false,
                dot: { effectId: "eff-poison", startTick: 0, applied: -1, perTick: 10 },
              },
            },
          },
        },
      }),
    ).toThrow(/applied/);
    // Malformed rhythm: the pair travels together or not at all (D13).
    expect(() =>
      restoreWorld({
        version: 2,
        data: {
          entities: {
            p: {
              id: "p",
              locationId: "room-start",
              flags: [],
              combat: {
                targetNpcId: "npc-guard",
                targetHp: 10,
                targetDead: false,
                playerNextStrikeTick: 12,
              },
            },
          },
        },
      }),
    ).toThrow(/playerNextStrikeTick\/npcNextStrikeTick/);
    // A rhythm-less C1 session is NOT malformation — absence is the seed
    // path's reading (the compatibility red line ⑥).
    const c1Save = restoreWorld({
      version: 2,
      data: {
        entities: {
          p: {
            id: "p",
            locationId: "room-start",
            flags: [],
            combat: { targetNpcId: "npc-guard", targetHp: 10, targetDead: false },
          },
        },
      },
    });
    expect(c1Save.state.entities["p"]!.combat!.targetHp).toBe(10);
  });
});

describe("the effect contract (#56 AC3/AC8)", () => {
  it("registers primitive implementations by type id; a duplicate name fails loudly", () => {
    const handler = () => {};
    expect(() =>
      createEffectPrimitiveRegistry([
        ["instant-damage", handler],
        ["instant-damage", handler],
      ]),
    ).toThrow(/registered twice/);
    expect(() => createEffectPrimitiveRegistry([["", handler]])).toThrow(/empty type id/);
  });

  it("aggregates through the minimal core — the empty degenerate form answers the base (T9)", () => {
    expect(aggregateModifiers(30)).toBe(30);
    expect(aggregateModifiers(30, [])).toBe(30);
    // The two-layer shape itself (C4 fills the lists; the arithmetic is pinned now).
    expect(aggregateModifiers(10, [{ kind: "flat", value: 5 }, { kind: "percent", value: 0.2 }])).toBe(18);
    expect(aggregateModifiers(10, [{ kind: "flat", value: -40 }])).toBe(0);
  });
});

describe("target resolution (ADR-0028 §2's reserved seat)", () => {
  const registry = createContentRegistry(
    { commands: [STRIKE], rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS },
    { character: CHARACTER, combatTiers: TIERS, settings: SETTINGS, world: { startRoomId: "room-start" } },
  );

  it("resolves by name over the room's static presence, and names its failures", () => {
    expect(resolveNpcTarget(registry, "room-yard", { noun: "Guard", ordinal: 1 })).toEqual({
      ok: true,
      npc: NPCS[0],
    });
    expect(resolveNpcTarget(registry, "room-yard", { noun: "Keeper", ordinal: 1 })).toEqual({
      ok: false,
      reason: "notCombatant",
    });
    expect(resolveNpcTarget(registry, "room-yard", { noun: "Ghost", ordinal: 1 })).toEqual({
      ok: false,
      reason: "noMatch",
    });
    // An out-of-range ordinal over real placements is a miss, not an error.
    expect(resolveNpcTarget(registry, "room-yard", { noun: "Guard", ordinal: 2 })).toEqual({
      ok: false,
      reason: "noMatch",
    });
    // A room with no placements matches nobody.
    expect(resolveNpcTarget(registry, "room-start", { noun: "Guard", ordinal: 1 })).toEqual({
      ok: false,
      reason: "noMatch",
    });
  });
});

describe("the character model's seeds and reads (#56 T4, #57 D12)", () => {
  it("seeds the declared keys over the fresh attrs slot (AC2)", () => {
    const world = rig({ seedAttrs: false });
    expect(world.runtime.state.entities["player"]!.attrs).toEqual({});
    seedCharacterAttrs(world.runtime.state.entities["player"]!, CHARACTER);
    expect(world.runtime.state.entities["player"]!.attrs).toEqual(CHARACTER.attrs);
  });

  it("reads the primary resource loudly when the attrs were never seeded", () => {
    const world = rig({ seedAttrs: false });
    expect(() =>
      primaryResourceOf(world.runtime.state.entities["player"]!, CHARACTER),
    ).toThrow(/primary resource/);
  });

  it("answers the attrs condition facet — the slot's first gate consumer", () => {
    const world = rig();
    const subject = world.runtime.subjectOf("player");
    expect(subject.attr("attack")).toBe(30);
    expect(subject.attr("nonexistent")).toBeUndefined();
  });
});

describe("the dice port stays honest", () => {
  it("the same scripted rolls through the REAL seeded stream replay (AC4's engine-side half)", () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const rollsA = Array.from({ length: 5 }, () => a.next());
    const rollsB = Array.from({ length: 5 }, () => b.next());
    expect(rollsA).toEqual(rollsB);
    expect(a.getState()).toBe(b.getState());
  });
});
