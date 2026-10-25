import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { setupCloud, type CloudStack } from "./cloudSetup.js";
import type { CloudSync } from "./game/cloudSync.js";
import { LocalSaveStore } from "./game/localSaveStore.js";
import { loadShippedPack } from "./game/browserPack.js";
import { createPlayableSession } from "./game/gameSession.js";
import type { GameSession } from "./game/gameSession.js";
import { WEB_HOST_COPY } from "./game/hostCopy.js";
import type { TerminalView } from "./ui/terminalView.js";
import { AuthPanel } from "./ui/AuthPanel.js";
import { CloudSavePanel } from "./ui/CloudSavePanel.js";
import { GameTerminal } from "./ui/GameTerminal.js";
import { TitleScreen } from "./ui/TitleScreen.js";

const pageStyle = { margin: "0 auto", fontFamily: "system-ui, sans-serif" } as const;

/**
 * The tracer bullet's first cut terminal geometry (#48 D7): the width and
 * height are the chunker's INPUTS — fixed numbers this slice, a real
 * measurement later; the engine pins no column constant (spec/05 §1).
 */
const VIEWPORT = { width: 40, height: 24 };

/**
 * The game's own local slot — distinct from the cloud-sync panel's
 * save-slot-1 on purpose: the panel syncs a save between stores, the game
 * OWNS this one (its reader, #52's 继续按钮, reads the same key).
 */
const GAME_SLOT_KEY = "game-slot-1";

/**
 * Host shell. The tracer bullet (#51) makes the game the door: the title
 * screen starts a new game (world guidance → terminal), and the cloud-save
 * surface (#30) stays below it — login and the sync status over the save
 * slot, unchanged.
 */
export default function App() {
  const cloud = useMemo(() => setupCloud(import.meta.env.VITE_CLOUDBASE_ENV_ID), []);
  const [game, setGame] = useState<{ session: GameSession; view: TerminalView } | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  const startNewGame = (name: string) => {
    const assembly = createPlayableSession({
      pack: loadShippedPack(),
      store: new LocalSaveStore(GAME_SLOT_KEY),
      viewport: VIEWPORT,
      copy: WEB_HOST_COPY,
    });
    // The output lines are pulled by snapshot, so lines published before the
    // terminal mounts are simply there when it first renders. A failed open
    // (a broken pack, a missing world table) stays ON the title screen and
    // says so — an unhandled rejection is not a message.
    assembly.session
      .startNewGame(name)
      .then(() => setGame(assembly))
      .catch(() => setOpenFailed(true));
  };

  return (
    <main style={pageStyle}>
      {game ? (
        <GameTerminal view={game.view} />
      ) : (
        <>
          {openFailed ? (
            <p style={{ color: "#b91c1c", textAlign: "center", marginTop: 48 }}>
              {WEB_HOST_COPY.openFailed}
            </p>
          ) : null}
          <TitleScreen defaultName={WEB_HOST_COPY.defaultPlayerName} onNewGame={startNewGame} />
        </>
      )}
      {cloud ? (
        <CloudShell cloud={cloud} />
      ) : (
        <p style={{ color: "#6b7280", textAlign: "center" }}>
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
    <section style={{ maxWidth: 480, margin: "32px auto" }}>
      <AuthPanel auth={cloud.auth} />
      {sync ? <CloudSavePanel sync={sync} /> : <p>登录后启用云存档（跨设备续档）。</p>}
    </section>
  );
}
