import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { isMapId, type MapId } from "../../shared/src/map";
import { randomCallsign } from "../../shared/src/names";
import { parseClientMessage, type GameMode, type LobbyState, type ServerMessage, type WeaponId } from "../../shared/src/protocol";
import { canJoinPvp, canStartPvp, playersInVoiceRange, PVP_MINIMUM_PLAYERS, requiredReadyCount, VOICE_PROXIMITY_RADIUS } from "../../shared/src/rooms";
import { verifySessionEvidence } from "./admission";
import { MatchAudit } from "./audit";
import { AwardSigner } from "./award-signer";
import { GameEngine } from "./engine";
import { clientIp, configuredOrigins, isAllowedOrigin, TokenBucket } from "./security";
import { createAuthChallenge, normalizeWallet, verifyWalletSignature } from "./wallet-auth";

const PORT = Number(process.env.GAME_SERVER_PORT ?? 8081);
const TICK_RATE = 30;
const SNAPSHOT_RATE = 15;
const VOICE_TOPOLOGY_RATE = 5;
const MAX_ROOM_PLAYERS = 12;
const MAX_CONNECTIONS_PER_IP = Number(process.env.GAME_MAX_CONNECTIONS_PER_IP ?? 6);
const MAX_CONNECTIONS_PER_WALLET = Number(process.env.GAME_MAX_CONNECTIONS_PER_WALLET ?? 2);
const AUTH_WINDOW_MS = 60_000;
const PRODUCTION = process.env.NODE_ENV === "production";
const REWARDS_ENABLED = process.env.GAME_REWARDS_ENABLED !== "false";
const MAP_OVERRIDE = isMapId(process.env.GAME_MAP_ID) ? process.env.GAME_MAP_ID : null;
const ALLOWED_ORIGINS = configuredOrigins();
const EVIDENCE_ENDPOINT = process.env.GAME_SESSION_EVIDENCE_URL;

if (PRODUCTION && ALLOWED_ORIGINS.size === 0) throw new Error("GAME_ALLOWED_ORIGINS is required in production");
if (PRODUCTION && REWARDS_ENABLED && !EVIDENCE_ENDPOINT) throw new Error("GAME_SESSION_EVIDENCE_URL is required when production rewards are enabled");
if (PRODUCTION && REWARDS_ENABLED && !process.env.GAME_AUDIT_LOG_PATH) throw new Error("GAME_AUDIT_LOG_PATH is required when production rewards are enabled");
if (PRODUCTION && EVIDENCE_ENDPOINT && !EVIDENCE_ENDPOINT.startsWith("https://")) throw new Error("GAME_SESSION_EVIDENCE_URL must use HTTPS in production");

const signer = new AwardSigner(undefined, PRODUCTION && REWARDS_ENABLED);

interface Session {
  id: string;
  ip: string;
  name: string;
  weapon: WeaponId;
  mode: GameMode | null;
  ready: boolean;
  voiceEnabled: boolean;
  awardPlayerId: string;
  joined: boolean;
  awarded: boolean;
  rewardEligible: boolean;
  identityPending: boolean;
  identityVerified: boolean;
  authChallenge: string;
  authExpiresAt: number;
  authMatchId: string;
  securityFlags: string[];
  messageBudget: TokenBucket;
  room: GameRoom | null;
  socket: WebSocket;
}

interface GameRoom {
  id: string;
  mode: GameMode;
  mapId: MapId;
  botCount: number;
  status: "lobby" | "playing" | "ending";
  sessions: Set<Session>;
  engine: GameEngine | null;
  audit: MatchAudit;
  resetAt: number;
}

const sessions = new Map<WebSocket, Session>();
const rooms = new Set<GameRoom>();
const ipConnections = new Map<string, number>();
const walletConnections = new Map<string, number>();
let pvpRoom: GameRoom | null = null;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendRoom(room: GameRoom, message: ServerMessage): void {
  const data = JSON.stringify(message);
  for (const session of room.sessions) if (session.socket.readyState === WebSocket.OPEN) session.socket.send(data);
}

