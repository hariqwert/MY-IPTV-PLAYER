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
  1. The CDN severs the socket connection after sending a ~3MB buffer due to rate-limit triggers (when downloading faster than 1.0x) or TCP window size 0 events (when backpressure pauses consumption).
  2. For offline channels (like the SD channel Asianet Movies `9031`), the provider server streams a pre-recorded 28-second static file loop and closes the connection cleanly at EOF.
* **Fix**: Implemented backend-level auto-reconnect relay loops on **both** `/api/internal-stream` and `/api/stream-proxy-raw`. The Express server catches upstream closures, establishes a fresh provider connection in under 1 second, and writes chunks directly to the active client stream. The downstream player continues reading without seeing EOF.

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
