// Needs yt-dlp and ffmpeg on PATH for the YouTube tab.
// Run: npm i && npm start
import express from 'express';
import cors from 'cors';
import { spawn, execFile } from 'node:child_process';
import WebTorrent from 'webtorrent';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Many home networks stall on IPv6 routes to YouTube; prefer IPv4 everywhere
dns.setDefaultResultOrder('ipv4first');

const app = express();
// ALLOWED_ORIGIN: comma-separated site addresses allowed to call this API, e.g. https://grab.vercel.app
// Leave it empty while developing and every origin is allowed.
const ALLOWED = (process.env.ALLOWED_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
// Lets a website on the internet (like your Vercel page) reach this server on localhost
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) res.set('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors({ origin: ALLOWED.length ? ALLOWED : true }), express.json());
app.get('/healthz', (req, res) => res.json({ ok: true }));
const client = new WebTorrent();

/* ---------- Torrent (magnet) ---------- */
// Many magnet links ship with dead trackers. Adding a few live public ones finds peers much faster.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];
const withTrackers = m => m + TRACKERS
  .filter(t => !decodeURIComponent(m).includes(t))
  .map(t => `&tr=${encodeURIComponent(t)}`).join('');

app.post('/api/torrent', (req, res) => {
  const { magnet } = req.body || {};
  if (!/^(magnet:\?|https?:\/\/\S+\.torrent(\?\S*)?$)/i.test(magnet || ''))
    return res.status(400).json({ error: 'Not a magnet link or .torrent link' });
  const existing = client.torrents.find(t => magnet.includes(t.infoHash));
  if (existing) return res.json({ infoHash: existing.infoHash });
  const t = client.add(/^magnet:/i.test(magnet) ? withTrackers(magnet) : magnet, { path: './downloads' });
  t.once('infoHash', () => res.json({ infoHash: t.infoHash }));
  t.once('metadata', () => console.log('torrent metadata received:', t.name));
  t.on('warning', w => console.warn('torrent warning:', w.message || w));
  t.on('error', () => !res.headersSent && res.status(500).json({ error: 'Could not add torrent' }));
});

app.get('/api/torrent/:hash/events', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = async () => {
    const t = await client.get(req.params.hash);
    if (!t) return res.write('data: {"gone":true}\n\n');
    res.write(`data: ${JSON.stringify({
      name: t.name, progress: t.progress, down: t.downloadSpeed, up: t.uploadSpeed,
      peers: t.numPeers, done: t.done, size: t.length, paused: t.paused,
      files: (t.files || []).map((f, i) => ({ i, name: f.name, size: f.length, progress: f.progress })),
    })}\n\n`);
  };
  const id = setInterval(send, 1000);
  send();
  req.on('close', () => clearInterval(id));
});

app.get('/api/torrent/:hash/files/:i', async (req, res) => {
  const t = await client.get(req.params.hash);
  const file = t?.files[Number(req.params.i)];
  if (!file) return res.sendStatus(404);
  res.set({
    'Content-Length': file.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });
  file.createReadStream().pipe(res);
});

// Pause: stop requesting pieces, drop peers and block new ones. Resume reconnects to the same peers.
const pausedPeers = new Map();
app.post('/api/torrent/:hash/pause', async (req, res) => {
  const t = await client.get(req.params.hash);
  if (!t) return res.sendStatus(404);
  t.pause();
  if (t.pieces?.length) t.deselect(0, t.pieces.length - 1);
  pausedPeers.set(t.infoHash, t.wires.filter(w => w.remoteAddress).map(w => `${w.remoteAddress}:${w.remotePort}`));
  for (const w of [...t.wires]) w.destroy();
  res.sendStatus(204);
});

app.post('/api/torrent/:hash/resume', async (req, res) => {
  const t = await client.get(req.params.hash);
  if (!t) return res.sendStatus(404);
  if (t.pieces?.length) t.select(0, t.pieces.length - 1);
  t.resume();
  for (const addr of pausedPeers.get(t.infoHash) || []) t.addPeer(addr);
  pausedPeers.delete(t.infoHash);
  res.sendStatus(204);
});

