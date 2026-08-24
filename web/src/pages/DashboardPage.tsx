export function DashboardPage() {
  return (
    <section className="dashboard-page" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title">
        Bonjour Erwan !
      </h1>
      <div className="dashboard-card-row" aria-hidden="true">
        <div className="dashboard-card" />
        <div className="dashboard-card" />
      </div>
      <div className="dashboard-card dashboard-card-wide" aria-hidden="true" />
    </section>
  );
}
