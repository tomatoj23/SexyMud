import { useState, useSyncExternalStore } from "react";
import { CloudAuthError, type CloudAuth } from "../game/cloudAuth.js";

const rowStyle = { display: "flex", gap: 8, alignItems: "center", margin: "8px 0" } as const;
const inputStyle = { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 } as const;
const buttonStyle = { padding: "6px 12px", borderRadius: 4, cursor: "pointer" } as const;

/**
 * The login surface (#30, decision D1/D2/D6): username + password against the
 * account system — the only path to cloud identity (no anonymous mode, D2).
 * The three session states render differently on purpose: a DEAD session is a
 * re-login prompt naming the account it belonged to; a plain sign-out is just
 * the form (decision D6).
 */
export function AuthPanel({ auth }: { auth: CloudAuth }) {
  const state = useSyncExternalStore(
    (listener) => auth.subscribe(listener),
    () => auth.state,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(action: "signIn" | "signUp"): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await auth[action](username, password);
      setPassword("");
    } catch (cause) {
      // A login failure is NOT an expiry (decision D6): the state did not
      // move, the form just says what to fix (or to try again later).
      setError(cause instanceof CloudAuthError ? cause.message : "登录失败，请重试");
    } finally {
      setPending(false);
    }
  }

  if (state.status === "signed-in") {
    return (
      <section>
        <h2 style={{ fontSize: 18, margin: "16px 0 8px" }}>云存档</h2>
        <div style={rowStyle}>
          <span>已登录：{state.session.account}</span>
          <button
            style={buttonStyle}
            onClick={() => {
              // A failed logout must SAY so — silently staying "signed in"
              // after clicking 退出 is the quiet-degrade shape this project bans.
              auth.signOut().catch((cause: unknown) => {
                setError(cause instanceof Error ? `退出失败：${cause.message}` : "退出失败，请重试");
              });
            }}
          >
            退出
          </button>
        </div>
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, margin: "16px 0 8px" }}>云存档</h2>
      {state.status === "expired" && (
        <p style={{ color: "#b45309" }}>
          登录已过期（{state.account}）——重新登录以继续云存档。本地存档不受影响。
        </p>
      )}
      <div style={rowStyle}>
        <input
          style={inputStyle}
          placeholder="用户名"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={pending}
        />
        <input
          style={inputStyle}
          type="password"
          placeholder="密码"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
        />
      </div>
      <div style={rowStyle}>
        <button style={buttonStyle} onClick={() => void submit("signIn")} disabled={pending}>
          登录
        </button>
        <button style={buttonStyle} onClick={() => void submit("signUp")} disabled={pending}>
          注册
        </button>
      </div>
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </section>
  );
}
