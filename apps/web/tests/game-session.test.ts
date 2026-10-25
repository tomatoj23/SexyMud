import { describe, expect, it } from "vitest";
import {
  SAVE_VERSION,
  displayWidth,
} from "@sexymud/core";
import type { OutputLine, SaveStore, Snapshot, Viewport } from "@sexymud/core";
import { createGameSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { loadPack } from "../src/game/pack.js";
import type { LoadedPack } from "../src/game/pack.js";
import { loadWuxiaPack, readPackFiles } from "./wuxia-pack.js";
import type { StatusPanel } from "../src/ui/terminalView.js";

/**
 * The tracer bullet's engine-side seam (#51's harness half, #48's test
 * decision 3): the game session driven end to end over the REAL shipped
 * content — files read off disk exactly the way the core tests read them
 * (traversal-chain's own precedent), the loader the browser feed shares,
 * and the session that plays host through the engine's one command harness.
 *
 * What these pins hold is external behaviour only: the lines the player
 * reads, the status the player sees, the save the store received — never
 * the session's internals.
 */

const PACK: LoadedPack = loadWuxiaPack();

/** An in-memory SaveStore — the pins want the saves, not the storage. */
class MemoryStore implements SaveStore {
  readonly saved: Snapshot[] = [];
  async load(): Promise<Snapshot | null> {
    return this.saved.at(-1) ?? null;
  }
  async save(snapshot: Snapshot): Promise<void> {
    this.saved.push(snapshot);
  }
}

interface SessionRig {
  session: GameSession;
  lines: string[];
  panels: StatusPanel[];
  store: SaveStore;
}

/** A session with collectors wired — one rig per scenario, fresh state. */
function makeSession(
  viewport: Viewport = { width: 40, height: 24 },
  store: SaveStore = new MemoryStore(),
): SessionRig {
  const lines: string[] = [];
  const panels: StatusPanel[] = [];
  const session = createGameSession({
    pack: PACK,
    store,
    viewport,
    copy: WEB_HOST_COPY,
    onOutput: (chunks) => {
      for (const chunk of chunks) {
        for (const line of chunk) lines.push(line.text);
      }
    },
    onStatus: (panel) => panels.push(panel),
  });
  return { session, lines, panels, store };
}

describe("world guidance — a new game lands on the declared start room (#48 D4, #51 AC2)", () => {
  it("reads the enterText first, then the room's look, all from shipped content", async () => {
    const rig = makeSession();
    await rig.session.startNewGame("");

    expect(rig.session.playerName()).toBe("少侠");
    // The declared start room (#49): room-lq-001.
    expect(rig.session.status().roomName).toBe("柳青镇镇口");
    // First beat: the arrival narrative, host-authored from content data —
    // no event carried it (Q7).
    expect(rig.lines[0]).toBe("你行至柳青镇口，脚下官道化作青石街面。");
    // Second beat: the automatic look — the same chain every command walks.
    expect(rig.lines[1]).toBe("〔柳青镇镇口〕");
    expect(rig.lines.some((line) => line.startsWith("官道到此收窄"))).toBe(true);
    expect(rig.lines).toContain("出路：北");
    expect(rig.lines).toContain("这里有：货郎×1");
  });

  it("takes the given display name; the actor id stays the fixed `player`", async () => {
    const store = new MemoryStore();
    const rig = makeSession({ width: 40, height: 24 }, store);
    await rig.session.startNewGame("  张三丰  ");

    expect(rig.session.playerName()).toBe("张三丰");
    // Stance renders the actor's own say line as the pronoun, so the name
    // shows where a THIRD party would see it — but the save never derives
    // an id from it: the entity under the tree is `player`, always.
    await rig.session.submit("说 在下初来乍到");
    expect(rig.lines).toContain("你说：在下初来乍到");
    const saved = store.saved.at(-1) as { data: { entities: Record<string, unknown> } };
    expect(Object.keys(saved.data.entities)).toEqual(["player"]);
  });

  it("saves once the opening has settled — the first autosave", async () => {
    const store = new MemoryStore();
    const rig = makeSession({ width: 40, height: 24 }, store);
    await rig.session.startNewGame("少侠");
    expect(store.saved.length).toBe(1);
  });

  it("words the hour from the PACK's segment label; absent label falls back to the raw id (owner ruling, #51 D2)", async () => {
    // The shipped pack's own segments carry the word — the pack's
    // vocabulary, the same law as a room's `name` (the labelled status line
    // is pinned throughout this file as 「子时」).
    expect(PACK.registry.calendar?.rings[0]?.segments[0]?.label).toBe("子时");

    // The label-less variant of the SAME pack reads the honest key back.
    const files = readPackFiles();
    const calendar = files["config/calendar.json"] as {
      rings: { segments: { label?: string }[] }[];
    };
    for (const ring of calendar.rings) {
      for (const segment of ring.segments) {
        delete segment.label;
      }
    }
    const bare = createGameSession({
      pack: loadPack(files, WEB_HOST_COPY),
      store: { load: async () => null, save: async () => {} },
      viewport: { width: 40, height: 24 },
      copy: WEB_HOST_COPY,
      onOutput: () => {},
      onStatus: () => {},
    });
    await bare.startNewGame("");
    expect(bare.status().hourLabel).toBe("zi");
  });
});

describe("the command walk through the engine's one harness (#51 AC4)", () => {
  it("walks north: departure, arrival narrative, and the status line follows", async () => {
    const rig = makeSession();
    await rig.session.startNewGame("");
    await rig.session.submit("北");

    expect(rig.lines).toContain("你离开了柳青镇镇口。");
    expect(rig.lines).toContain("你来到了柳青镇街市。");
    expect(rig.lines).toContain("你走进柳青镇街市，市声盈耳。");
    expect(rig.session.status().roomName).toBe("柳青镇街市");
    expect(rig.panels.at(-1)?.hourLabel).toBe("子时");
  });

  it("looks again on demand: the look verb goes through the same binding table", async () => {
    const rig = makeSession();
    await rig.session.startNewGame("");
    await rig.session.submit("l");

    const titles = rig.lines.filter((line) => line === "〔柳青镇镇口〕");
    expect(titles.length).toBe(2); // the automatic look, then the player's
  });

  it("speaks: the say line renders in the second person, verbatim text", async () => {
    const rig = makeSession();
    await rig.session.startNewGame("");
    await rig.session.submit("说 天色不错");

    expect(rig.lines).toContain("你说：天色不错");
  });

  it("shows the gate's refusal copy from the exit's JSON and moves nobody", async () => {
    const rig = makeSession();
    await rig.session.startNewGame("");
    await rig.session.submit("北"); // 001 → 002
    await rig.session.submit("西"); // 002 → 003
    await rig.session.submit("北"); // gated: needs the inn-lodger flag

    // The copy is content data (exit-lq-003-north's err_traverse), reached
    // through the injected errCopy face — the event carried only ids. It is
    // 76 columns wide, so it arrives FOLDED at the 40-column viewport; the
    // join reads it back as the sentence it is.
    expect(rig.lines.join("")).toContain(
      "掌柜的笑着拦住你：客官，后院是住店客人去处，打尖的客人请堂中坐。",
    );
    expect(rig.session.status().roomName).toBe("迎宾客栈大堂");
  });

  it("answers an unknown input with the host's line — and settles nothing", async () => {
    const store = new MemoryStore();
    const rig = makeSession({ width: 40, height: 24 }, store);
    await rig.session.startNewGame("");
    const savesBefore = store.saved.length;

    await rig.session.submit("咕哝");

    expect(rig.lines).toContain("「咕哝」是什么招式？");
    expect(store.saved.length).toBe(savesBefore); // invalid: no settlement
  });

  it("ignores blank input quietly", async () => {
    const rig = makeSession();
    await rig.session.startNewGame("");
    const lineCount = rig.lines.length;

    await rig.session.submit("   ");

    expect(rig.lines.length).toBe(lineCount);
  });
});

describe("autosave — every settled command saves the live world (#51 AC6)", () => {
  it("saves after each command with the engine's snapshot shape", async () => {
    const store = new MemoryStore();
    const rig = makeSession({ width: 40, height: 24 }, store);
    await rig.session.startNewGame(""); // save 1 (the opening)
    await rig.session.submit("看"); // save 2
    await rig.session.submit("说 安好"); // save 3

    expect(store.saved.length).toBe(3);
    const snapshot = store.saved.at(-1);
    expect(snapshot?.version).toBe(SAVE_VERSION);
    expect(snapshot?.data).toHaveProperty("entities.player.locationId", "room-lq-001");
  });

  it("a failing store stays visible — one line, and the game plays on", async () => {
    const failing: SaveStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error("QuotaExceededError")),
    };
    const rig = makeSession({ width: 40, height: 24 }, failing);
    await rig.session.startNewGame("");

    // The prompt is 44 columns — it too arrives folded; join reads it whole.
    expect(rig.lines.join("")).toContain(WEB_HOST_COPY.saveFailed);
    await rig.session.submit("看");
    expect(
      rig.lines.join("").split(WEB_HOST_COPY.saveFailed).length - 1,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("the chunker's inputs are live — width folds, both ends real (#51 AC3)", () => {
  it("folds at the given width: no line exceeds it, and narrower folds more", async () => {
    const narrow = makeSession({ width: 10, height: 8 });
    await narrow.session.startNewGame("");
    for (const line of narrow.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }

    const wide = makeSession({ width: 80, height: 8 });
    await wide.session.startNewGame("");
    // The same description folds into more physical lines when narrower.
    expect(narrow.lines.length).toBeGreaterThan(wide.lines.length);
  });
});
