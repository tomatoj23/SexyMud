import { describe, expect, it } from "vitest";
import { createSettler } from "../src/time/settle.js";
import type { SettleRequest } from "../src/time/settle.js";
import type { Message } from "../src/command/pipeline.js";
import { createCommandHarness, testClockOver } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { MartialEntry, MonsterRecord } from "../src/content/registry.js";
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
  npcStrike,
  primaryResourceOf,
  regenResources,
  seedCharacterAttrs,
} from "../src/combat/session.js";
import { strikeSpec } from "../src/combat/strike.js";
import {
  equipSpec,
  unequipSpec,
  MENTAL_EQUIPPED_EVENT,
  MENTAL_SLOT_CAP,
  MENTAL_UNEQUIPPED_EVENT,
} from "../src/combat/equip.js";
import { guardNotInCombat } from "../src/combat/guard.js";
import {
  equippedMentalModifiers,
  slotKindOf,
  validateEquippedMentals,
} from "../src/combat/mental.js";
import { validateEquippedMartials } from "../src/combat/martial.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import { commandSetSources } from "../src/command/entry.js";
import type { Rng } from "../src/types.js";

/**
 * The mental half's own tests (#59): the modifier pipeline's first real
 * members (flat and percent, constructed off equipped mentals and grouped by
 * stat), the five consumer reads that walk the pipe (attack, defense, dodge,
 * maxHp, maxInternalForce), the mental slot's save shape (unfilled absence,
 * ascending canonical order, load-point validation), and the ONE equip verb
 * routing both kinds to their own slots and caps.
 *
 * The fixture is SYNTHETIC on purpose — pinned numbers so every assertion
 * reads arithmetic: attack 30, defenseK 10, monster defense 6 ⇒ the basic
 * hand's 19, the flat's 22, both layers' 24; the guard's attack 15 against
 * the player's defense 3 ⇒ 12, the defense flat's 8.
 */

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
    id: "room-yard",
    name: "yard",
    description: "yard",
    enterText: "yard",
    exits: [],
    objects: [{ id: "npc-guard", count: 1 }],
  },
];

const NPCS: NpcEntry[] = [
  { id: "npc-guard", name: "Guard", description: "guard", monsterId: "mon-guard" },
];

const MONSTERS: MonsterRecord[] = [
  {
    id: "mon-guard",
    stats: {
      maxHp: 1000,
      attack: 15,
      externalDefense: 6,
      internalDefense: 0,
      dodge: 0,
      attackIntervalTicks: 2,
    },
    source: "external",
  },
];

const EFFECTS: EffectEntry[] = [{ id: "eff-hit", primitives: [{ type: "instant-damage" }] }];

const MARTIALS: MartialEntry[] = [
  {
    id: "mrt-a-001",
    kind: "technique",
    name: "Alpha",
    tier: 1,
    source: "external",
    element: "none",
    cost: 5,
    attackMultiplier: 1.2,
    effects: ["eff-hit"],
  },
];

/** The mental fixture set: one member per stat the five consumers read. */
const MENTALS: MartialEntry[] = [
  {
    id: "mnt-x-001",
    kind: "mental",
    name: "FlatMind",
    tier: 1,
    modifiers: [{ stat: "attack", flat: 5 }],
  },
  {
    id: "mnt-x-002",
    kind: "mental",
    name: "PercentMind",
    tier: 2,
    modifiers: [{ stat: "attack", percent: 0.1 }],
  },
  {
    id: "mnt-x-003",
    kind: "mental",
    name: "BodyMind",
    tier: 1,
    modifiers: [{ stat: "maxHp", flat: 100 }],
  },
  {
    id: "mnt-x-004",
    kind: "mental",
    name: "BreathMind",
    tier: 1,
    modifiers: [{ stat: "maxInternalForce", flat: 20 }],
  },
  {
    id: "mnt-x-005",
    kind: "mental",
    name: "ShellMind",
    tier: 1,
    modifiers: [{ stat: "externalDefense", flat: 5 }],
  },
  {
    id: "mnt-x-006",
    kind: "mental",
    name: "WindMind",
    tier: 1,
    modifiers: [{ stat: "dodge", flat: 5 }],
  },
];

