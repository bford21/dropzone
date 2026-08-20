# Dropzone FPS MVP — Technical Specification

## Product

Dropzone is a desktop-first, low-poly browser FPS inspired by the pace and clarity of early arena shooters. It offers private Training rooms for one player plus 1–7 bots and public PvP rooms for 2–12 real players. Each 5-minute free-for-all includes instant re-entry, three player-selectable arenas, and three hitscan weapons. The blockchain layer never participates in movement, shooting, hit detection, or respawning.

## Player experience

- Choose Training or Public PvP, select Foundry, Switchyard, or Citadel, pick rifle, sniper, or SMG, then deploy.
- Training starts immediately in an isolated room with the chosen number of bots and never issues Flaunch rewards.
- Public PvP shows a live roster. Players can ready or cancel; the match starts with at least two players when strictly more than half are ready.
- Voice is opt-in. Enabled PvP players can hear one another throughout the lobby; in a live round, audio peers connect only while both players are alive and within 18 authoritative game units. Training has no voice.
- WASD moves, mouse aims, primary click fires, `R` reloads, space jumps, shift slides/sprints, and `1`/`2`/`3` switch weapons.
- The HUD shows health, magazine, crosshair, match clock, leaderboard, connection state, and recent eliminations.
- A kill scores 100 points; a headshot adds 50. Deaths do not subtract points. Players respawn after 2 seconds.
- At round end the server freezes scoring, emits a signed-in-memory result record, and the Flaunch boundary converts the verified points into a Game Mode award in local/mock mode.

## Architecture

```text
Next.js/Vinext browser client
  - Three.js renderer and input sampling
  - visual-only local prediction and remote interpolation
  - never decides hits, damage, score, collision outcomes, or respawns
  - Flaunch Game Mode room facade for launch/economy UI
  - WebRTC peer audio for opted-in PvP voice
                 | WebSocket (game state + bounded voice signaling)
                 v
Authoritative Node realtime server (30 Hz)
  - private Training rooms and shared PvP lobby lifecycle
  - PvP roster, ready voting, and authoritative match start
  - movement integration and arena collision
  - weapon cadence, ammo, reload, ray hit tests, damage
  - health, elimination, respawn, match clock, leaderboard
  - lobby-wide and authoritative proximity voice topology
                 |
                 v
Flaunch integration package
  - verifies Ed25519-signed server results before awarding Game Mode points
  - local adapter uses the official mock-room API
  - embedded adapter uses the official parent bridge and live-room API
  - live launch still requires a public gate, database, RPC, and reviewed version
```

## Authority and trust boundaries

The client sends intent (`move`, `look`, `fire`, `reload`, `weapon`) with a monotonically increasing sequence number. The server bounds input values, applies all simulation, rate limits fire by weapon, traces shots from the server-owned player pose, mutates health/ammo, and publishes snapshots. Client position and client-reported hits are never accepted.

Snapshots are broadcast at 15 Hz while the simulation runs at 30 Hz. Mouse look is rendered immediately and the local camera uses short-horizon movement prediction, then reconciles toward each authoritative snapshot. Remote players interpolate between server targets. Prediction is presentation only: the server remains the source of truth and corrections always win.

### Voice topology and privacy

Voice media is peer-to-peer WebRTC audio and never passes through or gets recorded by the game server. A player must explicitly enable the microphone before the browser requests permission. The server relays strictly validated and size-bounded SDP/ICE signaling only when both players have voice enabled and are currently allowed to hear one another.

The PvP lobby permits a full voice mesh (at most 11 peers per client at the current 12-player room cap). During play, the server publishes a fresh allowed-peer topology at 5 Hz using server-owned alive state and positions; clients immediately close peer connections removed from that topology. Microphone capture continues until the player turns it off, leaves the lobby, or closes the page. Training never accepts voice state.

Production voice requires HTTPS, `wss://`, and a TURN service with preferably short-lived credentials. This peer-mesh design is appropriate for the MVP room cap. Because a modified peer-to-peer client could retain media from an already negotiated connection, deployments requiring hard moderation or cryptographic enforcement should terminate media at a trusted SFU and apply the same server topology to SFU subscriptions.

