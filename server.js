// server.js — IPTV web player backend
// M3U parsing (URL + upload) + a CORS/codec/timeout-hardened stream proxy.
// Run: npm install && node server.js  (http://localhost:8080)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const dns = require('dns');
const dnsPromises = require('dns').promises;
const dnsResolver = new dnsPromises.Resolver();
dnsResolver.setServers(['8.8.8.8', '1.1.1.1']);

// Override dns.lookup globally to bypass bad OS DNS servers / timeouts
const originalLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (!options) {
    options = {};
  }

  dnsResolver.resolve4(hostname)
    .then(ips => {
      if (ips && ips.length > 0) {
        if (options.all) {
          const addresses = ips.map(ip => ({ address: ip, family: 4 }));
          callback(null, addresses);
        } else {
          callback(null, ips[0], 4);
        }
      } else {
        originalLookup(hostname, options, callback);
      }
    })
    .catch(err => {
      originalLookup(hostname, options, callback);
    });
};

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
    if (process.platform === 'linux') {
      FFMPEG = 'ffmpeg';
    } else {
      try {
        FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
      } catch (e) {
        FFMPEG = 'ffmpeg';
      }
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
    const r = await axios.head(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'VLC/3.0.18' },
      validateStatus: (status) => status >= 200 && status < 400
    });
    clearTimeout(t);
    return { ok: true, status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: e.response ? e.response.status : 0, error: e.name === 'CanceledError' ? 'timeout' : e.message };
  }
}

async function followRedirectsAndResolve(urlStr, referer, userAgent) {
  let currentUrl = urlStr;
  let redirectCount = 0;
  const maxRedirects = 5;
  const headers = { 'User-Agent': userAgent || 'VLC/3.0.18 LibVLC/3.0.18', Accept: '*/*' };
  if (referer) {
    headers['Referer'] = referer;
  }

  while (redirectCount < maxRedirects) {
    try {
      const response = await axios.head(currentUrl, {
        headers,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers['location'];
        if (location) {
          currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
          redirectCount++;
          continue;
        }
      }
      break;
    } catch (e) {
      if (e.response && e.response.status >= 300 && e.response.status < 400) {
        const location = e.response.headers['location'];
        if (location) {
          currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
          redirectCount++;
          continue;
        }
      }
      console.error('[Redirect Follower] Error:', e.message);
      break;
    }
  }

  const parsed = new URL(currentUrl);
  return {
    url: currentUrl,
    originalHost: parsed.hostname,
    isHttps: parsed.protocol === 'https:'
  };
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
      const attrRegex = /(tvg-id|tvg-name|tvg-logo|group-title|http-referrer|referrer|user-agent)="([^"]*)"/gi;
      let m;
      while ((m = attrRegex.exec(attrsPart)) !== null) {
        attrs[m[1].toLowerCase()] = m[2];
      }
      current = {
        name,
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Uncategorized',
        tvgId: attrs['tvg-id'] || '',
        referrer: attrs['http-referrer'] || attrs['referrer'] || '',
        userAgent: attrs['user-agent'] || '',
      };
    } else if (line.toUpperCase().startsWith('#EXTVLCOPT:')) {
      if (current) {
        const opt = line.substring(11).trim();
        const eqIdx = opt.indexOf('=');
        if (eqIdx !== -1) {
          const key = opt.substring(0, eqIdx).trim().toLowerCase();
          const val = opt.substring(eqIdx + 1).trim();
          if (key === 'http-referrer' || key === 'referrer') {
            current.referrer = val;
          } else if (key === 'http-user-agent' || key === 'user-agent') {
            current.userAgent = val;
          }
        }
      }
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
    const response = await axios.get(url, {
      responseType: 'text',
      signal: controller.signal,
      headers: { 'User-Agent': 'VLC/3.0.18' }
    });
    clearTimeout(t);
    const text = response.data;
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
    const isTimeout = e.name === 'CanceledError';
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
  const forceTranscode = req.query.transcode === 'true';
  const referer = req.query.referer || req.query.referrer;
  const userAgentParam = req.query.userAgent || req.query.useragent;

  if (!streamUrl || typeof streamUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  // Pre-resolve and follow redirects for the stream URL (maintaining domain name)
  const { url: resolvedUrl, originalHost, isHttps } = await followRedirectsAndResolve(streamUrl, referer, userAgentParam);

  const headers = { 'User-Agent': userAgentParam || 'VLC/3.0.18 LibVLC/3.0.18', Accept: '*/*' };
  if (referer) {
    headers['Referer'] = referer;
  }

  // Helper: spawn ffmpeg. Supports fast stream copy (default) or full transcoding (fallback).
  // Includes optimized probe & delay flags for instant startup.
  function spawnFfmpeg(url, forceTranscode) {
    const ua = userAgentParam || 'VLC/3.0.18 LibVLC/3.0.18';
    let headersStr = `User-Agent: ${ua}\r\nAccept: */*\r\n`;
    if (referer) {
      headersStr += `Referer: ${referer}\r\n`;
    }
    
    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-headers', headersStr,
    ];

    args.push(
      '-fflags', '+genpts+igndts+discardcorrupt+nobuffer',
      '-correct_ts_overflow', '1',
      '-avoid_negative_ts', 'make_zero',
      '-flags', '+low_delay+global_header',
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      '-i', url
    );

    if (forceTranscode) {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '26',
        '-g', '25',
        '-vf', 'scale=-2:540',
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
    if (res.socket) res.socket.setNoDelay(true);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

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
    // --- Direct copy or Transcoding ---
    console.log('[proxy] Starting ffmpeg stream copy/transcode (resolved):', resolvedUrl);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp4');
    pipeFfmpeg(spawnFfmpeg(resolvedUrl, forceTranscode));
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e.name === 'CanceledError') {
      return res.status(504).send('Gateway Timeout: connection timed out');
    }
    console.error('Stream proxy error:', e.message);
    res.status(502).send('Proxy error: ' + e.message);
  }
});

app.listen(PORT, () => console.log(`IPTV player running at http://localhost:${PORT}`));
