// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountTitleScreen, type TypingRig } from "./panel-rig.js";

/**
 * The title screen's render pins (#51 AC1): one name box, one 「新游戏」
 * button, and the two name outcomes — a typed name travels verbatim, a
 * blank box travels the default 「少侠」. The name is a DISPLAY field
 * (#48 D4): what `onNewGame` receives is the name, never an id.
 *
 * #52 adds the save loop's door: 「继续」 lights only when a save exists,
 * and a new game over an existing save asks ONCE before overwriting.
 */

const mounted: { unmount(): void }[] = [];

afterEach(() => {
  for (const rig of mounted.splice(0)) rig.unmount();
});

function mount(received: string[]): TypingRig {
  const rig = mountTitleScreen({
    defaultName: "少侠",
    onNewGame: (name) => received.push(name),
  });
  mounted.push(rig);
  return rig;
}

describe("TitleScreen — the door into the world (#51 AC1)", () => {
  it("offers the name box and the one button — no save mounted, no 「继续」", () => {
    const rig = mount([]);
    expect(rig.text()).toContain("新游戏");
    expect(rig.inputValue()).toBe("");
    expect(rig.text()).not.toContain("继续");
  });

  it("sends a typed name verbatim, trimmed", async () => {
    const received: string[] = [];
    const rig = mount(received);

    await rig.typeInto("  张三  ");
    await rig.click("新游戏");

    expect(received).toEqual(["张三"]);
  });

  it("a blank box sends the default name", async () => {
    const received: string[] = [];
    const rig = mount(received);

    await rig.click("新游戏");

    expect(received).toEqual(["少侠"]);
  });

  it("Enter starts the game too — the form is the gesture", async () => {
    const received: string[] = [];
    const rig = mount(received);

    await rig.typeInto("李四");
    await rig.pressEnter();

    expect(received).toEqual(["李四"]);
  });

  it("a real keydown Enter starts the game too — no reliance on implicit submission", async () => {
    const received: string[] = [];
    const rig = mount(received);

    await rig.typeInto("王五");
    await rig.pressKeyEnter();

    // Some embedded webviews never run the implicit submission (the in-app
    // browser's verified finding) — the explicit keydown path carries them.
    expect(received).toEqual(["王五"]);
  });
});

describe("TitleScreen — the save loop's doors (#52 AC1/AC2)", () => {
  /** The ask's words — the host's copy, injected (Q5). */
  const overwrite = {
    prompt: "江湖中已有旧档——重开新游戏将覆盖旧进度，无法找回。",
    confirmLabel: "覆盖旧档，重开",
    cancelLabel: "先不",
  };

  function mountWithSave(received: {
    newGame: string[];
    continued: number[];
  }): TypingRig {
    const rig = mountTitleScreen({
      defaultName: "少侠",
      onNewGame: (name) => received.newGame.push(name),
      hasSave: true,
      onContinue: () => received.continued.push(1),
      overwrite,
    });
    mounted.push(rig);
    return rig;
  }

  it("lights 「继续」 when a save exists — and the gesture resumes, starting nothing", async () => {
    const seen = { newGame: [] as string[], continued: [] as number[] };
    const rig = mountWithSave(seen);

    expect(rig.text()).toContain("继续");
    await rig.click("继续");

    expect(seen.continued.length).toBe(1);
    expect(seen.newGame).toEqual([]);
  });

  it("asks ONCE before overwriting an existing save — never silently", async () => {
    const seen = { newGame: [] as string[], continued: [] as number[] };
    const rig = mountWithSave(seen);

    await rig.typeInto("李四");
    await rig.click("新游戏");

    // The ask, not the start: the prompt is on screen and nothing began.
    expect(seen.newGame).toEqual([]);
    expect(rig.text()).toContain(overwrite.prompt);

    await rig.click(overwrite.confirmLabel);
    expect(seen.newGame).toEqual(["李四"]);
  });

  it("cancel returns to the title — the old save keeps standing", async () => {
    const seen = { newGame: [] as string[], continued: [] as number[] };
    const rig = mountWithSave(seen);

    await rig.click("新游戏");
    await rig.click(overwrite.cancelLabel);

    expect(seen.newGame).toEqual([]);
    expect(rig.text()).not.toContain(overwrite.prompt);

    // Back on the ordinary row: the ask still guards a second attempt.
    await rig.click("新游戏");
    await rig.click(overwrite.confirmLabel);
    expect(seen.newGame).toEqual(["少侠"]); // a blank box still means the default
  });

  it("Enter during the ask starts nothing — the buttons carry the gesture", async () => {
    const seen = { newGame: [] as string[], continued: [] as number[] };
    const rig = mountWithSave(seen);

    await rig.click("新游戏");
    await rig.pressEnter();
    await rig.pressKeyEnter();

    expect(seen.newGame).toEqual([]);
    expect(rig.text()).toContain(overwrite.prompt);
  });
});
