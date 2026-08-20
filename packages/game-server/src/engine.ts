import { MAPS, type ArenaMap, type MapBox, type MapId } from "../../shared/src/map";
import { collidesAt, resolveVerticalMotion } from "../../shared/src/collision";
import { GRAVITY, JUMP_SPEED, MOVE_ACCELERATION, MOVE_SPEED, SPRINT_SPEED } from "../../shared/src/movement";
import type { InputState, KillFeedItem, PlayerSnapshot, Snapshot, Vec3, WeaponId } from "../../shared/src/protocol";
import { WEAPONS } from "../../shared/src/weapons";

const RESPAWN_MS = 2_000;
const MATCH_MS = Number(process.env.MATCH_DURATION_MS ?? 300_000);

interface PlayerState extends PlayerSnapshot {
  velocity: Vec3;
  input: InputState;
  grounded: boolean;
  lastShotAt: number;
  reloadEndsAt: number;
  respawnAt: number;
  nextBotDecision: number;
  nextBotAimAt: number;
  botTargetYaw: number;
  botTargetPitch: number;
  invulnerableUntil: number;
  ammoByWeapon: Record<WeaponId, { ammo: number; reserve: number }>;
  lastInputAt: number;
  suspiciousAimEvents: number;
  aimFlagged: boolean;
}

export interface ShotResult { shooterId: string; hitId: string | null; victimName: string | null; headshot: boolean; damage: number; killed: boolean }

const idleInput = (): InputState => ({ seq: 0, forward: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false });
const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const facingCenter = (v: Vec3): number => Math.atan2(v.x, v.z);

function clampName(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);
  return clean || "GUEST";
}

function raySphere(origin: Vec3, direction: Vec3, center: Vec3, radius: number): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

function rayBox(origin: Vec3, direction: Vec3, box: MapBox): number | null {
  let near = -Infinity;
  let far = Infinity;
  const axes: (keyof Vec3)[] = ["x", "y", "z"];
  const sizes = { x: box.width / 2, y: box.height / 2, z: box.depth / 2 };
  for (const axis of axes) {
    const min = box[axis] - sizes[axis];
    const max = box[axis] + sizes[axis];
    const d = direction[axis];
    if (Math.abs(d) < 1e-8) {
      if (origin[axis] < min || origin[axis] > max) return null;
      continue;
    }
    const t1 = (min - origin[axis]) / d;
    const t2 = (max - origin[axis]) / d;
    near = Math.max(near, Math.min(t1, t2));
    far = Math.min(far, Math.max(t1, t2));
    if (near > far) return null;
  }
  return far >= 0 ? Math.max(0, near) : null;
}

export class GameEngine {
  readonly players = new Map<string, PlayerState>();
  readonly startedAt: number;
  readonly endsAt: number;
  readonly matchId: string;
  readonly mapId: MapId;
  readonly map: ArenaMap;
  private tickNumber = 0;
  private feedId = 0;
  private spawnCursor = 0;
  private ended = false;
  private feed: KillFeedItem[] = [];
  onShot: ((shot: ShotResult) => void) | null = null;
  onRespawn: ((playerId: string, spawnYaw: number) => void) | null = null;
  onSecurityFlag: ((playerId: string, reason: string) => void) | null = null;

  constructor(now = Date.now(), matchId = `dropzone-${now.toString(36)}`, mapId: MapId = "foundry") {
    this.startedAt = now;
    this.endsAt = now + MATCH_MS;
    this.matchId = matchId;
    this.mapId = mapId;
    this.map = MAPS[mapId];
  }

  addPlayer(id: string, name: string, weapon: WeaponId, bot = false): PlayerSnapshot {
    const point = this.map.spawns[this.spawnCursor++ % this.map.spawns.length];
    const config = WEAPONS[weapon];
    const player: PlayerState = {
      id, name: clampName(name), position: clone(point), velocity: { x: 0, y: 0, z: 0 },
      yaw: facingCenter(point), pitch: 0, health: 100, alive: true, weapon, ammo: config.magazine, reserve: config.reserve,
      reloading: false, kills: 0, deaths: 0, score: 0, headshots: 0, bot, input: idleInput(), grounded: true,
      lastShotAt: -Infinity, reloadEndsAt: 0, respawnAt: 0,
      nextBotDecision: bot ? this.startedAt + 900 + this.spawnCursor * 120 : 0,
      nextBotAimAt: this.startedAt, botTargetYaw: facingCenter(point), botTargetPitch: 0,
      invulnerableUntil: this.startedAt + 1_500,
      ammoByWeapon: this.freshAmmoLoadout(), lastInputAt: this.startedAt, suspiciousAimEvents: 0, aimFlagged: false,
    };
    player.input.yaw = player.yaw;
    this.players.set(id, player);
    return this.publicPlayer(player);
  }

