import { describe, expect, it } from "vitest";
import type { SettleSpan } from "../src/time/settle.js";
import { createCommandHarness, expectMessageSequence, testClockOver } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { MonsterRecord } from "../src/content/registry.js";
import type {
  CharacterTable,
  CombatTiersTable,
  SettingsTable,
} from "../src/content/config.js";
import type { CommandEntry } from "../src/command/entry.js";
import { commandSetSources } from "../src/command/entry.js";
import type { EffectEntry } from "../src/effects/entry.js";
import type { NpcEntry, RoomEntry } from "../src/world/entry.js";
import { createEntity } from "../src/world/entity.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";
import { createSettler } from "../src/time/settle.js";
import {
  createCombatSettleHandler,
  seedCharacterAttrs,
} from "../src/combat/session.js";
import { combatTraversalSpec, COMBAT_ESCAPE_EVENT } from "../src/combat/traversal.js";
import { guardNotInCombat } from "../src/combat/guard.js";
import { strikeSpec } from "../src/combat/strike.js";
import { grantFlagSpec } from "../src/world/flag.js";
import type { Rng } from "../src/types.js";

/**
 * The combat-bearing MOVEMENT tests (#57, AC7–AC9): the escape roll's three
 * faces (disengage+move, pinned+priced, no-fight unchanged), the
 * declarative in-combat gate on a content command, and the proactive edge
 * (an npc who opens the fight as the player walks in, an escape INTO a
 * proactive room reopening one).
 *
 * The map is a synthetic three-room line — road ↔ yard ↔ den — with the
 * yard holding the passive guard and the den holding one PROACTIVE brute
 * (attack 8, defense 2 ⇒ the player's hand does 25; her hand 8 × (1 −
 * 3/13) ⇒ 5). Every escape roll is scripted: 0.1 lands under 0.5, 0.9
 * does not.
 */

// #58 fixture face: dodge base 0 (a zero-probability roll consumes no dice
// stream slot — the C1/C2 rng sequences stay comparable) and a zero primary
// regen rate (the regeneration pass stays silent for these fights).
const SETTINGS: SettingsTable = {
  combat: {
    formula: "",
    defenseK: 10,
    escapeChance: 0.5,
    dodge: { base: 0, cap: 0.4, k: 90 },
  },
  time: { primaryRegenPerTick: 0 },
};

const CHARACTER: CharacterTable = {
  attrs: { maxHp: 200, hp: 200, attack: 30, externalDefense: 3, dodge: 0 },
  primaryResource: { current: "hp", max: "maxHp" },
  deathAtOrBelow: 0,
  strikeIntervalTicks: 2,
  strike: {
    attackAttr: "attack",
    defenseAttrs: { external: "externalDefense", internal: "internalDefense" },
    dodgeAttr: "dodge",
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

const ROAD_EXIT = {
  id: "exit-road-east",
  direction: "东",
  targetRoomId: "room-yard",
  verbs: ["east", "e"],
  argForm: "none" as const,
  cmdset: "exits",
  priority: 101,
};

const YARD_TO_DEN = {
  id: "exit-yard-north",
  direction: "北",
  targetRoomId: "room-den",
  verbs: ["north", "n"],
  argForm: "none" as const,
  cmdset: "exits",
  priority: 101,
};

const DEN_TO_YARD = {
  id: "exit-den-south",
  direction: "南",
  targetRoomId: "room-yard",
  verbs: ["south", "s"],
  argForm: "none" as const,
  cmdset: "exits",
  priority: 101,
};

const YARD_TO_ROAD = {
  id: "exit-yard-west",
  direction: "西",
  targetRoomId: "room-road",
  verbs: ["west", "w"],
  argForm: "none" as const,
  cmdset: "exits",
  priority: 101,
};

const ROOMS: RoomEntry[] = [
  {
    id: "room-road",
    name: "road",
    description: "road",
    enterText: "road",
    exits: [ROAD_EXIT],
  },
  {
    id: "room-yard",
    name: "yard",
    description: "yard",
    enterText: "yard",
    exits: [YARD_TO_ROAD, YARD_TO_DEN],
    objects: [{ id: "npc-guard", count: 1 }],
  },
  {
    id: "room-den",
    name: "den",
    description: "den",
    enterText: "den",
    exits: [DEN_TO_YARD],
    objects: [
      { id: "npc-brute", count: 1 },
      { id: "npc-second-brute", count: 1 },
    ],
  },
];

const NPCS: NpcEntry[] = [
  { id: "npc-guard", name: "Guard", description: "guard", monsterId: "mon-guard" },
  { id: "npc-brute", name: "Brute", description: "brute", monsterId: "mon-brute" },
  { id: "npc-second-brute", name: "SecondBrute", description: "brute", monsterId: "mon-brute2" },
];

const MONSTERS: MonsterRecord[] = [
  {
    id: "mon-guard",
    stats: { maxHp: 140, attack: 15, externalDefense: 6, dodge: 0.05, attackIntervalTicks: 2 },
    source: "external",
  },
  {
    id: "mon-brute",
    proactive: true,
    stats: { maxHp: 60, attack: 8, externalDefense: 2, dodge: 0, attackIntervalTicks: 2 },
  },
  {
    id: "mon-brute2",
    proactive: true,
    stats: { maxHp: 60, attack: 9, externalDefense: 2, dodge: 0, attackIntervalTicks: 3 },
  },
];

const EFFECTS: EffectEntry[] = [
  { id: "eff-hit", primitives: [{ type: "instant-damage" }] },
];

const STRIKE: CommandEntry = {
  id: "cmd-strike",
  verbs: ["strike"],
  argForm: "target",
  cmdset: "character",
  priority: 0,
  effects: ["eff-hit"],
};

const LODGE: CommandEntry = {
  id: "cmd-lodge",
  verbs: ["lodge"],
  argForm: "none",
  cmdset: "character",
  priority: 0,
  notInCombat: true,
};

const SAY: CommandEntry = {
  id: "cmd-say",
  verbs: ["say"],
  argForm: "none",
  cmdset: "character",
  priority: 0,
};

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
    spec: Parameters<ReturnType<typeof createCommandHarness<WorldRuntime>>["call"]>[0],
    raw: string,
    options?: { tick?: number; rng?: Rng },
  ): ReturnType<ReturnType<typeof createCommandHarness<WorldRuntime>>["call"]>;
}

