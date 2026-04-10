import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// IMPORT YOUR ENGINE HERE
import * as EngineStuff from './src/core/game/GameMap.ts';
console.log("AVAILABLE EXPORTS:", Object.keys(EngineStuff));
process.exit(0); // Stop the script immediately so we can read the output

console.log('[System] ReplayExtractor script starting...');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPLAY_DIR = path.join(__dirname, 'pro_replays');
const TENSOR_DIR = path.join(__dirname, 'extracted_tensors');
const M_W = 1000;
const M_H = 500;

if (!fs.existsSync(TENSOR_DIR)) {
    console.log(`[System] Creating output directory: ${TENSOR_DIR}`);
    fs.mkdirSync(TENSOR_DIR, { recursive: true });
}

export async function extractTrainingData(replayData: any, gameID: string, winnerID: string, outDir: string) {
    let moveCounter = 0;
    
    // Initialize your real game engine
    const game = new GameMap(); 
    
    const turns = replayData.turns || replayData.game?.turns || replayData.data?.turns;

    if (!turns || !Array.isArray(turns)) {
        console.warn(`[Extractor] No turns array found in ${gameID}, skipping.`);
        return;
    }

    const layerSize = M_W * M_H;

    for (const turn of turns) {
        if (!turn.intents) continue;

        const winnerIntents = turn.intents.filter((i: any) => 
            (i.clientID === winnerID || i.id === winnerID) && 
            (i.type === 'attack' || i.type === 'spawn')
        );
        
        if (winnerIntents.length > 0) {
            for (const intent of winnerIntents) {
                const tensor = new Float32Array(6 * layerSize);

                // Safe fallback: properties might be on game.board, game.state, or just game
                const board = (game as any).board || (game as any).state || game;

                let maxTroops = 1;
                if (board.troops) {
                    for (let i = 0; i < layerSize; i++) {
                        if (board.troops[i] > maxTroops) {
                            maxTroops = board.troops[i];
                        }
                    }
                }

                for (let i = 0; i < layerSize; i++) {
                    const owner = board.ownership ? board.ownership[i] : -1;
                    const troops = board.troops ? board.troops[i] : 0;
                    const terrainByte = board.terrain ? board.terrain[i] : 0;
                    const defense = board.defenseMultipliers ? board.defenseMultipliers[i] : 1.0;

                    const isMine = (owner === winnerID);
                    const isEnemy = (!isMine && owner !== null && owner !== 0 && owner !== -1); 
                    
                    tensor[0 * layerSize + i] = (terrainByte & 0x80) ? 1.0 : 0.0;
                    tensor[1 * layerSize + i] = isMine ? 1.0 : 0.0;
                    tensor[2 * layerSize + i] = isEnemy ? 1.0 : 0.0;
                    tensor[3 * layerSize + i] = isMine ? (troops / maxTroops) : 0.0;
                    tensor[4 * layerSize + i] = isEnemy ? (troops / maxTroops) : 0.0;
                    tensor[5 * layerSize + i] = defense;
                }

                const rawRatio = intent.troops || 1.0;
                let ratioBin = 3; 
                if (rawRatio <= 0.15) ratioBin = 0;
                else if (rawRatio <= 0.50) ratioBin = 1;
                else if (rawRatio <= 0.85) ratioBin = 2;

                const targetTile = intent.targetTile ?? intent.tile ?? 0; 
                const meta = Float32Array.from([targetTile, ratioBin]);
                
                const prefix = `${gameID}_${moveCounter}`;
                fs.writeFileSync(path.join(outDir, `state_${prefix}.bin`), Buffer.from(tensor.buffer));
                fs.writeFileSync(path.join(outDir, `label_${prefix}.bin`), Buffer.from(meta.buffer));
                
                moveCounter++;
            }
        }
        
        // Tick the engine forward so the board state updates for the next turn
        if (typeof (game as any).processTurn === 'function') {
            (game as any).processTurn(turn.intents);
        }
    }
    console.log(`[Extractor] Extracted ${moveCounter} moves for game ${gameID}.`);
}

async function runBatch() {
    console.log(`[Batch] Looking for replays in: ${REPLAY_DIR}`);
    
    if (!fs.existsSync(REPLAY_DIR)) return console.error(`[Error] Directory not found.`);

    const files = fs.readdirSync(REPLAY_DIR).filter(f => f.endsWith('.json'));
    console.log(`[Batch] Found ${files.length} JSON files.`);

    for (const file of files) {
        const replayPath = path.join(REPLAY_DIR, file);
        const replayData = JSON.parse(fs.readFileSync(replayPath, 'utf-8'));
        const gameID = file.replace('game_', '').replace('.json', '');
        
        let rawPlayers = replayData.players || replayData.info?.players || replayData.game?.players || replayData.data?.players;
        
        let playersArray: any[] = [];
        if (Array.isArray(rawPlayers)) {
            playersArray = rawPlayers;
        } else if (rawPlayers && typeof rawPlayers === 'object') {
            playersArray = Object.values(rawPlayers);
        }

        let winnerID = replayData.winnerID || replayData.info?.winnerID || replayData.info?.winner; 
        
        if (!winnerID && playersArray.length > 0) {
            let winnerPlayer = playersArray.find((p: any) => 
                p.placement === 1 || p.rank === 1 || p.isWinner === true || p.winner === true
            );

            if (!winnerPlayer) {
                winnerPlayer = [...playersArray].sort((a: any, b: any) => 
                    (b.score || b.troops || 0) - (a.score || a.troops || 0)
                )[0];
            }

            if (winnerPlayer) {
                winnerID = winnerPlayer.clientID || winnerPlayer.id; 
            }
        }
        
        if (winnerID) {
            console.log(`[Batch] Processing ${file} (Found Winner ID: ${winnerID})...`);
            try {
                await extractTrainingData(replayData, gameID, winnerID, TENSOR_DIR);
            } catch (err) {
                console.error(`[Error] Engine failure on ${file}:`, err);
            }
        } else {
            console.warn(`[Batch] Skipping ${file} - Could not determine winner.`);
        }
    }
    
    console.log('[Batch] Complete!');
}

runBatch().catch(console.error);