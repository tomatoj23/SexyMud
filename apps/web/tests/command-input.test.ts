// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { SaveStore, Snapshot } from "@sexymud/core";
import { createPlayableSession } from "../src/game/gameSession.js";
import type { GameSession } from "../src/game/gameSession.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { mountTerminal, type GameRig } from "./panel-rig.js";
import { loadWuxiaPack } from "./wuxia-pack.js";

/**
 * The command input component's pins (#53) — the input face that replaced
 * #51's temporary box. jsdom drives the same DOM the browser gets, with one
 * honest limit: jsdom has no IME, so these tests pin the LOGIC BRANCHES of
 * the composition guard on real composition events — which half of the line
 * each Enter lands on. The real-IME half (iOS/Android/desktop) is the
 * ticket's manual-verification checklist; it gates the close, not this file.
 *
 * Session state: the history lives in the component (one per game), so the
 * reopen pin is a remount over a FRESH session — and 不落盘 is pinned
 * directly against localStorage, which this whole flow must never touch.
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

async function startGame(rig: GameRig, session: GameSession): Promise<void> {
  await rig.drive(() => session.startNewGame(""));
}

describe("IME composition — Enter never submits the half-made input (G3, #53 AC1)", () => {
  it("holds every Enter while the composition is open, draft untouched", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);
    const before = rig.outputLines().length;

    await rig.typeInto("shuo hua");
    rig.composeStart();
    await rig.pressKeyEnter();

    // The committing Enter submitted NOTHING and wiped NOTHING — the
    // half-made pinyin is still the draft, exactly as the IME left it.
    expect(rig.outputLines().length).toBe(before);
    expect(rig.inputValue()).toBe("shuo hua");
  });

  it("holds the keydown that itself says a composition owns it (Chrome/Firefox)", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);
    const before = rig.outputLines().length;

    await rig.typeInto("shuo hua");
    // No composition events at all — the KEY carries the signal: Chrome and
    // Firefox fire the composition-owned keydown with isComposing true
    // before compositionstart ever reaches us. That key submits nothing.
    await rig.pressKey("Enter", { isComposing: true });
    expect(rig.outputLines().length).toBe(before);
    expect(rig.inputValue()).toBe("shuo hua");
  });

  it("still holds the Enter that arrives right after compositionend (WebKit's order)", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);
    const before = rig.outputLines().length;

    await rig.typeInto("shuo hua");
    rig.composeStart();
    rig.composeEnd();
    // WebKit fires the committing keydown AFTER compositionend with
    // isComposing already false — the guard's grace window (D2) must still
    // hold this Enter on the composing side of the line.
    await rig.pressKeyEnter();
    expect(rig.outputLines().length).toBe(before);
    expect(rig.inputValue()).toBe("shuo hua");

    // The grace is one macrotask; the Enter after it is a free key again.
    await rig.pressKeyEnter();
    expect(rig.outputLines().length).toBe(before + 1);
    expect(rig.outputLines().at(-1)).toBe(WEB_HOST_COPY.unknownCommand("shuo hua"));
  });

  it("submits normally once the composition is finished and flushed", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);

    await rig.typeInto("说 你好");
    rig.composeStart();
    rig.composeEnd();
    // The composition closed WITHOUT an Enter (a candidate picked, say) —
    // after the grace window there is no committing key to hold back, so
    // the next Enter submits the committed Chinese straight away.
    await rig.drive(async () => {});
    await rig.pressKeyEnter();

    // The committed Chinese went through as a real command — the say line
    // the engine rendered, not a held-back half-made anything.
    expect(rig.outputLines().some((line) => line.includes("你说：你好"))).toBe(true);
  });

  it("yields the history arrows to the IME while composing (D3)", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);

    await rig.typeInto("看");
    await rig.pressEnter();
    await rig.typeInto("x");
    rig.composeStart();
    await rig.pressKey("ArrowUp");
    await rig.pressKey("ArrowDown");
    // Candidate navigation owns the arrows: the draft is the IME's.
    expect(rig.inputValue()).toBe("x");

    rig.composeEnd();
    await rig.drive(async () => {});
    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("看");
  });
});

describe("command history — up/down over the session's commands (#53 AC3)", () => {
  it("browses back and forth, clamping at both ends and restoring the live draft", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);

    await rig.typeInto("看");
    await rig.pressEnter();
    await rig.typeInto("说 天下");
    await rig.pressEnter();
    await rig.typeInto("北");

    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("说 天下");
    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("看");
    // The oldest entry clamps: up again reads the same line.
    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("看");
    await rig.pressKey("ArrowDown");
    expect(rig.inputValue()).toBe("说 天下");
    // Down past the newest restores the draft the first up saved.
    await rig.pressKey("ArrowDown");
    expect(rig.inputValue()).toBe("北");
    // At live, down changes nothing.
    await rig.pressKey("ArrowDown");
    expect(rig.inputValue()).toBe("北");

    // A fresh submit returns the cursor to live: up reads the NEWEST.
    await rig.pressEnter();
    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("北");
  });

  it("records nothing for whitespace-only input", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);

    await rig.typeInto("看");
    await rig.pressEnter();
    await rig.typeInto("   ");
    await rig.pressEnter();
    await rig.typeInto("说 天下");
    await rig.pressEnter();

    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("说 天下");
    await rig.pressKey("ArrowUp");
    // The whitespace non-command never entered the history — the next older
    // entry is the real command before it, and the oldest clamps there.
    expect(rig.inputValue()).toBe("看");
    await rig.pressKey("ArrowUp");
    expect(rig.inputValue()).toBe("看");
  });

  it("is session state: a reopened game starts empty and nothing is persisted", async () => {
    const first = mountGame();
    mounted.push(first.rig);
    await startGame(first.rig, first.session);
    const keysBefore = Object.keys(localStorage).sort();

    await first.rig.typeInto("看");
    await first.rig.pressEnter();
    // 不落盘: the whole typing/submitting/history flow never touches storage.
    expect(Object.keys(localStorage).sort()).toEqual(keysBefore);

    first.rig.unmount();
    const second = mountGame();
    mounted.push(second.rig);
    await startGame(second.rig, second.session);

    await second.rig.pressKey("ArrowUp");
    // 重开即空: the fresh game's first up has nothing to recall — the draft
    // stays as typed.
    expect(second.rig.inputValue()).toBe("");
  });
});

describe("input hardening minimal face — verbatim, no markup interpreted (#53 AC4)", () => {
  it("shows what the player typed as plain text and echoes it as plain text", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);
    const container = document.body;

    const hostile = '说 <img src=x onerror=alert(1)>【危险】';
    await rig.typeInto(hostile);
    // The input box itself displays the raw characters, uninterpreted.
    expect(rig.inputValue()).toBe(hostile);
    await rig.pressEnter();

    // The output carries the payload VERBATIM (the say line quotes it)…
    expect(rig.outputLines().some((line) => line.includes("<img src=x onerror=alert(1)>"))).toBe(
      true,
    );
    // …and it stayed TEXT: no element the payload named ever exists — the
    // output side renders engine tokens only (spec/05 §8's minimal face).
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.querySelectorAll("b").length).toBe(0);
  });

  it("keeps the unknown-command echo literal too — markup never becomes an element", async () => {
    const { rig, session } = mountGame();
    mounted.push(rig);
    await startGame(rig, session);
    const container = document.body;

    await rig.typeInto("<b>加粗</b>");
    await rig.pressEnter();

    expect(rig.outputLines().at(-1)).toBe(WEB_HOST_COPY.unknownCommand("<b>加粗</b>"));
    expect(container.querySelectorAll("b").length).toBe(0);
  });
});
