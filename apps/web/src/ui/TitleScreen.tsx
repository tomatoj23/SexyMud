import { useState } from "react";

/**
 * The title screen (#51; #48 D11): the door into the world. One name box
 * and one button this slice — 「继续」 lands with the save loop (#52).
 *
 * The name is a DISPLAY field only (the actor id is the fixed `player`,
 * #48 D4): a blank box means the default name (「少侠」), and the chosen
 * name reaches the game as `onNewGame(name)` — never as an id, never
 * derived into one.
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

export interface TitleScreenProps {
  /** The blank-name fallback (#48 D4, the host's word — Q5). */
  readonly defaultName: string;
  /** Fired with the display name (blank → defaultName). */
  readonly onNewGame: (name: string) => void;
}

export function TitleScreen(props: TitleScreenProps) {
  const [name, setName] = useState("");
  const start = () => {
    props.onNewGame(name.trim() || props.defaultName);
  };
  return (
    <div style={boxStyle}>
      <h1 style={{ fontSize: 32, letterSpacing: 8 }}>江湖</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>但行前路，无问西东。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <input
          type="text"
          aria-label="角色名字"
          placeholder={props.defaultName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={inputStyle}
          autoFocus
        />
        <button type="submit" style={buttonStyle}>
          新游戏
        </button>
      </form>
    </div>
  );
}
