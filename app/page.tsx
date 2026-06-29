export default function Home() {
  return (
    <main style={{
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 32,
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      background: "#0f172a",
      color: "#e2e8f0",
    }}>
      <section style={{ maxWidth: 720 }}>
        <p style={{ margin: "0 0 12px", color: "#f97316", fontWeight: 700, letterSpacing: 0 }}>
          Disabled Southstar root homepage
        </p>
        <h1 style={{ margin: "0 0 16px", fontSize: 42, lineHeight: 1.1, letterSpacing: 0 }}>
          Use the active Pi Agent Web UI on port 30141.
        </h1>
        <p style={{ margin: "0 0 20px", color: "#cbd5e1", fontSize: 17, lineHeight: 1.6 }}>
          This root Next.js homepage is intentionally disabled to prevent opening the wrong UI.
        </p>
        <pre style={{
          margin: 0,
          padding: 16,
          borderRadius: 8,
          background: "#020617",
          color: "#e2e8f0",
          overflowX: "auto",
        }}>{`cd /home/timmypai/apps/southstar/web
npm run dev

http://127.0.0.1:30141`}</pre>
      </section>
    </main>
  );
}
