import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const TARGET_PROS = [
    'Ultimus_Rex', '[UN] Ultimus_Rex', '[FTC] Flight', 'Biffeur on YT', 
    'Samraan', 'Picsou', 'Hi There', 'levi', '[UN] Sparkles', 
    'ryy', 'TrueAnon', '[CYN] super mario', '[UN] Gallemore', 
    '[CYN] Adz', 'Planetary Realignment'
]; 
const DOWNLOAD_DIR = path.join(__dirname, 'pro_replays');
const PAGES_TO_SCRAPE = 20;

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

async function scrapeWithPlaywright() {
    console.log('[Scraper] Launching headless browser...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    let downloadedCount = 0;
    let proCount = 0;

    try {
        for (let pageNum = 1; pageNum <= PAGES_TO_SCRAPE; pageNum++) {
            const pageUrl = `https://frontplus.io/games?completed=1&page=${pageNum}`;
            console.log(`\n[Scraper] Navigating to Page ${pageNum}...`);
            
            await page.goto(pageUrl, { waitUntil: 'networkidle' });
            await page.waitForSelector('div.games-table-row', { timeout: 10000 });

            const games = await page.evaluate(() => {
                const extracted = [];
                const rows = document.querySelectorAll('div.games-table-row'); 
                
                for (const row of rows) {
                    const linkElement = row.querySelector('.gt-id a');
                    const spans = row.querySelectorAll('span');
                    
                    if (linkElement && spans.length >= 5) {
                        const href = linkElement.getAttribute('href') || '';
                        const gameID = href.split('/').pop()?.split('?')[0]; 
                        const winnerText = spans[4].textContent || '';
                        
                        extracted.push({
                            id: gameID,
                            winner: winnerText.trim()
                        });
                    }
                }
                return extracted;
            });

            console.log(`[Scraper] Found ${games.length} games. Analyzing...`);

            for (const game of games) {
                if (!game.id || !game.winner || game.winner === '-') continue;

                const isPro = TARGET_PROS.some(pro => game.winner.includes(pro));
                const filePath = path.join(DOWNLOAD_DIR, `game_${game.id}.json`);

                if (fs.existsSync(filePath)) {
                    console.log(`  -> Already have ${game.id}, skipping...`);
                    continue;
                }

                // Log the bias, but download either way
                if (isPro) {
                    console.log(`  -> [PRO MATCH] Downloading ${game.id} (Winner: ${game.winner})`);
                    proCount++;
                } else {
                    console.log(`  -> [STANDARD MATCH] Downloading ${game.id} (Winner: ${game.winner})`);
                }
                
                try {
                    const archiveUrl = `https://api.openfront.io/game/${game.id}`;
                    const res = await fetch(archiveUrl);
                    
                    if (res.ok) {
                        const replayData = await res.json();
                        fs.writeFileSync(filePath, JSON.stringify(replayData));
                        console.log(`     Successfully grabbed ${game.id} from archive.`);
                        downloadedCount++;
                    } else {
                        console.warn(`     API returned ${res.status} for ${game.id}`);
                    }
                } catch (e) { 
                    console.error(`     Network error for ${game.id}:`, e);
                }
                
                // Keep the delay to avoid rate-limiting the server while bulk downloading
                await new Promise(r => setTimeout(r, 400)); 
            }
            
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`\n[Scraper] Done! Downloaded ${downloadedCount} total replays (${proCount} Pro matches).`);

    } catch (err) {
        console.error('[Scraper] Error:', err);
    } finally {
        await browser.close();
    }
}

scrapeWithPlaywright();