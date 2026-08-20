import assert from "node:assert/strict";
import test from "node:test";
import { GameEngine } from "../packages/game-server/src/engine";
import { collidesAt } from "../packages/shared/src/collision";
import { MAPS, mapForPlayerCount, mapForRoomJoin, type MapId } from "../packages/shared/src/map";

test("room population selects small, medium, and large arenas", () => {
  assert.equal(mapForPlayerCount(1), "foundry");
  assert.equal(mapForPlayerCount(4), "foundry");
  assert.equal(mapForPlayerCount(5), "switchyard");
  assert.equal(mapForPlayerCount(8), "switchyard");
  assert.equal(mapForPlayerCount(9), "citadel");
  assert.equal(mapForPlayerCount(12), "citadel");
});

test("the first player chooses the arena while active rooms keep their map", () => {
  assert.equal(mapForRoomJoin("foundry", "citadel", 0), "citadel");
  assert.equal(mapForRoomJoin("citadel", "switchyard", 1), "citadel");
  assert.equal(mapForRoomJoin("citadel", "switchyard", 0, "foundry"), "foundry");
});

test("every arena publishes its authoritative map and valid spawns", () => {
  for (const mapId of Object.keys(MAPS) as MapId[]) {
    const engine = new GameEngine(1_000, `test-${mapId}`, mapId);
    const player = engine.addPlayer("p1", "PLAYER", "rifle");
    assert.equal(engine.snapshot(1_000).match.mapId, mapId);
    assert.ok(Math.abs(player.position.x) < MAPS[mapId].halfSize);
    assert.ok(Math.abs(player.position.z) < MAPS[mapId].halfSize);
    assert.ok(MAPS[mapId].spawns.length >= 8);
    assert.ok(MAPS[mapId].spawns.every((spawn) => !collidesAt(spawn, MAPS[mapId])));
  }
});

test("every arena has jump routes and elevated firing positions", () => {
  const minimumSteps: Record<MapId, number> = { foundry: 8, switchyard: 20, citadel: 24 };
  const minimumElevation: Record<MapId, number> = { foundry: 3.4, switchyard: 3.8, citadel: 4.7 };
  for (const mapId of Object.keys(MAPS) as MapId[]) {
    const map = MAPS[mapId];
    assert.ok(map.boxes.filter((box) => box.kind === "step").length >= minimumSteps[mapId]);
    assert.ok(Math.max(...map.boxes.map((box) => box.y + box.height / 2)) >= minimumElevation[mapId]);
  }
});

test("large environmental props have authoritative collision proxies", () => {
  const props = [
    { map: MAPS.foundry, position: { x: -15.3, y: 0, z: 6.05 } },
    { map: MAPS.switchyard, position: { x: 27, y: 0, z: -13.25 } },
    { map: MAPS.citadel, position: { x: -8, y: 0, z: 21 } },
    { map: MAPS.citadel, position: { x: -25, y: 0, z: -14 } },
  ];
  for (const prop of props) assert.equal(collidesAt(prop.position, prop.map), true);
  assert.ok(Object.values(MAPS).every((map) => map.boxes.some((box) => box.kind === "collision")));
});

test("stair landings do not overlap coplanar deck surfaces", () => {
  for (const map of Object.values(MAPS)) {
    for (const step of map.boxes.filter((box) => box.kind === "step")) {
      const stepTop = step.y + step.height / 2;
      for (const deck of map.boxes.filter((box) => box.kind === "platform")) {
        if (Math.abs(stepTop - (deck.y + deck.height / 2)) > .005) continue;
        const overlapX = Math.min(step.x + step.width / 2, deck.x + deck.width / 2) - Math.max(step.x - step.width / 2, deck.x - deck.width / 2);
        const overlapZ = Math.min(step.z + step.depth / 2, deck.z + deck.depth / 2) - Math.max(step.z - step.depth / 2, deck.z - deck.depth / 2);
        assert.ok(overlapX <= .001 || overlapZ <= .001, `${map.id} has a coplanar stair/deck overlap`);
      }
    }
  }
});