function rig(startRoom = "room-yard"): Rig {
  const registry = createContentRegistry(
    { commands: [STRIKE, LODGE, SAY], rooms: ROOMS, npcs: NPCS, monsters: MONSTERS, effects: EFFECTS },
    { settings: SETTINGS, character: CHARACTER, combatTiers: TIERS, world: { startRoomId: "room-road" } },
  );
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("player"), startRoom);
  seedCharacterAttrs(runtime.state.entities["player"]!, CHARACTER);
  let rng: Rng = scriptedRng([]);
  const stream: Rng = { next: () => rng.next(), getState: () => 0 };
  const settler = createSettler({
    state: runtime.state,
    clock: runtime.clock,
    entity: createCombatSettleHandler(runtime, { rng: stream, baseEffects: STRIKE.effects ?? [] }),
  });
  const harness = createCommandHarness<WorldRuntime>({
    world: { live: runtime },
    receivers: ["player"],
    session: {
      clock: testClockOver(runtime.clock),
      rng: stream,
      settle: (request) => settler.settleTo(request),
    },
    verbs: ({ world, actorId }) => {
      const room = registry.room(world.locationOf(actorId));
      return [...commandSetSources([STRIKE, LODGE, SAY]), ...commandSetSources(room.exits)];
    },
    access: { subjectOf: (world, id) => world.subjectOf(id) },
  });
  return {
    runtime,
    call(spec, raw, callOptions) {
      rng = callOptions?.rng ?? scriptedRng([]);
      return harness.call(spec, {
        raw,
        actorId: "player",
        tick: callOptions?.tick,
      });
    },
  };
}

const west = () => combatTraversalSpec(YARD_TO_ROAD);
const north = () => combatTraversalSpec(YARD_TO_DEN);
const south = () => combatTraversalSpec(DEN_TO_YARD);