const STRIKE: CommandEntry = {
  id: "cmd-strike",
  verbs: ["strike"],
  argForm: "target",
  cmdset: "character",
  priority: 0,
  effects: ["eff-hit"],
};
const EQUIP: CommandEntry = {
  id: "cmd-equip",
  verbs: ["equip"],
  argForm: "text",
  cmdset: "character",
  priority: 0,
  notInCombat: true,
};
const UNEQUIP: CommandEntry = {
  id: "cmd-unequip",
  verbs: ["unequip"],
  argForm: "text",
  cmdset: "character",
  priority: 0,
  notInCombat: true,
};

const COMMANDS = [STRIKE, EQUIP, UNEQUIP];

const CHARACTER: CharacterTable = {
  attrs: {
    maxHp: 200,
    hp: 200,
    attack: 30,
    externalDefense: 3,
    internalDefense: 3,
    dodge: 10,
    internalForce: 40,
    maxInternalForce: 40,
  },
  primaryResource: { current: "hp", max: "maxHp" },
  secondaryResource: { current: "internalForce", max: "maxInternalForce" },
  deathAtOrBelow: 0,
  strikeIntervalTicks: 2,
  martial: { known: MARTIALS.map((entry) => entry.id), initialEquipped: [] },
  mental: { known: MENTALS.map((entry) => entry.id), initialEquipped: [] },
  strike: {
    attackAttr: "attack",
    defenseAttrs: { external: "externalDefense", internal: "internalDefense" },
    dodgeAttr: "dodge",
    element: "none",
    source: "external",
  },
};

/** dodge base b + k 90 + stat 10 ⇒ P = b + 10/100; the 0.999 tail never dodges. */
function settingsOf(dodgeBase: number, primaryRegenPerTick = 0): SettingsTable {
  return {
    combat: {
      formula: "",
      defenseK: 10,
      escapeChance: 0.5,
      dodge: { base: dodgeBase, cap: 0.9, k: 90 },
      internalForce: { regenPerTick: 1, zeroCostAttackRatio: 0.5 },
    },
    time: { primaryRegenPerTick },
  };
}

/** A dice script: the values `next()` answers, in order, then a tail. */
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
  call(raw: string, options?: { tick?: number; rng?: Rng }): ReturnType<ReturnType<typeof createCommandHarness>["call"]>;
  beat(tick: number): Message[];
  openFight(tick?: number, rng?: Rng): void;
}

