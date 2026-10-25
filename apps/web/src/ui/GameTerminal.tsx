import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
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

const statusStyle = {
  padding: "6px 12px",
  borderBottom: "1px solid #d1d5db",
  color: "#374151",
} as const;

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

export function GameTerminal(props: { readonly view: TerminalView }) {
  const view = props.view;
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot);

  const status = snapshot.status;
  return (
    <div style={shellStyle}>
      <div style={statusStyle} data-status>
        {status ? `${status.roomName}${status.hourLabel ? ` · ${status.hourLabel}` : ""}` : ""}
      </div>
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
