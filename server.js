// server.js — IPTV web player backend
// M3U parsing (URL + upload) + a CORS/codec/timeout-hardened stream proxy.
// Run: npm install && node server.js  (http://localhost:8080)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const dns = require('dns').promises;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const FFMPEG_STARTUP_TIMEOUT_MS = 20000; // kill ffmpeg if no data in 20s
let FFMPEG = process.env.FFMPEG_PATH;
if (!FFMPEG) {
  const defaultWinPath = 'C:\\Users\\HP\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe';
  if (fs.existsSync(defaultWinPath)) {
    FFMPEG = defaultWinPath;
  } else {
    try {
      FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
    } catch (e) {
      FFMPEG = 'ffmpeg';
    }
  }
}
const CONNECT_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 60000;

// Log resolved ffmpeg path on startup
console.log('[ffmpeg] resolved path:', FFMPEG);

// Quick reachability probe for a URL (HEAD with short timeout)
async function probeUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': 'VLC/3.0.18' } });
    clearTimeout(t);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// Pre-resolve hostname to IP to bypass static ffmpeg binary DNS resolution bugs in Docker/Render container sandboxes
async function resolveUrlToIp(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    const isHttps = parsed.protocol === 'https:';
    
    if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
      return { url: urlStr, hostHeader: null, originalHost: hostname, isHttps };
    }

    const lookup = await dns.lookup(hostname);
    if (lookup && lookup.address) {
      const ip = lookup.address;
      const port = parsed.port ? `:${parsed.port}` : '';
      parsed.host = `${ip}${port}`;
      return {
        url: parsed.href,
        hostHeader: `Host: ${hostname}\r\n`,
        originalHost: hostname,
        isHttps
      };
    }
  } catch (e) {
    console.error('[DNS] Failed to resolve:', urlStr, e.message);
  }
  return { url: urlStr, hostHeader: null, originalHost: null, isHttps: urlStr.startsWith('https') };
}

function err(category, message, retryable) {
  return { error: { category, message, retryable } };
}

// ---------- M3U parsing ----------

function parseM3U(text) {
  if (!text || !text.includes('#EXTM3U')) {
    throw new Error('Not a valid M3U playlist');
  }
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const meta = line.substring(line.indexOf(':') + 1);
      const commaIdx = meta.lastIndexOf(',');
      const attrsPart = commaIdx !== -1 ? meta.substring(0, commaIdx) : meta;
      const name = commaIdx !== -1 ? meta.substring(commaIdx + 1).trim() : 'Unknown';
      const attrs = {};
      const attrRegex = /(tvg-id|tvg-name|tvg-logo|group-title)="([^"]*)"/g;
      let m;
      while ((m = attrRegex.exec(attrsPart)) !== null) attrs[m[1]] = m[2];
      current = {
        name,
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Uncategorized',
        tvgId: attrs['tvg-id'] || '',
      };
    } else if (line && !line.startsWith('#') && current) {
      current.id = `m3u-${idx++}`;
      current.streamUrl = line;
      current.sourceType = 'm3u';
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

app.get('/api/m3u', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json(err('malformed_request', 'Missing url param', false));
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!response.ok) {
      return res.status(response.status).json(
        err('unreachable', `Provider returned status ${response.status}`, true)
      );
    }
    const text = await response.text();
    let channels;
    try {
      channels = parseM3U(text);
    } catch {
      return res.status(400).json(err('malformed_response', 'URL does not point to a valid M3U playlist', false));
    }
    if (channels.length === 0) {
      return res.status(200).json(err('empty_result', 'Playlist parsed but contained no channels', false));
    }
    res.json({ channels });
  } catch (e) {
    const isTimeout = e.name === 'AbortError';
    res.status(isTimeout ? 504 : 502).json(
      isTimeout
        ? err('unreachable', "This source isn't responding", true)
        : err('unreachable', e.message, true)
    );
  }
});

