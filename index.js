import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- All 20 original tools' implementations now live under sub-tools/, grouped by
// concern rather than by original tool name. Nothing was removed -- every function
// below is a near-verbatim port, still reachable and testable independently. This
// file's only job is to sequence them into the 4 tools Claude actually calls.
// NOTE: several sub-tools/ functions (get_card_by_name, get_rulings, edhrec synergies/average-decklist
// beyond what's used below, get_card_script, get_cardkingdom_price standalone, find_combos, playtest
// list_games/create_table/get_state/load_deck/do_action) are NOT imported here -- nothing in the 4 tools
// below calls them. Their code is intact under sub-tools/, just currently unreachable from this file.
// Decision on whether/how to re-expose them (5th tool vs. operation-mode params) is still open.
import { searchCards } from "./sub-tools/scryfall/cards.js";
import { getCommanderRecommendations } from "./sub-tools/edhrec/recommendations.js";
import { buildDeckByPrice } from "./sub-tools/deck-building/price_constrained_builder.js";
import { computeDeckConsistency } from "./sub-tools/deck-building/consistency.js";
import { computeBracketRating } from "./sub-tools/bracket/rating.js";
import { computeDeckPriceTotal } from "./sub-tools/cardkingdom/pricing.js";
import { getMoxfieldDecklist } from "./sub-tools/deck-building/moxfield.js";
import { parsePlaytestDecklist } from "./sub-tools/playtest/state.js";
// createPlaytestRoom intentionally NOT imported -- playtest table creation is disabled for now,
// see the comment on runChecksAndDeliver below. The file itself is untouched in sub-tools/delivery/.

import { LogReader } from "./sub-tools/arena-log/log_reader.js";
import { DraftScanner } from "./sub-tools/arena-log/draft_log_parser.js";
import { extractGreEvents, buildMatchTimeline, createMatchState } from "./sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline, resolveGrpIds } from "./sub-tools/arena-log/grpid_resolver.js";

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

// Shared by both deck tools below -- defined HERE (not tucked into sub-tools/) specifically so
// the full check -> gate -> deliver sequence stays visible to anyone reading this file, rather
// than hidden a layer down the way the old deliver_finished_deck.js orchestrator was.
//
// PLAYTEST TABLE CREATION IS TEMPORARILY DISABLED (see sub-tools/delivery/create_playtest_room.js
// and sub-tools/playtest/* -- code is untouched, just not called from here). The playtest server
// is buggy and needs more work; focus for now is the core MCP structure. Re-add a Step 3 call to
// createPlaytestRoom() once that's ready -- runChecksAndDeliver's shape (consistency/bracket/price
// -> gate -> deliver) is unchanged, so wiring it back in later is a small, localized edit here.
// deck_name is intentionally NOT a parameter here -- its only past use was labeling the playtest
// room, which is disabled. It's still collected by both tool schemas below (useful metadata, and
// ready to thread back in once playtest table creation is re-enabled) but stops there for now.
async function runChecksAndDeliver({ decklist_text, wincon_summary, general_strategy }) {
  const { commanderNames, deckEntries } = parsePlaytestDecklist(decklist_text);
  if (!commanderNames.length || !deckEntries.length) {
    return { blocked: true, reason: "Couldn't parse a commander and deck from decklist_text — check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting." };
  }

  const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
  const allCopiesNames = [...commanderNames, ...deckEntries.flatMap((e) => Array(e.qty).fill(e.name))];

  // Step 1: run deck consistency, bracket rating, and price total in parallel.
  const [consistency, bracket, price] = await Promise.all([
    computeDeckConsistency(commanderNames, deckEntries),
    computeBracketRating(commanderNames, uniqueDeckNames),
    computeDeckPriceTotal(allCopiesNames, false),
  ]);

  // Step 2: gate. A structurally broken deck is reported, not silently passed through.
  if (consistency.issues.length) {
    return {
      blocked: true,
      reason: "Consistency check found issues — fix the decklist and try again.",
      consistency, bracket, price,
    };
  }

  // Step 3 (playtest table creation) is disabled for now -- see comment above. Deck is clean,
  // so build final_delivery_text directly from the checks, with no room URL.
  const commanderLabel = `${commanderNames.join(" / ")} (${consistency.commander_color_identity.length ? consistency.commander_color_identity.join("/") : "Colorless"})`;
  const comboLabel = bracket.combos_found.length
    ? bracket.combos_found.map((c) => `${c.pieces.join(" + ")} (${c.speed})`).join("; ")
    : "None";
  const finalDeliveryText =
    `${decklist_text.trim()}\n\n` +
    `| | |\n|---|---|\n` +
    `| **Price** | $${price.total_usd.toFixed(2)} (Card Kingdom) |\n` +
    `| **Commander** | ${commanderLabel} |\n` +
    `| **Bracket Power** | ${bracket.bracket_estimate} |\n` +
    `| **Combo list** | ${comboLabel} |\n` +
    `| **Wincon(s)** | ${wincon_summary} |\n` +
    `| **General strategy** | ${general_strategy} |`;

  return { blocked: false, consistency, bracket, price, final_delivery_text: finalDeliveryText };
}

