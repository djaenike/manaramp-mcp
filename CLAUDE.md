# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP (Model Context Protocol) server, written in TypeScript (built with `tsup`, run over stdio,
spawned as a subprocess by Claude Desktop / Claude Code). As of the 2026-09 TypeScript conversion, the
code is split into three layers under `src/`:

- `src/sub-tools/` — focused modules grouped by concern (unchanged in spirit from before, just `.ts`
  now), each exporting plain, reusable functions with no MCP-specific wrapping. See the per-directory
  breakdown below.
- `src/tools/` — one file per registered tool (or, for the two deck-building tools, one shared file),
  each exporting a plain object — `{ name, description, inputSchema, handler }` — rather than calling
  `server.tool(...)` itself. `src/tools/index.ts` barrels all 8 into a `tools` array. This is the
  package's `"."` export (see `package.json`'s `exports` map): `import { tools } from 'manaramp-mcp'`
  gets just these definitions, with zero local-machine/stdio code pulled in.
- `src/local/index.ts` — the stdio bootstrap (was `index.js`). Imports `tools` from `../tools/index.js`
  and registers each with `server.tool(...)`, plus owns everything genuinely local-machine-only:
  writing the rendered HTML report to the user's Downloads folder, connecting `StdioServerTransport`.
  This is the package's `"./local"` export and what `npm start`/the `.mcpb` manifest actually run.

**Why the split**: the eventual goal (a separate, later phase — not built yet, and not started by this
conversion) is a remote MCP endpoint in the sibling `manaramp` Cloudflare Workers repo that imports the
SAME tool definitions this local stdio server uses, via `import { tools } from 'manaramp-mcp'`. This
conversion pass only does the TypeScript conversion + `tools/`/`sub-tools/`/`local/` restructuring
needed to make that possible later — it does **not** build the remote transport, add an API-key/auth
schema, or touch the `manaramp` repo. Two of the 8 tools (`arena_draft_assistance` /
`arena_draft_game_advice`) are fundamentally local-machine-only forever (they read a real
`Player.log` file) and will never be part of what a future remote transport imports, even though
they're still present in the `tools` array for completeness — see
`src/tools/shared/arena-local-state.ts`'s header comment.

**This section describes the 2026-09-12 TypeScript-conversion-era design (8 tools, HTML reports,
playtest-table glue). It's since been superseded twice over -- see "Remote MCP + Mongo" and the
consolidation pass right below it for what's actually true today (8 DIFFERENT tools: 5 query_*, 2
push_*, 1 manage_deck; no HTML reports; no playtest code left at all). Kept for history/context on
HOW it got here, not as a description of current behavior.**

It originally exposed 8 tools: `new_deck_creation`/`existing_deck_cleanup` (build/validate a
Commander deck, ending in a full HTML report), `search_cards`/`get_card_synergies`/`find_combos`/
`get_card_script` (raw lookups, live Scryfall/EDHREC/Commander Spellbook/Forge), and
`arena_draft_assistance`/`arena_draft_game_advice` (Player.log parsing). Playtest-table integration
(`sub-tools/playtest/*` -- list/create/get-state/load-deck/do-action) was never wired into any of
them. This repo used to also hold the playtest-table frontend/Worker itself, at
`extensions/playtest-table` (SvelteKit + Cloudflare Durable Objects); as of 2026-09-12 that Worker
lives in the sibling `manaramp` repo, and the local MCP-side glue (`sub-tools/playtest/*`) was fully
removed once its last real caller (`parsePlaytestDecklist`, moved to
`sub-tools/deck-building/decklist-parser.ts` and renamed `parseDecklistText`) was the only thing
left in it.

## Remote MCP + Mongo (2026-09-17, current design)

**Every tool queries or writes manaramp's own MongoDB data now -- there is NO live Scryfall/
EDHREC/Commander Spellbook/Card Kingdom/Forge/Moxfield API call anywhere in this repo anymore**,
including the two Arena tools (their last live dependency, Scryfall's `arena_id:` search, was
removed in a later pass the same day -- `sub-tools/scryfall/client.ts` no longer exists). If a
comment anywhere still describes a tool hitting a live API directly, that's describing an OLD,
already-replaced design -- the source of truth for what each sub-tool actually does is its own
file header and this section.

