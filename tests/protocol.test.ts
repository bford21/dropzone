import assert from "node:assert/strict";
import test from "node:test";
import { parseClientMessage } from "../packages/shared/src/protocol";

test("input parser clamps hostile movement and aim values", () => {
  const message = parseClientMessage({ type: "input", input: { seq: 2.9, forward: 999, strafe: -999, yaw: 1e9, pitch: 99, jump: true, sprint: true, position: { x: 999 } } });
  assert.equal(message?.type, "input");
  if (message?.type !== "input") return;
  assert.equal(message.input.seq, 2);
  assert.equal(message.input.forward, 1);
  assert.equal(message.input.strafe, -1);
  assert.equal(message.input.pitch, 1.45);
  assert.equal("position" in message.input, false);
});

test("unsupported client score messages are rejected", () => {
  assert.equal(parseClientMessage({ type: "score", score: 999_999 }), null);
});

test("non-finite inputs and malformed wallet proofs are rejected", () => {
  assert.equal(parseClientMessage({ type: "input", input: { seq: 1, forward: Number.NaN, strafe: 0, yaw: 0, pitch: 0 } }), null);
  assert.equal(parseClientMessage({ type: "identity", playerId: `0x${"1".repeat(40)}`, signature: "not-a-signature" }), null);
});

test("join messages accept only a known arena", () => {
  assert.deepEqual(parseClientMessage({ type: "join", name: "ACE", weapon: "rifle", mapId: "citadel", mode: "training", botCount: 5 }), { type: "join", name: "ACE", weapon: "rifle", mapId: "citadel", mode: "training", botCount: 5 });
  assert.deepEqual(parseClientMessage({ type: "join", name: "ACE", weapon: "rifle", mapId: "foundry", mode: "pvp", botCount: 0 }), { type: "join", name: "ACE", weapon: "rifle", mapId: "foundry", mode: "pvp", botCount: 0 });
  assert.equal(parseClientMessage({ type: "join", name: "ACE", weapon: "rifle", mapId: "client-cheat-map", mode: "training", botCount: 3 }), null);
  assert.equal(parseClientMessage({ type: "join", name: "ACE", weapon: "rifle", mapId: "foundry", mode: "training", botCount: 99 }), null);
  assert.equal(parseClientMessage({ type: "join", name: "ACE", weapon: "rifle", mapId: "foundry", mode: "pvp", botCount: 3 }), null);
  assert.equal(parseClientMessage({ type: "join", name: "ACE", weapon: "rifle", mapId: "foundry" }), null);
});

test("ready messages require an explicit boolean", () => {
  assert.deepEqual(parseClientMessage({ type: "ready", ready: true }), { type: "ready", ready: true });
  assert.equal(parseClientMessage({ type: "ready", ready: 1 }), null);
});

test("voice state and bounded WebRTC descriptions are accepted", () => {
  assert.deepEqual(parseClientMessage({ type: "voiceState", enabled: true }), { type: "voiceState", enabled: true });
  assert.deepEqual(parseClientMessage({ type: "voiceSignal", toPlayerId: "peer-2", signal: { kind: "description", description: { type: "offer", sdp: "v=0\r\n" } } }), {
    type: "voiceSignal",
    toPlayerId: "peer-2",
    signal: { kind: "description", description: { type: "offer", sdp: "v=0\r\n" } },
  });
});

test("malformed or oversized voice signaling is rejected", () => {
  assert.equal(parseClientMessage({ type: "voiceState", enabled: "yes" }), null);
  assert.equal(parseClientMessage({ type: "voiceSignal", toPlayerId: "peer/2", signal: { kind: "description", description: { type: "offer", sdp: "v=0" } } }), null);
  assert.equal(parseClientMessage({ type: "voiceSignal", toPlayerId: "peer-2", signal: { kind: "description", description: { type: "offer", sdp: "x".repeat(10_001) } } }), null);
  assert.equal(parseClientMessage({ type: "voiceSignal", toPlayerId: "peer-2", signal: { kind: "candidate", candidate: { candidate: "candidate", sdpMid: 1, sdpMLineIndex: 0 } } }), null);
});