// ?deleteFiles=1 also removes the downloaded data (used by Cancel)
app.delete('/api/torrent/:hash', async (req, res) => {
  const t = await client.get(req.params.hash);
  t?.destroy({ destroyStore: req.query.deleteFiles === '1' });
  res.sendStatus(204);
});

/* ---------- YouTube (via yt-dlp) ---------- */
const isYT = u => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(u || '');
// Extra yt-dlp flags, e.g. in Command Prompt:  set YT_FLAGS=-4 && npm start
const YT_FLAGS = ['-4', '--socket-timeout', '15', ...(process.env.YT_FLAGS || '').split(' ').filter(Boolean)];
const cache = new Map(); // url -> { at, data }
const TTL = 30 * 60 * 1000;
const fresh = k => { const c = cache.get(k); return c && Date.now() - c.at < TTL ? c.data : null; };

// Full lookup through yt-dlp (slower, but works for videos oEmbed refuses)
const inflight = new Map();
const runInfo = url => {
  const hit = fresh('i:' + url);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(url)) return inflight.get(url);
  const p = new Promise((resolve, reject) => {
    execFile('yt-dlp', [...YT_FLAGS, '-J', '--no-playlist', '--no-warnings', '--skip-download', url],
      { maxBuffer: 64e6, timeout: 90000 }, (err, out, stderr) => {
      if (err) {
        console.error('yt-dlp failed:', err.code, stderr || err.message);
        const last = (stderr || '').split('\n').filter(Boolean).pop() || '';
        return reject(new Error(err.code === 'ENOENT'
          ? 'yt-dlp is not installed or not on PATH'
          : last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') || 'Could not read that video'));
      }
      try {
        const j = JSON.parse(out);
        const heights = [...new Set(j.formats.filter(f => f.vcodec !== 'none' && f.height).map(f => f.height))]
          .sort((a, b) => b - a);
        const data = { title: j.title, channel: j.channel || j.uploader, thumbnail: j.thumbnail,
          duration: j.duration, heights };
        cache.set('i:' + url, { at: Date.now(), data });
        resolve(data);
      } catch { reject(new Error('yt-dlp returned unreadable data')); }
    });
  }).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
};

// Instant preview (~1s) from oEmbed; falls back to yt-dlp if oEmbed refuses the video
app.get('/api/yt/preview', async (req, res) => {
  const { url } = req.query;
  if (!isYT(url)) return res.status(400).json({ error: 'Enter a YouTube link' });
  const hit = fresh('p:' + url);
  if (hit) return res.json(hit);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`oEmbed status ${r.status}`);
    const j = await r.json();
    const data = { title: j.title, channel: j.author_name, thumbnail: j.thumbnail_url };
    cache.set('p:' + url, { at: Date.now(), data });
    return res.json(data);
  } catch (e) {
    console.error('oEmbed failed, falling back to yt-dlp:', e.message);
  }
  try {
    const { title, channel, thumbnail } = await runInfo(url);
    res.json({ title, channel, thumbnail });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Exact qualities (runs in the background on the page)
app.get('/api/yt/info', async (req, res) => {
  const { url } = req.query;
  if (!isYT(url)) return res.status(400).json({ error: 'Enter a YouTube link' });
  try {
    const { duration, heights } = await runInfo(url);
    res.json({ duration, heights });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- YouTube downloads: save to disk with live progress, then hand the file over ---------- */
const DIR = path.resolve('downloads', 'yt');
fs.mkdirSync(DIR, { recursive: true });
const jobs = new Map();
const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'original'];
const BITRATES = ['320', '256', '192', '128', '96'];
const safeName = n => (n || 'download').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 120) || 'download';

app.post('/api/yt/jobs', (req, res) => {
  const { url, kind = 'video', height, vformat = 'mp4', format = 'mp3', bitrate = '320', name } = req.body || {};
  if (!isYT(url)) return res.status(400).json({ error: 'Enter a YouTube link' });

  const args = [...YT_FLAGS, '--no-playlist', '--no-warnings', '--newline', '-N', '4',
    '--progress-template', 'download:DL|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(DIR, `${randomUUID()}.%(ext)s`)];
  const id = path.basename(args[args.length - 1]).split('.')[0];

  if (kind === 'audio') {
    if (!AUDIO_FORMATS.includes(format)) return res.status(400).json({ error: 'Unknown audio format' });
    if (format === 'original') args.push('-f', 'ba[ext=m4a]/ba/b');
    else {
      args.push('-f', 'ba/b', '-x', '--audio-format', format);
      if (['mp3', 'm4a', 'opus'].includes(format))
        args.push('--audio-quality', `${BITRATES.includes(bitrate) ? bitrate : '320'}K`);
    }
  } else {
    const h = parseInt(height) || 1080;
    const mp4 = vformat !== 'mkv';
    args.push('-f', mp4
      ? `bv*[height<=${h}][vcodec^=avc]+ba[ext=m4a]/bv*[height<=${h}]+ba/b`
      : `bv*[height<=${h}]+ba/b`,
      '--merge-output-format', mp4 ? 'mp4' : 'mkv');
  }

  const job = { status: 'connecting', percent: 0, speed: '', eta: '', name: safeName(name), at: Date.now() };
  jobs.set(id, job);
  const p = spawn('yt-dlp', [...args, url]);
  job.proc = p;
  let lastErr = '';

  p.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(line => {
    if (line.startsWith('DL|')) {
      const [, pc, sp, eta] = line.split('|');
      job.status = 'downloading';
      job.percent = parseFloat(pc) || 0;
      job.speed = (sp || '').trim();
      job.eta = (eta || '').trim();
    } else if (/^\[(Merger|ExtractAudio|VideoConvertor|Fixup)/.test(line)) job.status = 'processing';
  }));
  p.stderr.on('data', d => { console.error('yt-dlp:', d.toString()); lastErr = d.toString().trim().split('\n').pop(); });
  p.on('error', e => {
    job.status = 'error';
    job.error = e.code === 'ENOENT' ? 'yt-dlp is not installed or not on PATH' : e.message;
  });
  p.on('close', code => {
    if (job.status === 'cancelled') return removePartials(id);
    if (job.status === 'error') return;
    const f = fs.readdirSync(DIR).find(f => f.startsWith(id + '.') && !/\.(part|ytdl|temp)$/.test(f));
    if (code === 0 && f) {
      Object.assign(job, { status: 'done', percent: 100, file: path.join(DIR, f), ext: path.extname(f).slice(1) });
    } else {
      job.status = 'error';
      job.error = lastErr.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') || 'Download failed';
    }
  });
  res.json({ id });
});

// Kill yt-dlp and any ffmpeg it started (taskkill /T ends the whole tree on Windows)
const killTree = p => {
  if (!p || p.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
  else p.kill('SIGKILL');
};
const removePartials = id => {
  for (const f of fs.readdirSync(DIR)) if (f.startsWith(id + '.')) fs.rm(path.join(DIR, f), () => {});
};

app.delete('/api/yt/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.sendStatus(404);
  if (j.status !== 'done' && j.status !== 'error') {
    j.status = 'cancelled';
    killTree(j.proc);
    setTimeout(() => removePartials(req.params.id), 1500);
  }
  res.sendStatus(204);
});

app.get('/api/yt/jobs/:id/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = () => {
    const j = jobs.get(req.params.id);
    res.write(`data: ${JSON.stringify(j
      ? { status: j.status, percent: j.percent, speed: j.speed, eta: j.eta, error: j.error }
      : { status: 'error', error: 'Download not found' })}\n\n`);
  };
  const t = setInterval(send, 500);
  send();
  req.on('close', () => clearInterval(t));
});

app.get('/api/yt/jobs/:id/file', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done') return res.sendStatus(404);
  res.download(j.file, `${j.name}.${j.ext}`);
});

// Remove finished files and stale jobs after an hour
setInterval(() => {
  for (const [id, j] of jobs) {
    if (Date.now() - j.at < 3600e3) continue;
    j.proc?.kill();
    if (j.file) fs.rm(j.file, () => {});
    jobs.delete(id);
  }
}, 10 * 60e3);

process.on('uncaughtException', e => console.error('Uncaught:', e));
process.on('unhandledRejection', e => console.error('Unhandled:', e));

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));