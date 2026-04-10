/**
 * OpenFront AI Bot — Direct WebSocket client with ONNX v2.
 *
 * Usage:
 *   npx tsx aibot.ts                  → creates a lobby, prints URL, waits for you
 *   npx tsx aibot.ts <gameID>         → joins YOUR lobby (you host, you pick map/rules)
 *   npx tsx aibot.ts <gameID> <worker> → joins with explicit worker index
 *
 * The bot uses a SINGLE WebSocket connection from lobby through game end.
 */

import WebSocket from 'ws';
import * as ort from 'onnxruntime-node';
import { randomUUID } from 'crypto';

// ─── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL   = 'ws://localhost:9000';
const HTTP_BASE    = 'http://localhost:9000';
const NUM_WORKERS  = 3;
const BOT_UUID     = randomUUID();
const BOT_USERNAME = 'OpenFrontBot';

const IS_LAND_BIT = 0x80;
const M_W = 1000;
const M_H = 500;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h = h & h; }
  return Math.abs(h);
}

function send(ws: WebSocket, obj: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function generateID(): string {
  const c = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ─── Server config ─────────────────────────────────────────────────────────────
async function fetchNumWorkers(): Promise<number> {
  try {
    const res = await fetch(`${HTTP_BASE}/api/server_config`);
    if (!res.ok) return NUM_WORKERS;
    const data = await res.json() as any;
    return data.numWorkers ?? NUM_WORKERS;
  } catch { return NUM_WORKERS; }
}

// ─── Find which worker owns a gameID ───────────────────────────────────────────
async function findWorkerForGame(gameID: string, numWorkers: number): Promise<number> {
  // Try our hash first
  const guess = simpleHash(gameID) % numWorkers;
  // Validate by checking the lobby endpoint
  for (const idx of [guess, ...Array.from({ length: numWorkers }, (_, i) => i).filter(i => i !== guess)]) {
    try {
      const res = await fetch(`${HTTP_BASE}/w${idx}/api/game_info/${gameID}`);
      if (res.ok) return idx;
    } catch {}
  }
  return guess; // fall back
}

// ─── Terrain loading ───────────────────────────────────────────────────────────
interface TerrainInfo {
  terrain: Uint8Array;
  width: number;
  height: number;
  landTiles: number[];
}

async function loadTerrain(mapName: string): Promise<TerrainInfo | null> {
  try {
    const key = mapName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const [mRes, bRes] = await Promise.all([
      fetch(`${HTTP_BASE}/maps/${key}/manifest.json`),
      fetch(`${HTTP_BASE}/maps/${key}/map.bin`),
    ]);
    if (!mRes.ok || !bRes.ok) {
      console.warn(`[BOT] Terrain 404 for "${key}" — trying without spaces...`);
      // Try alternate: remove all spaces entirely
      const key2 = mapName.toLowerCase().replace(/\s+/g, '');
      const [m2, b2] = await Promise.all([
        fetch(`${HTTP_BASE}/maps/${key2}/manifest.json`),
        fetch(`${HTTP_BASE}/maps/${key2}/map.bin`),
      ]);
      if (!m2.ok || !b2.ok) {
        console.warn('[BOT] Could not load terrain, using fallback spawn');
        return null;
      }
      const manifest = await m2.json() as any;
      const w = manifest.map.width, h = manifest.map.height;
      const terrain = new Uint8Array(await b2.arrayBuffer());
      const landTiles = collectLandTiles(terrain, w, h);
      console.log(`[BOT] Terrain: ${w}×${h}, ${landTiles.length} inland tiles`);
      return { terrain, width: w, height: h, landTiles };
    }
    const manifest = await mRes.json() as any;
    const w = manifest.map.width, h = manifest.map.height;
    const terrain = new Uint8Array(await bRes.arrayBuffer());
    const landTiles = collectLandTiles(terrain, w, h);
    console.log(`[BOT] Terrain: ${w}×${h}, ${landTiles.length} inland tiles`);
    return { terrain, width: w, height: h, landTiles };
  } catch (e) {
    console.warn('[BOT] Terrain load error:', e);
    return null;
  }
}

function collectLandTiles(terrain: Uint8Array, w: number, h: number): number[] {
  const margin = Math.max(10, Math.floor(Math.min(w, h) * 0.05));
  const tiles: number[] = [];
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      if (terrain[y * w + x] & IS_LAND_BIT) tiles.push(y * w + x);
    }
  }
  return tiles;
}