app.post('/api/m3u/upload', express.text({ limit: '50mb' }), (req, res) => {
  const text = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json(err('malformed_request', 'Missing playlist content', false));
  }
  try {
    const channels = parseM3U(text);
    if (channels.length === 0) {
      return res.status(200).json(err('empty_result', 'Playlist parsed but contained no channels', false));
    }
    res.json({ channels });
  } catch {
    res.status(400).json(err('malformed_response', 'Content is not a valid M3U playlist', false));
  }
});

// ---------- Stream proxy ----------
// segment=true  -> raw passthrough (no transcoding, fast path)
// transcode=true -> single continuous ffmpeg process -> fragmented MP4 for <video>
// default        -> fetch + if HLS manifest, rewrite segment URLs through this proxy

function withIdleTimeout(stream, onTimeout) {
  let timer = setTimeout(onTimeout, IDLE_TIMEOUT_MS);
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(onTimeout, IDLE_TIMEOUT_MS);
  };
  stream.on('data', reset);
  const clear = () => clearTimeout(timer);
  stream.on('end', clear);
  stream.on('error', clear);
  stream.on('close', clear);
}

app.get('/api/stream-proxy', async (req, res) => {
  const streamUrl = req.query.url;
  const isSegment = req.query.segment === 'true';
  const forceTranscode = req.query.transcode === 'true';

  if (!streamUrl || typeof streamUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  const headers = { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', Accept: '*/*' };
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  // Helper: spawn ffmpeg. Supports fast stream copy (default) or full transcoding (fallback).
  // Includes optimized probe & delay flags for instant startup.
  function spawnFfmpeg(url, forceTranscode, hostHeader, originalHost, isHttps) {
    const headersStr = (hostHeader || '') + `User-Agent: VLC/3.0.18 LibVLC/3.0.18\r\nAccept: */*\r\n`;
    
    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-headers', headersStr,
    ];

    // Fix HTTPS / TLS SNI verification gap for IP-routed URLs
    if (isHttps && originalHost) {
      args.push(
        '-tls_host', originalHost,
        '-tls_verify', '0'
      );
    }

    args.push(
      '-fflags', '+genpts+nobuffer',
      '-flags', '+low_delay',
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      '-i', url
    );

    if (forceTranscode) {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '30',
        '-g', '25',
        '-vf', 'yadif=0:-1:0,scale=-2:360',
        '-c:a', 'aac', '-b:a', '128k'
      );
    } else {
      args.push(
        '-c:v', 'copy',                // copy video (extremely fast, low CPU)
        '-c:a', 'aac', '-b:a', '128k'  // convert audio to AAC (browser-safe)
      );
    }

    args.push(
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
      'pipe:1'
    );

    return spawn(FFMPEG, args);
  }

  function pipeFfmpeg(ffmpeg) {
    ffmpeg.on('error', (e) => {
      console.error('ffmpeg process error:', e.message);
      if (!res.headersSent) res.status(e.code === 'ENOENT' ? 500 : 502).send('Transcoder error: ' + e.message);
    });
    let stderrBuf = '';
    ffmpeg.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    let gotData = false;
    ffmpeg.stdout.once('data', () => { gotData = true; });
    // Kill ffmpeg if it produces no data within startup timeout
    const startupTimer = setTimeout(() => {
      if (!gotData) {
        console.error('[ffmpeg] startup timeout — no data after', FFMPEG_STARTUP_TIMEOUT_MS, 'ms');
        console.error('[ffmpeg] startup stderr log:\n', stderrBuf);
        try { ffmpeg.kill('SIGKILL'); } catch (e) {}
        if (!res.headersSent) res.status(504).send('Stream timeout: source unreachable or blocked by provider');
        else res.destroy();
      }
    }, FFMPEG_STARTUP_TIMEOUT_MS);
    ffmpeg.stdout.once('data', () => clearTimeout(startupTimer));
    ffmpeg.on('close', () => clearTimeout(startupTimer));
    withIdleTimeout(ffmpeg.stdout, () => {
      if (!res.headersSent) res.status(504).send('Gateway Timeout: stream stalled');
      else res.destroy();
      try { ffmpeg.kill('SIGKILL'); } catch (e) {}
    });
    ffmpeg.stdout.pipe(res);
    ffmpeg.on('close', (code) => {
      if (!gotData && code !== 0 && !res.headersSent) {
        console.error('ffmpeg failed:', stderrBuf.slice(-2000));
        res.status(502).send('Transcoding failed: source unreadable');
      }
    });
    req.on('close', () => { try { ffmpeg.kill('SIGKILL'); } catch (e) {} });
  }

  try {
    // --- Segment passthrough (HLS chunks) ---
    if (isSegment) {
      const connectTimer = setTimeout(() => abortController.abort(), CONNECT_TIMEOUT_MS);
      const response = await fetch(streamUrl, { headers, signal: abortController.signal });
      clearTimeout(connectTimer);
      if (!response.ok) {
        return res.status(response.status).send(`Provider returned ${response.status}`);
      }
      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(response.body);
      withIdleTimeout(nodeStream, () => {
        if (!res.headersSent) res.status(504).send('Gateway Timeout: stream stalled');
        else res.destroy();
        nodeStream.destroy();
      });
      nodeStream.pipe(res);
      return;
    }

    // --- Force transcode (explicit flag) ---
    if (forceTranscode) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'video/mp4');
      const { url: resolvedUrl, hostHeader, originalHost, isHttps } = await resolveUrlToIp(streamUrl);
      pipeFfmpeg(spawnFfmpeg(resolvedUrl, true, hostHeader, originalHost, isHttps));
      return;
    }

    // --- Smart probe: only fetch-probe explicit HLS URLs (.m3u8) ---
    // For all other IPTV stream URLs (no extension or MPEG-TS paths),
    // skip the slow fetch probe and go straight to ffmpeg, just like VLC does.
    const looksLikeHls = streamUrl.includes('.m3u8');

    if (looksLikeHls) {
      // HLS manifest: fetch, rewrite segment URLs, serve
      const connectTimer = setTimeout(() => abortController.abort(), CONNECT_TIMEOUT_MS);
      const response = await fetch(streamUrl, { headers, signal: abortController.signal });
      clearTimeout(connectTimer);
      if (!response.ok) {
        return res.status(response.status).send(`Provider returned ${response.status}`);
      }
      const contentType = response.headers.get('content-type');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (contentType) res.setHeader('Content-Type', contentType);
      const text = await response.text();
      const baseUrl = new URL(streamUrl);
      const rewritten = text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (t.startsWith('#') || t === '') return line;
        try {
          const abs = t.startsWith('http') ? t : new URL(t, baseUrl.href).href;
          return `/api/stream-proxy?url=${encodeURIComponent(abs)}&segment=true`;
        } catch {
          return line;
        }
      });
      res.send(rewritten.join('\n'));
    } else {
      // Non-HLS (MPEG-TS, RTMP wrappers, etc.): go straight to ffmpeg
      console.log('[proxy] Non-HLS URL — starting ffmpeg stream copy:', streamUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'video/mp4');
      const { url: resolvedUrl, hostHeader, originalHost, isHttps } = await resolveUrlToIp(streamUrl);
      pipeFfmpeg(spawnFfmpeg(resolvedUrl, false, hostHeader, originalHost, isHttps));
    }
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e.name === 'AbortError') {
      return res.status(504).send('Gateway Timeout: connection timed out');
    }
    console.error('Stream proxy error:', e.message);
    res.status(502).send('Proxy error: ' + e.message);
  }
});

app.listen(PORT, () => console.log(`IPTV player running at http://localhost:${PORT}`));