  addBots(count: number): void {
    const names = ["VANTA", "NEON", "RIFT", "KILO", "ECHO"];
    const weapons: WeaponId[] = ["rifle", "smg", "sniper"];
    for (let i = 0; i < count; i += 1) this.addPlayer(`bot-${i + 1}`, names[i % names.length], weapons[i % weapons.length], true);
  }

  removePlayer(id: string): void { this.players.delete(id); }

  setInput(id: string, input: InputState, now = Date.now()): void {
    const player = this.players.get(id);
    if (!player || input.seq <= player.input.seq) return;
    const elapsed = Math.max(1 / 120, Math.min(.25, (now - player.lastInputAt) / 1_000));
    const yawDelta = Math.atan2(Math.sin(input.yaw - player.yaw), Math.cos(input.yaw - player.yaw));
    const pitchDelta = input.pitch - player.pitch;
    const hardLimit = .35 + elapsed * 28;
    if (!player.bot && (Math.abs(yawDelta) > hardLimit || Math.abs(pitchDelta) > hardLimit)) {
      player.suspiciousAimEvents += 1;
      input = {
        ...input,
        yaw: player.yaw + Math.max(-hardLimit, Math.min(hardLimit, yawDelta)),
        pitch: player.pitch + Math.max(-hardLimit, Math.min(hardLimit, pitchDelta)),
      };
      if (player.suspiciousAimEvents >= 8 && !player.aimFlagged) {
        player.aimFlagged = true;
        this.onSecurityFlag?.(player.id, "impossible-aim-rate");
      }
    } else if (player.suspiciousAimEvents > 0) {
      player.suspiciousAimEvents -= 1;
    }
    player.input = input;
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.lastInputAt = now;
  }

  switchWeapon(id: string, weapon: WeaponId): void {
    const player = this.players.get(id);
    if (!player || !player.alive || player.weapon === weapon) return;
    player.ammoByWeapon[player.weapon] = { ammo: player.ammo, reserve: player.reserve };
    const stored = player.ammoByWeapon[weapon];
    player.weapon = weapon;
    player.ammo = stored.ammo;
    player.reserve = stored.reserve;
    player.reloading = false;
  }

  reload(id: string, now: number): void {
    const player = this.players.get(id);
    if (!player || !player.alive || player.reloading) return;
    const config = WEAPONS[player.weapon];
    if (player.ammo >= config.magazine || player.reserve <= 0) return;
    player.reloading = true;
    player.reloadEndsAt = now + config.reloadMs;
  }

  fire(id: string, now: number): ShotResult | null {
    const shooter = this.players.get(id);
    if (!shooter || !shooter.alive || this.ended || shooter.reloading) return null;
    const weapon = WEAPONS[shooter.weapon];
    if (now - shooter.lastShotAt < weapon.fireIntervalMs) return null;
    if (shooter.ammo <= 0) { this.reload(id, now); return null; }
    shooter.lastShotAt = now;
    shooter.ammo -= 1;
    shooter.ammoByWeapon[shooter.weapon] = { ammo: shooter.ammo, reserve: shooter.reserve };

    const cp = Math.cos(shooter.pitch);
    const direction = { x: -Math.sin(shooter.yaw) * cp, y: Math.sin(shooter.pitch), z: -Math.cos(shooter.yaw) * cp };
    const origin = { x: shooter.position.x, y: shooter.position.y + 1.55, z: shooter.position.z };
    let wallDistance = weapon.range;
    for (const box of this.map.boxes) {
      const distance = rayBox(origin, direction, box);
      if (distance !== null && distance < wallDistance) wallDistance = distance;
    }

    let best: { target: PlayerState; distance: number; headshot: boolean } | null = null;
    for (const target of this.players.values()) {
      if (target.id === id || !target.alive) continue;
      const head = raySphere(origin, direction, { x: target.position.x, y: target.position.y + 1.55, z: target.position.z }, 0.27);
      const body = raySphere(origin, direction, { x: target.position.x, y: target.position.y + 0.92, z: target.position.z }, 0.58);
      const headshot = head !== null && (body === null || head <= body);
      const distance = headshot ? head : body;
      if (distance !== null && distance < wallDistance && distance <= weapon.range && (!best || distance < best.distance)) best = { target, distance, headshot };
    }

    let appliedDamage = 0;
    let killed = false;
    if (best) {
      const falloff = best.distance <= weapon.falloffStart ? 1 : Math.max(0.55, 1 - (best.distance - weapon.falloffStart) / weapon.range * 0.45);
      const damage = Math.round(weapon.damage * (best.headshot ? weapon.headMultiplier : 1) * falloff);
      const outcome = this.damage(shooter, best.target, damage, best.headshot, now);
      appliedDamage = outcome.damage;
      killed = outcome.killed;
    }
    const result = { shooterId: id, hitId: appliedDamage > 0 ? best?.target.id ?? null : null, victimName: appliedDamage > 0 ? best?.target.name ?? null : null, headshot: appliedDamage > 0 && (best?.headshot ?? false), damage: appliedDamage, killed };
    this.onShot?.(result);
    return result;
  }

