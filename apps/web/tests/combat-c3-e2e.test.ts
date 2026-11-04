import { describe, expect, it } from "vitest";
import type { SaveStore, Snapshot, Viewport } from "@sexymud/core";
import { createGameSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { createHostClock } from "../src/game/hostClock.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { loadWuxiaPack } from "./wuxia-pack.js";
import type { StatusPanel } from "../src/ui/terminalView.js";

/**
 * The C3 hand-played chains (#58, AC12 and the C3-specific faces): the
 * wheel's named lines over the shipped pack's opening loadout, the perform
 * cast out of turn, the cooldown rotation, the drained fallback, the
 * regeneration line, and the equip/unequip management verbs — all through
 * the real session, the real content and a scripted wall, the #57 rig's own
 * discipline (fixed seed ⇒ fixed output; where the seed's dice decide, the
 * assertions read "contains", never exact rolls).
 */

const PACK = loadWuxiaPack();

class MemoryStore implements SaveStore {
  readonly saved: Snapshot[] = [];
  async load(): Promise<Snapshot | null> {
    return this.saved.at(-1) ?? null;
  }
  async save(snapshot: Snapshot): Promise<void> {
    this.saved.push(snapshot);
  }
}

function makeRig() {
  let wallMs = 1_000_000;
  const lines: string[] = [];
  const panels: StatusPanel[] = [];
  const store = new MemoryStore();
  const session: GameSession = createGameSession({
    pack: PACK,
    store,
    viewport: { width: 40, height: 24 } as Viewport,
    copy: WEB_HOST_COPY,
    hostClock: createHostClock({ tickSeconds: 1, now: () => wallMs }),
    heartbeatMs: 3_600_000,
    onOutput: (chunks) => {
      for (const chunk of chunks) for (const line of chunk) lines.push(line.text);
    },
    onStatus: (panel) => panels.push(panel),
  });
  return {
    session,
    lines,
    store,
    async play(input: string, secondsLater = 3) {
      wallMs += secondsLater * 1000;
      await session.submit(input);
    },
    async beat(secondsLater = 3) {
      wallMs += secondsLater * 1000;
      await session.heartbeat();
    },
  };
}

/** The walk to the back yard: north, west, check in, north. */
async function walkToYard(rig: ReturnType<typeof makeRig>) {
  await rig.play("北");
  await rig.play("西");
  await rig.play("住店");
  await rig.play("北");
}

describe("the C3 hand-played chains over the shipped pack (#58)", () => {
  it("AC12 — opens, wheels by name, casts out of turn, rotates, regenerates, kills (full line)", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("招式侠");
    await walkToYard(rig);

    // OPEN: the base punch (the opening hand is the command's own — the
    // wheel owns the RHYTHM, perform owns the named cast).
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("一拳打向孙彪");

    // PERFORM out of turn: the big one, by name, before the first rhythm
    // hand — the queue-jump's own line with the multiplier's damage
    // (30 × 2.0 × (1 − 6/16) = 37.5 → 38) and the reschedule it costs.
    await rig.play("施展 开碑劲");
    expect(rig.lines.join("")).toContain("一招「开碑劲」打向孙彪");
    expect(rig.lines.join("")).toContain("受创38点");

    // THE WHEEL on rhythm: the loadout's order [透骨指, 腐骨毒爪, 劈风掌,
    // 开碑劲] — the first beat's hand is 透骨指 (internal, against Sun
    // Biao's 0 internal defense: 45), the cooldown rotation brings the
    // poison claw and the palm in behind her.
    let beats = 0;
    while (beats < 40) {
      await rig.beat(3);
      beats += 1;
      if (rig.lines.join("").includes("孙彪闷哼一声")) break;
    }
    const text = rig.lines.join("");
    expect(text).toContain("一招「透骨指」打向孙彪");
    expect(text).toContain("受创45点");
    expect(text).toContain("一招「腐骨毒爪」打向孙彪");
    // (劈风掌 — third in the loadout — never got her turn: the poison and
    // the direct hands finished Sun Biao first; the rotation the first two
    // demonstrate is the claim, not the whole loadout.)
    // The regeneration line rode the beats (the casts left the force under
    // its max; every beat's span refilled some).
    expect(text).toMatch(/你调息片刻，回复了\d+(\.\d+)?点内力。/);
    // Sun Biao died and the session cleared — the fight's own close.
    expect(text).toContain("孙彪闷哼一声");
    const dead = rig.store.saved.at(-1)!;
    const deadRecord = (dead.data as { entities: Record<string, { combat?: unknown }> })
      .entities["player"]!;
    expect(deadRecord.combat).toBeUndefined();
    // And the wheel's spending shows in the save: the internal force rides
    // below its seed, the cooldowns table carries the cast ids.
    const attrs = (dead.data as { entities: Record<string, { attrs?: Record<string, number>, cooldowns?: Record<string, number> }> })
      .entities["player"]!;
    expect(attrs.attrs!["internalForce"]).toBeLessThan(100);
    expect(Object.keys(attrs.cooldowns ?? {}).length).toBeGreaterThan(0);
  });

  it("the drained wheel fights on at the ratio — a hand-built save carries the exhaustion (D18)", async () => {
    // The mid-fight save hook (#57 F-5's own technique): open a real fight,
    // then hand-write the drained attrs into the save and resume — the
    // wheel has nothing castable (2 < every cost) and the rhythm hands are
    // the base strike at half power.
    const rig = makeRig();
    await rig.session.startNewGame("耗尽侠");
    await walkToYard(rig);
    await rig.play("打 孙彪");
    const saved = rig.store.saved.at(-1)!;
    const entities = (saved.data as {
      entities: Record<string, Record<string, unknown>>;
    }).entities;
    (entities["player"]!.attrs as Record<string, number>)["internalForce"] = 2;
    (saved.data as { nowTick?: number }).nowTick = 100;

    const lines: string[] = [];
    let wallMs = 2_000_000;
    const resumed = createGameSession({
      pack: PACK,
      store: { load: async () => saved, save: async () => {} },
      viewport: { width: 40, height: 24 } as Viewport,
      copy: WEB_HOST_COPY,
      hostClock: createHostClock({ tickSeconds: 1, now: () => wallMs }),
      heartbeatMs: 3_600_000,
      onOutput: (chunks) => {
        for (const chunk of chunks) for (const line of chunk) lines.push(line.text);
      },
      onStatus: () => {},
    });
    await resumed.continueGame();
    const before = lines.length;
    wallMs += 3000;
    await resumed.heartbeat();
    const produced = lines.slice(before).join("");
    // 30 × 0.5 × (1 − 6/16) = 9.375 → 9: the drained number, by name-less
    // fist — the ratio is the ONLY thing that changed.
    expect(produced).toContain("一拳打向孙彪");
    expect(produced).toContain("受创9点");
    expect(produced).not.toContain("一招「");
  });

  it("the management verbs and the perform refusals — all four faces on screen (D13/D14)", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("管理侠");
    await walkToYard(rig);

    // Out of a fight, perform refuses its premise.
    await rig.play("施展 透骨指");
    expect(rig.lines.join("")).toContain("你此刻并不同人交手");

    // The new game's opening loadout is FULL — a fresh equip of anything
    // known answers alreadyEquipped (D13's no-silent-reorder face).
    await rig.play("激发 劈风掌");
    expect(rig.lines.join("")).toContain("这一招已在手上。");
    await rig.play("激发 无名神功");
    expect(rig.lines.join("")).toContain("你并未学过这一招。");

    // The reorder path IS the pair: unequip, then equip again — the
    // confirmation line is the session's own, and the slot's TAIL is where
    // the re-equipped martial lands.
    await rig.play("收招 劈风掌");
    expect(rig.lines.join("")).toContain("你收了「劈风掌」");
    const unequipped = (rig.store.saved.at(-1)!.data as {
      entities: Record<string, { martial?: string[] }>;
    }).entities["player"]!.martial;
    expect(unequipped).not.toContain("mrt-lq-001");
    await rig.play("激发 劈风掌");
    expect(rig.lines.join("")).toContain("你将「劈风掌」激发在手。");
    const reordered = (rig.store.saved.at(-1)!.data as {
      entities: Record<string, { martial?: string[] }>;
    }).entities["player"]!.martial;
    expect(reordered).toEqual([
      "mrt-lq-002",
      "mrt-lq-003",
      "mrt-lq-004",
      "mrt-lq-001", // re-equipped at the TAIL — the strategy moved
    ]);

    // Mid-fight, the management pair rides the declarative gate; the very
    // next play after the opening answers the not-equipped face while the
    // fight is still young (Sun Biao at 76 HP — one wheel hand in). The
    // cooling and drained faces are the core suite's own deterministic
    // pins (combat-martial.test.ts); e2e shows the faces the hands race.
    await rig.play("打 孙彪");
    // Both mid-fight faces ride ONE-TICK steps: no rhythm hand comes due
    // inside them (the first is due at +2), so the wheel cannot race the
    // refusals — the reordered loadout kills Sun Biao fast once it turns.
    await rig.play("激发 劈风掌", 1);
    expect(rig.lines.join("")).toContain("刀兵未歇，此刻不成。");
    await rig.play("施展 无名神功", 1);
    expect(rig.lines.join("")).toContain("这一招你并未装在手上。");
  });
});
