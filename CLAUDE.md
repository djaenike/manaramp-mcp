# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP (Model Context Protocol) server, entirely in `index.js` (~1400 lines, ESM, no build step, no
tests, no lint config). It runs over stdio and is spawned as a subprocess by Claude Desktop / Claude Code.
It exposes 20 tools: 10 let Claude reason over live Magic: The Gathering data instead of guessing from
training data, 5 (`playtest_*`) drive a companion local playtest server, 2 (`rate_deck_bracket`,
`analyze_deck_consistency`) are deterministic checks — power-level bracket and structural legality/mana
curve, respectively — against real data instead of an eyeballed guess, 2 more (`get_moxfield_decklist`,
`get_deck_price_total`) round out deck import and a whole-decklist price check, and 1 (`deliver_finished_deck`)
composes the bracket/price/consistency checks plus playtest table creation into the single required
final-delivery step — see below and `extensions/README.md`.

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

Several independent upstream data sources (plus a couple of purely local, deterministic checks) are
combined below, each with different trust levels — this drives most of the caveats in tool
descriptions and error messages:

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
  `playtest_load_deck`, `playtest_do_action`) — NOT a public API at all: a companion server
  (`extensions/playtest-table`, SvelteKit + Cloudflare Durable Objects) deployed as a real Cloudflare
  Worker at `PLAYTEST_BASE` in `index.js` (`https://scryfall-mcp.playtest-table.workers.dev` by
  default — no local process needs to be running for normal use). `PLAYTEST_SERVER_URL` overrides
  that default to point at a local `npx wrangler dev --port 8787` instead, for developing the
  playtest-table app itself. Every one of these 5 tools fails fast with an actionable message if the
  target server can't be reached. Critically, an AI-controlled seat's turns are **not** driven by
  these tools or by any Claude session at all in normal play — the deployed Worker resolves them
  itself via a Durable Object alarm that calls the Anthropic API directly (its own
  `ANTHROPIC_API_KEY` secret, Haiku 4.5 by default), so a game plays itself end-to-end the moment a
  human clicks through the lobby, with zero dependency on this MCP server or a Claude conversation
  being open anywhere. See `extensions/README.md` for the full autonomous-play design and its own
  further Claude-Code-only conveniences (CLI scripts for directly scripting/observing a room over
  its WebSocket, independent of the autonomous alarm) that these 5 tools don't replace — they're the
  subset that also works from Claude Desktop, which has no Bash tool or background-task
  notifications to run those with.
- **Commander Bracket System** (`rate_deck_bracket`) — not a live data source at all: `GAME_CHANGERS`,
  `MASS_LAND_DENIAL_CARDS`, and `EXTRA_TURN_CARDS` are hardcoded reference lists (Game Changers current
  as of the Feb 9, 2026 update, reviewed by the Commander Format Panel roughly every 3-4 months —
  re-verify against WotC's own list if a rating looks off). Combo detection reuses Commander Spellbook
  (same caveats as `find_combos`) but queries **one card at a time** — empirically confirmed this
  session that Commander Spellbook's `or` keyword is accepted syntax but does NOT behave as boolean OR
  (two individually-valid single-card queries can combine via `or` into zero results), so don't
  reintroduce a batched-OR "optimization" here without re-verifying it against the live API first.
- **`analyze_deck_consistency`** — not a separate upstream source: reuses the same Scryfall
  `/cards/collection` batch call `classifyComboSpeed`/`resolveCardInfo` already use (one fetch
  yields `cmc`, `type_line`, `color_identity`, and `legalities.commander` for the whole decklist at
  once). Checks deck size (100, commander(s) included), singleton (basic-land-ness read from the
  real `type_line`, not a hardcoded name list), color identity, and Commander legality — then
  computes a mana curve and a `curve_out_probability` (turns 1-6) via a hand-rolled hypergeometric
  helper (`combinations`/`hypergeometricAtLeast`, an iterative running product/division so a
  99-card library never risks overflow). That probability is an explicitly SIMPLIFIED model (7-card
  opening hand + 1 draw/turn, no mulligans/scry/ramp/card-draw spells) — verified by hand this
  session (37/99 lands → 96.7% chance of ≥1 land in the opening 7, matching the classic
  Frank-Karsten-style reference figure). Deliberately does **not** detect combos — that stays
  `rate_deck_bracket`'s job, so the Commander-Spellbook-querying logic never has to live in two
  places at once.
- **Moxfield** (`get_moxfield_decklist`) — no official public API; hits the same undocumented
  `api2.moxfield.com/v2/decks/all/<deckId>` endpoint Moxfield's own frontend calls, which needs its own
  browser-like `MOXFIELD_HEADERS` (the shared Scryfall `HEADERS` User-Agent gets rejected here). **Known,
  confirmed issue**: Moxfield's anti-bot protection sometimes 403s Node's `fetch()` outright — verified
  live this session that identical requests succeed via `curl` but fail via Node `fetch()` even with a
  full realistic Chrome header set (sec-ch-ua, Origin, Referer), which points at TLS/transport-level
  fingerprinting rather than anything header-content can fix. Deliberately shipped anyway with a clear
  403 fallback message (paste decklist text directly instead) rather than chasing a fingerprint-spoofing
  dependency — that would be an arms race against Cloudflare's bot detection, not a stable fix.

`build_budget_deck` is a composite tool: it pulls a commander's full EDHREC card pool, cross-references
every candidate against Card Kingdom's full pricelist, and greedily fills 99 slots by synergy-per-dollar
under a budget. It fetches CK's entire pricelist on every call (same slow path as `get_cardkingdom_price`)
and is explicitly a synergy-per-dollar optimizer, not a power-level/bracket classifier or combo-aware
deckbuilder — it doesn't check curve, color balance, or land count.

`deliver_finished_deck` is the other composite tool, and the newest one: it's not an independent data
source but glue over five other tools' logic (bracket, price, consistency, and playtest table
creation/deck loading), see "Deck-building final deliverable" below for its contract. Its handler is the
one place in this file where a tool calls `Promise.all` across independently-throwing async functions
(`computeDeckConsistency`/`computeBracketRating`/`computeDeckPriceTotal`) rather than one `fetch` — each
was refactored out of its own standalone tool specifically so this composite could call the same logic
without duplicating it or invoking the standalone tools over MCP from within a tool handler.

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
assembled manually, or fetched via `get_moxfield_decklist` — treat the job as unfinished until
`deliver_finished_deck` has been called and its `final_delivery_text` has been pasted to the user
verbatim. This tool exists specifically so the final format is defined once, in code, instead of being
re-assembled by hand (and potentially reformatted inconsistently) at the end of every conversation.

