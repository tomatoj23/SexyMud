const pageStyle = { maxWidth: 480, margin: "48px auto", fontFamily: "system-ui, sans-serif" } as const;

/**
 * Host shell placeholder.
 *
 * The idle-game domain model was cleared (see docs/engine-purity-audit.md). The
 * next milestone grows the command layer on the engine skeleton, following
 * docs/spec/02-command-layer.md. Until then the shell renders nothing but a
 * status line so the app still builds and the gates still run.
 */
export default function App() {
  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: 24, margin: 0 }}>SexyMUD</h1>
      <p>内核骨架已就绪，等待按 docs/spec/ 生长命令层。</p>
    </main>
  );
}
