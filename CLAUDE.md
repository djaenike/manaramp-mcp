# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP (Model Context Protocol) server. `index.js` is now a thin sequencing layer (ESM, no build
step) — it just wires together focused modules under `sub-tools/`, grouped by concern rather than by
tool name. It runs over stdio and is spawned as a subprocess by Claude Desktop / Claude Code.

It exposes 8 tools:
- `new_deck_creation` / `existing_deck_cleanup` — build or validate a Commander (or other-format) deck,
  always ending in a full HTML report (see "Deck delivery pipeline" below). These are the two "deck
  building" tools the project was consolidated around, and each sequences several `sub-tools/` modules
  in turn rather than being one flat fetch-and-return handler.
- `search_cards` / `get_card_synergies` / `find_combos` / `get_card_script` — raw lookup tools exposed
  standalone specifically so Claude can call them repeatedly *while* reasoning about a decklist, before
  ever calling the two deck tools above: finding real candidates for a role via Scryfall search,
  checking a candidate has real EDHREC support in the deck's colors/theme, verifying a pairing is a
  genuine documented Commander Spellbook combo, and pulling Forge's structured script to disambiguate
  a tricky ability. This is what makes "pick the best cards, checking combos/pairing/pricing/Forge
  text" an actual capability rather than something the two deck tools' descriptions merely claimed —
  earlier revisions referenced these tools by name in `new_deck_creation`'s description without
  actually registering them, which meant Claude had no way to call them.
- `arena_draft_assistance` / `arena_draft_game_advice` — read MTG Arena's `Player.log` and resolve pack
  contents / match events to real card data for draft-pick and in-game advice.

Playtest-table integration (`extensions/playtest-table`, a companion Cloudflare Worker) and its 5
`sub-tools/playtest/*`-backed operations (list/create/get-state/load-deck/do-action) are **not** wired
into any of the 8 tools right now — deliberately. See "Playtest table (currently disabled)" below.
Nothing under `sub-tools/playtest/` or `extensions/` needs to change for that; the code is intact and
independently testable, it's just not called from `index.js`.

## Commands

```bash
npm install     # only setup step — plain JS, no build
node index.js   # or `npm start` — runs the server directly over stdio
```

There's a small `tests/` directory (plain `.mjs` scripts, no test runner/framework — run each directly
with `node tests/<file>.mjs`) that mocks `global.fetch` and imports real functions from `index.js` and
`sub-tools/` to check them in isolation, since a stdio server itself isn't meaningfully testable by just
running the file standalone (it blocks waiting on stdio and any output goes to a client, not the
terminal). Still true: the only way to validate a *tool's actual UX* (not just its logic) is to run the
server and exercise a tool through an MCP client (Claude Desktop/Code).

To connect a local checkout to Claude Desktop for manual testing, add to
`claude_desktop_config.json` (path in [readme.md](readme.md)):
```json
{ "mcpServers": { "scryfall": { "command": "node", "args": ["/absolute/path/to/index.js"] } } }
```
Restart Claude Desktop after any change to `index.js` or any `sub-tools/` file — it does not hot-reload.

## Architecture

