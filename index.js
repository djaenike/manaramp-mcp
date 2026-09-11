import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

// --- All 20 original tools' implementations now live under sub-tools/, grouped by
// concern rather than by original tool name. Nothing was removed -- every function
// below is a near-verbatim port, still reachable and testable independently. This
// file's job is to sequence/expose them as the tools Claude actually calls: 2 deck-
// building tools, 4 raw lookup tools those two lean on Claude to call mid-build
// (search_cards/get_card_synergies/find_combos/get_card_script), 2 Arena tools.
// NOTE: get_card_by_name, get_rulings, get_average_decklist, get_cardkingdom_price
// standalone, and all 5 playtest_* operations are STILL not exposed here -- nothing
// below calls them. Their code is intact under sub-tools/, just currently unreachable
// from this file. Decision on whether/how to re-expose those specifically is still open.
import { searchCards } from "./sub-tools/scryfall/cards.js";
import { getCommanderRecommendations, getCardSynergies } from "./sub-tools/edhrec/recommendations.js";
import { findCombos } from "./sub-tools/spellbook/combos.js";
import { getCardScript } from "./sub-tools/forge/card_script.js";
import { buildDeckByPrice } from "./sub-tools/deck-building/price_constrained_builder.js";
import { computeDeckConsistency } from "./sub-tools/deck-building/consistency.js";
import { computeBracketRating } from "./sub-tools/bracket/rating.js";
import { computeDeckPriceTotal } from "./sub-tools/cardkingdom/pricing.js";
import { getMoxfieldDecklist } from "./sub-tools/deck-building/moxfield.js";
import { parsePlaytestDecklist } from "./sub-tools/playtest/state.js";
import { buildActualOutput } from "./sub-tools/delivery/report_data.js";
import { renderDeckReportHtml } from "./sub-tools/delivery/html_renderer.js";
// createPlaytestRoom intentionally NOT imported -- playtest table creation is disabled for now,
// see the comment on runChecksAndDeliver below. The file itself is untouched in sub-tools/delivery/.

import { LogReader } from "./sub-tools/arena-log/log_reader.js";
import { DraftScanner } from "./sub-tools/arena-log/draft_log_parser.js";
import { extractGreEvents, buildMatchTimeline, createMatchState } from "./sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline, resolveGrpIds } from "./sub-tools/arena-log/grpid_resolver.js";
import { loadCardRatings, findLatestCsvInDir } from "./sub-tools/arena-log/card_ratings.js";

// Create the MCP server instance
const server = new McpServer({
  name: "scryfall-mcp",
  version: "2.0.0",
});

// --- Per-log-path session state for the two Arena tools -------------------------------------
// Player.log is rewritten from scratch every Arena launch, and both draft and match parsing
// need to persist their offset/state ACROSS separate tool calls (each pick / each poll is its
// own call) -- not just within one call, the way scryfallLastRequestAt persists Scryfall pacing
// across this same process's tool calls. One reader/scanner/state set per path, created on first
// use and reused after.
const draftSessions = new Map();   // path -> { reader: LogReader, scanner: DraftScanner }
const matchSessions = new Map();   // path -> { reader: LogReader, state: matchState }
const cardRatingsCache = new Map(); // csv path -> Map<lowercased card name, 17Lands rating row>

function getDraftSession(path) {
  if (!draftSessions.has(path)) {
    draftSessions.set(path, { reader: new LogReader(path), scanner: new DraftScanner() });
  }
  return draftSessions.get(path);
}

function getMatchSession(path) {
  if (!matchSessions.has(path)) {
    matchSessions.set(path, { reader: new LogReader(path), state: createMatchState() });
  }
  return matchSessions.get(path);
}

// Batched grpId -> real card resolution via this server's own search_cards, reused by both
// Arena tools. arena_id:<id> confirmed live against Scryfall's search syntax.
async function searchCardsForResolver(query) {
  return searchCards(query);
}

// --- Report file output ----------------------------------------------------------------------
// Every rendered report also gets written to a real file -- this is how a Claude Desktop user (no
// Artifact/live-HTML rendering in its chat window) actually VIEWS the report: open report_path in
// a real browser, where plain https:// image URLs load with no restriction at all. That's also
// why images are NOT base64-inlined into html_report/actual_output (see report_data.js's comment)
// -- a real browser opening a local file doesn't need that workaround, and inlining blew the MCP
// tool response well past its ~1MB cap for a full decklist.
//
// Deliberately NOT written next to this file: this server is meant to run packaged (.mcpb) on a
// machine that may not be the one it was built on, so "next to index.js" isn't a folder the user
// can necessarily find or write to. The user's Downloads folder is a stable, always-writable,
// always-discoverable location on any machine regardless of where the server itself is installed
// -- a dedicated subfolder there keeps it from scattering loose report files into Downloads' root.
// SCRYFALL_MCP_REPORTS_DIR overrides this (used by tests, so test runs don't touch a real
// Downloads folder).
const REPORTS_DIR = process.env.SCRYFALL_MCP_REPORTS_DIR || join(homedir(), "Downloads", "MTG Deck Reports");

