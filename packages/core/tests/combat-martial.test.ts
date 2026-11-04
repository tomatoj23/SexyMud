import { describe, expect, it } from "vitest";
import { createSettler } from "../src/time/settle.js";
import type { SettleRequest } from "../src/time/settle.js";
import type { Message } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence, testClockOver } from "../src/command/testing.js";
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
  regenResources,
  seedCharacterAttrs,
} from "../src/combat/session.js";
import { npcStrike } from "../src/combat/session.js";
import { strikeSpec } from "../src/combat/strike.js";
import { performSpec } from "../src/combat/perform.js";
import { equipSpec, unequipSpec, MARTIAL_SLOT_CAP } from "../src/combat/equip.js";
import { guardNotInCombat } from "../src/combat/guard.js";
import {
  martialStrikePlan,
  selectStrikePlan,
  validateEquippedMartials,
} from "../src/combat/martial.js";
import { restoreWorld, serializeWorld } from "../src/state/snapshot.js";
import { commandSetSources } from "../src/command/entry.js";
import type { Rng } from "../src/types.js";

/**
 * The martial wheel's own tests (#58): the assembly-order priority walk and
 * its two fallback states (cooling = full power, drained = the exhausted
 * ratio), the perform cast's four refusals and its reschedule, the
 * equip/unequip pair's laws, the resource-regeneration pass (in-combat and
 * out alike, offline spans capped), the cooldowns slot's first real
 * consumer, the player's dodge roll and the delivery-word defense routing
 * (D8/D17), and the equipped slot's save shape and load-point checks.
 *
 * The fixture is SYNTHETIC on purpose — pinned numbers so every assertion
 * reads arithmetic: attack 30, defenseK 10, external defense 6 ⇒ a basic
 * hand's 19; the internal monster's 0 internal defense ⇒ full-value
 * internal hands; dodge base 0.5 + k 90 + stat 10 ⇒ P = 0.6 exactly on the
 * scripted dice's edge.
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
  quality: [
    { band: "low", min: 1, max: 2 },
    { band: "mid", min: 2, max: 3 },
    { band: "high", min: 3, max: 4 },
    { band: "ultimate", min: 4, max: 5 },
  ],
};

const ROOMS: RoomEntry[] = [
  {
    id: "room-yard",
    name: "yard",
    description: "yard",
    enterText: "yard",
    exits: [],
    objects: [{ id: "npc-guard", count: 1 }, { id: "npc-adept", count: 1 }],
  },
];

const NPCS: NpcEntry[] = [
  { id: "npc-guard", name: "Guard", description: "guard", monsterId: "mon-guard" },
  { id: "npc-adept", name: "Adept", description: "adept", monsterId: "mon-adept" },
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
  {
    // The internal delivery face: same attack, reads the player's INTERNAL
    // defense instead (D17), and her own stats carry the split defenses.
    id: "mon-adept",
    stats: {
      maxHp: 1000,
      attack: 15,
      externalDefense: 6,
      internalDefense: 0,
      dodge: 0,
      attackIntervalTicks: 2,
    },
    source: "internal",
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
  {
    id: "mrt-a-002",
    kind: "technique",
    name: "Beta",
    tier: 2,
    source: "internal",
    element: "none",
    cost: 15,
    cooldownTicks: 6,
    attackMultiplier: 1.5,
    effects: ["eff-hit"],
  },
  {
    id: "mrt-a-003",
    kind: "technique",
    name: "Gamma",
    tier: 3,
    source: "external",
    element: "wood",
    cost: 30,
    cooldownTicks: 10,
    attackMultiplier: 2.0,
    effects: ["eff-hit"],
  },
  {
    id: "mrt-a-004",
    kind: "technique",
    name: "Delta",
    tier: 4,
    source: "external",
    element: "none",
    cost: 8,
    cooldownTicks: 4,
    attackMultiplier: 1.1,
    effects: ["eff-hit"],
  },
  {
    // The fifth known martial: equipping her past a full slot is the
    // cap's own refusal face (a name nothing knows answers notLearned).
    id: "mrt-a-005",
    kind: "technique",
    name: "Epsilon",
    tier: 1,
    source: "external",
    element: "none",
    cost: 3,
    attackMultiplier: 1.05,
    effects: ["eff-hit"],
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
const PERFORM: CommandEntry = {
  id: "cmd-perform",
  verbs: ["perform"],
  argForm: "text",
  cmdset: "character",
  priority: 0,
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

const COMMANDS = [STRIKE, PERFORM, EQUIP, UNEQUIP];

/**
 * The character model: force 40 (three Beta casts, or a mix), the dodge
 * stat at 10, and a KNOWN list of all four with an EMPTY opening loadout —
 * each test equips exactly what it means to walk.
 */
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
  strike: {
    attackAttr: "attack",
    defenseAttrs: { external: "externalDefense", internal: "internalDefense" },
    dodgeAttr: "dodge",
    element: "none",
    source: "external",
  },
};

