import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { setupCloud, type CloudStack } from "./cloudSetup.js";
import type { CloudSync } from "./game/cloudSync.js";
import { LocalSaveStore, LocalSaveUnavailableError } from "./game/localSaveStore.js";
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

/** The failure lines' shared look — one face for every door that failed. */
const failureLineStyle = { color: "#b91c1c", textAlign: "center", marginTop: 48 } as const;

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
  // The game's own slot, ONE instance for every face of it: the existence
  // probe below, the new game's autosave, and 「继续」's load all read and
  // write the same key.
  const gameSlot = useMemo(() => new LocalSaveStore(GAME_SLOT_KEY), []);
  const [game, setGame] = useState<{ session: GameSession; view: TerminalView } | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  // The 「继续」 failure's CLASS, not a bare flag (#52 复核 N-2, #53): the
  // two troubles point at opposite doors (#32 D4), so the face carries which
  // door — corrupt opens the overwrite ask, unavailable says how to retry.
  const [continueFailedKind, setContinueFailedKind] = useState<"corrupt" | "unavailable" | null>(
    null,
  );
  // The corrupt door's handle (#53/N-2): a rising signal — each click walks
  // the player into the SAME overwrite ask 「新游戏」 fires.
  const [overwriteAskSignal, setOverwriteAskSignal] = useState(0);
  const [hasSave, setHasSave] = useState(false);

  useEffect(() => {
    // The 「继续」 door's light is BYTES EXIST (#52) — not "a good save
    // exists": damage is judged on the click, by the load path that owns the
    // verdict, so a damaged save still lights the door and still fails
    // loudly where failing loudly lives. Re-probed on every return to the
    // title (#55): the session that just ended has written new bytes, and
    // the door re-lights by the same rule that lit it at boot.
    if (game !== null) return;
    gameSlot
      .readRaw()
      .then((raw) => setHasSave(raw.kind === "text"))
      .catch(() => setHasSave(false));
  }, [gameSlot, game]);

  /** One session wired to one terminal — both doors open the game the same way. */
  const openSession = () =>
    createPlayableSession({
      pack: loadShippedPack(),
      store: gameSlot,
      viewport: VIEWPORT,
      copy: WEB_HOST_COPY,
    });

  const startNewGame = (name: string) => {
    const assembly = openSession();
    // The output lines are pulled by snapshot, so lines published before the
    // terminal mounts are simply there when it first renders. A failed open
    // (a broken pack, a missing world table) stays ON the title screen and
    // says so — an unhandled rejection is not a message.
    assembly.session
      .startNewGame(name)
      .then(() => setGame(assembly))
      .catch(() => setOpenFailed(true));
  };

  const continueGame = () => {
    setContinueFailedKind(null);
    const assembly = openSession();
    assembly.session
      .continueGame()
      .then((outcome) => {
        // "no-save" is the honest no-op: the door was lit on bytes that
        // vanished between the probe and the click — there is nothing to
        // resume and nothing to say.
        if (outcome === "resumed") setGame(assembly);
      })
      // A load that fails loudly keeps its verdict (#52 AC3); the SURFACE
      // splits by class (#53/N-2): unreachable storage is its own door
      // (check settings), everything a load can throw here — the store's
      // corrupt verdict on the envelope, the engine's own damage verdict on
      // the payload — is the repair/overwrite door.
      .catch((error: unknown) => {
        setContinueFailedKind(
          error instanceof LocalSaveUnavailableError ? "unavailable" : "corrupt",
        );
      });
  };

  /**
   * The confirmed 「回标题」 gesture (#55): the host shell unmounts the game
   * — the session object goes unreachable, its last autosave already on the
   * slot (#48 D10 saves after every settled command), so no final save is
   * owed here. The returning title starts CLEAN: a failure line from a
   * previous title visit was answered by the game that superseded it, and
   * carrying it back would read as fresh trouble (the stale-face class N-A
   * named).
   */
  const returnToTitle = () => {
    setOpenFailed(false);
    setContinueFailedKind(null);
    setGame(null);
  };

  return (
    <main style={pageStyle}>
      {game ? (
        <GameTerminal
          view={game.view}
          backToTitle={WEB_HOST_COPY.backToTitle}
          onReturnToTitle={returnToTitle}
        />
      ) : (
        <>
          {openFailed ? (
            <p style={failureLineStyle}>{WEB_HOST_COPY.openFailed}</p>
          ) : null}
          {continueFailedKind === "corrupt" ? (
            <p style={failureLineStyle}>
              {WEB_HOST_COPY.continueFailed.corrupt}{" "}
              <button
                type="button"
                onClick={() => {
                  // The exit's job is done once the player is in the ask:
                  // the failure line steps aside for the overwrite flow
                  // (a cancelled ask still leaves 「新游戏」 as the way back).
                  setContinueFailedKind(null);
                  setOverwriteAskSignal((count) => count + 1);
                }}
              >
                {WEB_HOST_COPY.continueFailed.corruptExitLabel}
              </button>
            </p>
          ) : null}
          {continueFailedKind === "unavailable" ? (
            <p style={failureLineStyle}>{WEB_HOST_COPY.continueFailed.unavailable}</p>
          ) : null}
          <TitleScreen
            defaultName={WEB_HOST_COPY.defaultPlayerName}
            hasSave={hasSave}
            overwrite={WEB_HOST_COPY.overwrite}
            openOverwriteAsk={overwriteAskSignal}
            onContinue={continueGame}
            onNewGame={startNewGame}
          />
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
