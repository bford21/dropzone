import assert from "node:assert/strict";
import test from "node:test";
import { randomCallsign } from "../packages/shared/src/names";

test("random player callsigns are readable and protocol-safe", () => {
  assert.equal(randomCallsign(() => 0), "ASH_ACE");
  assert.equal(randomCallsign(() => .9999), "WILD_WOLF");
  assert.match(randomCallsign(() => .42), /^[A-Z]+_[A-Z]+$/);
  assert.ok(randomCallsign(() => .73).length <= 16);
});
