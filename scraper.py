import os
import time
import re
import requests

# We will dump the stolen data directly into your training folder
SAVE_DIR = "AIdatatraining/replays"
os.makedirs(SAVE_DIR, exist_ok=True)

print("--- INITIATING THE GREAT HEIST ---")

# We use a fake User-Agent so the server thinks we are a standard Chrome browser, not a bot.
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://openfront.io/"
}

# Step 1: Extract game codes from existing profile files
print("Extracting game codes from existing profile data...")

# Use the existing profile files in the replays directory
import os
replays_dir = "replays"
found_codes = set()

# Find all profile JSON files
profile_files = [f for f in os.listdir(replays_dir) if f.startswith('profile_') and f.endswith('.json')]

if not profile_files:
    print("No profile files found! Run the profile scraper first.")
    exit()

print(f"Found {len(profile_files)} profile files to process.")

for profile_file in profile_files:
    try:
        with open(os.path.join(replays_dir, profile_file), 'r', encoding='utf-8') as f:
            import json
            profile_data = json.load(f)

        if 'games' in profile_data and isinstance(profile_data['games'], list):
            for game in profile_data['games']:
                # Only take Free For All games
                if game.get('mode') == 'Free For All' and game.get('gameId'):
                    found_codes.add(game['gameId'])

    except Exception as e:
        print(f"Error processing {profile_file}: {e}")

found_codes = list(found_codes)

print(f"Target List Secured. Found {len(found_codes)} unique match codes.")
print("Connecting to OpenFront Mainframe...\n")

# Step 2: Extract the Payload from OpenFront
success_count = 0

for code in found_codes:
    # Security check: Ensure code is only alphanumeric to prevent path traversal
    if not re.match(r'^[a-zA-Z0-9]+$', code):
        print(f"[SECURITY WARNING] Invalid code detected and skipped: {code}")
        continue

    target_url = f"https://api.openfront.io/game/{code}"
    save_path = os.path.join(SAVE_DIR, f"game_{code}.json")

    # Don't waste time downloading games we already have
    if os.path.exists(save_path):
        print(f"[SKIPPED] {code} is already in the vault.")
        continue

    print(f"Downloading Replay: {code}...")
    
    try:
        replay_res = requests.get(target_url, headers=headers)
        
        if replay_res.status_code == 200:
            # Write the JSON payload to the hard drive
            with open(save_path, "w", encoding="utf-8") as f:
                f.write(replay_res.text)
            success_count += 1
        else:
            print(f"[ERROR] OpenFront rejected code {code}. Status: {replay_res.status_code}")
            
    except Exception as e:
        print(f"[CRITICAL] Network error on {code}: {e}")
        
    # --- THE MOST IMPORTANT LINE IN THIS SCRIPT ---
    # If you hammer their server with 100 requests a second, their firewall will 
    # permanently IP ban you. Waiting 1.5 seconds between downloads ensures we fly under the radar.
    time.sleep(1.5)

print(f"\n--- HEIST COMPLETE ---")
print(f"Successfully secured {success_count} new replays in '{SAVE_DIR}'.")