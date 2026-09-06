/**
 * OpenFrontAI v3 - direct WebSocket bot with protocol-aware transport,
 * geometry-aware spawning, live-stat strategy, and explicit intent acks.
 *
 * Typical usage:
 *   npm run bot -- <gameID>
 *   npm run bot -- <gameID> <workerIndex>
 *
 * Environment:
 *   OPENFRONT_HTTP_BASE=http://localhost:9000
 *   OPENFRONT_WS_BASE=ws://localhost:9000
 *   OPENFRONT_SOURCE=../OpenFrontIO      # exact checkout for current zbin
 *   OPENFRONT_PROTOCOL=auto|json|zbin
 *   OPENFRONT_PLAY_TOKEN=<jwt-or-local-dev-persistent-id>
 *   OPENFRONT_TURNSTILE_TOKEN=<fresh-token-for-first-production-join>
 *   OPENFRONT_JOIN_MODE=join|rejoin
 *   OPENFRONT_REJOIN_LAST_TURN=0
 *   OPENFRONT_ADMIN_BOT_KEY=<same key as local server> # optional live stats
 *   OPENFRONT_MODEL=./models/openfront_v2.onnx
 */

import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import * as ort from "onnxruntime-node";
import { createProtocolAdapter, type ProtocolAdapter } from "./src/protocol.js";
import {
  chooseSpawnTile,
  spawnDistanceMap,
  type ModelHeatmap,
  type SpawnTerrain,
} from "./src/spawn.js";
import {
  chooseCombatDecision,
  sanitizeLiveStats,
  type AggressionRecord,
  type PlayerSnapshot,
} from "./src/strategy.js";

const HTTP_BASE = (process.env.OPENFRONT_HTTP_BASE ?? "http://localhost:9000").replace(/\/$/, "");
const WS_BASE = (process.env.OPENFRONT_WS_BASE ?? HTTP_BASE.replace(/^http/, "ws")).replace(/\/$/, "");
const BOT_USERNAME = process.env.OPENFRONT_BOT_NAME ?? "OpenFrontAI-v3";
const ADMIN_KEY = process.env.OPENFRONT_ADMIN_BOT_KEY ?? null;
const MODEL_PATH = process.env.OPENFRONT_MODEL ?? "./models/openfront_v2.onnx";
const DEFAULT_WORKERS = Number(process.env.OPENFRONT_NUM_WORKERS ?? 3);
const TURNSTILE_TOKEN = process.env.OPENFRONT_TURNSTILE_TOKEN?.trim() || null;
const JOIN_MODE = (process.env.OPENFRONT_JOIN_MODE ?? "join").toLowerCase();
const REJOIN_LAST_TURN = Math.max(0, Number(process.env.OPENFRONT_REJOIN_LAST_TURN ?? 0) || 0);

const MODEL_WIDTH = 1000;
const MODEL_HEIGHT = 500;
const IS_LAND_BIT = 0x80;
const SPAWN_WAIT_TURNS = Number(process.env.OPENFRONT_SPAWN_WAIT_TURNS ?? 18);
const SPAWN_RETRY_TURNS = Number(process.env.OPENFRONT_SPAWN_RETRY_TURNS ?? 35);
const COMBAT_START_TURN = Number(process.env.OPENFRONT_COMBAT_START_TURN ?? 310);
const DECISION_EVERY_TURNS = Number(process.env.OPENFRONT_DECISION_EVERY_TURNS ?? 18);
const NEUTRAL_COOLDOWN_TURNS = Number(process.env.OPENFRONT_NEUTRAL_COOLDOWN_TURNS ?? 55);
const STATS_REFRESH_TURNS = Number(process.env.OPENFRONT_STATS_REFRESH_TURNS ?? 20);
const HEARTBEAT_MS = Number(process.env.OPENFRONT_HEARTBEAT_MS ?? 5000);
const INTENT_ACK_TURNS = Number(process.env.OPENFRONT_INTENT_ACK_TURNS ?? 4);

