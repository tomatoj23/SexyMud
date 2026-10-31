import { describe, expect, it } from "vitest";
import { createSettler } from "../src/time/settle.js";
import type { SettleRequest } from "../src/time/settle.js";
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
import { createDotSettleHandler, primaryResourceOf, seedCharacterAttrs } from "../src/combat/session.js";
import { strikeSpec } from "../src/combat/strike.js";
import { createEffectPrimitiveRegistry } from "../src/effects/registry.js";
import { aggregateModifiers } from "../src/effects/modifiers.js";
import { resolveNpcTarget } from "../src/world/target.js";
import { createSeededRng } from "../src/rng.js";
import type { Rng, Snapshot } from "../src/types.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import { commandSetSources } from "../src/command/entry.js";

/**
 * The combat kernel's tests (#56): the strike formula, the dodge roll's
 * determinism, the retaliation, both deaths, the session's discipline
 * (switch refusal, corpse refusal), the poison's observation-time
 * compensation (cross-command, offline, due-tick stamping, pulse ceiling,
 * mid-pile kill) and the save round-trip of everything the kernel writes.
 *
 * The fixture is SYNTHETIC on purpose — a two-guard courtyard with pinned
 * numbers (attack 30, defense 6, K 10 ⇒ 19 damage; retaliation 15; poison
 * 10×5 every 2 ticks at 0.35) — so every assertion reads arithmetic, not a
 * pack's tuning. The wuxia pack's own numbers are pinned end-to-end in
 * apps/web's combat test.
 */

const SETTINGS: SettingsTable = { combat: { formula: "", defenseK: 10 } };

const CHARACTER: CharacterTable = {
  attrs: { maxHp: 200, hp: 200, attack: 30, externalDefense: 3 },
  primaryResource: { current: "hp", max: "maxHp" },
  deathAtOrBelow: 0,
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
    stats: { maxHp: 140, attack: 15, externalDefense: 6, dodge: 0.05 },
    source: "external",
  },
  {
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
  const settler = createSettler({
    state: runtime.state,
    clock: runtime.clock,
    entity: createDotSettleHandler(runtime),
  });
  let rng: Rng = scriptedRng([]);
  const harness = createCommandHarness<WorldRuntime>({
    world: { live: runtime },
    receivers: ["player"],
    session: {
      clock: testClockOver(runtime.clock),
      rng: { next: () => rng.next(), getState: () => 0 },
      settle: (request: SettleRequest) => settler.settleTo(request),
    },
    verbs: () => commandSetSources([STRIKE]),
  });
  const spec = strikeSpec(STRIKE);
  return {
    runtime,
    call(raw, callOptions) {
      rng = callOptions?.rng ?? scriptedRng([]);
      return harness.call(spec, { raw, actorId: "player", tick: callOptions?.tick });
    },
  };
}

