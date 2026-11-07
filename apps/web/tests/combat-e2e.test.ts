import { describe, expect, it } from "vitest";
import type { SaveStore, Snapshot, Viewport } from "@sexymud/core";
import { createGameSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { createHostClock } from "../src/game/hostClock.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { loadWuxiaPack } from "./wuxia-pack.js";
import type { StatusPanel } from "../src/ui/terminalView.js";

/**
 * The hand-played whole chains (#57 over #56): the opening strike and the
 * rhythm that follows it (no more immediate retaliation — the guard's hand
 * arrives on HER interval, at the next observation), the death that now
 * CLEARS the session (a further strike opens a brand-new fight, not a
 * corpse refusal), the escape door, and AC12's full line — open, exchange,
 * escape, walk into a proactive room and be ambushed, kill, clear, reopen.
 *
 * All through the REAL shipped content, the real session, and a scripted
 * wall clock. The automatic heartbeat is parked (a period the test never
 * reaches) and the beats are DRIVEN by hand — the rig moves the wall, then
 * beats, so every rhythm assertion is deterministic. The dice are the
 * session's own seed-1 stream: fixed input ⇒ fixed output.
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

/** A rig whose wall clock stands still until the test moves it. */
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
    // The automatic heartbeat is parked at an hour: the rig drives every
    // beat by hand below, so a rhythm assertion never races a timer.
    heartbeatMs: 3_600_000,
    onOutput: (chunks) => {
      for (const chunk of chunks) for (const line of chunk) lines.push(line.text);
    },
    onStatus: (panel) => panels.push(panel),
  });
  return {
    session,
    lines,
    panels,
    store,
    /** Moves the wall by whole seconds; each command reads the new "now". */
    async play(input: string, secondsLater = 3) {
      wallMs += secondsLater * 1000;
      await session.submit(input);
    },
    /** Moves the wall and drives one beat — the idle-fight's live face. */
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

describe("the hand-played combat chains over the shipped pack (#56/#57)", () => {
  it("opens, exchanges on rhythm, poisons, kills — and a further strike is a NEW fight (D6)", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("测试侠");
    await walkToYard(rig);
    expect(rig.session.status().roomName).toBe("迎宾客栈后院");

    // The OPENING hand lands now (C1's feel, kept) — and NO retaliation
    // rides it anymore: the guard's first hand is due on her interval.
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("一拳打向孙彪");
    expect(rig.lines.join("")).not.toContain("还了一手");

    // The exchange runs on the rhythm: each beat settles the due hands —
    // the player's (the hit line) and the guard's (the retaliation line,
    // now the settle layer's, stamped with its due tick).
    let beats = 0;
    while (beats < 40) {
      await rig.beat(3);
      beats += 1;
      if (rig.lines.join("").includes("孙彪闷哼一声")) break;
    }
    const text = rig.lines.join("");
    // 破坏性③'s pinned retaliation line — present, on the rhythm.
    expect(text).toContain("孙彪还了一手");
    // The poison hopped into the terminal (the dotTick render, unchanged).
    expect(text).toContain("孙彪毒性发作");
    // Sun Biao died on screen.
    expect(text).toContain("孙彪闷哼一声");

    // D6: the death CLEARED the session — the autosave carries no fight
    // (C1's targetDead corpse mark is gone with the whole session).
    const dead = rig.store.saved.at(-1)!;
    const deadRecord = (dead.data as { entities: Record<string, { combat?: unknown }> })
      .entities["player"]!;
    expect(deadRecord.combat).toBeUndefined();

    // A further strike OPENS a brand-new fight at full HP (破坏性①: the
    // corpse refusal is unreachable under C2).
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("一拳打向孙彪");
    const reopened = rig.store.saved.at(-1)!;
    const session = (reopened.data as {
      entities: Record<string, { combat?: { targetHp?: number; targetDead?: boolean } }>;
    }).entities["player"]!.combat!;
    expect(session.targetDead).toBe(false);
    expect(session.targetHp).toBe(118); // the fresh 140-HP fight, 22 in (the pre-equipped mental flat rides every hand, #59).
  });

  it("pins the FIRST-hand timing: no retaliation on the strike itself, both hands on the next beat", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("测试侠");
    await walkToYard(rig);

    // The strike command's own output: the player's hand only (破坏性③'s
    // dedicated timing pin — C1's immediate-retaliation example, rewritten).
    await rig.play("打 孙彪");
    const afterStrike = rig.lines.join("");
    expect(afterStrike).toContain("孙彪受创");
    expect(afterStrike).not.toContain("还了一手");

    // One beat later (wall +3s, both hands due at +2): the player's
    // auto-hand lands and the guard answers on the formula — 15 × (1 −
    // 3/13) → 12 (破坏性②: the bare 15 is retired).
    await rig.beat(3);
    const afterBeat = rig.lines.join("");
    expect(afterBeat).toContain("孙彪还了一手，你受创12点。");
  });

  it("resumes a pre-#56 save into a fight — attrs seeded, rhythm seeded, no fatal line", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("旧档侠");
    await walkToYard(rig);
    const legacy = rig.store.saved.at(-1)!;
    // Strip the pre-#56 face: no attrs, no combat.
    const legacyEntities = (legacy.data as {
      entities: Record<string, Record<string, unknown>>;
    }).entities;
    delete legacyEntities["player"]!.attrs;
    delete legacyEntities["player"]!.combat;
    const legacyStore: SaveStore = {
      load: async () => legacy,
      save: async () => {},
    };
    const lines: string[] = [];
    let wallMs = 2_000_000;
    const resumed = createGameSession({
      pack: PACK,
      store: legacyStore,
      viewport: { width: 40, height: 24 },
      copy: WEB_HOST_COPY,
      hostClock: createHostClock({ tickSeconds: 1, now: () => wallMs }),
      heartbeatMs: 3_600_000,
      onOutput: (chunks) => {
        for (const chunk of chunks) for (const line of chunk) lines.push(line.text);
      },
      onStatus: () => {},
    });
    await resumed.continueGame();
    wallMs += 3000;
    await resumed.submit("打 孙彪");
    const text = lines.join("");
    expect(text).toContain("孙彪受创");
    // The rhythm was seeded at the OPENING (a C1 save has no rhythm pair):
    // no retaliation on the strike itself —
    expect(text).not.toContain("还了一手");
    // — and the seeded exchange runs on the next beat (AC12's first half).
    wallMs += 3000;
    await resumed.heartbeat();
    expect(lines.join("")).toContain("孙彪还了一手");
    // No wiring line surfaced: the seeds made the fight legal.
    expect(lines.join("")).not.toContain(WEB_HOST_COPY.submitFailed);
  });

  it("resumes a C1 save MID-FIGHT — the load-point restart holds the owed hands (AC12 first half, D3)", async () => {
    // The AC12 face the third example cannot cover: a save that still
    // CARRIES a combat session (no rhythm pair, a C1 shape) and resumes
    // INTO the fight. The load point must seed the rhythm at the wall's
    // now — one exchange on the next beat, NOT thousands of owed hands
    // settled from the save's ancient tick (ADR-0016: offline fights
    // nobody's fights). This is also the only test that bites the
    // continueGame → resumeCombatSession wiring itself.
    const rig = makeRig();
    await rig.session.startNewGame("续战侠");
    await walkToYard(rig);
    const saved = rig.store.saved.at(-1)!;
    const entities = (saved.data as {
      entities: Record<string, Record<string, unknown>>;
    }).entities;
    // A C1-shaped mid-fight save: the session rides whole, rhythm pair
    // absent, the save's nowTick ancient relative to the resumed wall.
    entities["player"]!.combat = {
      targetNpcId: "npc-lq-003",
      targetHp: 100,
      targetDead: false,
    };
    (saved.data as { nowTick?: number }).nowTick = 100;

    const lines: string[] = [];
    let wallMs = 3_000_000;
    const resumed = createGameSession({
      pack: PACK,
      store: { load: async () => saved, save: async () => {} },
      viewport: { width: 40, height: 24 },
      copy: WEB_HOST_COPY,
      hostClock: createHostClock({ tickSeconds: 1, now: () => wallMs }),
      heartbeatMs: 3_600_000,
      onOutput: (chunks) => {
        for (const chunk of chunks) for (const line of chunk) lines.push(line.text);
      },
      onStatus: () => {},
    });
    await resumed.continueGame();
    // One beat: the seeded rhythm owes exactly one exchange (both hands due
    // at wall +2, the beat reads wall +3) — not a catch-up pile.
    const before = lines.length;
    wallMs += 3000;
    await resumed.heartbeat();
    const produced = lines.slice(before).join("");
    // The rhythm hand is the WHEEL's (#58 D6): the save carried the new
    // game's equipped slot, and the first castable martial is 透骨指 —
    // INTERNAL delivery against Sun Biao's 0 internal defense, so
    // (30 × 1.5 + 5) × (1 − 0/10) → 50 — the flat rides the post-multiplier
    // base (#59): the number only D9's routing produces
    // (an external hand reads his 6 defense and lands 23).
    expect(produced).toContain("一招「透骨指」打向孙彪");
    expect(produced).toContain("孙彪受创50点");
    // The guard's hand landed NOTHING this beat — the player's dodge roll
    // won this fixed draw (#58 D8: a won roll is the WHOLE hand missing,
    // F2's symmetry on the receiving side).
    expect(produced).toContain("闪过了孙彪的攻势");
    expect(produced).not.toContain("还了一手");
    // The beat's regeneration span refilled exactly the cast's cost (#58
    // D7): 15 back into the internal force — the only resource under its
    // max (the hp rides full, so it stays silent).
    expect(produced).toContain("回复了15点内力");
    // And nothing else settled: one exchange — the strike-word count stays
    // small (no catch-up pile of owed hands).
    const strikes = produced.match(/拳|还了一手/g) ?? [];
    expect(strikes.length).toBeLessThanOrEqual(4);
    expect(produced).not.toContain(WEB_HOST_COPY.submitFailed);
  });
});