function isLocalServer(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

const LOCAL_SERVER = isLocalServer(HTTP_BASE);
const BOT_TOKEN = process.env.OPENFRONT_PLAY_TOKEN?.trim() || (LOCAL_SERVER ? randomUUID() : null);

interface TerrainInfo extends SpawnTerrain {
  landTiles: number[];
}

interface PlayerInfo {
  clientID: string;
  username?: string;
  teamIndex?: number;
}

interface PendingIntent {
  intent: any;
  sentTurn: number;
  sentAt: number;
  description: string;
}

interface BotState {
  gameID: string;
  workerIndex: number;
  myClientID: string | null;
  roster: Map<string, PlayerInfo>;
  gameMode: string | null;
  turn: number;
  admitted: boolean;
  started: boolean;
  isPlayer: boolean;
  spawned: boolean;
  mySpawn: number | null;
  spawns: Map<string, number>;
  terrain: TerrainInfo | null;
  modelPrior: ModelHeatmap | null;
  aggressors: Map<string, AggressionRecord>;
  lastTargetTurn: Map<string, number>;
  lastNeutralTurn: number;
  lastDecisionTurn: number;
  lastSpawnAttemptTurn: number;
  lastStatsTurn: number;
  stats: PlayerSnapshot[] | null;
  decisionInFlight: boolean;
  pendingIntents: PendingIntent[];
}

function sendRaw(ws: WebSocket, protocol: ProtocolAdapter, message: unknown): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn("[NET] Tried to send while WebSocket was not open");
    return false;
  }
  try {
    ws.send(protocol.encode(message));
    return true;
  } catch (error) {
    console.error(`[WIRE] Failed to encode/send message: ${String(error)}`);
    return false;
  }
}

function describeIntent(intent: any): string {
  if (intent?.type === "spawn") return `spawn(tile=${intent.tile})`;
  if (intent?.type === "attack") {
    const target = intent.targetID === null ? "neutral" : intent.targetID;
    const troops = intent.troops === null ? "default" : Math.round(Number(intent.troops)).toLocaleString();
    return `attack(target=${target}, troops=${troops})`;
  }
  return String(intent?.type ?? "unknown");
}

function sendIntent(
  ws: WebSocket,
  protocol: ProtocolAdapter,
  state: BotState,
  intent: any,
): boolean {
  if (!state.admitted) {
    console.warn(`[INTENT] Refusing to send ${describeIntent(intent)} before server admission`);
    return false;
  }
  if (state.started && !state.isPlayer) {
    console.warn(`[INTENT] Refusing to send ${describeIntent(intent)} because this connection is a spectator`);
    return false;
  }
  const description = describeIntent(intent);
  if (!sendRaw(ws, protocol, { type: "intent", intent })) return false;
  state.pendingIntents.push({ intent, sentTurn: state.turn, sentAt: Date.now(), description });
  console.log(`[INTENT] Sent ${description} at turn ${state.turn}`);
  return true;
}

function workerPath(index: number): string {
  return `/w${index}`;
}

async function fetchNumWorkers(): Promise<number> {
  try {
    const response = await fetch(`${HTTP_BASE}/api/server_config`);
    if (!response.ok) return DEFAULT_WORKERS;
    const data = (await response.json()) as any;
    const value = Number(data.numWorkers);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_WORKERS;
  } catch {
    return DEFAULT_WORKERS;
  }
}

async function findWorkerForGame(gameID: string): Promise<number> {
  const count = await fetchNumWorkers();
  for (let index = 0; index < count; index++) {
    for (const route of [
      `${HTTP_BASE}${workerPath(index)}/api/game/${gameID}`,
      `${HTTP_BASE}${workerPath(index)}/api/game_info/${gameID}`,
    ]) {
      try {
        const response = await fetch(route);
        if (response.ok) return index;
      } catch {
        // Try the next endpoint/worker.
      }
    }
  }
  return 0;
}

function normalizeMapKey(mapName: string): string[] {
  const snake = mapName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const compact = mapName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...new Set([snake, compact])];
}

function collectLandTiles(terrain: Uint8Array, width: number, height: number): number[] {
  const margin = Math.max(4, Math.floor(Math.min(width, height) * 0.02));
  const result: number[] = [];
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const ref = y * width + x;
      if ((terrain[ref] & IS_LAND_BIT) !== 0) result.push(ref);
    }
  }
  return result;
}