function rig(options: { settings?: SettingsTable; mental?: readonly string[] } = {}): Rig {
  const registry = createContentRegistry(
    { commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS, martials: [...MARTIALS, ...MENTALS] },
    {
      settings: options.settings ?? settingsOf(0),
      character: CHARACTER,
      combatTiers: TIERS,
      dimensions: {
        source: ["external", "internal"],
        element: ["none", "wood"],
        damageBand: ["light", "medium", "heavy", "nearDeath"],
        lifeBand: ["critical", "low", "half", "high", "full"],
      },
    },
  );
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("player"), "room-yard");
  seedCharacterAttrs(runtime.state.entities["player"]!, CHARACTER);
  if (options.mental !== undefined && options.mental.length > 0) {
    runtime.state.entities["player"]!.mental = [...options.mental];
  }
  let rng: Rng = scriptedRng([]);
  const stream: Rng = { next: () => rng.next(), getState: () => 0 };
  const settler = createSettler({
    state: runtime.state,
    clock: runtime.clock,
    entity: createCombatSettleHandler(runtime, {
      rng: stream,
      baseEffects: STRIKE.effects ?? [],
    }),
  });
  const harness = createCommandHarness<WorldRuntime>({
    world: { live: runtime },
    receivers: ["player"],
    session: {
      clock: testClockOver(runtime.clock),
      rng: stream,
      settle: (request: SettleRequest) => settler.settleTo(request),
    },
    verbs: () => commandSetSources(COMMANDS),
  });
  const bindings = new Map(
    COMMANDS.map((entry) => {
      const spec =
        entry === STRIKE ? strikeSpec(entry)
          : entry === EQUIP ? guardNotInCombat(entry, equipSpec(entry))
          : guardNotInCombat(entry, unequipSpec(entry));
      return [entry.id, () => spec] as const;
    }),
  );
  return {
    runtime,
    beat(tick) {
      return harness.beat({ tick, actorId: "player" });
    },
    call(raw, callOptions) {
      const first = raw.split(" ")[0] ?? "";
      const entry = COMMANDS.find((candidate) => candidate.verbs.includes(first));
      const spec = bindings.get(entry?.id ?? "")!();
      rng = callOptions?.rng ?? scriptedRng([]);
      return harness.call(spec, { raw, actorId: "player", tick: callOptions?.tick });
    },
    openFight(tick = 100, openRng: Rng = scriptedRng([])) {
      rng = openRng;
      const out = harness.call(strikeSpec(STRIKE), { raw: "strike Guard", actorId: "player", tick });
      if (!out.result.ok) {
        throw new Error(`rig: opening the fight failed: ${JSON.stringify(out.result)}`);
      }
    },
  };
}

/** The drift fixtures: entries whose faces break the one-face law (not in known). */
const DRIFT_FIXTURES: readonly MartialEntry[] = [
  {
    id: "mnt-x-drift-both",
    kind: "mental",
    name: "BothFace",
    tier: 1,
    effects: ["eff-hit"],
    modifiers: [{ stat: "attack", flat: 5 }],
  },
  {
    id: "mnt-x-drift-none",
    kind: "mental",
    name: "NoFace",
    tier: 1,
  },
];

/** One strike event off the messages, or undefined. */
function strikeDamageOf(messages: readonly Message[]): number | undefined {
  for (const message of messages) {
    const event = message.event as { type?: string; damage?: number };
    if (event.type === "strike" && typeof event.damage === "number") {
      return event.damage;
    }
  }
  return undefined;
}

