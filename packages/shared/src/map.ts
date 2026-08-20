import type { Vec3 } from "./protocol";

export type MapId = "foundry" | "switchyard" | "citadel";

export interface MapBox extends Vec3 {
  width: number;
  height: number;
  depth: number;
  color: number;
  kind: "wall" | "cover" | "platform" | "step" | "support" | "collision";
}

export interface ArenaMap {
  id: MapId;
  label: string;
  theme: "desert-rig" | "container-yard" | "old-town";
  description: string;
  skyColor: number;
  groundColor: number;
  size: "SMALL" | "MEDIUM" | "LARGE";
  halfSize: number;
  playerRange: string;
  spawns: Vec3[];
  boxes: MapBox[];
}

function stairsAlongZ(x: number, startZ: number, direction: 1 | -1, steps: number, rise: number, width: number, depth: number, color: number, baseY = 0): MapBox[] {
  return Array.from({ length: steps }, (_, index) => {
    const height = (index + 1) * rise;
    return { x, y: baseY + height / 2, z: startZ + direction * index * depth, width, height, depth: depth + .04, color, kind: "step" as const };
  });
}

function stairsAlongX(z: number, startX: number, direction: 1 | -1, steps: number, rise: number, width: number, depth: number, color: number, baseY = 0): MapBox[] {
  return Array.from({ length: steps }, (_, index) => {
    const height = (index + 1) * rise;
    return { x: startX + direction * index * width, y: baseY + height / 2, z, width: width + .04, height, depth, color, kind: "step" as const };
  });
}

const foundry: ArenaMap = {
  id: "foundry", label: "DUST RIG", theme: "desert-rig", description: "DESERT INDUSTRIAL", skyColor: 0xc47b46, groundColor: 0x8f6842, size: "SMALL", halfSize: 22, playerRange: "1–4 PLAYERS",
  spawns: [
    { x: -17, y: 0, z: -17 }, { x: 17, y: 0, z: 17 }, { x: -17, y: 0, z: 17 }, { x: 17, y: 0, z: -17 },
    { x: 0, y: 0, z: -18 }, { x: 0, y: 0, z: 18 }, { x: -18, y: 0, z: 0 }, { x: 18, y: 0, z: -10 },
  ],
  boxes: [
    { x: 0, y: 1.4, z: 0, width: 8, height: 2.8, depth: 8, color: 0x3f4938, kind: "platform" },
    { x: -9, y: 1.6, z: -7, width: 3.5, height: 3.2, depth: 6, color: 0xd9ff43, kind: "cover" },
    { x: 9, y: 1.6, z: 7, width: 3.5, height: 3.2, depth: 6, color: 0xff5b32, kind: "cover" },
    { x: -9, y: 1.2, z: 8, width: 6, height: 2.4, depth: 3, color: 0x596351, kind: "cover" },
    { x: 9, y: 1.2, z: -8, width: 6, height: 2.4, depth: 3, color: 0x596351, kind: "cover" },
    { x: 0, y: 2.5, z: -20, width: 9, height: 5, depth: 1, color: 0x343a32, kind: "wall" },
    { x: 0, y: 2.5, z: 20, width: 9, height: 5, depth: 1, color: 0x343a32, kind: "wall" },
    { x: -20, y: 2.5, z: 0, width: 1, height: 5, depth: 9, color: 0x343a32, kind: "wall" },
    { x: 20, y: 2.5, z: 0, width: 1, height: 5, depth: 9, color: 0x343a32, kind: "wall" },
    ...stairsAlongZ(0, -8.3, 1, 4, .7, 2.8, 1.2, 0x68725d),
    ...stairsAlongZ(0, 8.3, -1, 4, .7, 2.8, 1.2, 0x68725d),
    { x: -7, y: 2.95, z: 0, width: 6, height: .3, depth: 2.2, color: 0x586451, kind: "platform" },
    { x: 7, y: 2.95, z: 0, width: 6, height: .3, depth: 2.2, color: 0x586451, kind: "platform" },
    { x: -7, y: 1.4, z: 0, width: .75, height: 2.8, depth: 1.4, color: 0x414b3e, kind: "support" },
    { x: 7, y: 1.4, z: 0, width: .75, height: 2.8, depth: 1.4, color: 0x414b3e, kind: "support" },
    { x: -11.5, y: 1.55, z: 0, width: 3, height: 3.1, depth: 5, color: 0x4a5647, kind: "platform" },
    { x: 11.5, y: 1.55, z: 0, width: 3, height: 3.1, depth: 5, color: 0x4a5647, kind: "platform" },
    ...stairsAlongX(-13, -12, 1, 2, .65, 1.25, 2.2, 0x68725d),
    ...stairsAlongX(13, 12, -1, 2, .65, 1.25, 2.2, 0x68725d),
    { x: -8.8, y: .9, z: -13, width: 2.5, height: 1.8, depth: 3, color: 0x505c4d, kind: "platform" },
    { x: 8.8, y: .9, z: 13, width: 2.5, height: 1.8, depth: 3, color: 0x505c4d, kind: "platform" },
    { x: 2, y: 5.4, z: -2.5, width: 3, height: .3, depth: 3.2, color: 0x8d6743, kind: "platform" },
    ...stairsAlongX(-2.5, -3.5, 1, 5, .55, .8, 1.7, 0x8a745b, 2.8),
    { x: -15, y: 1.25, z: -1, width: 4, height: 2.5, depth: 2.5, color: 0xa34e2b, kind: "cover" },
    { x: 15, y: 1.25, z: 1, width: 4, height: 2.5, depth: 2.5, color: 0x9b7b52, kind: "cover" },
    { x: -14, y: .7, z: 13, width: 3.2, height: 1.4, depth: 3.2, color: 0x6d5943, kind: "cover" },
    { x: 14, y: .7, z: -13, width: 3.2, height: 1.4, depth: 3.2, color: 0x6d5943, kind: "cover" },
  ],
};

