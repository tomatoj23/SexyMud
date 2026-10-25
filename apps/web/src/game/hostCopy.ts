import type { RenderCopy } from "@sexymud/core";

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
 * The hour labels are the calendar's segment IDS turned into Chinese words:
 * ids are keys the engine reads (the calendar schema says so — a display
 * name is the host's business), and which ring feeds the status line is
 * this host's choice (#48 D13: 状态行 = room name + game hour, derived by
 * the calendar pure function, worded from content keys).
 */

/** The status-line hour word: segment id → 「子时」-style label. */
const HOUR_LABELS: Readonly<Record<string, string>> = {
  zi: "子时",
  chou: "丑时",
  yin: "寅时",
  mao: "卯时",
  chen: "辰时",
  si: "巳时",
  wu: "午时",
  wei: "未时",
  shen: "申时",
  you: "酉时",
  xu: "戌时",
  hai: "亥时",
};

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
  /** Segment id → the Chinese hour word; an unknown id falls back to itself. */
  readonly hourLabels: Readonly<Record<string, string>>;
  /** The blank-name fallback on the title screen (#48 D4). */
  readonly defaultPlayerName: string;
  /**
   * The visible line for input no bound command claims — the caller's own
   * wording of resolve's `invalid` classification (spec/01 §4), never an
   * engine string.
   */
  unknownCommand(raw: string): string;
  /** The visible line when the autosave store failed (visible, not silent). */
  readonly saveFailed: string;
  /** The visible line when opening a new game itself failed (a wiring or pack break). */
  readonly openFailed: string;
}

export const WEB_HOST_COPY: HostCopy = {
  render: {
    you: "你",
    sayLine: "{speaker}说：{text}",
    departedLine: "{mover}离开了{from}。",
    arrivedLine: "{mover}来到了{to}。",
    appearanceTitle: "〔{name}〕",
    appearanceExits: "出路：{exits}",
    presenceRow: "{name}×{count}",
    appearanceItems: "这里有：{items}",
    appearancePeople: "在场：{people}",
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
  hourLabels: HOUR_LABELS,
  defaultPlayerName: "少侠",
  unknownCommand(raw) {
    return `「${raw}」是什么招式？`;
  },
  saveFailed: "（本地存档暂不可用，这一步之后的进度未能保存。）",
  openFailed: "开局失败——世界配置有误，无法进入江湖。",
};
