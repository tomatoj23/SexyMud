// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CloudAuth, type CloudAuthClient, type CloudAuthSession } from "../src/game/cloudAuth.js";
import { mountAuthPanel, type PanelRig } from "./panel-rig.js";

/**
 * The death guidance's ONE home (#42 D2) — the render half of "one owner".
 * CloudSavePanel speaks no death (#42, pinned there), so the words that DO
 * speak it are pinned here: the re-login prompt is the AC's verbatim
 * baseline (「重新登录以继续云存档」— L4's逐字 law), and it lives in `expired`
 * only — a plain sign-out is just the form (D6, #42's red line).
 */

const session: CloudAuthSession = { uid: "uid-1", account: "侠客行" };

/** The narrow stub: the render pins drive states, never the backend. */
const stub: CloudAuthClient = {
  signUp: () => Promise.reject(new Error("unused in these pins")),
  signIn: () => Promise.resolve(session),
  getLoginState: () => Promise.resolve(null),
  signOut: () => Promise.resolve(),
};

const mounted: Pick<PanelRig, "unmount">[] = [];

afterEach(() => {
  for (const panel of mounted.splice(0)) panel.unmount();
});

describe("AuthPanel — the death guidance's single home (#42 D2)", () => {
  it("a dead session renders the verbatim re-login prompt — the one copy", async () => {
    const auth = new CloudAuth(stub);
    await auth.signIn("侠客行", "pw");
    auth.markExpired(session); // the session machine is the death's owner

    const panel = mountAuthPanel(auth);
    mounted.push(panel);

    // The AC baseline, verbatim — the two divergent copies are gone, so a
    // re-wording here re-opens the drift this ticket closed.
    expect(panel.text()).toContain("登录已过期（侠客行）——重新登录以继续云存档。本地存档不受影响。");
  });

  it("a plain sign-out is just the form — no death words (D6, the red line)", () => {
    const auth = new CloudAuth(stub);

    const panel = mountAuthPanel(auth);
    mounted.push(panel);

    expect(panel.text()).not.toContain("登录已过期");
    expect(panel.text()).not.toContain("重新登录");
  });
});