  private damage(attacker: PlayerState, victim: PlayerState, amount: number, headshot: boolean, now: number): { damage: number; killed: boolean } {
    if (now < victim.invulnerableUntil) return { damage: 0, killed: false };
    const healthBefore = victim.health;
    victim.health = Math.max(0, victim.health - amount);
    const damage = healthBefore - victim.health;
    if (victim.health > 0) return { damage, killed: false };
    victim.alive = false;
    victim.deaths += 1;
    victim.respawnAt = now + RESPAWN_MS;
    victim.velocity = { x: 0, y: 0, z: 0 };
    attacker.kills += 1;
    if (headshot) attacker.headshots += 1;
    attacker.score += 100 + (headshot ? 50 : 0);
    this.feed.unshift({ id: ++this.feedId, attacker: attacker.name, victim: victim.name, weapon: attacker.weapon, headshot });
    this.feed = this.feed.slice(0, 5);
    return { damage, killed: true };
  }

  private respawn(player: PlayerState, now: number): void {
    const point = this.map.spawns[this.spawnCursor++ % this.map.spawns.length];
    const config = WEAPONS[player.weapon];
    player.ammoByWeapon = this.freshAmmoLoadout();
    player.position = clone(point);
    player.yaw = facingCenter(point);
    player.pitch = 0;
    player.input = { ...idleInput(), seq: player.input.seq + 1, yaw: player.yaw };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.health = 100;
    player.alive = true;
    player.ammo = config.magazine;
    player.reserve = config.reserve;
    player.reloading = false;
    player.respawnAt = 0;
    player.invulnerableUntil = now + 1_500;
    this.onRespawn?.(player.id, player.yaw);
  }

  private updateBot(player: PlayerState, now: number): void {
    const targets = [...this.players.values()].filter((candidate) => candidate.alive && candidate.id !== player.id);
    let nearest: PlayerState | null = null;
    let distance = Infinity;
    for (const target of targets) {
      const d = Math.hypot(target.position.x - player.position.x, target.position.z - player.position.z);
      if (d < distance) { nearest = target; distance = d; }
    }
    if (!nearest) return;
    const dx = nearest.position.x - player.position.x;
    const dz = nearest.position.z - player.position.z;
    const wobble = Math.sin(now / 310 + player.id.length * 1.7);
    if (now >= player.nextBotAimAt) {
      const aimDrift = Math.sin(now / 730 + player.id.length) * 0.11 + Math.sin(now / 190) * 0.035;
      player.botTargetYaw = Math.atan2(-dx, -dz) + aimDrift;
      player.botTargetPitch = Math.max(-0.4, Math.min(0.4, Math.atan2(nearest.position.y - player.position.y - .48, Math.max(1, distance)) + wobble * .045));
      player.nextBotAimAt = now + 320 + Math.abs(wobble) * 260;
    }
    const yawDelta = Math.atan2(Math.sin(player.botTargetYaw - player.yaw), Math.cos(player.botTargetYaw - player.yaw));
    player.yaw += yawDelta * 0.085;
    player.pitch += (player.botTargetPitch - player.pitch) * 0.09;
    player.input = { ...player.input, seq: player.input.seq + 1, yaw: player.yaw, pitch: player.pitch, forward: distance > 8 ? 0.62 : distance < 4 ? -0.34 : 0, strafe: Math.sin(now / 1100 + this.spawnCursor) * 0.28, sprint: distance > 17, jump: false };
    if (now >= player.nextBotDecision && distance < WEAPONS[player.weapon].range && Math.abs(yawDelta) < 0.24) {
      player.nextBotDecision = now + 560 + Math.abs(wobble) * 440;
      this.fire(player.id, now);
    }
  }

