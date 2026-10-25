import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CloudAuth } from "../src/game/cloudAuth.js";
import type { CloudSync } from "../src/game/cloudSync.js";
import type { OutputLine } from "@sexymud/core";
import { AuthPanel } from "../src/ui/AuthPanel.js";
import { CloudSavePanel } from "../src/ui/CloudSavePanel.js";
import type { TerminalView } from "../src/ui/terminalView.js";
import { GameTerminal } from "../src/ui/GameTerminal.js";
import { TitleScreen } from "../src/ui/TitleScreen.js";
import type { TitleScreenProps } from "../src/ui/TitleScreen.js";

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
  /**
   * A test-only gesture: drive the machine directly (a state the panel cannot
   * reach on its own) INSIDE `act` — the panel subscribes to the machine, so
   * a bare call would leave React's "not wrapped in act" warning as the only
   * trace of the re-render.
   */
  drive(work: () => Promise<unknown>): Promise<void>;
  unmount(): void;
}

/**
 * Lets every pending machine await settle before the act scope closes: a few
 * macrotask turns, not one — the machine's chains are microtasks today, and
 * the rig must not go quietly wrong the day one of them takes a real turn.
 */
async function turn(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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
    async drive(work: () => Promise<unknown>): Promise<void> {
      await act(async () => {
        await work();
        await turn();
      });
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * The login panel's rig (#42): the same query shape minus the picker —
 * AuthPanel's seams are its words too. Drive the auth state BEFORE mounting;
 * a post-mount transition would need its own `act` scope.
 */
export function mountAuthPanel(auth: CloudAuth): Pick<PanelRig, "text" | "unmount"> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(AuthPanel, { auth }));
  });
  return {
    text: () => container.textContent ?? "",
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * The game face's rig (#51): the terminal's seams are its words (the output
 * lines, the status line), its gestures (typing, submitting) and its NODES —
 * the append-only contract is pinned by holding a line's DOM node across a
 * later append and seeing it unmoved. The name box uses the native-setter
 * dance because React-controlled inputs reset a plain `.value` write.
 */

/** The typing gestures both game faces share (terminal and title screen). */
export interface TypingRig {
  /** Everything the player can currently read. */
  text(): string;
  /** The one button whose label is exactly `label`. */
  button(label: string): HTMLButtonElement;
  click(label: string): Promise<void>;
  /** The (single) text input's current value. */
  inputValue(): string;
  /** Types into the input, React-controlled. */
  typeInto(text: string): void;
  /** Submits the form the way Enter does (jsdom fires no submit on keydown). */
  pressEnter(): Promise<void>;
  /** Fires a REAL keydown Enter at the input — the explicit-submit pin. */
  pressKeyEnter(): Promise<void>;
  unmount(): void;
}

export interface GameRig extends TypingRig {
  /** The output stream's line texts, top to bottom. */
  outputLines(): string[];
  /** The output stream's line NODES — for the append-only pin. */
  outputNodes(): Element[];
  /** The status line's text. */
  statusLine(): string;
  /** Feeds the terminal's own append face (the buffer-cap pin's gesture). */
  appendLines(lines: readonly OutputLine[]): void;
  /**
   * Drives the machine directly INSIDE `act` (PanelRig.drive's semantics):
   * a session call no panel gesture covers re-renders the terminal just the
   * same, and this keeps React's act accounting honest.
   */
  drive(work: () => Promise<unknown>): Promise<void>;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("game rig: no native value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function textInputOf(container: HTMLElement, what: string): HTMLInputElement {
  const found = container.querySelector("input[type='text']");
  if (!(found instanceof HTMLInputElement)) throw new Error(`game rig: no ${what} mounted`);
  return found;
}

function buttonOf(container: HTMLElement, label: string): HTMLButtonElement {
  const all = [...container.querySelectorAll("button")];
  const found = all.find((candidate) => candidate.textContent?.trim() === label);
  if (found === undefined) {
    throw new Error(
      `game rig: no "${label}" button — labels present: ${all
        .map((candidate) => JSON.stringify(candidate.textContent?.trim()))
        .join(", ")}`,
    );
  }
  return found;
}

/** The typing half both rigs share, bound to one mounted container. */
function typingRigOf(container: HTMLElement, input: () => HTMLInputElement): Omit<TypingRig, "unmount"> {
  return {
    text: () => container.textContent ?? "",
    button: (label: string) => buttonOf(container, label),
    async click(label: string) {
      const target = buttonOf(container, label);
      await act(async () => {
        target.click();
        await turn();
      });
    },
    inputValue: () => input().value,
    typeInto(text: string) {
      act(() => {
        setInputValue(input(), text);
      });
    },
    async pressEnter() {
      const form = input().form;
      if (form === null) throw new Error("game rig: the input sits in no form");
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await turn();
      });
    },
    async pressKeyEnter() {
      await act(async () => {
        input().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        await turn();
      });
    },
  };
}

export function mountTerminal(view: TerminalView): GameRig {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(GameTerminal, { view }));
  });
  const input = () => textInputOf(container, "command input");
  const log = (): Element => {
    const found = container.querySelector('[role="log"]');
    if (found === null) throw new Error("game rig: no output stream mounted");
    return found;
  };
  return {
    ...typingRigOf(container, input),
    outputLines: () => [...log().children].map((line) => line.textContent ?? ""),
    outputNodes: () => [...log().children],
    statusLine: () => container.querySelector("[data-status]")?.textContent ?? "",
    appendLines: (lines: readonly OutputLine[]) => {
      act(() => {
        view.appendOutput(lines);
      });
    },
    async drive(work: () => Promise<unknown>) {
      await act(async () => {
        await work();
        await turn();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * The title screen's rig (#51): the typing gestures over the name box —
 * what the test asserts beyond them is what `onNewGame` received.
 */
export function mountTitleScreen(props: TitleScreenProps): TypingRig {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(TitleScreen, props));
  });
  return {
    ...typingRigOf(container, () => textInputOf(container, "name input")),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