function newRoom(mode: GameMode, mapId: MapId, botCount: number): GameRoom {
  const id = `${mode}-lobby-${randomUUID()}`;
  const room: GameRoom = { id, mode, mapId: MAP_OVERRIDE ?? mapId, botCount, status: mode === "pvp" ? "lobby" : "playing", sessions: new Set(), engine: null, audit: new MatchAudit(id), resetAt: 0 };
  room.audit.record("room-created", { mode, mapId: room.mapId, botCount });
  rooms.add(room);
  return room;
}

function lobbyState(room: GameRoom): LobbyState {
  const players = [...room.sessions].map((session) => ({ id: session.id, name: session.name, ready: session.ready, voiceEnabled: session.voiceEnabled }));
  const readyCount = players.filter((player) => player.ready).length;
  return { roomId: room.id, mapId: room.mapId, players, readyCount, requiredReady: requiredReadyCount(players.length), minimumPlayers: PVP_MINIMUM_PLAYERS };
}

function voiceAllowed(room: GameRoom, from: Session, to: Session): boolean {
  if (room.mode !== "pvp" || from === to || !from.voiceEnabled || !to.voiceEnabled || from.room !== room || to.room !== room) return false;
  if (room.status === "lobby") return true;
  const fromPlayer = room.engine?.players.get(from.id);
  const toPlayer = room.engine?.players.get(to.id);
  return Boolean(fromPlayer?.alive && toPlayer?.alive && playersInVoiceRange(fromPlayer.position, toPlayer.position));
}

function sendVoiceTopology(room: GameRoom): void {
  for (const session of room.sessions) {
    const peerIds = session.voiceEnabled ? [...room.sessions].filter((peer) => voiceAllowed(room, session, peer)).map((peer) => peer.id) : [];
    send(session.socket, { type: "voiceTopology", peerIds, proximityRadius: room.status === "lobby" ? null : VOICE_PROXIMITY_RADIUS });
  }
}

function broadcastLobby(room: GameRoom): void {
  sendRoom(room, { type: "lobby", lobby: lobbyState(room) });
  if (room.mode === "pvp") sendVoiceTopology(room);
}