  tick(dtSeconds: number, now: number): void {
    if (!this.ended && now >= this.endsAt) this.ended = true;
    this.tickNumber += 1;
    for (const player of this.players.values()) {
      if (!player.alive) { if (!this.ended && now >= player.respawnAt) this.respawn(player, now); continue; }
      if (player.reloading && now >= player.reloadEndsAt) {
        const weapon = WEAPONS[player.weapon];
        const needed = weapon.magazine - player.ammo;
        const moved = Math.min(needed, player.reserve);
        player.ammo += moved;
        player.reserve -= moved;
        player.ammoByWeapon[player.weapon] = { ammo: player.ammo, reserve: player.reserve };
        player.reloading = false;
      }
      if (player.bot) this.updateBot(player, now);
      const input = player.input;
      const length = Math.hypot(input.forward, input.strafe) || 1;
      const forward = input.forward / Math.max(1, length);
      const strafe = input.strafe / Math.max(1, length);
      const speed = input.sprint ? SPRINT_SPEED : MOVE_SPEED;
      const vx = (-Math.sin(player.yaw) * forward + Math.cos(player.yaw) * strafe) * speed;
      const vz = (-Math.cos(player.yaw) * forward - Math.sin(player.yaw) * strafe) * speed;
      player.velocity.x += (vx - player.velocity.x) * Math.min(1, dtSeconds * MOVE_ACCELERATION);
      player.velocity.z += (vz - player.velocity.z) * Math.min(1, dtSeconds * MOVE_ACCELERATION);
      if (player.bot && player.grounded && Math.hypot(vx, vz) > 1) {
        const distance = Math.hypot(vx, vz);
        const probe = { ...player.position, x: player.position.x + vx / distance * .85, z: player.position.z + vz / distance * .85 };
        if (collidesAt(probe, this.map)) player.input.jump = true;
      }
      if (input.jump && player.grounded) { player.velocity.y = JUMP_SPEED; player.grounded = false; }
      player.velocity.y -= GRAVITY * dtSeconds;
      const nextX = { ...player.position, x: player.position.x + player.velocity.x * dtSeconds };
      if (!collidesAt(nextX, this.map)) player.position.x = nextX.x; else player.velocity.x = 0;
      const nextZ = { ...player.position, z: player.position.z + player.velocity.z * dtSeconds };
      if (!collidesAt(nextZ, this.map)) player.position.z = nextZ.z; else player.velocity.z = 0;
      const vertical = resolveVerticalMotion(player.position, player.position.y + player.velocity.y * dtSeconds, player.velocity.y, this.map);
      player.position.y = vertical.y; player.velocity.y = vertical.velocityY; player.grounded = vertical.grounded;
      player.input.jump = false;
    }
  }

  snapshot(now: number): Snapshot {
    return {
      serverTime: now, tick: this.tickNumber,
      match: { id: this.matchId, mapId: this.mapId, phase: this.ended ? "ended" : "playing", startedAt: this.startedAt, endsAt: this.endsAt, remainingMs: Math.max(0, this.endsAt - now) },
      players: [...this.players.values()].map((player) => this.publicPlayer(player)), feed: this.feed,
    };
  }

  snapshotFor(viewerId: string, now: number): Snapshot {
    const viewer = this.players.get(viewerId);
    if (!viewer) return this.snapshot(now);
    return {
      serverTime: now,
      tick: this.tickNumber,
      match: { id: this.matchId, mapId: this.mapId, phase: this.ended ? "ended" : "playing", startedAt: this.startedAt, endsAt: this.endsAt, remainingMs: Math.max(0, this.endsAt - now) },
      players: [...this.players.values()].map((player) => {
        const visible = player.id === viewerId || (!player.alive ? false : this.hasLineOfSight(viewer, player));
        return this.publicPlayer(player, visible);
      }),
      feed: this.feed,
    };
  }

  private publicPlayer(player: PlayerState, visible = true): PlayerSnapshot {
    return {
      id: player.id, name: player.name, position: visible ? clone(player.position) : { x: 0, y: -1000, z: 0 }, yaw: visible ? player.yaw : 0, pitch: visible ? player.pitch : 0,
      health: visible ? player.health : 0, alive: player.alive, weapon: visible ? player.weapon : "rifle", ammo: visible ? player.ammo : 0, reserve: visible ? player.reserve : 0,
      reloading: visible ? player.reloading : false, kills: player.kills, deaths: player.deaths, score: player.score, bot: player.bot, headshots: player.headshots, visible,
    };
  }

  private freshAmmoLoadout(): Record<WeaponId, { ammo: number; reserve: number }> {
    return {
      rifle: { ammo: WEAPONS.rifle.magazine, reserve: WEAPONS.rifle.reserve },
      sniper: { ammo: WEAPONS.sniper.magazine, reserve: WEAPONS.sniper.reserve },
      smg: { ammo: WEAPONS.smg.magazine, reserve: WEAPONS.smg.reserve },
    };
  }

  private hasLineOfSight(viewer: PlayerState, target: PlayerState): boolean {
    const origin = { x: viewer.position.x, y: viewer.position.y + 1.55, z: viewer.position.z };
    for (const height of [.45, 1.05, 1.55]) {
      const dx = target.position.x - origin.x;
      const dy = target.position.y + height - origin.y;
      const dz = target.position.z - origin.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance <= 0.001) return true;
      const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
      let blocked = false;
      for (const box of this.map.boxes) {
        const hit = rayBox(origin, direction, box);
        if (hit !== null && hit < distance - .08) { blocked = true; break; }
      }
      if (!blocked) return true;
    }
    return false;
  }
}