const switchyard: ArenaMap = {
  id: "switchyard", label: "CONTAINER YARD", theme: "container-yard", description: "STACKS + GANTRIES", skyColor: 0x718895, groundColor: 0x596361, size: "MEDIUM", halfSize: 32, playerRange: "5–8 PLAYERS",
  spawns: [
    { x: -27, y: 0, z: -27 }, { x: 27, y: 0, z: 27 }, { x: -27, y: 0, z: 27 }, { x: 27, y: 0, z: -27 },
    { x: 0, y: 0, z: -28 }, { x: 0, y: 0, z: 28 }, { x: -28, y: 0, z: 0 }, { x: 28, y: 0, z: 0 },
    { x: -25, y: 0, z: -9 }, { x: 25, y: 0, z: 9 }, { x: -9, y: 0, z: 25 }, { x: 9, y: 0, z: -25 },
  ],
  boxes: [
    { x: 0, y: 1.6, z: 0, width: 10, height: 3.2, depth: 10, color: 0x3b4638, kind: "platform" },
    { x: -15, y: 1.8, z: -10, width: 4, height: 3.6, depth: 9, color: 0xd9ff43, kind: "cover" },
    { x: 15, y: 1.8, z: 10, width: 4, height: 3.6, depth: 9, color: 0xff5b32, kind: "cover" },
    { x: -15, y: 1.8, z: 11, width: 8, height: 3.6, depth: 4, color: 0x66705f, kind: "cover" },
    { x: 15, y: 1.8, z: -11, width: 8, height: 3.6, depth: 4, color: 0x66705f, kind: "cover" },
    { x: -5, y: 1.25, z: -20, width: 9, height: 2.5, depth: 3, color: 0x515d4c, kind: "cover" },
    { x: 5, y: 1.25, z: 20, width: 9, height: 2.5, depth: 3, color: 0x515d4c, kind: "cover" },
    { x: -24, y: 1.3, z: 4, width: 3, height: 2.6, depth: 8, color: 0x444f42, kind: "cover" },
    { x: 24, y: 1.3, z: -4, width: 3, height: 2.6, depth: 8, color: 0x444f42, kind: "cover" },
    { x: 0, y: 2.6, z: -30, width: 13, height: 5.2, depth: 1, color: 0x30372f, kind: "wall" },
    { x: 0, y: 2.6, z: 30, width: 13, height: 5.2, depth: 1, color: 0x30372f, kind: "wall" },
    ...stairsAlongZ(0, -10.5, 1, 5, .64, 3.2, 1.2, 0x66715e),
    ...stairsAlongZ(0, 10.5, -1, 5, .64, 3.2, 1.2, 0x66715e),
    { x: -9, y: 3.35, z: 0, width: 8, height: .3, depth: 2.5, color: 0x566250, kind: "platform" },
    { x: 9, y: 3.35, z: 0, width: 8, height: .3, depth: 2.5, color: 0x566250, kind: "platform" },
    { x: -9, y: 1.6, z: 0, width: .85, height: 3.2, depth: 1.6, color: 0x414b3e, kind: "support" },
    { x: 9, y: 1.6, z: 0, width: .85, height: 3.2, depth: 1.6, color: 0x414b3e, kind: "support" },
    { x: -15, y: 1.8, z: 0, width: 4, height: 3.6, depth: 6, color: 0x455243, kind: "platform" },
    { x: 15, y: 1.8, z: 0, width: 4, height: 3.6, depth: 6, color: 0x455243, kind: "platform" },
    ...stairsAlongZ(-15, -19, 1, 5, .72, 2.6, 1.2, 0x66715e),
    ...stairsAlongZ(15, 19, -1, 5, .72, 2.6, 1.2, 0x66715e),
    ...stairsAlongX(-22, -25, 1, 3, .62, 1.25, 2.3, 0x66715e),
    ...stairsAlongX(22, 25, -1, 3, .62, 1.25, 2.3, 0x66715e),
    { x: -20.2, y: .95, z: -22, width: 2.8, height: 1.9, depth: 3.2, color: 0x4b5748, kind: "platform" },
    { x: 20.2, y: .95, z: 22, width: 2.8, height: 1.9, depth: 3.2, color: 0x4b5748, kind: "platform" },
    { x: -24, y: 1.3, z: -17, width: 7.2, height: 2.6, depth: 2.7, color: 0xb54a32, kind: "cover" },
    { x: -24, y: 3.9, z: -17, width: 7.2, height: 2.6, depth: 2.7, color: 0xd78b2c, kind: "platform" },
    { x: 24, y: 1.3, z: 17, width: 7.2, height: 2.6, depth: 2.7, color: 0x34708a, kind: "cover" },
    { x: 22, y: 1.3, z: -21, width: 2.7, height: 2.6, depth: 7.2, color: 0xa9a347, kind: "cover" },
    { x: -22, y: 1.3, z: 21, width: 2.7, height: 2.6, depth: 7.2, color: 0x3c7880, kind: "cover" },
    { x: -7, y: 1.3, z: 17, width: 7.2, height: 2.6, depth: 2.7, color: 0xa54936, kind: "cover" },
    { x: 8, y: 1.3, z: -17, width: 7.2, height: 2.6, depth: 2.7, color: 0x3d6e8d, kind: "cover" },
    { x: -18.8, y: .55, z: -17, width: 2, height: 1.1, depth: 2, color: 0x7b664d, kind: "step" },
    { x: 18.8, y: .55, z: 17, width: 2, height: 1.1, depth: 2, color: 0x7b664d, kind: "step" },
  ],
};