async function loadTerrain(mapName: string): Promise<TerrainInfo | null> {
  for (const key of normalizeMapKey(mapName)) {
    try {
      const [manifestResponse, mapResponse] = await Promise.all([
        fetch(`${HTTP_BASE}/maps/${key}/manifest.json`),
        fetch(`${HTTP_BASE}/maps/${key}/map.bin`),
      ]);
      if (!manifestResponse.ok || !mapResponse.ok) continue;
      const manifest = (await manifestResponse.json()) as any;
      const width = Number(manifest?.map?.width);
      const height = Number(manifest?.map?.height);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) continue;
      const terrain = new Uint8Array(await mapResponse.arrayBuffer());
      if (terrain.length < width * height) continue;
      const landTiles = collectLandTiles(terrain, width, height);
      console.log(`[MAP] ${mapName}: ${width}x${height}, ${landTiles.length} candidate land tiles`);
      return { terrain, width, height, landTiles, landBit: IS_LAND_BIT };
    } catch {
      // Try alternate map key.
    }
  }
  console.warn(`[MAP] Could not load terrain for ${mapName}`);
  return null;
}

async function loadModel(): Promise<ort.InferenceSession | null> {
  try {
    const session = await ort.InferenceSession.create(MODEL_PATH);
    console.log(`[MODEL] Loaded ${MODEL_PATH}; using it as a spawn prior only`);
    return session;
  } catch (error) {
    console.warn(`[MODEL] Optional model unavailable; geometry spawn remains active: ${String(error)}`);
    return null;
  }
}

async function buildModelPrior(
  session: ort.InferenceSession | null,
  terrain: TerrainInfo,
): Promise<ModelHeatmap | null> {
  if (!session) return null;
  try {
    const input = new Float32Array(MODEL_WIDTH * MODEL_HEIGHT);
    const sx = terrain.width / MODEL_WIDTH;
    const sy = terrain.height / MODEL_HEIGHT;
    for (let y = 0; y < MODEL_HEIGHT; y++) {
      for (let x = 0; x < MODEL_WIDTH; x++) {
        const ref = Math.min(
          terrain.terrain.length - 1,
          Math.floor(y * sy) * terrain.width + Math.floor(x * sx),
        );
        input[y * MODEL_WIDTH + x] = (terrain.terrain[ref] & IS_LAND_BIT) !== 0 ? 0.2 : 0;
      }
    }
    const result = await session.run({
      map_state: new ort.Tensor("float32", input, [1, 1, MODEL_HEIGHT, MODEL_WIDTH]),
    });
    const output = result.click_heatmap;
    if (!output) return null;
    return { data: output.data as ArrayLike<number>, width: MODEL_WIDTH, height: MODEL_HEIGHT };
  } catch (error) {
    console.warn(`[MODEL] Spawn-prior inference failed; continuing heuristically: ${String(error)}`);
    return null;
  }
}

function turnPayload(message: any): { turnNumber: number; intents: any[] } | null {
  const turn = message?.turn ?? message;
  if (!turn || !Array.isArray(turn.intents)) return null;
  const turnNumber = Number(turn.turnNumber);
  return { turnNumber: Number.isFinite(turnNumber) ? turnNumber : 0, intents: turn.intents };
}

function nullableNumberMatches(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(0.5, Math.abs(a) * 1e-6);
}

function intentMatches(sent: any, echoed: any): boolean {
  if (!sent || !echoed || sent.type !== echoed.type) return false;
  if (sent.type === "spawn") return sent.tile === echoed.tile;
  if (sent.type === "attack") {
    return sent.targetID === echoed.targetID && nullableNumberMatches(sent.troops, echoed.troops);
  }
  return true;
}

function acknowledgeOwnIntent(state: BotState, echoed: any, turnNumber: number): void {
  const index = state.pendingIntents.findIndex((pending) => intentMatches(pending.intent, echoed));
  if (index < 0) {
    console.log(`[ACK] Server echoed own ${describeIntent(echoed)} on turn ${turnNumber}`);
    return;
  }
  const [pending] = state.pendingIntents.splice(index, 1);
  const latency = Date.now() - pending.sentAt;
  console.log(`[ACK] ${pending.description} accepted into turn ${turnNumber} (${latency} ms)`);
}

function expireUnackedIntents(state: BotState, turnNumber: number): void {
  const keep: PendingIntent[] = [];
  for (const pending of state.pendingIntents) {
    if (turnNumber - pending.sentTurn >= INTENT_ACK_TURNS) {
      console.warn(
        `[ACK] No server echo for ${pending.description} after ${turnNumber - pending.sentTurn} turns. ` +
          "This points to admission, wire-schema, rate-limit, or spectator issues rather than strategy.",
      );
    } else {
      keep.push(pending);
    }
  }
  state.pendingIntents = keep;
}

