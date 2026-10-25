/**
 * The command history the input box browses (#53) — the recall leg of the
 * mobile trio (spec/05 §9), so it lives in plain TypeScript beside the
 * terminal machine: the logic is what a mini-program sibling shares, the
 * React component (CommandInput.tsx) is only its web face.
 *
 * SESSION-SCOPED BY CONSTRUCTION: the instance lives in memory and dies with
 * the component that owns it (one per game — a reopened game starts empty);
 * nothing here touches storage, so 「重开即空、不落盘」 is not a policy the
 * caller must enforce but the shape of the object itself.
 *
 * The browsing model is the classic one: a cursor that sits at "live" (the
 * draft as typed) until the first up; the live draft is kept as the cushion
 * a down past the newest entry restores. Submitting (or submitting nothing
 * but whitespace) always returns the cursor to live.
 */
export interface CommandHistory {
  /** Records one submitted command; whitespace-only input is not history. */
  submit(raw: string): void;
  /** Browses one entry older; the oldest entry clamps; a live draft is saved. */
  up(currentDraft: string): string;
  /** Browses one entry newer; past the newest restores the saved live draft. */
  down(currentDraft: string): string;
}

export function createCommandHistory(): CommandHistory {
  const entries: string[] = [];
  let cursor = -1;
  let liveDraft = "";

  return {
    submit(raw) {
      const trimmed = raw.trim();
      if (trimmed === "") return;
      entries.push(trimmed);
      cursor = -1;
      liveDraft = "";
    },
    up(currentDraft) {
      if (entries.length === 0) return currentDraft;
      if (cursor === -1) {
        liveDraft = currentDraft;
        cursor = entries.length - 1;
      } else if (cursor > 0) {
        cursor -= 1;
      }
      // The cursor is clamped inside the entries by construction; the
      // fallback only satisfies the compiler's doubt about index access.
      return entries[cursor] ?? currentDraft;
    },
    down(currentDraft) {
      if (cursor === -1) return currentDraft;
      if (cursor < entries.length - 1) {
        cursor += 1;
        return entries[cursor] ?? currentDraft;
      }
      cursor = -1;
      return liveDraft;
    },
  };
}
