// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App.js";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";

/**
 * The 「继续」 failure face, SPLIT BY TROUBLE CLASS (#52 复核 N-2, #53):
 * a real mounted App over a poisoned slot — the two troubles point at
 * opposite doors (#32 D4), so each class must show its OWN line and its own
 * exit, never the other's. Three poisons: envelope damage (the store's
 * corrupt verdict), payload damage (the engine's verdict — same door), and
 * storage that worked at the probe but not at the load (unavailable).
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

describe("「继续」 fails by class, each class with its own door (#53 N-2)", () => {
  it("damaged envelope → the corrupt line, and its exit walks into the overwrite ask", async () => {
    localStorage.setItem(GAME_SLOT_KEY, "{broken");
    await mountAppSettled();

    await clickButton("继续");

    expect(text()).toContain(WEB_HOST_COPY.continueFailed.corrupt);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.unavailable);
    // The exit opens the SAME ask 「新游戏」 fires — one flow, one set of
    // words (#53/N-2): the overwrite prompt with its confirm and cancel.
    // Its job done, the failure line steps aside for the ask.
    await clickButton(WEB_HOST_COPY.continueFailed.corruptExitLabel);
    expect(text()).toContain(WEB_HOST_COPY.overwrite.prompt);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.corrupt);
    expect(buttonLabels()).toContain(WEB_HOST_COPY.overwrite.confirmLabel);
    expect(buttonLabels()).toContain(WEB_HOST_COPY.overwrite.cancelLabel);

    // Confirming the ask opens the game (the terminal mounts over the doors).
    await clickButton(WEB_HOST_COPY.overwrite.confirmLabel);
    expect(container?.querySelector("[data-status]") ?? null).not.toBeNull();
  });

  it("damaged payload (the engine's verdict) lands on the same corrupt door", async () => {
    // Passes the store's ENVELOPE check, fails the engine's payload check —
    // two verdicts, one door: bytes that cannot be resumed mean overwrite.
    localStorage.setItem(GAME_SLOT_KEY, JSON.stringify({ version: 2, data: {} }));
    await mountAppSettled();

    await clickButton("继续");

    expect(text()).toContain(WEB_HOST_COPY.continueFailed.corrupt);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.unavailable);
  });

  it("storage unreachable at load → the unavailable line, and no overwrite exit", async () => {
    // The probe read bytes (the door lit), the load could not reach them:
    // this trouble's exit is the browser's settings, never a destructive
    // overwrite — the corrupt door's handle must not even render.
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    getItem.mockImplementationOnce(() => "{broken");
    getItem.mockImplementation(() => {
      throw new DOMException("storage denied", "SecurityError");
    });
    await mountAppSettled();

    await clickButton("继续");

    expect(text()).toContain(WEB_HOST_COPY.continueFailed.unavailable);
    expect(text()).not.toContain(WEB_HOST_COPY.continueFailed.corrupt);
    expect(buttonLabels()).not.toContain(WEB_HOST_COPY.continueFailed.corruptExitLabel);
  });
});
