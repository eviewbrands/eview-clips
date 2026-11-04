import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

const stats = [
  { label: 'Lives', value: '12' },
  { label: 'Episódios', value: '36' },
  { label: 'Shorts', value: '148' },
  { label: 'Uploads', value: '3' },
];

const rows = [
  { title: 'Live 2026-11-03', status: 'Processando', channel: 'Canal do socio', progress: '82%' },
  { title: 'Live 2026-11-02', status: 'Pronto para revisão', channel: 'Canal do socio', progress: '100%' },
  { title: 'Live 2026-10-30', status: 'Em fila', channel: 'Canal do socio', progress: '34%' },
];

function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LIVEFLOW AI</p>
          <h1>Eview Clips</h1>
        </div>
        <button className="primary">Nova live</button>
      </header>

      <section className="stats">
        {stats.map((item) => (
          <article key={item.label} className="card">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Processamento</h2>
          <span>3 jobs ativos</span>
        </div>

        <table>
          <thead>
            <tr>
              <th>Live</th>
              <th>Status</th>
              <th>Canal</th>
              <th>Progresso</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.title}>
                <td>{row.title}</td>
                <td><span className="badge">{row.status}</span></td>
                <td>{row.channel}</td>
                <td>{row.progress}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
