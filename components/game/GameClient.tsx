"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { collidesAt, isStandingOnSurface, resolveVerticalMotion } from "@/packages/shared/src/collision";
import { MAPS, MAP_IDS, type MapId } from "@/packages/shared/src/map";
import { randomCallsign } from "@/packages/shared/src/names";
import { GRAVITY, JUMP_SPEED, MOVE_ACCELERATION, MOVE_SPEED, SPRINT_SPEED } from "@/packages/shared/src/movement";
import { damageIndicatorAngle, hasVoiceActivity, nextOpponentHealthFraction, shouldSnapOpponentPosition } from "@/packages/shared/src/presentation";
import type { GameMode, LobbyState, ServerMessage, Snapshot, WeaponId } from "@/packages/shared/src/protocol";
import { WEAPONS } from "@/packages/shared/src/weapons";
import { claimVerifiedAward, createDropzoneRoom, type DropzoneRoomSession } from "@/packages/flaunch/src/room";

type Phase = "lobby" | "connecting" | "matchmaking" | "playing";
type HitFeedback = "hit" | "kill" | null;
interface KillNotice { id: number; victim: string; headshot: boolean; points: number }
interface DamageNotice { id: number; angle: number; damage: number; headshot: boolean }
interface VoiceMeter { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; samples: Uint8Array<ArrayBuffer>; lastSpokeAt: number }