function startEngine(room: GameRoom, now: number): void {
  void room.audit.flush();
  const matchId = `dropzone-${room.mode}-${room.mapId}-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
  const engine = new GameEngine(now, matchId, room.mapId);
  room.audit = new MatchAudit(matchId);
  room.audit.record("round-started", { mode: room.mode, mapId: room.mapId, botCount: room.botCount }, now);
  room.engine = engine;
  room.status = "playing";
  room.resetAt = 0;
  if (room.mode === "training") engine.addBots(room.botCount);
  for (const session of room.sessions) {
    session.awarded = false;
    engine.addPlayer(session.id, session.name, session.weapon);
  }
  if (room.mode === "pvp") sendVoiceTopology(room);
  engine.onShot = (shot) => {
    room.audit.record("shot", shot);
    const shooterPlayer = engine.players.get(shot.shooterId);
    if (shooterPlayer) sendRoom(room, { type: "weaponFire", shooterId: shot.shooterId, weapon: shooterPlayer.weapon });
    const victim = shot.hitId ? [...room.sessions].find((session) => session.id === shot.hitId) : undefined;
    const victimPlayer = shot.hitId ? engine.players.get(shot.hitId) : undefined;
    if (victim && victimPlayer && shooterPlayer && shot.damage > 0) send(victim.socket, { type: "damage", attackerId: shot.shooterId, sourcePosition: { ...shooterPlayer.position }, damage: shot.damage, health: victimPlayer.health, headshot: shot.headshot, killed: shot.killed });
    const shooter = [...room.sessions].find((session) => session.id === shot.shooterId);
    if (shooter) send(shooter.socket, { type: "shot", ...shot });
  };
  engine.onRespawn = (playerId, spawnYaw) => {
    room.audit.record("respawn", { playerId, spawnYaw });
    sendRoom(room, { type: "respawn", playerId, spawnYaw });
  };
  engine.onSecurityFlag = (playerId, reason) => {
    const session = [...room.sessions].find((candidate) => candidate.id === playerId);
    if (!session || session.securityFlags.includes(reason)) return;
    session.securityFlags.push(reason);
    session.rewardEligible = false;
    room.audit.record("security-flag", { playerId, reason, ip: session.ip });
  };
}

function setupAdmission(session: Session, room: GameRoom, now: number): void {
  session.authExpiresAt = now + AUTH_WINDOW_MS;
  session.authMatchId = room.id;
  session.authChallenge = createAuthChallenge(session.id, session.authMatchId, session.authExpiresAt);
}

function welcome(session: Session, room: GameRoom): void {
  const player = room.engine?.players.get(session.id);
  send(session.socket, {
    type: "welcome",
    playerId: session.id,
    matchId: room.engine?.matchId ?? room.id,
    mapId: room.mapId,
    mode: room.mode,
    phase: room.status === "lobby" ? "lobby" : "playing",
    tickRate: TICK_RATE,
    awardPublicKey: signer.publicKey,
    spawnYaw: player?.yaw ?? 0,
    authChallenge: session.authChallenge,
    authExpiresAt: session.authExpiresAt,
  });
}

function joinTraining(session: Session, mapId: MapId, botCount: number, now: number): void {
  const room = newRoom("training", mapId, botCount);
  room.sessions.add(session);
  session.room = room;
  session.mode = "training";
  session.rewardEligible = false;
  startEngine(room, now);
  room.audit.record("player-joined", { sessionId: session.id, ip: session.ip, name: session.name });
  welcome(session, room);
}

function joinPvp(session: Session, mapId: MapId, now: number): void {
  if (!canJoinPvp(pvpRoom?.status ?? null)) {
    send(session.socket, { type: "error", message: "PVP match already in progress. Try again after this round." });
    return;
  }
  if (!pvpRoom || pvpRoom.sessions.size === 0) pvpRoom = newRoom("pvp", mapId, 0);
  if (pvpRoom.sessions.size >= MAX_ROOM_PLAYERS) {
    send(session.socket, { type: "error", message: "PVP lobby is full" });
    return;
  }
  const room = pvpRoom;
  room.sessions.add(session);
  session.room = room;
  session.mode = "pvp";
  session.ready = false;
  setupAdmission(session, room, now);
  room.audit.record("player-joined", { sessionId: session.id, ip: session.ip, name: session.name, requestedMapId: mapId, mapId: room.mapId });
  welcome(session, room);
  broadcastLobby(room);
}

function tryStartPvp(room: GameRoom, now: number): void {
  if (room.mode !== "pvp" || room.status !== "lobby") return;
  const state = lobbyState(room);
  if (!canStartPvp(state.players.length, state.readyCount)) return;
  startEngine(room, now);
  for (const session of room.sessions) {
    const player = room.engine!.players.get(session.id)!;
    send(session.socket, { type: "matchStart", matchId: room.engine!.matchId, mapId: room.mapId, spawnYaw: player.yaw });
  }
}

async function authenticateSession(session: Session, playerId: string, signature: string | undefined, evidence: unknown): Promise<void> {
  const room = session.room;
  if (!room || room.mode !== "pvp" || session.identityPending || session.identityVerified || session.awarded) return;
  session.identityPending = true;
  try {
    if (!signature) {
      if (!PRODUCTION) {
        session.awardPlayerId = playerId.toLowerCase();
        session.rewardEligible = REWARDS_ENABLED;
      }
      return;
    }
    const wallet = normalizeWallet(playerId);
    if (!wallet || Date.now() > session.authExpiresAt || !verifyWalletSignature(session.authChallenge, signature, wallet)) {
      room.audit.record("identity-rejected", { sessionId: session.id, reason: "invalid-wallet-proof" });
      return;
    }
    if ((walletConnections.get(wallet) ?? 0) >= MAX_CONNECTIONS_PER_WALLET) {
      room.audit.record("identity-rejected", { sessionId: session.id, reason: "wallet-session-limit", wallet });
      return;
    }
    const evidenceValid = await verifySessionEvidence({ evidence, playerId: wallet, matchId: session.authMatchId, sessionId: session.id, endpoint: EVIDENCE_ENDPOINT, bearerToken: process.env.GAME_SESSION_EVIDENCE_TOKEN });
    if (!evidenceValid) {
      room.audit.record("identity-rejected", { sessionId: session.id, reason: "invalid-session-evidence", wallet });
      return;
    }
    session.awardPlayerId = wallet;
    session.rewardEligible = REWARDS_ENABLED;
    session.identityVerified = true;
    walletConnections.set(wallet, (walletConnections.get(wallet) ?? 0) + 1);
    room.audit.record("identity-verified", { sessionId: session.id, wallet });
  } finally {
    session.identityPending = false;
  }
}

function issueAwards(room: GameRoom, now: number): void {
  const engine = room.engine;
  if (!engine || room.mode !== "pvp") return;
  for (const session of room.sessions) {
    if (session.awarded) continue;
    session.awarded = true;
    const player = engine.players.get(session.id);
    if (!player || !session.rewardEligible || session.securityFlags.length > 0) continue;
    const result = { playerId: session.awardPlayerId, points: player.score, kills: player.kills, headshots: player.headshots };
    room.audit.record("match-result", result, now);
    const award = signer.sign({ matchId: engine.matchId, ...result, issuedAt: now, nonce: randomBytes(12).toString("hex"), eventHash: room.audit.hash() });
    room.audit.record("award-issued", { playerId: session.awardPlayerId, points: player.score, eventHash: award.claim.eventHash }, now);
    send(session.socket, { type: "award", award });
  }
}

function removeSessionFromRoom(session: Session, now = Date.now()): void {
  const room = session.room;
  if (!room) return;
  room.sessions.delete(session);
  room.engine?.removePlayer(session.id);
  room.audit.record("player-left", { sessionId: session.id, ip: session.ip }, now);
  session.room = null;
  if (room.sessions.size === 0) {
    rooms.delete(room);
    if (pvpRoom === room) pvpRoom = null;
    void room.audit.flush();
  } else if (room.mode === "pvp" && room.status === "lobby") {
    broadcastLobby(room);
    tryStartPvp(room, now);
  } else if (room.mode === "pvp") {
    sendVoiceTopology(room);
  }
}

const httpServer = createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/health") {
    const playingRooms = [...rooms].filter((room) => room.status !== "lobby").length;
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, playingRooms, connections: sessions.size, pvpLobbyPlayers: pvpRoom?.status === "lobby" ? pvpRoom.sessions.size : 0, awardPublicKey: signer.publicKey, rewardsReady: REWARDS_ENABLED && (!PRODUCTION || Boolean(EVIDENCE_ENDPOINT)) }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not-found" }));
});

const sockets = new WebSocketServer({
  server: httpServer,
  maxPayload: 16_384,
  perMessageDeflate: false,
  verifyClient(info, done) {
    const ip = clientIp(info.req.headers, info.req.socket.remoteAddress);
    if (!isAllowedOrigin(info.origin, ALLOWED_ORIGINS, PRODUCTION)) { done(false, 403, "Origin not allowed"); return; }
    if ((ipConnections.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) { done(false, 429, "Connection limit reached"); return; }
    done(true);
  },
});

sockets.on("connection", (socket, request) => {
  const id = randomUUID();
  const ip = clientIp(request.headers, request.socket.remoteAddress);
  const session: Session = {
    id, ip, name: randomCallsign(), weapon: "rifle", mode: null, ready: false, voiceEnabled: false, awardPlayerId: id,
    joined: false, awarded: false, rewardEligible: false, identityPending: false, identityVerified: false,
    authChallenge: "", authExpiresAt: 0, authMatchId: "", securityFlags: [],
    messageBudget: new TokenBucket(120, 60), room: null, socket,
  };
  sessions.set(socket, session);
  ipConnections.set(ip, (ipConnections.get(ip) ?? 0) + 1);

  socket.on("message", (buffer) => {
    const now = Date.now();
    if (!session.messageBudget.take(1, now)) { session.room?.audit.record("connection-closed", { sessionId: id, reason: "message-rate", ip }); socket.close(1008, "Message rate exceeded"); return; }
    let decoded: unknown;
    try { decoded = JSON.parse(buffer.toString()); } catch { send(socket, { type: "error", message: "Malformed message" }); return; }
    const message = parseClientMessage(decoded);
    if (!message) { send(socket, { type: "error", message: "Unsupported message" }); return; }
    if (message.type === "join") {
      if (session.joined) return;
      session.name = message.name.trim() || randomCallsign();
      session.weapon = message.weapon;
      if (message.mode === "training") joinTraining(session, message.mapId, message.botCount, now);
      else joinPvp(session, message.mapId, now);
      session.joined = session.room !== null;
      return;
    }
    if (!session.joined || !session.room) { send(socket, { type: "error", message: "Join first" }); return; }
    const room = session.room;
    if (message.type === "identity") void authenticateSession(session, message.playerId, message.signature, message.evidence);
    else if (message.type === "ready") {
      if (room.mode !== "pvp" || room.status !== "lobby") return;
      session.ready = message.ready;
      room.audit.record("ready-changed", { sessionId: session.id, ready: session.ready }, now);
      broadcastLobby(room);
      tryStartPvp(room, now);
    } else if (message.type === "voiceState") {
      session.voiceEnabled = room.mode === "pvp" && message.enabled;
      room.audit.record("voice-state", { sessionId: session.id, enabled: session.voiceEnabled }, now);
      if (room.status === "lobby") broadcastLobby(room); else sendVoiceTopology(room);
    } else if (message.type === "voiceSignal") {
      const target = [...room.sessions].find((candidate) => candidate.id === message.toPlayerId);
      if (target && voiceAllowed(room, session, target)) send(target.socket, { type: "voiceSignal", fromPlayerId: session.id, signal: message.signal });
    } else if (room.engine && room.status !== "lobby") {
      if (message.type === "input") room.engine.setInput(session.id, message.input, now);
      else if (message.type === "fire") room.engine.fire(session.id, now);
      else if (message.type === "reload") room.engine.reload(session.id, now);
      else if (message.type === "weapon") { session.weapon = message.weapon; room.engine.switchWeapon(session.id, message.weapon); }
      else if (message.type === "ping") send(socket, { type: "pong", sentAt: message.sentAt, serverTime: now });
    } else if (message.type === "ping") send(socket, { type: "pong", sentAt: message.sentAt, serverTime: now });
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    sessions.delete(socket);
    removeSessionFromRoom(session);
    ipConnections.set(ip, Math.max(0, (ipConnections.get(ip) ?? 1) - 1));
    const wallet = normalizeWallet(session.awardPlayerId);
    if (wallet) walletConnections.set(wallet, Math.max(0, (walletConnections.get(wallet) ?? 1) - 1));
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

let lastTick = Date.now();
let snapshotCounter = 0;
let voiceCounter = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(.1, (now - lastTick) / 1_000);
  lastTick = now;
  snapshotCounter += 1;
  voiceCounter += 1;
  for (const room of rooms) {
    const engine = room.engine;
    if (!engine || room.status === "lobby") continue;
    engine.tick(dt, now);
    if (room.mode === "pvp" && voiceCounter % Math.max(1, Math.floor(TICK_RATE / VOICE_TOPOLOGY_RATE)) === 0) sendVoiceTopology(room);
    if (snapshotCounter % Math.max(1, Math.floor(TICK_RATE / SNAPSHOT_RATE)) === 0) {
      for (const session of room.sessions) send(session.socket, { type: "snapshot", snapshot: engine.snapshotFor(session.id, now) });
    }
    if (now < engine.endsAt) continue;
    if (room.status === "playing") {
      room.status = "ending";
      room.resetAt = now + 5_000;
      room.audit.record("round-ended", { eventHash: room.audit.hash() }, now);
      issueAwards(room, now);
    }
    if (now < room.resetAt) continue;
    if (room.mode === "training") {
      startEngine(room, now);
      for (const session of room.sessions) {
        const player = room.engine!.players.get(session.id)!;
        send(session.socket, { type: "round", matchId: room.engine!.matchId, mapId: room.mapId, spawnYaw: player.yaw });
      }
    } else {
      void room.audit.flush();
      room.engine = null;
      room.status = "lobby";
      room.resetAt = 0;
      for (const session of room.sessions) { session.ready = false; session.awarded = false; }
      room.audit = new MatchAudit(room.id);
      room.audit.record("lobby-opened", { mapId: room.mapId }, now);
      broadcastLobby(room);
    }
  }
}, 1_000 / TICK_RATE).unref();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Dropzone authoritative server listening on ws://localhost:${PORT}`);
  console.log(`Award verifier public key: ${signer.publicKey}`);
});

async function shutdown(): Promise<void> {
  sockets.close();
  await Promise.all([...rooms].map((room) => room.audit.flush()));
  httpServer.close(() => process.exit(0));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
