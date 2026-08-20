import { isMapId, type MapId } from "./map";

export type WeaponId = "rifle" | "sniper" | "smg";
export type GameMode = "training" | "pvp";

export interface Vec3 { x: number; y: number; z: number }

export interface InputState {
  seq: number;
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  position: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  weapon: WeaponId;
  ammo: number;
  reserve: number;
  reloading: boolean;
  kills: number;
  deaths: number;
  score: number;
  bot: boolean;
  headshots: number;
  visible?: boolean;
}

export interface KillFeedItem {
  id: number;
  attacker: string;
  victim: string;
  weapon: WeaponId;
  headshot: boolean;
}

export interface MatchState {
  id: string;
  mapId: MapId;
  phase: "playing" | "ended";
  startedAt: number;
  endsAt: number;
  remainingMs: number;
}

export interface Snapshot {
  serverTime: number;
  tick: number;
  match: MatchState;
  players: PlayerSnapshot[];
  feed: KillFeedItem[];
}

export interface AwardClaim {
  matchId: string;
  playerId: string;
  points: number;
  kills: number;
  headshots: number;
  issuedAt: number;
  nonce: string;
  eventHash: string;
}

export interface SignedAwardClaim {
  claim: AwardClaim;
  signature: string;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  voiceEnabled: boolean;
}

export type VoiceSignal =
  | { kind: "description"; description: { type: "offer" | "answer"; sdp: string } }
  | { kind: "candidate"; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null } };

export interface LobbyState {
  roomId: string;
  mapId: MapId;
  players: LobbyPlayer[];
  readyCount: number;
  requiredReady: number;
  minimumPlayers: number;
}

export type ClientMessage =
  | { type: "join"; name: string; weapon: WeaponId; mapId: MapId; mode: GameMode; botCount: number }
  | { type: "ready"; ready: boolean }
  | { type: "voiceState"; enabled: boolean }
  | { type: "voiceSignal"; toPlayerId: string; signal: VoiceSignal }
  | { type: "identity"; playerId: string; signature?: string; evidence?: unknown }
  | { type: "input"; input: InputState }
  | { type: "fire" }
  | { type: "reload" }
  | { type: "weapon"; weapon: WeaponId }
  | { type: "ping"; sentAt: number };

export type ServerMessage =
  | { type: "welcome"; playerId: string; matchId: string; mapId: MapId; mode: GameMode; phase: "lobby" | "playing"; tickRate: number; awardPublicKey: string; spawnYaw: number; authChallenge: string; authExpiresAt: number }
  | { type: "lobby"; lobby: LobbyState }
  | { type: "matchStart"; matchId: string; mapId: MapId; spawnYaw: number }
  | { type: "voiceTopology"; peerIds: string[]; proximityRadius: number | null }
  | { type: "voiceSignal"; fromPlayerId: string; signal: VoiceSignal }
  | { type: "round"; matchId: string; mapId: MapId; spawnYaw: number }
  | { type: "respawn"; playerId: string; spawnYaw: number }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "weaponFire"; shooterId: string; weapon: WeaponId }
  | { type: "damage"; attackerId: string; sourcePosition: Vec3; damage: number; health: number; headshot: boolean; killed: boolean }
  | { type: "shot"; shooterId: string; hitId: string | null; victimName: string | null; headshot: boolean; damage: number; killed: boolean }
  | { type: "award"; award: SignedAwardClaim }
  | { type: "pong"; sentAt: number; serverTime: number }
  | { type: "error"; message: string };

export function isWeaponId(value: unknown): value is WeaponId {
  return value === "rifle" || value === "sniper" || value === "smg";
}

