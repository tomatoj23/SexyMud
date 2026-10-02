// @vitest-environment jsdom
import type { Snapshot } from "@sexymud/core";
import { afterEach, describe, expect, it } from "vitest";
import { CloudSaveError } from "../src/game/cloudSaveStore.js";
import { LocalSaveUnavailableError, type RawLocalRead } from "../src/game/localSaveStore.js";
import { CloudSync, type CloudSlot, type LocalSlot, type SlotView } from "../src/game/cloudSync.js";
import { slotSummary } from "../src/ui/CloudSavePanel.js";
import { mountPanel, type PanelRig } from "./panel-rig.js";
import { snapshotFixture } from "./support.js";

/**
 * The panel's own tests (#34's pure-function pins, #45's W6 render pins).
 *
 * The summary reader is pinned as a TOTAL function (#34 复查轮; M7's law): a
 * hostile payload (`data: null`) is still a `save` view at the envelope
 * level, and the summary must never throw on it — a crash here would take
 * the whole panel down, salvage button included (#34 D2 makes that button the
 * player's escape hatch).
 *
 * The render pins (#45 W6) carry the judgment-discipline contract: the
 * machine owns every judgment — what is destructive and what it costs
 * (`destructive`), what the status speaks (`statusView`), every guard — and
 * this layer draws and reports gestures. They also absorb the assertions the
 * two earlier tickets deferred to this infrastructure: #33's conflict-gate
 * import button, #34's export door visibility.
 */

function saveView(snapshot: Snapshot): SlotView {
  return { kind: "save", snapshot };
}

describe("CloudSavePanel — slotSummary is a total reader (M7)", () => {
  it("a hostile payload (`data: null`) never crashes the summary — no progress suffix, panel alive", () => {
    // Envelope-clean but payload-hostile: parseSnapshotText accepts it (the
    // envelope check is only `{version, data}`), so the view is a `save` —
    // and the pre-fix reader died on `data.nowTick` right here.
    const hostile = { version: 2, data: null } as unknown as Snapshot;

    expect(slotSummary(saveView(hostile))).toBe("存档 v2");
  });

  it("a payload without nowTick shows no progress suffix — absence is an empty suffix, not words", () => {
    const quiet = { version: 2, data: {} } as Snapshot;

    expect(slotSummary(saveView(quiet))).toBe("存档 v2");
  });

  it("a normal save shows version and progress; the other kinds keep their own lines", () => {
    const live = { version: 2, data: { nowTick: 42 } } as Snapshot;

    expect(slotSummary(saveView(live))).toBe("存档 v2 · 进度 42 tick");
    expect(slotSummary({ kind: "unknown" })).toBe("未检查");
    expect(slotSummary({ kind: "empty" })).toBe("无存档");
    expect(slotSummary({ kind: "corrupt" })).toBe("存档损坏");
    expect(slotSummary({ kind: "unavailable" })).toBe("存储不可访问");
  });
});

/** The local slot as the panel sees it — RAM, every trouble class on tap. */
class FakeLocal implements LocalSlot {
  snapshot: Snapshot | null = null;
  text: string | null = null;
  /** `load` then throws anything but unavailability — visible damage. */
  damaged = false;
  /** The store cannot be reached at all (#32 D4). */
  unreachable = false;

  load(): Promise<Snapshot | null> {
    if (this.unreachable) return Promise.reject(new LocalSaveUnavailableError("denied"));
    if (this.damaged) return Promise.reject(new Error("not json"));
    return Promise.resolve(this.snapshot);
  }

  save(snapshot: Snapshot): Promise<void> {
    if (this.unreachable) return Promise.reject(new LocalSaveUnavailableError("denied"));
    this.snapshot = snapshot;
    this.text = JSON.stringify(snapshot);
    return Promise.resolve();
  }

  readRaw(): Promise<RawLocalRead> {
    if (this.unreachable) return Promise.resolve({ kind: "unavailable" });
    return Promise.resolve(this.text === null ? { kind: "empty" } : { kind: "text", text: this.text });
  }
}

/** The cloud slot — same shape the machine drives, with a hang knob for "in flight". */
class FakeCloud implements CloudSlot {
  snapshot: Snapshot | null = null;
  failing: Error | null = null;
  /** While true, `load` parks — the machine sits on `busy` until {@link release}. */
  hung = false;
  private wake: (() => void) | null = null;

