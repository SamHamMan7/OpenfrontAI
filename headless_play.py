import torch
import torch.nn as nn
import numpy as np
import asyncio
import websockets
import json

# 1. THE BRAIN (Exact architecture from your Colab training)
class OpenFrontBot(nn.Module):
    def __init__(self):
        super(OpenFrontBot, self).__init__()
        self.encoder = nn.Sequential(
            nn.Conv2d(6, 32, 3, padding=1), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(64, 128, 3, padding=1), nn.ReLU(),
        )
        self.spatial_head = nn.Sequential(
            nn.ConvTranspose2d(128, 64, 4, stride=2, padding=1), nn.ReLU(),
            nn.ConvTranspose2d(64, 32, 4, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(32, 1, 1) 
        )
        self.ratio_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(128, 64), nn.ReLU(),
            nn.Linear(64, 1)
        )

    def forward(self, x):
        feat = self.encoder(x)
        spatial = self.spatial_head(feat).view(x.size(0), -1) 
        ratio = self.ratio_head(feat)
        return spatial, ratio

# 2. THE BOT'S INTERNAL MENTAL MAP
# Layers: 0: Terrain, 1: My Land, 2: Enemy Land, 3-5: Troops/Details
mental_map = np.zeros((6, 256, 512), dtype=np.uint8)
my_client_id = None

def process_intent(intent):
    """Updates the internal map based on server intents"""
    # APPLY THE COORDINATE FIX FROM TRAINING
    raw_tile = intent.get("tile")
    if raw_tile is None: return
    
    fixed_tile = raw_tile % 131072 #
    y = fixed_tile // 512
    x = fixed_tile % 512

    if intent["type"] == "spawn":
        client_id = intent["clientId"]
        if client_id == my_client_id:
            mental_map[1, y, x] = 255 # My Land
        else:
            mental_map[2, y, x] = 255 # Enemy Land

async def run_bot():
    global my_client_id
    
    # Load the Brain
    bot = OpenFrontBot()
    bot.load_state_dict(torch.load("openfront_pro_v1.pth", map_location='cpu'))
    bot.eval()
    print("✅ Brain loaded and ready.")

    # URL from your network logs
    uri = "wss://openfront.io/w17" 
    
    async with websockets.connect(uri) as ws:
        print("✅ Headless Connection established!")

        async for message in ws:
            data = json.loads(message)

            # Look for your own ClientID in initial packets
            if "clientId" in data and my_client_id is None:
                my_client_id = data["clientId"]
                print(f"📡 My Client ID is: {my_client_id}")

            # Process Turn Packets
            if data.get("type") == "turn":
                for intent in data.get("intents", []):
                    process_intent(intent)
                
                # After updating the map, the AI decides its move
                state_tensor = torch.from_numpy(mental_map).float().unsqueeze(0) / 255.0
                
                with torch.no_grad():
                    spatial, ratio = bot(state_tensor)
                    
                    # Convert AI output to Target Tile
                    target_idx = torch.argmax(spatial).item()
                    # Scale troop count back up (Normalized / 10000 in training)
                    send_amount = int(ratio.item() * 10000.0)

                # Send Attack Intent back to server
                attack_packet = {
                    "type": "intent",
                    "intent": {
                        "type": "attack",
                        "target": target_idx,
                        "amount": send_amount
                    }
                }
                await ws.send(json.dumps(attack_packet))
                print(f"🎯 AI Attacking Tile: {target_idx} with {send_amount} troops")

if __name__ == "__main__":
    try:
        asyncio.run(run_bot())
    except KeyboardInterrupt:
        print("Bot stopped.")