function parseVoiceSignal(value: unknown): VoiceSignal | null {
  if (!value || typeof value !== "object") return null;
  const signal = value as Record<string, unknown>;
  if (signal.kind === "description" && signal.description && typeof signal.description === "object") {
    const description = signal.description as Record<string, unknown>;
    if ((description.type === "offer" || description.type === "answer") && typeof description.sdp === "string" && description.sdp.length > 0 && description.sdp.length <= 10_000) {
      return { kind: "description", description: { type: description.type, sdp: description.sdp } };
    }
  }
  if (signal.kind === "candidate" && signal.candidate && typeof signal.candidate === "object") {
    const candidate = signal.candidate as Record<string, unknown>;
    const sdpMidValid = candidate.sdpMid === null || typeof candidate.sdpMid === "string";
    const lineValid = candidate.sdpMLineIndex === null || (Number.isSafeInteger(candidate.sdpMLineIndex) && (candidate.sdpMLineIndex as number) >= 0);
    const fragmentValid = candidate.usernameFragment === undefined || candidate.usernameFragment === null || typeof candidate.usernameFragment === "string";
    if (typeof candidate.candidate === "string" && candidate.candidate.length <= 2_048 && sdpMidValid && lineValid && fragmentValid) {
      return { kind: "candidate", candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid as string | null, sdpMLineIndex: candidate.sdpMLineIndex as number | null, ...(candidate.usernameFragment === undefined ? {} : { usernameFragment: candidate.usernameFragment as string | null }) } };
    }
  }
  return null;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.type === "join" && typeof data.name === "string" && isWeaponId(data.weapon) && isMapId(data.mapId) && (data.mode === "training" || data.mode === "pvp") && Number.isSafeInteger(data.botCount)) {
    const botCount = data.botCount as number;
    if ((data.mode === "training" && (botCount < 1 || botCount > 7)) || (data.mode === "pvp" && botCount !== 0)) return null;
    return { type: "join", name: data.name.slice(0, 16), weapon: data.weapon, mapId: data.mapId, mode: data.mode, botCount };
  }
  if (data.type === "ready" && typeof data.ready === "boolean") return { type: "ready", ready: data.ready };
  if (data.type === "voiceState" && typeof data.enabled === "boolean") return { type: "voiceState", enabled: data.enabled };
  if (data.type === "voiceSignal" && typeof data.toPlayerId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(data.toPlayerId)) {
    let serialized: string;
    try { serialized = JSON.stringify(data.signal); } catch { return null; }
    if (new TextEncoder().encode(serialized).length > 12_000) return null;
    const signal = parseVoiceSignal(data.signal);
    return signal ? { type: "voiceSignal", toPlayerId: data.toPlayerId, signal } : null;
  }
  if (data.type === "identity" && typeof data.playerId === "string" && /^[a-zA-Z0-9x_-]{1,80}$/.test(data.playerId)) {
    if (data.signature !== undefined && (typeof data.signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(data.signature))) return null;
    return { type: "identity", playerId: data.playerId, ...(typeof data.signature === "string" ? { signature: data.signature } : {}), ...(data.evidence === undefined ? {} : { evidence: data.evidence }) };
  }
  if (data.type === "input" && data.input && typeof data.input === "object") {
    const i = data.input as Record<string, unknown>;
    if ([i.seq, i.forward, i.strafe, i.yaw, i.pitch].every((value) => typeof value === "number" && Number.isFinite(value))) {
      return {
        type: "input",
        input: {
          seq: Math.max(0, Math.floor(i.seq as number)),
          forward: Math.max(-1, Math.min(1, i.forward as number)),
          strafe: Math.max(-1, Math.min(1, i.strafe as number)),
          yaw: Math.max(-Math.PI * 100, Math.min(Math.PI * 100, i.yaw as number)),
          pitch: Math.max(-1.45, Math.min(1.45, i.pitch as number)),
          jump: i.jump === true,
          sprint: i.sprint === true,
        },
      };
    }
  }
  if (data.type === "fire" || data.type === "reload") return { type: data.type };
  if (data.type === "weapon" && isWeaponId(data.weapon)) return { type: "weapon", weapon: data.weapon };
  if (data.type === "ping" && typeof data.sentAt === "number" && Number.isFinite(data.sentAt)) return { type: "ping", sentAt: data.sentAt };
  return null;
}