describe("the mental supply — the pipeline's first real members (D10, AC1/AC3/AC4)", () => {
  it("answers an empty map with nothing equipped — the identity degenerate stays (AC3)", () => {
    const test = rig();
    const player = test.runtime.state.entities["player"]!;
    expect(equippedMentalModifiers(test.runtime.registry, player).size).toBe(0);
  });

  it("constructs flat and percent members off the equipped mentals, grouped by stat (AC1/AC4)", () => {
    const test = rig({ mental: ["mnt-x-001", "mnt-x-002"] });
    const player = test.runtime.state.entities["player"]!;
    const supply = equippedMentalModifiers(test.runtime.registry, player);
    expect([...supply.keys()]).toEqual(["attack"]);
    // The two members in the SLOT's order: the flat first (equipped first),
    // the percent behind it — one stat key, both layers as real members.
    expect(supply.get("attack")).toEqual([
      { kind: "flat", value: 5 },
      { kind: "percent", value: 0.1 },
    ]);
  });

  it("refuses a widened ceiling of 0 or less — the monster side's symmetry (C4 deep)", () => {
    const crushed = {
      ...MENTALS[0]!,
      modifiers: [{ stat: "maxHp", percent: -1 }],
    } as MartialEntry;
    const registry = createContentRegistry(
      {
        commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS,
        martials: [crushed, ...MENTALS.slice(1)],
      },
      { character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [crushed.id], initialEquipped: [] } }, combatTiers: TIERS },
    );
    const runtime = createWorldRuntime({ registry });
    runtime.addEntity(createEntity("player"), "room-yard");
    const player = runtime.state.entities["player"]!;
    seedCharacterAttrs(player, CHARACTER);
    player.mental = [crushed.id];
    expect(() => primaryResourceOf(player, CHARACTER, equippedMentalModifiers(registry, player)))
      .toThrow(/floor the primary max/);
  });

  it("refuses a stat the character table never declares — the registry's cross-file half (D10)", () => {
    const drifted = {
      ...MENTALS[0]!,
      modifiers: [{ stat: "nonexistent-stat", flat: 5 }],
    } as MartialEntry;
    expect(() =>
      createContentRegistry(
        {
          commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS,
          effects: EFFECTS, martials: [drifted, ...MARTIALS.slice(1)],
        },
        {
          character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [], initialEquipped: [] } },
          combatTiers: TIERS,
        },
      ),
    ).toThrow(/never name/);
  });

  it("refuses a technique face listed under mental.known — the prefix promise is not mechanical (D9)", () => {
    const trojan = {
      ...MARTIALS[0]!,
      id: "mnt-x-008",
      name: "TrojanFist",
    } as MartialEntry;
    expect(() =>
      createContentRegistry(
        {
          commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS,
          effects: EFFECTS, martials: [...MARTIALS, ...MENTALS, trojan],
        },
        {
          character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [trojan.id], initialEquipped: [] } },
          combatTiers: TIERS,
        },
      ),
    ).toThrow(/breath.s list takes mental faces only/);
  });

  it("refuses a declared row with neither layer, loudly (D10)", () => {
    const drifted = {
      ...MENTALS[0]!,
      modifiers: [{ stat: "attack" }],
    } as MartialEntry;
    const registry = createContentRegistry(
      {
        commands: COMMANDS,
        rooms: ROOMS,
        npcs: NPCS,
        monsters: MONSTERS,
        effects: EFFECTS,
        martials: [drifted],
      },
      { character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [drifted.id], initialEquipped: [] } }, combatTiers: TIERS },
    );
    const runtime = createWorldRuntime({ registry });
    runtime.addEntity(createEntity("player"), "room-yard");
    seedCharacterAttrs(runtime.state.entities["player"]!, CHARACTER);
    runtime.state.entities["player"]!.mental = [drifted.id];
    expect(() =>
      equippedMentalModifiers(registry, runtime.state.entities["player"]!),
    ).toThrow(/neither flat nor percent/);
  });
});

describe("slotKindOf — the entry's face routes the slot (D9)", () => {
  it("reads a technique's and a mental's faces apart", () => {
    expect(slotKindOf(MARTIALS[0]!)).toBe("martial");
    expect(slotKindOf(MENTALS[0]!)).toBe("mental");
  });

  it("refuses both faces and neither, loudly", () => {
    expect(() => slotKindOf(DRIFT_FIXTURES[0]!)).toThrow(/exactly one face/);
    expect(() => slotKindOf(DRIFT_FIXTURES[1]!)).toThrow(/exactly one face/);
  });
});

describe("consumer point ① — the attack operand walks the pipe (AC2)", () => {
  it("the basic hand answers the flat: (30 + 5) × (1 − 6/16) = 21.875 → 22", () => {
    const bare = rig();
    const bareOut = bare.call("strike Guard", { tick: 100 });
    expect(bareOut.result.ok).toBe(true);
    expect(strikeDamageOf(bareOut.messages)).toBe(19);

    const test = rig({ mental: ["mnt-x-001"] });
    const out = test.call("strike Guard", { tick: 100 });
    expect(out.result.ok).toBe(true);
    expect(strikeDamageOf(out.messages)).toBe(22);
  });

  it("both layers together: (30 + 5) × 1.1 × 0.625 = 24.06 → 24", () => {
    const test = rig({ mental: ["mnt-x-001", "mnt-x-002"] });
    const out = test.call("strike Guard", { tick: 100 });
    expect(out.result.ok).toBe(true);
    expect(strikeDamageOf(out.messages)).toBe(24);
  });
});

