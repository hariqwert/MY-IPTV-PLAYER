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
    ...(referer ? { 'Referer': referer } : {})
  };

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let activeStream = null;
  let isClosed = false;

  // Real-time MPEG-TS PCR filter state to drop duplicate reconnect bursts in Direct Play
  let mpegTsBuffer = Buffer.alloc(0);
  let maxPcrBase = -1;
  let dropping = false;
  let isMpegTs = null; // null = checking, true = yes, false = no
  let bytesChecked = 0;
  let lastConnectTime = 0;

  function filterMpegTsChunks(chunk) {
    mpegTsBuffer = Buffer.concat([mpegTsBuffer, chunk]);
    const packets = [];
    const now = Date.now();
    const timeSinceConnect = now - lastConnectTime;
    
    // Safety: Force disable dropping after 4 seconds of connection to prevent permanent lockups
    if (dropping && timeSinceConnect > 4000) {
      console.log('[pcr-filter] Reconnect burst window expired. Forcing resume.');
      dropping = false;
    }
    
    while (mpegTsBuffer.length >= 188) {
      if (mpegTsBuffer[0] !== 0x47) {
        let syncIndex = mpegTsBuffer.indexOf(0x47);
        if (syncIndex === -1) {
          mpegTsBuffer = Buffer.alloc(0);
          break;
        }
        mpegTsBuffer = mpegTsBuffer.slice(syncIndex);
        if (mpegTsBuffer.length < 188) break;
      }
      
      const packet = mpegTsBuffer.slice(0, 188);
      mpegTsBuffer = mpegTsBuffer.slice(188);
      
      const adaptationFieldControl = (packet[3] & 0x30) >> 4;
      let hasPcr = false;
      let pcrBase = -1;
      
      if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
        const adaptationFieldLength = packet[4];
        if (adaptationFieldLength > 0) {
          const flags = packet[5];
          const pcrFlag = (flags & 0x10) >> 4;
          if (pcrFlag === 1) {
            hasPcr = true;
            const b0 = packet[6];
            const b1 = packet[7];
            const b2 = packet[8];
            const b3 = packet[9];
            const b4 = packet[10];
            pcrBase = (b0 * 256 + b1) * 65536 * 256 + (b2 << 16) + (b3 << 8) + (b4 >> 7);
          }
        }
      }
      
      if (hasPcr) {
        if (maxPcrBase === -1) {
          maxPcrBase = pcrBase;
          dropping = false;
        } else {
          if (dropping && timeSinceConnect <= 4000) {
            if (pcrBase >= maxPcrBase) {
              console.log(`[pcr-filter] Reconnect burst caught up: PCR Base advanced to ${pcrBase} (max: ${maxPcrBase}). Resuming packet write.`);
              dropping = false;
              maxPcrBase = pcrBase;
            }
          } else {
            if (pcrBase < maxPcrBase) {
              const gap = maxPcrBase - pcrBase;
              // Only drop if it is a major backward jump (>0.5s) within the first 4s window
              if (gap > 45000 && timeSinceConnect <= 4000) {
                console.log(`[pcr-filter] Loop detected: PCR Base went back from ${maxPcrBase} to ${pcrBase} (gap: ${gap} ticks). Dropping duplicate packets.`);
                dropping = true;
              }
            } else {
              maxPcrBase = pcrBase;
            }
          }
        }
      }
      
      if (!dropping) {
        packets.push(packet);
      }
    }
    
    return packets.length > 0 ? Buffer.concat(packets) : null;
  }

  req.on('close', () => {
    isClosed = true;
    cleanupActiveStream();
  });

  async function startStreaming() {
    if (isClosed) return;

    try {
      console.log(`[internal-stream] Connecting to upstream: ${streamUrl}`);
      const response = await getStreamWithRedirects(streamUrl, headers);
      if (isClosed) {
        try { response.data.destroy(); } catch (e) {}
        return;
      }

      activeStream = response.data;
      lastConnectTime = Date.now();
      
      // If we had a previous maxPcrBase, start in dropping mode to drop the cached burst
      if (maxPcrBase !== -1) {
        dropping = true;
      }

      activeStream.on('data', (chunk) => {
        if (!isClosed) {
          if (isMpegTs === null) {
            bytesChecked += chunk.length;
            if (chunk.indexOf(0x47) !== -1) {
              isMpegTs = true;
            } else if (bytesChecked > 500 * 1024) {
              console.log('[internal-stream] Stream does not appear to be MPEG-TS. Bypassing PCR filter.');
              isMpegTs = false;
            }
          }

          if (isMpegTs === false) {
            res.write(chunk);
          } else {
            const filtered = filterMpegTsChunks(chunk);
            if (filtered) {
              res.write(filtered);
            }
          }
        }
      });

      activeStream.on('end', () => {
        console.log('[internal-stream] Upstream ended cleanly. Reconnecting in 1000ms...');
        cleanupActiveStream();
        setTimeout(startStreaming, 1000); // Back off to 1000ms
      });

      activeStream.on('error', (err) => {
        console.warn('[internal-stream] Upstream error, reconnecting in 1500ms:', err.message);
        cleanupActiveStream();
        setTimeout(startStreaming, 1500); // Back off to 1500ms
      });

    } catch (err) {
      console.error('[internal-stream] Upstream connection failure, retrying:', err.message);
      if (isClosed) return;
      setTimeout(startStreaming, 1500); // Retry in 1500ms
    }
  }

  function cleanupActiveStream() {
    if (activeStream) {
      activeStream.removeAllListeners('data');
      activeStream.removeAllListeners('end');
      activeStream.removeAllListeners('error');
      try { activeStream.destroy(); } catch (e) {}
      activeStream = null;
    }
  }

  startStreaming();
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