Every tool follows the same shape: `server.tool(name, description, zodSchema, async handler)`, where the
handler sequences one or more `sub-tools/` functions and returns `{ content: [{ type: "text", text: ... }] }`
(MCP's required response envelope — always stringify JSON payloads into that one text field).

The tool descriptions passed to `server.tool(...)` are load-bearing, not cosmetic — they're what the
calling Claude model reads to decide when and how to use each tool, how to interpret caveats about a
data source's reliability, and (for the two deck tools) what to actually do with the response. When
editing a tool, keep the description accurate to its actual behavior and data-quality caveats, since
that's the only place this information reaches the model.

`sub-tools/` is organized by concern, not by tool:
- `scryfall/` — `client.js` (shared `HEADERS` + `scryfallFetch` — Scryfall rejects requests without an
  accurate User-Agent), `cards.js` (search/get/rulings — `searchCards`/`getCardByName` both include a
  `category` field, via `classify.js`, alongside the raw `type_line`), `classify.js` (pure, fetch-free
  `classifyCategory`/`isManaRock`/`isCardDraw`/`isRemoval` — lives at this base layer, not in
  `delivery/`, specifically so both the lookup tools and the final report share one classification
  instead of two drifting copies). Official, documented API, no key needed.
- `edhrec/` — `client.js` (`slugify()`, EDHREC's URL slug format — no fuzzy matching, an inexact slug
  404s), `recommendations.js` (`getCommanderRecommendations`, used internally by both deck tools for
  commander-fit context; `getCardSynergies`, exposed as the standalone `get_card_synergies` tool;
  `getAverageDecklist`, still not exposed anywhere). Unofficial, undocumented JSON endpoints
  reverse-engineered from edhrec.com's own frontend.
- `forge/card_script.js` — reads community rules-engine scripts live from Card-Forge/forge's GitHub raw
  file host (GPL-3.0), keyed by a guessed filename via `forgeFilename()`. Not verified against split
  cards, DFCs, or unusual punctuation; 404s should fall back to Scryfall oracle text. Exposed as the
  standalone `get_card_script` tool.
- `cardkingdom/pricing.js` — no developer API; fetches one large public pricelist JSON file and filters
  in memory. Numeric fields arrive from CK as strings and must be parsed. This server's standardized
  "real dollar price" source, distinct from Scryfall's bundled bulk-estimate price. `computeDeckPriceTotal`
  and `fetchPriceByNameMap` are the two entry points other modules reuse (deck delivery and the
  price-constrained builder, respectively) instead of re-fetching the pricelist per card.
- `spellbook/combos.js` — Commander Spellbook's official REST API (MIT licensed), but the exact query
  parameter (`q`) is inferred from a syntax guide rather than confirmed against live docs (their docs
  site blocks automated fetching). `findCombos` (the standalone `find_combos` tool, queried with an
  explicit AND across whatever card names are passed in) is the one exception to the next point — it's
  meant for a Claude-driven "do these specific cards combo" check, not a full-decklist scan.
  `classifyComboSpeed`/`findCombosInDeck` (used internally by `bracket/rating.js`, not exposed
  standalone) query **one card at a time** across the whole decklist — empirically confirmed that
  Spellbook's `or` keyword is accepted syntax but does NOT behave as boolean OR (two individually-valid
  single-card queries can combine via `or` into zero results), so don't reintroduce a batched-OR
  "optimization" there without re-verifying it against the live API first.