/** dodge base b + k 90 + stat 10 ⇒ P = b + 0.1 — the 0.999 tail never dodges. */
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

const SETTINGS = settingsOf(0);

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
  /**
   * One settled strike that opens the fight at `tick`, dice scripted high;
   * `beatRolls` are the draws the NEXT beat's settle will consume (the
   * settle layer draws on the same stream the command channel left).
   */
  openFight(tick?: number, beatRolls?: readonly number[]): void;
}

function rig(options: { settings?: SettingsTable; equip?: readonly string[] } = {}): Rig {
  const registry = createContentRegistry(
    { commands: COMMANDS, rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS, martials: MARTIALS },
    {
      settings: options.settings ?? SETTINGS,
      character: CHARACTER,
      combatTiers: TIERS,
      dimensions: {
        source: ["external", "internal"],
        element: ["none", "wood"],
        damageBand: ["light", "medium", "heavy", "nearDeath"],
        lifeBand: ["critical", "low", "half", "high", "full"],
        quality: ["low", "mid", "high", "ultimate"],
      },
    },
  );
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("player"), "room-yard");
  seedCharacterAttrs(runtime.state.entities["player"]!, CHARACTER);
  runtime.state.entities["player"]!.martial = [...(options.equip ?? [])];
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
          : entry === PERFORM ? performSpec(entry)
          : entry === EQUIP ? guardNotInCombat(entry, equipSpec(entry))
          : guardNotInCombat(entry, unequipSpec(entry));
      return [entry.id, () => spec] as const;
    }),
  );
  const perform = PERFORM;
  return {
    runtime,
    beat(tick) {
      return harness.beat({ tick, actorId: "player" });
    },
    call(raw, callOptions) {
      const first = raw.split(" ")[0] ?? "";
      const entry = COMMANDS.find((candidate) => candidate.verbs.includes(first));
      const spec = entry === undefined ? performSpec(perform) : bindings.get(entry.id)!();
      rng = callOptions?.rng ?? scriptedRng([]);
      return harness.call(spec, { raw, actorId: "player", tick: callOptions?.tick });
    },
    openFight(tick = 100, beatRolls: readonly number[] = []) {
      rng = scriptedRng(beatRolls);
      const out = harness.call(strikeSpec(STRIKE), { raw: "strike Guard", actorId: "player", tick });
      if (!out.result.ok) {
        throw new Error(`rig: opening the fight failed: ${JSON.stringify(out.result)}`);
      }
    },
  };
}

/** The player entity's attrs, typed for the tests' many writes. */
function attrsOf(world: Rig): Record<string, number> {
  return world.runtime.state.entities["player"]!.attrs;
}

