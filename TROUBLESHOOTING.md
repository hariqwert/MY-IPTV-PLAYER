# Troubleshooting & Codebase Maintenance Guide

This document serves as an authoritative guide on the architecture, debugging procedures, and core streaming principles of the IPTV Web Player. Follow these instructions when fixing bugs or writing new features to ensure continuous, error-free playback.

---

## 1. The Self-Healing Stream Strategy

### The Problem
IPTV providers and CDNs often close raw HTTP streaming connections cleanly after a specific buffer threshold (~3MB or 20–30 seconds of video) or drop the TCP window size to 0 on backpressure, leading to playbacks stalling.

### The Solution (Backend-Level Reconnection)
Never let the frontend player or `ffmpeg` see connection termination. Instead, implement a **self-healing relay** inside your Express proxy:
1. Connect to the provider and pipe data chunk-by-chunk.
2. Listen for the `'end'` or `'error'` events from the upstream connection.
3. When the socket closes, clean up listeners, wait a brief delay (e.g., 1 second), and call the connection function again.
4. Continue writing the new chunks directly into the existing client socket.

**Maintenance Rule**: Keep the client-side socket (`res`) alive continuously. Reconnect the upstream sockets in the background.

---

## 2. Browser Media & Transcoding Constraints

### Audio Compatibility
* **MSE Limitation**: Web browsers (Chrome, Edge, Firefox, Safari) using Media Source Extensions (MSE) do **not** support decoding raw `mp2` or `ac3` audio tracks natively. They will play video in silence.
* **Transcoding Protocol**: You must transcode unsupported audio streams on the fly to browser-compatible standard AAC (`-c:a aac -b:a 128k`).

### Video Processing (0% CPU Copy)
* **Performance Rule**: Never re-encode/transcode the video stream (`h264`) on the backend. Video transcoding is extremely CPU-expensive and will overload server environments (like Render).
* **Implementation**: Always use video stream copying (`-c:v copy`) to repackage the H.264 stream into a compatible MPEG-TS container with **0% CPU cost**.

---

## 3. Frontend Player State Lifecycle

### Preventing Stack Overflows & Reference Crashes
When the player (`mpegts.js`) encounters a stream drop or error:
1. Do **not** destroy the player instance directly inside its own callback/event handler. Doing so causes internal null-reference exceptions (`Cannot read properties of null (reading 'currentURL')`).
2. **Implementation**: Always wrap the player disposal and recreation inside a `setTimeout(..., 0)` block. This defers execution to the next tick of the JavaScript event loop, allowing the player engine to finish its current stack trace safely.

```javascript
// Correct Cleanup Pattern
const playerToDestroy = state.mpegtsPlayer;
state.mpegtsPlayer = null;
if (playerToDestroy) {
  setTimeout(() => {
    try { playerToDestroy.unload(); } catch (e) {}
    try { playerToDestroy.detachMediaElement(); } catch (e) {}
    try { playerToDestroy.destroy(); } catch (e) {}
  }, 0);
}
```

---

## 4. Debugging Guidelines: Isolating Issues

When a channel fails to play, systematically isolate the networking layer from the playback player using these steps:

1. **Step 1: Inspect Upstream Redirects with Curl**
   Check if the provider is returning HTTP redirects or blocking the connection:
   ```bash
   curl.exe -I -L -H "User-Agent: VLC/3.0.18 LibVLC/3.0.18" "PROVIDER_URL"
   ```
2. **Step 2: Check for Segment/File Loops**
   Download the stream for a few seconds. If the download completes/ends cleanly at exactly ~3MB, the channel is currently offline and serving a static looped placeholder file rather than a live continuous stream.
3. **Step 3: Server Logs Check**
   Review the Express backend console logs. Verify if the `[internal-stream]` or `[proxy-raw-fetch]` handlers are successfully catching socket cuts and initiating background reconnect loops.

---

## 5. Case Study: Issues Encountered & Resolved

During the web player recovery phase, we analyzed, resolved, and documented the following core bugs:

