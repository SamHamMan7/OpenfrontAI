export interface SpawnTerrain {
  terrain: Uint8Array;
  width: number;
  height: number;
  landTiles: readonly number[];
  landBit?: number;
}

export interface ModelHeatmap {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface SpawnOptions {
  occupiedSpawns?: readonly number[];
  allySpawns?: readonly number[];
  model?: ModelHeatmap | null;
  maxCandidates?: number;
}

const DEFAULT_LAND_BIT = 0x80;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function hash01(x: number): number {
  let n = x | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n ^= n >>> 16;
  return (n >>> 0) / 0xffffffff;
}

function isLand(map: SpawnTerrain, ref: number): boolean {
  if (ref < 0 || ref >= map.terrain.length) return false;
  return (map.terrain[ref] & (map.landBit ?? DEFAULT_LAND_BIT)) !== 0;
}

function coord(map: SpawnTerrain, ref: number): { x: number; y: number } {
  return { x: ref % map.width, y: Math.floor(ref / map.width) };
}

function manhattan(map: SpawnTerrain, a: number, b: number): number {
  const ac = coord(map, a);
  const bc = coord(map, b);
  return Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y);
}

function nearestDistance(
  map: SpawnTerrain,
  ref: number,
  points: readonly number[],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const point of points) best = Math.min(best, manhattan(map, ref, point));
  return best;
}

function localLandScore(map: SpawnTerrain, ref: number): number {
  const { x, y } = coord(map, ref);
  const radii = [4, 10, 22, 40];
  const offsets = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const;

  let weighted = 0;
  let weightTotal = 0;
  for (let i = 0; i < radii.length; i++) {
    const radius = radii[i];
    const weight = radii.length - i;
    let land = 0;
    let total = 0;
    for (const [ox, oy] of offsets) {
      const sx = x + ox * radius;
      const sy = y + oy * radius;
      if (sx < 0 || sy < 0 || sx >= map.width || sy >= map.height) continue;
      total++;
      if (isLand(map, sy * map.width + sx)) land++;
    }
    if (total > 0) {
      weighted += (land / total) * weight;
      weightTotal += weight;
    }
  }
  return weightTotal > 0 ? weighted / weightTotal : 0;
}

function edgeScore(map: SpawnTerrain, ref: number): number {
  const { x, y } = coord(map, ref);
  const d = Math.min(x, y, map.width - 1 - x, map.height - 1 - y);
  return clamp01(d / Math.max(1, Math.min(map.width, map.height) * 0.16));
}

function modelScore(map: SpawnTerrain, ref: number, model: ModelHeatmap | null | undefined): number {
  if (!model || model.width <= 0 || model.height <= 0 || model.data.length === 0) return 0.5;
  const { x, y } = coord(map, ref);
  const mx = Math.min(model.width - 1, Math.floor((x / map.width) * model.width));
  const my = Math.min(model.height - 1, Math.floor((y / map.height) * model.height));
  const raw = Number(model.data[my * model.width + mx]);
  if (!Number.isFinite(raw)) return 0.5;
  // Bound arbitrary logits so the model is a prior, not a veto on basic map geometry.
  return 1 / (1 + Math.exp(-Math.max(-8, Math.min(8, raw))));
}

function sampleCandidates(map: SpawnTerrain, maxCandidates: number): number[] {
  const land = map.landTiles;
  if (land.length <= maxCandidates) return [...land];

  const result: number[] = [];
  const stride = land.length / maxCandidates;
  for (let i = 0; i < maxCandidates; i++) {
    const jitter = hash01(i * 2654435761) * 0.8 + 0.1;
    const index = Math.min(land.length - 1, Math.floor((i + jitter) * stride));
    result.push(land[index]);
  }
  return result;
}

export function chooseSpawnTile(map: SpawnTerrain, options: SpawnOptions = {}): number {
  if (map.landTiles.length === 0) return -1;

  const occupied = options.occupiedSpawns ?? [];
  const allies = options.allySpawns ?? [];
  const candidates = sampleCandidates(map, Math.max(100, options.maxCandidates ?? 2500));
  const diagonal = Math.max(1, map.width + map.height);

  let bestRef = candidates[0];
  let bestScore = -Infinity;

  for (const ref of candidates) {
    const nearestOccupied = nearestDistance(map, ref, occupied);
    if (nearestOccupied < 28) continue;

    const open = localLandScore(map, ref);
    const edge = edgeScore(map, ref);
    const enemySpacing = Number.isFinite(nearestOccupied)
      ? clamp01(nearestOccupied / (diagonal * 0.22))
      : 1;

    let allyShape = 0.5;
    if (allies.length > 0) {
      const d = nearestDistance(map, ref, allies);
      // Teams benefit from being near enough to support each other, but not from
      // spawning on top of each other. Peak around 8% of map width+height.
      const ideal = diagonal * 0.08;
      allyShape = Math.exp(-Math.abs(d - ideal) / Math.max(1, ideal));
    }

    const prior = modelScore(map, ref, options.model);
    const deterministicTieBreak = hash01(ref) * 0.002;
    const score =
      open * 3.4 +
      edge * 1.15 +
      enemySpacing * 2.25 +
      allyShape * 0.55 +
      prior * 1.35 +
      deterministicTieBreak;

    if (score > bestScore) {
      bestScore = score;
      bestRef = ref;
    }
  }

  return bestRef;
}

export function spawnDistanceMap(
  map: Pick<SpawnTerrain, "width" | "height">,
  mySpawn: number,
  spawns: ReadonlyMap<string, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  const mx = mySpawn % map.width;
  const my = Math.floor(mySpawn / map.width);
  for (const [clientID, ref] of spawns) {
    const x = ref % map.width;
    const y = Math.floor(ref / map.width);
    result.set(clientID, Math.abs(mx - x) + Math.abs(my - y));
  }
  return result;
}
