export const PVP_MINIMUM_PLAYERS = 2;
export const VOICE_PROXIMITY_RADIUS = 18;

export function requiredReadyCount(playerCount: number): number {
  return Math.floor(Math.max(0, playerCount) / 2) + 1;
}

export function canStartPvp(playerCount: number, readyCount: number): boolean {
  return playerCount >= PVP_MINIMUM_PLAYERS && readyCount >= requiredReadyCount(playerCount);
}

export function canJoinPvp(status: "lobby" | "playing" | "ending" | null): boolean {
  return status === null || status === "lobby";
}

export function playersInVoiceRange(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, radius = VOICE_PROXIMITY_RADIUS): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= radius;
}