const citadel: ArenaMap = {
  id: "citadel", label: "OLD QUARTER", theme: "old-town", description: "ROOFTOPS + ALLEYS", skyColor: 0x182a42, groundColor: 0x69645c, size: "LARGE", halfSize: 44, playerRange: "9–12 PLAYERS",
  spawns: [
    { x: -39, y: 0, z: -39 }, { x: 39, y: 0, z: 39 }, { x: -39, y: 0, z: 39 }, { x: 39, y: 0, z: -39 },
    { x: 0, y: 0, z: -40 }, { x: 0, y: 0, z: 40 }, { x: -40, y: 0, z: 0 }, { x: 40, y: 0, z: 0 },
    { x: -37, y: 0, z: -14 }, { x: 37, y: 0, z: 14 }, { x: -14, y: 0, z: 37 }, { x: 14, y: 0, z: -37 },
    { x: -39, y: 0, z: 29 }, { x: 39, y: 0, z: -29 }, { x: -29, y: 0, z: -39 }, { x: 29, y: 0, z: 39 },
  ],
  boxes: [
    { x: 0, y: 2, z: 0, width: 13, height: 4, depth: 13, color: 0x384438, kind: "platform" },
    { x: -20, y: 2.2, z: -18, width: 6, height: 4.4, depth: 11, color: 0xd9ff43, kind: "cover" },
    { x: 20, y: 2.2, z: 18, width: 6, height: 4.4, depth: 11, color: 0xff5b32, kind: "cover" },
    { x: -20, y: 2.2, z: 18, width: 11, height: 4.4, depth: 6, color: 0x5c6858, kind: "cover" },
    { x: 20, y: 2.2, z: -18, width: 11, height: 4.4, depth: 6, color: 0x5c6858, kind: "cover" },
    { x: -7, y: 1.5, z: -29, width: 12, height: 3, depth: 4, color: 0x485446, kind: "cover" },
    { x: 7, y: 1.5, z: 29, width: 12, height: 3, depth: 4, color: 0x485446, kind: "cover" },
    { x: -29, y: 1.5, z: 7, width: 4, height: 3, depth: 12, color: 0x485446, kind: "cover" },
    { x: 29, y: 1.5, z: -7, width: 4, height: 3, depth: 12, color: 0x485446, kind: "cover" },
    { x: -5, y: 1.2, z: -17, width: 5, height: 2.4, depth: 3, color: 0x697564, kind: "cover" },
    { x: 5, y: 1.2, z: 17, width: 5, height: 2.4, depth: 3, color: 0x697564, kind: "cover" },
    { x: -17, y: 1.2, z: 5, width: 3, height: 2.4, depth: 5, color: 0x697564, kind: "cover" },
    { x: 17, y: 1.2, z: -5, width: 3, height: 2.4, depth: 5, color: 0x697564, kind: "cover" },
    { x: 0, y: 2.8, z: -42, width: 17, height: 5.6, depth: 1, color: 0x2d342c, kind: "wall" },
    { x: 0, y: 2.8, z: 42, width: 17, height: 5.6, depth: 1, color: 0x2d342c, kind: "wall" },
    { x: -42, y: 2.8, z: 0, width: 1, height: 5.6, depth: 17, color: 0x2d342c, kind: "wall" },
    { x: 42, y: 2.8, z: 0, width: 1, height: 5.6, depth: 17, color: 0x2d342c, kind: "wall" },
    ...stairsAlongZ(0, -13.2, 1, 6, .66, 3.6, 1.2, 0x687360),
    ...stairsAlongZ(0, 13.2, -1, 6, .66, 3.6, 1.2, 0x687360),
    ...stairsAlongX(0, -13.2, 1, 6, .66, 1.2, 3.6, 0x687360),
    ...stairsAlongX(0, 13.2, -1, 6, .66, 1.2, 3.6, 0x687360),
    { x: -12, y: 4.12, z: -4, width: 11, height: .32, depth: 2.4, color: 0x53604f, kind: "platform" },
    { x: 12, y: 4.12, z: 4, width: 11, height: .32, depth: 2.4, color: 0x53604f, kind: "platform" },
    { x: 4, y: 4.12, z: -12, width: 2.4, height: .32, depth: 11, color: 0x53604f, kind: "platform" },
    { x: -4, y: 4.12, z: 12, width: 2.4, height: .32, depth: 11, color: 0x53604f, kind: "platform" },
    { x: -12, y: 1.98, z: -4, width: .9, height: 3.96, depth: 1.5, color: 0x414b3e, kind: "support" },
    { x: 12, y: 1.98, z: 4, width: .9, height: 3.96, depth: 1.5, color: 0x414b3e, kind: "support" },
    { x: 4, y: 1.98, z: -12, width: 1.5, height: 3.96, depth: .9, color: 0x414b3e, kind: "support" },
    { x: -4, y: 1.98, z: 12, width: 1.5, height: 3.96, depth: .9, color: 0x414b3e, kind: "support" },
    { x: -20, y: 2.2, z: 0, width: 5, height: 4.4, depth: 6, color: 0x465244, kind: "platform" },
    { x: 20, y: 2.2, z: 0, width: 5, height: 4.4, depth: 6, color: 0x465244, kind: "platform" },
    { x: 0, y: 2.2, z: -20, width: 6, height: 4.4, depth: 5, color: 0x465244, kind: "platform" },
    { x: 0, y: 2.2, z: 20, width: 6, height: 4.4, depth: 5, color: 0x465244, kind: "platform" },
    ...stairsAlongX(18, -35, 1, 3, .64, 1.3, 2.4, 0x687360),
    ...stairsAlongX(-18, 35, -1, 3, .64, 1.3, 2.4, 0x687360),
    ...stairsAlongX(34, -10, 1, 3, .64, 1.3, 2.4, 0x687360),
    ...stairsAlongX(-34, 10, -1, 3, .64, 1.3, 2.4, 0x687360),
    { x: -30.5, y: 1, z: 18, width: 3, height: 2, depth: 3.4, color: 0x4a5647, kind: "platform" },
    { x: 30.5, y: 1, z: -18, width: 3, height: 2, depth: 3.4, color: 0x4a5647, kind: "platform" },
    { x: -5.5, y: 1, z: 34, width: 3, height: 2, depth: 3.4, color: 0x4a5647, kind: "platform" },
    { x: 5.5, y: 1, z: -34, width: 3, height: 2, depth: 3.4, color: 0x4a5647, kind: "platform" },
    { x: -32, y: 3, z: -25, width: 10, height: 6, depth: 8, color: 0xb98d67, kind: "platform" },
    { x: 32, y: 3, z: 25, width: 10, height: 6, depth: 8, color: 0xc29b75, kind: "platform" },
    { x: -32, y: 2.6, z: 25, width: 9, height: 5.2, depth: 9, color: 0x8f9b86, kind: "platform" },
    { x: 32, y: 2.6, z: -25, width: 9, height: 5.2, depth: 9, color: 0xb77c66, kind: "platform" },
    { x: -31, y: 2.25, z: -8, width: 7, height: 4.5, depth: 8, color: 0xc1a77f, kind: "platform" },
    { x: 31, y: 2.25, z: 8, width: 7, height: 4.5, depth: 8, color: 0x8fa0a0, kind: "platform" },
    { x: -12, y: 1.1, z: 28, width: 5, height: 2.2, depth: 3, color: 0x796f5e, kind: "cover" },
    { x: 12, y: 1.1, z: -28, width: 5, height: 2.2, depth: 3, color: 0x796f5e, kind: "cover" },
    { x: -25.5, y: .55, z: -18, width: 2.2, height: 1.1, depth: 2.2, color: 0x806f58, kind: "step" },
    { x: 25.5, y: .55, z: 18, width: 2.2, height: 1.1, depth: 2.2, color: 0x806f58, kind: "step" },
    { x: 0, y: 6.2, z: 0, width: 4.2, height: 4.4, depth: 4.2, color: 0xd2b98e, kind: "wall" },
    { x: -17, y: 2.5, z: -33, width: 8, height: 5, depth: 7, color: 0xc6a477, kind: "platform" },
    { x: 17, y: 2.5, z: 33, width: 8, height: 5, depth: 7, color: 0x82979a, kind: "platform" },
    { x: -34, y: 2.3, z: 10, width: 7, height: 4.6, depth: 7, color: 0xb77b66, kind: "platform" },
    { x: 34, y: 2.3, z: -10, width: 7, height: 4.6, depth: 7, color: 0xd0b790, kind: "platform" },
  ],
};