function socketUrl(): string {
  const configured = process.env.NEXT_PUBLIC_GAME_SERVER_URL;
  if (configured) return configured;
  if (typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) return "ws://127.0.0.1:8081";
  return typeof location === "undefined" ? "ws://localhost:8081" : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/game-socket`;
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function voiceIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  const stunUrl = process.env.NEXT_PUBLIC_VOICE_STUN_URL;
  const turnUrl = process.env.NEXT_PUBLIC_VOICE_TURN_URL;
  if (stunUrl) servers.push({ urls: stunUrl });
  if (turnUrl) servers.push({ urls: turnUrl, username: process.env.NEXT_PUBLIC_VOICE_TURN_USERNAME, credential: process.env.NEXT_PUBLIC_VOICE_TURN_CREDENTIAL });
  return servers;
}

function boxPart(width: number, height: number, depth: number, x: number, y: number, z: number, rotationX = 0, rotationY = 0, rotationZ = 0): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.rotateX(rotationX); geometry.rotateY(rotationY); geometry.rotateZ(rotationZ); geometry.translate(x, y, z);
  return geometry;
}

function cylinderPart(radiusTop: number, radiusBottom: number, height: number, segments: number, x: number, y: number, z: number, rotationX = 0, rotationY = 0, rotationZ = 0): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
  geometry.rotateX(rotationX); geometry.rotateY(rotationY); geometry.rotateZ(rotationZ); geometry.translate(x, y, z);
  return geometry;
}

function mergedParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const merged = mergeGeometries(normalized, false);
  normalized.forEach((part, index) => { if (part !== parts[index]) part.dispose(); });
  parts.forEach((part) => part.dispose());
  if (!merged) throw new Error("Unable to build low-poly render mesh");
  return merged;
}

interface VisualBox { x: number; y: number; z: number; width: number; height: number; depth: number; rotationX?: number; rotationY?: number; rotationZ?: number }

function instancedBoxes(parts: VisualBox[], material: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, parts.length);
  const matrix = new THREE.Matrix4(); const position = new THREE.Vector3(); const rotation = new THREE.Quaternion(); const scale = new THREE.Vector3(); const euler = new THREE.Euler();
  parts.forEach((part, index) => {
    position.set(part.x, part.y, part.z); euler.set(part.rotationX ?? 0, part.rotationY ?? 0, part.rotationZ ?? 0); rotation.setFromEuler(euler); scale.set(part.width, part.height, part.depth); matrix.compose(position, rotation, scale); mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function playerNameplate(name: string, bot: boolean): { sprite: THREE.Sprite; material: THREE.SpriteMaterial } {
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#0e120de6"; context.fillRect(2, 6, 252, 52);
  context.strokeStyle = bot ? "#ff6037" : "#d9ff43"; context.lineWidth = 3; context.strokeRect(3.5, 7.5, 249, 49);
  context.fillStyle = bot ? "#ffb19c" : "#efffc0"; context.font = "900 23px monospace"; context.textAlign = "center"; context.textBaseline = "middle";
  const label = `${name.toUpperCase()}${bot ? " · BOT" : ""}`; context.fillText(label.length > 19 ? `${label.slice(0, 18)}…` : label, 128, 33, 226);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(material); sprite.position.y = .29; sprite.scale.set(2.05, .51, 1); sprite.renderOrder = 22;
  return { sprite, material };
}

export function GameClient() {
  const [phase, setPhase] = useState<Phase>("lobby");
  const [name, setName] = useState("ROOKIE");
  const [weapon, setWeapon] = useState<WeaponId>("rifle");
  const [gameMode, setGameMode] = useState<GameMode>("training");
  const [botCount, setBotCount] = useState(3);
  const [selectedMapId, setSelectedMapId] = useState<MapId>("foundry");
  const [mapId, setMapId] = useState<MapId>("foundry");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState("OFFLINE");
  const [playerId, setPlayerId] = useState("");
  const [ping, setPing] = useState(0);
  const [hitMarker, setHitMarker] = useState<HitFeedback>(null);
  const [killNotice, setKillNotice] = useState<KillNotice | null>(null);
  const [damageNotice, setDamageNotice] = useState<DamageNotice | null>(null);
  const [awardState, setAwardState] = useState("PENDING MATCH RESULT");
  const [pvpLobby, setPvpLobby] = useState<LobbyState | null>(null);
  const [voiceOptIn, setVoiceOptIn] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("MIC OFF");
  const [speakingPlayerIds, setSpeakingPlayerIds] = useState<Set<string>>(() => new Set());
  const mountRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const roomSessionRef = useRef<DropzoneRoomSession | null>(null);
  const latestRef = useRef<Snapshot | null>(null);
  const playerIdRef = useRef("");
  const keysRef = useRef(new Set<string>());
  const aimRef = useRef({ yaw: 0, pitch: 0, seq: 0 });
  const firingRef = useRef(false);
  const weaponRef = useRef<WeaponId>("rifle");
  const shotAtRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const lastHudUpdateRef = useRef(0);
  const hitTimerRef = useRef<number | null>(null);
  const killTimerRef = useRef<number | null>(null);
  const damageTimerRef = useRef<number | null>(null);
  const killNoticeIdRef = useRef(0);
  const damageNoticeIdRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const shotNoiseRef = useRef<AudioBuffer | null>(null);
  const lastLocalHealthRef = useRef<number | null>(null);
  const lastDamageEventAtRef = useRef(-Infinity);
  const remoteShotAtRef = useRef(new Map<string, number>());
  const lastRemoteAudioAtRef = useRef(-Infinity);
  const localVoiceStreamRef = useRef<MediaStream | null>(null);
  const voicePeersRef = useRef(new Map<string, RTCPeerConnection>());
  const voiceAudioRef = useRef(new Map<string, HTMLAudioElement>());
  const voiceIceQueueRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const voiceTopologyRef = useRef(new Set<string>());
  const voiceMeterContextRef = useRef<AudioContext | null>(null);
  const voiceMetersRef = useRef(new Map<string, VoiceMeter>());
  const callsignAssignedRef = useRef(false);

  useEffect(() => {
    if (callsignAssignedRef.current) return;
    callsignAssignedRef.current = true;
    setName(randomCallsign());
  }, []);

  const me = snapshot?.players.find((player) => player.id === playerId) ?? null;
  const selfHealth = me?.health ?? 100;
  const healthState = selfHealth <= 25 ? "critical" : selfHealth <= 55 ? "low" : "healthy";
  const leaders = useMemo(() => [...(snapshot?.players ?? [])].sort((a, b) => b.score - a.score || a.deaths - b.deaths).slice(0, 6), [snapshot]);
  const send = useCallback((message: object) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message)); }, []);
  const detachVoiceMeter = useCallback((meterPlayerId: string) => {
    const meter = voiceMetersRef.current.get(meterPlayerId);
    if (!meter) return;
    meter.source.disconnect(); meter.analyser.disconnect(); voiceMetersRef.current.delete(meterPlayerId);
  }, []);
  const attachVoiceMeter = useCallback((meterPlayerId: string, stream: MediaStream) => {
    if (!meterPlayerId || stream.getAudioTracks().length === 0) return;
    detachVoiceMeter(meterPlayerId);
    try {
      voiceMeterContextRef.current ??= new AudioContext({ latencyHint: "interactive" });
      const context = voiceMeterContextRef.current;
      if (context.state === "suspended") void context.resume();
      const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = .55; source.connect(analyser);
      voiceMetersRef.current.set(meterPlayerId, { source, analyser, samples: new Uint8Array(analyser.fftSize), lastSpokeAt: -Infinity });
    } catch { /* Voice remains audible if metering is unavailable. */ }
  }, [detachVoiceMeter]);
  const closeVoicePeer = useCallback((peerId: string) => {
    const peer = voicePeersRef.current.get(peerId);
    if (peer) { peer.ontrack = null; peer.onicecandidate = null; peer.close(); voicePeersRef.current.delete(peerId); }
    const audio = voiceAudioRef.current.get(peerId);
    if (audio) { audio.pause(); audio.srcObject = null; audio.remove(); voiceAudioRef.current.delete(peerId); }
    detachVoiceMeter(peerId);
    voiceIceQueueRef.current.delete(peerId);
  }, [detachVoiceMeter]);
  const closeAllVoicePeers = useCallback(() => {
    for (const peerId of [...voicePeersRef.current.keys()]) closeVoicePeer(peerId);
    voiceTopologyRef.current.clear();
  }, [closeVoicePeer]);
  const stopMicrophone = useCallback((notifyServer = true) => {
    if (notifyServer) send({ type: "voiceState", enabled: false });
    closeAllVoicePeers();
    detachVoiceMeter(playerIdRef.current);
    localVoiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    localVoiceStreamRef.current = null;
    setVoiceActive(false); setVoiceStatus("MIC OFF");
  }, [closeAllVoicePeers, detachVoiceMeter, send]);
  const requestMicrophone = useCallback(async (): Promise<boolean> => {
    if (localVoiceStreamRef.current?.active) { setVoiceActive(true); setVoiceStatus("VOICE LIVE"); return true; }
    if (!navigator.mediaDevices?.getUserMedia) { setVoiceStatus("MIC UNSUPPORTED"); return false; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => {
        if (localVoiceStreamRef.current !== stream) return;
        localVoiceStreamRef.current = null; closeAllVoicePeers(); detachVoiceMeter(playerIdRef.current); send({ type: "voiceState", enabled: false });
        setVoiceActive(false); setVoiceStatus("MIC DISCONNECTED");
      }, { once: true });
      localVoiceStreamRef.current = stream; attachVoiceMeter(playerIdRef.current, stream); setVoiceActive(true); setVoiceStatus("VOICE LIVE"); return true;
    } catch {
      setVoiceOptIn(false); setVoiceActive(false); setVoiceStatus("MIC PERMISSION DENIED"); return false;
    }
  }, [attachVoiceMeter, closeAllVoicePeers, detachVoiceMeter, send]);
  const createVoicePeer = useCallback((peerId: string, initiate: boolean): RTCPeerConnection | null => {
    const existing = voicePeersRef.current.get(peerId);
    if (existing) return existing;
    const stream = localVoiceStreamRef.current;
    if (!stream) return null;
    const peer = new RTCPeerConnection({ iceServers: voiceIceServers() });
    voicePeersRef.current.set(peerId, peer);
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    peer.onicecandidate = (event) => {
      if (event.candidate) send({ type: "voiceSignal", toPlayerId: peerId, signal: { kind: "candidate", candidate: event.candidate.toJSON() } });
    };
    peer.ontrack = (event) => {
      let audio = voiceAudioRef.current.get(peerId);
      if (!audio) { audio = new Audio(); audio.autoplay = true; voiceAudioRef.current.set(peerId, audio); }
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      audio.srcObject = remoteStream; attachVoiceMeter(peerId, remoteStream);
      void audio.play().catch(() => undefined);
    };
    peer.onconnectionstatechange = () => { if (peer.connectionState === "failed" || peer.connectionState === "closed") closeVoicePeer(peerId); };
    if (initiate) void (async () => {
      try {
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
        if (peer.localDescription) send({ type: "voiceSignal", toPlayerId: peerId, signal: { kind: "description", description: { type: "offer", sdp: peer.localDescription.sdp } } });
      } catch { closeVoicePeer(peerId); }
    })();
    return peer;
  }, [attachVoiceMeter, closeVoicePeer, send]);
  const handleVoiceTopology = useCallback((peerIds: string[]) => {
    const allowed = new Set(peerIds);
    voiceTopologyRef.current = allowed;
    for (const peerId of [...voicePeersRef.current.keys()]) if (!allowed.has(peerId)) closeVoicePeer(peerId);
    if (!localVoiceStreamRef.current) return;
    for (const peerId of allowed) if (!voicePeersRef.current.has(peerId) && playerIdRef.current < peerId) createVoicePeer(peerId, true);
  }, [closeVoicePeer, createVoicePeer]);
  const handleVoiceSignal = useCallback(async (fromPlayerId: string, signal: Extract<ServerMessage, { type: "voiceSignal" }>["signal"]) => {
    if (!localVoiceStreamRef.current || !voiceTopologyRef.current.has(fromPlayerId)) return;
    const peer = createVoicePeer(fromPlayerId, false);
    if (!peer) return;
    try {
      if (signal.kind === "candidate") {
        if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
        else voiceIceQueueRef.current.set(fromPlayerId, [...(voiceIceQueueRef.current.get(fromPlayerId) ?? []), signal.candidate]);
        return;
      }
      await peer.setRemoteDescription(signal.description);
      for (const candidate of voiceIceQueueRef.current.get(fromPlayerId) ?? []) await peer.addIceCandidate(candidate);
      voiceIceQueueRef.current.delete(fromPlayerId);
      if (signal.description.type === "offer") {
        const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        if (peer.localDescription) send({ type: "voiceSignal", toPlayerId: fromPlayerId, signal: { kind: "description", description: { type: "answer", sdp: peer.localDescription.sdp } } });
      }
    } catch { closeVoicePeer(fromPlayerId); }
  }, [closeVoicePeer, createVoicePeer, send]);
  const toggleVoice = useCallback(async () => {
    if (voiceActive) { setVoiceOptIn(false); stopMicrophone(true); return; }
    setVoiceOptIn(true);
    if (await requestMicrophone()) send({ type: "voiceState", enabled: true });
  }, [requestMicrophone, send, stopMicrophone, voiceActive]);
  const primeAudio = useCallback(() => {
    try {
      audioContextRef.current ??= new AudioContext({ latencyHint: "interactive" });
      const context = audioContextRef.current;
      if (!shotNoiseRef.current) {
        const buffer = context.createBuffer(1, Math.floor(context.sampleRate * .16), context.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
        shotNoiseRef.current = buffer;
      }
      if (context.state === "suspended") void context.resume();
    } catch { /* Visual feedback remains available if audio is blocked. */ }
  }, []);
  const playToneCue = useCallback((frequency: number, duration: number, volume: number, type: OscillatorType = "sine", delay = 0) => {
    primeAudio();
    const context = audioContextRef.current;
    if (!context) return;
    const at = context.currentTime + delay;
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(volume, at + .008); gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(at); oscillator.stop(at + duration + .01);
  }, [primeAudio]);
  const playShotCue = useCallback((activeWeapon: WeaponId) => {
    primeAudio();
    const context = audioContextRef.current; const noiseBuffer = shotNoiseRef.current;
    if (!context || !noiseBuffer) return;
    const profile = activeWeapon === "sniper"
      ? { duration: .15, volume: .16, rate: .72, cutoff: 1_100, thump: 58 }
      : activeWeapon === "smg"
        ? { duration: .055, volume: .065, rate: 1.38, cutoff: 2_300, thump: 130 }
        : { duration: .085, volume: .09, rate: 1, cutoff: 1_750, thump: 88 };
    const at = context.currentTime;
    const source = context.createBufferSource(); const filter = context.createBiquadFilter(); const gain = context.createGain();
    source.buffer = noiseBuffer; source.playbackRate.setValueAtTime(profile.rate, at);
    filter.type = "lowpass"; filter.frequency.setValueAtTime(profile.cutoff, at);
    gain.gain.setValueAtTime(profile.volume, at); gain.gain.exponentialRampToValueAtTime(.0001, at + profile.duration);
    source.connect(filter); filter.connect(gain); gain.connect(context.destination); source.start(at); source.stop(at + profile.duration);
    playToneCue(profile.thump, profile.duration, profile.volume * .55, "square");
  }, [playToneCue, primeAudio]);
  const playRemoteShotCue = useCallback((activeWeapon: WeaponId, distance: number) => {
    const attenuation = THREE.MathUtils.clamp(1 - distance / 75, .12, .72);
    const profile = activeWeapon === "sniper"
      ? { frequency: 92, duration: .12, volume: .052 }
      : activeWeapon === "smg"
        ? { frequency: 180, duration: .04, volume: .022 }
        : { frequency: 125, duration: .065, volume: .032 };
    playToneCue(profile.frequency, profile.duration, profile.volume * attenuation, "square");
  }, [playToneCue]);
  const playHitCue = useCallback((headshot: boolean) => {
    playToneCue(headshot ? 1_050 : 760, .06, .032, "sine");
    if (headshot) playToneCue(1_480, .07, .025, "sine", .035);
  }, [playToneCue]);
  const playReloadCue = useCallback(() => {
    playToneCue(230, .055, .022, "square"); playToneCue(340, .065, .018, "square", .09);
  }, [playToneCue]);
  const playSwitchCue = useCallback(() => { playToneCue(520, .045, .018, "triangle"); }, [playToneCue]);
  const playRespawnCue = useCallback(() => {
    playToneCue(330, .11, .022, "sine"); playToneCue(495, .14, .025, "sine", .08);
  }, [playToneCue]);
  const playDamageCue = useCallback(() => { playToneCue(92, .16, .04, "sawtooth"); }, [playToneCue]);
  const playDeathCue = useCallback(() => {
    playToneCue(145, .22, .045, "sawtooth"); playToneCue(72, .3, .04, "sawtooth", .12);
  }, [playToneCue]);
  const playEliminationCue = useCallback((headshot: boolean) => {
    primeAudio();
    const context = audioContextRef.current;
    if (!context) return;
    const start = context.currentTime;
    const frequencies = headshot ? [620, 930, 1240] : [440, 660];
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator(); const gain = context.createGain();
      const at = start + index * .055;
      oscillator.type = "square"; oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(.045, at + .012); gain.gain.exponentialRampToValueAtTime(.0001, at + .11);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(at); oscillator.stop(at + .12);
    });
  }, [primeAudio]);

  const deploy = useCallback(async () => {
    if (phase !== "lobby") return;
    if (gameMode === "pvp" && voiceOptIn) await requestMicrophone();
    stoppedRef.current = false;
    setPhase("connecting"); setConnection("CONNECTING");
    const connect = () => {
      if (stoppedRef.current) return;
      const socket = new WebSocket(socketUrl()); socketRef.current = socket;
      let admitted = false;
      socket.onopen = () => socket.send(JSON.stringify({ type: "join", name, weapon: weaponRef.current, mapId: selectedMapId, mode: gameMode, botCount: gameMode === "training" ? botCount : 0 }));
      socket.onmessage = async (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "welcome") {
          admitted = true;
          playerIdRef.current = message.playerId; aimRef.current.yaw = message.spawnYaw; aimRef.current.pitch = 0; setMapId(message.mapId); setPlayerId(message.playerId); setConnection("LIVE"); setPhase(message.phase === "lobby" ? "matchmaking" : "playing");
          if (message.mode === "training") { closeAllVoicePeers(); setAwardState("TRAINING · REWARDS DISABLED"); }
          else try {
              if (localVoiceStreamRef.current) { attachVoiceMeter(message.playerId, localVoiceStreamRef.current); send({ type: "voiceState", enabled: true }); setVoiceActive(true); setVoiceStatus("VOICE LIVE"); }
              roomSessionRef.current?.dispose();
              const roomSession = await createDropzoneRoom({ playerId: message.playerId, serverPublicKey: message.awardPublicKey, parentOrigin: process.env.NEXT_PUBLIC_FLAUNCH_PARENT_ORIGIN });
              if (stoppedRef.current || socket.readyState !== WebSocket.OPEN) { roomSession.dispose(); return; }
              roomSessionRef.current = roomSession;
              const proof = await roomSession.createAdmissionProof(message.authChallenge);
              send({ type: "identity", playerId: roomSession.playerId, ...proof });
            } catch { setAwardState("FLAUNCH GATE UNAVAILABLE"); }
        } else if (message.type === "lobby") {
          setPvpLobby(message.lobby); setMapId(message.lobby.mapId); setSnapshot(null); latestRef.current = null; lastLocalHealthRef.current = null; setPhase("matchmaking");
        } else if (message.type === "matchStart") {
          aimRef.current.yaw = message.spawnYaw; aimRef.current.pitch = 0; setMapId(message.mapId); setPvpLobby(null); setAwardState("PVP RESULT PENDING"); setPhase("playing");
        } else if (message.type === "round") { aimRef.current.yaw = message.spawnYaw; aimRef.current.pitch = 0; setMapId(message.mapId); playRespawnCue(); setAwardState("TRAINING · NEW ROUND"); }
        else if (message.type === "respawn" && message.playerId === playerIdRef.current) { aimRef.current.yaw = message.spawnYaw; aimRef.current.pitch = 0; playRespawnCue(); }
        else if (message.type === "snapshot") {
          const previousPhase = latestRef.current?.match.phase;
          latestRef.current = message.snapshot;
          const localPlayer = message.snapshot.players.find((player) => player.id === playerIdRef.current);
          if (localPlayer) {
            const previousHealth = lastLocalHealthRef.current;
            if (previousHealth !== null && localPlayer.health < previousHealth && performance.now() - lastDamageEventAtRef.current > 250) {
              if (localPlayer.alive) playDamageCue(); else playDeathCue();
            }
            lastLocalHealthRef.current = localPlayer.health;
          }
          const now = performance.now();
          if (now - lastHudUpdateRef.current >= 100 || previousPhase !== message.snapshot.match.phase) {
            lastHudUpdateRef.current = now;
            setSnapshot(message.snapshot);
          }
        }
        else if (message.type === "weaponFire" && message.shooterId !== playerIdRef.current) {
          const now = performance.now();
          remoteShotAtRef.current.set(message.shooterId, now);
          const current = latestRef.current;
          const shooter = current?.players.find((player) => player.id === message.shooterId);
          const localPlayer = current?.players.find((player) => player.id === playerIdRef.current);
          if (shooter?.alive && shooter.visible !== false && localPlayer && now - lastRemoteAudioAtRef.current >= 32) {
            lastRemoteAudioAtRef.current = now;
            playRemoteShotCue(message.weapon, Math.hypot(shooter.position.x - localPlayer.position.x, shooter.position.y - localPlayer.position.y, shooter.position.z - localPlayer.position.z));
          }
        }
        else if (message.type === "damage") {
          const current = latestRef.current;
          const localPlayer = current?.players.find((player) => player.id === playerIdRef.current);
          const angle = damageIndicatorAngle(message.sourcePosition, localPlayer?.position ?? { x: 0, y: 0, z: 0 }, aimRef.current.yaw);
          const now = performance.now();
          lastDamageEventAtRef.current = now;
          lastLocalHealthRef.current = message.health;
          if (message.killed) playDeathCue(); else playDamageCue();
          const id = ++damageNoticeIdRef.current;
          setDamageNotice({ id, angle, damage: message.damage, headshot: message.headshot });
          if (damageTimerRef.current !== null) window.clearTimeout(damageTimerRef.current);
          damageTimerRef.current = window.setTimeout(() => setDamageNotice((notice) => notice?.id === id ? null : notice), message.killed ? 850 : 650);
        }
        else if (message.type === "shot" && message.shooterId === playerIdRef.current) {
          shotAtRef.current = performance.now();
          if (message.hitId) {
            playHitCue(message.headshot);
            if (hitTimerRef.current !== null) window.clearTimeout(hitTimerRef.current);
            setHitMarker(message.killed ? "kill" : "hit");
            hitTimerRef.current = window.setTimeout(() => setHitMarker(null), message.killed ? 260 : 100);
          }
          if (message.killed) {
            const id = ++killNoticeIdRef.current;
            const points = message.headshot ? 150 : 100;
            if (killTimerRef.current !== null) window.clearTimeout(killTimerRef.current);
            setKillNotice({ id, victim: message.victimName ?? "RIVAL", headshot: message.headshot, points });
            killTimerRef.current = window.setTimeout(() => setKillNotice((current) => current?.id === id ? null : current), 1_250);
            playEliminationCue(message.headshot);
          }
        }
        else if (message.type === "voiceTopology") handleVoiceTopology(message.peerIds);
        else if (message.type === "voiceSignal") void handleVoiceSignal(message.fromPlayerId, message.signal);
        else if (message.type === "pong") setPing(Math.max(0, Math.round(performance.now() - message.sentAt)));
        else if (message.type === "award") {
          if (!roomSessionRef.current) { setAwardState("SIGNED RESULT READY"); return; }
          const result = await claimVerifiedAward(roomSessionRef.current.room, message.award);
          setAwardState(result.accepted ? `ƒ ${message.award.claim.points} POINTS VERIFIED` : `CLAIM REFUSED · ${result.refuse}`);
        }
        else if (message.type === "error" && !admitted) {
          stoppedRef.current = true; stopMicrophone(false); setConnection(message.message.toUpperCase()); setPhase("lobby"); socket.close();
        }
      };
      socket.onclose = () => {
        closeAllVoicePeers(); detachVoiceMeter(playerIdRef.current);
        roomSessionRef.current?.dispose(); roomSessionRef.current = null;
        if (stoppedRef.current) return;
        setConnection("RECONNECTING"); if (localVoiceStreamRef.current) setVoiceStatus("VOICE RECONNECTING");
        reconnectTimerRef.current = window.setTimeout(connect, 900);
      };
      socket.onerror = () => setConnection("SERVER UNAVAILABLE");
    };
    connect();
  }, [attachVoiceMeter, botCount, closeAllVoicePeers, detachVoiceMeter, gameMode, handleVoiceSignal, handleVoiceTopology, name, phase, playDamageCue, playDeathCue, playEliminationCue, playHitCue, playRemoteShotCue, playRespawnCue, requestMicrophone, selectedMapId, send, stopMicrophone, voiceOptIn]);

  const leavePvpLobby = useCallback(() => {
    stoppedRef.current = true;
    socketRef.current?.close();
    roomSessionRef.current?.dispose(); roomSessionRef.current = null;
    stopMicrophone(false);
    setPvpLobby(null); setConnection("OFFLINE"); setPhase("lobby"); setAwardState("PENDING MATCH RESULT");
  }, [stopMicrophone]);

  useEffect(() => () => { stoppedRef.current = true; if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current); if (hitTimerRef.current !== null) window.clearTimeout(hitTimerRef.current); if (killTimerRef.current !== null) window.clearTimeout(killTimerRef.current); if (damageTimerRef.current !== null) window.clearTimeout(damageTimerRef.current); remoteShotAtRef.current.clear(); socketRef.current?.close(); roomSessionRef.current?.dispose(); for (const peer of voicePeersRef.current.values()) peer.close(); for (const audio of voiceAudioRef.current.values()) { audio.pause(); audio.srcObject = null; audio.remove(); } for (const meter of voiceMetersRef.current.values()) { meter.source.disconnect(); meter.analyser.disconnect(); } voiceMetersRef.current.clear(); localVoiceStreamRef.current?.getTracks().forEach((track) => track.stop()); const audioContext = audioContextRef.current; audioContextRef.current = null; if (audioContext && audioContext.state !== "closed") void audioContext.close().catch(() => undefined); const meterContext = voiceMeterContextRef.current; voiceMeterContextRef.current = null; if (meterContext && meterContext.state !== "closed") void meterContext.close().catch(() => undefined); }, []);
  useEffect(() => { weaponRef.current = weapon; }, [weapon]);
  useEffect(() => {
    if (phase !== "matchmaking") return;
    const updateSpeaking = () => {
      const now = performance.now(); const next = new Set<string>();
      for (const [meterPlayerId, meter] of voiceMetersRef.current) {
        meter.analyser.getByteTimeDomainData(meter.samples);
        if (hasVoiceActivity(meter.samples)) meter.lastSpokeAt = now;
        if (now - meter.lastSpokeAt < 360) next.add(meterPlayerId);
      }
      setSpeakingPlayerIds((current) => current.size === next.size && [...next].every((id) => current.has(id)) ? current : next);
    };
    const meterTimer = window.setInterval(updateSpeaking, 100);
    return () => window.clearInterval(meterTimer);
  }, [phase]);
  useEffect(() => {
    if (phase !== "playing") return;
    const onKeyDown = (event: KeyboardEvent) => {
      keysRef.current.add(event.code);
      if (event.code === "KeyR" && !event.repeat) { playReloadCue(); send({ type: "reload" }); }
      const next = event.code === "Digit1" ? "rifle" : event.code === "Digit2" ? "sniper" : event.code === "Digit3" ? "smg" : null;
      if (next && next !== weaponRef.current) { playSwitchCue(); setWeapon(next); send({ type: "weapon", weapon: next }); }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.code);
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== mountRef.current) return;
      aimRef.current.yaw -= event.movementX * 0.0021;
      aimRef.current.pitch = Math.max(-1.42, Math.min(1.42, aimRef.current.pitch - event.movementY * 0.0019));
    };
    const onMouseDown = (event: MouseEvent) => { if (event.button === 0 && document.pointerLockElement === mountRef.current) { primeAudio(); firingRef.current = true; } };
    const onMouseUp = (event: MouseEvent) => { if (event.button === 0) firingRef.current = false; };
    window.addEventListener("keydown", onKeyDown); window.addEventListener("keyup", onKeyUp); window.addEventListener("mousemove", onMouseMove); window.addEventListener("mousedown", onMouseDown); window.addEventListener("mouseup", onMouseUp);
    let lastFire = 0;
    const inputTimer = window.setInterval(() => {
      const keys = keysRef.current; const aim = aimRef.current;
      send({ type: "input", input: { seq: ++aim.seq, forward: (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0), strafe: (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0), yaw: aim.yaw, pitch: aim.pitch, jump: keys.has("Space"), sprint: keys.has("ShiftLeft") || keys.has("ShiftRight") } });
      const now = performance.now();
      if (firingRef.current && now - lastFire >= WEAPONS[weaponRef.current].fireIntervalMs) {
        lastFire = now;
        shotAtRef.current = now;
        playShotCue(weaponRef.current);
        send({ type: "fire" });
      }
    }, 1000 / 30);
    const pingTimer = window.setInterval(() => send({ type: "ping", sentAt: performance.now() }), 2000);
    return () => {
      window.clearInterval(inputTimer); window.clearInterval(pingTimer);
      window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mousedown", onMouseDown); window.removeEventListener("mouseup", onMouseUp);
    };
  }, [phase, playReloadCue, playShotCue, playSwitchCue, primeAudio, send]);

  useEffect(() => {
    if (phase !== "playing" || !mountRef.current) return;
    const mount = mountRef.current;
    const arena = MAPS[mapId]; const arenaSize = arena.halfSize * 2;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(arena.skyColor);
    scene.fog = new THREE.FogExp2(arena.skyColor, arena.size === "LARGE" ? 0.009 : arena.size === "MEDIUM" ? 0.012 : 0.016);
    const camera = new THREE.PerspectiveCamera(84, mount.clientWidth / mount.clientHeight, 0.04, arena.halfSize * 5);
    scene.add(camera);
    const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio <= 1.25, powerPreference: "high-performance", preserveDrawingBuffer: new URLSearchParams(window.location.search).has("capture") });
    const maximumPixelRatio = Math.min(1.25, window.devicePixelRatio);
    let pixelRatio = Math.min(1.1, maximumPixelRatio);
    mount.dataset.pixelRatio = pixelRatio.toFixed(2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = arena.theme === "old-town" ? 1.38 : arena.theme === "container-yard" ? 1.08 : 1.18;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute("aria-label", "Dropzone first-person arena");
    mount.appendChild(renderer.domElement);

    const skyLight = arena.theme === "desert-rig" ? 0xffd6a0 : arena.theme === "container-yard" ? 0xd3e8ee : 0x7896c4;
    const groundLight = arena.theme === "desert-rig" ? 0x4d2418 : arena.theme === "container-yard" ? 0x202b2d : 0x17131b;
    scene.add(new THREE.HemisphereLight(skyLight, groundLight, arena.theme === "old-town" ? 2.1 : 2.4));
    const sun = new THREE.DirectionalLight(arena.theme === "desert-rig" ? 0xffb060 : arena.theme === "container-yard" ? 0xe7f3f4 : 0xa9c9ff, arena.theme === "old-town" ? 3.15 : arena.theme === "container-yard" ? 3.2 : 4.8);
    sun.position.set(arena.theme === "desert-rig" ? -24 : 18, arena.theme === "old-town" ? 18 : 30, arena.theme === "container-yard" ? -22 : 12); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
    const shadowExtent = arena.halfSize + 6; sun.shadow.camera.left = -shadowExtent; sun.shadow.camera.right = shadowExtent; sun.shadow.camera.top = shadowExtent; sun.shadow.camera.bottom = -shadowExtent;
    scene.add(sun);
    const rim = new THREE.DirectionalLight(arena.theme === "old-town" ? 0x456fba : 0x9dc6ff, arena.theme === "old-town" ? 1.8 : .9); rim.position.set(18, 9, -18); scene.add(rim);

    const floorCanvas = document.createElement("canvas"); floorCanvas.width = 512; floorCanvas.height = 512;
    const floorCtx = floorCanvas.getContext("2d")!;
    floorCtx.fillStyle = `#${arena.groundColor.toString(16).padStart(6, "0")}`; floorCtx.fillRect(0, 0, 512, 512);
    if (arena.theme === "old-town") {
      floorCtx.strokeStyle = "#756b5d"; floorCtx.lineWidth = 2;
      for (let row = 0; row < 16; row += 1) for (let column = -1; column < 9; column += 1) { const x = column * 64 + (row % 2) * 32; const y = row * 32; floorCtx.strokeRect(x + 1, y + 1, 62, 30); }
      floorCtx.fillStyle = "#6f665934"; for (let index = 0; index < 34; index += 1) floorCtx.fillRect((index * 83) % 500, (index * 47) % 500, 18 + index % 24, 3);
    } else if (arena.theme === "desert-rig") {
      floorCtx.strokeStyle = "#6f472d55"; floorCtx.lineWidth = 2;
      for (let index = 0; index < 42; index += 1) { const x = (index * 79) % 500; const y = (index * 137) % 500; floorCtx.beginPath(); floorCtx.moveTo(x, y); floorCtx.bezierCurveTo(x + 10, y - 4, x + 20, y + 4, x + 34, y); floorCtx.stroke(); }
      floorCtx.fillStyle = "#5d382d66"; for (let index = 0; index < 70; index += 1) { const size = 1 + index % 4; floorCtx.fillRect((index * 43) % 508, (index * 91) % 508, size, size); }
    } else {
      floorCtx.strokeStyle = "#89918c"; floorCtx.lineWidth = 3;
      for (let p = 0; p <= 512; p += 64) { floorCtx.beginPath(); floorCtx.moveTo(p, 0); floorCtx.lineTo(p, 512); floorCtx.stroke(); floorCtx.beginPath(); floorCtx.moveTo(0, p); floorCtx.lineTo(512, p); floorCtx.stroke(); }
      floorCtx.fillStyle = "#e0c548"; for (let p = -512; p < 1024; p += 80) { floorCtx.save(); floorCtx.translate(p, 250); floorCtx.rotate(-Math.PI / 4); floorCtx.fillRect(0, 0, 28, 90); floorCtx.restore(); }
    }
    const floorTexture = new THREE.CanvasTexture(floorCanvas); floorTexture.colorSpace = THREE.SRGBColorSpace; floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping; floorTexture.repeat.set(arenaSize / 11, arenaSize / 11); floorTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(arenaSize, arenaSize), new THREE.MeshStandardMaterial({ map: floorTexture, color: 0xffffff, roughness: .92, metalness: arena.theme === "container-yard" ? .1 : .03 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    const surfaceCanvas = document.createElement("canvas"); surfaceCanvas.width = 256; surfaceCanvas.height = 256;
    const surfaceContext = surfaceCanvas.getContext("2d")!;
    if (arena.theme === "old-town") {
      surfaceContext.fillStyle = "#eee0c7"; surfaceContext.fillRect(0, 0, 256, 256);
      surfaceContext.fillStyle = "#8c786817"; for (let index = 0; index < 180; index += 1) surfaceContext.fillRect((index * 59) % 253, (index * 97) % 253, 2 + index % 4, 2 + index % 3);
      surfaceContext.strokeStyle = "#9d89785c"; surfaceContext.lineWidth = 2;
      for (let index = 0; index < 9; index += 1) { const x = (index * 71) % 240; const y = (index * 43) % 235; surfaceContext.beginPath(); surfaceContext.moveTo(x, y); surfaceContext.lineTo(x + 5, y + 12); surfaceContext.lineTo(x + 1, y + 22); surfaceContext.stroke(); }
    } else if (arena.theme === "desert-rig") {
      surfaceContext.fillStyle = "#a36a43"; surfaceContext.fillRect(0, 0, 256, 256);
      surfaceContext.strokeStyle = "#5e3c2d88"; surfaceContext.lineWidth = 2; for (let panel = 0; panel <= 256; panel += 18) { surfaceContext.beginPath(); surfaceContext.moveTo(panel, 0); surfaceContext.lineTo(panel, 256); surfaceContext.stroke(); }
      surfaceContext.fillStyle = "#572c1d42"; for (let index = 0; index < 48; index += 1) { const size = 3 + index % 8; surfaceContext.fillRect((index * 73) % 250, (index * 113) % 250, size, size * .45); }
    } else {
      surfaceContext.fillStyle = "#dadcd2"; surfaceContext.fillRect(0, 0, 256, 256);
      surfaceContext.strokeStyle = "#7f8785"; surfaceContext.lineWidth = 3;
      for (let panel = 0; panel <= 256; panel += 64) { surfaceContext.beginPath(); surfaceContext.moveTo(panel, 0); surfaceContext.lineTo(panel, 256); surfaceContext.stroke(); surfaceContext.beginPath(); surfaceContext.moveTo(0, panel); surfaceContext.lineTo(256, panel); surfaceContext.stroke(); }
      surfaceContext.fillStyle = "#59615f";
      for (let y = 8; y < 256; y += 64) for (let x = 8; x < 256; x += 64) { surfaceContext.beginPath(); surfaceContext.arc(x, y, 2.2, 0, Math.PI * 2); surfaceContext.fill(); }
    }
    const surfaceTexture = new THREE.CanvasTexture(surfaceCanvas); surfaceTexture.colorSpace = THREE.SRGBColorSpace; surfaceTexture.wrapS = surfaceTexture.wrapT = THREE.RepeatWrapping; surfaceTexture.anisotropy = Math.min(2, renderer.capabilities.getMaxAnisotropy());
    const accentColor = arena.theme === "desert-rig" ? 0xff913d : arena.theme === "container-yard" ? 0xf1cd42 : 0xffba62;
    const accentMaterial = new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: .45, roughness: .48 });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: arena.theme === "old-town" ? 0x403d35 : 0x20261f, metalness: arena.theme === "old-town" ? .08 : .5, roughness: .68 });
    const arenaMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
    const coverBoxes = arena.boxes.filter((box) => box.kind === "cover");
    const stepBoxes = arena.boxes.filter((box) => box.kind === "step" || box.kind === "support");
    const stepMaterial = new THREE.MeshStandardMaterial({ map: surfaceTexture, color: 0x687360, metalness: .2, roughness: .72 });
    const stairInstances = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), stepMaterial, stepBoxes.length);
    const stepMatrix = new THREE.Matrix4();
    for (let index = 0; index < stepBoxes.length; index += 1) { const box = stepBoxes[index]; stepMatrix.makeScale(box.width, box.height, box.depth); stepMatrix.setPosition(box.x, box.y, box.z); stairInstances.setMatrixAt(index, stepMatrix); }
    stairInstances.castShadow = stairInstances.receiveShadow = true; stairInstances.instanceMatrix.needsUpdate = true; scene.add(stairInstances);
    const coverStripes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), accentMaterial, coverBoxes.length);
    const coverMatrix = new THREE.Matrix4();
    let coverIndex = 0;
    const arenaRenderGroups = new Map<string, { material: THREE.MeshStandardMaterial; parts: VisualBox[] }>();
    for (const box of arena.boxes) {
      if (box.kind === "step" || box.kind === "support" || box.kind === "collision") continue;
      const key = `${box.kind}:${box.color}`;
      let material = arenaMaterialCache.get(key);
      if (!material) { material = new THREE.MeshStandardMaterial({ map: surfaceTexture, color: box.color, metalness: arena.theme === "old-town" ? .02 : arena.theme === "container-yard" ? .5 : .26, roughness: arena.theme === "old-town" ? .92 : arena.theme === "desert-rig" ? .78 : .55 }); arenaMaterialCache.set(key, material); }
      const group = arenaRenderGroups.get(key) ?? { material, parts: [] }; group.parts.push(box); arenaRenderGroups.set(key, group);
      if (box.kind === "cover") { coverMatrix.makeScale(box.width + .04, .18, box.depth + .04); coverMatrix.setPosition(box.x, box.y + box.height * .25, box.z); coverStripes.setMatrixAt(coverIndex++, coverMatrix); }
    }
    for (const group of arenaRenderGroups.values()) { const mesh = instancedBoxes(group.parts, group.material); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh); }
    if (coverBoxes.length && arena.theme === "container-yard") { coverStripes.instanceMatrix.needsUpdate = true; scene.add(coverStripes); }
    for (let i = -1; i <= 1; i += 2) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(arenaSize, 2.5, .5), darkMaterial); wall.position.set(0, 1.25, i * arena.halfSize); wall.castShadow = wall.receiveShadow = true; scene.add(wall);
      const side = new THREE.Mesh(new THREE.BoxGeometry(.5, 2.5, arenaSize), darkMaterial); side.position.set(i * arena.halfSize, 1.25, 0); side.castShadow = side.receiveShadow = true; scene.add(side);
      if (arena.theme !== "old-town") { const railA = new THREE.Mesh(new THREE.BoxGeometry(arenaSize, .12, .16), accentMaterial); railA.position.set(0, 2.35, i * (arena.halfSize - .28)); scene.add(railA); const railB = new THREE.Mesh(new THREE.BoxGeometry(.16, .12, arenaSize), accentMaterial); railB.position.set(i * (arena.halfSize - .28), 2.35, 0); scene.add(railB); }
    }
    if (arena.theme === "desert-rig") { const ring = new THREE.Mesh(new THREE.TorusGeometry(arena.halfSize * .275, .08, 8, 48), accentMaterial); ring.rotation.x = Math.PI / 2; ring.position.y = .035; scene.add(ring); }
    const laneMatrix = new THREE.Matrix4(); const lanePosition = new THREE.Vector3(); const laneRotation = new THREE.Quaternion(); const laneScale = new THREE.Vector3(1, 1, 1); const laneEuler = new THREE.Euler();
    if (arena.theme === "desert-rig") { const laneLightCount = 16; const laneLights = new THREE.InstancedMesh(new THREE.BoxGeometry(.16, .05, 1.2), accentMaterial, laneLightCount); for (let i = 0; i < laneLightCount; i += 1) { const angle = i / laneLightCount * Math.PI * 2; lanePosition.set(Math.cos(angle) * arena.halfSize * .55, .04, Math.sin(angle) * arena.halfSize * .55); laneEuler.set(0, -angle, 0); laneRotation.setFromEuler(laneEuler); laneMatrix.compose(lanePosition, laneRotation, laneScale); laneLights.setMatrixAt(i, laneMatrix); } laneLights.instanceMatrix.needsUpdate = true; scene.add(laneLights); }
    const towerOffset = arena.halfSize - 3;
    const towerMatrix = new THREE.Matrix4();
    if (arena.theme === "desert-rig") { const towerLocations = [[-towerOffset, -towerOffset], [towerOffset, -towerOffset], [-towerOffset, towerOffset], [towerOffset, towerOffset]] as const; const towers = new THREE.InstancedMesh(new THREE.CylinderGeometry(.65, .9, 7, 6), darkMaterial, towerLocations.length); const beacons = new THREE.InstancedMesh(new THREE.CylinderGeometry(.72, .72, .18, 12), accentMaterial, towerLocations.length); for (let index = 0; index < towerLocations.length; index += 1) { const [x, z] = towerLocations[index]; towerMatrix.makeTranslation(x, 3.5, z); towers.setMatrixAt(index, towerMatrix); towerMatrix.makeTranslation(x, 6.65, z); beacons.setMatrixAt(index, towerMatrix); } towers.castShadow = true; towers.instanceMatrix.needsUpdate = true; beacons.instanceMatrix.needsUpdate = true; scene.add(towers, beacons); }
    const detailBoxes = arena.boxes.filter((box) => box.kind === "cover" || box.kind === "platform").filter((box) => box.height >= 1);
    const rooftopVents = new THREE.InstancedMesh(new THREE.BoxGeometry(.7, .13, .55), darkMaterial, detailBoxes.length);
    for (let index = 0; index < detailBoxes.length; index += 1) { const box = detailBoxes[index]; towerMatrix.makeRotationY(index % 2 ? Math.PI / 2 : 0); towerMatrix.setPosition(box.x + Math.min(1, box.width * .18), box.y + box.height / 2 + .08, box.z - Math.min(.6, box.depth * .12)); rooftopVents.setMatrixAt(index, towerMatrix); }
    rooftopVents.instanceMatrix.needsUpdate = true; if (arena.theme !== "old-town") scene.add(rooftopVents);
    if (arena.theme === "desert-rig") {
      const scaffoldParts: VisualBox[] = [];
      for (const x of [-3.45, 3.45]) for (const z of [-3.45, 3.45]) scaffoldParts.push({ x, y: 5.9, z, width: .22, height: 6.2, depth: .22 });
      for (const y of [3.25, 5.35, 7.8, 8.95]) {
        scaffoldParts.push({ x: 0, y, z: -3.45, width: 7.1, height: .18, depth: .18 }, { x: 0, y, z: 3.45, width: 7.1, height: .18, depth: .18 });
        scaffoldParts.push({ x: -3.45, y, z: 0, width: .18, height: .18, depth: 7.1 }, { x: 3.45, y, z: 0, width: .18, height: .18, depth: 7.1 });
      }
      scaffoldParts.push(
        { x: 0, y: 5.45, z: -3.48, width: 7.2, height: .12, depth: .12, rotationZ: .55 }, { x: 0, y: 5.45, z: -3.5, width: 7.2, height: .12, depth: .12, rotationZ: -.55 },
        { x: 0, y: 5.45, z: 3.48, width: 7.2, height: .12, depth: .12, rotationZ: .55 }, { x: 0, y: 5.45, z: 3.5, width: 7.2, height: .12, depth: .12, rotationZ: -.55 },
      );
      const scaffold = instancedBoxes(scaffoldParts, darkMaterial); scaffold.castShadow = true; scene.add(scaffold);
      const tankMaterial = new THREE.MeshStandardMaterial({ color: 0x87583c, metalness: .5, roughness: .52 });
      const tanks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.15, 1.15, 3.4, 10), tankMaterial, 4);
      [[-23.5, 2.5, 9], [23.5, 2.5, -9], [-9, 2.5, -23.5], [9, 2.5, 23.5]].forEach(([x, y, z], index) => { towerMatrix.makeTranslation(x, y, z); tanks.setMatrixAt(index, towerMatrix); });
      tanks.castShadow = true; tanks.instanceMatrix.needsUpdate = true; scene.add(tanks);
      const fuelTank = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 4.2, 12), tankMaterial); fuelTank.rotation.x = Math.PI / 2; fuelTank.position.set(-11.5, 1.7, 0); fuelTank.castShadow = true; scene.add(fuelTank);
      const pipeMaterial = new THREE.MeshStandardMaterial({ color: 0x514941, metalness: .72, roughness: .43 });
      const pipeline = new THREE.Mesh(mergedParts([
        cylinderPart(.55, .55, 6.2, 10, -8.2, 1.7, -9.5, 0, 0, Math.PI / 2),
        cylinderPart(.55, .55, 4.8, 10, -5.1, 1.7, -7.1, Math.PI / 2),
        cylinderPart(.55, .55, 1.7, 10, -5.1, .85, -4.7),
        cylinderPart(.7, .7, .18, 10, -5.1, 1.7, -9.5, 0, 0, Math.PI / 2),
        cylinderPart(.7, .7, .18, 10, -5.1, 1.7, -4.7, Math.PI / 2),
      ]), pipeMaterial); pipeline.castShadow = true; scene.add(pipeline);
      const truckMaterial = new THREE.MeshStandardMaterial({ color: 0xa45c31, metalness: .38, roughness: .62 });
      const truckBody = new THREE.Mesh(mergedParts([
        boxPart(1.9, 2.2, 2.45, 14, 1.25, 11.5), boxPart(1.3, .55, 2.3, 12.45, .52, 11.5), boxPart(6.4, .25, 2.4, 11.6, .48, 11.5),
        boxPart(.18, .9, 2.3, 12.6, 1.25, 11.5), boxPart(.18, .9, 2.3, 9.2, 1.25, 11.5),
      ]), truckMaterial); truckBody.castShadow = true; scene.add(truckBody);
      const truckTank = new THREE.Mesh(new THREE.CylinderGeometry(.94, .94, 3.35, 10), tankMaterial); truckTank.rotation.z = Math.PI / 2; truckTank.position.set(10.85, 1.42, 11.5); truckTank.castShadow = true; scene.add(truckTank);
      const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x171310, roughness: .96 });
      const truckWheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(.46, .46, .28, 10), tireMaterial, 6);
      [[13.9, .45, 10.18], [13.9, .45, 12.82], [11.7, .45, 10.18], [11.7, .45, 12.82], [9.5, .45, 10.18], [9.5, .45, 12.82]].forEach(([x, y, z], index) => { towerMatrix.makeRotationX(Math.PI / 2); towerMatrix.setPosition(x, y, z); truckWheels.setMatrixAt(index, towerMatrix); }); truckWheels.instanceMatrix.needsUpdate = true; scene.add(truckWheels);
      const mesaMaterial = new THREE.MeshStandardMaterial({ color: 0x6f3927, roughness: 1 });
      const mesas = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(3, 0), mesaMaterial, 8);
      [[-29, 1, -18], [-27, 2, 13], [28, 1, -15], [30, 2, 17], [-17, 1, 29], [15, 2, 28], [-14, 2, -30], [18, 1, -28]].forEach(([x, y, z], index) => { towerMatrix.makeScale(1 + index % 3 * .4, .8 + index % 2 * .55, 1 + index % 4 * .25); towerMatrix.setPosition(x, y, z); mesas.setMatrixAt(index, towerMatrix); });
      mesas.castShadow = true; mesas.instanceMatrix.needsUpdate = true; scene.add(mesas);
      const barrelMaterial = new THREE.MeshStandardMaterial({ color: 0x5f2922, metalness: .55, roughness: .5 });
      const barrels = new THREE.InstancedMesh(new THREE.CylinderGeometry(.32, .32, .82, 10), barrelMaterial, 10);
      [[-16, .41, 6], [-15.3, .41, 6.2], [-14.6, .41, 6], [16, .41, -6], [15.3, .41, -6.2], [12, .41, 16], [11.3, .41, 16], [-12, .41, -16], [-11.3, .41, -16], [-10.6, .41, -16]].forEach(([x, y, z], index) => { towerMatrix.makeTranslation(x, y, z); barrels.setMatrixAt(index, towerMatrix); });
      barrels.castShadow = true; barrels.instanceMatrix.needsUpdate = true; scene.add(barrels);
      const tires = new THREE.InstancedMesh(new THREE.TorusGeometry(.36, .12, 6, 12), tireMaterial, 6);
      [[-17.2, .4, 5], [-17.2, 1.05, 5], [17.2, .4, -5], [17.2, 1.05, -5], [-9, .4, 16], [9, .4, -16]].forEach(([x, y, z], index) => { towerMatrix.makeRotationY(index % 2 ? .18 : -.12); towerMatrix.setPosition(x, y, z); tires.setMatrixAt(index, towerMatrix); });
      tires.instanceMatrix.needsUpdate = true; scene.add(tires);
      const warningPanels = instancedBoxes([
        { x: -9, y: 2.5, z: -10.04, width: 1.4, height: .72, depth: .06 }, { x: 9, y: 2.2, z: -9.54, width: 1.4, height: .72, depth: .06 },
        { x: -12.01, y: 2.1, z: 0, width: .06, height: .72, depth: 1.4 }, { x: 12.01, y: 2.1, z: 0, width: .06, height: .72, depth: 1.4 },
      ], accentMaterial); scene.add(warningPanels);
    } else if (arena.theme === "container-yard") {
      const ribs: VisualBox[] = [];
      const containers = arena.boxes.filter((box) => box.height >= 2.5 && ((box.width >= 6.8 && box.depth <= 3.2) || (box.depth >= 6.8 && box.width <= 3.2)));
      for (const box of containers) {
        if (box.width > box.depth) for (let index = -3; index <= 3; index += 1) for (const side of [-1, 1]) ribs.push({ x: box.x + index * box.width / 7, y: box.y, z: box.z + side * (box.depth / 2 + .035), width: .1, height: box.height * .82, depth: .07 });
        else for (let index = -3; index <= 3; index += 1) for (const side of [-1, 1]) ribs.push({ x: box.x + side * (box.width / 2 + .035), y: box.y, z: box.z + index * box.depth / 7, width: .07, height: box.height * .82, depth: .1 });
      }
      const ribMaterial = new THREE.MeshStandardMaterial({ color: 0x303936, metalness: .65, roughness: .4 });
      if (ribs.length) scene.add(instancedBoxes(ribs, ribMaterial));
      const gantry = instancedBoxes([
        { x: -28, y: 4.2, z: 27.5, width: .55, height: 8.4, depth: .55 }, { x: 28, y: 4.2, z: 27.5, width: .55, height: 8.4, depth: .55 },
        { x: 0, y: 8.15, z: 27.5, width: 56.5, height: .5, depth: .65 }, { x: 0, y: 7.55, z: 27.5, width: 15, height: .12, depth: 1.1 },
        { x: -28, y: 4.2, z: -27.5, width: .55, height: 8.4, depth: .55 }, { x: 28, y: 4.2, z: -27.5, width: .55, height: 8.4, depth: .55 },
        { x: 0, y: 8.15, z: -27.5, width: 56.5, height: .5, depth: .65 }, { x: 10, y: 7.55, z: -27.5, width: 15, height: .12, depth: 1.1 },
      ], darkMaterial); gantry.castShadow = true; scene.add(gantry);
      const yardMarkings: VisualBox[] = []; for (const z of [-24, -8, 8, 24]) for (let x = -24; x <= 24; x += 8) yardMarkings.push({ x, y: .025, z, width: 3.2, height: .025, depth: .12 }); scene.add(instancedBoxes(yardMarkings, accentMaterial));
      const coneMaterial = new THREE.MeshStandardMaterial({ color: 0xff692e, roughness: .72 });
      const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(.24, .72, 8), coneMaterial, 14);
      [[-11, .36, -24], [-7, .36, -24], [-3, .36, -24], [1, .36, -24], [5, .36, -24], [9, .36, -24], [13, .36, -24], [-25, .36, 7], [-25, .36, 11], [25, .36, -11], [25, .36, -7], [-3, .36, 25], [3, .36, 25], [19, .36, 24]].forEach(([x, y, z], index) => { towerMatrix.makeTranslation(x, y, z); cones.setMatrixAt(index, towerMatrix); });
      cones.instanceMatrix.needsUpdate = true; scene.add(cones);
      const palletParts: VisualBox[] = [];
      for (const [x, z, rotationY] of [[-27, 16, 0], [27, -16, 0], [-12, 27, Math.PI / 2], [12, -27, Math.PI / 2]] as const) {
        for (let slat = -2; slat <= 2; slat += 1) palletParts.push({ x: x + (rotationY ? 0 : slat * .34), y: .11, z: z + (rotationY ? slat * .34 : 0), width: rotationY ? 1.9 : .27, height: .16, depth: rotationY ? .27 : 1.9, rotationY: 0 });
      }
      const palletMaterial = new THREE.MeshStandardMaterial({ color: 0x8c6844, roughness: .9 }); scene.add(instancedBoxes(palletParts, palletMaterial));
      const forkliftYellow = new THREE.MeshStandardMaterial({ color: 0xe1ad28, metalness: .42, roughness: .54 });
      const forklift = instancedBoxes([
        { x: 27, y: .55, z: -13, width: 1.5, height: 1.1, depth: 2.2 }, { x: 27, y: 1.45, z: -12.45, width: 1.35, height: .12, depth: 1.1 },
        { x: 26.35, y: 1.05, z: -12.45, width: .1, height: 1.65, depth: .1 }, { x: 27.65, y: 1.05, z: -12.45, width: .1, height: 1.65, depth: .1 },
        { x: 26.55, y: .16, z: -14.62, width: .12, height: .12, depth: 1.5 }, { x: 27.05, y: .16, z: -14.62, width: .12, height: .12, depth: 1.5 },
      ], forkliftYellow); forklift.castShadow = true; scene.add(forklift);
      const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(.34, .34, .24, 10), darkMaterial, 4);
      [[26.24, .35, -13.65], [27.76, .35, -13.65], [26.24, .35, -12.3], [27.76, .35, -12.3]].forEach(([x, y, z], index) => { towerMatrix.makeRotationZ(Math.PI / 2); towerMatrix.setPosition(x, y, z); wheels.setMatrixAt(index, towerMatrix); }); wheels.instanceMatrix.needsUpdate = true; scene.add(wheels);
      const craneCable = instancedBoxes([{ x: 10, y: 5.1, z: -27.5, width: .035, height: 4.8, depth: .035 }, { x: 10, y: 2.72, z: -27.5, width: .8, height: .18, depth: .5 }], darkMaterial); scene.add(craneCable);
    } else {
      const windowParts: VisualBox[] = []; const shutterParts: VisualBox[] = []; const doorParts: VisualBox[] = []; const awnings: VisualBox[] = []; const balconyParts: VisualBox[] = [];
      const buildings = arena.boxes.filter((box) => box.kind === "platform" && box.height >= 4 && box.width >= 5 && box.depth >= 4);
      for (const [buildingIndex, box] of buildings.entries()) {
        const rows = box.height >= 5.5 ? [2.1, 4.15] : [2.25];
        for (const y of rows) for (const offset of [-.25, .25]) {
          const windowWidth = Math.min(1.35, box.width * .18); const windowDepth = Math.min(1.35, box.depth * .18); const frontX = box.x + offset * box.width; const sideZ = box.z + offset * box.depth;
          windowParts.push({ x: frontX, y, z: box.z - box.depth / 2 - .035, width: windowWidth, height: .95, depth: .07 }, { x: frontX, y, z: box.z + box.depth / 2 + .035, width: windowWidth, height: .95, depth: .07 });
          windowParts.push({ x: box.x - box.width / 2 - .035, y, z: sideZ, width: .07, height: .95, depth: windowDepth }, { x: box.x + box.width / 2 + .035, y, z: sideZ, width: .07, height: .95, depth: windowDepth });
          for (const side of [-1, 1]) shutterParts.push({ x: frontX + side * (windowWidth / 2 + .16), y, z: box.z - box.depth / 2 - .055, width: .22, height: 1.02, depth: .08 });
        }
        doorParts.push({ x: box.x, y: 1.05, z: box.z - box.depth / 2 - .045, width: 1.1, height: 2.1, depth: .09 });
        awnings.push({ x: box.x, y: 1.65, z: box.z - box.depth / 2 - .38, width: Math.min(3.4, box.width * .52), height: .12, depth: .8 });
        if (buildingIndex % 2 === 0 && box.height >= 4.5) { const front = box.z - box.depth / 2; balconyParts.push({ x: box.x, y: 3.15, z: front - .48, width: 3.2, height: .14, depth: .95 }, { x: box.x, y: 3.65, z: front - .92, width: 3.2, height: .08, depth: .08 }, { x: box.x - 1.55, y: 3.65, z: front - .48, width: .08, height: 1, depth: .95 }, { x: box.x + 1.55, y: 3.65, z: front - .48, width: .08, height: 1, depth: .95 }); }
      }
      const windowMaterial = new THREE.MeshStandardMaterial({ color: 0x384b56, emissive: 0xf5a74d, emissiveIntensity: .62, metalness: .08, roughness: .32 });
      const doorMaterial = new THREE.MeshStandardMaterial({ color: 0x493526, metalness: .12, roughness: .84 });
      const shutterMaterial = new THREE.MeshStandardMaterial({ color: 0x32636b, roughness: .8 });
      if (windowParts.length) scene.add(instancedBoxes(windowParts, windowMaterial));
      if (shutterParts.length) scene.add(instancedBoxes(shutterParts, shutterMaterial));
      if (doorParts.length) scene.add(instancedBoxes(doorParts, doorMaterial));
      if (awnings.length) scene.add(instancedBoxes(awnings, accentMaterial));
      if (balconyParts.length) scene.add(instancedBoxes(balconyParts, darkMaterial));
      const lampPositions = [[-25, -14], [-25, 14], [25, -14], [25, 14], [-10, -36], [10, 36], [-36, 10], [36, -10]] as const;
      const lamps = new THREE.InstancedMesh(new THREE.CylinderGeometry(.07, .1, 3.4, 6), darkMaterial, lampPositions.length);
      const lampHeads = new THREE.InstancedMesh(new THREE.BoxGeometry(.36, .24, .36), accentMaterial, lampPositions.length);
      lampPositions.forEach(([x, z], index) => { towerMatrix.makeTranslation(x, 1.7, z); lamps.setMatrixAt(index, towerMatrix); towerMatrix.makeTranslation(x, 3.35, z); lampHeads.setMatrixAt(index, towerMatrix); });
      lamps.instanceMatrix.needsUpdate = true; lampHeads.instanceMatrix.needsUpdate = true; scene.add(lamps, lampHeads);
      const bellRoof = new THREE.Mesh(new THREE.ConeGeometry(3.25, 2.2, 4), new THREE.MeshStandardMaterial({ color: 0x6f342b, roughness: .88 })); bellRoof.position.set(0, 9.5, 0); bellRoof.rotation.y = Math.PI / 4; bellRoof.castShadow = true; scene.add(bellRoof);
      const moon = new THREE.Mesh(new THREE.SphereGeometry(3.8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffefc8, fog: false })); moon.position.set(-34, 34, -68); scene.add(moon);
      const clothesLines = instancedBoxes([
        { x: -25, y: 4.1, z: 3, width: .035, height: .035, depth: 11 }, { x: 25, y: 4.4, z: -3, width: .035, height: .035, depth: 11 },
        { x: -3, y: 4.2, z: 25, width: 11, height: .035, depth: .035 }, { x: 3, y: 4.5, z: -25, width: 11, height: .035, depth: .035 },
      ], darkMaterial); scene.add(clothesLines);
      const laundryParts: VisualBox[] = [];
      for (let index = 0; index < 12; index += 1) laundryParts.push({ x: -25, y: 3.75 - index % 2 * .12, z: -1.5 + index * .82, width: .06, height: .48 + index % 3 * .1, depth: .55 });
      for (let index = 0; index < 12; index += 1) laundryParts.push({ x: -1.5 + index * .82, y: 3.82 - index % 2 * .12, z: 25, width: .55, height: .48 + index % 3 * .1, depth: .06 });
      const laundryMaterial = new THREE.MeshStandardMaterial({ color: 0xd86558, roughness: .95, side: THREE.DoubleSide }); scene.add(instancedBoxes(laundryParts, laundryMaterial));
      const potPositions = [[-26, -13], [-24, 13], [26, 13], [24, -13], [-9, 27], [9, -27], [-35, 9], [35, -9]] as const;
      const pots = new THREE.InstancedMesh(new THREE.CylinderGeometry(.3, .22, .42, 8), new THREE.MeshStandardMaterial({ color: 0xa45e3e, roughness: .88 }), potPositions.length);
      const plants = new THREE.InstancedMesh(new THREE.ConeGeometry(.52, 1.15, 7), new THREE.MeshStandardMaterial({ color: 0x355d42, roughness: .92 }), potPositions.length);
      potPositions.forEach(([x, z], index) => { towerMatrix.makeTranslation(x, .21, z); pots.setMatrixAt(index, towerMatrix); towerMatrix.makeTranslation(x, .98, z); plants.setMatrixAt(index, towerMatrix); }); pots.instanceMatrix.needsUpdate = true; plants.instanceMatrix.needsUpdate = true; scene.add(pots, plants);
      const benches = instancedBoxes([
        { x: -8, y: .55, z: 21, width: 2.3, height: .16, depth: .55 }, { x: -8, y: .92, z: 21.22, width: 2.3, height: .62, depth: .12 },
        { x: 8, y: .55, z: -21, width: 2.3, height: .16, depth: .55 }, { x: 8, y: .92, z: -21.22, width: 2.3, height: .62, depth: .12 },
      ], doorMaterial); scene.add(benches);
    }
    if (arena.theme === "desert-rig") { const pipeCount = 12; const boundaryPipes = new THREE.InstancedMesh(new THREE.CylinderGeometry(.075, .075, 2.05, 6), accentMaterial, pipeCount); for (let index = 0; index < pipeCount; index += 1) { const side = index % 4; const along = -arena.halfSize + 3 + Math.floor(index / 4) * (arenaSize - 6) / Math.max(1, Math.ceil(pipeCount / 4) - 1); const x = side < 2 ? along : (side === 2 ? -arena.halfSize + .31 : arena.halfSize - .31); const z = side < 2 ? (side === 0 ? -arena.halfSize + .31 : arena.halfSize - .31) : along; towerMatrix.makeTranslation(x, 1.08, z); boundaryPipes.setMatrixAt(index, towerMatrix); } boundaryPipes.instanceMatrix.needsUpdate = true; scene.add(boundaryPipes); }
    const dustCount = arena.size === "LARGE" ? 128 : arena.size === "MEDIUM" ? 96 : 72;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let index = 0; index < dustCount; index += 1) { dustPositions[index * 3] = ((index * 37) % 101 / 100 - .5) * (arenaSize - 3); dustPositions[index * 3 + 1] = .35 + (index * 53) % 37 / 37 * 5.4; dustPositions[index * 3 + 2] = ((index * 71) % 103 / 102 - .5) * (arenaSize - 3); }
    const dustGeometry = new THREE.BufferGeometry(); dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: arena.theme === "desert-rig" ? 0xffc078 : arena.theme === "container-yard" ? 0xcfe4e7 : 0x9bb9e8, size: arena.theme === "desert-rig" ? .065 : .035, transparent: true, opacity: arena.theme === "desert-rig" ? .42 : .2, depthWrite: false, sizeAttenuation: true })); scene.add(dust);

    const weaponGroup = new THREE.Group();
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x242c26, metalness: .72, roughness: .34 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xbcd83c, emissive: 0x364600, emissiveIntensity: 1.35, metalness: .3, roughness: .4 });
    const weaponModel = new THREE.Group();
    const weaponBody = new THREE.Mesh(mergedParts([
      boxPart(.23, .19, .68, .34, -.29, -.69, -.04),
      boxPart(.18, .15, .47, .34, -.28, -1.12),
      boxPart(.25, .2, .31, .34, -.3, -.22),
      boxPart(.12, .32, .17, .36, -.43, -.52, -.22),
      boxPart(.13, .31, .2, .34, -.43, -.76, .14),
      cylinderPart(.035, .045, .58, 8, .34, -.27, -1.58, Math.PI / 2),
      cylinderPart(.064, .064, .09, 8, .34, -.27, -1.89, Math.PI / 2)
    ]), gunMat); weaponModel.add(weaponBody);
    const weaponTrim = new THREE.Mesh(mergedParts([
      boxPart(.1, .045, .68, .34, -.175, -.82),
      boxPart(.09, .1, .14, .34, -.13, -.65),
      boxPart(.11, .055, .12, .34, -.13, -.94),
      boxPart(.245, .04, .24, .34, -.265, -1.14),
      boxPart(.135, .06, .12, .34, -.43, -.75)
    ]), trimMat); weaponModel.add(weaponTrim); weaponGroup.add(weaponModel);
    const gloveMaterial = new THREE.MeshStandardMaterial({ color: 0x303832, metalness: .12, roughness: .82 });
    const hands = new THREE.Mesh(mergedParts([
      boxPart(.17, .19, .19, .34, -.47, -.51, -.18),
      boxPart(.19, .17, .21, .29, -.39, -1.08, .08),
      boxPart(.2, .2, .3, .42, -.54, -.4, -.2, 0, -.1),
      boxPart(.21, .2, .3, .18, -.48, -.94, .16, 0, .08)
    ]), gloveMaterial); weaponGroup.add(hands);
    weaponGroup.position.x = .16; weaponGroup.position.z = -.28;
    const muzzleMat = new THREE.MeshBasicMaterial({ color: 0xfff2a8 });
    const muzzle = new THREE.Mesh(new THREE.ConeGeometry(.12, .38, 7), muzzleMat); muzzle.rotation.x = -Math.PI / 2; muzzle.position.set(.34, -.27, -1.94); muzzle.visible = false; weaponGroup.add(muzzle);
    const flashCanvas = document.createElement("canvas"); flashCanvas.width = 96; flashCanvas.height = 96;
    const flashContext = flashCanvas.getContext("2d")!; const flashGradient = flashContext.createRadialGradient(48, 48, 2, 48, 48, 46);
    flashGradient.addColorStop(0, "#ffffff"); flashGradient.addColorStop(.16, "#fff5a8"); flashGradient.addColorStop(.42, "#ff9f32e8"); flashGradient.addColorStop(1, "#ff5b3200");
    flashContext.fillStyle = flashGradient; flashContext.fillRect(0, 0, 96, 96);
    const flashTexture = new THREE.CanvasTexture(flashCanvas); flashTexture.colorSpace = THREE.SRGBColorSpace;
    const flashMaterial = new THREE.SpriteMaterial({ map: flashTexture, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false });
    const remoteFlashMaterial = new THREE.SpriteMaterial({ map: flashTexture, color: 0xffca68, transparent: true, opacity: .94, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false });
    const muzzleFlash = new THREE.Sprite(flashMaterial); muzzleFlash.position.set(.34, -.27, -2.02); muzzleFlash.scale.set(.72, .72, 1); muzzleFlash.renderOrder = 10; muzzleFlash.visible = false; weaponGroup.add(muzzleFlash);
    const muzzleLight = new THREE.PointLight(0xff9f43, 0, 4); muzzleLight.position.copy(muzzle.position); weaponGroup.add(muzzleLight);
    camera.add(weaponGroup);
    const healthBackMaterial = new THREE.SpriteMaterial({ color: 0x10140e, opacity: .92, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const healthHighMaterial = new THREE.SpriteMaterial({ color: 0xd9ff43, depthTest: false, depthWrite: false, toneMapped: false });
    const healthMidMaterial = new THREE.SpriteMaterial({ color: 0xffb438, depthTest: false, depthWrite: false, toneMapped: false });
    const healthLowMaterial = new THREE.SpriteMaterial({ color: 0xff4f32, depthTest: false, depthWrite: false, toneMapped: false });
    const helmetPart = new THREE.IcosahedronGeometry(.34, 0); helmetPart.translate(0, 1.68, 0);
    const playerSuitGeometry = mergedParts([
      boxPart(.58, .25, .37, 0, .7, 0),
      boxPart(.23, .68, .28, -.2, .34, 0), boxPart(.23, .68, .28, .2, .34, 0),
      boxPart(.6, .1, .4, 0, .77, 0), boxPart(.45, .54, .18, 0, 1.12, .3), helmetPart
    ]);
    const playerArmorGeometry = mergedParts([
      boxPart(.7, .78, .43, 0, 1.08, 0), boxPart(.5, .3, .47, 0, 1.19, -.035),
      boxPart(.26, .2, .34, -.48, 1.34, -.015), boxPart(.26, .2, .34, .48, 1.34, -.015),
      boxPart(.19, .6, .22, -.49, 1.02, -.06, 0, 0, .12), boxPart(.19, .6, .22, .49, 1.02, -.06, 0, 0, -.12),
      boxPart(.25, .17, .31, -.2, .43, -.12), boxPart(.25, .17, .31, .2, .43, -.12),
      boxPart(.39, .11, .09, 0, 1.7, -.3)
    ]);
    const playerWeaponGeometry = mergedParts([
      boxPart(.15, .14, .66, .34, 1.08, -.48), boxPart(.17, .17, .23, .34, 1.08, -.08),
      boxPart(.1, .25, .14, .35, .95, -.32, -.22), cylinderPart(.027, .038, .47, 7, .34, 1.09, -1.04, Math.PI / 2),
      boxPart(.07, .07, .14, .34, 1.18, -.47)
    ]);
    const botArmorMaterial = new THREE.MeshStandardMaterial({ color: 0xff6037, emissive: 0x541207, emissiveIntensity: 1.05, metalness: .28, roughness: .48 });
    const humanArmorMaterial = new THREE.MeshStandardMaterial({ color: 0xd9ff43, emissive: 0x344500, emissiveIntensity: 1.05, metalness: .28, roughness: .48 });
    const playerSuitMaterial = new THREE.MeshStandardMaterial({ color: 0x171d19, metalness: .45, roughness: .65 });
    const playerWeaponMaterial = new THREE.MeshStandardMaterial({ color: 0x2d3730, metalness: .72, roughness: .36 });
    const markerGeometry = new THREE.RingGeometry(.28, .36, 12);
    const botMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xff6037, side: THREE.DoubleSide });
    const humanMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xd9ff43, side: THREE.DoubleSide });
    const playerMeshes = new Map<string, THREE.Group>();
    const makePlayer = (id: string, name: string, bot: boolean) => {
      const group = new THREE.Group();
      const suit = new THREE.Mesh(playerSuitGeometry, playerSuitMaterial); group.add(suit);
      const armor = new THREE.Mesh(playerArmorGeometry, bot ? botArmorMaterial : humanArmorMaterial); group.add(armor);
      const remoteGun = new THREE.Mesh(playerWeaponGeometry, playerWeaponMaterial); group.add(remoteGun);
      const remoteMuzzleFlash = new THREE.Sprite(remoteFlashMaterial); remoteMuzzleFlash.position.set(.34, 1.09, -1.31); remoteMuzzleFlash.scale.set(.5, .5, 1); remoteMuzzleFlash.renderOrder = 12; remoteMuzzleFlash.visible = false; group.add(remoteMuzzleFlash);
      const marker = new THREE.Mesh(markerGeometry, bot ? botMarkerMaterial : humanMarkerMaterial); marker.position.y = 2.25; marker.rotation.x = Math.PI / 2; group.add(marker);
      const healthMeter = new THREE.Group();
      const healthBack = new THREE.Sprite(healthBackMaterial); healthBack.scale.set(1.18, .16, 1); healthBack.renderOrder = 20; healthMeter.add(healthBack);
      const healthFill = new THREE.Sprite(healthHighMaterial); healthFill.scale.set(1.08, .09, 1); healthFill.renderOrder = 21; healthMeter.add(healthFill);
      const nameplate = playerNameplate(name, bot); healthMeter.add(nameplate.sprite);
      healthMeter.renderOrder = 20; scene.add(healthMeter);
      group.userData.target = new THREE.Vector3();
      group.userData.targetYaw = 0;
      group.userData.healthMeter = healthMeter;
      group.userData.healthFill = healthFill;
      group.userData.nameplateMaterial = nameplate.material;
      group.userData.muzzleFlash = remoteMuzzleFlash;
      group.userData.healthFraction = 1;
      group.userData.wasVisible = false;
      scene.add(group); playerMeshes.set(id, group); return group;
    };
    const onResize = () => { camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(mount.clientWidth, mount.clientHeight); }; window.addEventListener("resize", onResize);
    const onClick = () => {
      if (document.pointerLockElement === mount) return;
      try {
        const lock = mount.requestPointerLock();
        if (lock && typeof lock.catch === "function") lock.catch(() => undefined);
      } catch { /* Embedded browsers may decline pointer lock; keyboard play remains available. */ }
    };
    mount.addEventListener("click", onClick);
    camera.rotation.order = "YXZ";
    const predictedPosition = new THREE.Vector3();
    const predictedCandidate = new THREE.Vector3();
    const authoritativePosition = new THREE.Vector3();
    const predictedVelocity = new THREE.Vector3();
    let predictionReady = false;
    let predictedGrounded = true;
    let landingOffset = 0;
    let localAlive = true;
    let lastSceneTick = -1;
    let lastFrameAt = performance.now();
    let perfWindowAt = lastFrameAt;
    let perfFrames = 0;
    let shadowRendered = false;
    let renderedWeapon: WeaponId | null = null;
    let animation = 0;
    const render = () => {
      animation = requestAnimationFrame(render);
      const now = performance.now();
      const dt = Math.min(.05, (now - lastFrameAt) / 1000); lastFrameAt = now;
      const state = latestRef.current;
      if (state && state.tick !== lastSceneTick) {
        lastSceneTick = state.tick;
        const present = new Set<string>();
        for (const player of state.players) {
          if (player.id === playerIdRef.current) {
            authoritativePosition.set(player.position.x, player.position.y, player.position.z);
            localAlive = player.alive;
            if (!predictionReady || !player.alive || predictedPosition.distanceToSquared(authoritativePosition) > 9) {
              predictedPosition.copy(authoritativePosition); predictedVelocity.set(0, 0, 0); predictedGrounded = isStandingOnSurface(authoritativePosition, arena); predictionReady = true;
            } else {
              predictedPosition.x += (authoritativePosition.x - predictedPosition.x) * .32;
              predictedPosition.z += (authoritativePosition.z - predictedPosition.z) * .32;
              const verticalError = authoritativePosition.y - predictedPosition.y;
              const authoritativeGrounded = isStandingOnSurface(authoritativePosition, arena);
              if (Math.abs(verticalError) > 1.75) { predictedPosition.y = authoritativePosition.y; predictedVelocity.y = 0; predictedGrounded = authoritativeGrounded; }
              else {
                predictedPosition.y += verticalError * .1;
                if (predictedGrounded && !authoritativeGrounded && verticalError > .08) { predictedGrounded = false; predictedVelocity.y = Math.max(predictedVelocity.y, JUMP_SPEED * .72); }
                if (authoritativeGrounded && Math.abs(verticalError) < .1 && predictedVelocity.y <= 0) { predictedPosition.y = authoritativePosition.y; predictedVelocity.y = 0; predictedGrounded = true; }
              }
            }
            continue;
          }
          present.add(player.id);
          const mesh = playerMeshes.get(player.id) ?? makePlayer(player.id, player.name, player.bot);
          const visible = player.alive && player.visible !== false;
          const wasVisible = mesh.userData.wasVisible === true;
          mesh.visible = visible;
          const healthMeter = mesh.userData.healthMeter as THREE.Group;
          const healthFill = mesh.userData.healthFill as THREE.Sprite;
          const health = nextOpponentHealthFraction(mesh.userData.healthFraction as number, player.health, player.visible !== false, player.alive);
          mesh.userData.healthFraction = health;
          healthMeter.visible = visible;
          healthFill.scale.x = 1.08 * health;
          healthFill.position.x = -.54 * (1 - health);
          healthFill.material = health <= .25 ? healthLowMaterial : health <= .55 ? healthMidMaterial : healthHighMaterial;
          if (visible) {
            const target = mesh.userData.target as THREE.Vector3;
            target.set(player.position.x, player.position.y, player.position.z);
            if (shouldSnapOpponentPosition(wasVisible, visible, mesh.position.distanceToSquared(target))) mesh.position.copy(target);
            mesh.userData.targetYaw = player.yaw;
            if (!wasVisible) mesh.rotation.y = player.yaw;
          }
          mesh.userData.wasVisible = visible;
        }
        for (const [id, mesh] of playerMeshes) if (!present.has(id)) { const nameMaterial = mesh.userData.nameplateMaterial as THREE.SpriteMaterial; nameMaterial.map?.dispose(); nameMaterial.dispose(); scene.remove(mesh); scene.remove(mesh.userData.healthMeter as THREE.Group); playerMeshes.delete(id); remoteShotAtRef.current.delete(id); }
      }
      for (const [id, mesh] of playerMeshes) {
        mesh.position.lerp(mesh.userData.target as THREE.Vector3, .34);
        mesh.rotation.y += (mesh.userData.targetYaw as number - mesh.rotation.y) * .34;
        (mesh.userData.healthMeter as THREE.Group).position.set(mesh.position.x, mesh.position.y + 2.42, mesh.position.z);
        const remoteFlash = mesh.userData.muzzleFlash as THREE.Sprite;
        const remoteShotAge = now - (remoteShotAtRef.current.get(id) ?? -Infinity);
        const remoteFiring = mesh.visible && remoteShotAge >= 0 && remoteShotAge < 110;
        remoteFlash.visible = remoteFiring;
        if (remoteFiring) remoteFlash.scale.setScalar(.34 + (1 - remoteShotAge / 110) * .42);
      }
      if (predictionReady) {
        const keys = keysRef.current; const aim = aimRef.current;
        const forwardInput = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
        const strafeInput = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
        const inputLength = Math.max(1, Math.hypot(forwardInput, strafeInput));
        const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? SPRINT_SPEED : MOVE_SPEED;
        const targetX = (-Math.sin(aim.yaw) * forwardInput / inputLength + Math.cos(aim.yaw) * strafeInput / inputLength) * speed;
        const targetZ = (-Math.cos(aim.yaw) * forwardInput / inputLength - Math.sin(aim.yaw) * strafeInput / inputLength) * speed;
        const acceleration = Math.min(1, dt * MOVE_ACCELERATION);
        predictedVelocity.x += (targetX - predictedVelocity.x) * acceleration;
        predictedVelocity.z += (targetZ - predictedVelocity.z) * acceleration;
        if (localAlive) {
          if (keys.has("Space") && predictedGrounded) { predictedVelocity.y = JUMP_SPEED; predictedGrounded = false; }
          predictedVelocity.y -= GRAVITY * dt;
          predictedCandidate.copy(predictedPosition); predictedCandidate.x += predictedVelocity.x * dt;
          if (!collidesAt(predictedCandidate, arena)) predictedPosition.x = predictedCandidate.x; else predictedVelocity.x = 0;
          predictedCandidate.copy(predictedPosition); predictedCandidate.z += predictedVelocity.z * dt;
          if (!collidesAt(predictedCandidate, arena)) predictedPosition.z = predictedCandidate.z; else predictedVelocity.z = 0;
          const vertical = resolveVerticalMotion(predictedPosition, predictedPosition.y + predictedVelocity.y * dt, predictedVelocity.y, arena);
          if (!predictedGrounded && vertical.grounded) landingOffset = -.065;
          predictedPosition.y = vertical.y; predictedVelocity.y = vertical.velocityY; predictedGrounded = vertical.grounded;
        }
        const predictedEdge = arena.halfSize - .5; predictedPosition.x = THREE.MathUtils.clamp(predictedPosition.x, -predictedEdge, predictedEdge); predictedPosition.z = THREE.MathUtils.clamp(predictedPosition.z, -predictedEdge, predictedEdge);
        landingOffset += (0 - landingOffset) * Math.min(1, dt * 18);
        camera.position.set(predictedPosition.x, predictedPosition.y + 1.55 + landingOffset, predictedPosition.z);
        camera.rotation.y = aim.yaw; camera.rotation.x = aim.pitch;
      }
      const activeWeapon = weaponRef.current;
      if (activeWeapon !== renderedWeapon) {
        renderedWeapon = activeWeapon;
        if (activeWeapon === "sniper") { weaponModel.scale.set(1, .88, 1.12); gunMat.color.setHex(0x354139); muzzle.position.z = -2.14; muzzleFlash.position.z = -2.22; }
        else if (activeWeapon === "smg") { weaponModel.scale.set(1, 1.05, .84); gunMat.color.setHex(0x3c3029); muzzle.position.z = -1.72; muzzleFlash.position.z = -1.8; }
        else { weaponModel.scale.set(1, 1, 1); gunMat.color.setHex(0x29332b); muzzle.position.z = -1.94; muzzleFlash.position.z = -2.02; }
        muzzleLight.position.copy(muzzle.position);
      }
      const moving = keysRef.current.has("KeyW") || keysRef.current.has("KeyA") || keysRef.current.has("KeyS") || keysRef.current.has("KeyD");
      const bob = moving ? Math.sin(now / 85) * .018 : Math.sin(now / 440) * .004;
      const shotAge = now - shotAtRef.current; const flash = shotAge < 68; const flashStrength = flash ? 1 - shotAge / 68 : 0;
      muzzle.visible = flash; muzzleFlash.visible = flash; muzzleLight.intensity = flash ? 8 * flashStrength : 0;
      flashMaterial.opacity = flashStrength; muzzleFlash.scale.setScalar(.46 + flashStrength * .48);
      weaponGroup.position.y = -.095 + bob + (flash ? -.032 : 0); weaponGroup.rotation.x = flash ? .045 * flashStrength : 0;
      dust.rotation.y += dt * .004;
      renderer.render(scene, camera);
      if (!shadowRendered) { renderer.shadowMap.autoUpdate = false; shadowRendered = true; }
      perfFrames += 1;
      if (now - perfWindowAt >= 2000) {
        const fps = perfFrames * 1000 / (now - perfWindowAt);
        const nextRatio = fps < 52 ? Math.max(.8, pixelRatio - .1) : fps > 58 ? Math.min(maximumPixelRatio, pixelRatio + .05) : pixelRatio;
        if (nextRatio !== pixelRatio) { pixelRatio = nextRatio; renderer.setPixelRatio(pixelRatio); renderer.setSize(mount.clientWidth, mount.clientHeight, false); }
        mount.dataset.renderFps = fps.toFixed(0); mount.dataset.pixelRatio = pixelRatio.toFixed(2); mount.dataset.drawCalls = String(renderer.info.render.calls); mount.dataset.triangles = String(renderer.info.render.triangles);
        perfFrames = 0; perfWindowAt = now;
      }
    };
    render();
    return () => { cancelAnimationFrame(animation); window.removeEventListener("resize", onResize); mount.removeEventListener("click", onClick); for (const mesh of playerMeshes.values()) { const nameMaterial = mesh.userData.nameplateMaterial as THREE.SpriteMaterial; nameMaterial.map?.dispose(); nameMaterial.dispose(); } scene.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points) { object.geometry.dispose(); const mats = Array.isArray(object.material) ? object.material : [object.material]; mats.forEach((mat) => mat.dispose()); } }); floorTexture.dispose(); surfaceTexture.dispose(); flashTexture.dispose(); flashMaterial.dispose(); remoteFlashMaterial.dispose(); healthBackMaterial.dispose(); healthHighMaterial.dispose(); healthMidMaterial.dispose(); healthLowMaterial.dispose(); playerSuitGeometry.dispose(); playerArmorGeometry.dispose(); playerWeaponGeometry.dispose(); markerGeometry.dispose(); botArmorMaterial.dispose(); humanArmorMaterial.dispose(); playerSuitMaterial.dispose(); playerWeaponMaterial.dispose(); botMarkerMaterial.dispose(); humanMarkerMaterial.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, [mapId, phase]);

  if (phase === "matchmaking") return <PvpLobby lobby={pvpLobby} playerId={playerId} connection={connection} voiceActive={voiceActive} voiceStatus={voiceStatus} speakingPlayerIds={speakingPlayerIds} onToggleVoice={toggleVoice} onReady={(ready) => send({ type: "ready", ready })} onLeave={leavePvpLobby} />;
  if (phase !== "playing") return <Lobby phase={phase} name={name} setName={setName} weapon={weapon} setWeapon={setWeapon} gameMode={gameMode} setGameMode={setGameMode} botCount={botCount} setBotCount={setBotCount} selectedMapId={selectedMapId} setSelectedMapId={setSelectedMapId} voiceOptIn={voiceOptIn} setVoiceOptIn={setVoiceOptIn} voiceStatus={voiceStatus} deploy={deploy} />;
  return (
    <main className="game-shell" data-capture={typeof window !== "undefined" && new URLSearchParams(window.location.search).has("capture") ? "true" : undefined} data-map-id={mapId} data-player-position={me ? `${me.position.x.toFixed(2)},${me.position.y.toFixed(2)},${me.position.z.toFixed(2)}` : "pending"} data-player-aim={me ? `${me.yaw.toFixed(3)},${me.pitch.toFixed(3)}` : "pending"}>
      <div className="game-canvas" ref={mountRef} />
      <div className="game-fx" aria-hidden="true" />
      {damageNotice && <><div className={damageNotice.headshot ? "damage-vignette headshot" : "damage-vignette"} key={`damage-vignette-${damageNotice.id}`} aria-hidden="true" /><div className="damage-direction" key={`damage-direction-${damageNotice.id}`} style={{ transform: `translate(-50%, -50%) rotate(${damageNotice.angle}deg)` }} aria-hidden="true"><i /></div><div className="damage-impact-label" key={`damage-label-${damageNotice.id}`} role="status">{damageNotice.headshot ? "HEADSHOT · " : "INCOMING · "}-{damageNotice.damage} HP</div></>}
      <header className="game-top"><div className="brand"><span>DROP</span>ZONE <i>ƒ</i></div><div className="match-clock"><small>ROUND ENDS</small><b>{formatTime(snapshot?.match.remainingMs ?? 300_000)}</b></div><div className="network"><b /> {connection} · {ping} MS</div></header>
      <aside className="scoreboard"><h2>{gameMode === "training" ? "TRAINING" : "PUBLIC PVP"} / {MAPS[mapId].label} · {MAPS[mapId].size}</h2>{leaders.map((player, index) => <div className={player.id === playerId ? "score-row me" : "score-row"} key={player.id}><span>{String(index + 1).padStart(2, "0")}</span><b>{player.name}{player.bot ? " [BOT]" : ""}</b><em>{player.score}</em></div>)}</aside>
      <section className="kill-feed">{snapshot?.feed.map((item) => <div key={item.id}><b>{item.attacker}</b><span>{item.headshot ? "◎" : "×"}</span>{item.victim}</div>)}</section>
      <div className={`crosshair${hitMarker ? ` ${hitMarker}` : ""}`}><i /><i /></div>
      {killNotice && <><div className="kill-pulse" aria-hidden="true" /><div className="kill-confirm" role="status" key={killNotice.id}><small>ELIMINATION</small><b>{killNotice.victim}</b><span>{killNotice.headshot ? "HEADSHOT · " : ""}+{killNotice.points} POINTS</span></div></>}
      {!me?.alive && <div className="respawn-card"><small>ELIMINATED</small><b>REDEPLOYING…</b></div>}
      {snapshot?.match.phase === "ended" && <div className="round-card"><small>ROUND COMPLETE</small><b>{gameMode === "training" ? "RESETTING DRILL" : "RETURNING TO LOBBY"}</b><span>{gameMode === "training" ? "TRAINING RESULTS ARE NOT REWARDED" : "SIGNED RESULT SECURED"}</span></div>}
      <div className={`health-block ${healthState}`}><small>VITALS <span>{healthState === "critical" ? "CRITICAL" : healthState === "low" ? "WOUNDED" : "STABLE"}</span></small><strong>{selfHealth}<em> HP</em></strong><div className="self-health-track" role="progressbar" aria-label="Your health" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selfHealth}><i style={{ width: `${selfHealth}%` }} /></div></div>
      <div className="ammo-block"><small>{me?.reloading ? "RELOADING" : WEAPONS[me?.weapon ?? weapon].label}</small><strong>{me?.ammo ?? WEAPONS[weapon].magazine}<em> / {me?.reserve ?? WEAPONS[weapon].reserve}</em></strong><span>1 · 2 · 3 TO SWITCH</span></div>
      <div className="allowance"><small>{gameMode === "training" ? "TRAINING SCORE" : "ƒLAUNCH ALLOWANCE"}</small><b>{me?.score ?? 0} PTS</b><span>{awardState}</span></div>
      {gameMode === "pvp" && <button className={voiceActive ? "voice-hud active" : "voice-hud"} type="button" onClick={toggleVoice} aria-pressed={voiceActive}><span aria-hidden="true">{voiceActive ? "●" : "○"}</span> PROXIMITY MIC · {voiceStatus}</button>}
      <div className="controls-hint">CLICK TO LOCK AIM · WASD MOVE · SHIFT SPRINT · SPACE JUMP · R RELOAD</div>
    </main>
  );
}

