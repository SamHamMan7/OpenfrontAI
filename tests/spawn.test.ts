import assert from "node:assert/strict";
import test from "node:test";
import { chooseSpawnTile, spawnDistanceMap } from "../src/spawn.js";

function rectangleMap() {
  const width = 100;
  const height = 60;
  const terrain = new Uint8Array(width * height);
  const landTiles: number[] = [];
  for (let y = 10; y < 50; y++) {
    for (let x = 10; x < 90; x++) {
      const ref = y * width + x;
      terrain[ref] = 0x80;
      landTiles.push(ref);
    }
  }
  return { terrain, width, height, landTiles };
}

test("spawn selection keeps distance from already observed spawns", () => {
  const map = rectangleMap();
  const occupied = 30 * map.width + 50;
  const ref = chooseSpawnTile(map, { occupiedSpawns: [occupied], maxCandidates: 1_000 });
  const x = ref % map.width;
  const y = Math.floor(ref / map.width);
  assert.ok(x >= 10 && x < 90 && y >= 10 && y < 50);
  assert.ok(Math.abs(x - 50) + Math.abs(y - 30) >= 28);
});

test("spawn distance map uses map coordinates rather than raw tile index gaps", () => {
  const map = rectangleMap();
  const distances = spawnDistanceMap(
    map,
    20 * map.width + 20,
    new Map([["enemy", 25 * map.width + 30]]),
  );
  assert.equal(distances.get("enemy"), 15);
});