describe("AC12 — the full line: open, exchange, escape, ambush, kill, clear, reopen (#57)", () => {
  it("walks the whole road with the shipped pack", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("全链侠");

    // OPEN: strike Sun Biao in the back yard — the first hand lands now.
    await walkToYard(rig);
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("一拳打向孙彪");

    // EXCHANGE: a beat settles both due hands.
    await rig.beat(3);
    expect(rig.lines.join("")).toContain("孙彪还了一手");

    // ESCAPE: mid-fight moves roll until one lands — each miss spends a
    // hand's time and says so; the hit clears the fight and moves out.
    // One tick per attempt (#59): the pre-equipped mental's flat lifted every
    // hand, and Sun Biao no longer outlives a 3-tick attempt span — a shorter
    // step keeps the roll alive without touching the fight's arithmetic.
    let escapes = 0;
    while (escapes < 30) {
      await rig.play("南", 1);
      escapes += 1;
      const produced = rig.lines.join("");
      if (produced.includes("你且战且退，脱身而去。")) break;
      expect(produced).toContain("脱不开身");
    }
    expect(rig.session.status().roomName).toBe("迎宾客栈大堂");
    expect(rig.lines.join("")).toContain("你且战且退，脱身而去。");

    // AMBUSH: the market's north door opens into the ruined temple — the
    // proactive brute's hand is the first thing through it.
    await rig.play("东");
    await rig.play("北");
    expect(rig.session.status().roomName).toBe("镇北破庙");
    expect(rig.lines.join("")).toContain("泼皮还了一手，你受创");

    // KILL: the exchange runs — the player's auto-hands (25 a hand against
    // the brute's 2 defense) — until the brute falls.
    let beats = 0;
    while (beats < 40) {
      await rig.beat(3);
      beats += 1;
      if (rig.lines.join("").includes("泼皮闷哼一声")) break;
    }
    expect(rig.lines.join("")).toContain("泼皮闷哼一声");

    // CLEAR: the death took the whole session — the save carries no fight.
    const killed = rig.store.saved.at(-1)!;
    const killedRecord = (killed.data as { entities: Record<string, { combat?: unknown }> })
      .entities["player"]!;
    expect(killedRecord.combat).toBeUndefined();

    // REOPEN: a fresh strike at the same name is a brand-new full-HP fight.
    await rig.play("打 泼皮");
    expect(rig.lines.join("")).toContain("一拳打向泼皮");
    const reopened = rig.store.saved.at(-1)!;
    const session = (reopened.data as {
      entities: Record<string, { combat?: { targetHp?: number } }>;
    }).entities["player"]!.combat!;
    expect(session.targetHp).toBe(31); // the fresh 60-HP fight, 29 in (the pre-equipped mental's flat rides the opening fist too, #59).
  });
});
