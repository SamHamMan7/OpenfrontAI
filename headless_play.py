import torch
import torch.nn as nn
import numpy as np
import asyncio
import websockets
import json
import sys

# --- SETTINGS ---
BOT_NAME = "AI_Omni_Bot"
AUTH_COOKIE = "PASTE_YOUR_COOKIE_HERE" # Update this from DevTools

# 1. THE BRAIN
class OpenFrontBot(nn.Module):
    def __init__(self):
        super(OpenFrontBot, self).__init__()
        self.encoder = nn.Sequential(
            nn.Conv2d(6, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(64, 128, 3, padding=1), nn.ReLU(),
        )
        self.spatial_head = nn.Sequential(
            nn.ConvTranspose2d(128, 64, 4, stride=2, padding=1), nn.ReLU(),
            nn.ConvTranspose2d(64, 32, 4, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(32, 1, 1) 
        )
        self.ratio_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
            nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1)
        )

    def forward(self, x):
        feat = self.encoder(x)
        spatial = self.spatial_head(feat).view(x.size(0), -1) 
        ratio = self.ratio_head(feat)
        return spatial, ratio

# 2. THE ENGINE
class GameEngine:
    def __init__(self):
        self.tile_modulo = 131072
        self.width = 512
        self.mental_map = np.zeros((6, 256, 512), dtype=np.uint8)
        self.client_id = None

    def setup(self, size_type):
        if size_type == "Normal": self.tile_modulo, self.width = 131072, 512
        elif size_type == "Small": self.tile_modulo, self.width = 65536, 256
        print(f"🗺️ Map Configured: {size_type}")

# 3. DISCOVERY LOGIC
async def discover_match(target_id=None):
    """If target_id is None, it grabs the first public game. Otherwise, it hunts for that ID."""
    print("📡 Connecting to Lobby...")
    async with websockets.connect("wss://openfront.io/lobbies") as ws:
        async for message in ws:
            data = json.loads(message)
            if "games" in data:
                for mode in data["games"]:
                    for game in data["games"][mode]:
                        # MULTIPLAYER AUTO-JOIN
                        if target_id is None and game.get('playerCount', 0) < game.get('maxPlayers', 8):
                            print(f"🚀 Public Game Found! Joining {game['gameID']} on {game['worker']}")
                            return game['worker'], game['gameID']
                        # SOLO/MANUAL JOIN
                        elif target_id and game['gameID'] == target_id:
                            print(f"🎯 Target Solo Match Found! Joining {target_id}")
                            return game['worker'], game['gameID']
            await asyncio.sleep(0.5)

# 4. PLAY LOOP
async def play(worker, game_id):
    bot = OpenFrontBot()
    bot.load_state_dict(torch.load("openfront_pro_v1.pth", map_location='cpu', weights_only=True))
    bot.eval()
    engine = GameEngine()

    uri = f"wss://openfront.io/{worker}"
    headers = {"Origin": "https://openfront.io", "Cookie": AUTH_COOKIE}

    async with websockets.connect(uri, additional_headers=headers) as ws:
        await ws.send(json.dumps({"type": "join", "gameID": game_id, "username": BOT_NAME}))
        
        async for message in ws:
            data = json.loads(message)
            if data.get("type") == "prestart": engine.setup(data.get("gameMapSize", "Normal"))
            if "clientId" in data: engine.client_id = data["clientId"]
            if data.get("type") == "turn":
                # Decision Math
                state = torch.from_numpy(engine.mental_map).float().unsqueeze(0) / 255.0
                with torch.no_grad():
                    spatial, ratio = bot(state)
                    target = torch.argmax(spatial).item() % engine.tile_modulo
                
                await ws.send(json.dumps({
                    "type": "intent",
                    "intent": {"type": "attack", "target": target, "amount": int(ratio.item() * 10000)}
                }))

if __name__ == "__main__":
    # Case 1: Manual ID (Solo) -> python headless_play.py abc123def
    if len(sys.argv) > 1:
        target = sys.argv[1]
        w, g = asyncio.run(discover_match(target))
        asyncio.run(play(w, g))
    # Case 2: Auto (Multiplayer) -> python headless_play.py
    else:
        w, g = asyncio.run(discover_match())
        asyncio.run(play(w, g))