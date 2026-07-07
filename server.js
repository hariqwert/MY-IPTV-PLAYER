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

app.get('/api/internal-stream', async (req, res) => {
  const streamUrl = req.query.url;
  const referer = req.query.referer || req.query.referrer;
  const userAgentParam = req.query.userAgent || req.query.useragent;

  if (!streamUrl || typeof streamUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  const ua = userAgentParam || 'VLC/3.0.18 LibVLC/3.0.18';
  const headers = {
    'User-Agent': ua,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Range': 'bytes=0-',
    'Connection': 'keep-alive',
    ...(referer ? { 'Referer': referer } : {})
  };

  let responseStream = null;

  req.on('close', () => {
    if (responseStream) {
      try { responseStream.destroy(); } catch (e) {}
    }
  });

  try {
    console.log(`[internal-stream] Connecting directly with redirects: ${streamUrl}`);
    const response = await getStreamWithRedirects(streamUrl, headers);

    responseStream = response.data;

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    response.data.pipe(res);

    response.data.on('end', () => {
      console.log('[internal-stream] Stream ended cleanly.');
    });

    response.data.on('error', (err) => {
      console.warn('[internal-stream] Stream error:', err.message);
    });

  } catch (err) {
    console.error('[internal-stream] Fetch error:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Fetch error: ' + err.message);
    }
  }
});

app.get('/api/stream-proxy', async (req, res) => {
  const streamUrl = req.query.url;
  const forceTranscode = req.query.transcode === 'true';
  const referer = req.query.referer || req.query.referrer;
  const userAgentParam = req.query.userAgent || req.query.useragent;

  if (!streamUrl || typeof streamUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  const abortController = new AbortController();
  let clientDisconnected = false;

  req.on('close', () => {
    clientDisconnected = true;
    abortController.abort();
  });

  // Target the local loopback internal-stream route to bypass CDN fingerprint blocks
  const internalUrl = `http://localhost:${PORT}/api/internal-stream?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer || '')}&userAgent=${encodeURIComponent(userAgentParam || '')}`;
  console.log('[proxy] Spawning ffmpeg transcoder for internal loopback URL:', internalUrl);
  
  const ffmpeg = spawnFfmpeg(internalUrl, forceTranscode);

  if (res.socket) res.socket.setNoDelay(true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'video/mp2t'); // Output MPEG-TS to client
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  let stderrBuf = '';
  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString();
    stderrBuf += msg;
    console.log(`[ffmpeg-stderr] ${msg.trim()}`);
  });

  let gotData = false;
  ffmpeg.stdout.pipe(res);

  ffmpeg.stdout.on('data', () => {
    gotData = true;
  });

  const startupTimer = setTimeout(() => {
    if (!gotData) {
      console.error('[ffmpeg] startup timeout — no data after 15 seconds');
      console.error('[ffmpeg] startup stderr log:\n', stderrBuf);
      cleanup();
      if (!res.headersSent) res.status(504).send('Stream timeout');
      else res.destroy();
    }
  }, FFMPEG_STARTUP_TIMEOUT_MS);

  const cleanup = () => {
    clearTimeout(startupTimer);
    try { ffmpeg.kill('SIGKILL'); } catch (e) {}
  };

  req.on('close', cleanup);

  ffmpeg.on('close', (code) => {
    console.log(`[proxy-ffmpeg] Process exited with code ${code}`);
    cleanup();
    if (!gotData && code !== 0 && !res.headersSent) {
      res.status(502).send('Transcoding failed');
    } else {
      if (!res.writableEnded) res.end();
    }
  });

  function spawnFfmpeg(url, forceTranscode) {
    const args = [
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt+nobuffer',
      '-correct_ts_overflow', '1',
      '-avoid_negative_ts', 'make_zero',
      '-flags', '+low_delay+global_header',
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      '-i', url
    ];

    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k'
    );

    args.push(
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
      'pipe:1'
    );

    return spawn(FFMPEG, args);
  }
});

