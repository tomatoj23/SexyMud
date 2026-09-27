import { useEffect, useState, useSyncExternalStore } from "react";
import { CloudAuthError, type CloudAuth, type SignUpAttempt } from "../game/cloudAuth.js";

const rowStyle = { display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" } as const;
const inputStyle = { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 } as const;
const buttonStyle = { padding: "6px 12px", borderRadius: 4, cursor: "pointer" } as const;

/**
 * The login surface (#30, decision D1/D2/D6): account (email or username) +
 * password against the account system — the only path to cloud identity (no
 * anonymous mode, D2). Registration is the backend's two-step OTP flow
 * (decision D1, ADR-0037): an email + password mails a code, the code
 * completes the account. The three session states render differently on
 * purpose: a DEAD session is a re-login prompt naming the account it belonged
 * to; a plain sign-out is just the form (decision D6).
 */
export function AuthPanel({ auth }: { auth: CloudAuth }) {
  const state = useSyncExternalStore(
    (listener) => auth.subscribe(listener),
    () => auth.state,
  );
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [attempt, setAttempt] = useState<SignUpAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A stale error must not survive a state change: whatever the player did
  // landed, and the message below would be talking about a dead attempt.
  useEffect(() => {
    setError(null);
    setAttempt(null);
    setCode("");
  }, [state.status]);

  async function run(what: () => Promise<unknown>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await what();
      setPassword("");
    } catch (cause) {
      // A login failure is NOT an expiry (decision D6): the state did not
      // move, the form just says what to fix (or to try again later).
      setError(cause instanceof CloudAuthError ? cause.message : "操作失败，请重试");
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
            disabled={pending}
            onClick={() => {
              // A failed logout must SAY so — silently flipping to "signed
              // out" over a live backend session is the quiet-degrade shape
              // this project bans.
              void run(() => auth.signOut());
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
          placeholder="账号（邮箱或用户名）"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
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

      {attempt ? (
        <>
          <p style={{ margin: "4px 0" }}>验证码已发送到 {account}，请查收：</p>
          <div style={rowStyle}>
            <input
              style={inputStyle}
              placeholder="验证码"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={pending}
            />
            <button
              style={buttonStyle}
              disabled={pending || code === ""}
              onClick={() => void run(() => attempt.verify(code))}
            >
              完成注册
            </button>
          </div>
        </>
      ) : (
        <div style={rowStyle}>
          <button style={buttonStyle} onClick={() => void run(() => auth.signIn(account, password))} disabled={pending}>
            登录
          </button>
          <button
            style={buttonStyle}
            disabled={pending}
            onClick={() => {
              // Registration is two-step by the backend's design (decision
              // D1): this mails the code; "完成注册" lands the account.
              if (!account.includes("@")) {
                setError("注册需要邮箱（验证码发送到邮箱；用户名可在注册后作登录名）");
                return;
              }
              void run(async () => setAttempt(await auth.signUp(account, password)));
            }}
          >
            注册
          </button>
        </div>
      )}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </section>
  );
}
