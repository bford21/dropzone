import { ed25519 } from "@noble/curves/ed25519.js";
import type { AwardClaim, SignedAwardClaim } from "../../shared/src/protocol";

const encoder = new TextEncoder();

export function encodeAwardClaim(claim: AwardClaim): Uint8Array {
  return encoder.encode([
    "dropzone-award-v2", claim.matchId, claim.playerId.toLowerCase(), String(claim.points),
    String(claim.kills), String(claim.headshots), String(claim.issuedAt), claim.nonce, claim.eventHash,
  ].join("|"));
}

export function hexToBytes(value: string): Uint8Array | null {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) return null;
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export function bytesToHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function verifyAwardClaim(award: SignedAwardClaim, publicKeyHex: string): boolean {
  const signature = hexToBytes(award.signature);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || !publicKey || signature.length !== 64 || publicKey.length !== 32) return false;
  try { return ed25519.verify(signature, encodeAwardClaim(award.claim), publicKey); }
  catch { return false; }
}