function Lobby({ phase, name, setName, weapon, setWeapon, gameMode, setGameMode, botCount, setBotCount, selectedMapId, setSelectedMapId, voiceOptIn, setVoiceOptIn, voiceStatus, deploy }: { phase: Phase; name: string; setName: (value: string) => void; weapon: WeaponId; setWeapon: (value: WeaponId) => void; gameMode: GameMode; setGameMode: (value: GameMode) => void; botCount: number; setBotCount: (value: number) => void; selectedMapId: MapId; setSelectedMapId: (value: MapId) => void; voiceOptIn: boolean; setVoiceOptIn: (value: boolean) => void; voiceStatus: string; deploy: () => void }) {
  return (
    <main className="landing-shell">
      <nav className="topbar"><div className="brand"><span>DROP</span>ZONE</div></nav>
      <section className="hero-stage">
        <div className="arena-preview" aria-hidden="true" />
        <div className="lobby-card">
          <h1>Fast aim.<br /><em>Fair launch.</em></h1><p className="intro">Train privately against bots or ready up with real players in public PvP.</p>
          <label className="field-label" htmlFor="callsign">CALLSIGN</label><input id="callsign" value={name} onChange={(event) => setName(event.target.value)} maxLength={16} />
          <div className="field-label mode-label">CHOOSE MODE</div>
          <div className="mode-select" role="radiogroup" aria-label="Choose game mode">
            <button type="button" role="radio" aria-checked={gameMode === "training"} className={gameMode === "training" ? "mode-option active" : "mode-option"} onClick={() => setGameMode("training")}><b>TRAINING</b><small>PRIVATE · BOTS · NO REWARDS</small></button>
            <button type="button" role="radio" aria-checked={gameMode === "pvp"} className={gameMode === "pvp" ? "mode-option active" : "mode-option"} onClick={() => setGameMode("pvp")}><b>PUBLIC PVP</b><small>REAL PLAYERS · READY VOTE</small></button>
          </div>
          {gameMode === "training" && <div className="bot-picker"><span><b>TRAINING BOTS</b><small>Private room · rewards disabled</small></span><div><button type="button" onClick={() => setBotCount(Math.max(1, botCount - 1))} aria-label="Remove one bot">−</button><strong>{botCount}</strong><button type="button" onClick={() => setBotCount(Math.min(7, botCount + 1))} aria-label="Add one bot">+</button></div></div>}
          {gameMode === "pvp" && <button type="button" className={voiceOptIn ? "voice-option active" : "voice-option"} onClick={() => setVoiceOptIn(!voiceOptIn)} aria-pressed={voiceOptIn}><span><b>LOBBY + PROXIMITY VOICE</b><small>{voiceOptIn ? "Permission requested when you join" : "Optional · microphone stays off"}</small></span><strong>{voiceOptIn ? "ON" : voiceStatus === "MIC PERMISSION DENIED" ? "DENIED" : "OFF"}</strong></button>}
          <div className="field-label map-label">CHOOSE ARENA</div><div className="map-select" role="radiogroup" aria-label="Choose an arena">{MAP_IDS.map((id) => <button key={id} type="button" role="radio" aria-checked={selectedMapId === id} className={selectedMapId === id ? "map-option active" : "map-option"} onClick={() => setSelectedMapId(id)} title={`${MAPS[id].description} · ${MAPS[id].playerRange}`}><MapDiagram mapId={id} /><span><b>{MAPS[id].label}</b><small>{MAPS[id].size} · {MAPS[id].description}</small></span></button>)}</div>
          <div className="field-label loadout-label">CHOOSE LOADOUT</div><div className="loadout" role="group" aria-label="Choose a weapon">{(["rifle", "sniper", "smg"] as WeaponId[]).map((id, index) => <button key={id} className={weapon === id ? "weapon active" : "weapon"} onClick={() => setWeapon(id)} aria-pressed={weapon === id}><small>0{index + 1}</small><WeaponSilhouette weapon={id} /><strong>{WEAPONS[id].label}</strong></button>)}</div>
          <button className="deploy-button" onClick={deploy} disabled={phase === "connecting"}>{phase === "connecting" ? "LINKING TO MATCH…" : gameMode === "training" ? `START TRAINING · ${botCount} BOTS` : "JOIN PVP LOBBY"}<span>→</span></button>
          <div className="lobby-foot"><span><b /> {gameMode === "training" ? `${botCount} TRAINING RIVALS` : "PUBLIC MATCHMAKING"}</span><span>{gameMode === "training" ? "PRIVATE PRACTICE" : "MAJORITY READY TO START"}</span></div>
        </div>
      </section>
      <footer className="ticker"><span>TRAINING + PUBLIC PVP</span><i /><span>05:00 MATCH</span><i /><span>100 PTS / ELIM</span></footer>
    </main>
  );
}