## Performance priority

Responsiveness is the first client-side constraint. The target is a stable display-refresh frame rate on a typical integrated-GPU laptop, with sub-frame mouse response and no render-loop allocations proportional to snapshot frequency. The renderer therefore uses capped, adaptive pixel density, a cached static shadow map, instancing for repeated arena lights, limited anisotropy, and throttled React HUD updates. Full-screen blend filters and backdrop blurs are avoided during play. Visual additions must stay inside this budget or include a lower-cost fallback.

A production deployment requires wallet-bound sessions, trusted admission-evidence verification, persistent match records, regional rooms, and bounded server-side lag compensation. The current server supplies the first three and exposes explicit configuration seams for the deployment-specific verifier and audit destination.

## Arenas and weapons

Each Training player receives an isolated room on their selected arena. The first player entering an empty public PvP lobby selects its arena; later players join that lobby without changing it. After a PvP round, connected players return to the roster with ready state cleared. The server validates map, mode, bot count, and ready messages and remains authoritative over all transitions. `GAME_MAP_ID=foundry|switchyard|citadel` provides a development/deployment override.

| Arena | Population | Footprint | Layout |
| --- | ---: | ---: | --- |
| Foundry | 1–4 | 44×44 | tight center deck and short cover lanes |
| Switchyard | 5–8 | 64×64 | four broader lanes and staggered mid-field cover |
| Citadel | 9–12 | 88×88 | long sightlines, quadrant structures, and 16 spawn points |

All collision uses server-side axis-aligned boxes from the same shared map definitions used by the renderer. Map ID is included in welcome, round, and snapshot messages so clients cannot render a different arena from the active simulation.

| Weapon | Magazine | Damage | Headshot | Fire interval | Reload | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Rifle | 30 | 34 | 51 | 120 ms | 1.5 s | balanced default |
| Sniper | 5 | 100 | 150 | 900 ms | 2.1 s | scoped field of view |
| SMG | 36 | 22 | 33 | 75 ms | 1.35 s | short damage falloff |

## Flaunch Game Mode integration

Verified on 17 August 2026 against Flaunch's official `game-mode/game-mode-sdk.md` source and the published `0.1.0` packages:

- Browser: `@flayerlabs/gamemode-client` exposes `createMockRoom`, `connectEmbeddedGame`, and `joinRoom`; room capabilities include `launch`, `connection`, `economy`, `market`, `identity`, `presence`, and `social`; purchases use `room.economy.buy(maxSpendWei)`.
- Shared deterministic rules: `@flayerlabs/gamemode-spec` exposes `defineGame`; rules implement `parseAction`, `initRound`, `decide`, `evolve`, views, wake timing, and reward bounds.
- Production gate: `@flayerlabs/gamemode-gate` exposes `createDemoGate` for local evaluation and lower-level production components. A live gate additionally requires Postgres, a signer, an RPC endpoint, HTTPS/WebSockets, verified launch discovery, and a reviewed uploaded game version.

