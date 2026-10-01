import { useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent } from "react";
import type { Snapshot } from "@sexymud/core";
import type { CloudSync, SlotView, SyncOutcome, SyncState } from "../game/cloudSync.js";

const rowStyle = { display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" } as const;
const buttonStyle = { padding: "6px 12px", borderRadius: 4, cursor: "pointer" } as const;
const warnStyle = { color: "#b45309", margin: "4px 0" } as const;

/** The verdict line once nothing is in flight (存了／没存上／冲突/…). */
const VERDICT: Record<SyncOutcome, string> = {
  none: "尚未同步",
  saved: "已存到云端 ✓（存了）",
  downloaded: "云端存档已载入本地 ✓",
  imported: "已导入本地存档 ✓",
  dismissed: "继续本地玩——云端未同步",
  "remote-empty": "云端没有存档",
  "local-empty": "本地没有存档可上传",
  "in-sync": "本地与云端一致 ✓",
};

/**
 * The status line speaks from the PHASE first (decision D8: a failure must
 * say 没存上 — the earlier verdict never papers over it), then the last
 * verdict. Per action the failure names what did not happen.
 */
function statusLine(state: SyncState, last: SyncOutcome): string {
  if (state.phase === "busy") return "同步中…";
  if (state.phase === "auth-expired") return "登录已过期";
  if (state.phase === "conflict") return "冲突——请选择以哪边继续";
  if (state.phase === "failed") {
    return state.action === "upload"
      ? "没存上"
      : state.action === "download"
        ? "没下载到本地"
        : state.action === "import"
          ? "没导入"
          : "检查失败";
  }
  return VERDICT[last];
}

/** What the player sees of one slot in the comparison. */
function slotSummary(view: SlotView): string {
  if (view.kind === "unknown") return "未检查";
  if (view.kind === "empty") return "无存档";
  if (view.kind === "corrupt") return "存档损坏";
  if (view.kind === "unavailable") return "存储不可访问";
  const nowTick = (view.snapshot.data as { nowTick?: unknown }).nowTick;
  const progress = typeof nowTick === "number" ? ` · 进度 ${nowTick} tick` : "";
  return `存档 v${view.snapshot.version}${progress}`;
}

/** The exportable document goes out as a file — the player's own copy (ADR-0002 §21). */
function exportSnapshot(snapshot: Snapshot): void {
  const blob = new Blob([JSON.stringify(snapshot)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sexymud-save.json";
  anchor.click();
  // Deferred: revoking synchronously can cancel the download itself in some
  // browsers — the salvage channel must not fail silently.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The two-step confirm shared by every destructive exit (decision D7). */
function ConfirmButtons({
  warning,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  warning: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <span style={warnStyle}>{warning}</span>
      <button style={buttonStyle} onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button style={buttonStyle} onClick={onCancel}>
        取消
      </button>
    </>
  );
}

/**
 * The sync surface (#30): the status indicator and the conflict adjudication
 * (decisions D7/D8). Every write is an explicit button and every refusal is
 * visible — "not saved" never pretends "saved", and a deliberate overwrite
 * says out loud what it will throw away before doing it. The export button is
 * the escape hatch decision D7 leans on: a file in the player's own hands
 * before anything is replaced.
 */
export function CloudSavePanel({ sync }: { sync: CloudSync }) {
  const state = useSyncExternalStore(
    (listener) => sync.subscribe(listener),
    () => sync.state,
  );
  /** Two-step confirms: the destructive exits say their cost first (decision D7). */
  const [confirming, setConfirming] = useState<"upload" | "download" | "import" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const localSnapshot = sync.localView.kind === "save" ? sync.localView.snapshot : null;
  const busy = state.phase === "busy";

  async function run(action: () => Promise<unknown>): Promise<void> {
    setConfirming(null);
    // Refusals (busy / expired) surface as state, not as thrown noise here.
    await action().catch(() => undefined);
  }

  function uploadWarning(): string {
    if (sync.remoteView.kind === "save") return "云端存档将被覆盖——另一台设备的进度将被丢弃（可先导出本地存档保底）。";
    if (sync.remoteView.kind === "corrupt") return "云端存档已损坏——上传将以本地存档修复它。";
    // The views are display caches (#31), so even "empty" is the last probe's
    // CLAIM, not a fact — every overwrite says its cost out loud first
    // (decision D7), and no view state gets to skip that.
    if (sync.remoteView.kind === "empty") return "云端当前显示无存档——上传即新建；若显示已过期而云端实际有档，它将被覆盖。";
    return "云端状态未知（尚未检查成功）——若云端已有存档，上传将覆盖它。";
  }

  /** The mirror warning: a download overwrites the LOCAL slot, cache or not. */
  function downloadWarning(): string {
    if (sync.localView.kind === "save") return "本地存档将被云端存档覆盖（可先导出本地存档保底）。";
    // A damaged slot is NOT "no save" — say what the overwrite throws away.
    if (sync.localView.kind === "corrupt") return "本地存档已损坏——下载将用云端存档覆盖它，损坏内容将被丢弃。";
    // Unreachable storage has its own advice (#32 D4): change settings, not
    // repair a save — and the write will not land, overwrite or not.
    if (sync.localView.kind === "unavailable") return "本地存储当前不可访问——下载将无法写入，请先检查浏览器设置（重试无用）。";
    return "本地当前显示无存档（显示可能过期）——若本地实际已有存档，下载将覆盖它（可先导出保底）。";
  }

  /**
   * The pick is only a pick (#33): the machine reads and proves the file
   * restorable, and the confirm pops for a proven payload and for NOTHING
   * else — it is the very next thing after `beginImport` says so, whatever
   * the slot views currently claim (a stale cache never skips the cost
   * notice, #33 D3). Cancelling the picker is silence itself.
   */
  async function onImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const picked = event.target.files?.[0];
    // Clearing the value lets the same file be picked twice.
    event.target.value = "";
    if (!picked) return; // picker cancelled — silent, no state change (#33 D5)
    await run(async () => {
      const staged = await sync.beginImport(picked);
      if (staged.phase === "idle") setConfirming("import");
    });
  }

  return (
    <section style={{ borderTop: "1px solid #ddd", marginTop: 12, paddingTop: 8 }}>
      <div style={rowStyle}>
        <strong>云存档：</strong>
        <span>{statusLine(state, sync.last)}</span>
      </div>
      <div style={rowStyle}>
        <span>本地：{slotSummary(sync.localView)}</span>
        <span>云端：{slotSummary(sync.remoteView)}</span>
      </div>

      {state.phase === "busy" && <p>正在执行：{state.action}…</p>}

      {state.phase === "failed" && (
        <p style={{ color: "#b91c1c" }}>
          {state.action === "upload" &&
            state.failure !== "local-corrupt" &&
            state.failure !== "local-unavailable" &&
            "没存上："}
          {state.action === "download" && "没下载到本地："}
          {state.action === "probe" && "检查失败："}
          {state.action === "import" && state.failure !== "local-unavailable" && "没导入："}
          {state.failure === "network" && "网络不通或后端无响应。两端存档均未改动。"}
          {state.failure === "corrupt" &&
            (state.action === "upload"
              ? "云端存档损坏且无法经保存修复（记录锚已损坏）——本地存档无恙，可导出保底。"
              : "云端存档损坏，无法下载——若损坏仅在内容，上传本地存档可修复它。")}
          {state.failure === "local" && "本地写入失败（可能空间不足）——清理浏览器存储空间后可重试。"}
          {state.failure === "local-corrupt" && "本地存档损坏，无法上传——先修复或重置本地存档。"}
          {state.failure === "local-unavailable" &&
            (state.action === "upload"
              ? "本地存储不可访问，无法上传——请检查浏览器设置或退出隐私模式（重试无用）。"
              : state.action === "import"
                ? "本地存储不可访问，无法导入——请检查浏览器设置或退出隐私模式（重试无用）。"
                : "本地存储不可访问——请检查浏览器设置或退出隐私模式（重试无用）。")}
          {/* The file family (#33) — the advice is always "another file":
              repair/export salvage target the local slot, never the pick. */}
          {state.failure === "file" && "文件读不出来（可能已移动或被占用）——换一个文件再试，本地存档未改动。"}
          {state.failure === "file-corrupt" && "文件损坏或不是有效存档，本地存档未改动。"}
          {state.failure === "file-version" && "存档版本不可载（过新或迁移不可走），本地存档未改动。"}
        </p>
      )}

      {state.phase === "auth-expired" && <p style={warnStyle}>登录已过期——重新登录后继续云存档。</p>}

      {state.phase === "conflict" && (
        <div style={{ border: "1px solid #d97706", borderRadius: 4, padding: 8, margin: "8px 0" }}>
          <p style={{ margin: "0 0 8px" }}>
            {state.cause === "save"
              ? "保存时发现云端已被另一台设备更新。请选择以哪边继续："
              : "本地与云端存档不一致。请选择以哪边继续："}
          </p>
          <div style={rowStyle}>
            <button style={buttonStyle} onClick={() => setConfirming("upload")} disabled={!localSnapshot}>
              以本地为准（覆盖云端）
            </button>
            <button style={buttonStyle} onClick={() => void run(() => sync.download())}>
              以云端为准（载入云端）
            </button>
            <button style={buttonStyle} onClick={() => void run(async () => sync.dismiss())}>
              继续本地玩（暂不同步）
            </button>
            {localSnapshot && (
              <button style={buttonStyle} onClick={() => exportSnapshot(localSnapshot)}>
                导出本地存档（保底）
              </button>
            )}
            {/* The view gate (#33 D3): greyed out mid-adjudication — this
                whole block renders only in the conflict phase, so the button
                is pure display (the machine's own refusal is the insurance). */}
            <button style={buttonStyle} disabled>
              导入本地存档
            </button>
          </div>
          {confirming === "upload" && (
            <div style={rowStyle}>
              <ConfirmButtons
                warning={uploadWarning()}
                confirmLabel="确认覆盖"
                onConfirm={() => void run(() => sync.upload())}
                onCancel={() => setConfirming(null)}
              />
            </div>
          )}
        </div>
      )}

      {state.phase !== "conflict" && (
        <div style={rowStyle}>
          {confirming === "upload" ? (
            <ConfirmButtons
              warning={uploadWarning()}
              confirmLabel="确认上传"
              onConfirm={() => void run(() => sync.upload())}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === "download" ? (
            <ConfirmButtons
              warning={downloadWarning()}
              confirmLabel="确认下载"
              onConfirm={() => void run(() => sync.download())}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === "import" ? (
            // The cost notice verbatim (#33 D3): 覆盖当前本地存档、
            // 不可撤销、建议先导出保命 — unconditional, and it is the
            // confirm's answer that runs the write (commitImport).
            <ConfirmButtons
              warning="覆盖当前本地存档、不可撤销、建议先导出保命。"
              confirmLabel="确认导入"
              onConfirm={() => void run(() => sync.commitImport())}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <>
              {/* The views gate the BUTTONS (decision D3 kept) but never the
                  CONFIRM: a stale cache must not skip the cost notice (D7). */}
              <button
                style={buttonStyle}
                onClick={() => setConfirming("upload")}
                disabled={!localSnapshot || busy || state.phase === "auth-expired"}
              >
                上传到云端
              </button>
              <button
                style={buttonStyle}
                onClick={() => setConfirming("download")}
                disabled={sync.remoteView.kind !== "save" || busy || state.phase === "auth-expired"}
              >
                下载云端存档
              </button>
              <button
                style={buttonStyle}
                onClick={() => void run(() => sync.probe())}
                disabled={busy || state.phase === "auth-expired"}
              >
                重新检查
              </button>
              {localSnapshot && (
                <button style={buttonStyle} onClick={() => exportSnapshot(localSnapshot)}>
                  导出本地存档
                </button>
              )}
              {/* The #33 D1 pair: import lives beside export. The views gate
                  the BUTTONS but never the CONFIRM above (D7). Conflict never
                  reaches this row (its own block owns that phase), so the
                  conflict gate here is the block split above. */}
              <button
                style={buttonStyle}
                onClick={() => fileInput.current?.click()}
                disabled={busy || state.phase === "auth-expired"}
              >
                导入本地存档
              </button>
            </>
          )}
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(event) => void onImportFile(event)}
      />
    </section>
  );
}