// ─── ONNX ──────────────────────────────────────────────────────────────────────
async function pickTileONNX(
  session: ort.InferenceSession,
  terrain: TerrainInfo,
  enemyTiles: Set<number>,  // tile refs known to be owned by enemies
  myTiles: Set<number>,     // tile refs known to be ours
): Promise<number> {
  const { width: W, height: H, landTiles } = terrain;
  const sx = W / M_W, sy = H / M_H;
  const input = new Float32Array(M_W * M_H);

  for (let my = 0; my < M_H; my++) {
    for (let mx = 0; mx < M_W; mx++) {
      const ref = Math.floor(my * sy) * W + Math.floor(mx * sx);
      if (!(terrain.terrain[ref] & IS_LAND_BIT)) continue; // water = 0

      if (myTiles.has(ref))          input[my * M_W + mx] =  1.0; // our territory
      else if (enemyTiles.has(ref))  input[my * M_W + mx] = -1.0; // enemy
      else                           input[my * M_W + mx] =  0.2; // neutral land
    }
  }

  const result = await session.run({
    map_state: new ort.Tensor('float32', input, [1, 1, M_H, M_W]),
  });
  const heatmap = result.click_heatmap.data as Float32Array;

  // Find the best-scoring inland land tile that we don't already own
  let best = -Infinity, bestTile = landTiles[Math.floor(landTiles.length / 2)];
  for (const ref of landTiles) {
    if (myTiles.has(ref)) continue; // don't spawn on ourselves
    const mx = Math.floor((ref % W) / sx);
    const my = Math.floor(Math.floor(ref / W) / sy);
    if (mx >= 0 && mx < M_W && my >= 0 && my < M_H) {
      const s = heatmap[my * M_W + mx];
      if (s > best) { best = s; bestTile = ref; }
    }
  }
  return bestTile;
}

// ─── Create lobby (only used when no gameID argument given) ────────────────────
async function createLobby(numWorkers: number): Promise<{ gameID: string; widx: number }> {
  const gameID = generateID();
  for (let i = 0; i < numWorkers; i++) {
    const res = await fetch(`${HTTP_BASE}/w${i}/api/create_game/${gameID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BOT_UUID}` },
    });
    if (res.ok) {
      console.log(`\n╔════════════════════════════════════════════════════════════╗`);
      console.log(`║  Lobby created — open in browser:                          ║`);
      console.log(`║  http://localhost:9000/w${i}/game/${gameID}?lobby           ║`);
      console.log(`║  Or pass a gameID to join YOUR lobby with custom settings: ║`);
      console.log(`║  npx tsx aibot.ts <your-game-id>                           ║`);
      console.log(`╚════════════════════════════════════════════════════════════╝\n`);
      return { gameID, widx: i };
    }
  }
  throw new Error('Could not create lobby on any worker');
}