### Case 1: 17–30s Playback Freeze
* **Description**: Stream playback cut off cleanly after exactly ~20 seconds of playback on both Original and Transcoded quality modes.
* **Root-Cause**: 
  1. **Stream Corruption via Chunk Dropping**: Previously, the raw stream proxy endpoint (`/api/stream-proxy-raw`) used a manual memory queue (`bufferQueue`) with a strict `MAX_BUFFER_SIZE_BYTES` size threshold of 3MB. When the buffer filled up (in ~20 seconds), it deleted the oldest chunks to avoid memory growth. However, dropping arbitrary bytes out of an active MPEG-TS stream breaks sequence counters and corrupts packet headers, crashing the browser decoder (`mpegts.js`) and freezing playback.
  2. **CDN socket cuts / offline loops**: CDNs drop connections on high-speed downloads (scraper blocks) or when TCP windows drop to 0. Additionally, offline streams served a static 28-second file loop before closing.
* **Fix**: 
  1. **Unified Timestamp Correction via FFmpeg**: Replaced direct raw byte piping inside `/api/stream-proxy-raw` with a 0% CPU FFmpeg copy pipeline (`-c:v copy -c:a copy`). Both the `Original` (direct) and `Transcoded (Bypass)` quality endpoints now run the stream through FFmpeg. This leverages FFmpeg's robust timestamp correction flags (`-fflags +genpts+igndts+discardcorrupt+nobuffer -correct_ts_overflow 1 -avoid_negative_ts make_zero`) to rewrite packet sequence counters on the fly. When background reconnects occur, all timestamp gaps and discontinuities are completely corrected and smoothed out before reaching the browser, preventing player frame freezes.
  2. **Auto-Reconnect Relay Loop**: Appended a background-level auto-reconnect loop on the upstream loopback relay `/api/internal-stream`. The Express server automatically heals connection cuts in under 1 second without closing the downstream player pipe.

### Case 2: Silent Web Playback
* **Description**: Video played cleanly but without sound on the web interface.
* **Root-Cause**: Browser Media Source Extensions (MSE) do not support the older `mp2` audio codec natively.
* **Fix**: Configured FFmpeg to copy the video stream directly (`-c:v copy` at 0% CPU cost) and transcode only the audio track to browser-compatible standard AAC (`-c:a aac -b:a 128k`) on the fly.

### Case 3: Player Crash loop (`Cannot read properties of null (reading 'currentURL')`)
* **Description**: Browser throws a type error and breaks the player cycle when reconnecting or switching qualities.
* **Root-Cause**: Calling `.destroy()` on the `mpegtsPlayer` instance directly inside its own error and event listeners deletes dependencies while they are still in the active execution stack of the player engine.
* **Fix**: Wrapped all `mpegtsPlayer` disposal sequences in `setTimeout(..., 0)` to allow the player stack to complete its execution loop safely before instance destruction.

### Case 4: FFmpeg Container Format Mismatch
* **Description**: Browser player console logged `Non MPEG-TS/FLV, Unsupported media type!`.
* **Root-Cause**: FFmpeg was outputting fragmented MP4 (`-f mp4` with `-movflags frag_keyframe`) while the frontend `mpegts.js` engine expected a pure MPEG-TS (`video/mp2t`) container header.
* **Fix**: Standardized the FFmpeg command output format flag to `-f mpegts` and set the HTTP response headers content type to `video/mp2t`.

### Case 5: Broken Fallback quality-switch (Hanging on a Single Frame)
* **Description**: Switching to Transcoded (Bypass) mode failed to work when the player got stuck on a single frame in Original quality.
* **Root-Cause**: 
  1. Original quality copied `mp2` audio directly, which browsers cannot decode, causing a browser decoder crash (stuck frame).
  2. The code registered error listeners on invalid event strings: `player.on(mpegts.ErrorTypes.MEDIA_ERROR, ...)` and `player.on(mpegts.ErrorTypes.NETWORK_ERROR, ...)`. In `mpegts.js`, there are no such event names; the player fires a single unified `'error'` event (`mpegts.Events.ERROR`) and passes the error type as the callback parameter.
  3. Consequently, the media decoder crash went unhandled, the automatic quality fallback never executed, and the quality dropdown became unresponsive because the player state stayed in a crashed loop.
* **Fix**: Consolidated all error type handlers under the single unified `'error'` (`mpegts.Events.ERROR`) listener in `index.html`. It now correctly inspects the error type argument and triggers `fallbackToTranscode()` or restarts the stream instantly.
