# OpenFrontAI

A strategy bot for [OpenFront](https://github.com/openfrontio/OpenFrontIO) focused on **correct game semantics first**, then learning.

The original prototype had a neural-looking runtime, but the actual combat loop was almost random: it attacked every few turns, picked random targets, and sent `troops: 0.3`. OpenFront interprets `troops` as an **absolute troop count**, so those attacks were effectively fractions of one troop. The replay extractor also trained attacks as tile targets even though OpenFront attacks target player IDs.

This branch fixes those foundations.

## What v3 does

- **Protocol-correct attacks**: `targetID` + absolute troop counts, or `troops: null` to let OpenFront choose its configured default.
- **Strategic combat policy**: keeps a reserve, expands neutral land early, retaliates against recent attackers, avoids stronger fights, prefers favorable nearby targets, and never attacks live-stat teammates.
- **Better spawning**: waits briefly to observe other spawns, scores open/inland land, avoids crowded starts, and uses the ONNX heatmap as one bounded input instead of blindly trusting it.
- **Optional ground-truth live stats**: on a local server with the admin-bot API enabled, decisions use current troops, tiles, team, and alive status.
- **Current + legacy wire support**: legacy JSON still works; current OpenFront `zbin` is loaded from the exact local OpenFront checkout so the bot cannot silently drift from the server schema.
- **Correct replay labels**: the extractor records real `spawn(tile)` and `attack(targetID, troops)` actions without fabricating board state.
- **Tests and CI**: spawn and strategy behavior are unit-tested and TypeScript is checked in CI.

## Quick start

Install dependencies:

```bash
npm ci
```

Start OpenFront locally, create a private lobby, copy its game ID, then run:

```bash
npm run bot -- YOUR_GAME_ID
```

You can optionally pass the worker index:

```bash
npm run bot -- YOUR_GAME_ID 1
```

### Current OpenFront `main` / zbin protocol

Current OpenFront intentionally has no wire-version negotiation: the client and server must use the same schema. Point this bot at the **same checkout that is running your local server**:

```bash
OPENFRONT_SOURCE=../OpenFrontIO npm run bot -- YOUR_GAME_ID
```

On Windows PowerShell:

```powershell
$env:OPENFRONT_SOURCE = "C:\\path\\to\\OpenFrontIO"
npm run bot -- YOUR_GAME_ID
```

The adapter imports that checkout's `src/core/ZbinWire.ts`, so when OpenFront changes its positional binary schema the bot follows the exact local version instead of keeping a stale vendored copy.

If you are intentionally using the older JSON server, force it with:

```bash
OPENFRONT_PROTOCOL=json npm run bot -- YOUR_GAME_ID
```

## Better decisions with live stats

Current OpenFront can expose consensus live stats to a trusted local admin bot. If your local server has `ADMIN_BOT_API_KEY` configured, pass the same value to this process:

```bash
OPENFRONT_ADMIN_BOT_KEY=your-local-key npm run bot -- YOUR_GAME_ID
```

That gives the strategy real troop counts, territory size, team, and alive status. Without it, the bot falls back safely: it expands neutral land, retaliates against observed attackers, and in FFA can pressure known hostiles using OpenFront's own default attack amount. It does **not** guess team relationships.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENFRONT_HTTP_BASE` | `http://localhost:9000` | Local OpenFront HTTP base |
| `OPENFRONT_WS_BASE` | derived from HTTP base | WebSocket base |
| `OPENFRONT_SOURCE` | auto-detected nearby | Exact OpenFront checkout for zbin |
| `OPENFRONT_PROTOCOL` | `auto` | `auto`, `json`, or `zbin` |
| `OPENFRONT_PLAY_TOKEN` | generated dev ID | Join token / local dev persistent ID |
| `OPENFRONT_ADMIN_BOT_KEY` | unset | Enables live-stat reads |
| `OPENFRONT_MODEL` | `./models/openfront_v2.onnx` | Spawn-prior ONNX model |
| `OPENFRONT_SPAWN_WAIT_TURNS` | `18` | Observation time before first spawn |
| `OPENFRONT_COMBAT_START_TURN` | `310` | Avoids wasting attacks during spawn phase |
| `OPENFRONT_DECISION_EVERY_TURNS` | `18` | Strategic decision cadence |

## Architecture

```text
OpenFront WebSocket
        |
        v
 src/protocol.ts  <---- exact OpenFront ZbinWire.ts when available
        |
        +--------------------+
        |                    |
        v                    v
 src/spawn.ts          src/strategy.ts
 geometry + ONNX       stats + memory + reserve logic
        |                    |
        +---------+----------+
                  v
               aibot.ts
```

The ONNX model is deliberately a **spawn prior**, not a combat oracle. The old training labels did not match OpenFront's attack protocol, so using that model for combat would make the bot less correct, not more intelligent.

## Training data

Extract semantically correct winner actions:

```bash
npm run extract
```

This writes `training/intent_dataset.jsonl` (ignored by git). See [`training/README.md`](training/README.md) for the plan to rebuild a real learned policy by replaying each game through the exact engine commit recorded in the replay.

## Development

```bash
npm run typecheck
npm test
npm run check
```

## Next strength upgrades

The next meaningful jump is not a bigger network. It is exact state reconstruction and evaluation:

1. replay each training game through its recorded OpenFront commit;
2. learn separate action, target, and troop-allocation heads;
3. add structures, naval access, diplomacy, incoming attacks, and border topology to the state;
4. benchmark every policy revision in repeatable bot-vs-bot match suites;
5. only promote a model when its win rate beats this deterministic strategy baseline.

That gives the ML system a reliable target instead of optimizing corrupted labels.