function recordTurn(state: BotState, turnNumber: number, intents: readonly any[]): void {
  state.turn = Math.max(state.turn, turnNumber);
  for (const intent of intents) {
    if (!intent || typeof intent !== "object") continue;
    if (intent.clientID === state.myClientID) acknowledgeOwnIntent(state, intent, turnNumber);

    if (intent.type === "spawn" && typeof intent.clientID === "string" && Number.isInteger(intent.tile)) {
      state.spawns.set(intent.clientID, intent.tile);
      if (intent.clientID === state.myClientID) {
        state.spawned = true;
        state.mySpawn = intent.tile;
        console.log(`[SPAWN] Accepted at tile ${intent.tile}`);
      }
      continue;
    }

    if (intent.type === "attack" && typeof intent.clientID === "string") {
      if (intent.targetID === state.myClientID && intent.clientID !== state.myClientID) {
        const troops = typeof intent.troops === "number" && Number.isFinite(intent.troops) ? Math.max(0, intent.troops) : 0;
        const previous = state.aggressors.get(intent.clientID);
        const combined = previous && turnNumber - previous.turn <= 30 ? previous.troops + troops : troops;
        state.aggressors.set(intent.clientID, { turn: turnNumber, troops: combined });
      }
    }
  }
  expireUnackedIntents(state, turnNumber);
}

function knownHostiles(state: BotState): string[] {
  if (!state.myClientID) return [];
  if ((state.gameMode ?? "").toLowerCase() !== "ffa") return [];
  return [...state.roster.keys()].filter((id) => id !== state.myClientID);
}

async function fetchLiveStats(state: BotState): Promise<PlayerSnapshot[] | null> {
  if (!ADMIN_KEY) return null;
  const candidates = [
    `${HTTP_BASE}${workerPath(state.workerIndex)}/api/adminbot/game/${state.gameID}/stats`,
    `${HTTP_BASE}/api/adminbot/game/${state.gameID}/stats`,
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers: { "x-admin-bot-key": ADMIN_KEY } });
      if (response.status === 404) continue;
      if (!response.ok) return null;
      const data = (await response.json()) as any;
      return sanitizeLiveStats(data?.liveStats);
    } catch {
      // Try the alternate route.
    }
  }
  return null;
}

function spawnTile(state: BotState): number {
  if (!state.terrain) return -1;
  const occupied = [...state.spawns.entries()]
    .filter(([id]) => id !== state.myClientID)
    .map(([, ref]) => ref);
  return chooseSpawnTile(state.terrain, { occupiedSpawns: occupied, model: state.modelPrior });
}

function maybeSendSpawn(ws: WebSocket, protocol: ProtocolAdapter, state: BotState): void {
  if (state.spawned || !state.started || !state.isPlayer || !state.terrain) return;
  if (state.turn < SPAWN_WAIT_TURNS) return;
  if (state.turn - state.lastSpawnAttemptTurn < SPAWN_RETRY_TURNS) return;
  const tile = spawnTile(state);
  if (tile < 0) return;
  state.lastSpawnAttemptTurn = state.turn;
  console.log(`[SPAWN] Attempting tile ${tile}; observed ${state.spawns.size} other spawn(s)`);
  sendIntent(ws, protocol, state, { type: "spawn", tile });
}

async function maybeDecideCombat(
  ws: WebSocket,
  protocol: ProtocolAdapter,
  state: BotState,
): Promise<void> {
  if (!state.spawned || !state.isPlayer || state.turn < COMBAT_START_TURN) return;
  if (state.turn - state.lastDecisionTurn < DECISION_EVERY_TURNS) return;
  if (state.decisionInFlight) return;

  state.decisionInFlight = true;
  state.lastDecisionTurn = state.turn;
  try {
    if (ADMIN_KEY && state.turn - state.lastStatsTurn >= STATS_REFRESH_TURNS) {
      const latest = await fetchLiveStats(state);
      state.lastStatsTurn = state.turn;
      if (latest) state.stats = latest;
    }

    const distances =
      state.terrain && state.mySpawn !== null
        ? spawnDistanceMap(state.terrain, state.mySpawn, state.spawns)
        : new Map<string, number>();
    const decision = chooseCombatDecision({
      turn: state.turn,
      selfID: state.myClientID ?? "",
      stats: state.stats,
      knownHostiles: knownHostiles(state),
      memory: {
        aggressors: state.aggressors,
        lastTargetTurn: state.lastTargetTurn,
        spawnDistance: distances,
      },
      canExpandNeutral: state.turn - state.lastNeutralTurn >= NEUTRAL_COOLDOWN_TURNS,
    });

    if (decision.kind === "hold") {
      if (state.turn % 180 < DECISION_EVERY_TURNS) console.log(`[AI] HOLD - ${decision.reason}`);
      return;
    }

    const amountText = decision.troops === null ? "server default" : Math.round(decision.troops).toLocaleString();
    const targetText = decision.targetID === null ? "neutral" : decision.targetID;
    console.log(`[AI] ATTACK ${targetText} with ${amountText} - ${decision.reason}`);
    if (
      sendIntent(ws, protocol, state, {
        type: "attack",
        targetID: decision.targetID,
        troops: decision.troops,
      })
    ) {
      if (decision.targetID === null) state.lastNeutralTurn = state.turn;
      else state.lastTargetTurn.set(decision.targetID, state.turn);
    }
  } finally {
    state.decisionInFlight = false;
  }
}

