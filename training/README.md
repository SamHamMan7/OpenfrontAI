# Training data contract

The original training pipeline mixed up two different OpenFront concepts:

- `spawn` selects a **tile**.
- `attack` selects a **player ID** (`targetID`, with `null` meaning Terra Nullius) and an **absolute troop count**.

It also attempted to build full board tensors without actually replaying the matching OpenFront simulation. That creates plausible-looking but incorrect state/label pairs.

`ReplayExtractor.ts` now emits only facts that are present in the replay itself. Run:

```bash
npm run extract
```

The output is `training/intent_dataset.jsonl` (ignored by git). Each line preserves the source game, engine commit, turn, winner, config, and exact action semantics.

## Rebuilding a real learned policy

A trustworthy full-state imitation learner should:

1. Group replays by `gitCommit`.
2. Check out that exact OpenFrontIO commit.
3. Replay every turn through the official engine to reconstruct deterministic state.
4. Snapshot features immediately before each chosen winner action.
5. Train separate heads for at least:
   - spawn tile,
   - high-level action (hold / neutral expansion / player attack),
   - player target selection,
   - troop amount as a fraction of the *current* player troop count.
6. Evaluate by running matches, not by training loss alone.

Until that exists, the v2 ONNX model is treated only as a spawn prior. Combat uses explicit strategy code with correct protocol semantics.