describe("the wheel's selection (D6/D15)", () => {
  it("an empty wheel answers the base plan: multiplier 1, no cost, no martial id", () => {
    const world = rig();
    const plan = selectStrikePlan(world.runtime.registry, world.runtime.state.entities["player"]!, ["eff-hit"], 100);
    expect(plan).toEqual({
      effects: ["eff-hit"],
      source: "external",
      element: "none",
      attackMultiplier: 1,
      cost: 0,
    });
  });

  it("the first equipped castable martial wins — assembly order IS the priority", () => {
    const world = rig({ equip: ["mrt-a-002", "mrt-a-001"] });
    const plan = selectStrikePlan(world.runtime.registry, world.runtime.state.entities["player"]!, ["eff-hit"], 100);
    expect(plan.martialId).toBe("mrt-a-002");
    expect(plan.attackMultiplier).toBe(1.5);
    expect(plan.cost).toBe(15);
    expect(plan.source).toBe("internal");
    expect(plan.effects).toEqual(["eff-hit"]);
    expect(plan.cooldownTicks).toBe(6);
  });

  it("a martial on cooldown is skipped for the next in line (the cooldown's first real consumer)", () => {
    const world = rig({ equip: ["mrt-a-002", "mrt-a-004", "mrt-a-001"] });
    const player = world.runtime.state.entities["player"]!;
    player.cooldowns["mrt-a-002"] = 200; // due 200, hand at 100
    player.cooldowns["mrt-a-004"] = 200;
    const plan = selectStrikePlan(world.runtime.registry, player, ["eff-hit"], 100);
    expect(plan.martialId).toBe("mrt-a-001");
  });

  it("a ready martial at due tick turns ready (the >= comparison, the cooldown law)", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    const player = world.runtime.state.entities["player"]!;
    player.cooldowns["mrt-a-002"] = 106;
    const plan = selectStrikePlan(world.runtime.registry, player, ["eff-hit"], 106);
    expect(plan.martialId).toBe("mrt-a-002");
  });

  it("the EXHAUSTED state: nothing affordable ⇒ the base plan at the drained ratio", () => {
    const world = rig({ equip: ["mrt-a-002", "mrt-a-003"] });
    attrsOf(world)["internalForce"] = 3; // below every cost (15 / 30)
    const plan = selectStrikePlan(world.runtime.registry, world.runtime.state.entities["player"]!, ["eff-hit"], 100);
    expect(plan.martialId).toBeUndefined();
    expect(plan.attackMultiplier).toBe(0.5); // zeroCostAttackRatio
    expect(plan.cost).toBe(0);
  });

  it("the COOLING state is full power, not a punishment: affordable but all cooling ⇒ multiplier 1", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    const player = world.runtime.state.entities["player"]!;
    player.cooldowns["mrt-a-002"] = 200; // affordable (40 ≥ 15), merely cooling
    const plan = selectStrikePlan(world.runtime.registry, player, ["eff-hit"], 100);
    expect(plan.martialId).toBeUndefined();
    expect(plan.attackMultiplier).toBe(1);
  });

  it("rank rides the tier through the quality band table (C3-T2)", () => {
    const world = rig();
    const registry = world.runtime.registry;
    expect(martialStrikePlan(registry, registry.martial("mrt-a-001")).rank).toBe("low");
    expect(martialStrikePlan(registry, registry.martial("mrt-a-002")).rank).toBe("mid");
    expect(martialStrikePlan(registry, registry.martial("mrt-a-003")).rank).toBe("high");
    expect(martialStrikePlan(registry, registry.martial("mrt-a-004")).rank).toBe("ultimate");
  });
});