describe("the escape roll (#57 AC7/D11)", () => {
  it("a failed roll keeps the fight, spends a hand, and refuses the move", () => {
    const world = rig();
    // Open the fight at 10 (dodge 0.9 lands the hand; no poison in this
    // fixture's chain): next hands both due 12.
    world.call(strikeSpec(STRIKE), "strike Guard", { tick: 10, rng: scriptedRng([0.9]) });

    // Escape roll 0.9 ≥ 0.5: pinned.
    const out = world.call(west(), "west", { tick: 11, rng: scriptedRng([0.9]) });
    expect(out.result.ok).toBe(false);
    if (!out.result.ok && out.result.kind === "rejected") {
      expect(out.result.reason).toBe("escapeFailed");
    }
    const escape = out.messages.find((m) => m.event.type === COMBAT_ESCAPE_EVENT)!.event as Record<string, unknown>;
    expect(escape["outcome"]).toBe("pinned");
    expect(escape["npcId"]).toBe("npc-guard");
    // Still in the yard, still in the fight; the player's next hand paid
    // one interval (12 → 14, the escape's price), the guard's did not.
    expect(world.runtime.locationOf("player")).toBe("room-yard");
    const session = world.runtime.state.entities["player"]!.combat!;
    expect(session.playerNextStrikeTick).toBe(14);
    expect(session.npcNextStrikeTick).toBe(12);
  });

  it("a successful roll disengages — session cleared, ledger gone — and the move runs", () => {
    const world = rig();
    world.call(strikeSpec(STRIKE), "strike Guard", { tick: 10, rng: scriptedRng([0.9]) });

    // Escape roll 0.1 < 0.5: out.
    const out = world.call(west(), "west", { tick: 11, rng: scriptedRng([0.1]) });
    expect(out.result.ok).toBe(true);
    const escape = out.messages.find((m) => m.event.type === COMBAT_ESCAPE_EVENT)!.event as Record<string, unknown>;
    expect(escape["outcome"]).toBe("escaped");
    expect(world.runtime.state.entities["player"]!.combat).toBeUndefined();
    expect(world.runtime.locationOf("player")).toBe("room-road");
  });

  it("a failed escape on a rhythm-less C1 session seeds both sides — the price survives (review pin)", () => {
    const world = rig();
    // A C1-era session never observed: no rhythm pair. The failed escape
    // must seed BOTH sides now, or the next observation's seeding pass
    // would flatten the player's paid interval back to now + interval.
    world.runtime.state.entities["player"]!.combat = {
      targetNpcId: "npc-guard",
      targetHp: 100,
      targetDead: false,
    };
    const out = world.call(west(), "west", { tick: 20, rng: scriptedRng([0.9]) });
    expect(out.result.ok).toBe(false);
    const session = world.runtime.state.entities["player"]!.combat!;
    // Player: seeded at 22 then paid one interval → 24; the guard's side is
    // seeded too, so the settle layer's seeding branch never rewrites either.
    expect(session.playerNextStrikeTick).toBe(24);
    expect(session.npcNextStrikeTick).toBe(22);
  });

  it("a fight-free move reads no escape chance at all — zero change (AC7)", () => {
    const world = rig("room-road");
    // The settings table here carries escapeChance; a fight-free traversal
    // never reads it (one roll scripted would be spent if it did — the
    // result below reads it back by index).
    const out = world.call(
      combatTraversalSpec(ROAD_EXIT),
      "east",
      { tick: 10, rng: scriptedRng([0.0]) },
    );
    expect(out.result.ok).toBe(true);
    expect(world.runtime.locationOf("player")).toBe("room-yard");
    expect(out.messages.every((m) => m.event.type !== COMBAT_ESCAPE_EVENT)).toBe(true);
  });
});

describe("the declarative in-combat gate (#57 AC8/D7)", () => {
  it("refuses a notInCombat command mid-fight, through the entry's own err copy", () => {
    const world = rig();
    world.call(strikeSpec(STRIKE), "strike Guard", { tick: 10, rng: scriptedRng([0.9]) });

    const out = world.call(guardNotInCombat(LODGE, grantFlagSpec(LODGE, "inn-lodger")), "lodge", {
      tick: 11,
      rng: scriptedRng([0.9]),
    });
    expect(out.result.ok).toBe(false);
    if (!out.result.ok && out.result.kind === "rejected") {
      expect(out.result.reason).toBe("inCombat");
    }
    const refusal = out.messages.find((m) => m.event.type === "commandRefused")!.event as Record<string, unknown>;
    expect(refusal["commandKey"]).toBe("cmd-lodge");
    expect(refusal["errKey"]).toBe("err_inCombat");
    expect(refusal["reason"]).toBe("inCombat");
  });

  it("lets the same command through with no fight, and never gates an undeclaring entry", () => {
    const world = rig("room-road");
    const lodged = world.call(guardNotInCombat(LODGE, grantFlagSpec(LODGE, "inn-lodger")), "lodge", {
      tick: 10,
    });
    expect(lodged.result.ok).toBe(true);

    // An entry without the field wraps to itself: say runs mid-fight.
    world.call(strikeSpec(STRIKE), "strike Guard", { tick: 12, rng: scriptedRng([0.9]) });
    const said = world.call(guardNotInCombat(SAY, {
      key: SAY.id,
      func: (ctx) => {
        void ctx;
      },
    }), "say", { tick: 13 });
    expect(said.result.ok).toBe(true);
  });
});

