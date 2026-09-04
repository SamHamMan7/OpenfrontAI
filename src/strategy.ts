export interface PlayerSnapshot {
  clientID: string;
  troops: number;
  tilesOwned: number;
  isAlive: boolean;
  team: string | null;
}

export interface AggressionRecord {
  turn: number;
  troops: number;
}

export interface StrategyMemory {
  aggressors: ReadonlyMap<string, AggressionRecord>;
  lastTargetTurn: ReadonlyMap<string, number>;
  spawnDistance: ReadonlyMap<string, number>;
}

export interface CombatContext {
  turn: number;
  selfID: string;
  stats: readonly PlayerSnapshot[] | null;
  knownHostiles: readonly string[];
  memory: StrategyMemory;
  canExpandNeutral: boolean;
}

export type CombatDecision =
  | { kind: "hold"; reason: string }
  | {
      kind: "attack";
      targetID: string | null;
      troops: number | null;
      reason: string;
    };

const TARGET_COOLDOWN_TURNS = 80;
const RETALIATION_WINDOW_TURNS = 180;
const EARLY_EXPANSION_END_TURN = 1100;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sameTeam(self: PlayerSnapshot, other: PlayerSnapshot): boolean {
  return self.team !== null && other.team !== null && self.team === other.team;
}

function targetOffCooldown(
  clientID: string,
  turn: number,
  lastTargetTurn: ReadonlyMap<string, number>,
): boolean {
  const last = lastTargetTurn.get(clientID);
  return last === undefined || turn - last >= TARGET_COOLDOWN_TURNS;
}

function recentAggressor(
  candidates: readonly PlayerSnapshot[],
  memory: StrategyMemory,
  turn: number,
): { player: PlayerSnapshot; record: AggressionRecord } | null {
  let best: { player: PlayerSnapshot; record: AggressionRecord } | null = null;
  for (const player of candidates) {
    const record = memory.aggressors.get(player.clientID);
    if (!record || turn - record.turn > RETALIATION_WINDOW_TURNS) continue;
    if (!targetOffCooldown(player.clientID, turn, memory.lastTargetTurn)) continue;
    if (
      best === null ||
      record.turn > best.record.turn ||
      (record.turn === best.record.turn && record.troops > best.record.troops)
    ) {
      best = { player, record };
    }
  }
  return best;
}

function reserveTroops(self: PlayerSnapshot, enemies: readonly PlayerSnapshot[]): number {
  const nearbyThreats = enemies
    .filter((enemy) => (enemy.troops > 0 && enemy.isAlive))
    .map((enemy) => ({
      enemy,
      distance: Number.POSITIVE_INFINITY,
    }));

  // The caller's spawn-distance map is used in target scoring. Here we use a
  // robust global floor as a backstop: never empty the empire just because a
  // juicy target appeared.
  const strongest = nearbyThreats.reduce(
    (max, entry) => Math.max(max, entry.enemy.troops),
    0,
  );
  return Math.max(self.troops * 0.42, Math.min(self.troops * 0.72, strongest * 0.55));
}

function computeAttackTroops(
  self: PlayerSnapshot,
  target: PlayerSnapshot,
  enemies: readonly PlayerSnapshot[],
  aggression: AggressionRecord | null,
): number | null {
  const reserve = reserveTroops(self, enemies);
  const spendable = Math.floor(self.troops - reserve);
  if (spendable < 1) return null;

  let desired = Math.max(self.troops * 0.24, target.troops * 1.15 + 250);
  if (target.troops < self.troops * 0.2) {
    desired = Math.max(desired, target.troops * 1.8 + 500);
  }
  if (aggression) {
    // Counter-attacks cancel opposing attacks in OpenFront. Cover the recently
    // observed incoming stack when we can do so without violating the reserve.
    desired = Math.max(desired, aggression.troops * 1.08);
  }

  const amount = Math.min(spendable, Math.floor(desired));
  if (amount < 1) return null;

  // Avoid feeding a much stronger target unless this is retaliation.
  if (!aggression && target.troops > self.troops * 0.92) return null;
  // Avoid token attacks that are very unlikely to matter.
  if (!aggression && amount < target.troops * 0.22) return null;
  return amount;
}

function targetScore(
  self: PlayerSnapshot,
  target: PlayerSnapshot,
  memory: StrategyMemory,
  turn: number,
): number {
  const troopRatio = self.troops / Math.max(1, target.troops);
  const density = target.troops / Math.max(1, target.tilesOwned);
  const distance = memory.spawnDistance.get(target.clientID);
  const proximity = distance === undefined ? 0 : 1 / (1 + distance / 250);
  const aggression = memory.aggressors.get(target.clientID);
  const recentAggression =
    aggression && turn - aggression.turn <= RETALIATION_WINDOW_TURNS ? 2.2 : 0;

  return (
    Math.log2(Math.max(0.125, troopRatio)) * 2.5 +
    proximity * 1.4 -
    Math.log10(Math.max(1, density)) * 0.25 -
    Math.log10(Math.max(1, target.tilesOwned)) * 0.15 +
    recentAggression
  );
}

