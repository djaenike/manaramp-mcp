# extensions/

Playtest tooling for testing decks (built via the scryfall-mcp tools) against an AI-controlled
opponent, another person, or watching two AIs play each other. This lives alongside the MCP server
because playtesting calls back into the same MCP functions (deck building, EDHREC lookups,
pricing) — the server itself (`playtest-table/`, below) isn't a component of the MCP server and
doesn't run over stdio.

**Update:** a subset of this — create a table, load a deck, read state, act on the board — is now
also exposed as real MCP tools directly in root `index.js` (`playtest_list_games`,
`playtest_create_table`, `playtest_get_state`, `playtest_load_deck`, `playtest_do_action`), so any
MCP client (Claude Desktop included, not just Claude Code) can drive a game via chat. These tools
talk to the deployed Worker by default (see below) — no local server needs to be running for normal
use; `PLAYTEST_SERVER_URL` only needs setting to point them at a local `wrangler dev` instead, for
developing the playtest-table app itself. The CLI scripts and the turn-notification auto-wake loop
described in this file remain Claude-Code-only conveniences — they depend on a Bash tool and
background-task notifications that Claude Desktop simply doesn't have; a Desktop session drives
games entirely through those 5 tools instead. See root `CLAUDE.md` for the tool list.

`playtest-table/` is a SvelteKit app **deployed as a real Cloudflare Worker**
(`https://scryfall-mcp.playtest-table.workers.dev`, same host as `PLAYTEST_BASE` in root
`index.js`), with a Durable Object holding each room's live game state and pushing updates to every
connected client over WebSockets. There's no separate card database file anymore — any deck
(pasted, or pulled at random from EDHREC) is cross-referenced against Scryfall live, server-side, at
import time. Critically, this also means **an AI-controlled seat plays itself with no Claude
session involved at all** — the Worker calls the Anthropic API directly from a Durable Object alarm
whenever it's an AI seat's move (see "Autonomous AI play" below). The CLI scripts and
turn-notification loop further down this file are a separate, Claude-Code-only way to directly
script or observe a room over its raw WebSocket protocol (useful for development/testing, as most of
this file documents) — they are not what makes a real user's game against an AI opponent actually
play out.

A room is N **seats** (currently always 2), each either `human` or `ai`-controlled, chosen at
creation time in the lobby. "AI vs AI" isn't a separate mode — it's just a room where every seat
happens to be AI-controlled, which the board detects and renders read-only for spectating.

```
extensions/
└── playtest-table/
    ├── wrangler.jsonc               ← Cloudflare config: binds GAME_ROOM + LOBBY Durable Objects
    ├── vite.config.ts               ← SvelteKit + plugin that merges both DO classes into the built worker
    ├── package.json
    ├── scripts/
    │   ├── play.js                   ← Claude's CLI for actually executing moves — no browser involved
    │   └── watch-for-turn.js         ← waits until a given seat becomes active, then exits (wakes Claude up)
    └── src/
        ├── routes/
        │   ├── +page.server.ts                  ← "/" just redirects to "/lobby"
        │   ├── lobby/+page.svelte                ← list open tables, create a new one (pick seats/controllers)
        │   ├── room/[roomId]/+page.svelte        ← the board: zones, hand, battlefield, log, import panel, zoom modal
        │   ├── api/room/[roomId]/+server.ts     ← upgrades the request, hands it to the room's Durable Object
        │   ├── api/lobby/+server.ts               ← list/create rooms (seeds GameRoom + records it in LobbyRegistry)
        │   ├── api/resolve-deck/+server.ts       ← cross-references a parsed decklist against Scryfall
        │   └── api/random-deck/+server.ts        ← pulls a commander's EDHREC average build, then resolves it
        └── lib/server/
            ├── types.ts                          ← shared GameState/SeatDef/PlayerState/CardInfoEntry shapes
            ├── deck-resolve.ts                    ← Scryfall/EDHREC fetch helpers shared by both api/ routes
            ├── game-room.ts                       ← the Durable Object: holds authoritative state, applies actions, persists, broadcasts
            ├── lobby-registry.ts                   ← singleton Durable Object: just a JSON list of rooms for the lobby to display
            └── worker-exports.ts                  ← re-exports both DO classes so the vite plugin can find them
```