describe("consumer points ② and ③ — the npc hand's defense and dodge walk the pipe (AC2)", () => {
  it("the defense flat narrows the guard's hand: 15 × (1 − 8/18) = 8.33 → 8", () => {
    // Baseline first: 15 × (1 − 3/13) = 11.54 → 12.
    const baseline = rig({ settings: settingsOf(0) });
    baseline.openFight(100);
    const basePlayer = baseline.runtime.state.entities["player"]!;
    npcStrike(baseline.runtime, basePlayer, "npc-guard", {
      nowTick: 102,
      rng: scriptedRng([]),
      emit: () => {},
    });
    // dodge P = 0 + 10/100 = 0.1; the 0.999 tail never dodges.
    expect(200 - basePlayer.attrs.hp!).toBe(12);

    const test = rig({ settings: settingsOf(0), mental: ["mnt-x-005"] });
    test.openFight(100);
    const player = test.runtime.state.entities["player"]!;
    npcStrike(test.runtime, player, "npc-guard", {
      nowTick: 102,
      rng: scriptedRng([]),
      emit: () => {},
    });
    // defense 3 + 5 = 8: 15 × (1 − 8/18) → 8.
    expect(200 - player.attrs.hp!).toBe(8);
  });

  it("the dodge flat lifts the roll past a draw the bare stat loses (D8 through the pipe)", () => {
    // P(bare) = 0.5 + 10/100 = 0.6; P(with flat) = 0.5 + 15/105 = 0.6428…:
    // the draw 0.61 misses bare and dodges equipped — one draw, two verdicts.
    const draw = 0.61;
    const bare = rig({ settings: settingsOf(0.5) });
    bare.openFight(100, scriptedRng([draw]));
    const barePlayer = bare.runtime.state.entities["player"]!;
    npcStrike(bare.runtime, barePlayer, "npc-guard", {
      nowTick: 102,
      rng: scriptedRng([draw]),
      emit: () => {},
    });
    expect(200 - barePlayer.attrs.hp!).toBe(12);

    const test = rig({ settings: settingsOf(0.5), mental: ["mnt-x-006"] });
    test.openFight(100, scriptedRng([draw]));
    const player = test.runtime.state.entities["player"]!;
    let dodgeSeen = false;
    npcStrike(test.runtime, player, "npc-guard", {
      nowTick: 102,
      rng: scriptedRng([draw]),
      emit: (_to, draft) => {
        if ((draft as { isDodge?: boolean }).isDodge === true) dodgeSeen = true;
      },
    });
    expect(dodgeSeen).toBe(true);
    expect(player.attrs.hp!).toBe(200);
  });
});

