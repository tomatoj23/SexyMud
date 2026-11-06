import { describe, expect, it } from "vitest";
import type { SaveStore, Snapshot, Viewport } from "@sexymud/core";
import { createGameSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { createHostClock } from "../src/game/hostClock.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { loadWuxiaPack } from "./wuxia-pack.js";
import type { StatusPanel } from "../src/ui/terminalView.js";

/**
 * The C4 hand-played chains (#59, AC11/AC12): the pre-equipped mental's
 * VISIBLE difference on the damage line, the one verb's two slots (raising
 * and gathering a mental through the same 激发/收招 pair), the slot's
 * byte-stable elision when emptied, and the old-save red line — a C3-era
 * record with no mental key resumes its fight unchanged. All through the
 * real session and the real content, the #57 rig's own discipline.
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

function makeRig(store: SaveStore = new MemoryStore()) {
  let wallMs = 1_000_000;
  const lines: string[] = [];
  const panels: StatusPanel[] = [];
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
  };
}

/** The walk to the back yard: north, west, check in, north. */
async function walkToYard(rig: ReturnType<typeof makeRig>) {
  await rig.play("北");
  await rig.play("西");
  await rig.play("住店");
  await rig.play("北");
}

/** The player record of the newest save. */
function playerRecord(store: SaveStore) {
  const data = (store as MemoryStore).saved.at(-1)!.data as {
    entities: Record<string, Record<string, unknown>>;
  };
  return data.entities["player"]!;
}

/** Rolls mid-fight escapes (one tick each) until the fight is over or gone. */
async function fightUntilClear(rig: ReturnType<typeof makeRig>) {
  const before = rig.lines.length;
  for (let escapes = 0; escapes < 40; escapes += 1) {
    await rig.play("南", 1);
    const produced = rig.lines.slice(before).join("");
    if (produced.includes("你且战且退，脱身而去。")) return;
    if (produced.includes("孙彪闷哼一声")) return;
  }
}

describe("the C4 hand-played chains over the shipped pack (#59)", () => {
  it("AC11/AC12 — the pre-equipped mental shows on the damage line, gathers, returns, elides (full line)", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("养气侠");
    await walkToYard(rig);

    // The new game's opening breath: the table's mental loadout rides the
    // same seeding as the martial one — the save carries it before any fight.
    expect(playerRecord(rig.store).mental).toEqual(["mnt-lq-001"]);

    // OPEN with the flat at work: (30 + 5) × (1 − 6/16) = 21.875 → 22 — the
    // bare fist's 19 plus the mental's 5, the visible difference (AC11).
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("一拳打向孙彪");
    expect(rig.lines.join("")).toContain("受创22点");

    // Mid-fight, the gate holds for the mental half too (C4-T3).
    await rig.play("激发 吐纳心法");
    expect(rig.lines.join("")).toContain("刀兵未歇");

    // GATHER the flat back out — the mental's own confirmation line, and the
    // slot's last member deletes the key outright (byte-stable elision).
    await rig.play("收招 伏波心法");
    expect(rig.lines.join("")).toContain("你收了「伏波心法」，内息归于丹田。");
    expect(playerRecord(rig.store).mental).toBeUndefined();
    expect("mental" in playerRecord(rig.store)).toBe(false);

    // Out of the fight, a fresh strike answers the BARE fist again — 19,
    // the pipe's own identity degenerate (AC3 on screen). The escape left
    // the yard (or the kill cleared it); walk back in either way.
    await fightUntilClear(rig);
    await rig.play("北");
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("受创19点");

    // RAISE another by name — the breath's own twin line, the slot's key
    // back. The second fight ends the sure way (the kill clears in place,
    // no walk back needed): beat until Sun Biao falls, then raise.
    const beforeEnding = rig.lines.length;
    for (let beats = 0; beats < 40; beats += 1) {
      await rig.play("南", 1);
      const produced = rig.lines.slice(beforeEnding).join("");
      if (produced.includes("孙彪闷哼一声") || produced.includes("你且战且退，脱身而去。")) break;
    }
    // The kill clears in place; the escape leaves for the hall — walk back
    // only when the hall is where the ending left us.
    if (rig.session.status().roomName === "迎宾客栈大堂") {
      await rig.play("北");
    }
    await rig.play("激发 吐纳心法");
    expect(rig.lines.join("")).toContain("你运起「吐纳心法」，内息暗自流转。");
    expect(playerRecord(rig.store).mental).toEqual(["mnt-lq-003"]);
  });

  it("AC12 — a C3-era save (no mental key) resumes its fight unchanged (the red line)", async () => {
    // Build the C3-era record by hand: a mid-fight save with the mental key
    // DELETED — exactly what a pre-#59 record looks like on the wire.
    const store = new MemoryStore();
    const rig = makeRig(store);
    await rig.session.startNewGame("旧档侠");
    await walkToYard(rig);
    await rig.play("打 孙彪");
    const data = store.saved.at(-1)!.data as {
      entities: Record<string, Record<string, unknown>>;
    };
    delete data.entities["player"]!.mental;

    // The wall restarts past the save's own nowTick (the opening fight
    // saved around 1_015_000): a resume from BEFORE the save would be a
    // negative span and settle nothing.
    let wallMs = 1_020_000;
    const lines: string[] = [];
    const resumed: GameSession = createGameSession({
      pack: PACK,
      store,
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
    wallMs += 3000;
    await resumed.heartbeat();
    // The resumed fight runs on with NO supply — the identity degenerate
    // holds mid-fight, and the mental slot reads absent, never "lost".
    expect(lines.join("")).toContain("孙彪受创");
    expect(playerRecord(store).mental).toBeUndefined();
  });
});