## Running it locally

Not required for normal play — the deployed Worker above handles that. Run this only when actually
developing `playtest-table/` itself (a UI change, a new action, etc.) and you want a live loop
without deploying first.

`vite dev` (plain SvelteKit dev server) does **not** have Durable Object bindings — only
`wrangler dev` runs the actual Cloudflare Workers runtime (via Miniflare) locally:

```bash
cd extensions/playtest-table
npm install
npm run build
npx wrangler dev --port 8787
```

Open `http://localhost:8787` — it redirects to `/lobby`. Create a table there (label each seat,
pick `human` or `ai` per seat) and you land on `/room/<roomId>`. Claim a human seat by clicking
"Claim seat" (a per-browser id in `localStorage`, not a real login — anyone can still act on any
seat over the websocket regardless of claim state, it's purely a UI convenience).

In Claude Code, Claude executes any AI-controlled seat via `scripts/play.js` — a WebSocket CLI, not
browser automation — same server, same port. In Claude Desktop (or any other MCP client), the same
actions go through the `playtest_*` tools in root `index.js` instead, which read
`PLAYTEST_SERVER_URL` (default `http://127.0.0.1:8787`) — set it if wrangler is bound to a
different port. The CLI scripts below point at a specific room with `ROOM_URL`:

```bash
ROOM_URL=ws://127.0.0.1:8787/api/room/<roomId>   # or omit entirely to use the legacy "default" room
node scripts/play.js state                                          # read the current board — lists this room's actual seat ids
node scripts/play.js randomDeck seat1                                # random commander, real EDHREC decklist
node scripts/play.js randomDeck seat1 "Krenko, Mob Boss"              # or name one specifically
node scripts/play.js importDeck seat1 path/to/pasted-decklist.txt     # Moxfield-style export from a file
node scripts/play.js openingHand seat1
node scripts/play.js move seat1 "Island" hand battlefield
node scripts/play.js tap seat1 "Island"
node scripts/play.js search seat1 library land                       # find a card by name or type (for tutors)
node scripts/play.js counter seat1 "Some Creature" "+1/+1" 2
node scripts/play.js batch '[{"type":"moveCard","player":"seat1","cardName":"Island","fromZone":"hand","toZone":"battlefield"},{"type":"passTurn"}]'
node scripts/play.js pass
```

A room created via the lobby uses seat ids `seat0`/`seat1` (whatever labels were chosen are just
display text); the old, never-relobbied `default` room still uses the original literal `you`/`ai`
ids. Either way, run `state` first if you don't already know a room's seat ids.

A whole turn is normally one `batch` call — one connection, one round trip — rather than one
process per action. See the comment block at the top of `play.js` for the full command list.

### Autonomous AI play

An AI-controlled seat's actual moves during real (non-Claude-Code-testing) play are **not** driven
by Claude at all — `lib/server/ai-turn.ts` calls the Anthropic API directly from inside the Durable
Object, on its own `ANTHROPIC_API_KEY` secret (`ANTHROPIC_MODEL` env var overrides the default,
`claude-haiku-4-5-20251001` — deliberately the cheapest current model, since every AI move on every
deployed game is billed to that one key). This means a "Me vs AI" table plays itself end-to-end from
the moment a human clicks through the lobby, with zero dependency on any Claude conversation being
open anywhere — the "materially different, bigger project" this file used to describe as future
work (a separate always-on service hitting the Claude API on its own schedule) is what this is.

`GameRoom`'s `alarm()` handler (a Cloudflare Durable Object Alarm, not a cron sweep — reactive,
scheduled ~1.5s after whatever change just left an AI seat needing to act) is the trigger, checked
in priority order every time it fires:
1. A pending block decision for an AI-controlled defender (`requestAiBlocks`) — can be true even
   when `game.active` belongs to a different (attacking) seat.
2. A pending discard for an AI-controlled seat over its hand-size limit (`requestAiDiscard`).
3. Otherwise, if the active seat is AI-controlled, a full turn (`requestAiTurn` — one Anthropic call
   forced to a `submit_turn` tool, returning a whole ordered action batch ending in `passTurn`).