// --- Tool 1: new_deck_creation ---------------------------------------------------------------
// Sequence: EDHREC commander recommendations (context) -> build a decklist (auto-built via
// build_deck_by_price -- an optional price_limit_usd, not exclusively a "budget" tool -- OR use
// an already-assembled decklist_text from earlier in the conversation) -> runChecksAndDeliver
// (consistency + bracket + price checks). Playtest table creation is TEMPORARILY DISABLED -- see
// runChecksAndDeliver's comment above. Internally exercises: edhrec/recommendations, deck-building/
// price_constrained_builder, deck-building/consistency, bracket/rating, cardkingdom/pricing.
server.tool(
  "new_deck_creation",
  "Build a new deck end-to-end -- any format, but this pipeline (bracket rating, EDH-specific " +
  "consistency checks) is built around Commander. Two ways to supply the decklist: " +
  "(1) give just commander_name (optionally with price_limit_usd as a ceiling, or omit it entirely " +
  "for no price constraint at all) and this auto-builds a synergy-ranked decklist from EDHREC + Card " +
  "Kingdom data via build_deck_by_price, or (2) pass decklist_text if you've already assembled one " +
  "manually earlier in the conversation (e.g. using search_cards/get_card_synergies/find_combos as " +
  "needed) -- this skips straight to validation. Either way, runs analyze_deck_consistency + " +
  "rate_deck_bracket + get_deck_price_total, and returns ready-to-paste final_delivery_text if the " +
  "deck is structurally clean, or the specific issues found if not. If build_deck_by_price's output " +
  "is short of 100 cards (it excludes basic lands by design), the consistency check will report that " +
  "as an issue -- add lands to decklist_text and call this again. NOTE: playtest table creation is " +
  "temporarily disabled while that server is reworked -- this tool validates and delivers a " +
  "decklist, it does not create a playable table right now.",
  {
    commander_name: z.string().describe("Exact commander name, e.g. 'Atraxa, Grand Unifier'"),
    price_limit_usd: z.number().optional().describe("Optional USD ceiling for auto-building nonland cards via build_deck_by_price. Omit entirely for no price constraint (highest-synergy build regardless of cost), or omit along with commander_name and supply decklist_text instead."),
    min_synergy_pct: z.number().optional().describe("Only used for auto-build: skip candidates below this EDHREC synergy percentage."),
    decklist_text: z.string().optional().describe("A fully-assembled decklist ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line) to validate and deliver directly, skipping the auto-build step."),
    deck_name: z.string().describe("The deck's name/theme, e.g. 'Edgar Markov Vampire Tribal'."),
    wincon_summary: z.string().describe("How this deck actually wins. Check the combos_found in this response before finalizing -- name real combo pieces if any were found."),
    general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn."),
  },
  async ({ commander_name, price_limit_usd, min_synergy_pct, decklist_text, deck_name, wincon_summary, general_strategy }) => {
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
      delivery = await runChecksAndDeliver({ decklist_text: resolvedDecklistText, wincon_summary, general_strategy });
    } catch (e) {
      return { content: [{ type: "text", text: `deliver_finished_deck failed: ${e.message}` }] };
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
  "the user pasted it. Runs analyze_deck_consistency + rate_deck_bracket + get_deck_price_total; any " +
  "issue found (wrong card count, singleton violation, off-color card, not Commander-legal) is " +
  "returned as a punch-list -- fix the decklist_text and call again. Once clean, returns ready-to-" +
  "paste final_delivery_text, same as new_deck_creation's final step. Also returns EDHREC " +
  "recommendations for the primary commander as improvement context alongside the pass/fail result. " +
  "NOTE: playtest table creation is temporarily disabled while that server is reworked.",
  {
    moxfield_url: z.string().optional().describe("A Moxfield deck URL or bare deck id. Provide this OR decklist_text, not both."),
    decklist_text: z.string().optional().describe("Pasted decklist text ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line)."),
    deck_name: z.string().describe("The deck's name/theme."),
    wincon_summary: z.string().describe("How this deck actually wins. Check combos_found in this response before finalizing."),
    general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn."),
  },
  async ({ moxfield_url, decklist_text, deck_name, wincon_summary, general_strategy }) => {
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
      delivery = await runChecksAndDeliver({ decklist_text: resolvedDecklistText, wincon_summary, general_strategy });
    } catch (e) {
      return { content: [{ type: "text", text: `deliver_finished_deck failed: ${e.message}` }] };
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

// --- Tool 3: arena_draft_assistance -----------------------------------------------------------
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
  "draft_log_parser.js). This tool only supplies data -- it does not recommend a pick; reason " +
  "over the returned pack/pick-history data to actually advise.",
  {
    player_log_path: z.string().describe("Absolute path to Arena's Player.log, e.g. 'C:\\\\Users\\\\<name>\\\\AppData\\\\LocalLow\\\\Wizards Of The Coast\\\\MTGA\\\\Player.log'"),
  },
  async ({ player_log_path }) => {
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

    let enrichedPack = [];
    if (state.currentPack.length) {
      const grpIds = state.currentPack.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
      const resolved = await resolveGrpIds(grpIds, searchCardsForResolver);
      enrichedPack = state.currentPack.map((id) => {
        const card = resolved.get(parseInt(id, 10));
        return card ? card[0] ?? card : { grpId: id, card: null };
      });
    }

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
          picks_made_so_far: state.pickedCards.length,
        }, null, 2),
      }],
    };
  }
);

// --- Tool 4: arena_draft_game_advice ----------------------------------------------------------
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