- `bracket/rating.js` (+ `reference_data.js`) — the Commander Bracket System classifier. Not a live data
  source: `GAME_CHANGERS`, `MASS_LAND_DENIAL_CARDS`, `EXTRA_TURN_CARDS` are hardcoded reference lists
  (Game Changers current as of the Feb 9, 2026 update, reviewed by the Commander Format Panel roughly
  every 3-4 months — re-verify against WotC's own list if a rating looks off). Combo detection reuses
  `spellbook/combos.js`.
- `deck-building/consistency.js` — not a separate upstream source: reuses the same Scryfall
  `/cards/collection` batch call (one fetch yields `cmc`, `type_line`, `color_identity`,
  `legalities.commander`, `mana_cost`, `oracle_text`, and an `image_url` for the whole decklist at once,
  the last three specifically so `delivery/report_data.js` doesn't need a second fetch). Checks deck
  size (100, commander(s) included), singleton (basic-land-ness read from the real `type_line`, not a
  hardcoded name list), color identity, and Commander legality — then computes a mana curve and a
  `curve_out_probability` (turns 1-6) via a hand-rolled hypergeometric helper (`combinations`/
  `hypergeometricAtLeast`, an iterative running product/division so a 99-card library never risks
  overflow). That probability is an explicitly SIMPLIFIED model (7-card opening hand + 1 draw/turn, no
  mulligans/scry/ramp/card-draw spells). Deliberately does **not** detect combos — that stays
  `bracket/rating.js`'s job, so the Commander-Spellbook-querying logic never has to live in two places.
- `deck-building/price_constrained_builder.js` (`buildDeckByPrice`) — pulls a commander's full EDHREC
  card pool, cross-references every candidate against Card Kingdom's pricelist, and greedily fills 99
  nonland slots by synergy-per-dollar under an *optional* price ceiling (no ceiling at all is a valid,
  common case — not exclusively a "budget" tool, hence the name; it replaced an earlier
  `budget_builder.js` that always required a hard budget, since removed). Explicitly a synergy-per-
  dollar optimizer, not a power-level/bracket classifier or combo-aware deckbuilder — it doesn't check
  curve, color balance, or land count on its own (that's why its output always goes through
  `analyze_deck_consistency`/`rate_deck_bracket` afterward).
- `deck-building/moxfield.js` — no official public API; hits the same undocumented
  `api2.moxfield.com/v2/decks/all/<deckId>` endpoint Moxfield's own frontend calls, which needs its own
  browser-like `MOXFIELD_HEADERS` (the shared Scryfall `HEADERS` User-Agent gets rejected here). **Known
  issue**: Moxfield's anti-bot protection sometimes 403s Node's `fetch()` outright even with a full
  realistic Chrome header set — points at TLS/transport-level fingerprinting, not anything header-content
  can fix. Shipped anyway with a clear 403 fallback message (paste decklist text directly instead)
  rather than chasing a fingerprint-spoofing arms race against Cloudflare's bot detection.
- `playtest/` (`client.js`, `state.js`, `lobby.js`, `actions.js`) — the playtest-table WebSocket
  protocol. `parsePlaytestDecklist` (in `state.js`) is the one function from here actually used by the
  live tools today (both deck tools use it to parse `Commander`/`Deck` sections). See "Playtest table
  (currently disabled)" below for the rest.
- `delivery/` — the deck report pipeline; see "Deck delivery pipeline" below. Also holds
  `create_playtest_room.js` (currently unused, see below).
- `arena-log/` (`log_reader.js`, `draft_log_parser.js`, `gre_match_parser.js`, `grpid_resolver.js`) —
  backs the two `arena_*` tools. `log_reader.js` tracks a byte offset per `player_log_path` so repeated
  calls only process new lines (Arena rewrites `Player.log` from scratch every launch — a size decrease
  is detected as a relaunch and resets state). `grpid_resolver.js` batches `arena_id:<id>` lookups
  through `scryfall/cards.js`'s `search_cards`-equivalent, confirmed live against Scryfall's search
  syntax. Only Premier/Quick Draft are implemented in `draft_log_parser.js` (not Traditional/Sealed).
  `gre_match_parser.js` only reports ANNOTATED, CONFIRMED events — an `ActionsAvailableReq` listing a
  legal option is never reported as something that happened, only an actual
  `ZoneTransfer`/`ObjectsSelected`/damage annotation is. Arena's own log records the human's actual
  pick confirmation the moment it happens in-client (`DraftScanner`'s `pickedCards`, populated by
  `parseHumanDraftPick`/`parseQuickPick`) — no separate "tell Claude what you picked" step is needed.
  **The pick-detection event names/shapes were wrong until they were corrected by reading two real,
  currently-maintained parsers directly** (not secondhand docs): 17Lands' own official client
  (`rconroy293/mtga-log-client`) and `manasight/manasight-parser` (which ships its own test fixtures
  against real log text). The earlier version, based on an archived community tool, listened for
  `Draft.MakeHumanDraftPick`/`request.params.{packNumber,pickNumber,cardId}` for Premier/Traditional
  picks — that event name doesn't exist in real logs; the real one is `EventPlayerDraftMakePick`,
  whose payload has been observed in three different shapes (top-level, under `PickInfo`, or
  string-escaped inside `request`), so `parseHumanDraftPick` checks all three. Quick Draft's picker
  had two separate bugs: an extra incorrect `.Payload` unwrap step (the pick-request side has no such
  wrapper, unlike the pack-status side, which does), and read a singular `CardId` when the real field
  is a `CardIds` array (whose first entry can legitimately be `0`, a "not resolved yet" sentinel to
  skip, not a real pick). The marker itself also now matches both `BotDraftDraftPick` and
  `BotDraft_DraftPick` — 17Lands' own client explicitly checks both forms since real logs have used
  either. See `tests/test_draft_pick_parsing.mjs` for fixtures built directly from those two
  reference parsers' own shapes. PACK parsing was not touched — no evidence surfaced that it's wrong.
  `arena_draft_assistance`'s handler in `index.js` resolves `pickedCards` through the
  same `resolveGrpIds` call as `currentPack` (one combined batch, since `resolveGrpIds` dedupes) and
  returns it as `picks_made` — an earlier revision only returned `pickedCards.length`, which made the
  actual pool invisible to Claude and made pool-aware picks (leaning into an emerging archetype,
  avoiding an over-drafted color) impossible; see `tests/test_arena_picks_resolved.mjs`. There is
  still no external pick-quality data source wired in anywhere (no 17Lands win rates, no tier list) —
  `draft_log_parser.js`'s header comment notes it borrowed 17Lands' *log format* knowledge from the
  open-source `MTGA_Draft_17Lands` project, deliberately not its rating data — so pick advice is
  Claude's own judgment over real oracle text/mana cost, not backed by aggregated draft-performance
  stats, UNLESS `card_ratings_csv_path` is supplied (see `card_ratings.js` below).
- `arena-log/card_ratings.js` — optional real win-rate/signal data for `arena_draft_assistance`,
  loaded from a card_ratings CSV the **user** manually exports from 17lands.com/card_ratings (a
  normal button on that page) — this server never calls 17lands.com itself. That distinction is
  deliberate: 17Lands' own usage guidelines discourage third parties from hitting their live
  site/API directly (rate-limited, new sets embargoed ~12 days, stated risk of countermeasures
  against abuse patterns) — that's exactly the pattern several archived/community MTGA draft tools
  use (confirmed by reading their source: a raw `urllib.request.urlopen` against
  `17lands.com/card_ratings/data?expansion=...`), and this repo deliberately does not replicate it.
  17Lands' own sanctioned alternative for programmatic use is their bulk `public_datasets` (raw
  per-game/per-pick CSVs, tens/hundreds of MB per set, requiring real aggregation to turn into
  per-card ratings) — a substantially bigger integration than a manually-exported snapshot;
  not built here. `parseCardRatingsCsv`/`loadCardRatings` hand-parse the export (quoted CSV, no
  dependency added) into a `Map<lowercased name, row>`; percentage/`pp` columns parse to numbers,
  blank cells (small sample size) parse to `null` — **null means no reliable data, not a bad card**,
  don't treat it as 0. `index.js` caches one loaded `Map` per `card_ratings_csv_path` (like
  `draftSessions`) and merges each pack/pick card's row onto it as `card_ratings_17lands` by exact
  name match (lowercased) — no fuzzy matching, so a 17Lands name that doesn't exactly match
  Scryfall's (rare, but possible for reprints/promos) silently returns `null` there. See
  `tests/test_card_ratings_csv.mjs`.