  /** Lets a parked `load` land (with the current snapshot). */
  release(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  load(): Promise<Snapshot | null> {
    if (this.failing) return Promise.reject(this.failing);
    if (this.hung) {
      return new Promise<Snapshot | null>((resolve) => {
        this.wake = () => resolve(this.snapshot);
      });
    }
    return Promise.resolve(this.snapshot);
  }

  replace(snapshot: Snapshot): Promise<{ outcome: "saved" }> {
    if (this.failing) return Promise.reject(this.failing);
    this.snapshot = snapshot;
    return Promise.resolve({ outcome: "saved" });
  }
}

const mounted: PanelRig[] = [];

/** One panel over a real `CloudSync` over the two fakes — the render rig's seam. */
function mountRig(): { panel: PanelRig; local: FakeLocal; cloud: FakeCloud; sync: CloudSync } {
  const local = new FakeLocal();
  const cloud = new FakeCloud();
  const sync = new CloudSync(cloud, local);
  const panel = mountPanel(sync);
  mounted.push(panel);
  return { panel, local, cloud, sync };
}

afterEach(() => {
  for (const panel of mounted.splice(0)) panel.unmount();
});

describe("CloudSavePanel — rendered discipline (#45 W6: the judgments are the machine's)", () => {
  it("D7 the cost notice is unconditional — a STALE view never skips it (#31's law, now a render pin)", async () => {
    const { panel, local, cloud } = mountRig();
    const same = snapshotFixture({ nowTick: 20 });
    local.snapshot = same;
    local.text = JSON.stringify(same);
    cloud.snapshot = same;
    await panel.click("重新检查"); // both sides read — the views are last-known from here
    local.snapshot = null; // the slot vanishes BEHIND the machine; the view is stale now
    local.text = null;

    await panel.click("上传到云端");

    // The confirm speaks anyway — and words the stale CLAIM conditionally.
    expect(panel.text()).toContain("云端存档将被覆盖——另一台设备的进度将被丢弃");
  });

  it("D7 the import cost is quoted VERBATIM and only the confirm's answer writes (#33's two-step, now a render pin)", async () => {
    const { panel, local } = mountRig();
    const file = snapshotFixture({ nowTick: 42 });

    await panel.pickFile(JSON.stringify(file));
    expect(panel.text()).toContain("覆盖当前本地存档、不可撤销、建议先导出保命。");
    expect(local.snapshot).toBeNull(); // the cost is on screen and nothing has moved yet

    await panel.click("确认导入");
    expect(local.snapshot).toEqual(file);
    expect(panel.text()).toContain("已导入本地存档 ✓");
  });

  it("the machine's refusal words reach the error line whatever the kind — the panel adapts at ONE place", async () => {
    const { panel, local, sync } = mountRig();
    await panel.pickFile(JSON.stringify(snapshotFixture({ nowTick: 7 })));
    // The confirm's own answer, run behind the row — the staged payload is spent.
    await panel.drive(() => sync.commitImport());
    expect(local.snapshot).not.toBeNull();

    await panel.click("确认导入"); // the row still stands; the machine refuses

    // The machine's OWN words for the refusal, shown — never invented here.
    expect(panel.text()).toContain("没有待确认的导入");
  });

  it("the refusal line is the LAST gesture's verdict — a machine move never retires it, a new gesture always does", async () => {
    const { panel, local, cloud } = mountRig();
    const same = snapshotFixture({ nowTick: 20 });
    local.snapshot = same;
    local.text = JSON.stringify(same);
    cloud.snapshot = same;
    await panel.click("重新检查"); // the views are known — in-sync, idle
    cloud.hung = true;
    await panel.click("重新检查"); // parks the machine on busy
    await panel.click("重新检查"); // refused — the verdict is on the line

    expect(panel.text()).toContain("此操作未执行");
    cloud.hung = false;
    await panel.drive(() => {
      cloud.release(); // the in-flight probe lands — a machine move
      return Promise.resolve();
    });
    // The verdict belongs to the refused GESTURE (#45 复查): it outlives the
    // machine move that followed it — "误清" was the bug this pins away.
    expect(panel.text()).toContain("此操作未执行");

    await panel.click("上传到云端"); // a NEW gesture — the verdict retires
    expect(panel.text()).not.toContain("此操作未执行"); // "赖着" under a fresh confirm row is the other half
  });

  it("D7 the download's cost names the slot the MACHINE says dies — the mirror of the upload notice", async () => {
    const { panel, local, cloud, sync } = mountRig();
    const same = snapshotFixture({ nowTick: 20 });
    local.snapshot = same;
    local.text = JSON.stringify(same);
    cloud.snapshot = same;
    await panel.click("重新检查"); // in-sync, idle — the main row renders
    expect(sync.destructive.download.overwrites).toBe("local"); // the judgment is the machine's

    await panel.click("下载云端存档");

    expect(panel.text()).toContain("本地存档将被云端存档覆盖"); // …and the copy names exactly that slot
  });

  it("D8 a failure covers the old verdict — the line says what did NOT happen, never a stale ✓", async () => {
    const { panel, local, cloud } = mountRig();
    local.snapshot = snapshotFixture({ nowTick: 20 });
    local.text = JSON.stringify(local.snapshot);
    await panel.click("重新检查");
    await panel.click("上传到云端");
    await panel.click("确认上传");
    expect(panel.text()).toContain("已存到云端 ✓（存了）");

    cloud.failing = new Error("backend down");
    await panel.click("重新检查");

    expect(panel.text()).toContain("检查失败");
    expect(panel.text()).not.toContain("已存到云端"); // the failure speaks first (D8's last sentence)
  });

  it("the conflict block greys the import door — #33 D3's display gate, the deferred assertion lands here", async () => {
    const { panel, local, cloud } = mountRig();
    local.snapshot = snapshotFixture({ nowTick: 20 });
    local.text = JSON.stringify(local.snapshot);
    cloud.snapshot = snapshotFixture({ nowTick: 99 });
    await panel.click("重新检查");

    expect(panel.text()).toContain("冲突——请选择以哪边继续");
    expect(panel.button("导入本地存档").disabled).toBe(true); // display gate — the machine's refusal is the insurance
  });

  it("the export door follows 'can the machine produce a file' — #34 D2's deferred display assertions", async () => {
    const { panel, local } = mountRig();

    // A corrupt slot's bytes ARE the salvage — the door is AVAILABLE.
    local.damaged = true;
    await panel.click("重新检查");
    expect(panel.text()).toContain("存档损坏");
    expect(panel.button("导出本地存档").disabled).toBe(false);

    // Absence: there is nothing to ship.
    local.damaged = false;
    local.snapshot = null;
    await panel.click("重新检查");
    expect(panel.button("导出本地存档").disabled).toBe(true);

    // Unreachable storage: no bytes at all — "check settings", not "retry".
    local.unreachable = true;
    await panel.click("重新检查");
    expect(panel.text()).toContain("存储不可访问");
    expect(panel.button("导出本地存档").disabled).toBe(true);
  });

  it("D5 the red line: no guard in the panel — mid-flight the buttons stay clickable and the refusal is SHOWN", async () => {
    const { panel, local, cloud } = mountRig();
    const same = snapshotFixture({ nowTick: 20 });
    local.snapshot = same;
    local.text = JSON.stringify(same);
    cloud.snapshot = same;
    await panel.click("重新检查"); // the views are known — in-sync, idle
    cloud.hung = true;
    await panel.click("重新检查"); // parks the machine on busy — and keeps it there

    expect(panel.text()).toContain("同步中…");
    // The guard tails are GONE (#45 D5): the machine is the guard, and its
    // refusal is loud — no silent dead point behind a greyed-out guess.
    expect(panel.button("重新检查").disabled).toBe(false);
    expect(panel.button("上传到云端").disabled).toBe(false); // its view gate is all that remains

    await panel.click("重新检查");
    expect(panel.text()).toContain("上一个同步操作还在进行");
  });

  it("D5 the view gates stay — the head clauses are display, and they read the machine's own views", async () => {
    const { panel, local } = mountRig();
    await panel.click("重新检查"); // both sides read: empty and empty

    expect(panel.button("上传到云端").disabled).toBe(true); // no local save, nothing to upload
    expect(panel.button("下载云端存档").disabled).toBe(true); // no cloud save, nothing to download

    local.snapshot = snapshotFixture({ nowTick: 20 });
    local.text = JSON.stringify(local.snapshot);
    await panel.click("重新检查");
    expect(panel.button("上传到云端").disabled).toBe(false);
    expect(panel.button("下载云端存档").disabled).toBe(true); // its gate reads the REMOTE view
  });

  it("an expired session greys nothing — and the refusal names the dead gesture distinctly", async () => {
    const { panel, cloud } = mountRig();
    cloud.failing = new CloudSaveError("auth", "session expired");
    await panel.click("重新检查");
    expect(panel.text()).toContain("登录已过期"); // the phase's own guidance line

    expect(panel.button("重新检查").disabled).toBe(false); // D5: the guard tail is gone
    await panel.click("重新检查");
    expect(panel.text()).toContain("此操作未执行"); // the machine's refusal, on the error line (AuthPanel's law)
  });
});
