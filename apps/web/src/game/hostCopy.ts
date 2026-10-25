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
  defaultPlayerName: "少侠",
  unknownCommand(raw) {
    return `「${raw}」是什么招式？`;
  },
  saveFailed: "（本地存档暂不可用，这一步之后的进度未能保存。）",
  openFailed: "开局失败——世界配置有误，无法进入江湖。",
};
