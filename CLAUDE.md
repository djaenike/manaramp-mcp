# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP (Model Context Protocol) server, entirely in `index.js` (~1200 lines, ESM, no build step, no
tests, no lint config). It runs over stdio and is spawned as a subprocess by Claude Desktop / Claude Code.
It exposes 18 tools: 10 let Claude reason over live Magic: The Gathering data instead of guessing from
training data, 5 (`playtest_*`) drive a companion local playtest server, 1 (`rate_deck_bracket`) is a
deterministic classifier against the Commander Format Panel's official Bracket System, and 2 more
(`get_moxfield_decklist`, `get_deck_price_total`) round out deck import and a whole-decklist price check —
see below and `extensions/README.md`.

## Commands

```bash
npm install     # only setup step — plain JS, no build
node index.js   # or `npm start` — runs the server directly over stdio
```

There is no test suite, linter, or build step. The only way to validate a change is to run the server
and exercise a tool through an MCP client (Claude Desktop/Code), since stdio servers aren't meaningfully
testable by just running the file standalone (it blocks waiting on stdio and any output goes to a client,
not the terminal).

To connect a local checkout to Claude Desktop for manual testing, add to
`claude_desktop_config.json` (path in [readme.md](readme.md)):
```json
{ "mcpServers": { "scryfall": { "command": "node", "args": ["/absolute/path/to/index.js"] } } }
```
Restart Claude Desktop after any change to `index.js` — it does not hot-reload.

## Architecture

Every tool follows the same shape: `server.tool(name, description, zodSchema, async handler)`, where the
handler fetches from a public HTTP API and returns `{ content: [{ type: "text", text: ... }] }` (MCP's
required response envelope — always stringify JSON payloads into that one text field).

The tool descriptions passed to `server.tool(...)` are load-bearing, not cosmetic — they're what the
calling Claude model reads to decide when and how to use each tool and how to interpret caveats about a
data source's reliability. When editing a tool, keep the description accurate to its actual behavior and
data-quality caveats, since that's the only place this information reaches the model.

Five independent upstream data sources are combined, each with different trust levels — this drives most
of the caveats in tool descriptions and error messages:

- **Scryfall** (`search_cards`, `get_card_by_name`, `get_rulings`) — official, documented, no API key.
  Source of card text/legality/bulk price estimate.
- **EDHREC** (`edhrec_get_commander_recommendations`, `edhrec_get_card_synergies`,
  `edhrec_get_average_decklist`) — unofficial, undocumented JSON endpoints reverse-engineered from
  edhrec.com's own frontend. No fuzzy matching; `slugify()` must produce an exact slug match or it 404s.
- **Forge** (`get_card_script`) — reads community rules-engine scripts live from Card-Forge/forge's GitHub
  raw file host (GPL-3.0), keyed by a guessed filename via `forgeFilename()`. Not verified against split
  cards, DFCs, or unusual punctuation; 404s should fall back to Scryfall oracle text.
- **Card Kingdom** (`get_cardkingdom_price`, and internally reused by `build_budget_deck`) — no developer
  API; fetches one large public pricelist JSON file and filters in memory. Numeric fields arrive from CK
  as strings and must be parsed. Designated as this server's standardized "real dollar price" source,
  distinct from Scryfall's bundled bulk-estimate price.
- **Commander Spellbook** (`find_combos`) — official REST API, MIT licensed, but the exact query
  parameter (`q`) is inferred from a syntax guide rather than confirmed against live docs (their docs site
  blocks automated fetching).
- **playtest-table** (`playtest_list_games`, `playtest_create_table`, `playtest_get_state`,
  `playtest_load_deck`, `playtest_do_action`) — NOT a public API at all: a companion local dev server
  (`extensions/playtest-table`, SvelteKit + Cloudflare Durable Objects) that must be running
  (`npx wrangler dev --port 8787` from that directory) before any of these 5 tools work. Every one
  fails fast with an actionable message if it isn't. `PLAYTEST_SERVER_URL` overrides the default
  `http://127.0.0.1:8787`. See `extensions/README.md` for what this actually is and its own further
  Claude-Code-only conveniences (CLI scripts, a turn-notification auto-wake loop) that these 5 tools
  don't replace — they're the subset that also works from Claude Desktop, which has no Bash tool or
  background-task notifications to run those with.