// --- Card ratings drop-in folder --------------------------------------------------------------
// Unlike REPORTS_DIR above, this one deliberately stays next to index.js (via import.meta.url, so
// it's stable regardless of cwd): the point is "drop a 17Lands CSV export in the same folder as
// the server" rather than remembering/typing a path each time, which arena_draft_assistance falls
// back to auto-discovering (most recently modified .csv wins) when card_ratings_csv_path isn't
// given explicitly. A temporary stand-in for a real store (SQLite, etc.) -- fine for "one file,
// swap it when you re-export," not meant to scale past that.
const CARD_RATINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "card_ratings");
try { mkdirSync(CARD_RATINGS_DIR, { recursive: true }); } catch { /* best-effort; handled again on use */ }

function slugifyFilename(name) {
  return (name || "deck").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "deck";
}

function writeReportFile(deckName, html) {
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(REPORTS_DIR, `${slugifyFilename(deckName)}-${timestamp}.html`);
    writeFileSync(path, html);
    return path;
  } catch (e) {
    return null; // a filesystem hiccup shouldn't take down report delivery -- html_report is still returned directly
  }
}

// Shared by both deck tools below -- defined HERE (not tucked into sub-tools/) specifically so
// the full check -> build report -> render sequence stays visible to anyone reading this file,
// rather than hidden a layer down the way the old deliver_finished_deck.js orchestrator was.
//
// PLAYTEST TABLE CREATION IS TEMPORARILY DISABLED (see sub-tools/delivery/create_playtest_room.js
// and sub-tools/playtest/* -- code is untouched, just not called from here). The playtest server
// is buggy and needs more work; focus for now is the core MCP structure. Re-add a call to
// createPlaytestRoom() once that's ready -- this function's shape (consistency/bracket/price ->
// build report -> render) is unaffected by that, so wiring it back in later is a small, localized
// edit here (e.g. threading a room_url into actualOutput/the rendered HTML).
//
// There is no "blocked" gate here: a decklist that parses (a Commander and a Deck section were
// found) always gets a full report, even if consistency checks failed. deck_report_template.html
// has a built-in issue banner for exactly that case -- surfacing problems in the delivered report
// is more useful than refusing to deliver one. The only hard stop is a genuine parse failure,
// where there's nothing coherent to report on at all.
async function runChecksAndDeliver({
  decklist_text, deck_name, deck_design_preference, deck_type, price_limit_usd, bracket_level_requested,
  user_color_preference, user_commander_preference, wincon_summary, general_strategy,
}) {
  const { commanderNames, deckEntries } = parsePlaytestDecklist(decklist_text);
  if (!commanderNames.length || !deckEntries.length) {
    return { blocked: true, reason: "Couldn't parse a commander and deck from decklist_text — check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting." };
  }

  const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
  const allCopiesNames = [...commanderNames, ...deckEntries.flatMap((e) => Array(e.qty).fill(e.name))];

  const [consistency, bracket, price] = await Promise.all([
    computeDeckConsistency(commanderNames, deckEntries),
    computeBracketRating(commanderNames, uniqueDeckNames),
    computeDeckPriceTotal(allCopiesNames, false),
  ]);

  const userDefinedScope = {
    deckDesignPreference: deck_design_preference ?? null,
    deckType: deck_type ?? "commander",
    priceLimitUsd: price_limit_usd ?? null,
    bracketLevel: bracket_level_requested ?? null,
    userColorPreference: user_color_preference ?? null,
    userCommanderPreference: user_commander_preference ?? null,
  };

  const actualOutput = buildActualOutput({
    commanderNames, deckEntries, decklistText: decklist_text,
    consistency, bracket, price, wincon_summary, general_strategy, bracket_level_requested,
  });

  const htmlReport = renderDeckReportHtml(userDefinedScope, actualOutput);
  const reportPath = writeReportFile(deck_name, htmlReport);

  return {
    blocked: false, user_defined_scope: userDefinedScope, actual_output: actualOutput,
    html_report: htmlReport, report_path: reportPath,
  };
}