function sendAdmissionMessage(ws: WebSocket, protocol: ProtocolAdapter, gameID: string): void {
  if (!BOT_TOKEN) throw new Error("OPENFRONT_PLAY_TOKEN is required for non-local OpenFront servers");

  if (JOIN_MODE === "rejoin") {
    console.log(`[AUTH] Sending rejoin from turn ${REJOIN_LAST_TURN}`);
    sendRaw(ws, protocol, {
      type: "rejoin",
      gameID,
      lastTurn: REJOIN_LAST_TURN,
      token: BOT_TOKEN,
    });
    return;
  }

  if (JOIN_MODE !== "join") {
    throw new Error(`Unsupported OPENFRONT_JOIN_MODE=${JOIN_MODE}; expected join or rejoin`);
  }

  if (!LOCAL_SERVER && TURNSTILE_TOKEN === null) {
    console.warn(
      "[AUTH] No Turnstile token supplied. Current production OpenFront rejects a first join without one. " +
        "This is only expected to work if this token identity was already admitted to this same game (or on local Dev).",
    );
  }
  console.log(`[AUTH] Sending join${TURNSTILE_TOKEN ? " with Turnstile token" : ""}`);
  sendRaw(ws, protocol, {
    type: "join",
    token: BOT_TOKEN,
    gameID,
    username: BOT_USERNAME,
    clanTag: null,
    turnstileToken: TURNSTILE_TOKEN,
  });
}

