import { useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent } from "react";
import { CloudSyncError } from "../game/cloudSync.js";
import type { CloudSync, DestructiveAction, SlotView, StatusView, SyncOutcome } from "../game/cloudSync.js";

const rowStyle = { display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" } as const;
const buttonStyle = { padding: "6px 12px", borderRadius: 4, cursor: "pointer" } as const;
const warnStyle = { color: "#b45309", margin: "4px 0" } as const;
const errorStyle = { color: "#b91c1c" } as const;

/** The verdict line once nothing is in flight (存了／没存上／冲突/…). */
const VERDICT: Record<SyncOutcome, string> = {
  none: "尚未同步",
  saved: "已存到云端 ✓（存了）",
  downloaded: "云端存档已载入本地 ✓",
  imported: "已导入本地存档 ✓",
  exported: "已导出本地存档为文件 ✓",
  dismissed: "继续本地玩——云端未同步",
  "remote-empty": "云端没有存档",
  // `local-empty` is the one word two actions share — statusLine splits it per
  // action; this entry is only the type's fallback.
  "local-empty": "本地没有存档",
  "in-sync": "本地与云端一致 ✓",
};

/**
 * The status line words ONE machine judgment ({@link StatusView}, decision
 * D8): the machine resolved the precedence — a standing failure covers the
 * old verdict — so this reader only chooses words. Per action the failure
 * names what did not happen.
 */
function statusLine(view: StatusView, local: SlotView): string {
  if (view.kind === "busy") return "同步中…";
  if (view.kind === "auth-expired") return "登录已过期";
  if (view.kind === "conflict") return "冲突——请选择以哪边继续";
  if (view.kind === "failed") {
    return view.action === "upload"
      ? "没存上"
      : view.action === "download"
        ? "没下载到本地"
        : view.action === "import"
          ? "没导入"
          : view.action === "export"
            ? "没导出"
            : "检查失败";
  }
  const { outcome, from } = view;
  // The shared absence word splits per action (#34, L14): the copy names the
  // door the verdict came through — `from` is the machine's own attribution
  // (the verdict pair moves atomically there), so a pick attempt or a refused
  // click never re-attributes an earlier verdict.
  if (outcome === "local-empty") {
    return from === "export" ? "本地没有存档可导出" : "本地没有存档可上传";
  }
  // Salvage says what it shipped (#34 D2): a corrupt slot's export is the raw
  // damaged bytes — the file is for repair, not a restorable save.
  if (outcome === "exported" && local.kind === "corrupt") {
    return "已导出原始字节 ✓（存档损坏，可修复后经导入取回）";
  }
  return VERDICT[outcome];
}

/**
 * What the player sees of one slot in the comparison — a TOTAL reader: a
 * hostile payload (`data: null`) is still a `save` view at the envelope
 * level, and the summary must never throw on it — a crash here would take
 * the whole panel down, salvage button included (M7's law; the summary
 * module of #46 absorbs this). Exported for its direct pin.
 */
export function slotSummary(view: SlotView): string {
  if (view.kind === "unknown") return "未检查";
  if (view.kind === "empty") return "无存档";
  if (view.kind === "corrupt") return "存档损坏";
  if (view.kind === "unavailable") return "存储不可访问";
  const data: unknown = view.snapshot.data;
  const nowTick =
    typeof data === "object" && data !== null ? (data as { nowTick?: unknown }).nowTick : undefined;
  const progress = typeof nowTick === "number" ? ` · 进度 ${nowTick} tick` : "";
  return `存档 v${view.snapshot.version}${progress}`;
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
 *
 * A thin binding (#45 D2): thin means NO business judgment — what is
 * destructive and what it costs arrives as the machine's cost ELEMENTS
 * (`sync.destructive`), what the status speaks arrives as `sync.statusView`,
 * and a refused gesture is the machine's own word shown here the way
 * AuthPanel shows one. This layer keeps the interaction choreography
 * (buttons, confirm rows, the file picker) and the wording.
 */
export function CloudSavePanel({ sync }: { sync: CloudSync }) {
  const state = useSyncExternalStore(
    (listener) => sync.subscribe(listener),
    () => sync.state,
  );
  /** Two-step confirms: the destructive exits say their cost first (decision D7). */
  const [confirming, setConfirming] = useState<"upload" | "download" | "import" | null>(null);
  /**
   * The machine's refusal words (#45 D3) — shown, never swallowed (AuthPanel's
   * law). The line is a verdict on the LAST GESTURE ("此操作未执行…"), so it is
   * retired by the player's NEXT gesture and by nothing else (#45 复查: a
   * machine move is the wrong signal — it both killed live notices mid-wait
   * and let dead ones linger under a fresh confirm row).
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The export gate reads the VIEW's kind (#34 D2): available whenever the
  // machine can produce a file — a corrupt slot's bytes ARE the salvage — and
  // disabled only for absence and unreachable storage. Display only; the
  // machine is the authority on what it will actually ship. (#45 ruling ③:
  // a stale "empty" can only mis-DISABLE, never mis-enable — 重新检查 is the
  // remedy — so the gate stays a view gate and no guard lives here.)
  const exportDisabled = sync.localView.kind === "empty" || sync.localView.kind === "unavailable";

  /** Opening a confirm row IS a gesture — it retires the previous verdict. */
  function openConfirm(next: "upload" | "download" | "import"): void {
    setRefusal(null);
    setConfirming(next);
  }

  function cancelConfirm(): void {
    setRefusal(null);
    setConfirming(null);
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    setConfirming(null);
    setRefusal(null);
    try {
      await action();
    } catch (cause) {
      // One channel, one adaptation (#45 D3): a refusal arrives typed with the
      // machine's own words and is SHOWN — the silent dead point behind a
      // greyed-out guess is closed by never swallowing again.
      setRefusal(cause instanceof CloudSyncError ? cause.message : "操作失败，请重试");
    }
  }

  /**
   * The cost words for one destructive exit (#45 D1): the machine says WHICH
   * slot dies (`DestructiveView.overwrites`) and what stands there
   * (`target`), so the copy below names exactly that slot — keyed on the
   * machine's element, never on a button's identity. Import's notice is
   * #33 D3's VERBATIM words (its own pinned copy).
   */
  function costWarning(action: DestructiveAction): string {
    const { overwrites, target } = sync.destructive[action];
    if (action === "import") return "覆盖当前本地存档、不可撤销、建议先导出保命。";
    if (overwrites === "remote") {
      if (target.kind === "save") return "云端存档将被覆盖——另一台设备的进度将被丢弃（可先导出本地存档保底）。";
      if (target.kind === "corrupt") return "云端存档已损坏——上传将以本地存档修复它。";
      // The views are display caches (#31), so even "empty" is the last probe's
      // CLAIM, not a fact — every overwrite says its cost out loud first
      // (decision D7), and no view state gets to skip that.
      if (target.kind === "empty") return "云端当前显示无存档——上传即新建；若显示已过期而云端实际有档，它将被覆盖。";
      return "云端状态未知（尚未检查成功）——若云端已有存档，上传将覆盖它。";
    }
    if (target.kind === "save") return "本地存档将被云端存档覆盖（可先导出本地存档保底）。";
    // A damaged slot is NOT "no save" — say what the overwrite throws away.
    if (target.kind === "corrupt") return "本地存档已损坏——下载将用云端存档覆盖它，损坏内容将被丢弃。";
    // Unreachable storage has its own advice (#32 D4): change settings, not
    // repair a save — and the write will not land, overwrite or not.
    if (target.kind === "unavailable") return "本地存储当前不可访问——下载将无法写入，请先检查浏览器设置（重试无用）。";
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
      if (staged.phase === "idle") openConfirm("import");
    });
  }

  return (
    <section style={{ borderTop: "1px solid #ddd", marginTop: 12, paddingTop: 8 }}>
      <div style={rowStyle}>
        <strong>云存档：</strong>
        <span>{statusLine(sync.statusView, sync.localView)}</span>
      </div>
      <div style={rowStyle}>
        <span>本地：{slotSummary(sync.localView)}</span>
        <span>云端：{slotSummary(sync.remoteView)}</span>
      </div>

      {state.phase === "busy" && <p>正在执行：{state.action}…</p>}

      {state.phase === "failed" && (
        <p style={errorStyle}>
          {state.action === "export" ? (
            // Export's failure vocabulary is CLOSED (#34): `local-unavailable`
            // and `file` are the only words it speaks — the closed block keeps
            // even a defensive reach from borrowing another door's advice.
            state.failure === "local-unavailable"
              ? "本地存储不可访问，无法导出——请检查浏览器设置或退出隐私模式（重试无用）。"
              : state.failure === "file"
                ? "没导出：文件生成或下载失败（可能被浏览器拦截）——可重试；本地存档未改动。"
                : "没导出：导出未能完成——本地存档未改动。"
          ) : (
            <>
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
              {/* The file family (#33) — the advice is "another file":
                  repair/export salvage target the local slot, never the pick. */}
              {state.failure === "file" && "文件读不出来（可能已移动或被占用）——换一个文件再试，本地存档未改动。"}
              {state.failure === "file-corrupt" && "文件损坏或不是有效存档，本地存档未改动。"}
              {state.failure === "file-version" && "存档版本不可载（过新或迁移不可走），本地存档未改动。"}
            </>
          )}
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
            <button
              style={buttonStyle}
              onClick={() => openConfirm("upload")}
              disabled={sync.localView.kind !== "save"}
            >
              以本地为准（覆盖云端）
            </button>
            <button style={buttonStyle} onClick={() => void run(() => sync.download())}>
              以云端为准（载入云端）
            </button>
            <button style={buttonStyle} onClick={() => void run(() => sync.dismiss())}>
              继续本地玩（暂不同步）
            </button>
            {/* The escape hatch is live mid-adjudication (#34 D7): exporting
                is not one of the three exits — it ships a file and leaves the
                choice standing. */}
            <button
              style={buttonStyle}
              onClick={() => void run(() => sync.exportLocal())}
              disabled={exportDisabled}
            >
              导出本地存档（保底）
            </button>
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
                warning={costWarning("upload")}
                confirmLabel="确认覆盖"
                onConfirm={() => void run(() => sync.upload())}
                onCancel={cancelConfirm}
              />
            </div>
          )}
        </div>
      )}

      {state.phase !== "conflict" && (
        <div style={rowStyle}>
          {confirming === "upload" ? (
            <ConfirmButtons
              warning={costWarning("upload")}
              confirmLabel="确认上传"
              onConfirm={() => void run(() => sync.upload())}
              onCancel={cancelConfirm}
            />
          ) : confirming === "download" ? (
            <ConfirmButtons
              warning={costWarning("download")}
              confirmLabel="确认下载"
              onConfirm={() => void run(() => sync.download())}
              onCancel={cancelConfirm}
            />
          ) : confirming === "import" ? (
            // The cost notice verbatim (#33 D3): 覆盖当前本地存档、
            // 不可撤销、建议先导出保命 — unconditional, and it is the
            // confirm's answer that runs the write (commitImport).
            <ConfirmButtons
              warning={costWarning("import")}
              confirmLabel="确认导入"
              onConfirm={() => void run(() => sync.commitImport())}
              onCancel={cancelConfirm}
            />
          ) : (
            <>
              {/* The views gate the BUTTONS (decision D3 kept) but never the
                  CONFIRM: a stale cache must not skip the cost notice (D7).
                  Only VIEW gates remain here (#45 D5): the machine-guard
                  tails (`busy` / `auth-expired`) are gone — the guard is the
                  machine's own, its refusal is loud, and a second copy in
                  this layer is the judged-elsewhere shape the ticket kills. */}
              <button
                style={buttonStyle}
                onClick={() => openConfirm("upload")}
                disabled={sync.localView.kind !== "save"}
              >
                上传到云端
              </button>
              <button
                style={buttonStyle}
                onClick={() => openConfirm("download")}
                disabled={sync.remoteView.kind !== "save"}
              >
                下载云端存档
              </button>
              <button style={buttonStyle} onClick={() => void run(() => sync.probe())}>
                重新检查
              </button>
              {/* D2: the button follows "can the machine produce a file" —
                  a corrupt slot's button is AVAILABLE (export IS the salvage);
                  disabled is display, the machine is the authority. */}
              <button
                style={buttonStyle}
                onClick={() => void run(() => sync.exportLocal())}
                disabled={exportDisabled}
              >
                导出本地存档
              </button>
              {/* The #33 D1 pair: import lives beside export. The views gate
                  the BUTTONS but never the CONFIRM above (D7). Conflict never
                  reaches this row (its own block owns that phase), so the
                  conflict gate here is the block split above. */}
              <button
                style={buttonStyle}
                onClick={() => {
                  setRefusal(null); // a gesture — the picker retires the last verdict too
                  fileInput.current?.click();
                }}
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
      {/* The refusal line (#45 D3) — AuthPanel's error law verbatim: the
          machine's own words, red, below the controls they belong to. */}
      {refusal && <p style={errorStyle}>{refusal}</p>}
    </section>
  );
}
