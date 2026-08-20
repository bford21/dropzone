import assert from "node:assert/strict";
import test from "node:test";
import { Round } from "@flayerlabs/gamemode-spec/round";
import { AwardSigner } from "../packages/game-server/src/award-signer";
import { dropzoneRules } from "../packages/flaunch/src/rules";

const eventHash = "a".repeat(64);

test("a signed authoritative result becomes Flaunch points", () => {
  const signer = new AwardSigner();
  const opensAt = 1_000_000;
  const player = "0xplayer";
  const round = Round.start(dropzoneRules, { serverPublicKey: signer.publicKey, maxPointsPerPlayer: 50_000 }, 47, { opensAt, closesAt: opensAt + 600_000 });
  const award = signer.sign({ matchId: "match-1", playerId: player, points: 350, kills: 3, headshots: 1, issuedAt: opensAt + 10_000, nonce: "unique-1", eventHash });
  round.send({ kind: "action", player, action: { type: "claim", award }, at: opensAt + 10_000 });
  assert.equal(round.pointsFor(player), 350);
  assert.equal(round.playerView(player).points, 350);
});

test("a browser-tampered award is refused", () => {
  const signer = new AwardSigner();
  const opensAt = 1_000_000;
  const player = "0xplayer";
  const round = Round.start(dropzoneRules, { serverPublicKey: signer.publicKey, maxPointsPerPlayer: 50_000 }, 47, { opensAt, closesAt: opensAt + 600_000 });
  const award = signer.sign({ matchId: "match-1", playerId: player, points: 100, kills: 1, headshots: 0, issuedAt: opensAt + 10_000, nonce: "unique-2", eventHash });
  award.claim.points = 50_000;
  round.send({ kind: "action", player, action: { type: "claim", award }, at: opensAt + 10_000 });
  assert.equal(round.pointsFor(player), 0);
});

test("the same match result cannot be claimed twice", () => {
  const signer = new AwardSigner();
  const opensAt = 1_000_000;
  const player = "0xplayer";
  const round = Round.start(dropzoneRules, { serverPublicKey: signer.publicKey, maxPointsPerPlayer: 50_000 }, 47, { opensAt, closesAt: opensAt + 600_000 });
  const award = signer.sign({ matchId: "match-1", playerId: player, points: 100, kills: 1, headshots: 0, issuedAt: opensAt + 10_000, nonce: "unique-3", eventHash });
  round.send({ kind: "action", player, action: { type: "claim", award }, at: opensAt + 10_000 });
  round.send({ kind: "action", player, action: { type: "claim", award }, at: opensAt + 11_000 });
  assert.equal(round.pointsFor(player), 100);
});

test("player casing cannot bypass match replay protection", () => {
  const signer = new AwardSigner();
  const opensAt = 1_000_000;
  const round = Round.start(dropzoneRules, { serverPublicKey: signer.publicKey, maxPointsPerPlayer: 50_000 }, 47, { opensAt, closesAt: opensAt + 600_000 });
  const award = signer.sign({ matchId: "case-match", playerId: "0xabcdef", points: 100, kills: 1, headshots: 0, issuedAt: opensAt + 10_000, nonce: "case-one", eventHash });
  round.send({ kind: "action", player: "0xABCDEF", action: { type: "claim", award }, at: opensAt + 10_000 });
  round.send({ kind: "action", player: "0xabcdef", action: { type: "claim", award }, at: opensAt + 11_000 });
  assert.equal(round.pointsFor("0xabcdef"), 100);
  assert.equal(round.playerView("0xABCDEF").claimedMatches.length, 1);
});

test("signed but inconsistent score formulas are refused", () => {
  const signer = new AwardSigner();
  const opensAt = 1_000_000;
  const player = "0xplayer";
  const round = Round.start(dropzoneRules, { serverPublicKey: signer.publicKey, maxPointsPerPlayer: 50_000 }, 47, { opensAt, closesAt: opensAt + 600_000 });
  const award = signer.sign({ matchId: "bad-score", playerId: player, points: 150, kills: 1, headshots: 0, issuedAt: opensAt + 10_000, nonce: "bad-score", eventHash });
  round.send({ kind: "action", player, action: { type: "claim", award }, at: opensAt + 10_000 });
  assert.equal(round.pointsFor(player), 0);
});

test("claim parser rejects unknown and oversized fields", () => {
  const signer = new AwardSigner();
  const award = signer.sign({ matchId: "strict", playerId: "0xplayer", points: 100, kills: 1, headshots: 0, issuedAt: 1_000_000, nonce: "strict", eventHash });
  assert.equal(dropzoneRules.parseAction({ type: "claim", award, padding: "x".repeat(3_000) }), null);
  assert.equal(dropzoneRules.parseAction({ type: "claim", award: { ...award, claim: { ...award.claim, admin: true } } }), null);
});
