import { useEffect, useRef, useState } from 'react';
import { API, fmtBytes } from '../../server/api';
import { Icon } from './Icons';

const fmtEta = (left, speed) => {
  if (!speed || !left) return '—';
  const s = Math.round(left / speed);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export default function TorrentDownloader({ report, prefill }) {
  const [magnet, setMagnet] = useState('');
  const [hash, setHash] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const seen = useRef(0);

  // A magnet link pasted into the hero box arrives here
  useEffect(() => {
    if (!prefill || seen.current === prefill.n) return;
    seen.current = prefill.n;
    setMagnet(prefill.value);
  }, [prefill]);

  useEffect(() => {
    if (!hash) return;
    const es = new EventSource(`${API}/api/torrent/${hash}/events`);
    es.onmessage = e => {
      const d = JSON.parse(e.data);
      setStats(d);
      if (d.gone) return report?.(hash, { status: 'removed' });
      report?.(hash, {
        type: 'torrent',
        title: d.name || 'Fetching metadata…',
        status: d.progress === 1 ? 'done' : d.paused ? 'paused' : 'active',
        pct: Math.round(d.progress * 100),
        note: fmtBytes(d.size),
      });
    };
    return () => es.close();
  }, [hash, report]);

  async function start(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await fetch(`${API}/api/torrent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: magnet.trim() }),
      });
      const j = await r.json();
      if (!r.ok) return setError(j.error);
      setStats(null);
      setHash(j.infoHash);
      report?.(j.infoHash, { type: 'torrent', title: 'Fetching metadata…', status: 'active', pct: 0 });
    } catch {
      setError('Cannot reach the server. Is it running on port 4000?');
    }
  }

  async function togglePause() {
    const action = stats.paused ? 'resume' : 'pause';
    try {
      await fetch(`${API}/api/torrent/${hash}/${action}`, { method: 'POST' });
      setStats(st => st && { ...st, paused: action === 'pause', down: 0 });
    } catch {
      setError('Cannot reach the server. Is it running on port 4000?');
    }
  }

  // Cancel removes the torrent and deletes what was downloaded so far. A finished torrent keeps its files.
  async function cancel() {
    const finished = stats?.progress === 1;
    try {
      await fetch(`${API}/api/torrent/${hash}${finished ? '' : '?deleteFiles=1'}`, { method: 'DELETE' });
    } catch { /* server unreachable: still clear the card */ }
    report?.(hash, { status: finished ? 'removed' : 'cancelled' });
    setHash(null);
    setStats(null);
  }

  const complete = stats && !stats.gone && stats.progress === 1;

  return (
    <div className="tool" data-tool="torrent">
      <form onSubmit={start} className="field">
        <Icon name="magnet" size={20} />
        <input value={magnet} onChange={e => setMagnet(e.target.value)}
               placeholder="Paste a magnet link or .torrent URL" aria-label="Magnet or torrent link" />
        <button className="btn primary" disabled={!magnet.trim()}>Start download</button>
      </form>
      {error && <p className="notice error" role="alert">{error}</p>}

      {!hash && (
        <div className="empty">
          <span className="empty-icon"><Icon name="magnet" size={26} /></span>
          <h2>Paste a magnet link</h2>
          <p>Once it starts, you will see the file list, speed and connected peers here. Finished files can be saved one at a time.</p>
        </div>
      )}
      {hash && !stats && <p className="notice">Finding peers…</p>}
      {stats?.gone && <p className="notice error">This torrent was removed.</p>}

      {stats && !stats.gone && (
        <article className="media-card">
          <div className="media-head">
            <div>
              <h2>{stats.name || 'Fetching metadata…'}</h2>
              <p className="meta">{stats.files.length} {stats.files.length === 1 ? 'file' : 'files'} · {fmtBytes(stats.size)}</p>
            </div>
            <span className="badge" data-s={complete ? 'done' : stats.paused ? 'paused' : 'active'}>
              {complete ? 'Complete' : stats.paused ? 'Paused' : 'Downloading'}
            </span>
          </div>

          <progress value={stats.progress} max="1" />

          <div className="mini">
            <div><b>{(stats.progress * 100).toFixed(1)}%</b><span>Progress</span></div>
            <div><b>{fmtBytes(stats.down)}/s</b><span>Download</span></div>
            <div><b>{fmtBytes(stats.up)}/s</b><span>Upload</span></div>
            <div><b>{stats.peers}</b><span>Peers</span></div>
            <div><b>{complete ? 'Done' : stats.paused ? 'Paused' : fmtEta(stats.size * (1 - stats.progress), stats.down)}</b><span>Time left</span></div>
          </div>

          <ul className="files">
            {stats.files.map(f => (
              <li key={f.i}>
                <span className="file-icon"><Icon name="file" size={16} /></span>
                <span className="file-name">{f.name} <small>{fmtBytes(f.size)}</small></span>
                {f.progress === 1
                  ? <a className="btn primary sm" href={`${API}/api/torrent/${hash}/files/${f.i}`}>Save file</a>
                  : <em>{(f.progress * 100).toFixed(0)}%</em>}
              </li>
            ))}
          </ul>

          <div className="btns">
            {!complete && (
              <button className="btn" onClick={togglePause}>
                <Icon name={stats.paused ? 'play' : 'pause'} size={16} /> {stats.paused ? 'Resume' : 'Pause'}
              </button>
            )}
            <button className="btn ghost danger" onClick={cancel}>
              <Icon name={complete ? 'trash' : 'x'} size={16} /> {complete ? 'Remove torrent' : 'Cancel download'}
            </button>
          </div>
        </article>
      )}
    </div>
  );
}