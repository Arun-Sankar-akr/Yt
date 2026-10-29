import { useCallback, useEffect, useRef, useState } from 'react';
import TorrentDownloader from './components/TorrentDownloader';
import YouTubeDownloader from './components/YouTubeDownloader';
import { Icon } from './components/Icons';
import { Footer } from './components/Sections';
import { API } from '../server/api';
import logo from "./assets/favicon.png"
import './App.css';

const TABS = [
  { id: 'torrent', label: 'Magnet link', icon: 'magnet', View: TorrentDownloader },
  { id: 'youtube', label: 'YouTube', icon: 'video', View: YouTubeDownloader },
];

const STATUS = { active: 'In progress', paused: 'Paused', done: 'Done', error: 'Failed', removed: 'Removed', cancelled: 'Cancelled' };

// Decide which tool a pasted link belongs to
const detect = v =>
  (/^magnet:\?/i.test(v) || /^https?:\/\/\S+\.torrent(\?\S*)?$/i.test(v)) ? 'torrent'
    : /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(v) ? 'youtube'
      : null;

// Pings the API every 15 seconds so the header can show whether it is running
function useServer() {
  const [s, setS] = useState({ state: 'checking', ms: null });
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const t = performance.now();
      try {
        await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(4000) });
        if (alive) setS({ state: 'online', ms: Math.round(performance.now() - t) });
      } catch {
        if (alive) setS({ state: 'offline', ms: null });
      }
    };
    ping();
    const id = setInterval(ping, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return s;
}

function ActivityCard({ items }) {
  return (
    <section className="side-card" aria-labelledby="act-title">
      <h2 id="act-title">Recent activity</h2>
      {items.length === 0 ? (
        <div className="empty-sm">
          <Icon name="inbox" size={22} />
          <p>Nothing yet. Downloads you start will show up here.</p>
        </div>
      ) : (
        <ul className="activity">
          {items.slice(0, 6).map(a => (
            <li key={a.id}>
              <span className="act-icon"><Icon name={a.type === 'torrent' ? 'magnet' : 'video'} size={16} /></span>
              <div className="act-body">
                <p className="act-title" title={a.title}>{a.title}</p>
                {a.status === 'active'
                  ? <div className="mini-bar"><i style={{ width: `${a.pct || 0}%` }} /></div>
                  : <p className="act-note">{a.note || (a.type === 'torrent' ? 'Torrent' : 'YouTube')}</p>}
              </div>
              <span className="badge" data-s={a.status}>{a.status === 'active' ? `${a.pct || 0}%` : STATUS[a.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LinkTips() {
  return (
    <section className="side-card" aria-labelledby="tips-title">
      <h2 id="tips-title">Links that work</h2>
      <ul className="tips">
        <li>youtube.com/watch, youtu.be and music.youtube.com links</li>
        <li>Shorts, embed and live links</li>
        <li>Magnet links that start with magnet:?</li>
      </ul>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState('torrent');
  const [smart, setSmart] = useState('');
  const [hint, setHint] = useState('');
  const [prefill, setPrefill] = useState(null);
  const [activity, setActivity] = useState([]);
  const workRef = useRef(null);
  const server = useServer();

  // Children call this to add or update an entry; unchanged updates are ignored
  const report = useCallback((id, patch) => setActivity(list => {
    const i = list.findIndex(a => a.id === id);
    if (i === -1) return [{ id, ...patch }, ...list].slice(0, 20);
    const cur = list[i];
    if (Object.keys(patch).every(k => cur[k] === patch[k])) return list;
    const next = [...list];
    next[i] = { ...cur, ...patch };
    return next;
  }), []);

  function onSmartSubmit(e) {
    e.preventDefault();
    const v = smart.trim();
    const kind = detect(v);
    if (!kind) return setHint('That does not look like a magnet link, a .torrent link or a YouTube link.');
    setHint('');
    setTab(kind);
    setPrefill({ tab: kind, value: v, n: Date.now() });
    setSmart('');
    workRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="#top" aria-label="Grab home">
          <span className="brand-mark"><img src={logo} alt="Grab_Logo" id='logo' /></span>
          Grab
        </a>
        <span className="pill" data-state={server.state} role="status">
          <span className="dot" />
          {server.state === 'online' ? `Server online · ${server.ms} ms`
            : server.state === 'offline' ? 'Server offline' : 'Checking server'}
        </span>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title">Paste a link. Get the file.</h1>
          <p className="hero-sub">
            Save videos and audio from YouTube, or download anything from a magnet link.
            Everything runs on your own computer.
          </p>
          <form className="field big" onSubmit={onSmartSubmit}>
            <Icon name="link" size={20} />
            <input
              value={smart}
              onChange={e => { setSmart(e.target.value); setHint(''); }}
              placeholder="youtube.com/watch… or magnet:?xt=…"
              aria-label="Paste a YouTube or magnet link"
            />
            <button className="btn primary" disabled={!smart.trim()}>Continue</button>
          </form>
          {hint && <p className="notice error" role="alert">{hint}</p>}
          <ul className="supports" aria-label="Supported sources">
            <li><Icon name="video" size={16} /> YouTube video</li>
            <li><Icon name="music" size={16} /> YouTube audio</li>
            <li><Icon name="magnet" size={16} /> Magnet links</li>
          </ul>
          {server.state === 'offline' && (
            <p className="notice error" role="alert">
              Cannot reach the server on port 4000. Open the server folder, run <code>npm i</code> and
              <code>npm start</code>, then reload this page.
            </p>
          )}
        </section>

        <section className="work" id="workspace" ref={workRef}>
          <div className="panel" data-tab={tab}>
            <div className="panel-head" role="tablist" aria-label="Download type">
              {TABS.map(t => (
                <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id}
                        aria-controls={`pane-${t.id}`} onClick={() => setTab(t.id)}>
                  <Icon name={t.icon} size={18} /> {t.label}
                </button>
              ))}
            </div>
            {TABS.map(({ id, View }) => (
              <div key={id} id={`pane-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`}
                   className="panel-body" hidden={tab !== id}>
                <View report={report} prefill={prefill?.tab === id ? prefill : null} />
              </div>
            ))}
          </div>
          <aside className="side">
            <ActivityCard items={activity} />
            <LinkTips />
          </aside>
        </section>

      </main>

      <Footer />
    </div>
  );
}