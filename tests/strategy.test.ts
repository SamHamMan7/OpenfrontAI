import assert from "node:assert/strict";
import test from "node:test";
import { chooseCombatDecision, sanitizeLiveStats } from "../src/strategy.js";

function memory() {
  return {
    aggressors: new Map<string, { turn: number; troops: number }>(),
    lastTargetTurn: new Map<string, number>(),
    spawnDistance: new Map<string, number>(),
  };
}

test("fallback expansion uses the server attack amount instead of a fake ratio", () => {
  const decision = chooseCombatDecision({
    turn: 500,
    selfID: "me",
    stats: null,
    knownHostiles: [],
    memory: memory(),
    canExpandNeutral: true,
  });
  assert.deepEqual(decision, {
    kind: "attack",
    targetID: null,
    troops: null,
    reason: "expand neutral territory with server-calculated attack amount",
  });
});

test("recent attackers are prioritized for retaliation", () => {
  const m = memory();
  m.aggressors.set("attacker", { turn: 490, troops: 12_000 });
  const decision = chooseCombatDecision({
    turn: 500,
    selfID: "me",
    stats: [
      { clientID: "me", troops: 50_000, tilesOwned: 5_000, isAlive: true, team: null },
      { clientID: "attacker", troops: 12_000, tilesOwned: 1_500, isAlive: true, team: null },
    ],
    knownHostiles: ["attacker"],
    memory: m,
    canExpandNeutral: true,
  });
  assert.equal(decision.kind, "attack");
  if (decision.kind !== "attack") return;
  assert.equal(decision.targetID, "attacker");
  assert.equal(typeof decision.troops, "number");
  assert.ok((decision.troops ?? 0) >= 12_000);
});

test("same-team players are never selected as combat targets", () => {
  const decision = chooseCombatDecision({
    turn: 1_300,
    selfID: "me",
    stats: [
      { clientID: "me", troops: 10_000, tilesOwned: 4_000, isAlive: true, team: "Red" },
      { clientID: "friend", troops: 10, tilesOwned: 10, isAlive: true, team: "Red" },
      { clientID: "enemy", troops: 2_000, tilesOwned: 400, isAlive: true, team: "Blue" },
    ],
    knownHostiles: [],
    memory: memory(),
    canExpandNeutral: false,
  });
  assert.equal(decision.kind, "attack");
  if (decision.kind !== "attack") return;
  assert.equal(decision.targetID, "enemy");
});

test("live stats are validated and negative numeric junk is clamped", () => {
  const stats = sanitizeLiveStats({
    players: [
      { clientID: "p", troops: -10, tilesOwned: 5, isAlive: true, team: null },
      { clientID: 123, troops: 50, tilesOwned: 10, isAlive: true },
    ],
  });
  if (!stats) throw new Error("expected valid stats");
  assert.equal(stats.length, 1);
  assert.equal(stats[0].troops, 0);
});