test("players land on map objects and can jump again from high ground", () => {
  const engine = new GameEngine(1_000, "test-platform-landing", "foundry");
  engine.addPlayer("p1", "CLIMBER", "rifle");
  const player = engine.players.get("p1")!;
  const step = engine.map.boxes.find((box) => box.kind === "step")!;
  const top = step.y + step.height / 2;
  player.position = { x: step.x, y: top + .12, z: step.z };
  player.velocity = { x: 0, y: -1, z: 0 };
  player.grounded = false;
  engine.tick(.1, 1_100);
  assert.equal(player.position.y, top);
  assert.equal(player.grounded, true);
  engine.setInput("p1", { seq: 1, forward: 0, strafe: 0, yaw: 0, pitch: 0, jump: true, sprint: false }, 1_101);
  engine.tick(1 / 30, 1_134);
  assert.ok(player.position.y > top);
  assert.equal(player.grounded, false);
});

test("each arena's central stair route is traversable with normal movement and jumps", () => {
  const routes: Record<MapId, { startZ: number; elevation: number }> = {
    foundry: { startZ: -10, elevation: 2.8 },
    switchyard: { startZ: -12.2, elevation: 3.2 },
    citadel: { startZ: -14.9, elevation: 3.9 },
  };
  for (const mapId of Object.keys(routes) as MapId[]) {
    const engine = new GameEngine(1_000, `test-stair-route-${mapId}`, mapId);
    engine.addPlayer("p1", "CLIMBER", "rifle");
    const player = engine.players.get("p1")!;
    player.position = { x: 0, y: 0, z: routes[mapId].startZ };
    player.yaw = Math.PI;
    player.input = { seq: 0, forward: 1, strafe: 0, yaw: Math.PI, pitch: 0, jump: false, sprint: false };
    let maximumHeight = 0;
    for (let step = 1; step <= 270; step += 1) {
      engine.setInput("p1", { seq: step, forward: 1, strafe: 0, yaw: Math.PI, pitch: 0, jump: player.grounded, sprint: false }, 1_000 + step * 16);
      engine.tick(1 / 60, 1_000 + step * 16);
      maximumHeight = Math.max(maximumHeight, player.position.y);
    }
    assert.ok(maximumHeight >= routes[mapId].elevation, `${mapId} only reached ${maximumHeight}`);
  }
});

test("movement is derived from bounded input on the server", () => {
  const engine = new GameEngine(1_000, "test-match");
  engine.addPlayer("p1", "PLAYER", "rifle");
  const before = engine.snapshot(1_000).players[0].position;
  const facing = engine.snapshot(1_000).players[0].yaw;
  engine.setInput("p1", { seq: 1, forward: 99, strafe: 0, yaw: facing, pitch: 0, jump: false, sprint: false });
  engine.tick(1 / 30, 1_033);
  const after = engine.snapshot(1_033).players[0].position;
  assert.ok(Math.hypot(after.x, after.z) < Math.hypot(before.x, before.z));
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 1);
});

test("jump uses a quick authoritative arc and returns cleanly to ground", () => {
  const engine = new GameEngine(1_000, "test-jump");
  const player = engine.addPlayer("p1", "PLAYER", "rifle");
  engine.setInput("p1", { seq: 1, forward: 0, strafe: 0, yaw: player.yaw, pitch: 0, jump: true, sprint: false });
  engine.tick(1 / 30, 1_033);
  assert.ok(engine.players.get("p1")!.position.y > .2);
  for (let step = 2; step <= 24; step += 1) engine.tick(1 / 30, 1_000 + step * 33);
  assert.equal(engine.players.get("p1")!.position.y, 0);
  assert.equal(engine.players.get("p1")!.grounded, true);
});

test("sniper headshot damage and score are server authoritative", () => {
  const engine = new GameEngine(1_000, "test-match");
  engine.addPlayer("shooter", "ACE", "sniper");
  engine.addPlayer("target", "RIVAL", "rifle");
  const shooter = engine.players.get("shooter")!;
  const target = engine.players.get("target")!;
  shooter.position = { x: -18, y: 0, z: -13 };
  target.position = { x: -18, y: 0, z: -20 };
  engine.setInput("shooter", { seq: 1, forward: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false });
  const shot = engine.fire("shooter", 3_000);
  assert.equal(shot?.hitId, "target");
  assert.equal(shot?.victimName, "RIVAL");
  assert.equal(shot?.headshot, true);
  assert.equal(shot?.damage, 100);
  assert.equal(shot?.killed, true);
  assert.equal(engine.snapshot(3_000).players.find((p) => p.id === "target")?.alive, false);
  assert.equal(engine.snapshot(3_000).players.find((p) => p.id === "shooter")?.score, 150);
});