// ─── Single-connection game session ────────────────────────────────────────────
async function playGame(
  gameID: string,
  widx: number,
  session: ort.InferenceSession,
  isCreator: boolean,
): Promise<void> {
  const wsUrl = `${SERVER_URL}/w${widx}`;
  console.log(`[BOT] Connecting to ${wsUrl} for game ${gameID}`);

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);

    let clientID     = '';
    let isSpawned    = false;
    let turnCount    = 0;
    let terrain: TerrainInfo | null = null;
    let spawnTile    = -1;
    let onnxReady    = false;
    let gameStarted  = false;
    let spawnAttempt = 0;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    // Track known territory from intent acknowledgements
    const enemyTiles = new Set<number>();
    const myTiles    = new Set<number>();
    const knownEnemies = new Set<string>();

    // Expand a tile into a rough region (spawn gives ~20 tile radius)
    function markRegion(set: Set<number>, tile: number, radius: number) {
      if (!terrain) return;
      const cx = tile % terrain.width, cy = Math.floor(tile / terrain.width);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > radius) continue;
          const ref = (cy + dy) * terrain.width + (cx + dx);
          if (ref >= 0 && ref < terrain.terrain.length) set.add(ref);
        }
      }
    }

    const cleanup = () => { if (pingTimer) clearInterval(pingTimer); };

    // ── open ────────────────────────────────────────────────────────────────
    ws.on('open', () => {
      console.log('[BOT] Connected — sending join');
      send(ws, {
        type: 'join', gameID, token: BOT_UUID,
        username: BOT_USERNAME, clanTag: null, turnstileToken: null,
      });
      pingTimer = setInterval(() => send(ws, { type: 'ping' }), 5000);
    });

    // ── message (single handler for entire lifecycle) ────────────────────────
    ws.on('message', async (data: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.myClientID && !clientID) {
        clientID = msg.myClientID;
        console.log(`[BOT] clientID = ${clientID}`);
      }

      switch (msg.type) {

        // ── LOBBY PHASE ──────────────────────────────────────────────────
        case 'lobby_info': {
          const clients: any[] = msg.lobby?.clients ?? [];
          if (!gameStarted) {
            process.stdout.write(`\r[BOT] Lobby: ${clients.length} player(s)    `);
            // If we are the lobby creator AND there are 2+ players, start
            if (isCreator && clients.length >= 2) {
              console.log('\n[BOT] Player joined — starting game!');
              await fetch(`${HTTP_BASE}/w${widx}/api/start_game/${gameID}`, { method: 'POST' });
            }
          }
          break;
        }

        // ── PRESTART ─────────────────────────────────────────────────────
        case 'prestart': {
          const mapName: string = msg.gameMap ?? '';
          console.log(`\n[BOT] Prestart — map: "${mapName}"`);
          const t = await loadTerrain(mapName);
          if (t) {
            terrain = t;
            try {
              spawnTile = await pickTileONNX(session, terrain, enemyTiles, myTiles);
              onnxReady = true;
              const x = spawnTile % terrain.width;
              const y = Math.floor(spawnTile / terrain.width);
              console.log(`[AI] ONNX spawn → tile ${spawnTile} (${x}, ${y})`);
            } catch (e) {
              console.error('[AI] ONNX error:', e);
              spawnTile = terrain.landTiles[Math.floor(terrain.landTiles.length / 2)];
            }
          }
          break;
        }

        // ── START ────────────────────────────────────────────────────────
        case 'start': {
          gameStarted = true;
          isSpawned   = false;
          spawnAttempt = 0;
          const players = msg.gameStartInfo?.players ?? [];
          console.log(`[BOT] Game STARTED — ${players.length} players: ${players.map((p: any) => p.username).join(', ')}`);

          // Immediately send spawn
          if (spawnTile < 0 && terrain) {
            spawnTile = terrain.landTiles[Math.floor(terrain.landTiles.length / 2)];
          }
          if (spawnTile >= 0) {
            send(ws, { type: 'intent', intent: { type: 'spawn', tile: spawnTile } });
            console.log(`[AI] Spawn sent → tile ${spawnTile}`);
          }
          break;
        }

        // ── TURN ─────────────────────────────────────────────────────────
        case 'turn': {
          turnCount = msg.turn?.turnNumber ?? turnCount + 1;

          // Track ALL spawn intents from this turn
          if (Array.isArray(msg.turn?.intents)) {
            for (const intent of msg.turn.intents) {
              if (intent.type === 'spawn' && intent.tile != null) {
                if (intent.clientID === clientID) {
                  if (!isSpawned) {
                    isSpawned = true;
                    console.log(`[BOT] ✓ SPAWNED on turn ${turnCount}`);
                  }
                  markRegion(myTiles, intent.tile, 15);
                } else {
                  // Enemy spawned — mark their region
                  markRegion(enemyTiles, intent.tile, 15);
                  if (intent.clientID) knownEnemies.add(intent.clientID);
                  console.log(`[BOT] Enemy spawned at tile ${intent.tile}`);
                }
              }
            }
          }

          if (!clientID) break;

          // ── Spawn phase ──────────────────────────────────────────────
          if (!isSpawned) {
            // Re-run ONNX every 30 turns with updated enemy positions
            if (turnCount % 30 === 0 && terrain && enemyTiles.size > 0) {
              try {
                spawnTile = await pickTileONNX(session, terrain, enemyTiles, myTiles);
                console.log(`[AI] Re-evaluated spawn → tile ${spawnTile} (enemies: ${enemyTiles.size} tiles)`);
              } catch {}
            }
            // Rotate randomly every 20 turns as fallback
            if (turnCount % 20 === 0 && terrain && spawnTile < 0) {
              spawnAttempt++;
              spawnTile = terrain.landTiles[Math.floor(Math.random() * terrain.landTiles.length)];
              console.log(`[AI] Random spawn tile ${spawnTile} (attempt ${spawnAttempt})`);
            }
            if (spawnTile >= 0) {
              send(ws, { type: 'intent', intent: { type: 'spawn', tile: spawnTile } });
            }
            break;
          }

          // ── Combat phase ─────────────────────────────────────────────
          if (turnCount % 3 === 0) {
            const enemyArr = Array.from(knownEnemies);
            const target = (Math.random() > 0.5 && enemyArr.length > 0) 
                           ? enemyArr[Math.floor(Math.random() * enemyArr.length)] 
                           : null;
            send(ws, { type: 'intent', intent: { type: 'attack', targetID: target, troops: 0.3 } });
            if (turnCount % 30 === 0) console.log(`[AI] Attacking (target: ${target ?? 'TerraNullius'}, turn ${turnCount})`);
          }
          break;
        }

        case 'error':
          console.error(`[BOT] Server: ${msg.error}`);
          break;
      }
    });

    // ── close / error ───────────────────────────────────────────────────────
    ws.on('close', (code, reason) => {
      cleanup();
      console.log(`[BOT] Disconnected (${code}) ${reason.toString() || ''}`);
      resolve();
    });

    ws.on('error', (e) => {
      console.error('[BOT] WS error:', e.message);
      ws.close();
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== OpenFront AI Bot (WebSocket + ONNX v2) ===');
  console.log(`ID: ${BOT_UUID}\n`);

  const session = await ort.InferenceSession.create('./models/openfront_v2.onnx');
  console.log(`[BOT] ONNX loaded — inputs: ${session.inputNames}, outputs: ${session.outputNames}`);

  const numWorkers = await fetchNumWorkers();
  console.log(`[BOT] ${numWorkers} worker(s)\n`);

  process.on('SIGINT', () => { console.log('\n[BOT] Bye.'); process.exit(0); });

  // Parse CLI: npx tsx aibot.ts [gameID] [workerIdx]
  const cliGameID  = process.argv[2] || '';
  const cliWorker  = process.argv[3] ? parseInt(process.argv[3]) : -1;

  while (true) {
    try {
      let gameID: string;
      let widx: number;
      let isCreator: boolean;

      if (cliGameID) {
        // USER-HOSTED: join their lobby
        gameID    = cliGameID;
        widx      = cliWorker >= 0 ? cliWorker : await findWorkerForGame(gameID, numWorkers);
        isCreator = false;
        console.log(`[BOT] Joining user lobby ${gameID} on w${widx}`);
      } else {
        // BOT-HOSTED: create lobby and wait
        const lobby = await createLobby(numWorkers);
        gameID    = lobby.gameID;
        widx      = lobby.widx;
        isCreator = true;
      }

      await playGame(gameID, widx, session, isCreator);
      console.log('[BOT] Game ended — restarting in 2s...\n');
      await new Promise(r => setTimeout(r, 2000));

      // If user gave a specific gameID, don't loop (that game is done)
      if (cliGameID) break;

    } catch (e) {
      console.error('[BOT] Error:', e);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

main();
