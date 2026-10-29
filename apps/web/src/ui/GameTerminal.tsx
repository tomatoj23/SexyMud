import type { CSSProperties } from "react";
import { useState, useSyncExternalStore } from "react";
import type { OutputSpan, StyleName } from "@sexymud/core";
import { CommandInput } from "./CommandInput.js";
import type { TerminalView } from "./terminalView.js";

/**
 * The React half of the reference TerminalView (spec/05 §9): it renders
 * whatever the plain-TS machine (terminalView.ts) holds and forwards the
 * input box's submits into it. The cross-client share is the machine; this
 * component is web-only presentation (ADR-0018).
 *
 * Lines are final when they arrive (append-only, already folded and chunked
 * by the engine's wrap/chunk through the session) — so the output stream is
 * `white-space: pre` with no wrapping of its own: a resize moves nothing
 * (#48 D8, 追加即定稿), and scrolling is this client's own business
 * (spec/05 §7 — non-modal, input never hijacked).
 *
 * The style face maps the engine's SEMANTIC names to looks here, once per
 * client (spec/05 §4): a new highlight is a dimensions-table row plus one
 * row in STYLE_LOOKS, zero engine change. Unknown names degrade to plain —
 * a style must never be the only carrier of information.
 */

const STYLE_LOOKS: Record<string, CSSProperties> = {
  roomName: { color: "#0e7490", fontWeight: 600 },
  npcName: { color: "#7c3aed" },
  itemName: { color: "#15803d" },
  commandHint: { color: "#475569" },
  danger: { color: "#b91c1c" },
  good: { color: "#15803d" },
};

function Span(props: { readonly span: OutputSpan }) {
  const look = STYLE_LOOKS[props.span.style as StyleName];
  if (look === undefined) {
    return <span>{props.span.text}</span>;
  }
  return <span style={look}>{props.span.text}</span>;
}

const shellStyle = {
  maxWidth: 720,
  margin: "24px auto",
  fontFamily: "system-ui, sans-serif",
} as const;

/** The status row's shell: the room line left, the 「回标题」 door right (#55). */
const statusRowStyle = {
  display: "flex",
  alignItems: "center",
  borderBottom: "1px solid #d1d5db",
} as const;

const statusStyle = {
  padding: "6px 12px",
  color: "#374151",
} as const;

const exitButtonStyle = {
  marginLeft: "auto",
  marginRight: 12,
  fontSize: 14,
  padding: "4px 12px",
} as const;

/** The 「回标题」 ask strip — the same in-UI shape the title screen's asks use. */
const exitAskStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid #d1d5db",
  color: "#b91c1c",
} as const;

const exitAskButtonStyle = {
  marginLeft: 12,
  fontSize: 14,
  padding: "4px 12px",
  color: "#374151",
} as const;

/** The back-to-title door's words — host copy, injected (Q5). */
export interface BackToTitleCopy {
  /** The door's own label, on the status row. */
  readonly exitLabel: string;
  /** The ask's one line — it names both halves: the game ends, the save stays. */
  readonly ask: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

const streamStyle = {
  padding: "12px",
  minHeight: 320,
  maxHeight: 480,
  overflowY: "auto",
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 14,
  lineHeight: 1.7,
  whiteSpace: "pre",
} as const;

export interface GameTerminalProps {
  readonly view: TerminalView;
  /**
   * The 「回标题」 door's words (#55); the door renders only when both this
   * and the gesture below are present — the same law as the title screen's
   * 「继续」.
   */
  readonly backToTitle?: BackToTitleCopy;
  /**
   * Fired once the player CONFIRMS the exit — the host shell unmounts the
   * game and the title returns; the save keeps standing wherever the
   * session's autosave left it.
   */
  readonly onReturnToTitle?: () => void;
}

export function GameTerminal(props: GameTerminalProps) {
  const view = props.view;
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot);
  // The exit is a CONFIRMED gesture (#55): the ask says the save stays, and
  // nothing is hijacked while it stands — the stream and the command box
  // play on (spec/05 §7, non-modal).
  const [askingReturn, setAskingReturn] = useState(false);
  const returnDoor =
    props.backToTitle !== undefined && props.onReturnToTitle !== undefined
      ? { copy: props.backToTitle, confirm: props.onReturnToTitle }
      : undefined;

  const status = snapshot.status;
  return (
    <div style={shellStyle}>
      <div style={statusRowStyle}>
        <div style={statusStyle} data-status>
          {status ? `${status.roomName}${status.hourLabel ? ` · ${status.hourLabel}` : ""}` : ""}
        </div>
        {returnDoor && !askingReturn ? (
          <button type="button" style={exitButtonStyle} onClick={() => setAskingReturn(true)}>
            {returnDoor.copy.exitLabel}
          </button>
        ) : null}
      </div>
      {askingReturn && returnDoor ? (
        <div style={exitAskStyle}>
          {returnDoor.copy.ask}
          <button type="button" style={exitAskButtonStyle} onClick={returnDoor.confirm}>
            {returnDoor.copy.confirmLabel}
          </button>
          <button
            type="button"
            style={exitAskButtonStyle}
            onClick={() => setAskingReturn(false)}
          >
            {returnDoor.copy.cancelLabel}
          </button>
        </div>
      ) : null}
      <div style={streamStyle} role="log" aria-live="polite" aria-label="输出流">
        {snapshot.rows.map((row) => (
          <div key={row.id}>
            {row.line.spans.map((span, index) => (
              <Span key={index} span={span} />
            ))}
          </div>
        ))}
      </div>
      {/* The input face is the command input component (#53): IME-safe,
          history-capable — one input surface since #51, evolved in place. */}
      <CommandInput onSubmit={(raw) => view.submitCommand(raw)} />
    </div>
  );
}