`index.js` keeps its own per-`player_log_path` session maps (`draftSessions`/`matchSessions`) so the two
Arena tools' offset/state persists *across* separate tool calls within one running server process (each
pick / each poll is its own MCP call).

## Deck delivery pipeline

Both deck tools funnel through a shared `runChecksAndDeliver` (defined in `index.js`, not tucked into
`sub-tools/`, specifically so the full check → build report → render sequence stays visible in one
place) after they've resolved a `decklist_text` (auto-built, pasted, or fetched from Moxfield):

1. Parse `Commander`/`Deck` sections via `playtest/state.js`'s `parsePlaytestDecklist`. If that fails
   entirely (no commander or no deck found at all), return immediately — there's nothing coherent to
   report on.
2. Run `computeDeckConsistency`, `computeBracketRating`, and `computeDeckPriceTotal` in parallel
   (`Promise.all` — this is the one place in the file that pattern is used instead of a single `fetch`).
3. `delivery/report_data.js`'s `buildActualOutput(...)` assembles the full `actualOutput` contract
   defined in `delivery/deck_report_template.json` (the canonical shape reference — read it before
   changing this pipeline's output fields) from those three results: full per-card list (name/qty/
   category/price/image/mana cost/oracle text — category via `classifyCategory(typeLine)`; mana-rock/
   card-draw/removal counts are oracle-text-keyword HEURISTICS, not real Scryfall fields, and will miss
   edge cases), category counts, `manaCurve`/`curveOutProbability` (passed through verbatim from
   `computeDeckConsistency`'s `mana_curve`/`curve_out_probability` — the report's actual "make sure
   mana makes sense" surface), the Moxfield-import string, and a `bracketLevelMatchesRequest` flag
   (compares bracket *numbers* extracted from both strings, since e.g. "Bracket 3" vs "Upgraded (3)"
   don't share text otherwise). Card images stay plain Scryfall `https://` URLs here — **do not**
   base64-inline them by default (see the file's own header comment): a previous revision called
   `scryfall/images.js`'s `inlineCardImages` here to embed every card's image, and it broke real
   decks — the MCP tool response (this JSON, plus `html_report` embedding a second copy of it) has a
   hard client-enforced size cap (observed ~1MB), and ~90 inlined images alone already blow past that.
   Measured: the same ~100-card `actual_output` payload is ~38KB with plain image URLs vs. >1.6MB
   inlined. `inlineCardImages` still exists and works, for the separate case of manually re-embedding
   images before publishing the rendered HTML as a shareable web Artifact elsewhere (not subject to
   the MCP tool-result cap) — it's just not called by this default pipeline.
4. `delivery/html_renderer.js`'s `renderDeckReportHtml(...)` loads `delivery/deck_report_template.html`
   from disk and does the templating **server-side** — swaps its placeholder `DECK_DATA` for the real
   `{ userDefinedScope, actualOutput }` via an anchored string replace, and strips the file's own
   "boilerplate reference only" comment. This is deliberate: the calling Claude model is NOT expected to
   reconstruct the report from the template each time (that would risk drift/bugs) — the MCP renders one
   complete HTML string (`html_report`) instead.
5. `index.js`'s `writeReportFile(deck_name, htmlReport)` also saves that same HTML to `reports/`
   (gitignored, resolved next to `index.js` via `import.meta.url` so it's stable regardless of cwd) and
   returns the path as `report_path`. This is the *primary* way a user actually views the report: opening
   `report_path` in a real browser has no CSP restriction, so the plain Scryfall image URLs above load
   normally there — unlike a claude.ai/Code Artifact, which is why the tool descriptions tell Claude to
   surface `report_path` to the user rather than only relying on `html_report` being published as one. A
   filesystem failure here returns `report_path: null` rather than failing the whole delivery — the
   in-response `html_report` string is the fallback.

There is **no pass/fail gate** here. A decklist that parses always gets a full report, even with
consistency issues — `deck_report_template.html` has a built-in issue banner for exactly that case
(renders when `actualOutput.consistencyIssues` is non-empty), so surfacing problems in the delivered
report is more useful than refusing to deliver one. Re-run the relevant deck tool after any manual card
swap made *during* building, not only once at the very end — a swap can silently break price, singleton,
or color identity, and nothing else re-checks it.

If `delivery/deck_report_template.html`'s structure changes (new sections, renamed the `DECK_DATA`/
`renderDeckReport` anchor, etc.), `html_renderer.js`'s anchors must be updated to match — it throws a
clear error rather than silently falling back to the file's own placeholder example data if the anchors
don't match.

## Playtest table (currently disabled)

`extensions/playtest-table` (SvelteKit + Cloudflare Durable Objects, deployed as a real Cloudflare
Worker) and `sub-tools/playtest/*` are untouched and fully intact, but **not called from any of the 4
tools right now** — the playtest server needs more work, and the current focus is the core MCP
structure/delivery pipeline. `delivery/create_playtest_room.js` (the room-creation + deck-load glue)
still exists and works standalone but is not imported by `index.js`.

Re-enabling it later is a small, localized change: import `createPlaytestRoom` in `index.js` and add a
step to `runChecksAndDeliver` after report-building (e.g. threading a `room_url` into `actualOutput`/the
rendered HTML) — the rest of the pipeline's shape is unaffected. See `extensions/README.md` for the full
autonomous-play design (an AI-controlled seat's turns are driven by the Worker's own Durable Object alarm
calling the Anthropic API directly, not by this MCP server or any Claude conversation) if/when that work
resumes.

(Future, not for this pass: a paywall gate in front of the playtest link for non-paying users, once
playtest is re-enabled — noted here as context for later planning, nothing to build against yet.)
