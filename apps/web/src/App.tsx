import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { setupCloud, type CloudStack } from "./cloudSetup.js";
import type { CloudSync } from "./game/cloudSync.js";
import { AuthPanel } from "./ui/AuthPanel.js";
import { CloudSavePanel } from "./ui/CloudSavePanel.js";

const pageStyle = { maxWidth: 480, margin: "48px auto", fontFamily: "system-ui, sans-serif" } as const;

/**
 * Host shell. The idle-game domain model was cleared (see
 * docs/engine-purity-audit.md); the next milestone grows the command layer on
 * the engine skeleton (docs/spec/02). What lives here today is the cloud-save
 * surface (#30): login and the sync status / conflict adjudication over the
 * player's save slot.
 */
export default function App() {
  const cloud = useMemo(() => setupCloud(import.meta.env.VITE_CLOUDBASE_ENV_ID), []);

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: 24, margin: 0 }}>SexyMUD</h1>
      <p>内核骨架已就绪，等待按 docs/spec/ 生长命令层。</p>
      {cloud ? (
        <CloudShell cloud={cloud} />
      ) : (
        <p style={{ color: "#6b7280" }}>
          云存档未配置（缺 VITE_CLOUDBASE_ENV_ID）——本地存档照常可用。
        </p>
      )}
    </main>
  );
}

/**
 * The cloud half, alive only around a session: a sync stack opens when a
 * session exists and closes when it dies — the transport is bound to ONE
 * authenticated session (decision D1 of #29), so a re-login rebuilds it
 * (decision D6).
 */
function CloudShell({ cloud }: { cloud: CloudStack }) {
  const authState = useSyncExternalStore(
    (listener) => cloud.auth.subscribe(listener),
    () => cloud.auth.state,
  );
  const [sync, setSync] = useState<CloudSync | null>(null);

  // Boot: probe for a persisted session (never an "expired" — see CloudAuth.restore).
  // A failed probe REJECTS (#43, decision D1) — the binding keeps that
  // information; how quiet a flaky boot goes is THIS layer's decision, and
  // this shell stays quiet (the login form is the same fix either way).
  useEffect(() => {
    void cloud.auth.restore().catch(() => undefined);
  }, [cloud]);

  useEffect(() => {
    if (authState.status !== "signed-in") {
      setSync(null);
      return;
    }
    const instance = cloud.openSync(authState.session);
    setSync(instance);
    // Decision D3: show both sides, sync nothing. A fresh instance is idle, so
    // this call cannot trigger a guard refusal (and work failures land as
    // machine state the panel renders) — the catch only keeps a future refusal
    // from surfacing as an unhandled rejection.
    void instance.probe().catch(() => undefined);
    return () => setSync(null);
  }, [cloud, authState]);

  return (
    <>
      <AuthPanel auth={cloud.auth} />
      {sync ? <CloudSavePanel sync={sync} /> : <p>登录后启用云存档（跨设备续档）。</p>}
    </>
  );
}