describe("consumer points ④ and ⑤ — the ceilings walk the pipe (AC2, C4-T2)", () => {
  it("maxHp: primaryResourceOf answers the widened ceiling (200 → 300)", () => {
    const bare = rig();
    const barePlayer = bare.runtime.state.entities["player"]!;
    expect(primaryResourceOf(barePlayer, CHARACTER).max).toBe(200);
    const test = rig({ mental: ["mnt-x-003"] });
    const player = test.runtime.state.entities["player"]!;
    expect(
      primaryResourceOf(player, CHARACTER, equippedMentalModifiers(test.runtime.registry, player)).max,
    ).toBe(300);
  });

  it("maxInternalForce: the regeneration pass refills to the widened ceiling (AC2⑤)", () => {
    const test = rig({ settings: settingsOf(0, 0), mental: ["mnt-x-004"] });
    const player = test.runtime.state.entities["player"]!;
    // The force stands at its bare ceiling (40) — the widened ceiling is 60,
    // so the span refills the difference, capped by the pipe's own max.
    const events: string[] = [];
    regenResources(test.runtime, player, { fromTick: 0, toTick: 20 }, (_to, draft) => {
      const event = draft as { type?: string; resource?: string };
      if (event.type === "resourceRegen" && event.resource === "internalForce") {
        events.push(event.resource);
      }
    });
    expect(events).toEqual(["internalForce"]);
    expect(player.attrs.internalForce).toBe(60);
  });

  it("refuses a floored ceiling on the regeneration pass too — the out-of-fight half (C4 deep)", () => {
    const crushed = {
      ...MENTALS[3]!,
      modifiers: [{ stat: "maxInternalForce", percent: -1 }],
    } as MartialEntry;
    const registry = createContentRegistry(
      {
        commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS,
        martials: [...MENTALS.slice(0, 3), crushed],
      },
      { character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [crushed.id], initialEquipped: [] } }, combatTiers: TIERS, settings: settingsOf(0, 0.5) },
    );
    const runtime = createWorldRuntime({ registry });
    runtime.addEntity(createEntity("player"), "room-yard");
    const player = runtime.state.entities["player"]!;
    seedCharacterAttrs(player, CHARACTER);
    player.mental = [crushed.id];
    expect(() =>
      regenResources(runtime, player, { fromTick: 0, toTick: 10 }, () => {}),
    ).toThrow(/floor the maxInternalForce ceiling/);
  });

  it("an unequipped ceiling heals at the next read, never by a write-down (F6's law, C4-T2)", () => {
    const test = rig({ mental: ["mnt-x-004"] });
    const player = test.runtime.state.entities["player"]!;
    // Fill to the widened ceiling, then drop the mental — the stored value
    // stays 60; the regen pass sees current ≥ bare max and refills nothing.
    regenResources(test.runtime, player, { fromTick: 0, toTick: 20 }, () => {});
    expect(player.attrs.internalForce).toBe(60);
    delete player.mental;
    regenResources(test.runtime, player, { fromTick: 20, toTick: 40 }, () => {});
    expect(player.attrs.internalForce).toBe(60);
  });
});

describe("the equip pair routes both kinds — one verb, two slots, two caps (D12, AC7)", () => {
  it("equips a mental by name into the mental slot, its own event carrying the id", () => {
    const test = rig();
    const out = test.call("equip FlatMind");
    expect(out.result.ok).toBe(true);
    const player = test.runtime.state.entities["player"]!;
    expect(player.mental).toEqual(["mnt-x-001"]);
    expect(player.martial).toBeUndefined();
    const event = out.messages[0]!.event as { type?: string; martialId?: string };
    expect(event.type).toBe(MENTAL_EQUIPPED_EVENT);
    expect(event.martialId).toBe("mnt-x-001");
  });

  it("refuses a second copy and past the cap of three — the shared error faces", () => {
    const test = rig({ mental: ["mnt-x-001", "mnt-x-003", "mnt-x-004"] });
    const again = test.call("equip FlatMind");
    expect(again.result.ok).toBe(false);
    expect(again.messages[0]!.event).toMatchObject({ errKey: "err_alreadyEquipped" });

    const full = test.call("equip PercentMind");
    expect(full.result.ok).toBe(false);
    expect(full.messages[0]!.event).toMatchObject({ errKey: "err_martialSlotFull" });
  });

  it("the technique cap stays its own four — a full breath never blocks the hand", () => {
    const test = rig({ mental: ["mnt-x-001", "mnt-x-002", "mnt-x-003"] });
    const hand = test.call("equip Alpha");
    expect(hand.result.ok).toBe(true);
    expect(test.runtime.state.entities["player"]!.martial).toEqual(["mrt-a-001"]);
  });

  it("refuses an unknown name with the shared notLearned face", () => {
    const test = rig();
    const out = test.call("equip 无名心法");
    expect(out.result.ok).toBe(false);
    expect(out.messages[0]!.event).toMatchObject({ errKey: "err_notLearned" });
  });

  it("unequips a mental by name; the last one deletes the slot outright", () => {
    const test = rig({ mental: ["mnt-x-001"] });
    const out = test.call("unequip FlatMind");
    expect(out.result.ok).toBe(true);
    const player = test.runtime.state.entities["player"]!;
    expect(player.mental).toBeUndefined();
    const event = out.messages[0]!.event as { type?: string };
    expect(event.type).toBe(MENTAL_UNEQUIPPED_EVENT);
  });

  it("the in-combat gate holds for UNEQUIP too — the pair's other half (C4-T3)", () => {
    const test = rig({ mental: ["mnt-x-001"] });
    test.openFight();
    const out = test.call("unequip FlatMind");
    expect(out.result.ok).toBe(false);
    expect(out.messages[0]!.event).toMatchObject({ errKey: "err_inCombat" });
    expect(test.runtime.state.entities["player"]!.mental).toEqual(["mnt-x-001"]);
  });

  it("the in-combat gate holds for the mental half too (C4-T3)", () => {
    const test = rig();
    test.openFight();
    const out = test.call("equip FlatMind");
    expect(out.result.ok).toBe(false);
    expect(out.messages[0]!.event).toMatchObject({ errKey: "err_inCombat" });
  });
});