describe("the martial hand through the settle layer (D6/D11/D17)", () => {
  it("a rhythm hand casts the wheel's martial: multiplier in, defense routed, cost paid, cooldown armed", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    world.openFight(100); // opening = base hand: 19 damage, force untouched
    expect(world.runtime.state.entities["player"]!.combat!.targetHp).toBe(1000 - 19);
    expect(attrsOf(world)["internalForce"]).toBe(40);

    // The beat settles the hands due at 102: the player's wheel hand
    // (Beta: INTERNAL, ×1.5, cost 15, cooldown 6) then the guard's.
    const messages = world.beat(103);
    const strike = messages.map((m) => m.event).find((event) => event.type === "strike" && (event as { attackerId?: string }).attackerId === "player") as Record<string, unknown>;
    // 30 × 1.5 × (1 − 0/10) = 45 — the internal routing's own number (an
    // external hand reads the 6 defense and lands 23).
    expect(strike["damage"]).toBe(45);
    expect(strike["martialId"]).toBe("mrt-a-002");
    expect(strike["rank"]).toBe("mid");
    expect(strike["source"]).toBe("internal");
    // 40 − 15 (the cast) + 3 (the span's own regen, 1/tick × 3) = 28.
    expect(attrsOf(world)["internalForce"]).toBe(28);
    expect(world.runtime.state.entities["player"]!.cooldowns["mrt-a-002"]).toBe(102 + 6);
  });

  it("the wheel rotates by cooldown: the auto-exchange cycles the loadout over one long beat", () => {
    const world = rig({ equip: ["mrt-a-002", "mrt-a-004", "mrt-a-001"] });
    world.openFight(100);
    const messages = world.beat(115); // hands due at 102..114
    const playerHands = messages
      .map((m) => m.event as Record<string, unknown>)
      .filter((event) => event["type"] === "strike" && event["attackerId"] === "player")
      .map((strike) => strike["martialId"] ?? "basic");
    // The ledger the wheel walks, force 40 down: 102 Beta (−15 → 25,
    // cooldown 6 → due 108); 104 Delta (−8 → 17, due 108); 106 Alpha (−5 →
    // 12); 108 Beta is READY but unaffordable (15 > 12) — the wheel skips
    // her for Delta (−8 → 4); 110 onward NOTHING is affordable (15/8/5 all
    // > 4) — the EXHAUSTED basic hands at the ratio, mid-beat and all; the
    // span's regen (1/tick × 15) refills AFTER the loop, so it cannot save
    // the later hands. No dice anywhere in the choice.
    expect(playerHands).toEqual([
      "mrt-a-002",
      "mrt-a-004",
      "mrt-a-001",
      "mrt-a-004",
      "basic",
      "basic",
      "basic",
    ]);

  });

  it("an exhausted wheel fights on at the ratio: attack × zeroCostAttackRatio, no cost", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    world.openFight(100);
    // Drain AFTER the opening settle (its own span heals to full): 3 left
    // is below Beta's 15 — the wheel has nothing castable.
    attrsOf(world)["internalForce"] = 3;
    const messages = world.beat(103);
    const strike = messages.map((m) => m.event).find((event) => event.type === "strike" && (event as { attackerId?: string }).attackerId === "player") as Record<string, unknown>;
    // 30 × 0.5 × (1 − 6/16) = 9.375 → 9: the drained state's own number.
    expect(strike["damage"]).toBe(9);
    expect("martialId" in strike).toBe(false);
    // The basic hand costs nothing; the span's regen refills 3 back.
    expect(attrsOf(world)["internalForce"]).toBe(6);
  });
});

describe("perform — the cast verb (D5/D14)", () => {
  it("refuses out of combat: err_notInCombat", () => {
    const world = rig({ equip: ["mrt-a-001"] });
    const out = world.call("perform Alpha", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "notInCombat" });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.to).toBe("player");
    expect(out.messages[0]!.event).toMatchObject({
      type: "commandRefused",
      reason: "notInCombat",
      commandKey: "cmd-perform",
      errKey: "err_notInCombat",
    });
  });

  it("refuses a name nothing equipped answers: err_notEquipped", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    world.openFight(100);
    const out = world.call("perform Alpha", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "notEquipped" });
    expect(out.messages[0]!.event).toMatchObject({
      type: "commandRefused",
      commandKey: "cmd-perform",
      errKey: "err_notEquipped",
    });
  });

  it("refuses while cooling: err_onCooldown", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    world.openFight(100);
    const first = world.call("perform Beta", { tick: 100, rng: scriptedRng([]) });
    expect(first.result.ok).toBe(true);
    const second = world.call("perform Beta", { tick: 101 });
    expect(second.result).toMatchObject({ kind: "rejected", reason: "onCooldown" });
    // The one-tick settle span healed 1 first (its regen line rides ahead);
    // the refusal itself is the commandRefused among the messages.
    const refused = second.messages
      .map((m) => m.event)
      .find((event) => event.type === "commandRefused");
    expect(refused).toMatchObject({
      commandKey: "cmd-perform",
      errKey: "err_onCooldown",
    });
  });

  it("refuses when the force cannot pay: err_outOfForce", () => {
    const world = rig({ equip: ["mrt-a-003"] });
    world.openFight(100);
    attrsOf(world)["internalForce"] = 29; // Gamma costs 30; the opening span healed first
    const out = world.call("perform Gamma", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "outOfForce" });
    expect(out.messages[0]!.event).toMatchObject({
      type: "commandRefused",
      commandKey: "cmd-perform",
      errKey: "err_outOfForce",
    });
  });

  it("casts NOW: the hand lands immediately with the martial's whole face", () => {
    const world = rig({ equip: ["mrt-a-003"] });
    world.openFight(100);
    // Cast at 101, BEFORE the rhythm's first wheel hand (due 102): the
    // zero-length settle span heals nothing, so the arithmetic is bare.
    const out = world.call("perform Gamma", { tick: 101, rng: scriptedRng([]) });
    expect(out.result.ok).toBe(true);
    const strike = out.messages[0]!.event as Record<string, unknown>;
    // 30 × 2.0 × (1 − 6/16) = 37.5 → 38.
    expect(strike).toMatchObject({
      type: "strike",
      damage: 38,
      martialId: "mrt-a-003",
      rank: "high",
      source: "external",
      element: "wood",
    });
    expect(attrsOf(world)["internalForce"]).toBe(10); // 40 − 30, no span healed
    expect(world.runtime.state.entities["player"]!.cooldowns["mrt-a-003"]).toBe(111);
  });

  it("reschedules the rhythm monotonically: a close hand is pushed, a far hand keeps its place (D5)", () => {
    const world = rig({ equip: ["mrt-a-001"] });
    world.openFight(100); // player's next hand 102
    // Cast at 101: the close hand (102) is displaced to 101 + 2 = 103.
    world.call("perform Alpha", { tick: 101, rng: scriptedRng([]) });
    expect(world.runtime.state.entities["player"]!.combat!.playerNextStrikeTick).toBe(103);
    // Cast again at 102: the standing hand (103) is close again — pushed to 104.
    world.call("perform Alpha", { tick: 102, rng: scriptedRng([]) });
    expect(world.runtime.state.entities["player"]!.combat!.playerNextStrikeTick).toBe(104);
    // A FAR hand is never pulled closer: push the rhythm out, cast at once.
    const session = world.runtime.state.entities["player"]!.combat!;
    session.playerNextStrikeTick = 200;
    world.call("perform Alpha", { tick: 103, rng: scriptedRng([]) });
    expect(session.playerNextStrikeTick).toBe(200);
  });
});

