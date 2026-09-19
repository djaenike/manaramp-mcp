import { z } from "zod";
import { getDeckDoc } from "../functions/query/decks.js";
import { pushDeck } from "../functions/push/deck.js";
import { analyzeDecklist, extractBracketNumber } from "./shared/deck-analysis.js";
const inputSchema = {
  deck_id: z.string().optional().describe("Pass the deck_id read_deck or a PREVIOUS publish_deck call returned to update that exact deck in place, instead of creating a new one. Must belong to the calling account. Omit entirely to create a brand-new deck."),
  decklist_text: z.string().describe("The FINAL, fully-assembled decklist ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line) -- iterate on this via optimize_deck first, this tool re-runs the same analysis and persists the result."),
  deck_name: z.string().describe("The deck's name/theme, e.g. 'Edgar Markov Vampire Tribal'."),
  deck_type: z.string().optional().describe("Format, e.g. 'commander' (default), 'standard', 'modern'."),
  bracket_estimate: z.string().optional().describe("The Commander Bracket (1-5) YOU judge this deck to be, e.g. 'Bracket 3 (Upgraded)' -- based on optimize_deck's returned facts plus the official Commander Bracket System's own criteria."),
  bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the response flags whether bracket_estimate actually matches it."),
  is_public: z.boolean().optional().describe("Whether this deck should be visible to anyone with its manaramp.com/decks/<slug> link (default false, owner-only)."),
  wincon_summary: z.string().describe("How this deck actually wins. Check optimize_deck's combos_found before finalizing -- name real combo pieces if any were found."),
  general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn.")
};
const publishDeckTool = {
  name: "publish_deck",
  description: "Persist a FINAL decklist and get a real, permanent manaramp.com/decks/<slug> link -- the only tool that writes to the user's account. Iterate on the decklist with optimize_deck first; call this ONCE the list is actually final, not on every tweak. Pass deck_id (from read_deck or an earlier publish_deck call) to update that exact deck in place instead of creating a duplicate. Re-runs the same consistency/price/facts analysis optimize_deck does and persists it alongside the decklist -- there is no separate 'just save it' step. Present deck_url directly to the user along with the consistency/price/facts summary this tool returns; there's no separate report artifact to generate.",
  inputSchema,
  handler: async ({ deck_id, decklist_text, deck_name, deck_type, bracket_estimate, bracket_level_requested, is_public, wincon_summary, general_strategy }, ctx) => {
    let existingDeck = null;
    if (deck_id) {
      existingDeck = await getDeckDoc(ctx.writeDb, { deck_id });
      if (!existingDeck) {
        return { content: [{ type: "text", text: `No deck found with deck_id '${deck_id}'.` }] };
      }
      if (existingDeck.owner_user_id !== ctx.ownerUserId) {
        return { content: [{ type: "text", text: `deck_id '${deck_id}' isn't owned by the calling account -- can't edit it.` }] };
      }
    }
    let analysis;
    try {
      analysis = await analyzeDecklist(ctx.readDb, decklist_text);
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
    const { commanderNames, deckEntries, consistency, facts, priceTotal, cardsNotPriced, totalCards } = analysis;
    const commanderOracleIds = commanderNames.map((n) => consistency.card_details.get(n)?.oracle_id).filter((id) => Boolean(id));
    const nonCommanderEntries = deckEntries.filter((e) => !commanderNames.includes(e.name));
    const cardOracleIds = nonCommanderEntries.flatMap((e) => {
      const oracleId = consistency.card_details.get(e.name)?.oracle_id;
      return oracleId ? Array(e.qty).fill(oracleId) : [];
    });
    const deckFields = {
      name: deck_name,
      format: deck_type ?? "commander",
      cards: cardOracleIds,
      sideboard: null,
      size_summary: { main: cardOracleIds.length, sideboard: 0, commander: commanderOracleIds.length, total: totalCards },
      commander: commanderOracleIds.length ? { oracle_ids: commanderOracleIds, color_identity: consistency.commander_color_identity } : null,
      bracket: bracket_estimate || facts.combos_found.length ? { estimate: bracket_estimate ?? null, combos_found: facts.combos_found.map((c) => ({ pieces: c.pieces, speed: c.speed })) } : null,
      mana_curve: consistency.mana_curve,
      curve_out_probability: consistency.curve_out_probability,
      consistency_issues: consistency.issues,
      price_usd: priceTotal,
      price_fetched_at: /* @__PURE__ */ new Date(),
      wincon_summary,
      general_strategy,
      source: "publish_deck"
    };
    const { deck_id: deckIdToReturn, slug } = await pushDeck(ctx.writeDb, ctx.ownerUserId, deckFields, existingDeck, { is_public });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          deck_id: deckIdToReturn,
          deck_url: `https://manaramp.com/decks/${slug}`,
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
  publishDeckTool
};
