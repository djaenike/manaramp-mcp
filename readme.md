# ManaRamp MCP (local, stdio)

A local MCP server for Magic: The Gathering deck building, card research, and MTG Arena play
assistance. Runs locally over **stdio** — Claude Desktop spawns it as a subprocess, no hosting
required.

## Setup (plain JS — no build step)

```bash
npm install
```

That's it — `index.js` runs directly with Node (v18+, for native `fetch`).

## Connect it to Claude Desktop

Edit Claude Desktop's config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "manaramp": {
      "command": "node",
      "args": ["/absolute/path/to/manaramp-mcp/index.js"]
    }
  }
}
```

Restart Claude Desktop. You should see "manaramp" listed as an available tool source
(usually a small hammer/tools icon in the chat input). Claude can now call:

## The 8 tools

**Deck building (Commander-oriented, but works for any format):**

- `new_deck_creation` — build a new deck. The good path: Claude picks real cards using the lookup
  tools below (a commander that fits what you asked for, removal/ramp/draw that actually exists in
  your colors, combos it's actually verified, not just guessed at) and assembles the decklist itself.
  There's also a quicker fallback — give just a commander name (optionally with a USD ceiling) and it
  auto-fills the other 99 slots by EDHREC synergy-per-dollar alone, with no combo or curve awareness —
  but that's meant for a fast first draft, not the finished product. Either way, it validates the
  result (deck size, singleton, color identity, Commander legality), rates its power level against the
  official Commander Bracket System, checks its real dollar total, and hands back a complete HTML
  report.
- `existing_deck_cleanup` — the same validation/rating/pricing pipeline, but for a deck you already
  have: paste a decklist, or hand it a Moxfield URL to fetch one directly. Doubles as a cleanup
  punch-list (any consistency issue found shows up as a fix in the report) and returns EDHREC
  recommendations for the commander as improvement ideas. Ask for a change ("more removal," "cut this
  card") and Claude uses the same lookup tools to find and verify a real replacement, then re-runs this
  tool for a fresh report — building and editing are the same exercise.

Both of these **always** return a finished HTML report — Claude will present that directly rather than
retyping a summary, and it's also saved to a local file (`report_path` in the tool's response, next to
where this server is installed) that you can open directly in a browser. Opening the saved file is the
more reliable way to see it: card images are plain Scryfall links rather than embedded (keeps the tool
response itself small), and those load normally in a real browser tab but won't necessarily render if
the raw HTML is instead published somewhere with tighter content restrictions. If something's
structurally wrong with the deck (wrong card count, an off-color card, etc.) the report still
generates, with the problem flagged in an in-report banner instead of refusing to deliver anything.

**Card research (what the two deck tools above lean on Claude to use while actually picking cards,
rather than working from training data alone):**

- `search_cards` — Scryfall search syntax (`c:red t:creature cmc<=2`, `o:"draw a card"`, etc.) for
  finding real candidates for a role. Each result includes a plain `category` (Creature/Instant/
  Sorcery/Enchantment/Artifact/Planeswalker/Land/Other) alongside the full type line, plus a fast
  bulk-estimate `usd` price (not the real dollar figure the deck tools use for the final total, just a
  quick sanity check).
- `get_card_synergies` — EDHREC's synergy data for one card: what else typically gets played alongside
  it, plus any combos EDHREC itself flags. Use it to check a candidate actually has support in the
  deck's colors/theme, not just that it's good on its own.
- `find_combos` — real, documented combos from Commander Spellbook for a set of card names (queried
  together, not one at a time). Use it to verify a pairing is a genuine combo before building around
  it, not just something EDHREC calls "high synergy."
- `get_card_script` — a card's structured rules-engine script from the open-source Forge project, for
  disambiguating a tricky ability (tap-cost vs. attack trigger vs. ETB, etc.) beyond what oracle text
  makes clear.

**MTG Arena play assistance** (requires "Detailed Logs (Plugin Support)" enabled in Arena's settings,
and a full relaunch of Arena after enabling it):

- `arena_draft_assistance` — reads your current Premier/Quick Draft pack straight from Arena's
  `Player.log` and resolves every card in it to real card data (name, mana cost, oracle text) so Claude
  can help you make the pick. Also returns everything you've picked so far this draft (Arena's own log
  records that automatically — you don't need to tell Claude what you picked), so it can reason about
  your emerging colors/archetype, not just the current pack in isolation. Call it again after each pick
  to see the next pack. Optionally pass `card_ratings_csv_path` pointing at a card_ratings CSV you
  export yourself from 17lands.com/card_ratings for real win-rate and signal-reading data alongside
  the card text (see Notes below) — without it, pick advice is Claude's own judgment over the real
  card text/mana cost.
- `arena_draft_game_advice` — reads match events from `Player.log` as a game plays out and returns a
  turn-by-turn timeline (land plays, spells cast, attacks, damage, life changes) with every card
  resolved to its real name and text, so Claude can help you think through in-game decisions.

Neither Arena tool tells you what to do on its own — they supply real, structured data for Claude to
reason over.

## Try it

Ask Claude Desktop something like:

> "Build me a new Commander deck around Edgar Markov, vampire tribal, budget around $150."

Claude will call `new_deck_creation`, which pulls EDHREC's synergy data for Edgar Markov, cross-checks
prices against Card Kingdom, assembles a full 100-card decklist, validates and rates it, and hands back
an HTML report with the full list, price breakdown, bracket rating, and win condition.

Or, with a deck you already have:

> "Here's my Moxfield deck: [paste URL]. Clean it up and tell me what's wrong with it."

Claude will call `existing_deck_cleanup`, fetch the list from Moxfield, and return the same kind of
report — any structural issues doubling as your fix-it list.

Or, during an Arena draft:

> "Help me draft — my Player.log is at C:\Users\<name>\AppData\LocalLow\Wizards Of The Coast\MTGA\Player.log"

Claude will call `arena_draft_assistance` each time you're on the clock and reason over the real pack
contents to suggest a pick.

## Notes

- **Deck data sources**: EDHREC (unofficial, undocumented endpoints — card/commander names must match
  EDHREC's slug format closely; misspellings 404), Card Kingdom (unofficial public pricelist feed — the
  standardized real-dollar price source here, distinct from Scryfall's bundled bulk-estimate price),
  Commander Spellbook (official API, used to detect real combos for the bracket rating), and Scryfall
  itself (official, documented, no API key) for card legality/text/mana cost.
- **The Commander Bracket System rating is a best-effort classifier**, not an official ruling — it's
  built from hardcoded reference lists (Game Changers, mass land denial, extra-turn cards) that the
  Commander Format Panel updates periodically, plus live combo detection. Re-verify against WotC's own
  list if a rating looks off.
- **Auto-building from a commander name can be noticeably slower** than working from an already-
  assembled decklist — it fetches EDHREC's full card pool for that commander and Card Kingdom's entire
  pricelist to cross-reference prices.
- **Moxfield fetches can occasionally fail with a 403** — Moxfield's anti-bot protection sometimes
  blocks the request outright. If that happens, paste the decklist text directly instead of the URL.
- **`get_card_script`'s Forge lookup is a guessed filename**, not a search — split cards, double-faced
  cards, or cards with unusual punctuation may not match, and a 404 there just means fall back to
  `search_cards`'s oracle text for that card, not that anything is broken.
- **`find_combos`'s exact query syntax is inferred from a public guide**, not confirmed against live
  docs — if a pairing you know has combos returns nothing, spot-check with a known combo like
  `['Dramatic Reversal', 'Isochron Scepter']` before concluding there's truly nothing there.
- **`card_ratings_csv_path` requires a file YOU export yourself** — go to 17lands.com/card_ratings,
  pick the set/format/date range you want, and use the page's own CSV export, then point the tool at
  that file. This server never contacts 17lands.com itself: their own usage guidelines ask third-party
  tools not to hit their live site directly (they rate-limit it and can restrict access), so rather
  than doing that, this just reads a snapshot you already have. That also means the data is only as
  fresh as when you exported it, and it reflects whatever filters (format, date range) you had
  selected at the time.
- **The playtest-table feature (an actual playable table for the built deck) is temporarily disabled**
  while that companion server is reworked — these tools validate and deliver a report, they don't
  currently create a playable table.
- This is stdio transport only, meaning it's local-only (Claude Desktop or Claude Code on
  your machine). To let Claude.ai or other remote clients use it, you'd switch to the
  Streamable HTTP transport and deploy it somewhere public.