describe("the mental slot's save shape (D8, AC5/AC12)", () => {
  function worldOf(mental: readonly string[] | undefined) {
    const test = rig();
    const player = test.runtime.state.entities["player"]!;
    if (mental !== undefined) player.mental = [...mental];
    const snapshot = serializeWorld(test.runtime.state, {
      nowTick: 10,
      rngState: 0,
      due: [],
    });
    return { snapshot, test };
  }

  it("serializes ascending — the order carries no meaning (unlike the wheel's slot)", () => {
    const { snapshot } = worldOf(["mnt-x-003", "mnt-x-001", "mnt-x-002"]);
    expect(snapshot.data.entities["player"]!.mental).toEqual([
      "mnt-x-001",
      "mnt-x-002",
      "mnt-x-003",
    ]);
  });

  it("an emptied slot writes no key — byte-identical to a pre-#59 record", () => {
    const { snapshot } = worldOf([]);
    expect(snapshot.data.entities["player"]!.mental).toBeUndefined();
    expect("mental" in snapshot.data.entities["player"]!).toBe(false);
  });

  it("a pre-#59 save (no mental key) restores as no equipped mental (AC12)", () => {
    const { snapshot, test } = worldOf(undefined);
    const record = JSON.parse(JSON.stringify(snapshot.data.entities["player"]!));
    delete record.mental;
    const restored = restoreWorld({ version: snapshot.version, data: { ...snapshot.data, entities: { player: record } } });
    expect(restored.state.entities["player"]!.mental).toBeUndefined();
    // And the fight arithmetic still runs — the C1–C3 red line.
    expect(
      primaryResourceOf(restored.state.entities["player"]!, CHARACTER).max,
    ).toBe(200);
  });

  it("refuses a malformed slot at load — absence is tolerated, malformation is not", () => {
    const { snapshot } = worldOf(undefined);
    const record = JSON.parse(JSON.stringify(snapshot.data.entities["player"]!));
    record.mental = ["mnt-x-001", 42];
    expect(() =>
      restoreWorld({ version: snapshot.version, data: { ...snapshot.data, entities: { player: record } } }),
    ).toThrow(/mental/);
  });

  it("the registry refuses a both-face or faceless entry outright — the flattened world's gate (D9)", () => {
    // Prototype inheritance is the escape hatch the file-level if/then cannot
    // see: a mental declaring prototypeParent at a technique inherits its
    // effects WHOLE (the flattener replaces absent own keys with the
    // parent's), and the both-face graft detonates here at load — never at
    // the first equip.
    // Inheritance targets a TEMPLATE (an entry declaring prototypeKey) —
    // the prototype pair's own law; the template technique is the graft's
    // parent, the mental never writes an own modifiers list, so the
    // flattened entry carries the parent's effects beside its kind word.
    const template = {
      ...MARTIALS[0]!,
      id: "mrt-a-tpl",
      name: "TemplateFist",
      prototypeKey: "mrt-a-tpl",
    } as MartialEntry;
    // The escape needs BOTH faces present in the FLATTENED entry: the
    // mental keeps its own modifiers (the file passes if/then) and inherits
    // the technique template's effects — neither layer sees the other.
    const grafted = {
      ...MENTALS[0]!,
      id: "mnt-x-009",
      name: "GraftedMind",
      prototypeParent: [template.id],
    } as MartialEntry;
    expect(() =>
      createContentRegistry(
        {
          commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS,
          effects: EFFECTS, martials: [...MARTIALS, ...MENTALS, template, grafted],
        },
        {
          character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [], initialEquipped: [] } },
          combatTiers: TIERS,
        },
      ),
    ).toThrow(/exactly one face, and prototype inheritance/);
    expect(() =>
      createContentRegistry(
        {
          commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS,
          effects: EFFECTS, martials: [...MARTIALS, ...MENTALS, DRIFT_FIXTURES[1]!],
        },
        {
          character: { ...CHARACTER, martial: { known: [], initialEquipped: [] }, mental: { known: [], initialEquipped: [] } },
          combatTiers: TIERS,
        },
      ),
    ).toThrow(/neither an effect chain nor stat modifiers/);
  });

  it("the load-point check names the drifts an assembled save can still carry: unknown id, wheel-slot entry (D8/D13)", () => {
    const test = rig({ mental: ["mnt-x-001"] });
    const player = test.runtime.state.entities["player"]!;
    validateEquippedMentals(test.runtime.state, test.runtime.registry);

    player.mental = ["mnt-x-nope"];
    expect(() => validateEquippedMentals(test.runtime.state, test.runtime.registry)).toThrow(/unknown martial/);

    player.mental = ["mrt-a-001"];
    expect(() => validateEquippedMentals(test.runtime.state, test.runtime.registry)).toThrow(/technique/);

    // The twin slot's own drift: a MENTAL parked in the wheel's slot
    // answers at the load point too (martialStrikePlan's throw is the late
    // assertion, not the gate).
    player.mental = undefined;
    player.martial = ["mnt-x-001"];
    expect(() => validateEquippedMartials(test.runtime.state, test.runtime.registry)).toThrow(/wheel takes technique faces only/);
    player.martial = undefined;
  });

  it("a round trip keeps the supply — save, reload, the pipe still answers (AC12)", () => {
    const { snapshot } = worldOf(["mnt-x-001"]);
    const restored = restoreWorld(snapshot);
    const registry = test0Registry();
    const player = restored.state.entities["player"]!;
    expect(
      equippedMentalModifiers(registry, player).get("attack"),
    ).toEqual([{ kind: "flat", value: 5 }]);
    // And the ceiling read stays the bare base — the restored mind widens
    // attack, not maxHp: the C1–C3 arithmetic is the pipe's own identity.
    expect(primaryResourceOf(player, CHARACTER).max).toBe(200);
  });
});

/** The shared registry for the round-trip block (one assembly, many worlds). */
function test0Registry() {
  return createContentRegistry(
    {
      commands: COMMANDS,
      rooms: ROOMS,
      npcs: NPCS,
      monsters: MONSTERS,
      effects: EFFECTS,
      martials: [...MARTIALS, ...MENTALS],
    },
    {
      character: CHARACTER,
      combatTiers: TIERS,
      dimensions: {
        source: ["external", "internal"],
        element: ["none", "wood"],
        damageBand: ["light", "medium", "heavy", "nearDeath"],
        lifeBand: ["critical", "low", "half", "high", "full"],
      },
      settings: settingsOf(0),
    },
  );
}
