export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="card">
        <h1>ParkSignal</h1>
        <p className="hint">Engine status: running</p>
        <p className="hint">Health endpoint: /api/health</p>
        <a className="button-link" href="/dashboard">
          Öppna dashboard
        </a>
      </section>
    </main>
  );
}