function PvpLobby({ lobby, playerId, connection, voiceActive, voiceStatus, speakingPlayerIds, onToggleVoice, onReady, onLeave }: { lobby: LobbyState | null; playerId: string; connection: string; voiceActive: boolean; voiceStatus: string; speakingPlayerIds: Set<string>; onToggleVoice: () => void; onReady: (ready: boolean) => void; onLeave: () => void }) {
  const me = lobby?.players.find((player) => player.id === playerId);
  const enoughPlayers = (lobby?.players.length ?? 0) >= (lobby?.minimumPlayers ?? 2);
  return (
    <main className="match-lobby-shell">
      <nav className="topbar"><div className="brand"><span>DROP</span>ZONE <i>ƒ</i></div><div className="server-pill"><b /> {connection}</div></nav>
      <section className="match-lobby-stage">
        <div className="match-lobby-card">
          <p className="eyebrow">PUBLIC PVP LOBBY</p>
          <h2>{lobby ? MAPS[lobby.mapId].label : "FINDING ROOM"}</h2>
          <p className="lobby-status">{!lobby ? "Connecting to the authoritative lobby…" : !enoughPlayers ? "Waiting for at least one more player" : `${lobby.readyCount} of ${lobby.players.length} ready · ${lobby.requiredReady} required`}</p>
          <div className="ready-progress"><i style={{ width: `${lobby ? Math.min(100, lobby.readyCount / lobby.requiredReady * 100) : 0}%` }} /></div>
          <div className="player-roster" aria-live="polite">{lobby?.players.map((player, index) => { const speaking = speakingPlayerIds.has(player.id); return <div key={player.id} className={`${player.ready ? "ready" : ""}${player.id === playerId ? " me" : ""}${speaking ? " speaking" : ""}`}><span>{String(index + 1).padStart(2, "0")}</span><b>{player.name}{player.id === playerId ? " · YOU" : ""}{speaking && <small className="talking-indicator" aria-hidden="true">TALKING</small>}</b><i className={player.voiceEnabled ? "voice-live" : ""}>{player.voiceEnabled ? "MIC" : "—"}</i><em>{player.ready ? "READY" : "WAITING"}</em></div>; })}</div>
          <button className={voiceActive ? "lobby-voice-button active" : "lobby-voice-button"} type="button" onClick={onToggleVoice} aria-pressed={voiceActive}><span aria-hidden="true">{voiceActive ? "●" : "○"}</span>{voiceActive ? "LOBBY VOICE ON" : "ENABLE MICROPHONE"}<small>{voiceActive ? "Everyone with voice enabled can hear you" : voiceStatus}</small></button>
          <button className={me?.ready ? "ready-button active" : "ready-button"} type="button" disabled={!lobby} onClick={() => onReady(!me?.ready)}>{me?.ready ? "CANCEL READY" : "READY UP"}<span>{me?.ready ? "✓" : "→"}</span></button>
          <button className="leave-lobby" type="button" onClick={onLeave}>LEAVE LOBBY</button>
          <small className="majority-note">The match starts automatically when more than half the lobby is ready. Minimum 2 players.</small>
        </div>
      </section>
    </main>
  );
}

