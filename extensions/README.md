# extensions/

Playtest tooling for testing decks (built via the scryfall-mcp tools) against an AI-controlled
opponent. This lives alongside the MCP server because playtesting calls back into the same MCP
functions (deck building, EDHREC lookups, pricing) — it isn't a component of the MCP server itself,
and doesn't run over stdio or speak the MCP protocol.

`playtest-table/` (the SvelteKit app) is the live, working version — it has full feature parity
with the original static page. `playtest-table.html`, `deck-data/`, and `browser-driver/` are the
old approach, kept only until we're confident the new one has been played on enough to trust it;
after that they should be deleted, not left to rot.

```
extensions/
├── playtest-table.html          ← OLD single-file board (Zada vs Kumena test decks)
│                                   published to claude.ai, driven by clicking via Playwright
├── deck-data/
│   ├── card-db.json              ← offline Scryfall card data (name/image/type) for playtest-table.html
│   └── presets.json               ← decklists loadable in that page (Zada, Kumena)
│
├── browser-driver/                ← OLD click-automation setup for playtest-table.html
│   ├── driver.js                  ← persistent local server; Claude sends it commands, it clicks the board via Playwright
│   ├── diagnose.js                ← throwaway debugging script, safe to delete
│   ├── open-playtest-chrome.bat   ← launches the debuggable Chrome window the driver attaches to
│   ├── .browser-profile/          ← Chrome profile data (from an earlier, abandoned approach)
│   └── .test-profile/             ← Chrome profile data (from an earlier connectivity test)
│
└── playtest-table/                 ← CURRENT: SvelteKit app, real-time board over WebSockets
    ├── wrangler.jsonc               ← Cloudflare config: binds GAME_ROOM → the GameRoom Durable Object
    ├── vite.config.ts               ← SvelteKit + plugin that merges GameRoom into the built worker
    ├── package.json
    ├── static/deck-data/
    │   ├── card-db.json              ← full-resolution Scryfall art (fetched client-side, not bundled in the worker)
    │   └── presets.json               ← Zada / Kumena decklists
    ├── scripts/
    │   └── play.js                    ← Claude's CLI for actually executing moves (see below) — no browser involved
    └── src/
        ├── routes/
        │   ├── +page.svelte                    ← the actual board: zones, hand, battlefield, log, import panel, zoom modal
        │   └── api/room/[roomId]/+server.ts     ← upgrades the request, hands it to the Durable Object
        └── lib/server/
            ├── types.ts                          ← shared GameState/Card/PlayerState shapes
            ├── game-room.ts                      ← the Durable Object: holds authoritative state, applies actions, persists, broadcasts
            └── worker-exports.ts                  ← re-exports GameRoom so the plugin can find it
```

## Running it locally

`vite dev` (plain SvelteKit dev server) does **not** have Durable Object bindings — only
`wrangler dev` runs the actual Cloudflare Workers runtime (via Miniflare) locally:

```bash
cd extensions/playtest-table
npm install
npm run build
npx wrangler dev --port 8787
```

Open `http://localhost:8787` in a browser to play your own side. Claude executes the AI's side via
`scripts/play.js` — a WebSocket CLI, not browser automation:

```bash
node scripts/play.js state                              # read the current board
node scripts/play.js loadPreset ai "Kumena"              # load a preset deck (substring match)
node scripts/play.js openingHand ai
node scripts/play.js move ai "Island" hand battlefield
node scripts/play.js tap ai "Island"
node scripts/play.js pass
```

Every command connects, sends one action (or none, for `state`), gets the resulting broadcast back,
and disconnects — state lives in the Durable Object, not in any one connection, so the browser tab
and Claude's script always see the same board.

## Architecture notes worth knowing

- **No `webSocketOpen` hook.** Cloudflare's Hibernation API only calls `webSocketMessage`/`Close`/
  `Error` — the initial state has to be sent directly on the socket inside `fetch()`, before the 101
  response goes out. (First version of this got that wrong and every connection hung forever
  waiting for a push that was never coming.)
- **Card art lives client-side only.** The Durable Object's state has zero images in it — just
  `{id, name, tapped}`. The Svelte page fetches `card-db.json` once and looks up art/type text by
  name for rendering. Keeps persisted state small and keeps Scryfall art entirely a presentation
  concern.
- **Shuffling is server-authoritative.** `Math.random()` runs inside the Durable Object, not the
  client, so nobody (human or script) can see or influence shuffle order before it happens.