- **Commander Bracket System** (`rate_deck_bracket`) — not a live data source at all: `GAME_CHANGERS`,
  `MASS_LAND_DENIAL_CARDS`, and `EXTRA_TURN_CARDS` are hardcoded reference lists (Game Changers current
  as of the Feb 9, 2026 update, reviewed by the Commander Format Panel roughly every 3-4 months —
  re-verify against WotC's own list if a rating looks off). Combo detection reuses Commander Spellbook
  (same caveats as `find_combos`) but queries **one card at a time** — empirically confirmed this
  session that Commander Spellbook's `or` keyword is accepted syntax but does NOT behave as boolean OR
  (two individually-valid single-card queries can combine via `or` into zero results), so don't
  reintroduce a batched-OR "optimization" here without re-verifying it against the live API first.
- **Moxfield** (`get_moxfield_decklist`) — no official public API; hits the same undocumented
  `api2.moxfield.com/v2/decks/all/<deckId>` endpoint Moxfield's own frontend calls, which needs its own
  browser-like `MOXFIELD_HEADERS` (the shared Scryfall `HEADERS` User-Agent gets rejected here). **Known,
  confirmed issue**: Moxfield's anti-bot protection sometimes 403s Node's `fetch()` outright — verified
  live this session that identical requests succeed via `curl` but fail via Node `fetch()` even with a
  full realistic Chrome header set (sec-ch-ua, Origin, Referer), which points at TLS/transport-level
  fingerprinting rather than anything header-content can fix. Deliberately shipped anyway with a clear
  403 fallback message (paste decklist text directly instead) rather than chasing a fingerprint-spoofing
  dependency — that would be an arms race against Cloudflare's bot detection, not a stable fix.

`build_budget_deck` is the composite tool: it pulls a commander's full EDHREC card pool, cross-references
every candidate against Card Kingdom's full pricelist, and greedily fills 99 slots by synergy-per-dollar
under a budget. It fetches CK's entire pricelist on every call (same slow path as `get_cardkingdom_price`)
and is explicitly a synergy-per-dollar optimizer, not a power-level/bracket classifier or combo-aware
deckbuilder — it doesn't check curve, color balance, or land count.

Two name-normalization helpers are shared across tools and are a common source of lookup failures:
- `slugify()` — EDHREC's URL slug format (lowercase, hyphens, punctuation stripped)
- `forgeFilename()` — Forge's cardsfolder filename format (lowercase, underscores, punctuation stripped)

`HEADERS` (User-Agent + Accept) is sent on every outbound fetch — Scryfall in particular rejects requests
without an accurate User-Agent.

The 5 `playtest_*` tools are the one place this file's usual "one-shot HTTP GET" shape doesn't apply —
they need a real connect→send→await→close websocket lifecycle plus a connection timeout (a refused
connection, i.e. wrangler dev not running, is the *expected* common case here, unlike the public APIs the
other 10 tools hit). `connectRoom`/`sendAndAwait`/`withRoom` (ported from
`extensions/playtest-table/scripts/play.js`, the pre-existing Claude-Code CLI for this same protocol)
centralize that lifecycle so it's written once, not once per tool. `playtest_do_action`'s `type` field is
also this file's first use of `z.enum(...)` — the wire-protocol action vocabulary is small and closed
enough to validate directly rather than leaving it as a free-form string.

## Deck-building final deliverable

Whenever a conversation in this repo lands on a finished decklist — built via `build_budget_deck`,
assembled manually, or fetched via `get_moxfield_decklist` — treat the job as unfinished until all of
these are delivered, not just a card list:

1. **A short summary** — the commander, the deck's strategy/theme, and a sentence or two on how it
   actually wins.
2. **Its bracket rating**, via `rate_deck_bracket` — stated plainly to the user, not computed silently
   and left out of the final message.
3. **Win conditions**, if any — combos `rate_deck_bracket`/`find_combos` surfaced, or the deck's primary
   game plan if there's no hard combo piece.
4. **A real playtest import** — `playtest_create_table` (label it with the actual commander/deck name,
   never leave it as "Untitled table") followed by `playtest_load_deck` for that seat, so the user gets
   a real `room_url` to open, not just a decklist to eyeball.
5. **If a budget was ever mentioned**, confirm the actual final total via `get_deck_price_total` before
   calling it done — this is a real, previously-hit failure mode: a decklist that started at $75 drifted
   to $135 after manual swaps because nothing re-verified the total after the last edit. Re-check after
   *every* swap, not just once at the start.