describe("the strike kernel (#56)", () => {
  it("lands the formula: max(1, round(attack × (1 − defense/(defense+K)))) with bands and no crit", () => {
    const world = rig();
    // dodge roll 0.9 ≥ 0.05 (no dodge), chance roll 0.9 ≥ 0.35 (no poison).
    const out = world.call("strike Guard", { rng: scriptedRng([0.9, 0.9]) });

    expect(out.result.ok).toBe(true);
    // 30 × (1 − 6/16) = 18.75 → 19; the guard's 140 HP read 121 (140−19),
    // a 0.864 life ratio → band "full" (≥0.85); the hit is 19/140 = 0.136 → "medium".
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
      {
        to: "player",
        event: {
          type: "strike",
          attackerId: "npc-guard",
          defenderId: "player",
          damage: 15,
          isDodge: false,
        },
      },
    ]);
    // The session the first strike opened, and the retaliation's write.
    const session = world.runtime.state.entities["player"]!.combat!;
    expect(session.targetNpcId).toBe("npc-guard");
    expect(session.targetHp).toBe(121);
    expect(session.targetDead).toBe(false);
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(185);
  });

  it("leaves rank absent (the C1 placeholder — no martial arts yet)", () => {
    const world = rig();
    const out = world.call("strike Guard", { rng: scriptedRng([0.9, 0.9]) });
    const strike = out.messages[0]!.event as Record<string, unknown>;
    expect("rank" in strike).toBe(false);
  });

  it("dodges on the roll: 0 damage, no HP write, the retaliation unchanged", () => {
    const world = rig();
    // dodge roll 0.01 < 0.05 → dodged; the poison chance still rolls (and misses).
    const out = world.call("strike Guard", { rng: scriptedRng([0.01, 0.9]) });

    expectMessageSequence(out.messages, [
      {
        event: { type: "strike", damage: 0, isDodge: true, defenderHpRatio: "full" },
      },
      { event: { type: "strike", attackerId: "npc-guard", damage: 15 } },
    ]);
    expect(world.runtime.state.entities["player"]!.combat!.targetHp).toBe(140);
  });

  it("replays identically under the same seed — the determinism pin (AC4)", () => {
    const first = rig();
    const second = rig();
    const rolls = [0.42, 0.2, 0.5, 0.5];
    const a = first.call("strike Guard", { rng: scriptedRng(rolls) });
    const b = second.call("strike Guard", { rng: scriptedRng(rolls) });
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(first.runtime.state.entities["player"]!.combat).toEqual(
      second.runtime.state.entities["player"]!.combat,
    );
  });

  it("refuses a nobody, a non-combatant and a target switch — the three checks plus T3", () => {
    const world = rig();
    // Nobody by that name.
    const ghost = world.call("strike Ghost", { rng: scriptedRng([0.9, 0.9]) });
    expect(ghost.result.ok).toBe(false);
    if (!ghost.result.ok && ghost.result.kind === "rejected") {
      expect(ghost.result.reason).toBe("notVisible");
    }
    // Present, but no monsterId.
    const keeper = world.call("strike Keeper", { rng: scriptedRng([0.9, 0.9]) });
    expect(keeper.result.ok).toBe(false);
    if (!keeper.result.ok && keeper.result.kind === "rejected") {
      expect(keeper.result.reason).toBe("notCombatant");
    }
    // A live session against the guard: striking the BOSS is a switch (T3).
    world.call("strike Guard", { rng: scriptedRng([0.9, 0.9]) });
    const switched = world.call("strike Boss", { rng: scriptedRng([0.9, 0.9]) });
    expect(switched.result.ok).toBe(false);
    if (!switched.result.ok && switched.result.kind === "rejected") {
      expect(switched.result.reason).toBe("targetLocked");
    }
  });

  it("kills the npc, marks the corpse and refuses the next strike (D7)", () => {
    const world = rig();
    const session = { targetNpcId: "npc-guard", targetHp: 19, targetDead: false };
    world.runtime.state.entities["player"]!.combat = session;

    const out = world.call("strike Guard", { rng: scriptedRng([0.9, 0.9]) });
    expectMessageSequence(out.messages, [
      { event: { type: "strike", damage: 19 } },
      { event: { type: "death", deceasedId: "npc-guard", kind: "npc", cause: "strike" } },
    ]);
    // Dead: no retaliation, the mark stands.
    expect(session.targetDead).toBe(true);
    const again = world.call("strike Guard", { rng: scriptedRng([0.9, 0.9]) });
    expect(again.result.ok).toBe(false);
    if (!again.result.ok && again.result.kind === "rejected") {
      expect(again.result.reason).toBe("targetDead");
    }
  });

  it("kills the player: announce, refill, relocate, clear the WHOLE session (T6)", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    state.attrs["hp"] = 10;
    state.combat = { targetNpcId: "npc-guard", targetHp: 100, targetDead: false, dot: { effectId: "eff-poison", startTick: 4, applied: 1, perTick: 10 } };

    const out = world.call("strike Guard", { rng: scriptedRng([0.9, 0.9]) });
    const types = out.messages.map((message) => message.event.type);
    // The strike lands, the retaliation kills, the death announces, and the
    // relocation rides the movement announcements.
    expect(types).toEqual(["strike", "strike", "death", "departed", "arrived"]);
    const death = out.messages[2]!.event as Record<string, unknown>;
    expect(death["kind"]).toBe("player");
    expect(death["deceasedId"]).toBe("player");
    expect(state.attrs["hp"]).toBe(200);
    expect(state.combat).toBeUndefined();
    expect(world.runtime.locationOf("player")).toBe("room-start");
  });
});

