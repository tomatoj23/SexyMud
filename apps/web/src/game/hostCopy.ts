import { markupKey, type RenderCopy } from "@sexymud/core";

/**
 * The web host's own words (#51; #48's Q5 ruling: one-line prompts, default
 * names and other theme vocabulary live in the HOST, behind the
 * engine-purity red line). Two faces sit here:
 *
 * - the RENDER copy (templates + the second-person pronoun) — the voice the
 *   engine's pure renderer substitutes into (Q6: the copy table is an
 *   renderer INPUT, the engine owns not one word);
 * - the host prompts — the unknown-command line (an `invalid` input has no
 *   event to render, and spec/01 §4 words the caller's own refusal), the
 *   save-failure line, and the player-name fallback.
 *
 * The hour WORD is not here anymore (owner ruling 2026-10-25, #51's D2):
 * 「子时」 is the pack's own vocabulary and rides WITH the calendar segment
 * (`segments[].label`, absent → the raw id) — the status line reads it
 * through the calendar pure function, the same law as a room's `name`. What
 * stays on this host is only WHICH ring feeds the status line.
 */

/** Everything the web host words itself; swap the host, swap this table. */
export interface HostCopy {
  /** The render voice — injected into the engine's pure renderer (Q6). */
  readonly render: RenderCopy;
  /**
   * Reason-code fallbacks for refusals whose (commandKey, errKey) face no
   * content entry covers — the renderer demands a copy and throws without
   * one (#50: degradation visible, never silent).
   */
  readonly reasonCopy: Readonly<Record<string, string>>;
  /** Which calendar ring the status line reads the hour from. */
  readonly hourRingId: string;
  /** The blank-name fallback on the title screen (#48 D4). */
  readonly defaultPlayerName: string;
  /**
   * The visible line for input no bound command claims — the caller's own
   * wording of resolve's `invalid` classification (spec/01 §4), never an
   * engine string.
   */
  unknownCommand(raw: string): string;
  /**
   * The flag-granted line (#56 T1): a granted flag's event is an extension
   * arm, and the C1 rendering seam renders the engine's eight arms only —
   * so the SESSION words the grant here, the enterText family. This host
   * binds one grant command today (the lodge check-in); a second one grows
   * a table keyed by flag.
   */
  readonly flagGrantedLine: string;
  /** The visible line when the autosave store failed (visible, not silent). */
  readonly saveFailed: string;
  /** The visible line when opening a new game itself failed (a wiring or pack break). */
  readonly openFailed: string;
  /**
   * The one-line notice when the saved room is gone from the current pack
   * (#52): the save is NOT corrupt — the world moved on — so the player is
   * set down at the declared start room and told why, in one line.
   */
  readonly saveRoomGone: string;
  /**
   * The 「继续」 failure face, SPLIT BY TROUBLE CLASS (#52 复核 N-2, #53):
   * the two failures point at opposite doors (#32 D4) — damaged bytes mean
   * repair or overwrite, an unreachable store means check browser settings
   * — so they may never share a line. Each class's EXIT rides with its
   * word: the corrupt face opens the overwrite ask (the words in
   * `overwrite` below), the unavailable face says how to retry.
   */
  readonly continueFailed: {
    /** 存档损坏——修档的门（重开覆盖旧档）。 */
    readonly corrupt: string;
    /** 存档损坏那扇门的把手（词随门走，换宿主换词）。 */
    readonly corruptExitLabel: string;
    /** 存储不可达——查设置的门（检查后重试）。 */
    readonly unavailable: string;
  };
  /**
   * The overwrite confirmation's words (#52): a new game over an existing
   * save asks ONCE — never a silent overwrite, never lost progress.
   */
  readonly overwrite: {
    readonly prompt: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
  };
  /**
   * The in-game 「回标题」 door's words (#55): ending the current game is a
   * CONFIRMED gesture, and the ask names both halves of the truth — the
   * game ends, the local save keeps standing (「继续」 reopens it).
   */
  readonly backToTitle: {
    readonly exitLabel: string;
    readonly ask: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
  };
}

export const WEB_HOST_COPY: HostCopy = {
  render: {
    you: "你",
    // Placeholder tokens go through markupKey (#54, spec/05 §8.2): the
    // NUL-wrapped alphabet a player cannot type — a bare {key} stopped
    // being a placeholder when the mechanism face landed.
    sayLine: `${markupKey("speaker")}说：${markupKey("text")}`,
    departedLine: `${markupKey("mover")}离开了${markupKey("from")}。`,
    arrivedLine: `${markupKey("mover")}来到了${markupKey("to")}。`,
    appearanceTitle: `〔${markupKey("name")}〕`,
    appearanceExits: `出路：${markupKey("exits")}`,
    presenceRow: `${markupKey("name")}×${markupKey("count")}`,
    appearanceItems: `这里有：${markupKey("items")}`,
    appearancePeople: `在场：${markupKey("people")}`,
    // The combat kernel's fixed templates (#56 T7: C1's minimal face lives
    // HERE, with the host; a later combat-text slice owns moving the words
    // into content). Wording follows content/style-guide.md — damage reads
    // as harm taken, never a bare "N points of damage" line. Placeholders
    // (markupKey): see render.ts's RenderCopy docs.
    strikeHit: `${markupKey("attacker")}一拳打向${markupKey("defender")}，${markupKey("defender")}受创${markupKey("damage")}点。`,
    strikeDodge: `${markupKey("defender")}身形一侧，闪过了${markupKey("attacker")}的攻势。`,
    strikeTake: `${markupKey("attacker")}还了一手，你受创${markupKey("damage")}点。`,
    dotTickLine: `${markupKey("target")}毒性发作，损了${markupKey("damage")}点气血（第${markupKey("applied")}/${markupKey("total")}跳）。`,
    deathNpcLine: `${markupKey("deceased")}闷哼一声，直挺挺倒了下去。`,
    deathPlayerLine: `${markupKey("deceased")}眼前一黑，倒了下去……`,
    listJoin: "、",
  },
  reasonCopy: {
    accessDenied: "此路不通。",
    notVisible: "你看不真切。",
    vetoed: "此举不成。",
    moveVetoed: "这一步迈不出去。",
    sayVetoed: "话到嘴边，又咽了回去。",
  },
  hourRingId: "day",
  defaultPlayerName: "少侠",
  unknownCommand(raw) {
    return `「${raw}」是什么招式？`;
  },
  flagGrantedLine: "掌柜的收下银子，递给你一块住客木牌：客官往后院请便。",
  saveFailed: "（本地存档暂不可用，这一步之后的进度未能保存。）",
  openFailed: "开局失败——世界配置有误，无法进入江湖。",
  saveRoomGone: "上次所在之处已不在江湖之中，你回到了起点。",
  continueFailed: {
    corrupt: "续档失败——存档损坏，读不出可用进度。可重开新游戏覆盖旧档。",
    corruptExitLabel: "重开新游戏",
    unavailable: "续档失败——本地存储不可用，请检查浏览器设置（如隐私模式、站点存储被禁）后再试。",
  },
  overwrite: {
    prompt: "江湖中已有旧档——重开新游戏将覆盖旧进度，无法找回。",
    confirmLabel: "覆盖旧档，重开",
    cancelLabel: "先不",
  },
  backToTitle: {
    exitLabel: "回标题",
    ask: "结束本局、回到标题？进度已存在本地档里，从标题的「继续」随时回来。",
    confirmLabel: "结束本局",
    cancelLabel: "接着玩",
  },
};
