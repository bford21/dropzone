import type { WeaponId } from "./protocol";

export interface WeaponConfig {
  id: WeaponId;
  label: string;
  magazine: number;
  reserve: number;
  damage: number;
  headMultiplier: number;
  fireIntervalMs: number;
  reloadMs: number;
  range: number;
  falloffStart: number;
}

export const WEAPONS: Record<WeaponId, WeaponConfig> = {
  rifle: { id: "rifle", label: "RIFLE", magazine: 30, reserve: 90, damage: 34, headMultiplier: 1.5, fireIntervalMs: 120, reloadMs: 1500, range: 80, falloffStart: 50 },
  sniper: { id: "sniper", label: "SNIPER", magazine: 5, reserve: 20, damage: 100, headMultiplier: 1.5, fireIntervalMs: 900, reloadMs: 2100, range: 120, falloffStart: 120 },
  smg: { id: "smg", label: "SMG", magazine: 36, reserve: 108, damage: 22, headMultiplier: 1.5, fireIntervalMs: 75, reloadMs: 1350, range: 60, falloffStart: 22 },
};
