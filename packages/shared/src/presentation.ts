import type { Vec3 } from "./protocol";

export function damageIndicatorAngle(source: Vec3, target: Vec3, yaw: number): number {
  const dx = source.x - target.x;
  const dz = source.z - target.z;
  const forward = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
  const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
  return Math.atan2(right, forward) * 180 / Math.PI;
}

export function nextOpponentHealthFraction(previous: number, receivedHealth: number, visible: boolean, alive: boolean): number {
  if (!alive) return 1;
  if (!visible || !Number.isFinite(receivedHealth)) return previous;
  return Math.max(0, Math.min(100, receivedHealth)) / 100;
}

export function shouldSnapOpponentPosition(wasVisible: boolean, visible: boolean, distanceSquared: number): boolean {
  return visible && (!wasVisible || distanceSquared > 64);
}

export function hasVoiceActivity(samples: Uint8Array, threshold = .035): boolean {
  if (samples.length === 0) return false;
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const amplitude = (samples[index] - 128) / 128;
    energy += amplitude * amplitude;
  }
  return Math.sqrt(energy / samples.length) >= threshold;
}
