import * as ort from 'onnxruntime-node';

// Map Constants based on OpenFront.io dimensions
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 1500;

/**
 * THE OPTIC NERVE (V2)
 * Normalizes the raw 0-255 byte array into AI-friendly floats.
 * 1.0 = Your Empire | -1.0 = Enemy | 0.2 = Neutral Land | 0.0 = Ocean
 */
function encodeGameState(rawTiles: Uint8Array, myPlayerId: number): Float32Array {
    const encodedState = new Float32Array(rawTiles.length);

    for (let i = 0; i < rawTiles.length; i++) {
        const tile = rawTiles[i];

        if (tile === 0) {
            encodedState[i] = 0.0;   // Void
        } else if (tile === 255) {
            encodedState[i] = 0.2;   // Neutral Expansion Target
        } else if (tile === myPlayerId) {
            encodedState[i] = 1.0;   // Self (Brightest)
        } else {
            encodedState[i] = -1.0;  // Hostile (Darkest)
        }
    }

    return encodedState;
}

async function runAIBot() {
    console.log("--- INITIALIZING DEEPFRONT V2 ---");
    
    // 1. Load the upgraded V2 Brain
    const session = await ort.InferenceSession.create('./models/openfront_v2.onnx');
    console.log("V2 Brain Loaded. Tactical Geometry active.");

    // 2. Simulated Live Game State 
    // In the future, this 'liveServerTiles' will come from your WebSocket connection
    const liveServerTiles = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
    const MY_ID = 5; 
    
    // SETUP TEST SCENARIO:
    liveServerTiles.fill(0); // Clear board
    // Create a block of land
    for(let i = 1000000; i < 1500000; i++) liveServerTiles[i] = 255; 
    // Give us a small base
    for(let i = 1100000; i < 1110000; i++) liveServerTiles[i] = MY_ID;

    // 3. Process Sensory Data
    const aiVisionArray = encodeGameState(liveServerTiles, MY_ID);
    
    // 4. Construct Tensor for ONNX (Batch:1, Channel:1, H:1500, W:2000)
    const inputTensor = new ort.Tensor('float32', aiVisionArray, [1, 1, MAP_HEIGHT, MAP_WIDTH]);

    // 5. Execute Inference
    const feeds = { map_state: inputTensor };
    const results = await session.run(feeds);
    
    // 6. Extract the Tactical Heatmap
    const heatmap = results.click_heatmap.data as Float32Array;

    // 7. Argmax: Find the peak of the probability distribution
    let maxVal = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < heatmap.length; i++) {
        if (heatmap[i] > maxVal) {
            maxVal = heatmap[i];
            bestIndex = i;
        }
    }

    // 8. Translate 1D Index back to 2D Map Coordinates
    const targetX = bestIndex % MAP_WIDTH;
    const targetY = Math.floor(bestIndex / MAP_WIDTH);

    console.log(`\n--- V2 DECISION COMPLETE ---`);
    console.log(`Confidence Score (Logits): ${maxVal.toFixed(4)}`);
    console.log(`Target: (X: ${targetX}, Y: ${targetY})`);
    console.log(`[NETWORK] Ready to send intent for tile ${bestIndex}`);
}

runAIBot().catch(console.error);