// Dust Rig keeps our block-built visual language but follows Rust's recognizable
// combat grammar: central tower, two ascents, under-tower gaps, north pipeline,
// west fuel platform, northeast offices, southeast truck yard, and south generators.
foundry.boxes = [
  { x: 0, y: 2.8, z: 0, width: 7.4, height: .3, depth: 7.4, color: 0x8b4b2d, kind: "platform" },
  { x: -2.85, y: 1.4, z: 0, width: 1.1, height: 2.8, depth: 5.2, color: 0x49372f, kind: "support" },
  { x: 2.85, y: 1.4, z: -.8, width: 1.1, height: 2.8, depth: 3.6, color: 0x49372f, kind: "support" },
  { x: .8, y: 1.4, z: -2.85, width: 3.2, height: 2.8, depth: 1.1, color: 0x49372f, kind: "support" },
  { x: 0, y: .7, z: 2.85, width: 2.4, height: 1.4, depth: 1.1, color: 0x71503b, kind: "cover" },
  ...stairsAlongZ(0, -9, 1, 5, .59, 1.75, 1.05, 0x66574b),
  { x: 0, y: 5.67, z: -.9, width: 4.6, height: .3, depth: 4.5, color: 0xa86335, kind: "platform" },
  ...stairsAlongX(-1.65, -3.25, 1, 5, .57, .78, 1.35, 0x66574b, 2.95),
  { x: .9, y: 8.48, z: 1.15, width: 3.2, height: .28, depth: 3, color: 0xc17b42, kind: "platform" },
  ...stairsAlongZ(.9, -1.75, 1, 5, .55, 1.1, .72, 0x66574b, 5.82),
  { x: -11.5, y: 1.7, z: 0, width: 5.2, height: 3.4, depth: 4.5, color: 0, kind: "collision" },
  { x: -13.5, y: 1.55, z: -9.5, width: 5.4, height: 3.1, depth: 5.2, color: 0x71503b, kind: "platform" },
  ...stairsAlongX(-9.5, -17.1, 1, 3, .62, 1.1, 2, 0x66574b),
  { x: -8.2, y: 1.7, z: -9.5, width: 6.2, height: .55, depth: 1.3, color: 0, kind: "collision" },
  { x: -5.1, y: 1.7, z: -7.1, width: 1.3, height: .55, depth: 4.8, color: 0, kind: "collision" },
  { x: -5.1, y: .85, z: -4.7, width: 1.3, height: 1.7, depth: 1.3, color: 0, kind: "collision" },
  { x: 11.8, y: 2.5, z: -11.5, width: 6.2, height: 5, depth: 4.5, color: 0x8b4b2d, kind: "wall" },
  { x: 15.4, y: 2.2, z: -6.2, width: 3.2, height: 4.4, depth: 7.2, color: 0x71503b, kind: "wall" },
  { x: 9.2, y: 1.45, z: -5.5, width: 3.6, height: 2.9, depth: 2.7, color: 0xa86335, kind: "cover" },
  { x: 11.5, y: 1.35, z: 11.5, width: 7, height: 2.7, depth: 2.8, color: 0, kind: "collision" },
  { x: 15.8, y: .8, z: 7.2, width: 2.7, height: 1.6, depth: 3.4, color: 0x71503b, kind: "cover" },
  { x: 7.2, y: .65, z: 15.5, width: 3, height: 1.3, depth: 2.5, color: 0x5e4335, kind: "cover" },
  { x: -1.7, y: 1.25, z: 13.8, width: 3.4, height: 2.5, depth: 3.2, color: 0x8b4b2d, kind: "cover" },
  { x: 2.1, y: 1.05, z: 14.8, width: 2.8, height: 2.1, depth: 3, color: 0xa86335, kind: "cover" },
  { x: -11.8, y: 1.45, z: 11.8, width: 5.2, height: 2.9, depth: 5.2, color: 0x71503b, kind: "platform" },
  ...stairsAlongZ(-11.8, 16.2, -1, 3, .56, 2, 1.05, 0x66574b),
  { x: -17, y: 1.15, z: 5, width: 2.5, height: 2.3, depth: 6, color: 0x5e4335, kind: "cover" },
  { x: 17, y: 1.15, z: .5, width: 2.5, height: 2.3, depth: 5.2, color: 0x8b4b2d, kind: "cover" },
  { x: -6.8, y: .7, z: 17, width: 4.5, height: 1.4, depth: 2.2, color: 0xa86335, kind: "cover" },
];

