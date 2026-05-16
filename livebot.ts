import WebSocket from 'ws';
import * as ort from 'onnxruntime-node';
import { randomUUID } from 'crypto';

const WIDTH = 2000;
const HEIGHT = 1500;
const M_WIDTH = 2000;
const M_HEIGHT = 1500;

async function start() {
    const session = await ort.InferenceSession.create('./models/openfront_v2.onnx');
    
    // We will cycle through the 3 common worker pipes
    const workers = ['w0', 'w1', 'w2'];
    let workerIdx = 0;

    console.log("--- BOT ACTIVE: SNIPING PUBLIC LOBBIES ---");

    while (true) {
        const worker = workers[workerIdx];
        workerIdx = (workerIdx + 1) % workers.length;

        try {
            await tryJoin(worker, session);
        } catch (e) {
            // Wait 1 second before trying the next worker
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

async function tryJoin(worker: string, session: any) {
    const token = randomUUID();
    let gameID = await new Promise<string>((resolve, reject) => {
        const lobbyWs = new WebSocket(`ws://localhost:9000/${worker}/lobbies`);
        lobbyWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                const games = msg.games;
                let foundId = null;
                if (games?.ffa && games.ffa.length > 0) foundId = games.ffa[0].gameID;
                else if (games?.team && games.team.length > 0) foundId = games.team[0].gameID;
                
                if (foundId) {
                    lobbyWs.close();
                    resolve(foundId);
                }
            } catch (e) {}
        });
        lobbyWs.on('error', () => reject());
        setTimeout(() => { lobbyWs.close(); reject(); }, 2000);
    }).catch(() => null);

    if (!gameID) {
        console.log(`[BOT] No active public games found on ${worker}.`);
        return;
    }

    const socket = new WebSocket(`ws://localhost:9000/${worker}?token=${token}`);
    
    let myId = -1, myCID = "", map: Uint8Array | null = null;
    let joined = false;

    const ping = setInterval(() => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: "ping" }));
    }, 5000);

    return new Promise((resolve, reject) => {
        socket.on('open', () => {
            console.log(`[BOT] Connected to ${worker}, joining game ${gameID}...`);
            socket.send(JSON.stringify({ 
                type: "join", 
                gameID: gameID, 
                username: "DeepFront_AI", 
                token: token,
                clanTag: null,
                turnstileToken: null 
            }));
        });

        socket.on('error', (err) => {
            console.error(`[ERROR] Socket error on ${worker}:`, err.message);
        });

        socket.on('message', async (data: any, isBinary: boolean) => {
            if (isBinary) {
                if (!map) console.log(`[BOT] Received first binary map data!`);
                map = new Uint8Array(data);
            } else {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type !== 'turn' && msg.type !== 'TICK' && msg.type !== 'ping') {
                        console.log(`[MSG] ${msg.type}`);
                    }
                    if (msg.type === 'error') {
                         console.error("[SERVER ERROR]", msg.error, msg.message);
                    }
                    
                    if (msg.type === 'JOIN_SUCCESS' || msg.type === 'rejoin' || msg.data?.yourPlayerId || msg.type === 'start') {
                        if (!joined) {
                            console.log(`[FOUND] Successfully entered game on ${worker}!`);
                            joined = true;
                        }
                        if (msg.type === 'start' && msg.myClientID) myCID = msg.myClientID;
                        if (msg.data?.yourPlayerId) myId = msg.data.yourPlayerId;
                        if (msg.data?.clientID) myCID = msg.data.clientID;
                    }

                    // For 'lobby_info' we can extract the myClientID too
                    if (msg.type === 'lobby_info') {
                        if (!joined) {
                            console.log(`[FOUND] Successfully entered game lobby on ${worker}!`);
                            joined = true; // They accepted our join request!
                        }
                        if (msg.myClientID) myCID = msg.myClientID;
                        // look up our client info to get player id if available
                        const me = msg.lobby?.clients?.find((c: any) => c.clientID === myCID);
                        if (me && me.playerID) myId = me.playerID;
                    }

                    if (myId !== -1 && map && (msg.type === 'turn' || msg.type === 'TICK' || msg.type === 'hash')) {
                        await runAI(socket, session, map, myId, myCID);
                    }
                } catch (e) {}
            }
        });

        socket.on('close', (code, reason) => {
            clearInterval(ping);
            if (!joined) console.log(`[CLOSE] Disconnected from ${worker} (code: ${code}, reason: ${reason})`);
            if (joined) console.log(`[OFFLINE] Game ended. Sniping next...`);
            resolve(true);
        });

        const timer = setTimeout(() => { 
            if (!joined) { 
                console.log(`[TIMEOUT] No join response from ${worker} in 2s.`);
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    try { socket.close(); } catch(e) {} 
                }
                reject(); 
            } 
        }, 2000);
    });
}

async function runAI(ws: WebSocket, session: any, map: Uint8Array, id: number, cid: string) {
    try {
        const isSpawned = map.includes(id);
        const input = new Float32Array(M_WIDTH * M_HEIGHT);
        const sx = WIDTH / M_WIDTH, sy = HEIGHT / M_HEIGHT;

        for (let y = 0; y < M_HEIGHT; y++) {
            for (let x = 0; x < M_WIDTH; x++) {
                const tIdx = Math.floor(y * sy) * WIDTH + Math.floor(x * sx);
                const tile = map[tIdx] || 0;
                let val = -1.0;
                if (tile === 0) val = 0.0;
                else if (tile === 255) val = 0.2;
                else if (tile === id) val = 1.0;
                input[y * M_WIDTH + x] = val;
            }
        }

        const res = await session.run({ map_state: new ort.Tensor('float32', input, [1, 1, M_HEIGHT, M_WIDTH]) });
        const heatmap = res.click_heatmap.data;
        let max = -100, best = -1;
        for (let i = 0; i < heatmap.length; i++) { if (heatmap[i] > max) { max = heatmap[i]; best = i; } }

        const tx = Math.floor((best % M_WIDTH) * sx);
        const ty = Math.floor(Math.floor(best / M_WIDTH) * sy);
        
        let target = ty * WIDTH + tx;
        if (!isSpawned && max < -0.5) {
            // Find a random neutral land tile (255)
            const neutralLandTiles: number[] = [];
            for (let i = 0; i < map.length; i++) {
                if (map[i] === 255) neutralLandTiles.push(i);
            }
            if (neutralLandTiles.length > 0) {
                target = neutralLandTiles[Math.floor(Math.random() * neutralLandTiles.length)];
            } else {
                target = 1359002;
            }
        }

        ws.send(JSON.stringify({ 
            type: "intent", 
            intent: { type: isSpawned ? "attack" : "spawn", tile: target, clientID: cid } 
        }));
        
        if (!isSpawned) console.log(`[AI] Attempting spawn at ${target}...`);
    } catch (e) {
        console.error(`[AI] Error during inference or turn:`, e);
    }
}

start();