function spawnFfmpeg(url, audioCopy, headersStr) {
  const args = [];
  if (headersStr) {
    args.push('-headers', headersStr);
  }

  const isHls = url.toLowerCase().includes('.m3u8') || url.toLowerCase().includes('.m3u') || url.toLowerCase().includes('/hls/');
  if (isHls) {
    args.push('-live_start_index', '-3');
  }

  args.push(
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-correct_ts_overflow', '1',
    '-avoid_negative_ts', 'make_zero',
    '-flags', '+global_header',
    '-analyzeduration', '1000000',
    '-probesize', '1000000'
  );

  if (url.toLowerCase().startsWith('http')) {
    args.push(
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2'
    );
  }

  args.push('-i', url);

  if (audioCopy) {
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
      '-vf', 'scale=-2:720,format=yuv420p,setpts=if(eq(N\\,0)\\,PTS\\,if(gt(PTS\\,PREV_OUTPTS)\\,PTS\\,nan))',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-af', 'aresample=async=1,asetpts=if(eq(N\\,0)\\,PTS\\,if(gt(PTS\\,PREV_OUTPTS)\\,PTS\\,nan))'
    );
  }

  args.push(
    '-f', 'mpegts',
    'pipe:1'
  );

  return spawn(FFMPEG, args);
}

app.get('/api/stream-proxy', async (req, res) => {
  const streamUrl = req.query.url;
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

  const headers = {
    'User-Agent': userAgentParam || 'VLC/3.0.18 LibVLC/3.0.18',
    'Accept': '*/*',
    ...(referer ? { 'Referer': referer } : {})
  };

  const isHls = streamUrl.toLowerCase().includes('.m3u8') || streamUrl.toLowerCase().includes('.m3u') || streamUrl.toLowerCase().includes('/hls/');

  const inputUrl = streamUrl;
  let headersStr = '';
  if (referer) headersStr += `Referer: ${referer}\r\n`;
  if (userAgentParam) headersStr += `User-Agent: ${userAgentParam}\r\n`;
  else headersStr += `User-Agent: VLC/3.0.18 LibVLC/3.0.18\r\n`;

  const transcode = req.query.transcode === 'true';
  console.log(`[proxy] Spawning ffmpeg (transcode=${transcode}) directly to upstream URL:`, inputUrl);

  const ffmpeg = spawnFfmpeg(inputUrl, !transcode, headersStr);

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
});

app.listen(PORT, () => console.log(`IPTV player running at http://localhost:${PORT}`));
