import { z } from "zod";
import { analyzeDecklist, extractBracketNumber } from "./shared/deck-analysis.js";
const inputSchema = {
  decklist_text: z.string().describe("A fully-assembled decklist ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line) to analyze -- nothing is persisted by this tool. Look up real card names first via search_cards/query_combos/query_synergies rather than guessing; not_found in this tool's response will flag anything unresolved so you can fix spelling or swap the card before calling again."),
  bracket_estimate: z.string().optional().describe("If you've already judged a Commander Bracket (1-5) for this list, pass it here to cross-check against bracket_level_requested -- this tool never computes one itself, only the raw facts (game_changers_found/mass_land_denial_found/extra_turns_found/combos_found) needed to judge it."),
  bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the response flags whether bracket_estimate actually matches it (only meaningful once bracket_estimate is also given).")
};
const optimizeDeckTool = {
  name: "optimize_deck",
  description: "Analyze a decklist -- consistency (card count, singleton, color identity, Commander legality), mana curve, curve-out probability, price, and Game Changer/mass land denial/extra turn/combo/tutor/ramp/token/counterspell/recursion facts -- WITHOUT persisting or publishing anything. Call this as many times as you want while assembling or tweaking a decklist; nothing is saved to the user's account until you separately call publish_deck with the final list. game_changers_found/mass_land_denial_found/extra_turns_found/combos_found are raw facts, NOT a bracket verdict -- judge the actual Commander Bracket (1-5) yourself from those facts plus the official Bracket System's own criteria. tutors_found/land_ramp_found/extra_land_drops_found/token_generators_found/counterspells_found/recursion_found are the same kind of raw per-card fact, Forge-derived, for judging whether the deck has real interaction/card advantage/ramp -- not just what a wincon summary claims. combos_found's total_cmc/unresolved_piece_names: when unresolved_piece_names is non-empty, total_cmc is a floor (some pieces aren't in manaramp's card database yet), not a confirmed total. Editing an EXISTING deck? Call read_deck first to get its current decklist_text as your starting point, then iterate here before publish_deck.",
  inputSchema,
  handler: async ({ decklist_text, bracket_estimate, bracket_level_requested }, ctx) => {
    let analysis;
    try {
      analysis = await analyzeDecklist(ctx.readDb, decklist_text);
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
    const { consistency, facts, priceTotal, cardsNotPriced, totalCards } = analysis;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          consistency_issues: consistency.issues,
          not_found: consistency.not_found,
          game_changers_found: facts.game_changers_found,
          mass_land_denial_found: facts.mass_land_denial_found,
          extra_turns_found: facts.extra_turns_found,
          combos_found: facts.combos_found,
          tutors_found: facts.tutors_found,
          land_ramp_found: facts.land_ramp_found,
          extra_land_drops_found: facts.extra_land_drops_found,
          token_generators_found: facts.token_generators_found,
          counterspells_found: facts.counterspells_found,
          recursion_found: facts.recursion_found,
          bracket_estimate: bracket_estimate ?? null,
          bracket_level_matches_request: bracket_estimate && bracket_level_requested ? extractBracketNumber(bracket_level_requested) === extractBracketNumber(bracket_estimate) : null,
          price_usd: priceTotal,
          cards_not_priced: cardsNotPriced.length ? cardsNotPriced : void 0,
          mana_curve: consistency.mana_curve,
          curve_out_probability: consistency.curve_out_probability,
          total_cards: totalCards
        }, null, 2)
      }]
    };
  }
};
export {
  optimizeDeckTool
};
