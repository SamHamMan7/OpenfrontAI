/**
 * Replay action extractor.
 *
 * This intentionally does NOT fabricate board tensors. OpenFront replays store
 * intents, not a full board snapshot; reconstructing exact state requires the
 * exact OpenFront engine commit recorded by each replay. The previous extractor
 * silently invented attack labels from target tiles and treated absolute troop
 * counts as ratios, which poisoned training data.
 *
 * This script emits semantically correct winner action examples as JSONL. A
 * future state-reconstruction pipeline can join these labels to exact engine
 * snapshots without changing the action contract again.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface ReplayIntent {
  type?: string;
  clientID?: string;
  tile?: number;
  targetID?: string | null;
  troops?: number | null;
}

interface ReplayTurn {
  turnNumber?: number;
  intents?: ReplayIntent[];
}

interface ReplayRecord {
  gitCommit?: string;
  info?: {
    gameID?: string;
    winner?: unknown;
    config?: Record<string, unknown>;
  };
  turns?: ReplayTurn[];
}

interface ActionExample {
  schemaVersion: 1;
  gameID: string;
  gitCommit: string | null;
  turnNumber: number;
  clientID: string;
  winner: true;
  config: Record<string, unknown>;
  action:
    | { type: "spawn"; tile: number }
    | { type: "attack"; targetID: string | null; troops: number | null };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inputDir = path.resolve(__dirname, process.argv[2] ?? "pro_replays");
const outputFile = path.resolve(
  __dirname,
  process.argv[3] ?? "training/intent_dataset.jsonl",
);

function winnerIDs(winner: unknown): Set<string> {
  if (typeof winner === "string") return new Set([winner]);
  if (!Array.isArray(winner) || winner.length < 2) return new Set();

  const tag = winner[0];
  const start = tag === "team" || tag === "nation" ? 2 : 1;
  return new Set(
    winner
      .slice(start)
      .filter((value): value is string => typeof value === "string"),
  );
}

function actionFromIntent(intent: ReplayIntent): ActionExample["action"] | null {
  if (intent.type === "spawn" && Number.isInteger(intent.tile)) {
    return { type: "spawn", tile: intent.tile! };
  }
  if (intent.type === "attack") {
    const targetID = typeof intent.targetID === "string" ? intent.targetID : null;
    const troops =
      typeof intent.troops === "number" && Number.isFinite(intent.troops)
        ? Math.max(0, intent.troops)
        : null;
    return { type: "attack", targetID, troops };
  }
  return null;
}

function extractReplay(file: string, replay: ReplayRecord): ActionExample[] {
  const gameID = replay.info?.gameID ?? path.basename(file).replace(/^game_/, "").replace(/\.json$/, "");
  const winners = winnerIDs(replay.info?.winner);
  if (winners.size === 0) return [];

  const config = replay.info?.config ?? {};
  const examples: ActionExample[] = [];
  for (const turn of replay.turns ?? []) {
    const turnNumber = Number(turn.turnNumber ?? 0);
    for (const intent of turn.intents ?? []) {
      if (typeof intent.clientID !== "string" || !winners.has(intent.clientID)) continue;
      const action = actionFromIntent(intent);
      if (!action) continue;
      examples.push({
        schemaVersion: 1,
        gameID,
        gitCommit: replay.gitCommit ?? null,
        turnNumber: Number.isFinite(turnNumber) ? turnNumber : 0,
        clientID: intent.clientID,
        winner: true,
        config,
        action,
      });
    }
  }
  return examples;
}

function main(): void {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Replay directory not found: ${inputDir}`);
  }

  const files = fs.readdirSync(inputDir).filter((name) => name.endsWith(".json")).sort();
  const lines: string[] = [];
  let skipped = 0;
  for (const name of files) {
    const file = path.join(inputDir, name);
    try {
      const replay = JSON.parse(fs.readFileSync(file, "utf8")) as ReplayRecord;
      const examples = extractReplay(file, replay);
      if (examples.length === 0) skipped++;
      for (const example of examples) lines.push(JSON.stringify(example));
    } catch (error) {
      console.warn(`[extract] ${name}: ${String(error)}`);
      skipped++;
    }
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  console.log(`[extract] ${lines.length} winner actions from ${files.length} replay(s)`);
  console.log(`[extract] ${skipped} replay(s) produced no usable winner actions`);
  console.log(`[extract] wrote ${outputFile}`);
}

main();
