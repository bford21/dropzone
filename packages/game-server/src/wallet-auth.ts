import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const encoder = new TextEncoder();
const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

function bytesFromHex(value: string): Uint8Array | null {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) return null;
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function personalMessageDigest(message: string): Uint8Array {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\u0019Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

export function normalizeWallet(value: string): string | null {
  const normalized = value.toLowerCase();
  return WALLET_PATTERN.test(normalized) ? normalized : null;
}

export function createAuthChallenge(sessionId: string, matchId: string, expiresAt: number): string {
  const nonce = randomBytes(18).toString("hex");
  return [
    "Dropzone Game Mode admission",
    `Session: ${sessionId}`,
    `Match: ${matchId}`,
    `Expires: ${expiresAt}`,
    `Nonce: ${nonce}`,
    "Sign only if you are joining this Dropzone match.",
  ].join("\n");
}

export function recoverWalletFromPersonalSignature(message: string, signatureHex: string): string | null {
  const signature = bytesFromHex(signatureHex);
  if (!signature || signature.length !== 65) return null;
  const recovery = signature[64] >= 27 ? signature[64] - 27 : signature[64];
  if (recovery > 3) return null;
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(signature.subarray(0, 64), 1);
  try {
    const publicKey = secp256k1.recoverPublicKey(recovered, personalMessageDigest(message), { prehash: false });
    const address = `0x${Array.from(keccak_256(publicKey.subarray(1)).slice(-20), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return normalizeWallet(address);
  } catch {
    return null;
  }
}

export function verifyWalletSignature(message: string, signature: string, claimedPlayerId: string): boolean {
  const claimed = normalizeWallet(claimedPlayerId);
  return claimed !== null && recoverWalletFromPersonalSignature(message, signature) === claimed;
}
