import fs from 'fs';
import path from 'path';

const REPLAY_DIR = path.join(__dirname, 'replays');

async function scrapeGameReplays() {
    console.log("Phase 3: Initiating Core Replay Extraction...");

    // 1. Find all the profile JSONs we downloaded in Phase 2
    const files = fs.readdirSync(REPLAY_DIR);
    const profileFiles = files.filter(f => f.startsWith('profile_') && f.endsWith('.json'));

    if (profileFiles.length === 0) {
        console.error("No player profiles found! Run Phase 2 first.");
        return;
    }

    // 2. Extract every unique gameId from those profiles
    const uniqueGameIds = new Set<string>();

    for (const file of profileFiles) {
        const rawData = fs.readFileSync(path.join(REPLAY_DIR, file), 'utf-8');
        try {
            const profile = JSON.parse(rawData);
            if (profile.games && Array.isArray(profile.games)) {
                for (const game of profile.games) {
                    // Only take Free For All games for our specific training regimen
                    if (game.mode === "Free For All" && game.gameId) {
                        uniqueGameIds.add(game.gameId);
                    }
                }
            }
        } catch (e) {
            console.error(`Error parsing ${file}:`, e);
        }
    }

    const gameIdsArray = Array.from(uniqueGameIds);
    console.log(`Found ${gameIdsArray.length} unique FFA games to download.`);

    // 3. Download the actual game data
    let downloadedCount = 0;

    for (const gameId of gameIdsArray) {
        // Security check: Ensure gameId is only alphanumeric to prevent path traversal
        if (!/^[a-zA-Z0-9]+$/.test(gameId)) {
            console.warn(`[Security Warning] Invalid gameId detected and skipped: ${gameId}`);
            continue;
        }

        const savePath = path.join(REPLAY_DIR, `game_${gameId}.json`);
        
        // Skip if we already downloaded it (good for resuming if the script crashes)
        if (fs.existsSync(savePath)) {
            console.log(`[Skipping] game_${gameId}.json already exists.`);
            continue;
        }

        const gameUrl = `https://api.openfront.io/game/${gameId}`;
        
        try {
            console.log(`[Fetching Replay ${downloadedCount + 1}/${gameIdsArray.length}] ID: ${gameId}`);
            
            const response = await fetch(gameUrl);
            if (!response.ok) {
                console.log(`   -> Failed to fetch ${gameId} (Might be expired or deleted).`);
                continue;
            }

            const gameData = await response.json();
            
            // 4. Save the raw replay to the vault
            fs.writeFileSync(savePath, JSON.stringify(gameData, null, 2));
            downloadedCount++;

            // Anti-Ban measure: OpenFront limits are usually around 1-2 requests per second.
            // Let's play it safe with an 800ms delay.
            await new Promise(resolve => setTimeout(resolve, 800));

        } catch (error) {
            console.error(`   -> Error hitting API for game ${gameId}:`, error);
        }
    }

    console.log(`Phase 3 Complete. Successfully downloaded ${downloadedCount} raw game replays.`);
    console.log("You now possess the complete training dataset. It is time to forge the brain.");
}

scrapeGameReplays();