// --- Tool 1: new_deck_creation ---------------------------------------------------------------
// Sequence: EDHREC commander recommendations (context) -> build a decklist (auto-built via
// build_deck_by_price -- an optional price_limit_usd, not exclusively a "budget" tool -- OR use
// an already-assembled decklist_text, built via search_cards/get_card_synergies/find_combos/
// get_card_script) -> runChecksAndDeliver (consistency + bracket + price checks + report). Playtest
// table creation is TEMPORARILY DISABLED -- see runChecksAndDeliver's comment above. Internally
// exercises: edhrec/recommendations, deck-building/price_constrained_builder, deck-building/
// consistency, bracket/rating, cardkingdom/pricing.
server.tool(
  "new_deck_creation",
  "Build a new deck end-to-end -- any format, but this pipeline (bracket rating, EDH-specific " +
  "consistency checks) is built around Commander. Two ways to supply the decklist: " +
  "(1) RECOMMENDED for anything beyond a quick budget fill: assemble decklist_text yourself first, " +
  "using search_cards (find real candidates for each role -- removal, ramp, card draw, curve slots), " +
  "get_card_synergies (check a candidate has real support in these colors/theme), find_combos " +
  "(verify a pairing is a genuine documented combo before building around it), and get_card_script " +
  "(disambiguate a tricky ability's actual function) as needed -- then pass the result as " +
  "decklist_text. If the user has no commander preference, use search_cards to pick one that fits " +
  "deck_design_preference/user_color_preference before assembling the rest. (2) Quicker but far " +
  "less deliberate: give just commander_name (optionally with price_limit_usd as a ceiling, or omit " +
  "it entirely for no price constraint) and this auto-builds a synergy-ranked decklist from EDHREC + " +
  "Card Kingdom data via build_deck_by_price alone -- a pure synergy-per-dollar greedy fill with NO " +
  "combo-awareness, no Forge lookups, and no mana-curve awareness; use option (1) whenever the user " +
  "cares about getting those things right. Either way, runs analyze_deck_consistency + " +
  "rate_deck_bracket + get_deck_price_total and ALWAYS returns a full report -- there is no pass/fail " +
  "gate. The response's actual_output.consistencyIssues lists anything wrong (wrong card count, " +
  "singleton violation, off-color card, not Commander-legal); if it's non-empty, the returned " +
  "html_report will show an in-report issue banner rather than silently hiding the problem. If " +
  "build_deck_by_price's output is short of 100 cards (it excludes basic lands by design), add lands " +
  "to decklist_text and call this again for an updated report. THE RETURNED html_report IS THE " +
  "DELIVERABLE: it's a complete, self-contained HTML page (deck_report_template.html already merged " +
  "with this deck's real data) -- present it to the user, do NOT re-derive or reformat a summary from " +
  "actual_output yourself. The same HTML is also saved to report_path (a local file next to this " +
  "server) -- tell the user that path so they can open it directly in a browser; that's also the " +
  "most reliable way to see working card images, since card images are plain Scryfall URLs (not " +
  "embedded) to keep this response well under typical tool-result size limits, and a URL-based " +
  "<img> won't load if you instead publish html_report as a sandboxed web artifact elsewhere unless " +
  "you fetch and re-embed each image yourself first. NOTE: playtest table creation is temporarily " +
  "disabled while that server is reworked -- this tool validates and delivers a report, it does not " +
  "create a playable table right now.",
  {
    commander_name: z.string().describe("Exact commander name, e.g. 'Atraxa, Grand Unifier'"),
    price_limit_usd: z.number().optional().describe("Optional USD ceiling for auto-building nonland cards via build_deck_by_price. Omit entirely for no price constraint (highest-synergy build regardless of cost), or omit along with commander_name and supply decklist_text instead."),
    min_synergy_pct: z.number().optional().describe("Only used for auto-build: skip candidates below this EDHREC synergy percentage."),
    decklist_text: z.string().optional().describe("A fully-assembled decklist ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line) to validate and deliver directly, skipping the auto-build step."),
    deck_name: z.string().describe("The deck's name/theme, e.g. 'Edgar Markov Vampire Tribal'."),
    deck_design_preference: z.string().optional().describe("User's free-text description of what they asked for, e.g. 'aggressive go-wide tokens deck'. Echoed into the report's user-defined-scope section."),
    deck_type: z.string().optional().describe("Format, e.g. 'commander' (default), 'standard', 'modern'."),
    bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the report will flag whether the deck actually built to that bracket."),
    user_color_preference: z.array(z.string()).optional().describe("Color identity the user asked for, e.g. ['W','B']. Omit if the user had no preference."),
    wincon_summary: z.string().describe("How this deck actually wins. Check the combos_found in this response before finalizing -- name real combo pieces if any were found."),
    general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn."),
  },
  async ({ commander_name, price_limit_usd, min_synergy_pct, decklist_text, deck_name, deck_design_preference, deck_type, bracket_level_requested, user_color_preference, wincon_summary, general_strategy }) => {
    let commanderRecommendations = null;
    try {
      commanderRecommendations = await getCommanderRecommendations(commander_name);
    } catch (e) {
      commanderRecommendations = { error: e.message };
    }

    let resolvedDecklistText = decklist_text;
    let buildSource;

    if (!resolvedDecklistText) {
      // No price_limit_usd at all is valid now -- buildDeckByPrice treats that as "no ceiling",
      // not an error. This tool no longer requires a budget to auto-build.
      let buildResult;
      try {
        buildResult = await buildDeckByPrice(commander_name, price_limit_usd, min_synergy_pct);
      } catch (e) {
        return { content: [{ type: "text", text: `build_deck_by_price failed: ${e.message}` }] };
      }
      buildSource = price_limit_usd !== undefined
        ? `build_deck_by_price (synergy-ranked, $${price_limit_usd} ceiling)`
        : "build_deck_by_price (synergy-ranked, no price ceiling)";
      const lines = [
        "Commander", `1 ${commander_name}`, "",
        "Deck", ...buildResult.deck.map((c) => `1 ${c.name}`),
      ];
      resolvedDecklistText = lines.join("\n");
    } else {
      buildSource = "decklist_text (already assembled)";
    }

    let delivery;
    try {
      delivery = await runChecksAndDeliver({
        decklist_text: resolvedDecklistText, deck_name, deck_design_preference, deck_type, price_limit_usd,
        bracket_level_requested, user_color_preference, user_commander_preference: commander_name,
        wincon_summary, general_strategy,
      });
    } catch (e) {
      return { content: [{ type: "text", text: `Report generation failed: ${e.message}` }] };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ build_source: buildSource, commander_recommendations: commanderRecommendations, ...delivery }, null, 2),
      }],
    };
  }
);