describe("equip and unequip — the slot's laws (D13)", () => {
  it("equips a learned martial by exact name: the slot appends, the event carries the id", () => {
    const world = rig();
    const out = world.call("equip Alpha", { tick: 100 });
    expect(out.result.ok).toBe(true);
    expect(world.runtime.state.entities["player"]!.martial).toEqual(["mrt-a-001"]);
    expect(out.messages[0]!.event).toMatchObject({
      type: "martialEquipped",
      martialId: "mrt-a-001",
    });
  });

  it("refuses an unknown or unlearned name: err_notLearned", () => {
    const world = rig();
    const out = world.call("equip No Such Art", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "notLearned" });
    expect(out.messages[0]!.event).toMatchObject({
      type: "commandRefused",
      commandKey: "cmd-equip",
      errKey: "err_notLearned",
    });
  });

  it("refuses a second copy: err_alreadyEquipped", () => {
    const world = rig({ equip: ["mrt-a-001"] });
    const out = world.call("equip Alpha", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "alreadyEquipped" });
  });

  it("refuses past the cap of four: err_martialSlotFull", () => {
    expect(MARTIAL_SLOT_CAP).toBe(4);
    const world = rig({ equip: ["mrt-a-001", "mrt-a-002", "mrt-a-003", "mrt-a-004"] });
    const out = world.call("equip Epsilon", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "martialSlotFull" });
    expect(out.messages[0]!.event).toMatchObject({ errKey: "err_martialSlotFull" });
  });

  it("unequips by name; the LAST one deletes the slot outright", () => {
    const world = rig({ equip: ["mrt-a-001", "mrt-a-002"] });
    const out = world.call("unequip Alpha", { tick: 100 });
    expect(out.result.ok).toBe(true);
    expect(world.runtime.state.entities["player"]!.martial).toEqual(["mrt-a-002"]);
    expect(out.messages[0]!.event).toMatchObject({
      type: "martialUnequipped",
      martialId: "mrt-a-001",
    });
    world.call("unequip Beta", { tick: 101 });
    expect(world.runtime.state.entities["player"]!.martial).toBeUndefined();
  });

  it("refuses to unequip what is not on: err_notEquipped", () => {
    const world = rig({ equip: ["mrt-a-001"] });
    const out = world.call("unequip Beta", { tick: 100 });
    expect(out.result).toMatchObject({ kind: "rejected", reason: "notEquipped" });
  });

  it("both commands carry the notInCombat gate (the declarative wrapper, mid-fight)", () => {
    const world = rig();
    world.openFight(100);
    const equip = world.call("equip Alpha", { tick: 100 });
    expect(equip.result).toMatchObject({ kind: "rejected", reason: "inCombat" });
    const unequip = world.call("unequip Alpha", { tick: 100 });
    expect(unequip.result).toMatchObject({ kind: "rejected", reason: "inCombat" });
  });

  it("the known list backs the has_martial facet (C3-T7)", () => {
    const world = rig();
    expect(world.runtime.subjectOf("player").hasSkill("mrt-a-001")).toBe(true);
    expect(world.runtime.subjectOf("player").hasSkill("mrt-x-999")).toBe(false);
  });
});

