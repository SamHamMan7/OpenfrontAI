console.warn("livebot.ts is retired: its tile-based attack messages were invalid OpenFront protocol.");
console.warn("Forwarding to the v3 bot. Use `npm run bot -- <gameID>` going forward.");
await import("./aibot.js");
