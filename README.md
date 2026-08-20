# Dropzone

A Krunker-inspired, low-poly browser FPS built around Flaunch Game Mode. The Next.js/Vinext client renders the arena with Three.js; a separate Node WebSocket process owns the complete match simulation.

Read [the technical specification](docs/TECHNICAL_SPEC.md) for the trust model, weapons, map, Flaunch verification notes, and acceptance criteria.

## Run locally

Requires Node 22+.

```bash
npm install
npm run dev
```

In a second terminal:

```bash
npm run game:server
```

Open the web URL printed by `npm run dev`. Choose an arena, loadout, and mode before deploying. Training creates a private room for you and 1–7 bots. Public PvP places real players in a shared lobby; a two-player minimum and strict ready majority starts the match. Voice is optional: opted-in players hear the whole lobby, then only living players within 18 game units during a match. The realtime server listens on `ws://localhost:8081`.

## Deploy on Railway

The first public deployment uses two persistent Railway services sourced from this repository. Keep both services at the repository root because the web and game processes share packages.

### 1. Create the services

Create an empty Railway project, then add `bford21/dropzone` twice and name the services exactly `web` and `game-server`.

For `web`:

- Root directory: `/`
- Config file path: `/railway.web.json`
- Generate an HTTP public domain.

For `game-server`:

- Root directory: `/`
- Config file path: `/railway.game.json`
- Generate an HTTP public domain; secure WebSockets use this same domain.
- Keep exactly one replica. Lobby and match state are currently process-local.

The checked-in configs select Railpack, production start commands, watch paths, restart policies, and the `/` and `/health` health checks. Both processes bind to Railway's injected `PORT` on `0.0.0.0`.

### 2. Add variables

Add this variable to `web` before its final build:

```text
NEXT_PUBLIC_GAME_SERVER_URL=wss://${{game-server.RAILWAY_PUBLIC_DOMAIN}}
```

Add these variables to `game-server`:

```text
GAME_ALLOWED_ORIGINS=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
GAME_TRUST_PROXY=true
GAME_REWARDS_ENABLED=false
GAME_MAX_CONNECTIONS_PER_IP=6
GAME_MAX_CONNECTIONS_PER_WALLET=2
```

Railway terminates TLS and supplies the trusted `X-Real-IP` header used when `GAME_TRUST_PROXY=true`. Do not enable that setting behind an untrusted proxy. After the domains and variables exist, redeploy both services. The game health endpoint should report `"ok": true`, and the browser should connect to the game domain over `wss://`.

`NEXT_PUBLIC_*` values are embedded during the web build, so changing them requires a web redeploy. For reliable production voice, also configure the STUN/TURN variables documented below; a managed TURN provider is recommended.

### 3. Enable verified rewards later

The initial Railway deployment deliberately uses `GAME_REWARDS_ENABLED=false`. Before enabling rewards, deploy the trusted session-evidence verifier described in the technical specification, attach a Railway volume to `game-server` at `/data`, and set:

```text
GAME_REWARDS_ENABLED=true
GAME_AWARD_PRIVATE_KEY=<sealed 32-byte hex seed>
GAME_SESSION_EVIDENCE_URL=https://<trusted-verifier-domain>
GAME_SESSION_EVIDENCE_TOKEN=<sealed verifier credential>
GAME_AUDIT_LOG_PATH=/data/matches.ndjson
```

Never commit those values. Seal the signing seed and verifier credential in Railway.

## Controls

- WASD — move
- Mouse — aim
- Left click — fire
- Shift — sprint
- Space — jump
- R — reload
- 1 / 2 / 3 — rifle / sniper / SMG

## Validation

```bash
npm run typecheck
npm test
npm run build
```

The tests cover bounded input, authoritative movement, server-side hits and scoring, fire-rate enforcement, ammo-switch abuse, impossible aim rates, hidden-position redaction, voice signaling bounds and proximity, wallet challenge binding, traffic budgets, origin checks, signed Flaunch claims, claim tampering, score formulas, and replay prevention.

## Voice chat

PvP voice uses browser WebRTC audio and is off by default. The game server relays only bounded offer/answer and ICE messages; it never receives or records microphone media. In the PvP lobby, every opted-in player can connect. During a live round, the server recalculates the permitted peer set from authoritative player positions five times per second and removes connections outside the 18-unit radius. Training rooms never enable voice.

Microphone access requires `localhost` or HTTPS. Configure a TURN service for reliable production connectivity across restrictive networks; a STUN-only setup is not sufficient for every player.

## Flaunch modes

Local development uses the official `createMockRoom` API from `@flayerlabs/gamemode-client`. When the game runs inside the Flaunch parent, set `NEXT_PUBLIC_FLAUNCH_PARENT_ORIGIN`; the client then uses the documented `connectEmbeddedGame` and `joinRoom` path.

The authoritative server signs the immutable result claim with Ed25519. The reviewed `defineGame` rules verify that proof inside the Flaunch gate before awarding points. Production refuses to start with rewards enabled unless its signing key, origin policy, admission-evidence verifier, and durable audit destination are configured. Local development alone uses the deterministic development key and mock room.

Training scores are deliberately not eligible for Flaunch rewards. Only verified public PvP sessions can receive a signed match award.

Environment variables:

- `GAME_SERVER_PORT` — realtime server port, default `8081`.
- `GAME_AWARD_PRIVATE_KEY` — production Ed25519 seed; never expose it to the web app.
- `GAME_ALLOWED_ORIGINS` — comma-separated exact browser origins allowed to open game sockets.
- `GAME_SESSION_EVIDENCE_URL` — trusted HTTPS endpoint that validates fresh SDK admission evidence.
- `GAME_SESSION_EVIDENCE_TOKEN` — optional bearer credential for that verifier.
- `GAME_AUDIT_LOG_PATH` — durable append-only match and reward audit log.
- `GAME_MAX_CONNECTIONS_PER_IP` / `GAME_MAX_CONNECTIONS_PER_WALLET` — optional abuse ceilings.
- `GAME_TRUST_PROXY` — set only when a trusted proxy overwrites forwarded client addresses.
- `GAME_REWARDS_ENABLED=false` — run production gameplay without issuing Game Mode rewards.
- `NEXT_PUBLIC_GAME_SERVER_URL` — public `wss://` game-server URL.
- `NEXT_PUBLIC_FLAUNCH_PARENT_ORIGIN` — exact trusted Flaunch embed parent origin.
- `NEXT_PUBLIC_VOICE_STUN_URL` — optional STUN URL used by WebRTC voice.
- `NEXT_PUBLIC_VOICE_TURN_URL` — production TURN URL used by WebRTC voice.
- `NEXT_PUBLIC_VOICE_TURN_USERNAME` / `NEXT_PUBLIC_VOICE_TURN_CREDENTIAL` — TURN credentials (prefer short-lived credentials issued by your backend).
- `MATCH_DURATION_MS` — optional local/testing round duration, default five minutes.

For a live Flaunch launch, also deploy the reviewed gate with Postgres, HTTPS/WebSockets, an RPC endpoint, and Flaunch launch discovery as required by the official Game Mode documentation.