Call it with `decklist_text` (the `Commander` / blank line / `Deck` block — same format
`get_moxfield_decklist`'s `decklist_text` produces and `playtest_load_deck` parses), `deck_name`, and two
fields that require actual judgment about the deck and so are NOT computed by the tool itself:
- `wincon_summary` — combo-based if the deck has one (name the pieces + a turn-speed estimate, e.g.
  "Dramatic Reversal + Isochron Scepter, achievable turn 6 or earlier"), otherwise the deck's primary
  non-combo game plan.
- `general_strategy` — a short paragraph on how to actually pilot the deck turn to turn.

Internally, `deliver_finished_deck` runs `analyze_deck_consistency`, `rate_deck_bracket`, and
`get_deck_price_total` **unconditionally**, every time — not just "if a budget was mentioned" — via
shared `computeDeckConsistency`/`computeBracketRating`/`computeDeckPriceTotal` functions extracted so
the three standalone tools and this composite one never run divergent logic. If consistency comes back
with any issue (wrong card count, a singleton violation, an off-color card, something not
Commander-legal), the tool returns those issues instead of a delivery and deliberately does **not**
create a playtest table for a broken deck — fix the decklist and call it again. Only when the deck is
clean does it create the table (`playtest_create_table` with one human seat, one AI seat, labeled with
`deck_name`, never "Untitled table" — the AI seat auto-gets its own random EDHREC opponent deck and
opening hand) and load the built decklist into the human seat (`playtest_load_deck`'s same
resolve-deck + loadDeck + openingHand sequence), then assembles `final_delivery_text` in the fixed
order: decklist block, then a summary table (Price / Commander + color identity / Bracket Power / Combo
list / Wincon(s) / General strategy), then the `room_url`. `bracket.combos_found` in the response is
computed fresh inside this same call, so it may reveal a combo that wasn't accounted for when
`wincon_summary` was drafted — if the two disagree, rewrite `wincon_summary` and call again before
showing anything to the user, per the tool's own description.

Because this is the *final* gate, not the only check: still call `rate_deck_bracket` /
`get_deck_price_total` / `analyze_deck_consistency` individually (or just re-run
`deliver_finished_deck`) after any manual swap made *during* building, not only once at the very end —
this is a real, previously-hit failure mode: a decklist that started at $75 drifted to $135 after manual
swaps because nothing re-verified the total after the last edit, and a swap can just as easily break
singleton or color identity. Don't explain how to use the playtest table itself (no walkthrough of
controls or UI) in the final message — it's meant to be self-explanatory, and instructional text just
adds clutter here.

(Future, not for this pass: a paywall gate in front of the playtest link for non-paying users —
noted here as context for later planning, nothing to build against yet.)