function MapDiagram({ mapId }: { mapId: MapId }) {
  if (mapId === "citadel") return <svg className="map-diagram town-map" viewBox="0 0 160 72" aria-hidden="true"><rect className="map-sky" width="160" height="72" rx="3" /><circle className="map-moon" cx="132" cy="15" r="7" /><path className="map-ground" d="M0 56 29 50l32 5 31-7 38 5 30-4v23H0z" /><path className="town-back" d="M4 31h27v27H4zm30 8h23v19H34zm78-13h41v32h-41z" /><path className="town-front" d="M60 26h34v34H60zm-4 0 21-13 22 13zM99 38h21v22H99z" /><path className="town-windows" d="M11 39h6v7h-6zm9 0h6v7h-6zm48-5h7v8h-7zm12 0h7v8h-7zm-11 14h7v12h-7zm50-14h7v7h-7zm12 0h7v7h-7z" /></svg>;
  if (mapId === "switchyard") return <svg className="map-diagram yard-map" viewBox="0 0 160 72" aria-hidden="true"><rect className="map-sky" width="160" height="72" rx="3" /><path className="map-ground" d="M0 55h160v17H0z" /><path className="yard-crane" d="M17 10h5v48h-5zm0 0h104v5H17zm78 3h5v12h-5zm-5 12h15v3H90z" /><path className="container-blue" d="M6 43h48v15H6zm84-16h43v15H90z" /><path className="container-orange" d="M40 28h47v15H40zm72 15h43v15h-43z" /><path className="container-red" d="M55 43h56v15H55z" /><path className="container-ribs" d="M14 45h2v11h-2zm10 0h2v11h-2zm10 0h2v11h-2zm29 0h2v11h-2zm11 0h2v11h-2zm11 0h2v11h-2zm35 0h2v11h-2zm10 0h2v11h-2zm10 0h2v11h-2z" /></svg>;
  return <svg className="map-diagram rust-map" viewBox="0 0 160 72" aria-hidden="true"><rect className="map-sky" width="160" height="72" rx="3" /><circle className="map-sun" cx="139" cy="15" r="8" /><path className="map-ground" d="M0 52 31 48l29 4 31-8 34 6 35-5v27H0z" /><path className="rust-tower" d="M61 17h38v5H61zm4 9h30v4H65zm4 8h22v4H69zm4 8h14v20H73zM62 18h4l11 44h-5zm32 0h4L88 62h-5z" /><path className="rust-pipe" d="M8 38h42v7H8zm37 0h7v18h-7zm66 5h43v6h-43zm0 0h6v15h-6z" /><path className="rust-tank" d="M16 50h31v12H16zm0 0c0-6 31-6 31 0zM111 53h32v9h-32z" /></svg>;
}