describe("the poison (DoT, observation-time compensation)", () => {
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
    // A second strike whose chance roll would arm again: the standing
    // instance keeps its startTick and its pulse count — a re-application
    // neither resets nor refreshes (the implementation-batch ruling on
    // D4's "at most maxPulses hops").
    world.call("strike Guard", { tick: 104, rng: scriptedRng([0.9, 0.01]) });
    const dot = world.runtime.state.entities["player"]!.combat!.dot!;
    expect(dot.startTick).toBe(100);
    expect(dot.applied).toBe(2); // pulses 102 and 104 of the FIRST arming.
  });

  it("settles across commands: pulses due, stamped with their DUE tick, never the catch-up", () => {
    const world = rig();
    world.call("strike Guard", { tick: 100, rng: scriptedRng([0.9, 0.2]) });
    // Next command at tick 105: floor((105−100)/2) = 2 pulses due (102, 104).
    const out = world.call("strike Guard", { tick: 105, rng: scriptedRng([0.9, 0.9]) });

    const ticks = out.messages.map((m) => m.event as Record<string, unknown>);
    const dots = ticks.filter((event) => event["type"] === "dotTick");
    expect(dots).toHaveLength(2);
    expect(dots[0]!.tick).toBe(102);
    expect(dots[1]!.tick).toBe(104);
    expect(dots[0]!).toMatchObject({ effectId: "eff-poison", targetId: "npc-guard", damage: 10, pulsesApplied: 1, pulsesTotal: 5 });
    // Settlement rides BEFORE the command's own events (ADR-0034 §4).
    expect(ticks[0]!["type"]).toBe("dotTick");
    // The settlement runs first (−20 for the two pulses), then this strike
    // (−19): 140 − 19 (the arming strike) − 20 − 19 = 82.
    expect(world.runtime.state.entities["player"]!.combat!.targetHp).toBe(82);
    expect(world.runtime.state.entities["player"]!.combat!.dot!.applied).toBe(2);
  });

  it("catches an offline span in one settlement — cross-offline parity (D4)", () => {
    const world = rig();
    world.call("strike Guard", { tick: 10, rng: scriptedRng([0.9, 0.2]) });
    // Ten thousand ticks away: 5 pulses all due (capped at maxPulses), then
    // the ledger is CLEARED (T11④ — interval × maxPulses is the lifetime).
    const out = world.call("strike Guard", { tick: 10_010, rng: scriptedRng([0.9, 0.9]) });
    const dots = out.messages.map((m) => m.event as Record<string, unknown>).filter((e) => e["type"] === "dotTick");
    expect(dots).toHaveLength(5);
    expect(dots.map((event) => event.tick)).toEqual([12, 14, 16, 18, 20]);
    expect(world.runtime.state.entities["player"]!.combat!.dot).toBeUndefined();
  });

  it("stops mid-pile at a kill — the remaining pulses are void (T8)", () => {
    const world = rig();
    // 30 HP left: the arming strike does 19 → 11 left; pulse 1 (−10) leaves 1,
    // pulse 2 kills mid-pile.
    world.runtime.state.entities["player"]!.combat = {
      targetNpcId: "npc-guard",
      targetHp: 30,
      targetDead: false,
    };
    world.call("strike Guard", { tick: 0, rng: scriptedRng([0.9, 0.2]) });
    const out = world.call("strike Guard", { tick: 6, rng: scriptedRng([0.9, 0.9]) });

    const events = out.messages.map((m) => m.event as Record<string, unknown>);
    const dots = events.filter((e) => e["type"] === "dotTick");
    const deaths = events.filter((e) => e["type"] === "death");
    expect(dots).toHaveLength(2);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]!).toMatchObject({ deceasedId: "npc-guard", kind: "npc", cause: "dot" });
    // 30 − 19 (strike) − 10 − 10 = −9: dead, and pulse 3 never fired.
    expect(world.runtime.state.entities["player"]!.combat!.targetDead).toBe(true);
    // The strike itself never ran its own arm — the corpse refusal answered.
  });
});

describe("the save round-trip (attrs + combat + poison ledger)", () => {
  const roundTrip = (runtime: WorldRuntime): Snapshot =>
    JSON.parse(JSON.stringify(serializeWorld(runtime.state, { nowTick: 50, rngState: 7, due: [] }))) as Snapshot;

  it("persists the session mid-poison and resumes on the entry's terms (effectId look-back)", () => {
    const world = rig();
    world.call("strike Guard", { tick: 10, rng: scriptedRng([0.9, 0.2]) });
    world.call("strike Guard", { tick: 14, rng: scriptedRng([0.9, 0.9]) }); // pulses 12 and 14 both due.

    const restored = restoreWorld(roundTrip(world.runtime));
    const session = restored.state.entities["player"]!.combat!;
    expect(session.targetNpcId).toBe("npc-guard");
    expect(session.dot).toEqual({ effectId: "eff-poison", startTick: 10, applied: 2, perTick: 10 });
    // The attrs ride whole.
    expect(restored.state.entities["player"]!.attrs["hp"]).toBeLessThan(200);
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

  it("tolerates absence and refuses malformation on both new slots (#40 discipline)", () => {
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

describe("the character model's seeds and reads (#56 T4)", () => {
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