describe("the proactive edge (#57 AC9/D14)", () => {
  it("the first proactive npc opens as the player walks in: her hand now, the player's from the interval", () => {
    const world = rig();
    // Walk north into the den (no fight): the brute opens — 8 × (1 − 3/13)
    // = 6.15 → 6 on the player; her next hand due 12, the player's 12.
    const out = world.call(north(), "north", { tick: 10, rng: scriptedRng([0.9]) });
    expect(out.result.ok).toBe(true);
    expectMessageSequence(
      out.messages.filter((m) => m.event.type === "strike"),
      [
        {
          event: {
            type: "strike",
            attackerId: "npc-brute",
            defenderId: "player",
            damage: 6,
            isDodge: false,
          },
        },
      ],
    );
    const session = world.runtime.state.entities["player"]!.combat!;
    expect(session.targetNpcId).toBe("npc-brute");
    expect(session.targetHp).toBe(60);
    expect(session.playerNextStrikeTick).toBe(12);
    expect(session.npcNextStrikeTick).toBe(12);
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(194);
  });

  it("a standing session never triggers the edge (the C1-T3 focus)", () => {
    const world = rig();
    world.call(strikeSpec(STRIKE), "strike Guard", { tick: 10, rng: scriptedRng([0.9]) });
    // Mid-fight the move is an escape attempt FIRST: the roll pins
    // (0.9 ≥ 0.5), the move never runs, and there is no edge to trigger —
    // the session is still the guard's, the player still in the yard.
    const out = world.call(north(), "north", { tick: 11, rng: scriptedRng([0.9]) });
    expect(out.result.ok).toBe(false);
    expect(world.runtime.state.entities["player"]!.combat!.targetNpcId).toBe("npc-guard");
    expect(world.runtime.locationOf("player")).toBe("room-yard");
  });

  it("an escape INTO a proactive room reopens the fight (the chain-room corner)", () => {
    const world = rig();
    world.call(strikeSpec(STRIKE), "strike Guard", { tick: 10, rng: scriptedRng([0.9]) });
    // Escape north succeeds (0.1 < 0.5): the guard's session clears, the
    // move lands in the den — and the brute opens immediately.
    const out = world.call(north(), "north", { tick: 11, rng: scriptedRng([0.1]) });
    expect(out.result.ok).toBe(true);
    const session = world.runtime.state.entities["player"]!.combat!;
    expect(session.targetNpcId).toBe("npc-brute");
    expect(world.runtime.state.entities["player"]!.attrs["hp"]).toBe(194);
  });

  it("picks the FIRST proactive placement and ignores passive npcs", () => {
    // The den's list: brute (proactive, attack 8) then second-brute
    // (proactive, attack 9): the FIRST is the opener, not the strongest.
    const world = rig();
    world.call(north(), "north", { tick: 10, rng: scriptedRng([0.9]) });
    expect(world.runtime.state.entities["player"]!.combat!.targetNpcId).toBe("npc-brute");

    // And a passive room never opens: the yard's guard is not proactive,
    // so walking road→yard starts nothing.
    const quiet = rig("room-road");
    const walked = quiet.call(combatTraversalSpec(ROAD_EXIT), "east", { tick: 10 });
    expect(walked.result.ok).toBe(true);
    expect(quiet.runtime.state.entities["player"]!.combat).toBeUndefined();
  });

  it("the opener's hand can kill the player — the settle layer's death path", () => {
    const world = rig();
    const state = world.runtime.state.entities["player"]!;
    state.attrs["hp"] = 5;
    const out = world.call(north(), "north", { tick: 10, rng: scriptedRng([0.9]) });
    expect(out.result.ok).toBe(true);
    const types = out.messages.map((m) => m.event.type);
    expect(types).toContain("death");
    expect(state.attrs["hp"]).toBe(200);
    expect(state.combat).toBeUndefined();
    expect(world.runtime.locationOf("player")).toBe("room-road");
  });
});

describe("movement wording rides the pure adapter (no fight, no change)", () => {
  it("an ordinary traversal still announces departure and arrival", () => {
    const world = rig("room-road");
    const out = world.call(combatTraversalSpec(ROAD_EXIT), "east", { tick: 10 });
    const types = out.messages.map((m) => m.event.type);
    expect(types).toContain("departed");
    expect(types).toContain("arrived");
    expect(world.runtime.locationOf("player")).toBe("room-yard");
  });
});