// --- Tool 2: existing_deck_cleanup -----------------------------------------------------------
// Sequence: fetch the decklist (Moxfield URL OR pasted text) -> EDHREC recommendations for the
// primary commander (cleanup/improvement context) -> runChecksAndDeliver (consistency + bracket
// + price; issues double as the cleanup punch-list). Playtest table creation is TEMPORARILY
// DISABLED -- see runChecksAndDeliver's comment above. Internally exercises: deck-building/
// moxfield, edhrec/recommendations, deck-building/consistency, bracket/rating, cardkingdom/pricing.
server.tool(
  "existing_deck_cleanup",
  "Validate and clean up an existing deck -- any format, Commander-oriented pipeline (same as " +
  "new_deck_creation). Supply either moxfield_url to fetch a decklist directly, or decklist_text if " +
  "the user pasted it. Runs analyze_deck_consistency + rate_deck_bracket + get_deck_price_total and " +
  "ALWAYS returns a full report -- there is no pass/fail gate. actual_output.consistencyIssues lists " +
  "anything wrong (wrong card count, singleton violation, off-color card, not Commander-legal); the " +
  "returned html_report shows an in-report issue banner when that list is non-empty, doubling as a " +
  "cleanup punch-list. Also returns EDHREC recommendations for the primary commander as improvement " +
  "context. WHEN THE USER ASKS FOR A CHANGE (more removal, less mana, more card draw, swap out a " +
  "weak card, etc.): don't just describe the change -- use search_cards/get_card_synergies/" +
  "find_combos/get_card_script to find and verify real replacement cards, edit decklist_text " +
  "yourself accordingly, and call this tool again with the updated list for a fresh report. This is " +
  "the same exercise as building a new deck, just starting from an existing list instead of a blank " +
  "one. THE RETURNED html_report IS THE DELIVERABLE: it's a complete, self-contained HTML page " +
  "(deck_report_template.html already merged with this deck's real data) -- present it to the user, " +
  "do NOT re-derive or reformat a summary from actual_output yourself. The same HTML is also saved " +
  "to report_path (a local file next to this server) -- tell the user that path so they can open it " +
  "directly in a browser; that's also the most reliable way to see working card images, since card " +
  "images are plain Scryfall URLs (not embedded) to keep this response well under typical tool-result " +
  "size limits, and a URL-based <img> won't load if you instead publish html_report as a sandboxed " +
  "web artifact elsewhere unless you fetch and re-embed each image yourself first. NOTE: playtest " +
  "table creation is temporarily disabled while that server is reworked.",
  {
    moxfield_url: z.string().optional().describe("A Moxfield deck URL or bare deck id. Provide this OR decklist_text, not both."),
    decklist_text: z.string().optional().describe("Pasted decklist text ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line)."),
    deck_name: z.string().describe("The deck's name/theme."),
    deck_design_preference: z.string().optional().describe("User's free-text description of what they want cleaned up / improved, if any. Echoed into the report's user-defined-scope section."),
    deck_type: z.string().optional().describe("Format, e.g. 'commander' (default), 'standard', 'modern'."),
    bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the report will flag whether the deck matches it."),
    user_color_preference: z.array(z.string()).optional().describe("Color identity the user asked for, if they mentioned one, e.g. ['W','B']."),
    wincon_summary: z.string().describe("How this deck actually wins. Check combos_found in this response before finalizing."),
    general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn."),
  },
  async ({ moxfield_url, decklist_text, deck_name, deck_design_preference, deck_type, bracket_level_requested, user_color_preference, wincon_summary, general_strategy }) => {
    if (!moxfield_url && !decklist_text) {
      return { content: [{ type: "text", text: "Provide either moxfield_url or decklist_text." }] };
    }
    if (moxfield_url && decklist_text) {
      return { content: [{ type: "text", text: "Provide either moxfield_url or decklist_text, not both." }] };
    }

    let resolvedDecklistText = decklist_text;
    let moxfieldMeta = null;
    if (moxfield_url) {
      try {
        moxfieldMeta = await getMoxfieldDecklist(moxfield_url);
      } catch (e) {
        return { content: [{ type: "text", text: `get_moxfield_decklist failed: ${e.message}` }] };
      }
      resolvedDecklistText = moxfieldMeta.decklist_text;
    }

    const { commanderNames } = parsePlaytestDecklist(resolvedDecklistText);
    let commanderRecommendations = null;
    if (commanderNames[0]) {
      try {
        commanderRecommendations = await getCommanderRecommendations(commanderNames[0]);
      } catch (e) {
        commanderRecommendations = { error: e.message };
      }
    }

    let delivery;
    try {
      delivery = await runChecksAndDeliver({
        decklist_text: resolvedDecklistText, deck_name, deck_design_preference, deck_type,
        bracket_level_requested, user_color_preference, user_commander_preference: commanderNames[0] ?? null,
        wincon_summary, general_strategy,
      });
    } catch (e) {
      return { content: [{ type: "text", text: `Report generation failed: ${e.message}` }] };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          source: moxfield_url ? `Moxfield: ${moxfieldMeta.deck_name}` : "Pasted decklist_text",
          commander_recommendations: commanderRecommendations,
          ...delivery,
        }, null, 2),
      }],
    };
  }
);

