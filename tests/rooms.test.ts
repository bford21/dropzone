import assert from "node:assert/strict";
import test from "node:test";
import { canJoinPvp, canStartPvp, playersInVoiceRange, requiredReadyCount, VOICE_PROXIMITY_RADIUS } from "../packages/shared/src/rooms";

test("PVP requires at least two real players", () => {
  assert.equal(canStartPvp(0, 0), false);
  assert.equal(canStartPvp(1, 1), false);
  assert.equal(canStartPvp(2, 2), true);
});

test("players can create or join a lobby but cannot enter an active match", () => {
  assert.equal(canJoinPvp(null), true);
  assert.equal(canJoinPvp("lobby"), true);
  assert.equal(canJoinPvp("playing"), false);
  assert.equal(canJoinPvp("ending"), false);
});

test("PVP starts only when a strict majority is ready", () => {
  assert.equal(requiredReadyCount(2), 2);
  assert.equal(requiredReadyCount(3), 2);
  assert.equal(requiredReadyCount(4), 3);
  assert.equal(requiredReadyCount(5), 3);
  assert.equal(canStartPvp(3, 1), false);
  assert.equal(canStartPvp(3, 2), true);
  assert.equal(canStartPvp(4, 2), false);
  assert.equal(canStartPvp(4, 3), true);
});

test("proximity voice uses the shared authoritative radius", () => {
  const origin = { x: 0, y: 0, z: 0 };
  assert.equal(VOICE_PROXIMITY_RADIUS, 18);
  assert.equal(playersInVoiceRange(origin, { x: 18, y: 0, z: 0 }), true);
  assert.equal(playersInVoiceRange(origin, { x: 12, y: 6, z: 9 }), true);
  assert.equal(playersInVoiceRange(origin, { x: 18.01, y: 0, z: 0 }), false);
});
