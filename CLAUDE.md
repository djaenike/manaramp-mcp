# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP (Model Context Protocol) server, entirely in `index.js` (~540 lines, ESM, no build step, no
tests, no lint config). It runs over stdio and is spawned as a subprocess by Claude Desktop / Claude Code.
It exposes 10 tools that let Claude reason over live Magic: The Gathering data instead of guessing from
training data.

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

## Known issue

`SCRYFALL_BASE` is referenced in `search_cards`, `get_card_by_name`, and `get_rulings` (index.js:77,
120, 154) but is never declared anywhere in the file — only `EDHREC_BASE`, `FORGE_RAW_BASE`,
`CARDKINGDOM_PRICELIST_URL`, and `COMMANDER_SPELLBOOK_BASE` are defined. Calling any of those three
Scryfall tools currently throws a `ReferenceError`. If you touch any Scryfall-backed tool, add the missing
`const SCRYFALL_BASE = "https://api.scryfall.com"` alongside the other base-URL constants near the top of
the file.
