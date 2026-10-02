import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CloudSync } from "../src/game/cloudSync.js";
import { CloudSavePanel } from "../src/ui/CloudSavePanel.js";

/**
 * The panel RENDER rig (W6 / #45) — the repo's first rendering test
 * infrastructure. Deliberately thin: one new dependency (`jsdom`), React's
 * own `act` for wrapping, and queries on text and buttons — the panel's real
 * seams are its words and its gestures, so a query library would add three
 * packages to restate `querySelectorAll("button")`.
 *
 * Everything a panel test does to the machine goes through a real
 * `CloudSync`; everything it observes goes through what is rendered. The
 * helper returns Promises for the gestures because a gesture starts machine
 * work that lands asynchronously — `act` must still be on duty when it does.
 */

// React reads this before deciding whether to warn about un-acted updates
// (react-dom-client); without it every store notification is noise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One mounted panel plus the gestures the tests need. */
export interface PanelRig {
  /** Everything the player can currently read. */
  text(): string;
  /** The one button whose label is exactly `label` (two doors never share a label). */
  button(label: string): HTMLButtonElement;
  /** The gesture: click the button and let the machine work it out. */
  click(label: string): Promise<void>;
  /** The pick: hand the hidden file input a save's text, as the picker would. */
  pickFile(text: string): Promise<void>;
  unmount(): void;
}

/** Lets every pending machine await settle before the act scope closes. */
function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function mountPanel(sync: CloudSync): PanelRig {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(CloudSavePanel, { sync }));
  });

  function button(label: string): HTMLButtonElement {
    const all = [...container.querySelectorAll("button")];
    const [found, extra] = all.filter((candidate) => candidate.textContent?.trim() === label);
    if (!found || extra) {
      throw new Error(
        `panel rig: wanted exactly one "${label}" button — labels present: ${all
          .map((candidate) => JSON.stringify(candidate.textContent?.trim()))
          .join(", ")}`,
      );
    }
    return found;
  }

  return {
    text: () => container.textContent ?? "",
    button,
    async click(label: string): Promise<void> {
      const target = button(label);
      await act(async () => {
        target.click();
        await turn();
      });
    },
    async pickFile(text: string): Promise<void> {
      const input = container.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error("panel rig: no file input to pick with");
      await act(async () => {
        const file = new File([text], "sexymud-save.json", { type: "application/json" });
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await turn();
      });
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}
