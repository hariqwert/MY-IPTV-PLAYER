# Signal — IPTV Web Player

## Setup
```
npm install
node server.js
```
Open http://localhost:8080 — you'll land on the hero page first, click
"Enter the player" to go into the app.

Requires `ffmpeg` on your machine (used only as a fallback when a stream's
codec isn't natively browser-playable). Mac: `brew install ffmpeg`.
Ubuntu/Debian: `sudo apt install ffmpeg`.

## Design
Hero page: dark cinematic background, a "channel dial" numeral that spins
like an old TV tuner on load then settles, Fraunces serif display type +
Inter body + IBM Plex Mono for tuning-dial/technical labels, one amber
accent color. "Enter the player" crossfades into the app view.

## What's inside (functionality carried over)
- Add an M3U source by URL or file upload
- Live channel browser with groups + search
- Playback via hls.js through a backend proxy that bypasses CORS, passes
  segments through raw when possible, falls back to real-time ffmpeg
  transcoding only on a codec error, and times out cleanly on dead sources
  instead of hanging (10s connect, 10s idle)
- Distinct error messages for blocked (403), dead/timeout (504), and
  malformed sources

## Known, expected limitations
Free/public IPTV sources always have some dead links, geo-blocked channels,
or providers that block server-side access outright — that's not a bug in
this app, it's the nature of the sources.

## Extending to Xtream Codes / Stalker Portal
Not wired in here (both need real credentials to test against). They plug
into the exact same /api/stream-proxy — see the technical reference PDF
from earlier in this conversation for the endpoint/header/call-sequence
details.
## A testing stage website preview 
https://my-iptv-player.onrender.com/

