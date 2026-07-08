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
const net = require('net');
const dnsResolver = new dnsPromises.Resolver();
dnsResolver.setServers(['8.8.8.8', '1.1.1.1']);

// Override dns.lookup globally to bypass bad OS DNS servers / timeouts
const originalLookup = dns.lookup;
let inLookup = false;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (!options) {
    options = {};
  }

  if (inLookup) {
    return originalLookup(hostname, options, callback);
  }

  inLookup = true;
  dnsResolver.resolve4(hostname)
    .then(ips => {
      inLookup = false;
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
      inLookup = false;
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

// Locate VLC binary
let VLC = process.env.VLC_PATH;
if (!VLC) {
  const commonVlcPaths = [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
  ];
  for (const p of commonVlcPaths) {
    if (fs.existsSync(p)) {
      VLC = p;
      break;
    }
  }
  if (!VLC) {
    VLC = 'vlc'; // Fallback to PATH
  }
}

// Log resolved paths on startup
console.log('[ffmpeg] resolved path:', FFMPEG);
console.log('[vlc] resolved path:', VLC);

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

async function getStreamWithRedirects(urlStr, headers, signal) {
  let currentUrl = urlStr;
  let redirectCount = 0;
  const maxRedirects = 5;

  while (redirectCount < maxRedirects) {
    const response = await axios.get(currentUrl, {
      headers,
      maxRedirects: 0,
      responseType: 'stream',
      signal,
      validateStatus: (status) => status >= 200 && status < 400
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];
      if (location) {
        currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
        redirectCount++;
        if (response.data) {
          try { response.data.destroy(); } catch (e) {}
        }
        continue;
      }
    }

    return response;
  }
  throw new Error('Too many redirects');
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


const crypto = require('crypto');
const hlsSessions = new Map();
const HLS_TEMP_DIR = path.join(__dirname, 'public', 'hls_temp');

// Ensure HLS temp directory exists and is clean on boot
if (fs.existsSync(HLS_TEMP_DIR)) {
  try {
    fs.rmSync(HLS_TEMP_DIR, { recursive: true, force: true });
  } catch (e) {
    console.error('[hls] Error cleaning temp dir on boot:', e.message);
  }
}
fs.mkdirSync(HLS_TEMP_DIR, { recursive: true });

// Middleware to track session activity on files served under /hls_temp
app.use('/hls_temp/:streamId', (req, res, next) => {
  const { streamId } = req.params;
  const session = hlsSessions.get(streamId);
  if (session) {
    session.lastRequestTime = Date.now();
  }
  next();
});

async function resolveRedirects(urlStr, headers) {
  let currentUrl = urlStr;
  let redirectCount = 0;
  const maxRedirects = 5;

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
      return currentUrl;
    } catch (e) {
      try {
        const response = await axios.get(currentUrl, {
          headers: { ...headers, Range: 'bytes=0-0' },
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
        return currentUrl;
      } catch (err2) {
        return currentUrl;
      }
    }
  }
  return currentUrl;
}


app.get('/api/stream/start', async (req, res) => {
  const streamUrl = req.query.url;
  const mode = req.query.mode || 'transcode'; // 'transcode' or 'copy'
  const referer = req.query.referer || req.query.referrer;
  const userAgentParam = req.query.userAgent || req.query.useragent;

  if (!streamUrl || typeof streamUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  const headers = {
    'User-Agent': userAgentParam || 'VLC/3.0.18 LibVLC/3.0.18',
    'Accept': '*/*',
    ...(referer ? { 'Referer': referer } : {})
  };

  try {
    const resolvedUrl = await resolveRedirects(streamUrl, headers);
    const isHls = resolvedUrl.toLowerCase().includes('.m3u8') || resolvedUrl.toLowerCase().includes('.m3u') || resolvedUrl.toLowerCase().includes('/hls/');

    if (isHls) {
      console.log('[hls] Stream is already HLS. Directing player to resolved URL:', resolvedUrl);
      return res.json({ manifestUrl: resolvedUrl, streamId: null });
    }

    const streamId = crypto.randomBytes(8).toString('hex');
    const segmentDir = path.join(HLS_TEMP_DIR, streamId);
    fs.mkdirSync(segmentDir, { recursive: true });
    const manifestPath = path.join(segmentDir, 'index.m3u8');

    let headersStr = '';
    if (referer) headersStr += `Referer: ${referer}\r\n`;
    if (userAgentParam) headersStr += `User-Agent: ${userAgentParam}\r\n`;
    else headersStr += `User-Agent: VLC/3.0.18 LibVLC/3.0.18\r\n`;

    const args = [];
    if (headersStr) {
      args.push('-headers', headersStr);
    }

    args.push(
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-correct_ts_overflow', '1',
      '-avoid_negative_ts', 'make_zero',
      '-flags', '+global_header',
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      '-i', resolvedUrl
    );

    if (mode === 'copy') {
      args.push(
        '-c:v', 'copy',
        '-c:a', 'copy'
      );
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '28',
        '-vf', 'scale=-2:720,format=yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k'
      );
    }

    args.push(
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(segmentDir, 'seg_%d.ts'),
      manifestPath
    );

    console.log(`[hls] Spawning FFmpeg HLS segmenter (mode: ${mode}) for session ${streamId}`);
    const ffmpegProcess = spawn(FFMPEG, args);

    ffmpegProcess.stderr.on('data', (d) => {
      // Un-comment to trace ffmpeg status output in console
      // console.log(`[ffmpeg-hls-stderr-${streamId}] ${d.toString().trim()}`);
    });

    const session = {
      ffmpegProcess,
      tempDir: segmentDir,
      lastRequestTime: Date.now(),
      manifestPath
    };
    hlsSessions.set(streamId, session);

    // Wait until index.m3u8 is actually created before responding to player
    let checks = 0;
    const checkTimer = setInterval(() => {
      checks++;
      if (fs.existsSync(manifestPath)) {
        clearInterval(checkTimer);
        return res.json({ manifestUrl: `/hls_temp/${streamId}/index.m3u8`, streamId });
      }
      if (checks > 75) { // 15 seconds timeout
        clearInterval(checkTimer);
        try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
        try { fs.rmSync(segmentDir, { recursive: true, force: true }); } catch (e) {}
        hlsSessions.delete(streamId);
        if (!res.headersSent) {
          return res.status(504).send('FFmpeg failed to generate HLS manifest in time');
        }
      }
    }, 200);

  } catch (err) {
    console.error('[hls] Failed to start stream:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Failed to initialize playback session');
    }
  }
});

app.post('/api/stream/stop', (req, res) => {
  const { streamId } = req.body;
  if (!streamId) {
    return res.status(400).send('Missing streamId');
  }
  const session = hlsSessions.get(streamId);
  if (session) {
    console.log(`[hls] Stopping session ${streamId}`);
    cleanupSession(streamId, session);
  }
  res.sendStatus(200);
});

function cleanupSession(streamId, session) {
  try {
    session.ffmpegProcess.kill('SIGKILL');
  } catch (e) {}
  try {
    fs.rmSync(session.tempDir, { recursive: true, force: true });
  } catch (e) {}
  hlsSessions.delete(streamId);
}

// Background Garbage Collector to clean up inactive HLS directories
setInterval(() => {
  const now = Date.now();
  for (const [streamId, session] of hlsSessions.entries()) {
    const idleTime = now - session.lastRequestTime;
    if (idleTime > 30000) { // 30 seconds idle timeout
      console.log(`[hls-gc] Cleaning up idle session ${streamId} (idle for ${Math.round(idleTime / 1000)}s)`);
      cleanupSession(streamId, session);
    }
  }
}, 10000);

app.listen(PORT, () => console.log(`IPTV player running at http://localhost:${PORT}`));