app.get('/api/stream-proxy-raw', async (req, res) => {
  const streamUrl = req.query.url;
  const referer = req.query.referer || req.query.referrer;
  const userAgentParam = req.query.userAgent || req.query.useragent;

  if (!streamUrl || typeof streamUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  let clientDisconnected = false;
  const abortController = new AbortController();

  req.on('close', () => {
    clientDisconnected = true;
    abortController.abort();
    cleanup();
  });

  let responseStream = null;
  let bytesReceived = 0;
  let totalBytesReceived = 0;
  
  const MAX_BUFFER_SIZE_BYTES = 3 * 1024 * 1024; // 3MB
  let bufferQueue = [];
  let bufferSizeBytes = 0;
  let isWriting = false;

  const interval = setInterval(() => {
    console.log(`[proxy-raw-throughput] Avg speed: ${(bytesReceived / 5 / 1024).toFixed(2)} KB/s. Total bytes: ${totalBytesReceived}. Buffer size: ${(bufferSizeBytes / 1024).toFixed(2)} KB`);
    bytesReceived = 0;
  }, 5000);

  const cleanup = () => {
    clearInterval(interval);
    if (responseStream) {
      try { responseStream.destroy(); } catch (e) {}
    }
  };

  req.on('close', cleanup);

  const writeNext = () => {
    if (isWriting || clientDisconnected) return;
    if (bufferQueue.length === 0) return;

    isWriting = true;
    const chunk = bufferQueue.shift();
    bufferSizeBytes -= chunk.length;

    // Write chunk to client
    const ok = res.write(chunk);
    if (ok) {
      isWriting = false;
      setImmediate(writeNext);
    } else {
      res.once('drain', () => {
        isWriting = false;
        writeNext();
      });
    }
  };

  const addChunk = (chunk) => {
    bufferQueue.push(chunk);
    bufferSizeBytes += chunk.length;
    
    // Drop oldest chunks if buffer size limit is exceeded
    while (bufferSizeBytes > MAX_BUFFER_SIZE_BYTES && bufferQueue.length > 0) {
      const removed = bufferQueue.shift();
      bufferSizeBytes -= removed.length;
    }
    
    writeNext();
  };

  try {
    console.log('[proxy-raw-fetch] Fetching raw stream directly with redirects:', streamUrl);
    const clientRange = req.headers.range;
    const headers = {
      'User-Agent': userAgentParam || 'VLC/3.0.18 LibVLC/3.0.18',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Range': clientRange || 'bytes=0-',
      'Connection': 'keep-alive',
      ...(referer ? { 'Referer': referer } : {})
    };

    const connectTimer = setTimeout(() => abortController.abort(), CONNECT_TIMEOUT_MS);
    const response = await getStreamWithRedirects(streamUrl, headers, abortController.signal);
    clearTimeout(connectTimer);

    if (clientDisconnected) {
      response.data.destroy();
      return;
    }

    responseStream = response.data;
    console.log(`[proxy-raw-connect] Upstream connected. Status: ${response.status}`);

    withIdleTimeout(response.data, () => {
      console.error('[proxy-raw] Stream idle timeout — stalling connection');
      cleanup();
      if (!res.headersSent) res.status(504).send('Gateway Timeout: stream stalled');
      else res.destroy();
    });

    response.data.on('data', (chunk) => {
      bytesReceived += chunk.length;
      totalBytesReceived += chunk.length;
      addChunk(chunk);
    });

    response.data.on('end', () => {
      console.log('[proxy-raw-stream] Upstream stream ended cleanly.');
      cleanup();
      if (!res.writableEnded) res.end();
    });

    response.data.on('error', (err) => {
      console.warn('[proxy-raw-stream] Upstream stream error:', err.message);
      cleanup();
      if (!res.headersSent) res.status(502).send('Upstream stream error');
      else res.destroy();
    });

    response.data.on('close', () => {
      console.log('[proxy-raw-stream] Upstream stream closed.');
      cleanup();
      if (!res.writableEnded) res.end();
    });

  } catch (err) {
    console.error('[proxy-raw-error] Upstream fetch error:', err.message);
    cleanup();
    if (!res.headersSent) {
      res.status(502).send('Fetch error: ' + err.message);
    } else {
      res.destroy();
    }
  }
});

app.listen(PORT, () => console.log(`IPTV player running at http://localhost:${PORT}`));
