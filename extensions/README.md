# extensions/

Playtest tooling for testing decks (built via the scryfall-mcp tools) against an AI-controlled
opponent. This lives alongside the MCP server because playtesting calls back into the same MCP
functions (deck building, EDHREC lookups, pricing) — it isn't a component of the MCP server itself,
and doesn't run over stdio or speak the MCP protocol.

`playtest-table/` is a SvelteKit app deployed as a Cloudflare Worker, with a Durable Object holding
each room's live game state and pushing updates to every connected client over WebSockets. There's
no separate card database file anymore — any deck (pasted, or pulled at random from EDHREC) is
cross-referenced against Scryfall live, server-side, at import time.

```
extensions/
└── playtest-table/
    ├── wrangler.jsonc               ← Cloudflare config: binds GAME_ROOM → the GameRoom Durable Object
    ├── vite.config.ts               ← SvelteKit + plugin that merges GameRoom into the built worker
    ├── package.json
    ├── scripts/
    │   ├── play.js                   ← Claude's CLI for actually executing moves — no browser involved
    │   └── watch-for-turn.js         ← waits until it's the AI's turn, then exits (wakes Claude up)
    └── src/
        ├── routes/
        │   ├── +page.svelte                    ← the board: zones, hand, battlefield, log, import panel, zoom modal
        │   ├── api/room/[roomId]/+server.ts     ← upgrades the request, hands it to the Durable Object
        │   ├── api/resolve-deck/+server.ts       ← cross-references a parsed decklist against Scryfall
        │   └── api/random-deck/+server.ts        ← pulls a commander's EDHREC average build, then resolves it
        └── lib/server/
            ├── types.ts                          ← shared GameState/Card/PlayerState/CardInfoEntry shapes
            ├── deck-resolve.ts                    ← Scryfall/EDHREC fetch helpers shared by both api/ routes
            ├── game-room.ts                       ← the Durable Object: holds authoritative state, applies actions, persists, broadcasts
            └── worker-exports.ts                  ← re-exports GameRoom so the vite plugin can find it
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
node scripts/play.js state                                        # read the current board
node scripts/play.js randomDeck ai                                 # random commander, real EDHREC decklist
node scripts/play.js randomDeck ai "Krenko, Mob Boss"               # or name one specifically
node scripts/play.js importDeck ai path/to/pasted-decklist.txt      # Moxfield-style export from a file
node scripts/play.js openingHand ai
node scripts/play.js move ai "Island" hand battlefield
node scripts/play.js tap ai "Island"
node scripts/play.js search ai library land                        # find a card by name or type (for tutors)
node scripts/play.js counter ai "Some Creature" "+1/+1" 2
node scripts/play.js batch '[{"type":"moveCard","player":"ai","cardName":"Island","fromZone":"hand","toZone":"battlefield"},{"type":"passTurn"}]'
node scripts/play.js pass
```

A whole turn is normally one `batch` call — one connection, one round trip — rather than one
process per action. See the comment block at the top of `play.js` for the full command list.

### The turn-notification loop

`watch-for-turn.js` connects, waits until the room's `active` player becomes `"ai"`, then exits.
Claude launches it as a tracked background process after every AI turn; the harness notifies Claude
automatically when it exits, which is what makes "you don't have to ping the chat every time it's
the AI's turn" actually work. It must be launched as the directly-tracked process (not detached with
`&`/`disown` the way long-running servers are) — detaching it removes it from what the harness is
watching, so its eventual exit goes unnoticed.

## Architecture notes worth knowing

- **No `webSocketOpen` hook.** Cloudflare's Hibernation API only calls `webSocketMessage`/`Close`/
  `Error` — the initial state has to be sent directly on the socket inside `fetch()`, before the 101
  response goes out.
- **Card art/type/cost/text live in `GameState.cardInfo`**, not a static file — a dictionary keyed
  by card name that only ever grows, populated by `/api/resolve-deck` and `/api/random-deck`
  whenever a deck is imported, and preserved across table resets. Individual `Card` instances in
  hand/battlefield/etc. stay lightweight (`{id, name, tapped, counters}`) and look up full details
  by name from `cardInfo` at render time — which also means Claude's own state reads already have
  full card data for anything ever imported into the room, no separate lookup needed.
- **Scryfall/EDHREC calls happen server-side (the Worker), never in the browser.** Partly to avoid
  depending on their CORS policy (servers aren't subject to CORS, only browsers are, and it was
  never actually confirmed whether either API allows direct browser calls) — and as a side effect,
  since this page isn't a claude.ai Artifact, there's no CSP blocking remote `<img>` sources either,
  so card art is just the plain Scryfall CDN URL, no base64 embedding needed.
- **Shuffling is server-authoritative.** `Math.random()` runs inside the Durable Object, not the
  client, so nobody (human or script) can see or influence shuffle order before it happens.
- **`process.exit()` right after `console.log` races with stdout** when output is redirected to a
  file, as it always is for backgrounded scripts — both CLI scripts flush via a write callback
  before exiting to avoid silently truncating their final output.