async function connect(gameID: string, workerIndex: number): Promise<void> {
  if (!BOT_TOKEN) {
    throw new Error(
      "Remote OpenFront no longer accepts a generated persistent ID as a play token. " +
        "Set OPENFRONT_PLAY_TOKEN locally to a valid token for your own session; do not paste it into chat or commit it.",
    );
  }

  const protocol = await createProtocolAdapter();
  const model = await loadModel();
  const state: BotState = {
    gameID,
    workerIndex,
    myClientID: null,
    roster: new Map(),
    gameMode: null,
    turn: 0,
    admitted: false,
    started: false,
    isPlayer: false,
    spawned: false,
    mySpawn: null,
    spawns: new Map(),
    terrain: null,
    modelPrior: null,
    aggressors: new Map(),
    lastTargetTurn: new Map(),
    lastNeutralTurn: Number.NEGATIVE_INFINITY,
    lastDecisionTurn: Number.NEGATIVE_INFINITY,
    lastSpawnAttemptTurn: Number.NEGATIVE_INFINITY,
    lastStatsTurn: Number.NEGATIVE_INFINITY,
    stats: null,
    decisionInFlight: false,
    pendingIntents: [],
  };

  const url = `${WS_BASE}${workerPath(workerIndex)}`;
  console.log(`[NET] Opening WebSocket to ${gameID} on worker ${workerIndex} (${protocol.mode})`);
  const ws = new WebSocket(url);
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  ws.on("open", () => {
    console.log("[NET] WebSocket handshake succeeded; waiting for game-server admission");
    sendAdmissionMessage(ws, protocol, gameID);
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) sendRaw(ws, protocol, { type: "ping" });
    }, HEARTBEAT_MS);
  });

  ws.on("message", (raw: RawData) => {
    void (async () => {
      let message: any;
      try {
        if (typeof raw === "string") message = protocol.decode(raw);
        else if (raw instanceof ArrayBuffer) message = protocol.decode(raw);
        else if (Array.isArray(raw)) message = protocol.decode(Buffer.concat(raw));
        else message = protocol.decode(raw as Buffer);
      } catch (error) {
        console.error(`[WIRE] Could not decode server frame in ${protocol.mode} mode: ${String(error)}`);
        return;
      }

      protocol.observe(message);

      if (message?.type === "ping") {
        sendRaw(ws, protocol, { type: "ping" });
        return;
      }
      if (message?.type === "error") {
        console.error(`[SERVER] ${message.error ?? message.message ?? "unknown error"}`);
        return;
      }
      if (message?.type === "lobby_info") {
        state.admitted = true;
        state.myClientID = message.myClientID ?? state.myClientID;
        console.log(`[AUTH] Admitted as client ${state.myClientID ?? "unknown"}`);
        return;
      }
      if (message?.type === "prestart") {
        state.admitted = true;
        const mapName = String(message.gameMap ?? "");
        if (mapName) {
          state.terrain = await loadTerrain(mapName);
          if (state.terrain) state.modelPrior = await buildModelPrior(model, state.terrain);
        }
        return;
      }
      if (message?.type === "start") {
        state.admitted = true;
        state.started = true;
        state.myClientID = message.myClientID ?? state.myClientID;
        const info = message.gameStartInfo ?? {};
        const players = Array.isArray(info.players) ? info.players : [];
        state.roster.clear();
        for (const player of players) {
          if (typeof player?.clientID !== "string") continue;
          state.roster.set(player.clientID, {
            clientID: player.clientID,
            username: typeof player.username === "string" ? player.username : undefined,
            teamIndex: typeof player.teamIndex === "number" ? player.teamIndex : undefined,
          });
        }
        state.isPlayer = state.myClientID !== null && state.roster.has(state.myClientID);
        state.gameMode = typeof info?.config?.gameMode === "string" ? info.config.gameMode : null;
        if (!state.terrain && typeof info?.config?.gameMap === "string") {
          state.terrain = await loadTerrain(info.config.gameMap);
          if (state.terrain) state.modelPrior = await buildModelPrior(model, state.terrain);
        }
        if (Array.isArray(message.turns)) {
          for (const missed of message.turns) {
            if (Array.isArray(missed?.intents)) recordTurn(state, Number(missed.turnNumber ?? 0), missed.intents);
          }
        }
        console.log(
          `[GAME] Started: ${players.length} player(s), mode ${state.gameMode ?? "unknown"}, ` +
            `identity=${state.isPlayer ? "player" : "spectator"}`,
        );
        if (!state.isPlayer) {
          console.warn(
            "[GAME] This connection is not in gameStartInfo.players. A late fresh join becomes a spectator; " +
              "reconnect the identity that was admitted before the game started.",
          );
        }
        return;
      }
      if (message?.type === "turn") {
        const turn = turnPayload(message);
        if (!turn) return;
        recordTurn(state, turn.turnNumber, turn.intents);
        maybeSendSpawn(ws, protocol, state);
        await maybeDecideCombat(ws, protocol, state);
      }
    })().catch((error) => console.error(`[BOT] Message handler failed: ${String(error)}`));
  });

  ws.on("close", (code, reason) => {
    if (heartbeat !== null) clearInterval(heartbeat);
    const text = reason.toString();
    console.log(`[NET] Closed (${code}) ${text}`);
    if (!state.admitted) {
      console.error(
        "[AUTH] Socket opened but the player was never admitted. If the reason mentions Unauthorized/Turnstile, " +
          "this is authentication rather than Cloudflare dropping gameplay requests.",
      );
    }
  });
  ws.on("error", (error) => {
    console.error(`[NET] WebSocket error: ${String(error)}`);
  });
}

async function main(): Promise<void> {
  const gameID = process.argv[2];
  const explicitWorker = process.argv[3] === undefined ? null : Number(process.argv[3]);

  if (!gameID) {
    console.log("Create/join a lobby in OpenFront, then run: npm run bot -- <gameID>");
    console.log("For current production auth, see README.md; local Dev needs no Turnstile token.");
    return;
  }

  const workerIndex = Number.isInteger(explicitWorker) && explicitWorker! >= 0
    ? explicitWorker!
    : await findWorkerForGame(gameID);
  await connect(gameID, workerIndex);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
