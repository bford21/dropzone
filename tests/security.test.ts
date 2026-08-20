import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { AwardSigner } from "../packages/game-server/src/award-signer";
import { clientIp, isAllowedOrigin, TokenBucket } from "../packages/game-server/src/security";
import { recoverWalletFromPersonalSignature, verifyWalletSignature } from "../packages/game-server/src/wallet-auth";

const encoder = new TextEncoder();

function ethereumDigest(message: string): Uint8Array {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\u0019Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

function ethereumSignature(message: string, secretKey: Uint8Array): string {
  const recovered = secp256k1.sign(ethereumDigest(message), secretKey, { prehash: false, format: "recovered" });
  const ethereum = new Uint8Array(65);
  ethereum.set(recovered.subarray(1), 0);
  ethereum[64] = recovered[0] + 27;
  return `0x${Array.from(ethereum, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

test("wallet admission binds the exact challenge and address", () => {
  const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const challenge = "Dropzone one-time challenge";
  const signature = ethereumSignature(challenge, secretKey);
  const wallet = recoverWalletFromPersonalSignature(challenge, signature);
  assert.match(wallet ?? "", /^0x[0-9a-f]{40}$/);
  assert.equal(verifyWalletSignature(challenge, signature, wallet!), true);
  assert.equal(verifyWalletSignature(`${challenge}!`, signature, wallet!), false);
  assert.equal(verifyWalletSignature(challenge, signature, `0x${"0".repeat(40)}`), false);
});

test("message token bucket allows normal play and rejects floods", () => {
  const bucket = new TokenBucket(4, 2, 1_000);
  assert.equal(bucket.take(1, 1_000), true);
  assert.equal(bucket.take(3, 1_000), true);
  assert.equal(bucket.take(1, 1_000), false);
  assert.equal(bucket.take(1, 1_500), true);
});

test("production origin checks fail closed", () => {
  const origins = new Set(["https://play.example"]);
  assert.equal(isAllowedOrigin("https://play.example", origins, true), true);
  assert.equal(isAllowedOrigin("https://evil.example", origins, true), false);
  assert.equal(isAllowedOrigin(undefined, origins, true), false);
  assert.equal(isAllowedOrigin(undefined, new Set(), false), true);
});

test("forwarded addresses are trusted only behind an explicitly trusted proxy", () => {
  const headers = { "x-forwarded-for": "203.0.113.8, 10.0.0.2" };
  assert.equal(clientIp(headers, "127.0.0.1", false), "127.0.0.1");
  assert.equal(clientIp(headers, "127.0.0.1", true), "203.0.113.8");
});

test("production signer refuses the known development seed fallback", () => {
  assert.throws(() => new AwardSigner("", true), /required in production/);
});
