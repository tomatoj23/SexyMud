// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountTitleScreen, type TypingRig } from "./panel-rig.js";

/**
 * The title screen's render pins (#51 AC1): one name box, one 「新游戏」
 * button, and the two name outcomes — a typed name travels verbatim, a
 * blank box travels the default 「少侠」. The name is a DISPLAY field
 * (#48 D4): what `onNewGame` receives is the name, never an id, and the
 * button that is NOT here («继续», #52) is as deliberate as the one that
 * is.
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
  it("offers the name box and the one button — 「继续」 is #52's, not here", () => {
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