The former public docs URL currently does not render through the docs frontend, but the same [official documentation source](https://github.com/flayerlabs/flaunch-gitbook/blob/main/game-mode/game-mode-sdk.md) remains present in Flaunch's public repository. The current packages were also verified through the [npm registry](https://www.npmjs.com/search?q=%40flayerlabs%2Fgamemode). This repository uses only the API names above and does **not** fabricate a score-submission endpoint. Instead, the browser submits a normal documented `room.send` action containing a server-signed result; the pure `defineGame` rules verify the signature, player, bounds, freshness, and one-claim-per-match rule before returning an award.

### Admission, anti-cheat, and reward safety

- Public PvP joins through the official `joinRoom` flow, which requests the SDK's fresh session evidence. It then obtains a second fresh evidence value and a wallet signature over a one-time game-server challenge. Training does not open a reward session.
- The game server verifies the wallet signature locally and delegates the deliberately opaque evidence to `GAME_SESSION_EVIDENCE_URL`. This URL is a deployment adapter, not an invented Flaunch SDK method. It must return `{ "valid": true, "playerId": "0x..." }` (the player ID may be omitted when the verifier already binds the request).
- Production rewards fail closed unless a unique `GAME_AWARD_PRIVATE_KEY`, `GAME_ALLOWED_ORIGINS`, HTTPS evidence verifier, and `GAME_AUDIT_LOG_PATH` are configured. Guest play can remain available, but an unverified session is never awarded.
- The WebSocket host caps payloads, connections per IP and wallet, and messages per connection. It disables compression, validates origins, bounds aim rates, and disqualifies repeatedly impossible aim input.
- Weapon ammo is stored per weapon, preventing switch-to-refill exploits. Snapshots retain scoreboard fields but redact the coordinates of opponents outside authoritative line of sight.
- Awards use the v2 claim format: kills, headshots, formula-derived score, and the current append-only audit hash are signed. Rules reject unknown/oversized fields, inconsistent scoring, stale claims, wrong players, invalid signatures, and replay attempts after canonicalizing player IDs.

Production environment variables:

| Variable | Purpose |
| --- | --- |
| `GAME_AWARD_PRIVATE_KEY` | Unique 32-byte Ed25519 signing seed in hex, loaded from secret storage. |
| `GAME_ALLOWED_ORIGINS` | Comma-separated exact browser origins permitted to open game sockets. |
| `GAME_SESSION_EVIDENCE_URL` | HTTPS trusted-platform endpoint that consumes and verifies fresh SDK admission evidence. |
| `GAME_SESSION_EVIDENCE_TOKEN` | Optional bearer credential for the verifier adapter. |
| `GAME_AUDIT_LOG_PATH` | Durable append-only NDJSON destination for match and reward events. |
| `GAME_MAX_CONNECTIONS_PER_IP` | Optional connection ceiling; defaults to 6. |
| `GAME_MAX_CONNECTIONS_PER_WALLET` | Optional verified-wallet ceiling; defaults to 2. |
| `GAME_TRUST_PROXY` | Set to `true` only behind a proxy that overwrites `X-Forwarded-For`. |
| `GAME_REWARDS_ENABLED` | Set to `false` to run production gameplay without issuing rewards. |
| `NEXT_PUBLIC_VOICE_STUN_URL` | Optional STUN service URL used for WebRTC candidate discovery. |
| `NEXT_PUBLIC_VOICE_TURN_URL` | TURN service URL required for reliable production voice across NAT/firewalls. |
| `NEXT_PUBLIC_VOICE_TURN_USERNAME` | TURN username; production should prefer short-lived credentials. |
| `NEXT_PUBLIC_VOICE_TURN_CREDENTIAL` | TURN credential paired with the username. |

## Repository layout

- `app/` — Next.js/Vinext shell and game page.
- `components/game/` — Three.js client, HUD, lobby, and input.
- `packages/shared/` — transport messages, constants, map, and weapon data.
- `packages/game-server/` — deterministic authoritative simulation and WebSocket host.
- `packages/flaunch/` — Flaunch rules, mock room, provider contract, and production guard.
- `tests/` — engine, protocol, and Flaunch rules tests.

## Acceptance criteria

1. The browser home screen offers Training and Public PvP, three arenas, configurable Training bots, and three loadouts.
2. Training creates a private one-human room and starts immediately; separate Training players never share a simulation and cannot earn rewards.
3. Two or more browser tabs can enter the public roster, see joins and ready changes, and start only after a strict ready majority with a two-player minimum.
4. Rifle, sniper, and SMG have distinct validated cadence, magazine, reload, and damage.
5. A client cannot set its own position, health, damage, kills, score, room state, or match start.
6. PvP match end produces a server-owned result and a local/mock Flaunch award without any invented SDK method; Training never does.
7. Type-check/build and automated simulation tests pass.
8. The home screen offers Foundry, Switchyard, and Citadel; the first player in an empty PvP lobby sets its arena, later players cannot change it, and a server override always wins.
9. PvP microphone access is opt-in; the lobby permits all enabled peers and live rounds restrict enabled peers to the authoritative 18-unit proximity topology. Training has no voice.