function collisionBox(x: number, y: number, z: number, width: number, height: number, depth: number): MapBox {
  return { x, y, z, width, height, depth, color: 0, kind: "collision" };
}

foundry.boxes.push(
  collisionBox(-15.3, .45, 6.05, 1.8, .9, 1.25), collisionBox(15.3, .45, -6.05, 1.8, .9, 1.25),
  collisionBox(11.3, .45, 16, 1.7, .9, .8), collisionBox(-11.3, .45, -16, 2.4, .9, .8),
  collisionBox(-17.2, .72, 5, .9, 1.45, .8), collisionBox(17.2, .72, -5, .9, 1.45, .8),
);
switchyard.boxes.push(
  collisionBox(27, .85, -13.25, 1.8, 1.7, 4.6),
  collisionBox(-27, .13, 16, 2.1, .26, 2.1), collisionBox(27, .13, -16, 2.1, .26, 2.1),
  collisionBox(-12, .13, 27, 2.1, .26, 2.1), collisionBox(12, .13, -27, 2.1, .26, 2.1),
);
const townBuildings = citadel.boxes.filter((box) => box.kind === "platform" && box.height >= 4 && box.width >= 5 && box.depth >= 4);
townBuildings.forEach((box, index) => {
  citadel.boxes.push(collisionBox(box.x, 1.65, box.z - box.depth / 2 - .38, Math.min(3.4, box.width * .52), .14, .8));
  if (index % 2 === 0 && box.height >= 4.5) citadel.boxes.push(collisionBox(box.x, 3.15, box.z - box.depth / 2 - .48, 3.2, .14, .95));
});
citadel.boxes.push(
  ...[[-25, -14], [-25, 14], [25, -14], [25, 14], [-10, -36], [10, 36], [-36, 10], [36, -10]].map(([x, z]) => collisionBox(x, 1.7, z, .24, 3.4, .24)),
  ...[[-26, -13], [-24, 13], [26, 13], [24, -13], [-9, 27], [9, -27], [-35, 9], [35, -9]].map(([x, z]) => collisionBox(x, .7, z, .65, 1.4, .65)),
  collisionBox(-8, .62, 21, 2.5, 1.25, .85), collisionBox(8, .62, -21, 2.5, 1.25, .85),
);