Each of these three calls the same `applyAction`/`GameRoom` action vocabulary a human's own actions
go through (`ai-turn.ts`'s `ACTION_TYPES` is a deliberate subset — no `openingHand`/`mulligan`/
`claimSeat`/`loadDeck`/`resetTable`, since those are pregame/meta actions that would be destructive
or nonsensical for an automated mid-game turn to invoke). If a call throws (bad key, API outage,
model didn't return valid tool input), the room logs the failure and retries on the next alarm;
after 3 consecutive failures it falls back to a safe deterministic default so the room can never
get permanently stuck — "no blocks" for a stuck block decision, an automatic discard of the
hand's last N cards for a stuck discard, and for a stuck full turn, stopping automatic play for
that seat entirely (logged, pointing at the `ANTHROPIC_API_KEY` secret) rather than hot-looping a
persistently broken call. A room-wide `MAX_AI_MOVES_PER_ROOM` cap also stops automatic play once
hit, as a blunt cost backstop against an unwatched AI-vs-AI room running forever.

The model only ever sees the requesting seat's own hidden information (hand contents are described
in full only for that seat; every other seat's hand is reported as a count only — see
`summarizeGameState` in `ai-turn.ts`), and every returned action has its `player` field forcibly
rewritten to the requesting seat regardless of what the model's response says, matching the same
defensive fix already applied to the human-facing MCP tools after this project's own
"AI played my cards" bug.

### Directly scripting/observing a room (Claude Code only)