describe("resource regeneration — one compensation settlement (D4/D7/C3-T8)", () => {
  it("heals both pairs over the span, capped at their maxes, one event each stamped at the span's end", () => {
    const world = rig({ settings: settingsOf(0, 0.5) });
    const player = world.runtime.state.entities["player"]!;
    attrsOf(world)["hp"] = 190;
    attrsOf(world)["internalForce"] = 30;
    const drafts: { to: string; event: Record<string, unknown> }[] = [];
    regenResources(world.runtime, player, { fromTick: 100, toTick: 110 }, (to, event) => {
      drafts.push({ to, event: event as unknown as Record<string, unknown> });
    });
    // rate 0.5/tick × 10 = 5 hp; rate 1/tick × 10 = 10 force.
    expect(attrsOf(world)["hp"]).toBe(195);
    expect(attrsOf(world)["internalForce"]).toBe(40);
    expect(drafts).toEqual([
      {
        to: "player",
        event: {
          type: "resourceRegen",
          resource: "hp",
          amount: 5,
          fromTick: 100,
          toTick: 110,
          tick: 110,
        },
      },
      {
        to: "player",
        event: {
          type: "resourceRegen",
          resource: "internalForce",
          amount: 10,
          fromTick: 100,
          toTick: 110,
          tick: 110,
        },
      },
    ]);
  });

  it("an offline span heals only to the ceiling — the cap is the max key (ADR-0016's literal member)", () => {
    const world = rig();
    const player = world.runtime.state.entities["player"]!;
    attrsOf(world)["internalForce"] = 7;
    const capped: Record<string, unknown>[] = [];
    regenResources(world.runtime, player, { fromTick: 0, toTick: 1_000_000 }, (_to, event) => {
      capped.push(event as unknown as Record<string, unknown>);
    });
    // 7 + min(1 × 1_000_000, 40 − 7) = 40 — healed TO the ceiling, not
    // past, and the one event carries the CAPPED amount (33), never the
    // million-tick one.
    expect(attrsOf(world)["internalForce"]).toBe(40);
    expect(capped).toEqual([
      { type: "resourceRegen", resource: "internalForce", amount: 33, fromTick: 0, toTick: 1_000_000, tick: 1_000_000 },
    ]);
  });

  it("a full resource and a zero rate stay silent — no owed regeneration is not news", () => {
    const world = rig();
    const player = world.runtime.state.entities["player"]!;
    let emitted = 0;
    regenResources(world.runtime, player, { fromTick: 0, toTick: 50 }, () => {
      emitted += 1;
    });
    expect(emitted).toBe(0); // hp full, force full

    const zeroRate = rig({
      settings: {
        combat: {
          formula: "",
          defenseK: 10,
          escapeChance: 0.5,
          dodge: { base: 0, cap: 0.9, k: 90 },
          internalForce: { regenPerTick: 0, zeroCostAttackRatio: 0.5 },
        },
        time: { primaryRegenPerTick: 0 },
      },
    });
    attrsOf(zeroRate)["hp"] = 100;
    let zeroEmitted = 0;
    regenResources(zeroRate.runtime, zeroRate.runtime.state.entities["player"]!, { fromTick: 0, toTick: 50 }, () => {
      zeroEmitted += 1;
    });
    expect(zeroEmitted).toBe(0); // the rates are zero
    expect(attrsOf(zeroRate)["hp"]).toBe(100);
  });

  it("rides the settle handler OUT of combat too — the pass is not the fight's (D7)", () => {
    const world = rig({ settings: settingsOf(0, 0.5) });
    attrsOf(world)["hp"] = 100;
    const messages = world.beat(110); // no session at all
    const regen = messages.map((m) => m.event).filter((event) => event.type === "resourceRegen");
    expect(regen).toHaveLength(1);
    expect(attrsOf(world)["hp"]).toBe(155); // 100 + 0.5 × 110 (lastSeen 0 → 110)
  });
});

