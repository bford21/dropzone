import assert from "node:assert/strict";
import test from "node:test";
import { damageIndicatorAngle, hasVoiceActivity, nextOpponentHealthFraction, shouldSnapOpponentPosition } from "../packages/shared/src/presentation";

test("damage indicators point toward the attacker relative to view yaw", () => {
  const target = { x: 0, y: 1, z: 0 };
  assert.equal(damageIndicatorAngle({ x: 0, y: 1, z: -10 }, target, 0), 0);
  assert.equal(damageIndicatorAngle({ x: 10, y: 1, z: 0 }, target, 0), 90);
  assert.equal(damageIndicatorAngle({ x: -10, y: 1, z: 0 }, target, 0), -90);
  assert.equal(Math.abs(damageIndicatorAngle({ x: 0, y: 1, z: 10 }, target, 0)), 180);
  assert.ok(Math.abs(damageIndicatorAngle({ x: -10, y: 1, z: 0 }, target, Math.PI / 2)) < 1e-10);
});

test("redacted hidden health does not overwrite the last visible health meter", () => {
  assert.equal(nextOpponentHealthFraction(1, 0, false, true), 1);
  assert.equal(nextOpponentHealthFraction(.66, 0, false, true), .66);
  assert.equal(nextOpponentHealthFraction(.32, 0, false, false), 1);
  assert.equal(nextOpponentHealthFraction(.66, Number.NaN, true, true), .66);
});

test("a dead opponent resets its cached meter before respawn", () => {
  const afterDeath = nextOpponentHealthFraction(.08, 0, false, false);
  assert.equal(afterDeath, 1);
  assert.equal(nextOpponentHealthFraction(afterDeath, 0, false, true), 1);
  assert.equal(nextOpponentHealthFraction(afterDeath, 100, true, true), 1);
});

test("visible opponent health updates and remains bounded", () => {
  assert.equal(nextOpponentHealthFraction(1, 66, true, true), .66);
  assert.equal(nextOpponentHealthFraction(.66, 100, true, true), 1);
  assert.equal(nextOpponentHealthFraction(.66, 500, true, true), 1);
  assert.equal(nextOpponentHealthFraction(.66, -10, true, true), 0);
});

test("opponents snap on respawn or reappearance but interpolate normal movement", () => {
  assert.equal(shouldSnapOpponentPosition(false, true, 400), true);
  assert.equal(shouldSnapOpponentPosition(true, true, 4), false);
  assert.equal(shouldSnapOpponentPosition(true, true, 81), true);
  assert.equal(shouldSnapOpponentPosition(true, false, 400), false);
});

test("voice activity ignores silence and detects speech-level energy", () => {
  assert.equal(hasVoiceActivity(new Uint8Array(128).fill(128)), false);
  assert.equal(hasVoiceActivity(Uint8Array.from({ length: 128 }, (_, index) => index % 2 ? 130 : 126)), false);
  assert.equal(hasVoiceActivity(Uint8Array.from({ length: 128 }, (_, index) => index % 2 ? 176 : 80)), true);
});