**UPDATED 2026-09-22 -- `manage_deck` in this section is stale, describing a design already
superseded twice over before this update (see tools/index.ts's own header for the real, current
history: manage_deck -> optimize_deck/publish_deck/read_deck (2026-09-18) -> validate_and_submit/
read_deck plus a new format_guidelines tool (2026-09-22, replacing optimize_deck/publish_deck --
real feedback was that deck building leaned too combo-oriented)). tools/index.ts's header is the
source of truth for the current tool list; kept below for history/context on the auth/transport
architecture, which hasn't changed.**

**Two disjoint tool sets** (`tools/index.ts`):
- `tools` (registered ONLY by manaramp's
  remote `/mcp` endpoint (`src/routes/mcp/+server.ts` in the sibling `manaramp` repo), which imports
  this package's `.` export and runs these handlers IN-PROCESS inside its own Cloudflare Worker
  request, passing an already-open `Db` straight into each handler's second `ctx` argument
  (`tools/types.ts`'s `McpContext`). Mongo credentials never leave that Worker -- this package has
  `mongodb` as a dependency for its TYPES only and never opens a `MongoClient` anywhere in its own
  code.
- `localTools` (8) -- registered by `local/index.ts` (the `.mcpb`/`npm start` path): the 2
  genuinely local-only Arena tools (`arena_draft_assistance`, `arena_draft_game_advice` -- read a
  real local `Player.log` file, a Worker can't) PLUS remote-proxied versions of the 6 non-push
  tools (via `tools/shared/remote-proxy.ts` -- same name/description/schema, but the handler calls
  `manaramp.com/mcp` over HTTP instead of touching a `Db`). This makes the `.mcpb` a complete,
  self-sufficient server on its own -- deck building AND Arena assistance from one Claude Desktop
  install, no separate remote connector needed. `push_game_log`/`push_draft_result` aren't proxied
  for local use -- they're internal side effects the Arena tools call themselves over HTTP (see
  below), not something the calling model invokes directly.

**Auth is mandatory, not optional**: manaramp's `/mcp` route requires
`Authorization: Bearer <api key>` on every request, resolved against manaramp's `api_keys`
collection (one per account, generated automatically at signup). There is no anonymous/unowned
call path -- `manage_deck` always knows which account is calling, so decks are owned from creation
(no claim-later flow -- see manaramp's `src/lib/server/schema/decks.ts`). The Arena tools' own
remote calls use the SAME auth, via `MANARAMP_API_KEY` -- injected by Claude Desktop from
`manifest.json`'s `user_config.manaramp_api_key` (`sensitive: true`, stored in the OS keychain,
never baked into the distributed `.mcpb` itself). Both Arena integrations degrade gracefully with a
clear message in the response if no key is configured.

**Tool consolidation, round 1** (same day): `new_deck_creation`/`existing_deck_cleanup` merged into
one `manage_deck` tool. `get_card_script` was retired -- `search_cards`' own `abilities`/
`oracle_text` fields already covered what it disambiguated. **Moxfield import was removed entirely**
(`getMoxfieldDecklist`/`moxfield_url` -- gone; a pasted Moxfield text export is just `decklist_text`
now; exporting a manaramp deck TO Moxfield's format is a client-side button on the deck page
instead, in the `manaramp` repo, not an MCP concern).

**Tool consolidation, round 2** (`fourth pass`, same day -- see git history for "round 1" if the
names below look unfamiliar): renamed everything to a consistent `query_*`/`push_*`/`manage_*`
scheme (`search_cards` -> `query_cards`, `get_card_synergies` -> `query_synergies`, `find_combos`
-> `query_combos`), and added two brand-new read-only tools -- `query_decks` and
`query_draft_results` -- so there's exactly one query tool per Mongo collection this repo touches
(cards, commander_synergies via query_synergies, combos, decks, draft_results). The bigger change:
**dropped every piece of server-side "recommendation" logic**, leaving only deterministic fact-
gathering + persistence:
- `sub-tools/deck-building/price_constrained_builder.ts` (the auto-build-by-price greedy knapsack)
  was DELETED. `manage_deck` no longer accepts `commander_name`/`price_limit_usd` at all --
  `decklist_text` is the only way in now, built by the calling model itself via `query_cards`/
  `query_synergies`/`query_combos`.
- `sub-tools/bracket/rating.ts` (computeBracketRating -- a rules decision tree producing a
  "Bracket 3" label + prose) was replaced by `sub-tools/bracket/facts.ts`'s `gatherDeckFacts`, which
  only returns raw facts (game changers/mass land denial/extra turns present, combos assembled).
  `manage_deck` gained a `bracket_estimate` INPUT field instead -- the calling model judges the
  actual bracket from those facts (typically on a FOLLOW-UP call, once it's seen them) and supplies
  it, same pattern `wincon_summary`/`general_strategy` always used.
- `sub-tools/spellbook/combos.ts` unified `findCombos` (small candidate list) and
  `findCombosInDeck`+`classifyComboSpeed` (full decklist) into ONE `findCombos(db, names, limit?)`
  -- "which combos are fully assembled in this list" is a strict superset of "do these 2 cards
  combo," so one query now covers both `query_combos`'s per-pairing use and `gatherDeckFacts`'s
  full-decklist use.

**No HTML report anymore** (part of round 1): `manage_deck` persists directly and returns a compact
JSON summary plus `deck_url` (a real, permanent `manaramp.com/decks/<slug>` link) -- that page (in
the `manaramp` repo) is the actual deliverable now. This deleted the entire `sub-tools/delivery/`
report-generation code and `tools/shared/run-checks-and-deliver.ts`.

**Arena tools' remote calls, concretely**:
- `arena_draft_assistance` resolves every grpId in the current pack/pick history via
  `resolveGrpIdsViaManaramp` (`tools/shared/arena-local-state.ts`) -- one batched remote
  `query_cards` call per invocation (`arena_grp_ids: number[]` filter, matching against
  `cards.arena_grp_ids`), replacing the old per-id live Scryfall lookup entirely. Every resolved
  card carries a real `format_stats` array (17Lands data straight from Mongo -- the old manual
  card_ratings CSV drop-in mechanism was removed the same day, fully superseded). It also pushes
  this draft's accumulated picks + full pack-options history to `push_draft_result` on EVERY call
  (see `draft_result_pushed`/`draft_result_push_error` in the response) -- there's no clean "draft
  finished" signal, so it just keeps upserting the same doc (keyed by Arena's own `draftId`, now
  tracked by `DraftScanner`).
- `arena_draft_game_advice` resolves timeline grpIds the same way (via `enrichTimeline`), and pushes
  the full match log to `push_game_log` the moment a `matchResult` event appears (see
  `pushed_game_log_id`/`push_error`).
- `grpid_resolver.ts`'s contract changed to match: `resolveGrpIds`/`enrichTimeline` now take a
  single `BatchResolveFn` -- `(grpIds: number[]) => Promise<Map<number, card>>` -- instead of a
  per-id `searchCardsFn(query: string)`, so one call resolves a whole batch instead of N.

**`resources/` folder deleted**: held two real `Player.log` fixture files and a markdown notes file
from when the parser was being reverse-engineered against real log samples -- nothing imported any
of it. `sub-tools/arena-log/` is the one place to look for log-parsing behavior now.

**Correction (2026-09-17, checked Atlas directly)**: `MONGODB_READWRITE_URI`'s Atlas role is
`readWriteAnyDatabase` -- broad, NOT scoped to `decks`/`game_logs` at the database level the way
several comments across both repos previously claimed (see `manaramp`'s
`src/lib/server/queries/db.ts`). No Atlas change was or is needed for `push_draft_result`'s writes
to `draft_results` -- they already work today. The decks/game_logs/draft_results boundary is an
application-code convention (this credential is only ever USED for those collections), not
something Atlas itself enforces.

## Commands

```bash
npm install       # setup
npm run build     # tsup: compiles src/ -> dist/ (mirrors src/'s folder structure 1:1, no bundling —
                   # see tsup.config.ts's header comment for why)
npm start         # node dist/local/index.js — runs the BUILT server over stdio
npm run dev       # tsx src/local/index.ts — runs the server straight from source, no build step
npm run typecheck # tsc --noEmit
```

**No `tests/` folder** (removed 2026-09-17, fifth pass, per explicit direction -- "we shouldn't need
to do tests and save them as files to bloat the repo"). It used to hold plain `.mjs` scripts
(no framework) exercising Arena log parsing, the grpId disk cache, settings persistence, and the
batch grpId resolver contract in isolation with fake data. The one way to validate a *tool's actual
UX* now (not just its logic) is to run the server and exercise a tool through a real MCP client
(Claude Desktop/Code) -- which was already true even when the test files existed, since a stdio
server isn't meaningfully testable by just running a file standalone (it blocks waiting on stdio,
output goes to a client, not the terminal).

To connect a local checkout to Claude Desktop for manual testing, add to
`claude_desktop_config.json` (path in [readme.md](readme.md)):
```json
{ "mcpServers": { "manaramp": { "command": "node", "args": ["/absolute/path/to/dist/local/index.js"] } } }
```
Run `npm run build` after any change to `src/` — Claude Desktop spawns the **built** `dist/local/index.js`,
which does not hot-reload or auto-rebuild.

## Architecture

Every tool is a plain object under `src/tools/` — `{ name, description, inputSchema, handler }` (the
same `name`/`description`/zod-raw-shape/`async handler` that used to be positional arguments to
`server.tool(...)` directly) — where the handler sequences one or more `functions/` functions and
returns `{ content: [{ type: "text", text: ... }] }` (MCP's required response envelope — always
stringify JSON payloads into that one text field). `src/local/index.ts` is the only place that actually
calls `server.tool(...)`, looping uniformly over `src/tools/index.ts`'s `tools` array:
`for (const tool of tools) server.tool(tool.name, tool.description, tool.inputSchema, tool.handler)`.

The tool descriptions passed to `server.tool(...)` are load-bearing, not cosmetic — they're what the
calling Claude model reads to decide when and how to use each tool, how to interpret caveats about a
data source's reliability, and (for `manage_deck`) what to actually do with the response. When
editing a tool, keep the description accurate to its actual behavior and data-quality caveats, since
that's the only place this information reaches the model.

**This bullet list described the pre-2026-09-17 `sub-tools/` layout (scryfall/edhrec/forge/
cardkingdom/spellbook/bracket/deck-building/playtest/delivery, each hitting a live external API).
That's gone -- see "Remote MCP + Mongo" above for the current design. What's actually there now,
under `src/functions/` (flat, collection-named, not tool-named -- see that section's tool-
consolidation notes for the full history of each rename/merge):**
- `functions/cards.ts` -- `queryCards`, the ONE place `cards` gets queried. Every other function
  that needs card data (deck-validation, combos' cmc lookup, decks' oracle_id resolution,
  draft-results' grpId resolution) calls this instead of running its own query.
- `functions/synergies.ts` -- `querySynergies`, queries `commander_synergies` (commander-keyed).
- `functions/combos.ts` -- `queryCombos`, queries `combos`; calls `queryCards` for cmc/speed
  classification rather than its own separate cards lookup.
- `functions/decks.ts` -- `getDeckDoc`/`queryDeckList`/`queryDeckDetail`, reads from `decks`; calls
  `queryCards` (oracle_ids filter) for card resolution.
- `functions/draft-results.ts` -- `queryDraftResultList`/`getDraftResultDoc`/`queryDraftResultDetail`,
  reads from `draft_results`; calls `queryCards` (arena_grp_ids filter) for pick/pack resolution.
- `functions/deck-validation.ts` -- `validateDeck`, PURE (no `db` param, no Mongo access of its
  own) -- takes an already-queried `CardSummary[]` (from `queryCards`, fetched once by whichever
  tool needs it) plus commander/deck-entry names, returns consistency issues, mana curve, and
  curve-out probability (a hand-rolled hypergeometric helper, `combinations`/`hypergeometricAtLeast`
  -- an iterative running product/division so a 99-card library never risks overflow; the
  probability itself is an explicitly SIMPLIFIED model: 7-card opening hand + 1 draw/turn, no
  mulligans/scry/ramp/card-draw spells).
- `functions/bracket-facts.ts` (+ `bracket-reference-data.ts`) -- `gatherDeckFacts`, raw facts only
  (game changers/mass land denial/extra turns present, combos assembled) -- no bracket-tier
  decision, that's the calling model's job now (see manage-deck.ts's `bracket_estimate` input).
  `GAME_CHANGERS`/`MASS_LAND_DENIAL_CARDS`/`EXTRA_TURN_CARDS` are hardcoded reference lists (Game
  Changers current as of the Feb 9, 2026 update, reviewed by the Commander Format Panel roughly
  every 3-4 months -- re-verify against WotC's own list if something looks off).
- `functions/decklist-parser.ts` -- `parseDecklistText`, pure text parsing (Commander/Deck section
  headers, `<qty> <name>` lines) -- no Mongo, no external calls.
- `functions/arena-log/` (`log_reader.ts`, `draft_log_parser.ts`, `gre_match_parser.ts`,
  `grpid_resolver.ts`, `settings.ts`) —
  backs the two `arena_*` tools. `log_reader.ts` tracks a byte offset per `player_log_path` so repeated
  calls only process new lines (Arena rewrites `Player.log` from scratch every launch — a size decrease
  is detected as a relaunch and resets state). `grpid_resolver.ts` batches `arena_id:<id>` lookups
  through `scryfall/cards.ts`'s `search_cards`-equivalent, confirmed live against Scryfall's search
  syntax. `resolveGrpIds` takes an optional `{ cache }` (a plain `Map`) to read/write through and
  returns `{ cards, errors }` (not a bare `Map` — `errors` is grpId → the actual failure message,
  for whatever was looked up *this call*). `src/tools/shared/arena-local-state.ts` keeps one
  `grpIdCardCache`, shared by BOTH Arena tools (a grpId always maps to the same real card, so this is
  safe across different drafts/games/log paths, not just within one) — a confirmed miss is cached too,
  since a genuine 404 (e.g. a special-art land print Scryfall's `arena_id` field has no entry for)
  won't resolve differently on a retry. This cache is **disk-persisted**, not just in-memory:
  `loadGrpIdCache`/`saveGrpIdCache` read/write `card_cache/grpid_cache.json` at the PACKAGE ROOT (via a
  fixed upward walk from `arena-local-state.ts`'s own compiled location, documented in that file's
  header comment — same effective location `CARD_RATINGS_DIR` resolves to) — same "flat file until you
  set up SQL" stopgap as
  `card_ratings/`, deliberately, and likewise tracked in git rather than ignored, since unlike
  `card_ratings.csv`'s evolving win-rate snapshot, a grpId→card mapping is a permanent fact that
  only ever gets more valuable to keep). `withPersistentGrpIdCache(...)` wraps both Arena tools'
  resolve calls and writes the file back ONLY when the cache actually grew (no disk I/O on a call
  that resolved nothing new). This closes a real bug found via a live draft session: without any
  cache at all, `arena_draft_assistance` re-resolved the ENTIRE pick history from scratch on every
  single call, so cost (and latency — reported as ~1 min per call by Pack 3) grew without bound as
  the draft went on; the resulting burst of concurrent Scryfall requests is also what exposed the
  `scryfallFetch` pacing race described above, causing a handful of grpIds that resolve fine in
  isolation (confirmed by testing them live afterward) to fail intermittently mid-draft. An
  in-memory-only cache would have fixed that within one running server process, but silently
  reset on any restart (computer reboot, Claude Desktop fully quitting, a crash) — hence disk
  persistence, not just a module-level `Map` -- empirically verified both that a cache reused
  within one process avoids re-resolving, and that it survives a fresh process (disk-backed).
  Only Premier/Quick Draft are implemented in `draft_log_parser.ts` (not Traditional/Sealed).
  `gre_match_parser.ts` only reports ANNOTATED, CONFIRMED events — an `ActionsAvailableReq` listing a
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
  either. PACK parsing was not touched — no evidence surfaced that it's wrong.
  `arena_draft_assistance`'s handler in `src/tools/arena-draft-assistance.ts` resolves `pickedCards`
  through the same `resolveGrpIds` call as `currentPack` (one combined batch, since `resolveGrpIds`
  dedupes) and returns it as `picks_made` — an earlier revision only returned
  `pickedCards.length`, which made the actual pool invisible to Claude and made pool-aware picks
  (leaning into an emerging archetype, avoiding an over-drafted color) impossible. Real win-rate/
  signal data (17Lands' `format_stats`) comes from manaramp's own database now via the remote
  `query_cards` call (`resolveGrpIdsViaManaramp` -- see "Remote MCP + Mongo" above), not a manually-
  exported CSV -- the `arena-log/card_ratings.ts` CSV-parsing module this bullet used to describe
  was deleted 2026-09-17 once that remote lookup fully superseded it.

`src/tools/arena-draft-assistance.ts` and `src/tools/arena-draft-game-advice.ts` each keep their own
per-`player_log_path` session map (`draftSessions`/`matchSessions` respectively, one module-level `Map`
per file) so the two Arena tools' offset/state persists *across* separate tool calls within one running
server process (each pick / each poll is its own MCP call).

Both Arena tools' `player_log_path` param is **optional**, backed by `functions/arena-log/settings.ts`
(`loadSettings`/`saveSettings`, a generic path-keyed JSON store — deliberately generic, not
Arena-specific, so it's reusable for any future "remember this on disk" need) writing to
`arena_settings.json` at the package root (gitignored — it's a real absolute path on the user's specific
machine, unlike `card_cache/`, which is portable and tracked). `resolvePlayerLogPath`
(in `src/tools/shared/arena-local-state.ts`, imported by both Arena tool files) is the glue: an
explicitly-given path always wins and gets saved; an omitted one falls back to whatever was last
remembered. This fixes a real, reported annoyance — Claude has no memory of a *prior conversation's*
tool-call arguments, so without server-side persistence the user had to retype the same path every
single new conversation, even the day right after already giving it once -- empirically verified that
a saved value survives a fresh load, simulating exactly that. `arena-local-state.ts` is deliberately
kept under
`tools/` (not `local/`) despite being a real filesystem/local-machine concern — see that file's own
header comment for why: it's shared state the two ALREADY-permanently-local-only Arena tools both need
(a grpId resolved during a draft must still be cache-hit during that match's game-advice calls), and
keeping it there avoids awkwardly injecting it through `local/index.ts`'s otherwise-uniform, flat
tool-registration loop.

## Deck delivery pipeline (REMOVED -- historical only)

`runChecksAndDeliver`, `delivery/report_data.ts`, `delivery/html_renderer.ts`,
`delivery/deck_report_template.html`/`.json`, and `scryfall/images.ts` are all DELETED
(2026-09-17). `manage_deck` (see "Remote MCP + Mongo" above) does the same consistency/bracket-
facts/price computation, but returns a compact JSON summary instead of rendering an HTML report --
there's no local file write, no template, no `report_path`/`html_report` anymore. The actual
deliverable is the persisted deck's `manaramp.com/decks/<slug>` page (in the `manaramp` repo) now.

## Playtest table (REMOVED -- historical only)

The playtest-table Worker itself moved to the sibling `manaramp` repo back on 2026-09-12 (see "What
this is" above). The MCP-side glue that stayed behind (`sub-tools/playtest/*`,
`delivery/create_playtest_room.ts`) was never wired into any registered tool, and was fully DELETED
on 2026-09-17 once `parsePlaytestDecklist` -- the one piece of it still actually used -- was moved
to `functions/decklist-parser.ts` (renamed `parseDecklistText`). There is no "re-enable" path
anymore; reviving playtest functionality here would mean rebuilding this glue from git history, not
flipping a flag.