describe("the player's dodge and the delivery routing (D8/D17)", () => {
  it("the npc hand rolls the player's dodge: a won roll is the WHOLE hand missing", () => {
    // base 0.5 + 10/(10+90) = 0.6 exactly — the dice's edge is the test.
    const world = rig({ settings: settingsOf(0.5) });
    world.openFight(100);
    const won = world.beat(103);
    const guardHand = won
      .map((m) => m.event)
      .find((event) => event.type === "strike" && (event as { attackerId?: string }).attackerId === "npc-guard") as Record<string, unknown>;
    // The scripted tail 0.999 ≥ 0.6: this beat's roll missed the dodge.
    expect(guardHand["isDodge"]).toBe(false);

    const dodged = rig({ settings: settingsOf(0.5) });
    // The opening hand draws nothing (the guard's monster dodge is 0), so
    // the beat's FIRST draw is the guard hand's PLAYER-dodge roll — 0.5 <
    // 0.6 wins it.
    dodged.openFight(100, [0.5]);
    // First draw: the player's wheel hand (monster dodge 0 ⇒ no roll); the
    // guard's hand rolls the PLAYER dodge — 0.5 < 0.6 wins it.
    const messages = dodged.beat(103);
    let guardDodge: Record<string, unknown> | undefined;
    for (const message of messages) {
      const event = message.event as Record<string, unknown>;
      if (event["type"] === "strike" && event["attackerId"] === "npc-guard") {
        guardDodge = event;
      }
    }
    expect(guardDodge).toMatchObject({ isDodge: true, damage: 0 });
    expect(attrsOf(dodged)["hp"]).toBe(200); // nothing landed
  });

  it("a zero-probability dodge consumes no dice (the monster-dodge precedent's zero case)", () => {
    const world = rig(); // base 0 but the stat rides 10 ⇒ P = 0.1
    attrsOf(world)["dodge"] = 0; // base 0 + stat 0 ⇒ P = 0 exactly
    let draws = 0;
    const counting: Rng = { next: () => { draws += 1; return 0.999; }, getState: () => 0 };
    world.openFight(100);
    // Drive the npc hand directly with the counting dice.
    npcStrike(world.runtime, world.runtime.state.entities["player"]!, "npc-guard", {
      nowTick: 100,
      rng: counting,
      emit: () => {},
    });
    expect(draws).toBe(0);
  });

  it("the guard's EXTERNAL hand reads the external defense; the adept's INTERNAL hand reads the internal one", () => {
    const world = rig();
    world.openFight(100);
    npcStrike(world.runtime, world.runtime.state.entities["player"]!, "npc-guard", {
      nowTick: 100,
      rng: scriptedRng([]),
      emit: () => {},
    });
    // 15 × (1 − 3/13) = 11.54 → 12.
    expect(attrsOf(world)["hp"]).toBe(200 - 12);

    const adeptRig = rig();
    adeptRig.openFight(100);
    // Retarget the session to the adept for her internal hand.
    const player = adeptRig.runtime.state.entities["player"]!;
    player.combat = {
      targetNpcId: "npc-adept",
      targetHp: 1000,
      targetDead: false,
      playerNextStrikeTick: 102,
      npcNextStrikeTick: 102,
    };
    npcStrike(adeptRig.runtime, player, "npc-adept", {
      nowTick: 100,
      rng: scriptedRng([]),
      emit: () => {},
    });
    // Same attack, the OTHER defense key (also 3 here): the routing is the
    // assertion — flip the seeds and only this number moves.
    expect(attrsOf(adeptRig)["hp"]).toBe(200 - 12);
    // The split made audible: give the player a thick internal defense and
    // the adept's hand lands less.
    attrsOf(adeptRig)["internalDefense"] = 9;
    attrsOf(adeptRig)["hp"] = 200;
    npcStrike(adeptRig.runtime, player, "npc-adept", {
      nowTick: 100,
      rng: scriptedRng([]),
      emit: () => {},
    });
    // 15 × (1 − 9/19) = 7.89 → 8.
    expect(attrsOf(adeptRig)["hp"]).toBe(200 - 8);
  });
});

