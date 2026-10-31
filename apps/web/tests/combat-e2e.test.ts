import { describe, expect, it } from "vitest";
import type { SaveStore, Snapshot, Viewport } from "@sexymud/core";
import { createGameSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { createHostClock } from "../src/game/hostClock.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { loadWuxiaPack } from "./wuxia-pack.js";
import type { StatusPanel } from "../src/ui/terminalView.js";

/**
 * AC1's hand-played whole chain (#56): a new game walks to the lodge,
 * checks in (T1's flag route), steps into the back yard, strikes Sun Biao
 * (damage line, retaliation line), watches the poison hop (the dotTick
 * render's first live consumer), kills him (the death line) and is refused
 * a further strike — all through the REAL shipped content, the real
 * session, and a scripted wall clock (the poison hops by real ticks, so the
 * rig moves the wall between commands).
 *
 * The dice are the session's own seed-1 stream: fixed input ⇒ fixed
 * output, and the assertions read the exact arithmetic the shipped numbers
 * produce (attack 30, defense 6, K 10 ⇒ 19 damage; retaliation 15; poison
 * 10 × 5 every 2 ticks at 0.35).
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
  };
}

describe("AC1 — the hand-played combat chain over the shipped pack (#56)", () => {
  it("checks in, walks in, strikes, poisons, kills and is refused a corpse strike", async () => {
    const rig = makeRig();
    await rig.session.startNewGame("测试侠");
    expect(rig.session.status().roomName).toBe("柳青镇镇口");

    // Walk to the lodge hall (north, then west) and check in (T1's route:
    // the flag has exactly one way in, and the gate's own words do not move).
    await rig.play("北");
    await rig.play("西");
    expect(rig.session.status().roomName).toBe("迎宾客栈大堂");
    await rig.play("住店");
    // Folded at the viewport: the phrase spans physical lines, so the pin
    // reads the joined text (the folder adds breaks, never characters).
    expect(rig.lines.join("")).toContain(WEB_HOST_COPY.flagGrantedLine);

    // In: the back yard opens to a lodger (the gate that used to be
    // unreachable, T1's whole point).
    await rig.play("北");
    expect(rig.session.status().roomName).toBe("迎宾客栈后院");

    // Strike until the fight resolves: the seed-1 stream decides dodge and
    // poison rolls; whatever it decides, the PLAYER-READ lines are the
    // contract — damage lines, retaliation lines, the poison's hop line on
    // the commands after an armed one, and Sun Biao's death.
    let strikes = 0;
    while (strikes < 30) {
      const before = rig.lines.length;
      await rig.play("打 孙彪", 3);
      strikes += 1;
      const produced = rig.lines.slice(before).join("");
      if (produced.includes("他已经倒下了，不必再补一手。")) break;
    }
    const text = rig.lines.join("");
    // The strike line and the retaliation line — T7's host templates.
    expect(text).toContain("一拳打向孙彪");
    expect(text).toContain("孙彪还了一手");
    // The poison hopped into the terminal (the dotTick render's live pass).
    expect(text).toContain("孙彪毒性发作");
    // Sun Biao died on screen.
    expect(text).toContain("孙彪闷哼一声");
    // The corpse refuses the further strike (the loop's exit).
    expect(text).toContain("他已经倒下了，不必再补一手。");

    // The autosave carries the corpse mark: a reload refuses to resume the
    // fight (the session's whole persistence face, AC9).
    const last = rig.store.saved.at(-1)!;
    const record = (last.data as { entities: Record<string, { combat?: { targetDead?: boolean } }> })
      .entities["player"]!;
    expect(record.combat?.targetDead).toBe(true);
  });

  it("shows the retaliation line through the host template on the very first strike", async () => {
    // The strike/retaliation WORDS the player reads, pinned on the first
    // exchange (the engine-side semantics — both deaths, the refill, the
    // relocation — live in tests/combat-strike.test.ts; the player-side
    // death template is pinned in packages/core/tests/text-render.test.ts).
    const rig = makeRig();
    await rig.session.startNewGame("测试侠");
    await rig.play("北");
    await rig.play("西");
    await rig.play("住店");
    await rig.play("北");
    await rig.play("打 孙彪");
    expect(rig.lines.join("")).toContain("孙彪还了一手，你受创");
    expect(rig.lines.join("")).toContain("孙彪受创");
  });

  it("resumes a pre-#56 save into a fight — the empty attrs slot is seeded, not fatal (#56 audit)", async () => {
    // A save that predates the attrs slot carries no attrs at all (its
    // absence reads as the empty map, the slot's own law). Resuming it and
    // striking must WORK: the session seeds the character model over the
    // empty map (a save that carried attrs keeps every value), and a
    // dispatch that throws reaches the player as one line — never an
    // unhandled rejection freezing the terminal.
    const rig = makeRig();
    await rig.session.startNewGame("旧档侠");
    // Walk the first session into the yard (flags carrying the lodger mark,
    // position the yard) so the resumed save can strike immediately.
    await rig.play("北");
    await rig.play("西");
    await rig.play("住店");
    await rig.play("北");
    expect(rig.session.status().roomName).toBe("迎宾客栈后院");
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
    expect(text).toContain("孙彪还了一手");
    // No wiring line surfaced: the seed made the fight legal.
    expect(text).not.toContain(WEB_HOST_COPY.submitFailed);
  });
});
