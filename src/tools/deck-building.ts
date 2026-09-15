/**
 * tools/deck-building.ts -- Tool 1: new_deck_creation, Tool 2: existing_deck_cleanup
 * Registers BOTH deck-building tools in one file since they share almost every sub-tool import and
 * the same runChecksAndDeliver pipeline (tools/shared/run-checks-and-deliver.ts). Imports
 * searchCards/getCardSynergies/findCombos/getCardScript-equivalents directly from their sub-tools/
 * modules (getCommanderRecommendations, getMoxfieldDecklist, etc) rather than from the standalone
 * lookup tool files (search-cards.ts, get-card-synergies.ts, find-combos.ts, get-card-script.ts) --
 * tools never import tools.
 */

import { z } from "zod";
import { getCommanderRecommendations } from "../sub-tools/edhrec/recommendations.js";
import { buildDeckByPrice } from "../sub-tools/deck-building/price_constrained_builder.js";
import { getMoxfieldDecklist } from "../sub-tools/deck-building/moxfield.js";
import { parsePlaytestDecklist } from "../sub-tools/playtest/state.js";
import { runChecksAndDeliver } from "./shared/run-checks-and-deliver.js";
import type { ToolDefinition } from "./types.js";

// --- Tool 1: new_deck_creation ---------------------------------------------------------------
// Sequence: EDHREC commander recommendations (context) -> build a decklist (auto-built via
// build_deck_by_price -- an optional price_limit_usd, not exclusively a "budget" tool -- OR use
// an already-assembled decklist_text, built via search_cards/get_card_synergies/find_combos/
// get_card_script) -> runChecksAndDeliver (consistency + bracket + price checks + report). Playtest
// table creation is TEMPORARILY DISABLED -- see runChecksAndDeliver's comment. Internally
// exercises: edhrec/recommendations, deck-building/price_constrained_builder, deck-building/
// consistency, bracket/rating, cardkingdom/pricing.
const newDeckCreationInputSchema = {
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
};

const newDeckCreationTool: ToolDefinition<typeof newDeckCreationInputSchema> = {
  name: "new_deck_creation",
  description:
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
  inputSchema: newDeckCreationInputSchema,
  handler: async ({ commander_name, price_limit_usd, min_synergy_pct, decklist_text, deck_name, deck_design_preference, deck_type, bracket_level_requested, user_color_preference, wincon_summary, general_strategy }) => {
    let commanderRecommendations: unknown;
    try {
      commanderRecommendations = await getCommanderRecommendations(commander_name);
    } catch (e: any) {
      commanderRecommendations = { error: e.message };
    }

    let resolvedDecklistText = decklist_text;
    let buildSource: string;

    if (!resolvedDecklistText) {
      // No price_limit_usd at all is valid now -- buildDeckByPrice treats that as "no ceiling",
      // not an error. This tool no longer requires a budget to auto-build.
      let buildResult;
      try {
        buildResult = await buildDeckByPrice(commander_name, price_limit_usd, min_synergy_pct);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `build_deck_by_price failed: ${e.message}` }] };
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
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Report generation failed: ${e.message}` }] };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ build_source: buildSource, commander_recommendations: commanderRecommendations, ...delivery }, null, 2),
      }],
    };
  },
};

// --- Tool 2: existing_deck_cleanup -----------------------------------------------------------
// Sequence: fetch the decklist (Moxfield URL OR pasted text) -> EDHREC recommendations for the
// primary commander (cleanup/improvement context) -> runChecksAndDeliver (consistency + bracket
// + price; issues double as the cleanup punch-list). Playtest table creation is TEMPORARILY
// DISABLED -- see runChecksAndDeliver's comment. Internally exercises: deck-building/
// moxfield, edhrec/recommendations, deck-building/consistency, bracket/rating, cardkingdom/pricing.
const existingDeckCleanupInputSchema = {
  moxfield_url: z.string().optional().describe("A Moxfield deck URL or bare deck id. Provide this OR decklist_text, not both."),
  decklist_text: z.string().optional().describe("Pasted decklist text ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line)."),
  deck_name: z.string().describe("The deck's name/theme."),
  deck_design_preference: z.string().optional().describe("User's free-text description of what they want cleaned up / improved, if any. Echoed into the report's user-defined-scope section."),
  deck_type: z.string().optional().describe("Format, e.g. 'commander' (default), 'standard', 'modern'."),
  bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the report will flag whether the deck matches it."),
  user_color_preference: z.array(z.string()).optional().describe("Color identity the user asked for, if they mentioned one, e.g. ['W','B']."),
  wincon_summary: z.string().describe("How this deck actually wins. Check combos_found in this response before finalizing."),
  general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn."),
};

const existingDeckCleanupTool: ToolDefinition<typeof existingDeckCleanupInputSchema> = {
  name: "existing_deck_cleanup",
  description:
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
  inputSchema: existingDeckCleanupInputSchema,
  handler: async ({ moxfield_url, decklist_text, deck_name, deck_design_preference, deck_type, bracket_level_requested, user_color_preference, wincon_summary, general_strategy }) => {
    if (!moxfield_url && !decklist_text) {
      return { content: [{ type: "text" as const, text: "Provide either moxfield_url or decklist_text." }] };
    }
    if (moxfield_url && decklist_text) {
      return { content: [{ type: "text" as const, text: "Provide either moxfield_url or decklist_text, not both." }] };
    }

    let resolvedDecklistText = decklist_text;
    let moxfieldMeta: Awaited<ReturnType<typeof getMoxfieldDecklist>> | null = null;
    if (moxfield_url) {
      try {
        moxfieldMeta = await getMoxfieldDecklist(moxfield_url);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `get_moxfield_decklist failed: ${e.message}` }] };
      }
      resolvedDecklistText = moxfieldMeta.decklist_text;
    }

    const { commanderNames } = parsePlaytestDecklist(resolvedDecklistText!);
    let commanderRecommendations: unknown = null;
    if (commanderNames[0]) {
      try {
        commanderRecommendations = await getCommanderRecommendations(commanderNames[0]);
      } catch (e: any) {
        commanderRecommendations = { error: e.message };
      }
    }

    let delivery;
    try {
      delivery = await runChecksAndDeliver({
        decklist_text: resolvedDecklistText!, deck_name, deck_design_preference, deck_type,
        bracket_level_requested, user_color_preference, user_commander_preference: commanderNames[0] ?? null,
        wincon_summary, general_strategy,
      });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Report generation failed: ${e.message}` }] };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          source: moxfield_url ? `Moxfield: ${moxfieldMeta!.deck_name}` : "Pasted decklist_text",
          commander_recommendations: commanderRecommendations,
          ...delivery,
        }, null, 2),
      }],
    };
  },
};

export { newDeckCreationTool, existingDeckCleanupTool };
