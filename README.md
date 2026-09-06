# OpenFrontAI

A strategy bot for [OpenFront](https://github.com/openfrontio/OpenFrontIO) focused on **correct game semantics first**, then learning.

The original prototype made percentage-style combat decisions (for example `0.3` meaning "attack with 30%"), which is a perfectly reasonable strategy representation. The important protocol detail is that current OpenFront converts that ratio to an **absolute troop count** before putting the attack intent on the wire. The old standalone bot skipped that client-side conversion when it wrote directly to the WebSocket. The replay extractor also trained attacks as tile targets even though OpenFront attacks target player IDs.

This branch fixes those foundations and now includes explicit network/admission diagnostics.

## What v3 does

- **Protocol-correct attacks**: `targetID` + absolute troop counts, or `troops: null` to let OpenFront choose its configured default.
- **Strategic combat policy**: keeps a reserve, expands neutral land early, retaliates against recent attackers, avoids stronger fights, prefers favorable nearby targets, and never attacks live-stat teammates.
- **Better spawning**: waits briefly to observe other spawns, scores open/inland land, avoids crowded starts, and uses the ONNX heatmap as one bounded input instead of blindly trusting it.
- **Optional ground-truth live stats**: on a local server with the admin-bot API enabled, decisions use current troops, tiles, team, and alive status.
- **Current + legacy wire support**: legacy JSON still works; current OpenFront `zbin` is loaded from the exact local OpenFront checkout so the bot cannot silently drift from the server schema.
- **Correct replay labels**: the extractor records real `spawn(tile)` and `attack(targetID, troops)` actions without fabricating board state.
- **Connection diagnostics**: distinguishes WebSocket handshake, game-server admission, and server-echoed gameplay intents.
- **Heartbeat**: sends the same 5-second application ping cadence as the official client so a valid session is not pruned as stale.
- **Tests and CI**: spawn and strategy behavior are unit-tested and TypeScript is checked in CI.

## Quick start: local OpenFront

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

## Why "connected" may still do nothing

Current OpenFront has three distinct stages that used to be easy to confuse:

```text
WebSocket open
    ↓
join/rejoin accepted by game server
    ↓
intent accepted and echoed in a committed turn
```

The bot now logs each separately:

```text
[NET] WebSocket handshake succeeded; waiting for game-server admission
[AUTH] Admitted as client Ab12Cd34
[INTENT] Sent spawn(tile=12345) at turn 18
[ACK] spawn(tile=12345) accepted into turn 19 (... ms)
```

If you see `[NET]` but never `[AUTH]`, the problem is authentication/admission, not combat strategy. If you see `[INTENT]` but no `[ACK]`, the bot will warn after a few turns; that points to a wire-schema, rate-limit, spectator, or admission problem.

### Production authentication

Current production OpenFront does **not** accept a randomly generated persistent ID as a play token. A first production join requires normal OpenFront authentication plus a fresh Turnstile token. This bot intentionally does not try to bypass that check.

For your own session, keep credentials only in local environment variables; never paste them into chat or commit them:

```powershell
$env:OPENFRONT_HTTP_BASE = "https://YOUR_OPENFRONT_HOST"
$env:OPENFRONT_WS_BASE = "wss://YOUR_OPENFRONT_HOST"
$env:OPENFRONT_PLAY_TOKEN = "...your current play token..."
$env:OPENFRONT_TURNSTILE_TOKEN = "...fresh first-join token..."
$env:OPENFRONT_SOURCE = "C:\\path\\to\\the-matching-OpenFrontIO-checkout"
npm run bot -- YOUR_GAME_ID
```

A safer workflow for development is still to run the official server locally, where Dev mode accepts a generated persistent ID and does not require Turnstile.

If the same authenticated identity was already admitted to the game and you are reconnecting it, current OpenFront supports the normal `rejoin` message:

```powershell
$env:OPENFRONT_JOIN_MODE = "rejoin"
$env:OPENFRONT_REJOIN_LAST_TURN = "0"
npm run bot -- YOUR_GAME_ID
```

A **fresh join after the game has already started becomes a spectator** in current OpenFront because the player roster is frozen at start. The bot detects that and refuses to pretend its gameplay intents will work.

## Better decisions with live stats

Current OpenFront can expose consensus live stats to a trusted local admin bot. If your local server has `ADMIN_BOT_API_KEY` configured, pass the same value to this process:

```bash
OPENFRONT_ADMIN_BOT_KEY=your-local-key npm run bot -- YOUR_GAME_ID
```

That gives the strategy real troop counts, territory size, team, and alive status. Without it, the bot falls back safely: it expands neutral land, retaliates against observed attackers, and in FFA can pressure known hostiles using OpenFront's own default attack amount. It does **not** guess team relationships.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENFRONT_HTTP_BASE` | `http://localhost:9000` | OpenFront HTTP base |
| `OPENFRONT_WS_BASE` | derived from HTTP base | WebSocket base |
| `OPENFRONT_SOURCE` | auto-detected nearby | Exact OpenFront checkout for zbin |
| `OPENFRONT_PROTOCOL` | `auto` | `auto`, `json`, or `zbin` |
| `OPENFRONT_PLAY_TOKEN` | generated only for local Dev | Join/rejoin identity token |
| `OPENFRONT_TURNSTILE_TOKEN` | unset | Fresh first-join token on current production |
| `OPENFRONT_JOIN_MODE` | `join` | `join` or `rejoin` |
| `OPENFRONT_REJOIN_LAST_TURN` | `0` | Last turn already received when rejoining |
| `OPENFRONT_ADMIN_BOT_KEY` | unset | Enables local live-stat reads |
| `OPENFRONT_MODEL` | `./models/openfront_v2.onnx` | Spawn-prior ONNX model |
| `OPENFRONT_HEARTBEAT_MS` | `5000` | Application heartbeat cadence |
| `OPENFRONT_INTENT_ACK_TURNS` | `4` | Turns to wait for a server echo before warning |
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
        admission + heartbeat
          + intent ack tracking
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

Once transport is verified end-to-end, the next meaningful jump is exact state reconstruction and evaluation:

1. replay each training game through its recorded OpenFront commit;
2. learn separate action, target, and troop-allocation heads;
3. add structures, naval access, diplomacy, incoming attacks, and border topology to the state;
4. benchmark every policy revision in repeatable bot-vs-bot match suites;
5. only promote a model when its win rate beats this deterministic strategy baseline.

That gives the ML system a reliable target instead of optimizing corrupted labels.
