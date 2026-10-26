import type { OutputLine } from "@sexymud/core";

/**
 * The web's TerminalView — the reference implementation of the multi-client
 * interface (spec/05 §9, ADR-0018). Deliberately NOT a React module: the
 * cross-client share is the INTERFACE and the LOGIC (append-only output, the
 * line buffer cap, the status panel, the command channel), so the machine
 * lives here in plain TypeScript and the React half (GameTerminal.tsx) only
 * renders it. A mini-program sibling implements the same four methods over
 * `scroll-view` without touching this file.
 *
 * The output contract (#48 D8): APPEND-ONLY — lines enter folded and chunked
 * (the engine's wrap/chunk output, fed by the session) and never move again
 * — resize does not re-fold, and appending cannot rewrite what is already on
 * screen. The buffer carries at most `limit` physical lines; overflow drops
 * the EARLIEST (spec/05 §7: an unbounded buffer drags a long session down).
 *
 * Each carried line gets a stable row id at append time. Index keys would
 * shift under the cap's drop-earliest trim and re-render the whole list;
 * with ids a drop removes exactly the dropped lines' nodes and nothing else
 * — the DOM face of "never a full re-render".
 */

/** What the status line shows: where the player stands, and when (#48 D13). */
export interface StatusPanel {
  readonly roomName: string;
  /** undefined when the pack ships no calendar ring for the hour. */
  readonly hourLabel: string | undefined;
}

/** One carried line with the stable id it was appended under. */
export interface TerminalRow {
  readonly id: number;
  readonly line: OutputLine;
}

/** One renderable snapshot — a stable reference until the next change. */
export interface TerminalSnapshot {
  readonly rows: readonly TerminalRow[];
  readonly status: StatusPanel | undefined;
}

/** The interface every client implements (spec/05 §9) plus the host's glue. */
export interface TerminalView {
  /** Incremental append — never a full re-render (spec/05 §9). */
  appendOutput(lines: readonly OutputLine[]): void;
  setStatus(panel: StatusPanel): void;
  /** Registers the ONE command channel (the input box's submit). */
  onCommand(cb: (raw: string) => void): void;
  /**
   * The suggestion port, deliberately empty: the signature is the mobile
   * trio's landing spot. The HISTORY leg arrived with the input component
   * (#53, commandHistory.ts); suggestions/completion are still no caller's
   * and no implementation's — they arrive with their own slice.
   */
  setSuggestions(list: readonly string[]): void;
  /**
   * Host glue (not part of the cross-client interface): fires the input
   * box's submit through the channel `onCommand` registered.
   */
  submitCommand(raw: string): void;

  // Host glue (not part of the cross-client interface): React subscribes.
  subscribe(listener: () => void): () => void;
  getSnapshot(): TerminalSnapshot;
}

export function createTerminalView(limit = 500): TerminalView {
  let rows: TerminalRow[] = [];
  let status: StatusPanel | undefined;
  let snapshot: TerminalSnapshot = { rows, status };
  let nextRowId = 1;
  const listeners = new Set<() => void>();
  let commandChannel: ((raw: string) => void) | undefined;

  const publish = (): void => {
    snapshot = { rows, status };
    for (const listener of listeners) listener();
  };

  return {
    appendOutput(appended) {
      if (appended.length === 0) return;
      // Append-only: the previous array is never edited; overflow drops the
      // earliest rows off the front, ids travelling with their lines.
      rows = [...rows, ...appended.map((line) => ({ id: nextRowId++, line }))];
      if (rows.length > limit) {
        rows = rows.slice(rows.length - limit);
      }
      publish();
    },
    setStatus(panel) {
      status = panel;
      publish();
    },
    onCommand(cb) {
      commandChannel = cb;
    },
    setSuggestions(_list) {
      // Still the empty port: the trio's history leg landed (#53); the
      // suggestions leg waits for its own slice — no caller wires this yet.
    },
    submitCommand(raw) {
      const trimmed = raw.trim();
      if (trimmed === "" || commandChannel === undefined) return;
      commandChannel(trimmed);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