function chooseFallback(
  context: CombatContext,
): CombatDecision {
  // Without trusted troop/team stats, do not invent percentages or blindly
  // attack arbitrary players. null asks OpenFront to use its configured attack
  // amount, which is far safer than the old hard-coded 0.3 troops.
  let retaliator: { id: string; record: AggressionRecord } | null = null;
  for (const [id, record] of context.memory.aggressors) {
    if (context.turn - record.turn > RETALIATION_WINDOW_TURNS) continue;
    if (!targetOffCooldown(id, context.turn, context.memory.lastTargetTurn)) continue;
    if (!retaliator || record.turn > retaliator.record.turn) {
      retaliator = { id, record };
    }
  }
  if (retaliator) {
    return {
      kind: "attack",
      targetID: retaliator.id,
      troops: null,
      reason: "retaliate with server-calculated attack amount",
    };
  }

  if (context.canExpandNeutral) {
    return {
      kind: "attack",
      targetID: null,
      troops: null,
      reason: "expand neutral territory with server-calculated attack amount",
    };
  }

  // Only use knownHostiles when the caller can actually establish hostility
  // (e.g. FFA). Prefer the nearest spawn rather than a random player.
  const target = context.knownHostiles
    .filter((id) => targetOffCooldown(id, context.turn, context.memory.lastTargetTurn))
    .sort((a, b) => {
      const da = context.memory.spawnDistance.get(a) ?? Number.POSITIVE_INFINITY;
      const db = context.memory.spawnDistance.get(b) ?? Number.POSITIVE_INFINITY;
      return da - db;
    })[0];
  if (target) {
    return {
      kind: "attack",
      targetID: target,
      troops: null,
      reason: "pressure nearest known hostile with server-calculated attack amount",
    };
  }

  return { kind: "hold", reason: "no safe target without live stats" };
}

export function chooseCombatDecision(context: CombatContext): CombatDecision {
  if (!context.stats) return chooseFallback(context);

  const self = context.stats.find((player) => player.clientID === context.selfID);
  if (!self || !self.isAlive) {
    return { kind: "hold", reason: "self missing or eliminated in live stats" };
  }

  const enemies = context.stats.filter(
    (player) =>
      player.clientID !== self.clientID &&
      player.isAlive &&
      !sameTeam(self, player),
  );
  if (enemies.length === 0) {
    return context.canExpandNeutral
      ? {
          kind: "attack",
          targetID: null,
          troops: Math.max(1, Math.floor(self.troops * 0.2)),
          reason: "no enemy players remain; finish neutral expansion",
        }
      : { kind: "hold", reason: "no hostile players remain" };
  }

  const aggressor = recentAggressor(enemies, context.memory, context.turn);
  if (aggressor) {
    const troops = computeAttackTroops(
      self,
      aggressor.player,
      enemies,
      aggressor.record,
    );
    if (troops !== null) {
      return {
        kind: "attack",
        targetID: aggressor.player.clientID,
        troops,
        reason: `retaliate against recent attacker (${Math.round(aggressor.record.troops)} observed troops)`,
      };
    }
  }

  // Expansion has the highest expected value early, but stop mindlessly pouring
  // troops into neutral land once the map should be mostly claimed.
  if (
    context.canExpandNeutral &&
    context.turn <= EARLY_EXPANSION_END_TURN &&
    self.troops >= 1_500
  ) {
    const reserve = reserveTroops(self, enemies);
    const amount = Math.min(
      Math.floor(self.troops * 0.28),
      Math.floor(self.troops - reserve),
    );
    if (amount >= 1) {
      return {
        kind: "attack",
        targetID: null,
        troops: amount,
        reason: "prioritize early neutral expansion while keeping a reserve",
      };
    }
  }

  const candidates = enemies
    .filter((enemy) =>
      targetOffCooldown(enemy.clientID, context.turn, context.memory.lastTargetTurn),
    )
    .map((enemy) => ({
      enemy,
      score: targetScore(self, enemy, context.memory, context.turn),
    }))
    .sort((a, b) => b.score - a.score);

  for (const { enemy } of candidates) {
    const troops = computeAttackTroops(self, enemy, enemies, null);
    if (troops === null) continue;
    return {
      kind: "attack",
      targetID: enemy.clientID,
      troops,
      reason: `attack favorable target (${Math.round(self.troops)} vs ${Math.round(enemy.troops)} troops)`,
    };
  }

  if (context.canExpandNeutral && self.troops >= 2_000) {
    const reserve = reserveTroops(self, enemies);
    const amount = Math.min(
      Math.floor(self.troops * 0.18),
      Math.floor(self.troops - reserve),
    );
    if (amount >= 1) {
      return {
        kind: "attack",
        targetID: null,
        troops: amount,
        reason: "no favorable war; take neutral land instead",
      };
    }
  }

  return { kind: "hold", reason: "reserve or matchup says to wait" };
}

export function sanitizeLiveStats(value: unknown): PlayerSnapshot[] | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as { players?: unknown };
  if (!Array.isArray(maybe.players)) return null;

  const players: PlayerSnapshot[] = [];
  for (const raw of maybe.players) {
    if (!raw || typeof raw !== "object") continue;
    const player = raw as Record<string, unknown>;
    if (typeof player.clientID !== "string") continue;
    if (typeof player.troops !== "number") continue;
    if (typeof player.tilesOwned !== "number") continue;
    if (typeof player.isAlive !== "boolean") continue;
    players.push({
      clientID: player.clientID,
      troops: finiteNonNegative(player.troops),
      tilesOwned: Math.floor(finiteNonNegative(player.tilesOwned)),
      isAlive: player.isAlive,
      team: typeof player.team === "string" ? player.team : null,
    });
  }
  return players.length > 0 ? players : null;
}