Separately from the autonomous system above, Claude Code can still drive or observe a room directly
over its raw WebSocket protocol — useful for development/testing (most of this file, and how this
session's own combat/UI changes were exercised end-to-end), or if a user specifically asks Claude to
play a move itself rather than let the Worker's own AI act.

```bash
node scripts/find-ai-games.js   # or HTTP_BASE=http://127.0.0.1:8787 node scripts/find-ai-games.js
```

Lists every room with an AI seat and flags which ones actually need a move right now (`active` is
an AI-controlled seat) — cheaper than hand-checking `state` on every room in the lobby.

`watch-for-turn.js` connects, waits until the room's `active` player becomes a given seat id
(`WATCH_SEAT` env var, default `"ai"` for the legacy default room), then exits:

```bash
ROOM_URL=ws://127.0.0.1:8787/api/room/<roomId> WATCH_SEAT=seat1 node scripts/watch-for-turn.js
```

Claude launches it as a tracked background process after every AI turn it drives itself; the
harness notifies Claude automatically when it exits, which is what makes "you don't have to ping
the chat every time it's the AI's turn" work for this direct-scripting path. It must be launched as
the directly-tracked process (not detached with `&`/`disown` the way long-running servers are) —
detaching it removes it from what the harness is watching, so its eventual exit goes unnoticed.

### AI vs AI spectating

Create a table with both seats set to `ai`. The board detects "every seat is AI-controlled" and
renders read-only (no life stepper, draw/mulligan/pass-turn buttons, tap-toggle, or zone-move
popovers) — nobody can claim a seat since none are human. In normal play both seats resolve their
own turns via the autonomous system above with nobody watching required; anyone with the room URL
just watches the board update live from the same broadcasts a normal game uses. Claude Code can
still drive both seats itself via `scripts/play.js` instead, same as any AI seat, for testing.

## Combat & abilities

Combat is the one part of the game the engine actually structures (everything else — casting a
spell, an ETB, an activated ability's effect — is just applied directly via the general-purpose
actions, no stack, no priority passing):

- **`declareAttackers(player, cardIds)`** — validates every named creature is untapped and either
  not summoning-sick or has haste, in a two-pass validate-then-commit (all creatures are checked
  *before* any are tapped, so one invalid creature in a multi-attacker declaration can't leave
  earlier ones tapped-but-uncommitted). Taps each attacker unless it has vigilance. If no attacker
  has any legal blocker anywhere on the defending side, combat resolves immediately with no blocks
  (skips a pointless declare-blockers step).
- **`declareBlockers(player, blocks)`** — validates each assignment against `canBlock`, throws if a
  blocker can't legally block what it's assigned to, then resolves.
- **`canBlock(attackerInfo, blockerInfo)`** — oracle-text-substring keyword checks (`hasKeyword`,
  shared by all of the below): an attacker with "can't be blocked" is never blockable; otherwise an
  attacker with flying needs a blocker with flying or reach; anything else can be blocked by
  anything untapped. Deliberately does not parse conditional/"except by ..." unblockable text —
  same bounded-scope tradeoff as the rest of `hasKeyword`.
- **`resolveCombat(blocks)`** — for each attacker: unblocked deals its power straight to the
  defending player; blocked with trample computes total assigned-blocker toughness, and if attacker
  power exceeds it, every assigned blocker dies and the excess spills over as life loss to the
  defending player — otherwise (not enough power to punch through, or no trample) falls back to a
  simplified "first blocker takes all the attacker's power" resolution rather than modeling real
  per-blocker lethal-damage-assignment ordering. The attacker itself dies if total blocker power
  meets or exceeds its toughness, independent of any of the above.
- **Not modeled**: deathtouch, first strike/double strike, menace, conditional unblockable, and true
  attacker-controlled lethal-assignment ordering across multiple blockers — all bounded, deliberate
  simplifications for a casual playtest board, not a rules-accurate engine.
- **`activateAbility(player, cardId)`** — taps an untapped permanent and logs the activation
  distinctly from a combat/mana tap (e.g. "X's ability activated (tapped)"). Deliberately does not
  parse costs or apply effects — whatever the ability actually does still gets applied by hand via
  the existing general actions (`adjustLife`/`adjustCounter`/`addCard`/`moveCard`), the same way
  casting a spell already works on this board. A lightweight, explicitly-scoped choice over building
  real cost/effect parsing, since the board already treats every other spell/ability the same way.

Client-side (`room/[roomId]/+page.svelte`), the block-assignment flow mirrors Arena rather than a
single dropdown: click one of your own untapped creatures to "arm" it as a blocker (clicking it
again, or clicking an attacker while it's armed, assigns it), then click the attacking creature
you're blocking to complete the assignment; clicking an already-assigned blocker again removes it.
`canBlockClient()` mirrors the server's flying/reach/unblockable legality purely to dim illegal
targets — the server call in `declareBlockers` remains the sole authority. Orange SVG connector
lines are drawn between each assigned attacker/blocker pair (computed from live `getBoundingClientRect()`
positions, redrawn on assignment change and window resize), and the opponent's battlefield renders
its permanent categories in mirrored order so creatures on both sides sit nearest the shared middle
of the table rather than in visually inconsistent stacks.

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
- **Seat claiming is a UI convenience, not access control.** `claimSeat`/`releaseSeat` just record a
  per-browser `localStorage` id against a seat so the board knows which row to call "yours" and to
  disable claiming an already-claimed human seat — any client can still send moves for any seat
  regardless of claim state, same trust level the project has always had. There are no real user
  accounts.
- **`LobbyRegistry` is a second, singleton Durable Object** (`idFromName('singleton')`), holding
  nothing but a flat JSON list of rooms so `/lobby` has something to display — there's no API to
  enumerate `GameRoom`'s `idFromName`-derived instances from outside, so this list is the only
  record of what rooms exist. It's a plain request/response `fetch()`, no websocket; the lobby list
  is refetched on navigation, not pushed live.
- **A room's seats are seeded once, before anyone connects**, via a plain (non-websocket) `POST
  .../init` on the `GameRoom` itself — `/api/lobby`'s create handler calls this right after minting
  a room id, before recording it in the registry. `initSeats` is idempotent: if the room somehow
  already has saved state, seeding again is a no-op rather than clobbering an in-progress game.
- **Rooms saved before the `seats[]` model existed have no `seats` array at all.** `loadGame()`
  treats that shape as fresh rather than crashing the first time anything reads `game.seats` —
  which is what happened to the original `default` room the first time it was reconnected to after
  this change; its prior game state didn't carry forward.
