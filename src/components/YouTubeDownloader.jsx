import { useEffect, useRef, useState } from 'react';
import { API } from '../../server/api';
import { Icon } from './Icons';
import { Choice } from './Controls';

const DEFAULT_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];
const AUDIO_FORMATS = [
  { id: 'mp3', label: 'MP3', lossy: true, note: 'Plays on every device and app.' },
  { id: 'm4a', label: 'M4A', lossy: true, note: 'AAC audio. Works well on Apple devices.' },
  { id: 'opus', label: 'Opus', lossy: true, note: 'Best sound for the file size.' },
  { id: 'flac', label: 'FLAC', note: 'Lossless container. Larger files.' },
  { id: 'wav', label: 'WAV', note: 'Uncompressed. The largest files.' },
  { id: 'original', label: 'Original', note: 'No conversion, so it finishes fastest.' },
];
const BITRATES = [320, 256, 192, 128, 96];
const mins = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const BUSY = ['starting', 'connecting', 'downloading', 'processing'];

export default function YouTubeDownloader({ report, prefill }) {
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState(null);
  const [kind, setKind] = useState('video');
  const [vformat, setVformat] = useState('mp4');
  const [height, setHeight] = useState('1080');
  const [format, setFormat] = useState('mp3');
  const [bitrate, setBitrate] = useState('320');
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const source = useRef(null);
  const seen = useRef(0);

  useEffect(() => () => source.current?.close(), []);

  // A link pasted into the hero box arrives here
  useEffect(() => {
    if (!prefill || seen.current === prefill.n) return;
    seen.current = prefill.n;
    setUrl(prefill.value);
    lookup(null, prefill.value);
  }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  async function lookup(e, raw) {
    e?.preventDefault();
    const link = (raw ?? url).trim();
    setError(''); setJob(null);
    const id = link.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/)?.[1];
    if (!id) { setInfo(null); return setError('Could not find a video ID in that link'); }

    // Card appears at once; thumbnail comes straight from YouTube's image server
    setInfo({ title: '', channel: '', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, pending: true });
    const apply = j => setInfo(i => i && { ...i, title: j.title, channel: j.channel, pending: false });

    // Title and channel: ask YouTube from the browser first (about 1 second)
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`);
      if (!r.ok) throw new Error('oembed');
      const j = await r.json();
      return apply({ title: j.title, channel: j.author_name });
    } catch { /* fall back to the server below */ }

    try {
      const r = await fetch(`${API}/api/yt/preview?url=${encodeURIComponent(link)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      apply(j);
    } catch (err) {
      setInfo(i => i && { ...i, pending: false });
      setError(err.message === 'Failed to fetch' ? 'Cannot reach the server. Is it running on port 4000?' : err.message);
    }
  }

  async function startDownload() {
    setError('');
    source.current?.close();
    setJob({ status: 'starting', percent: 0 });
    const title = info?.title || 'YouTube download';
    const note = kind === 'audio' ? 'Audio' : 'Video';
    try {
      const r = await fetch(`${API}/api/yt/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), kind, height, vformat, format, bitrate, name: info?.title || '' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setJob(x => ({ ...x, id: j.id }));
      report?.(j.id, { type: 'youtube', title, note, status: 'active', pct: 0 });

      const es = new EventSource(`${API}/api/yt/jobs/${j.id}/events`);
      source.current = es;
      es.onmessage = ev => {
        const d = JSON.parse(ev.data);
        setJob({ id: j.id, ...d });
        report?.(j.id, {
          type: 'youtube', title, note,
          status: d.status === 'done' ? 'done' : d.status === 'error' ? 'error' : 'active',
          pct: Math.round(d.percent || 0),
        });
        if (d.status === 'done' || d.status === 'error') {
          es.close();
          if (d.status === 'done') {
            const a = document.createElement('a');
            a.href = `${API}/api/yt/jobs/${j.id}/file`;
            a.click();
          }
        }
      };
    } catch (err) {
      setJob(null);
      setError(err.message === 'Failed to fetch' ? 'Cannot reach the server. Is it running on port 4000?' : err.message);
    }
  }

  async function cancelDownload() {
    if (!job?.id) return;
    source.current?.close();
    try { await fetch(`${API}/api/yt/jobs/${job.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    report?.(job.id, { status: 'cancelled' });
    setJob({ id: job.id, status: 'cancelled' });
  }

  const audio = AUDIO_FORMATS.find(f => f.id === format);
  const busy = job && BUSY.includes(job.status);
  const label = {
    starting: 'Starting…',
    connecting: 'Connecting to YouTube…',
    downloading: job && `Downloading ${job.percent?.toFixed(0)}%${job.speed ? ` · ${job.speed}` : ''}${job.eta ? ` · ${job.eta} left` : ''}`,
    processing: 'Converting and merging…',
    done: 'Done. Your file is saving to your Downloads folder.',
    cancelled: 'Download cancelled. Nothing was saved.',
  }[job?.status];

  const summary = kind === 'video'
    ? `${vformat.toUpperCase()} video, up to ${height}p`
    : `${audio.label} audio${audio.lossy ? ` at ${bitrate} kbps` : ''}`;

  return (
    <div className="tool" data-tool="youtube">
      <form onSubmit={lookup} className="field">
        <Icon name="link" size={20} />
        <input value={url} onChange={e => setUrl(e.target.value)}
               placeholder="Paste a YouTube link" aria-label="YouTube link" />
        <button className="btn primary" disabled={!url.trim()}>Find formats</button>
      </form>
      {error && <p className="notice error" role="alert">{error}</p>}

      {!info && (
        <div className="empty">
          <span className="empty-icon"><Icon name="video" size={26} /></span>
          <h2>Paste a YouTube link</h2>
          <p>Videos, Shorts and music links all work. You will choose the quality and format next.</p>
        </div>
      )}

      {info && (
        <article className="media">
          <img className="thumb" src={info.thumbnail} alt="" />
          <div className="media-body">
            {info.pending && !info.title
              ? <div className="skeleton" aria-label="Loading title" />
              : <h2>{info.title || 'Video'}</h2>}
            <p className="meta">{[info.channel, info.duration && mins(info.duration)].filter(Boolean).join(' · ')}</p>

            <div className="opts">
              <Choice label="Download as" variant="seg" value={kind} onChange={setKind}
                      options={[{ value: 'video', label: 'Video', icon: 'video' }, { value: 'audio', label: 'Audio only', icon: 'music' }]} />
              {kind === 'video' ? (
                <>
                  <Choice label="File type" variant="seg" value={vformat} onChange={setVformat}
                          options={[{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }]} />
                  <Choice label="Quality" value={height} onChange={setHeight}
                          options={DEFAULT_HEIGHTS.map(h => ({ value: String(h), label: h === 2160 ? '4K' : `${h}p` }))} />
                </>
              ) : (
                <>
                  <Choice label="Audio format" value={format} onChange={setFormat}
                          options={AUDIO_FORMATS.map(f => ({ value: f.id, label: f.label }))} />
                  {audio.lossy && (
                    <Choice label="Bitrate" value={bitrate} onChange={setBitrate}
                            options={BITRATES.map(b => ({ value: String(b), label: `${b} kbps` }))} />
                  )}
                  <p className="hint">{audio.note}</p>
                </>
              )}
            </div>

            {kind === 'video' && (
              <p className="hint">If this video does not have the quality you pick, you get the closest lower one.</p>
            )}
            {kind === 'audio' && (format === 'flac' || format === 'wav') && (
              <p className="hint">YouTube’s audio is already compressed, so FLAC and WAV will not sound better than the source. They are just larger files.</p>
            )}

            <div className="dl-bar">
              <span className="dl-summary">{summary}</span>
              <div className="btns">
                {busy && (
                  <button className="btn" onClick={cancelDownload} disabled={!job.id}>
                    <Icon name="x" size={16} /> Cancel
                  </button>
                )}
                <button className="btn primary" onClick={startDownload} disabled={busy}>
                  <Icon name="download" size={18} /> {busy ? 'Working…' : 'Download'}
                </button>
              </div>
            </div>

            {job && job.status !== 'error' && (
              <div className="job">
                {job.status !== 'cancelled' && <progress value={job.status === 'processing' ? undefined : (job.percent || 0) / 100} max="1" />}
                <p>{label}</p>
                {job.status === 'done' && (
                  <a className="btn sm" href={`${API}/api/yt/jobs/${job.id}/file`}>Save again</a>
                )}
              </div>
            )}
            {job?.status === 'error' && <p className="notice error" role="alert">{job.error}</p>}
          </div>
        </article>
      )}
    </div>
  );
}