// --- Tool 3: search_cards ----------------------------------------------------------------------
// Raw Scryfall search, exposed standalone specifically so Claude can call it repeatedly WHILE
// reasoning about a decklist (before ever calling new_deck_creation/existing_deck_cleanup) --
// e.g. "what are the best cheap removal spells in these colors" or "is there a better card-draw
// enchantment I'm missing" -- rather than picking cards purely from training data. Each result
// includes `category` (Creature/Instant/Sorcery/etc, derived from type_line) alongside the raw
// type_line, so category doesn't need to be re-derived by hand while scanning candidates.
server.tool(
  "search_cards",
  "Search Magic cards via Scryfall's search syntax (e.g. 'c:red t:creature cmc<=2', 'o:\"draw a " +
  "card\"'). Returns up to 25 matches with name, mana_cost, type_line, category (Creature/Instant/" +
  "Sorcery/Enchantment/Artifact/Planeswalker/Land/Other -- derived from type_line), oracle_text, " +
  "Commander/Standard legality, and usd (Scryfall's bundled bulk-estimate price -- a fast sanity " +
  "check only, NOT this server's standardized real-dollar source; new_deck_creation/" +
  "existing_deck_cleanup use Card Kingdom pricing for the actual deck total). Use this while " +
  "building or editing a decklist to find real candidates for a role (removal, ramp, card draw, a " +
  "specific color/curve slot) instead of relying on training data alone -- then pass the assembled " +
  "decklist_text to new_deck_creation or existing_deck_cleanup for validation, pricing, bracket " +
  "rating, and the final HTML report.",
  {
    query: z.string().describe("Scryfall search syntax, e.g. 'c:red t:creature cmc<=2'"),
    max_price_usd: z.number().optional().describe("Optional ceiling on Scryfall's bundled usd estimate, to pre-filter obviously-too-expensive candidates."),
  },
  async ({ query, max_price_usd }) => {
    try {
      const cards = await searchCards(query, max_price_usd);
      return { content: [{ type: "text", text: JSON.stringify(cards, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `search_cards failed: ${e.message}` }] };
    }
  }
);

// --- Tool 4: get_card_synergies -----------------------------------------------------------------
// EDHREC's per-card synergy page: what else gets played alongside a given card, plus any combos
// EDHREC itself flags for it. Distinct from new_deck_creation's internal commander-recommendations
// lookup (that's "what fits this commander"); this is "what pairs well with this specific card" --
// use it while evaluating whether a candidate card actually has support in the deck, not just a
// good card in isolation.
server.tool(
  "get_card_synergies",
  "EDHREC's synergy data for a single card: other cards commonly played alongside it (by category, " +
  "with inclusion rates) and any known combos EDHREC flags for it. Card name must match EDHREC's " +
  "slug format closely (lowercase, punctuation stripped) -- no fuzzy matching, a misspelling 404s. " +
  "Use this while building/editing a decklist to check whether a candidate card has real support " +
  "(cards that pair with it) in the colors/theme you're building, not just that it's individually " +
  "strong. For confirmed, fully-documented combos (not just 'played together'), use find_combos.",
  {
    card_name: z.string().describe("Exact card name, e.g. 'Isochron Scepter'"),
  },
  async ({ card_name }) => {
    try {
      const synergies = await getCardSynergies(card_name);
      return { content: [{ type: "text", text: JSON.stringify(synergies, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `get_card_synergies failed: ${e.message}` }] };
    }
  }
);

// --- Tool 5: find_combos ------------------------------------------------------------------------
// Commander Spellbook's official combo database, queried with an implicit AND across every card
// name passed in one call. Use this to verify two-or-more candidate cards actually form a real,
// documented combo before building around them, or to check whether a commander/card already has
// a known combo line worth including.
server.tool(
  "find_combos",
  "Look up real, documented combos from Commander Spellbook given 2 or more card names (queried as " +
  "an AND -- every name must appear together in a result). Returns each combo's full card list, " +
  "prerequisites, steps, and produced result (e.g. 'infinite mana'), plus a permalink. Use this to " +
  "verify a candidate pairing is a genuine combo (not just commonly played together per " +
  "get_card_synergies) before building a deck around it, or to double-check a combo you're relying " +
  "on for wincon_summary before calling new_deck_creation/existing_deck_cleanup. If a pairing you " +
  "know has combos returns zero results, the exact query syntax is inferred from a syntax guide " +
  "(not confirmed against live docs) -- spot-check with a known combo like ['Dramatic Reversal', " +
  "'Isochron Scepter'] before concluding there's truly nothing there.",
  {
    card_names: z.array(z.string()).describe("Two or more exact card names to check for a combo together."),
    limit: z.number().optional().describe("Max results to return (default 10)."),
  },
  async ({ card_names, limit }) => {
    try {
      const combos = await findCombos(card_names, limit);
      return { content: [{ type: "text", text: JSON.stringify(combos, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `find_combos failed: ${e.message}` }] };
    }
  }
);

// --- Tool 6: get_card_script ---------------------------------------------------------------------
// Forge's structured rules-engine script for a card (cost/trigger/effect fields), read live from
// Card-Forge/forge on GitHub. Use this to disambiguate ability types oracle text alone can leave
// unclear -- e.g. whether an effect is a tap-cost ability, an attack trigger, or an ETB -- while
// evaluating a candidate card's actual functional role in a deck.
server.tool(
  "get_card_script",
  "Pull a card's structured rules-engine script from Card-Forge/forge (GPL-3.0, community-" +
  "maintained, unofficial) -- useful to disambiguate ability types (tap-cost ability vs. attack " +
  "trigger vs. ETB, etc.) beyond what prose oracle text makes clear, while evaluating how a " +
  "candidate card actually functions during a build. The filename is guessed from the card name " +
  "(lowercase, underscores for spaces, punctuation stripped) and is NOT verified against split " +
  "cards, DFCs, or unusual punctuation -- on a 404, fall back to search_cards/oracle text for this " +
  "card instead of assuming the card doesn't exist.",
  {
    card_name: z.string().describe("Exact card name, e.g. 'Dramatic Reversal'"),
  },
  async ({ card_name }) => {
    try {
      const script = await getCardScript(card_name);
      return { content: [{ type: "text", text: JSON.stringify(script, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `get_card_script failed: ${e.message}` }] };
    }
  }
);

// --- Tool 7: arena_draft_assistance -----------------------------------------------------------
// Sequence: read new Player.log lines (offset persisted per path across calls) -> parse draft
// pack/pick events (Premier/Quick format detection, P1P1 special case) -> resolve every card id
// in the current pack to real card data via search_cards' arena_id: syntax. Internally exercises:
// arena-log/log_reader, arena-log/draft_log_parser, arena-log/grpid_resolver -> scryfall/cards.
server.tool(
  "arena_draft_assistance",
  "Read the current MTG Arena draft pack from Player.log and resolve every card in it to real " +
  "card data (name, mana cost, oracle text) for pick advice. Requires 'Detailed Logs (Plugin " +
  "Support)' enabled in Arena's settings and a full relaunch after enabling it. Call this again " +
  "after each pick to see the next pack -- offset/state for a given player_log_path persists " +
  "across calls within this session, so each call only processes what's new since the last one. " +
  "Supports Premier and Quick Draft; Traditional Draft and Sealed are not yet implemented (see " +
  "draft_log_parser.js). picks_made is the full resolved list of every card picked so far this " +
  "draft (Arena's own log records the actual pick the moment it's made in-client -- you don't need " +
  "the user to tell you what they picked, it's already here on the next call) -- use it to reason " +
  "about the emerging pool (colors/archetype signals so far, curve, what's already covered) rather " +
  "than judging current_pack in isolation. This tool only supplies data, both for the current pack " +
  "and for pick history -- it does not recommend a pick itself. There is no LIVE external win-rate " +
  "data source wired in (this server never calls 17lands.com itself -- their own guidelines " +
  "discourage third-party tools from hitting that site directly). Real win-rate data still gets " +
  "used when available: drop a card_ratings CSV the USER manually exported from " +
  "17lands.com/card_ratings (a normal button on that page, not an API) for the current set/format " +
  "into this server's card_ratings/ folder, and it's picked up automatically (most recently " +
  "modified .csv wins if there's more than one) -- no path needs to be passed for that common " +
  "case. card_ratings_csv_path is only for pointing at a file somewhere else instead. Either way, " +
  "when ratings are loaded, every card in current_pack and picks_made gets a card_ratings_17lands field " +
  "(gih_wr = win rate when actually drawn into hand, 17Lands' own headline 'how good is this " +
  "card' number; alsa = average pick NUMBER this card was last seen still unpicked in a pack " +
  "-- NOT the position it was taken at, that's ata -- so low alsa means it's usually gone " +
  "immediately/highly prized, and a card in your colors sitting in a real pack later than its " +
  "alsa predicts is a live signal that color is more open at your table than average; iih = " +
  "Improvement In Hand, how much win rate actually changes when this card shows up vs. when it " +
  "doesn't, an unweighted difference so a large iih on a small sample can overstate a rare card's " +
  "value -- check it against gih for sample size; null fields mean too small a sample, not a bad " +
  "card). Use those numbers alongside oracle text when they're present; without " +
  "card_ratings_csv_path, fall back to reasoning over real card text/mana costs alone.",
  {
    player_log_path: z.string().describe("Absolute path to Arena's Player.log, e.g. 'C:\\\\Users\\\\<name>\\\\AppData\\\\LocalLow\\\\Wizards Of The Coast\\\\MTGA\\\\Player.log'"),
    card_ratings_csv_path: z.string().optional().describe("Absolute path to a card_ratings CSV the user manually exported from 17lands.com/card_ratings. Optional -- omit this to auto-use whatever CSV (if any) is dropped in this server's card_ratings/ folder; only pass this to point at a file somewhere else instead."),
  },
  async ({ player_log_path, card_ratings_csv_path }) => {
    const session = getDraftSession(player_log_path);
    let lines, sessionReset;
    try {
      ({ lines, sessionReset } = session.reader.readNewLines());
    } catch (e) {
      return { content: [{ type: "text", text: `Couldn't read Player.log at '${player_log_path}': ${e.message}` }] };
    }
    if (sessionReset) {
      session.scanner.reset();
    }

    const events = session.scanner.processLines(lines);
    const state = session.scanner.getState();

    // Resolve the current pack AND everything picked so far in one batch (resolveGrpIds
    // dedupes internally) -- picks_made needs real card data too, not just a count, so Claude
    // can actually reason about the emerging pool (colors leaned into, archetype signals),
    // not just how many picks have happened.
    const currentPackIds = state.currentPack.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
    const pickedCardIds = state.pickedCards.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
    const resolved = await resolveGrpIds([...currentPackIds, ...pickedCardIds], searchCardsForResolver);

    const resolvedRatingsPath = card_ratings_csv_path || findLatestCsvInDir(CARD_RATINGS_DIR);
    let cardRatings = null;
    let cardRatingsError = null;
    if (resolvedRatingsPath) {
      if (!cardRatingsCache.has(resolvedRatingsPath)) {
        try {
          cardRatingsCache.set(resolvedRatingsPath, loadCardRatings(resolvedRatingsPath));
        } catch (e) {
          cardRatingsError = e.message;
        }
      }
      cardRatings = cardRatingsCache.get(resolvedRatingsPath) ?? null;
    }

    const resolveOne = (id) => {
      const card = resolved.get(parseInt(id, 10));
      const enriched = card ? { ...(card[0] ?? card) } : { grpId: id, card: null };
      if (cardRatings && enriched.name) {
        enriched.card_ratings_17lands = cardRatings.get(enriched.name.toLowerCase()) ?? null;
      }
      return enriched;
    };
    const enrichedPack = state.currentPack.map(resolveOne);
    const picksMade = state.pickedCards.map(resolveOne);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_reset: sessionReset,
          new_events_this_call: events,
          draft_format: state.draftFormat,
          event_name: state.eventName,
          pack_number: state.currentPackNumber,
          pick_number: state.currentPickNumber,
          current_pack: enrichedPack,
          picks_made: picksMade,
          picks_made_so_far: picksMade.length,
          card_ratings_source: !resolvedRatingsPath
            ? `No card ratings loaded -- drop a 17Lands card_ratings CSV export into ${CARD_RATINGS_DIR} (or pass card_ratings_csv_path) for real win-rate/signal data.`
            : cardRatingsError
              ? `Failed to load '${resolvedRatingsPath}': ${cardRatingsError}`
              : `Loaded ${cardRatings.size} cards from '${resolvedRatingsPath}'${card_ratings_csv_path ? "" : " (auto-discovered)"}.`,
        }, null, 2),
      }],
    };
  }
);

