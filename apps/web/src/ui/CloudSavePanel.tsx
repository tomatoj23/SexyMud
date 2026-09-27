import { useState, useSyncExternalStore } from "react";
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
  dismissed: "继续本地玩——云端未同步",
  "remote-empty": "云端没有存档",
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
    return state.action === "upload" ? "没存上" : state.action === "download" ? "没下载到本地" : "检查失败";
  }
  return VERDICT[last];
}

/** What the player sees of one slot in the comparison. */
function slotSummary(view: SlotView): string {
  if (view.kind === "unknown") return "未检查";
  if (view.kind === "empty") return "无存档";
  if (view.kind === "corrupt") return "存档损坏";
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
  URL.revokeObjectURL(url);
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
  const [confirming, setConfirming] = useState<"upload" | "download" | null>(null);
  const localSnapshot = sync.localView.kind === "save" ? sync.localView.snapshot : null;
  const busy = state.phase === "busy";

  async function run(action: () => Promise<unknown>): Promise<void> {
    setConfirming(null);
    // Refusals (busy / expired) surface as state, not as thrown noise here.
    await action().catch(() => undefined);
  }

  function uploadWarning(): string | null {
    if (sync.remoteView.kind === "save") return "云端存档将被覆盖——另一台设备的进度将被丢弃（可先导出本地存档保底）。";
    if (sync.remoteView.kind === "corrupt") return "云端存档已损坏——上传将以本地存档修复它。";
    return null;
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
          {state.action === "upload" && "没存上："}
          {state.action === "download" && "没下载到本地："}
          {state.action === "probe" && "检查失败："}
          {state.failure === "network" && "网络不通或后端无响应。两端存档均未改动。"}
          {state.failure === "corrupt" && "云端存档损坏，无法下载——可上传本地存档修复它。"}
          {state.failure === "local" && "本地写入失败（可能空间不足）。"}
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
            <button style={buttonStyle} onClick={() => sync.dismiss()}>
              继续本地玩（暂不同步）
            </button>
            {localSnapshot && (
              <button style={buttonStyle} onClick={() => exportSnapshot(localSnapshot)}>
                导出本地存档（保底）
              </button>
            )}
          </div>
          {confirming === "upload" && (
            <div style={rowStyle}>
              <ConfirmButtons
                warning={uploadWarning() ?? ""}
                confirmLabel="确认覆盖"
                onConfirm={() => localSnapshot && void run(() => sync.upload(localSnapshot))}
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
              warning={uploadWarning() ?? ""}
              confirmLabel="确认上传"
              onConfirm={() => localSnapshot && void run(() => sync.upload(localSnapshot))}
              onCancel={() => setConfirming(null)}
            />
          ) : confirming === "download" ? (
            <ConfirmButtons
              warning="本地存档将被云端存档覆盖（可先导出本地存档保底）。"
              confirmLabel="确认下载"
              onConfirm={() => void run(() => sync.download())}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <>
              <button
                style={buttonStyle}
                onClick={() => {
                  if (uploadWarning()) setConfirming("upload");
                  else if (localSnapshot) void run(() => sync.upload(localSnapshot));
                }}
                disabled={!localSnapshot || busy || state.phase === "auth-expired"}
              >
                上传到云端
              </button>
              <button
                style={buttonStyle}
                onClick={() => {
                  if (sync.localView.kind === "save") setConfirming("download");
                  else void run(() => sync.download());
                }}
                disabled={sync.remoteView.kind !== "save" || busy || state.phase === "auth-expired"}
              >
                下载云端存档
              </button>
              {localSnapshot && (
                <button style={buttonStyle} onClick={() => exportSnapshot(localSnapshot)}>
                  导出本地存档
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
