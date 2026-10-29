// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";

/**
 * The in-game 「回标题」 door (#55): ending the current game is a CONFIRMED
 * gesture — the ask says the save keeps standing (never a silent drop), and
 * confirming lands back on the title screen with 「继续」 re-lit by the
 * bytes-exist rule. The same file pins the ticket's second face: the stale
 * overwrite signal must not masquerade as a fresh ask on the remount (the
 * #53 review's N-A, closed here because this ticket makes the remount
 * reachable).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function turn(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const GAME_SLOT_KEY = "game-slot-1";

let root: Root | undefined;
let container: HTMLElement | undefined;

function mountApp(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(App));
  });
}

const text = (): string => container?.textContent ?? "";

const buttonLabels = (): string[] =>
  [...(container?.querySelectorAll("button") ?? [])].map(
    (button) => button.textContent?.trim() ?? "",
  );

async function clickButton(label: string): Promise<void> {
  const target = [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === label,
  );
  if (target === undefined) {
    throw new Error(`no "${label}" button — present: ${buttonLabels().join(", ")}`);
  }
  await act(async () => {
    target.click();
    await turn();
  });
}

/** Mounted + the existence probe settled — the doors are lit or not. */
async function mountAppSettled(): Promise<void> {
  mountApp();
  await act(async () => {
    await turn();
  });
}

/** In the game: the title doors swapped for the terminal. */
const inGame = (): boolean => (container?.querySelector("[data-status]") ?? null) !== null;

afterEach(() => {
  if (root !== undefined) {
    act(() => root!.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("「回标题」 — a confirmed exit that keeps the save standing (#55 AC1)", () => {
  it("asks with the retention words; cancel keeps the game; confirm returns to a lit 「继续」", async () => {
    await mountAppSettled();

    await clickButton("新游戏"); // clean slot: no ask, straight in
    expect(inGame()).toBe(true);

    // The ask names both halves of the truth: the game ends, the save stays.
    await clickButton(WEB_HOST_COPY.backToTitle.exitLabel);
    expect(text()).toContain(WEB_HOST_COPY.backToTitle.ask);
    expect(buttonLabels()).toContain(WEB_HOST_COPY.backToTitle.confirmLabel);
    expect(buttonLabels()).toContain(WEB_HOST_COPY.backToTitle.cancelLabel);
    expect(inGame()).toBe(true); // the ask blocks nothing — the game is still up

    // Cancel: the ask steps aside, the session plays on.
    await clickButton(WEB_HOST_COPY.backToTitle.cancelLabel);
    expect(text()).not.toContain(WEB_HOST_COPY.backToTitle.ask);
    expect(inGame()).toBe(true);

    // Confirm: the title returns and 「继续」 is re-lit by the bytes the
    // session autosaved — then the lit door really resumes the game.
    await clickButton(WEB_HOST_COPY.backToTitle.exitLabel);
    await clickButton(WEB_HOST_COPY.backToTitle.confirmLabel);
    expect(inGame()).toBe(false);
    expect(buttonLabels()).toContain("继续");

    await clickButton("继续");
    expect(inGame()).toBe(true);
  });
});

describe("「回标题」 — the stale overwrite signal stays silent (#55 AC2, #53 N-A)", () => {
  it("损坏出口→取消→重开进局→回标题→再挂载：无确认框自开，手动「新游戏」仍问一次", async () => {
    localStorage.setItem(GAME_SLOT_KEY, "{broken");
    await mountAppSettled();

    // The corrupt exit raises the signal (count 1) and opens the ask…
    await clickButton("继续");
    await clickButton(WEB_HOST_COPY.continueFailed.corruptExitLabel);
    expect(text()).toContain(WEB_HOST_COPY.overwrite.prompt);
    // …and the player cancels — the ask closes, the count stays 1.
    await clickButton(WEB_HOST_COPY.overwrite.cancelLabel);
    expect(text()).not.toContain(WEB_HOST_COPY.overwrite.prompt);

    // Into a game (through the ask 「新游戏」 itself fires — count plays no
    // part), then back to the title: the remount must not read the stale
    // count as a fresh ask.
    await clickButton("新游戏");
    await clickButton(WEB_HOST_COPY.overwrite.confirmLabel);
    expect(inGame()).toBe(true);

    await clickButton(WEB_HOST_COPY.backToTitle.exitLabel);
    await clickButton(WEB_HOST_COPY.backToTitle.confirmLabel);
    expect(inGame()).toBe(false);
    expect(text()).not.toContain(WEB_HOST_COPY.overwrite.prompt);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.corrupt);

    // The ask itself is not broken — only its OUTSIDE door went edge-
    // triggered: a manual 「新游戏」 over the standing save still asks once.
    await clickButton("新游戏");
    expect(text()).toContain(WEB_HOST_COPY.overwrite.prompt);
  });
});

describe("「回标题」 — the returning title starts clean (#55 D4)", () => {
  it("a failure line from a previous title visit does not survive the round trip", async () => {
    // The unavailable verdict needs bytes at the probe and a throwing store
    // at the load — then the player starts a fresh game anyway (its autosave
    // writes through the unmocked half) and returns: no stale 「续档失败」.
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    getItem.mockImplementationOnce(() => "{broken");
    getItem.mockImplementation(() => {
      throw new DOMException("storage denied", "SecurityError");
    });
    await mountAppSettled();

    await clickButton("继续");
    expect(text()).toContain(WEB_HOST_COPY.continueFailed.unavailable);

    // Into a game anyway: the probe lit the door on bytes, so 「新游戏」
    // still asks once over them — the fresh start's autosave then writes
    // through the unmocked half.
    await clickButton("新游戏");
    await clickButton(WEB_HOST_COPY.overwrite.confirmLabel);
    expect(inGame()).toBe(true);

    await clickButton(WEB_HOST_COPY.backToTitle.exitLabel);
    await clickButton(WEB_HOST_COPY.backToTitle.confirmLabel);
    expect(inGame()).toBe(false);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.unavailable);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.corrupt);
  });
});