// --- Tool 8: arena_draft_game_advice ----------------------------------------------------------
// Sequence: read new Player.log lines (separate offset stream from the draft tool, same file) ->
// parse GRE match events into a turn-by-turn timeline -> resolve every grpId referenced in it to
// real card data. Internally exercises: arena-log/log_reader, arena-log/gre_match_parser,
// arena-log/grpid_resolver -> scryfall/cards.
server.tool(
  "arena_draft_game_advice",
  "Read new match/game events from Player.log since the last call and return a turn-by-turn " +
  "timeline (land plays, spells cast, resolves, attacks, damage, life changes, match result) with " +
  "every card resolved to its real name and oracle text. Requires 'Detailed Logs (Plugin Support)' " +
  "enabled in Arena and a full relaunch after enabling it. Call this again as the game progresses -- " +
  "state for a given player_log_path (including the running instanceId->card map) persists across " +
  "calls, so each call only returns what's new. Only ANNOTATED, CONFIRMED events are reported (an " +
  "ActionsAvailableReq listing a legal option is never reported as something that happened -- only " +
  "an actual ZoneTransfer/ObjectsSelected/damage annotation is). This tool only supplies data -- it " +
  "does not give advice directly; reason over the returned timeline to actually advise on the game.",
  {
    player_log_path: z.string().describe("Absolute path to Arena's Player.log"),
  },
  async ({ player_log_path }) => {
    const session = getMatchSession(player_log_path);
    let lines, sessionReset;
    try {
      ({ lines, sessionReset } = session.reader.readNewLines());
    } catch (e) {
      return { content: [{ type: "text", text: `Couldn't read Player.log at '${player_log_path}': ${e.message}` }] };
    }
    if (sessionReset) {
      session.state = createMatchState();
    }

    const { events, droppedCount } = extractGreEvents(lines);
    const { timeline, state: updatedState } = buildMatchTimeline(events, session.state);
    session.state = updatedState;

    const enrichedTimeline = await enrichTimeline(timeline, searchCardsForResolver);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_reset: sessionReset,
          dropped_summarized_blocks: droppedCount,
          new_timeline_events: enrichedTimeline,
        }, null, 2),
      }],
    };
  }
);

// --- Start the server over stdio ---
import { pathToFileURL } from "url";

// Guarded so this file can also be `import`ed by tests without starting a stdio server
// (which would hang waiting on a transport that isn't there in a test context).
// MUST use pathToFileURL, not a plain `file://${process.argv[1]}` string concat --
// on Windows process.argv[1] is a backslash path ('C:\Users\...') while import.meta.url
// is a proper file:// URL ('file:///C:/Users/...'); string concat never matches, which
// silently skips server.connect() entirely -- the server starts and accepts the stdio
// pipe but never responds to anything, hanging until the client times out and cancels.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Exported for tests only -- not part of the MCP tool surface.
export { runChecksAndDeliver };