function WeaponSilhouette({ weapon }: { weapon: WeaponId }) {
  if (weapon === "sniper") return <svg className="weapon-visual sniper-visual" viewBox="0 0 180 70" aria-hidden="true"><path className="weapon-shadow" d="M7 47h163v8H7z" /><path className="weapon-stock" d="M8 39h40l18-11h33l10 11-15 11H43L25 57H8z" /><path className="weapon-metal" d="M58 27h67l13 8h35v8h-52l-13 7H58z" /><path className="weapon-barrel" d="M121 31h52v5h-52z" /><path className="weapon-grip" d="M72 48h18l-4 19H68z" /><rect className="weapon-accent" x="61" y="32" width="44" height="5" rx="1" /><rect className="weapon-scope" x="72" y="17" width="42" height="8" rx="4" /><circle className="weapon-detail" cx="76" cy="21" r="6" /><circle className="weapon-detail" cx="111" cy="21" r="6" /><path className="weapon-detail" d="M96 50h13l9 12h-17z" /></svg>;
  if (weapon === "smg") return <svg className="weapon-visual smg-visual" viewBox="0 0 180 70" aria-hidden="true"><path className="weapon-shadow" d="M17 49h148v8H17z" /><path className="weapon-stock" d="M25 34 7 23h14l28 12v16H25z" /><path className="weapon-metal" d="M39 29h84l14 9h31v10h-42l-12 8H45L34 48z" /><path className="weapon-barrel" d="M127 34h40v6h-40z" /><path className="weapon-grip" d="M65 53h19l-3 16H62z" /><path className="weapon-mag" d="M96 52h17l8 17h-18z" /><rect className="weapon-accent" x="56" y="34" width="54" height="7" rx="1" /><path className="weapon-detail" d="M41 26h51v5H41zm83 14h32v3h-32z" /></svg>;
  return <svg className="weapon-visual rifle-visual" viewBox="0 0 180 70" aria-hidden="true"><path className="weapon-shadow" d="M7 49h165v8H7z" /><path className="weapon-stock" d="M8 34V22h18l32 15v15H39L23 59H7z" /><path className="weapon-metal" d="M47 27h78l14 9h34v10h-43l-13 9H52L39 47z" /><path className="weapon-barrel" d="M126 31h47v7h-47z" /><path className="weapon-grip" d="M68 52h19l-4 17H64z" /><path className="weapon-mag" d="M97 52h18l7 17h-20z" /><rect className="weapon-accent" x="61" y="33" width="51" height="7" rx="1" /><path className="weapon-detail" d="M68 21h30v7H68zm55 17h35v3h-35z" /><circle className="weapon-bolt" cx="116" cy="39" r="3" /></svg>;
}