function applyThemePalette(map: ArenaMap, colors: number[], stepColor: number, wallColor: number): void {
  let structureIndex = 0;
  map.boxes = map.boxes.map((box) => {
    if (box.kind === "collision") return box;
    if (box.kind === "step" || box.kind === "support") return { ...box, color: stepColor };
    if (box.kind === "wall") return { ...box, color: wallColor };
    const color = colors[structureIndex++ % colors.length];
    return { ...box, color };
  });
}

applyThemePalette(foundry, [0x8b4b2d, 0xa86335, 0x71503b, 0xc17b42, 0x5e4335], 0x66574b, 0x49372f);
applyThemePalette(switchyard, [0xb94835, 0x2f6f88, 0xd08a2d, 0x4e7759, 0x9b9b42, 0x405f79], 0x59635f, 0x303a3e);
applyThemePalette(citadel, [0xc7aa80, 0x9d6f63, 0x7f9897, 0xd0b992, 0x8f866e, 0xb98770], 0x81796b, 0x5c554b);

export const MAPS: Record<MapId, ArenaMap> = { foundry, switchyard, citadel };
export const MAP_IDS = Object.keys(MAPS) as MapId[];
export function isMapId(value: unknown): value is MapId { return typeof value === "string" && value in MAPS; }
export function mapForPlayerCount(playerCount: number): MapId { return playerCount <= 4 ? "foundry" : playerCount <= 8 ? "switchyard" : "citadel"; }
export function mapForRoomJoin(current: MapId, requested: MapId, humanPlayers: number, override: MapId | null = null): MapId {
  return override ?? (humanPlayers === 0 ? requested : current);
}

// Backwards-compatible aliases for the original small arena.
export const ARENA_HALF_SIZE = foundry.halfSize;
export const SPAWNS = foundry.spawns;
export const MAP_BOXES = foundry.boxes;