test("training bots start slowly and use bounded movement", () => {
  const engine = new GameEngine(1_000, "test-match");
  engine.addPlayer("human", "PLAYER", "rifle");
  engine.addBots(1);
  const bot = engine.players.get("bot-1")!;
  assert.ok(bot.nextBotDecision >= 1_900);
  engine.tick(1 / 30, 1_033);
  assert.ok(Math.abs(bot.input.forward) <= .62);
  assert.ok(Math.abs(bot.input.strafe) <= .28);
});

test("weapon fire cadence cannot be bypassed by message spam", () => {
  const engine = new GameEngine(1_000, "test-match");
  engine.addPlayer("p1", "PLAYER", "rifle");
  assert.ok(engine.fire("p1", 2_000));
  assert.equal(engine.fire("p1", 2_001), null);
  assert.equal(engine.snapshot(2_001).players[0].ammo, 29);
});

test("weapon switching cannot refill a spent magazine", () => {
  const engine = new GameEngine(1_000, "test-ammo");
  engine.addPlayer("p1", "PLAYER", "rifle");
  assert.ok(engine.fire("p1", 2_000));
  assert.equal(engine.snapshot(2_001).players[0].ammo, 29);
  engine.switchWeapon("p1", "smg");
  engine.switchWeapon("p1", "rifle");
  assert.equal(engine.snapshot(2_002).players[0].ammo, 29);
});

test("repeated impossible aim snaps are flagged", () => {
  const engine = new GameEngine(1_000, "test-aim");
  const player = engine.addPlayer("p1", "PLAYER", "rifle");
  let reason: string | null = null;
  engine.onSecurityFlag = (_id, value) => { reason = value; };
  for (let seq = 1; seq <= 8; seq += 1) {
    engine.setInput("p1", { seq, forward: 0, strafe: 0, yaw: player.yaw + seq * Math.PI, pitch: seq % 2 ? 1.4 : -1.4, jump: false, sprint: false }, 1_000 + seq * 9);
  }
  assert.equal(reason, "impossible-aim-rate");
});

test("per-player snapshots redact opponents hidden behind cover", () => {
  const engine = new GameEngine(1_000, "test-visibility", "foundry");
  engine.addPlayer("viewer", "VIEWER", "rifle");
  engine.addPlayer("target", "TARGET", "rifle");
  const viewer = engine.players.get("viewer")!;
  const target = engine.players.get("target")!;
  const cover = engine.map.boxes[0];
  viewer.position = { x: cover.x - cover.width / 2 - 3, y: 0, z: cover.z };
  target.position = { x: cover.x + cover.width / 2 + 3, y: 0, z: cover.z };
  const hidden = engine.snapshotFor("viewer", 1_000).players.find((candidate) => candidate.id === "target")!;
  assert.equal(hidden.visible, false);
  assert.deepEqual(hidden.position, { x: 0, y: -1000, z: 0 });
  assert.equal(hidden.health, 0);
  assert.equal(hidden.ammo, 0);
  assert.equal(hidden.score, 0);
});

test("respawns face the arena and notify the connected client", () => {
  const engine = new GameEngine(1_000, "test-match");
  engine.addPlayer("shooter", "ACE", "sniper");
  engine.addPlayer("target", "RIVAL", "rifle");
  const shooter = engine.players.get("shooter")!;
  const target = engine.players.get("target")!;
  shooter.position = { x: -18, y: 0, z: -13 };
  target.position = { x: -18, y: 0, z: -20 };
  engine.setInput("shooter", { seq: 1, forward: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sprint: false });
  engine.fire("shooter", 3_000);
  let announcedYaw: number | null = null;
  engine.onRespawn = (id, yaw) => { if (id === "target") announcedYaw = yaw; };
  engine.tick(1 / 30, 5_001);
  const respawned = engine.snapshot(5_001).players.find((player) => player.id === "target")!;
  const towardCenter = (-Math.sin(respawned.yaw)) * (-respawned.position.x) + (-Math.cos(respawned.yaw)) * (-respawned.position.z);
  assert.ok(respawned.alive);
  assert.equal(announcedYaw, respawned.yaw);
  assert.ok(towardCenter > 0);
});