describe("the equipped slot's save shape and load-point checks (D9/D13/AC9)", () => {
  it("round-trips the slot with its ORDER as written — the priority travels", () => {
    const world = rig({ equip: ["mrt-a-003", "mrt-a-001"] });
    const snapshot = serializeWorld(world.runtime.state, { nowTick: 100, rngState: 0, due: [] });
    const record = snapshot.data.entities["player"]!;
    expect(record.martial).toEqual(["mrt-a-003", "mrt-a-001"]);
    const restored = restoreWorld(snapshot);
    expect(restored.state.entities["player"]!.martial).toEqual(["mrt-a-003", "mrt-a-001"]);
  });

  it("an unequipped-everything save is byte-shaped like a pre-#58 one: no martial key", () => {
    const world = rig(); // empty wheel — the slot never existed
    const snapshot = serializeWorld(world.runtime.state, { nowTick: 100, rngState: 0, due: [] });
    expect("martial" in snapshot.data.entities["player"]!).toBe(false);
    const restored = restoreWorld(snapshot);
    expect(restored.state.entities["player"]!.martial).toBeUndefined();
  });

  it("a C2-shaped save (attrs, combat, no martial) reads clean and fights on basic hands (AC9)", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    world.openFight(100);
    const snapshot = serializeWorld(world.runtime.state, { nowTick: 100, rngState: 0, due: [] });
    delete (snapshot.data.entities["player"]! as { martial?: string[] }).martial;
    const restored = restoreWorld(snapshot);
    const player = restored.state.entities["player"]!;
    expect(player.martial).toBeUndefined();
    expect(player.combat!.targetHp).toBe(1000 - 19); // the fight rode whole
    // The re-assembled world's wheel is empty: the next hand is basic.
    const registry = world.runtime.registry;
    const plan = selectStrikePlan(registry, player, ["eff-hit"], 102);
    expect(plan.martialId).toBeUndefined();
    expect(plan.attackMultiplier).toBe(1);
  });

  it("a malformed slot is refused at load — never silently emptied (the late-slot law)", () => {
    const world = rig({ equip: ["mrt-a-001"] });
    const snapshot = serializeWorld(world.runtime.state, { nowTick: 100, rngState: 0, due: [] });
    (snapshot.data.entities["player"]! as { martial?: unknown }).martial = ["mrt-a-001", 7];
    expect(() => restoreWorld(snapshot)).toThrow(/martial/);
  });

  it("the load point validates references: an unknown id and a drifted-known id both fail loudly", () => {
    const world = rig({ equip: ["mrt-a-001"] });
    const player = world.runtime.state.entities["player"]!;
    expect(() => validateEquippedMartials(world.runtime.state, world.runtime.registry)).not.toThrow();
    player.martial = ["mrt-x-999"];
    expect(() => validateEquippedMartials(world.runtime.state, world.runtime.registry)).toThrow(/unknown martial/);
    player.martial = ["mrt-a-001"];
    // Not unknown, but no longer LEARNED: content drift's own message.
    player.martial = ["mrt-a-004"];
    const shrunk = createContentRegistry(
      {
        commands: COMMANDS,
        rooms: ROOMS,
        npcs: NPCS,
        monsters: MONSTERS,
        effects: EFFECTS,
        martials: MARTIALS,
      },
      {
        settings: SETTINGS,
        character: { ...CHARACTER, martial: { known: ["mrt-a-001"], initialEquipped: [] } },
        combatTiers: TIERS,
      },
    );
    const state = { entities: { player: { ...player, martial: ["mrt-a-004"] } } };
    expect(() => validateEquippedMartials(state as never, shrunk)).toThrow(/known list/);
  });

  it("a cooldown survives the round-trip and keeps timing across the reload (AC7)", () => {
    const world = rig({ equip: ["mrt-a-002"] });
    world.openFight(100);
    world.call("perform Beta", { tick: 100, rng: scriptedRng([]) });
    const snapshot = serializeWorld(world.runtime.state, { nowTick: 100, rngState: 0, due: [] });
    expect(snapshot.data.entities["player"]!.cooldowns).toEqual({ "mrt-a-002": 106 });
    const restored = restoreWorld(snapshot);
    expect(restored.state.entities["player"]!.cooldowns["mrt-a-002"]).toBe(106);
  });
});
