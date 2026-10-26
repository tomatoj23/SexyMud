// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { lineOf } from "@sexymud/core";
import type { SaveStore, Snapshot } from "@sexymud/core";
import { createPlayableSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { mountTerminal, type GameRig } from "./panel-rig.js";
import { loadWuxiaPack } from "./wuxia-pack.js";

/**
 * The render half of #51 (the panel-rig seam, #48's test decision 2): the
 * terminal as the player meets it — mounted over a REAL session and the
 * REAL shipped content, jsdom driving the same DOM the browser gets. The
 * pins are the append-only contract (a held line node survives the next
 * append unmoved — no full re-render), the buffer cap (500 lines, earliest
 * dropped), the status line and the input box's round trip.
 */

class MemoryStore implements SaveStore {
  async load(): Promise<Snapshot | null> {
    return null;
  }
  async save(): Promise<void> {}
}

/** A fully wired game — session, view and the mounted terminal over both. */
function mountGame(): { rig: GameRig; session: GameSession } {
  const game = createPlayableSession({
    pack: loadWuxiaPack(),
    store: new MemoryStore(),
    viewport: { width: 40, height: 24 },
    copy: WEB_HOST_COPY,
  });
  return { rig: mountTerminal(game.view), session: game.session };
}

const mounted: { unmount(): void }[] = [];

afterEach(() => {
  for (const rig of mounted.splice(0)) rig.unmount();
});

describe("the mounted terminal — the status line and the opening (#51 AC3)", () => {
  it("shows where the player stands and the game hour, derived not stored", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await rig.drive(() => session.startNewGame(""));

    expect(rig.statusLine()).toBe("柳青镇镇口 · 子时");
    expect(rig.outputLines()[0]).toBe("你行至柳青镇口，脚下官道化作青石街面。");
    expect(rig.outputLines()[1]).toBe("〔柳青镇镇口〕");
  });
});

describe("the output stream — append-only, capped (#51 AC3, #48 D8)", () => {
  it("appends without rewriting what is already there: a held node stays the first line", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await rig.drive(() => session.startNewGame(""));

    const firstNode = rig.outputNodes()[0] as Node;
    const firstText = rig.outputLines()[0];
    const countBefore = rig.outputNodes().length;

    await rig.typeInto("说 且听下回分解，这行话长一些，正好试一试追加");
    await rig.pressEnter();

    // The held node is STILL the stream's first line — same object, same
    // place; only new lines joined below (no full re-render, #48 D8).
    expect(rig.outputNodes()[0]).toBe(firstNode);
    expect(rig.outputLines()[0]).toBe(firstText);
    expect(rig.outputNodes().length).toBeGreaterThan(countBefore);
  });

  it("caps the buffer at 500 lines, dropping the earliest (#48 D8: 长会话不卡)", () => {
    const { rig } = mountGame();
    mounted.push(rig);

    const filler = Array.from({ length: 600 }, (_, at) =>
      lineOf([{ text: `第${String(at).padStart(3, "0")}行`, style: "plain" }]),
    );
    rig.appendLines(filler);

    const lines = rig.outputLines();
    expect(lines.length).toBe(500);
    expect(lines[0]).toBe("第100行"); // the first 100 dropped, the rest kept in order
    expect(lines.at(-1)).toBe("第599行");
  });

  it("a drop removes only the dropped lines' nodes — the survivors keep theirs", () => {
    const { rig } = mountGame();
    mounted.push(rig);

    const first = Array.from({ length: 600 }, (_, at) =>
      lineOf([{ text: `第${String(at).padStart(3, "0")}行`, style: "plain" }]),
    );
    rig.appendLines(first); // capped at once: 第100行 onward is carried
    const survivor = rig.outputNodes()[100] as Node; // 第200行 — carried, mid-buffer

    const more = Array.from({ length: 100 }, (_, at) =>
      lineOf([{ text: `续${String(at).padStart(3, "0")}行`, style: "plain" }]),
    );
    rig.appendLines(more); // 700 fed → the earliest 200 drop in total

    expect(rig.outputNodes()[0]).toBe(survivor); // same node, now first
    expect(rig.outputLines()[0]).toBe("第200行");
    expect(rig.outputNodes().length).toBe(500);
  });
});

describe("the command box — typing reaches the game, output answers (#51 AC3/AC4)", () => {
  it("sends through the button and through Enter, both through the one channel", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await session.startNewGame("");

    await rig.typeInto("说 按钮发送");
    await rig.click("发送");
    expect(rig.outputLines()).toContain("你说：按钮发送");
    expect(rig.inputValue()).toBe(""); // the box clears after a send

    await rig.typeInto("说 回车发送");
    await rig.pressEnter();
    expect(rig.outputLines()).toContain("你说：回车发送");
  });

  it("a real keydown Enter submits too — no reliance on implicit form submission", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await session.startNewGame("");

    await rig.typeInto("说 键入回车");
    await rig.pressKeyEnter();

    // Some embedded webviews never run the implicit submission (verified in
    // the in-app browser: a trusted, unprevented Enter fires no submit) —
    // the explicit keydown path is what carries those hosts.
    expect(rig.outputLines()).toContain("你说：键入回车");
    expect(rig.inputValue()).toBe("");
  });

  it("walks north from the box and the status line follows", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await rig.drive(() => session.startNewGame(""));

    await rig.typeInto("北");
    await rig.pressEnter();

    expect(rig.statusLine()).toBe("柳青镇街市 · 子时");
    expect(rig.outputLines()).toContain("你来到了柳青镇街市。");
  });
});

describe("the input gate — strip and cap before the engine (#54, spec/05 §8.1)", () => {
  it("an embedded newline cannot forge an output line — the #51 finding, green", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await rig.drive(() => session.startNewGame(""));

    await rig.typeInto("说 甲\n乙");
    await rig.pressEnter();

    // The forgery was: the newline rode into the say line's text and
    // `white-space: pre` rendered it as an extra visible line. The gate
    // rebuilds the line before the engine sees it, so the event's text
    // carries no newline — and no DOM line ever does.
    expect(rig.outputLines()).toContain("你说：甲乙");
    for (const line of rig.outputLines()) {
      expect(line.includes("\n")).toBe(false);
    }
  });

  it("a line past the host's cap (200) is truncated at the gate, code points whole", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await rig.drive(() => session.startNewGame(""));

    await rig.typeInto(`说 ${"甲".repeat(205)}`);
    await rig.pressEnter();

    // The gate keeps 200 code points — 「说 」 plus 198 of the 205 — so the
    // engine and the say line see exactly that (joined: the long line folds
    // across several DOM rows at the 40-column viewport).
    const said = rig.outputLines().join("");
    expect(said).toContain(`你说：${"甲".repeat(198)}`);
    expect(said.match(/甲/g)?.length ?? 0).toBe(198);
  });

  it("a line of nothing but control characters settles nothing — no echo, no save", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await rig.drive(() => session.startNewGame(""));
    const before = rig.outputLines().length;

    await rig.typeInto("\n\u202e\x00");
    await rig.pressEnter();

    expect(rig.outputLines().length).toBe(before);
    expect(rig.inputValue()).toBe("");
  });
});
