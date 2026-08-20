import type { ArenaMap, MapBox } from "./map";
import type { Vec3 } from "./protocol";

export const PLAYER_RADIUS = .48;
export const PLAYER_HEIGHT = 1.75;

function overlapsFootprint(x: number, z: number, box: MapBox): boolean {
  const closestX = Math.max(box.x - box.width / 2, Math.min(x, box.x + box.width / 2));
  const closestZ = Math.max(box.z - box.depth / 2, Math.min(z, box.z + box.depth / 2));
  const dx = x - closestX;
  const dz = z - closestZ;
  return dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS;
}

export function isStandingOnSurface(position: Vec3, map: ArenaMap): boolean {
  if (Math.abs(position.y) <= .04) return true;
  for (const box of map.boxes) {
    if (!overlapsFootprint(position.x, position.z, box)) continue;
    if (Math.abs(position.y - (box.y + box.height / 2)) <= .04) return true;
  }
  return false;
}

export function collidesAt(position: Vec3, map: ArenaMap): boolean {
  if (Math.abs(position.x) > map.halfSize - PLAYER_RADIUS || Math.abs(position.z) > map.halfSize - PLAYER_RADIUS) return true;
  for (const box of map.boxes) {
    if (position.y >= box.y + box.height / 2 || position.y + PLAYER_HEIGHT <= box.y - box.height / 2) continue;
    if (overlapsFootprint(position.x, position.z, box)) return true;
  }
  return false;
}

export interface VerticalResolution {
  y: number;
  velocityY: number;
  grounded: boolean;
}

export function resolveVerticalMotion(position: Vec3, nextY: number, velocityY: number, map: ArenaMap): VerticalResolution {
  if (velocityY <= 0) {
    let floor = 0;
    for (const box of map.boxes) {
      if (!overlapsFootprint(position.x, position.z, box)) continue;
      const top = box.y + box.height / 2;
      if (position.y >= top - .03 && nextY <= top) floor = Math.max(floor, top);
    }
    if (nextY <= floor) return { y: floor, velocityY: 0, grounded: true };
  } else {
    let ceiling = Infinity;
    const currentHead = position.y + PLAYER_HEIGHT;
    const nextHead = nextY + PLAYER_HEIGHT;
    for (const box of map.boxes) {
      if (!overlapsFootprint(position.x, position.z, box)) continue;
      const bottom = box.y - box.height / 2;
      if (currentHead <= bottom + .03 && nextHead >= bottom) ceiling = Math.min(ceiling, bottom);
    }
    if (ceiling < Infinity) return { y: ceiling - PLAYER_HEIGHT, velocityY: 0, grounded: false };
  }
  return { y: nextY, velocityY, grounded: false };
}
