import { useEffect, useRef, useState } from "react";
import type { Game } from "@idlerpg/core";
import { loadGame, resetSave } from "./game/loader.js";

interface View {
  realmName: string;
  progressResourceName: string;
  current: number;
  required: number;
  activityName: string | null;
}

const pageStyle = { maxWidth: 480, margin: "48px auto", fontFamily: "system-ui, sans-serif" } as const;
const buttonStyle = { padding: "8px 24px", fontSize: 16 } as const;

export default function App() {
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const gameRef = useRef<Game | null>(null);
  const firstActivityRef = useRef<{ id: string; name: string } | null>(null);
  const saveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    let unsubscribe: (() => void) | undefined;
    let onUnload: (() => void) | undefined;

    loadGame()
      .then(({ game, saveStore, content }) => {
        if (cancelled) return;
        gameRef.current = game;
        firstActivityRef.current = content.activities[0] ?? null;
        saveRef.current = () => {
          void saveStore.save(game.snapshot());
        };

        const render = () => {
          const realm = game.currentRealm();
          const progress = game.progress();
          const activity = game.activeActivity();
          setView({
            realmName: realm.name,
            progressResourceName: content.progressResourceName,
            current: progress.current,
            required: progress.required,
            activityName: activity?.name ?? null,
          });
        };

        unsubscribe = game.subscribe(render);
        game.sync(); // settle the offline gap on load (fires an accrual event)
        render();
        timers.push(window.setInterval(() => game.sync(), 1000));
        timers.push(window.setInterval(() => saveRef.current?.(), 5000));
        onUnload = () => saveRef.current?.();
        window.addEventListener("beforeunload", onUnload);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(String(error));
      });

    return () => {
      cancelled = true;
      for (const t of timers) window.clearInterval(t);
      unsubscribe?.();
      if (onUnload) window.removeEventListener("beforeunload", onUnload);
      saveRef.current?.();
    };
  }, []);

  const toggleActivity = () => {
    const game = gameRef.current;
    const first = firstActivityRef.current;
    if (!game || !first) return;
    if (game.activeActivity()) game.stopActivity();
    else game.startActivity(first.id);
  };

  if (loadError) {
    return (
      <main style={pageStyle}>
        <p>存档加载失败：{loadError}</p>
        <button
          onClick={() => {
            void resetSave().then(() => window.location.reload());
          }}
          style={buttonStyle}
        >
          重置存档并重试
        </button>
      </main>
    );
  }

  if (!view) {
    return (
      <main style={pageStyle}>
        <p>加载中……</p>
      </main>
    );
  }

  const percent = view.required > 0 ? Math.min(100, (view.current / view.required) * 100).toFixed(1) : "0";

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: 24, margin: 0 }}>IdleRPG</h1>
      <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, display: "grid", gap: 8 }}>
        <p style={{ margin: 0, fontSize: 20 }}>{view.realmName}</p>
        <p style={{ margin: 0 }}>
          {view.progressResourceName}：{view.current} / {view.required}（{percent}%）
        </p>
        <button onClick={toggleActivity} style={buttonStyle}>
          {view.activityName ? "停止" : (firstActivityRef.current?.name ?? "开始")}
        </button>
      </section>
    </main>
  );
}
