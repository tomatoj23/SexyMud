import { useState } from "react";

/**
 * The title screen (#51; #48 D11): the door into the world — one name box
 * and, since #52, the save loop's two doors: 「继续」 lights only when a
 * save exists (clicking resumes it), and a new game over an existing save
 * asks ONCE before overwriting.
 *
 * The name is a DISPLAY field only (the actor id is the fixed `player`,
 * #48 D4): a blank box means the default name (「少侠」), and the chosen
 * name reaches the game as `onNewGame(name)` — never as an id, never
 * derived into one.
 *
 * The ask is IN-UI on purpose (not window.confirm): embedded webviews run
 * no dialogs — the same shell that never ran implicit form submission
 * (#51's verified finding) — and a native dialog is a door the host
 * cannot style, test, or trust.
 */

const boxStyle = {
  maxWidth: 480,
  margin: "96px auto 0",
  textAlign: "center",
  fontFamily: "system-ui, sans-serif",
} as const;

const inputStyle = {
  fontSize: 18,
  padding: "8px 12px",
  width: "16em",
  marginRight: 8,
} as const;

const buttonStyle = { fontSize: 18, padding: "8px 20px" } as const;

/** The overwrite ask's words — host copy, injected (Q5). */
export interface OverwriteCopy {
  readonly prompt: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface TitleScreenProps {
  /** The blank-name fallback (#48 D4, the host's word — Q5). */
  readonly defaultName: string;
  /** Fired with the display name (blank → defaultName). */
  readonly onNewGame: (name: string) => void;
  /**
   * A save exists (#52): the 「继续」 door lights up. Absent (the default)
   * the door stays unlit — no save, no resume.
   */
  readonly hasSave?: boolean;
  /** The resume gesture (#52); the door renders only when both are present. */
  readonly onContinue?: () => void;
  /**
   * The overwrite ask's words (#52). With a save present and this copy
   * injected, 「新游戏」 asks once before firing `onNewGame`; a host that
   * words no ask keeps #51's direct behavior.
   */
  readonly overwrite?: OverwriteCopy;
}

export function TitleScreen(props: TitleScreenProps) {
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const chosenName = () => name.trim() || props.defaultName;
  const start = () => {
    // An existing save is progress on the line: overwriting it asks ONCE —
    // never a silent overwrite, never lost progress (#52 AC2).
    if (props.hasSave && props.overwrite !== undefined) {
      setConfirming(true);
      return;
    }
    props.onNewGame(chosenName());
  };
  // During the ask the buttons carry the gesture — Enter starts nothing.
  const submitGesture = () => {
    if (!confirming) start();
  };
  return (
    <div style={boxStyle}>
      <h1 style={{ fontSize: 32, letterSpacing: 8 }}>江湖</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>但行前路，无问西东。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitGesture();
        }}
      >
        <input
          type="text"
          aria-label="角色名字"
          placeholder={props.defaultName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // Enter starts the game EXPLICITLY — some embedded webviews
            // never run the browser's implicit form submission (see
            // GameTerminal's command box, the same finding). preventDefault
            // keeps hosts that do run it from double-firing.
            if (event.key === "Enter") {
              event.preventDefault();
              submitGesture();
            }
          }}
          style={inputStyle}
          autoFocus
        />
        {confirming && props.overwrite ? (
          <>
            <p style={{ color: "#b91c1c" }}>{props.overwrite.prompt}</p>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => props.onNewGame(chosenName())}
            >
              {props.overwrite.confirmLabel}
            </button>
            <button type="button" style={buttonStyle} onClick={() => setConfirming(false)}>
              {props.overwrite.cancelLabel}
            </button>
          </>
        ) : (
          <>
            {props.hasSave && props.onContinue ? (
              <button type="button" style={buttonStyle} onClick={props.onContinue}>
                继续
              </button>
            ) : null}
            <button type="submit" style={buttonStyle}>
              新游戏
            </button>
          </>
        )}
      </form>
    </div>
  );
}
