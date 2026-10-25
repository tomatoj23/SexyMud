import { useRef, useState } from "react";
import { createCommandHistory } from "./commandHistory.js";

/**
 * The command input component (#53) — the face that replaced #51's temporary
 * command box (one input surface evolving, never two). Three laws live here:
 *
 * - IME composition is a first-class citizen (G3): Enter while a composition
 *   is open NEVER submits the half-made pinyin — that Enter belongs to the
 *   IME (it commits the candidate). Every functional key yields during
 *   composition, including the history arrows (candidate navigation).
 * - The command history (up/down) is session state (spec/05 §9's recall
 *   leg): the plain-TS machine in commandHistory.ts dies with this
 *   component — one per game, nothing persisted.
 * - The player's input is shown VERBATIM: the draft is a controlled input's
 *   plain text and the output side renders engine tokens only (spec/05 §8's
 *   minimal face this slice; the full mechanism-level hardening is its own
 *   ticket).
 */

const inputStyle = { flex: 1, fontSize: 16, padding: "8px 12px" } as const;
const sendStyle = { fontSize: 16, padding: "8px 20px" } as const;

export function CommandInput(props: { readonly onSubmit: (raw: string) => void }) {
  const [draft, setDraft] = useState("");
  // Lazy-built once per mount: the history's lifetime IS this component's
  // (per game) — remounting a fresh game starts it empty.
  const [history] = useState(createCommandHistory);
  const composingRef = useRef(false);

  const send = () => {
    const raw = draft;
    setDraft("");
    history.submit(raw);
    props.onSubmit(raw);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      style={{ display: "flex", gap: 8, padding: "8px 0" }}
    >
      <input
        type="text"
        aria-label="命令输入"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          // WebKit fires the COMMITTING Enter's keydown after compositionend,
          // with isComposing already false — one macrotask of grace keeps
          // that Enter on the composing side of the line. A human's next
          // Enter lands long after the timer has run (G3, D2).
          setTimeout(() => {
            composingRef.current = false;
          }, 0);
        }}
        onKeyDown={(event) => {
          // A key the IME still owns: return untouched — no submit of the
          // half-made pinyin, no history step over the candidate window.
          if (composingRef.current || event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            // Enter submits EXPLICITLY: the browser's implicit form
            // submission is a courtesy some embedded webviews do not run
            // (verified in the in-app browser: a trusted, unprevented Enter
            // still fires no submit event). preventDefault keeps the
            // courtesy path from double-firing where it does work (#51).
            event.preventDefault();
            send();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setDraft(history.up(draft));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setDraft(history.down(draft));
          }
        }}
        style={inputStyle}
        autoFocus
      />
      <button type="submit" style={sendStyle}>
        发送
      </button>
    </form>
  );
}
