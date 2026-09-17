import { z } from "zod";
import { queryCards } from "../functions/query/cards.js";
import { getDeckDoc, queryDeckDetail } from "../functions/query/decks.js";
import { pushDeck } from "../functions/push/deck.js";
import { parseDecklistText } from "../functions/parsing/decklist-parser.js";
import { validateDeck } from "../functions/reference/deck-validation.js";
import { gatherDeckFacts } from "../functions/reference/bracket-facts.js";
const inputSchema = {
  deck_id: z.string().optional().describe("Pass the deck_id a PREVIOUS manage_deck call returned to update that exact deck in place, instead of creating a new one -- do this on every follow-up edit within a conversation. If given WITHOUT decklist_text, this loads the deck's CURRENT cards from manaramp as the starting point (read-and-validate, nothing changes unless a follow-up call also passes an updated decklist_text). Omit entirely to create a brand-new deck. Must belong to the calling account."),
  decklist_text: z.string().optional().describe("A fully-assembled decklist ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line) to validate, price, and persist. Build this yourself from your own MTG knowledge -- paste a Moxfield or other text export here directly if the user has one, there's no separate import step. Not found in manaramp's database yet? not_found in this tool's response will say so; fix spelling or swap the card on a follow-up call. Required unless deck_id alone is given to load an existing deck."),
  deck_name: z.string().describe("The deck's name/theme, e.g. 'Edgar Markov Vampire Tribal'."),
  deck_type: z.string().optional().describe("Format, e.g. 'commander' (default), 'standard', 'modern'."),
  bracket_estimate: z.string().optional().describe("The Commander Bracket (1-5) YOU judge this deck to be, e.g. 'Bracket 3 (Upgraded)' -- this tool does not compute one itself, it only returns the raw facts (game_changers_found, mass_land_denial_found, extra_turns_found, combos_found) needed to judge it. Typically set on a FOLLOW-UP call (same deck_id) once you've seen those facts from a first call, using the official Commander Bracket System's own criteria."),
  bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the response flags whether bracket_estimate actually matches it (only meaningful once bracket_estimate is also given)."),
  is_public: z.boolean().optional().describe("Whether this deck should be visible to anyone with its manaramp.com/decks/<slug> link (default false, owner-only)."),
  wincon_summary: z.string().describe("How this deck actually wins. Check combos_found in this response before finalizing -- name real combo pieces if any were found."),
  general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn.")
};
function extractBracketNumber(s) {
  const m = String(s ?? "").match(/\d+/);
  return m ? m[0] : null;
}
const manageDeckTool = {
  name: "manage_deck",
  description: "Create a new deck, or read/update an existing one, end-to-end -- any format, but the consistency checks here are EDH-specific. Every result is PERSISTED to manaramp under the calling account and gets a real permanent link -- pass the deck_id this tool returns back into a follow-up call to keep editing the SAME deck instead of creating a duplicate; omit it to start a new one. BUILD decklist_text yourself first from your own MTG knowledge -- this tool does not auto-build a deck from a commander name alone, and there is no separate card/synergy/combo lookup tool to call first; use THIS tool's own returned facts (consistency_issues/not_found/price_usd/game_changers_found/combos_found) to refine the list on a follow-up call with the same deck_id instead. Two ways to call this: (1) pass decklist_text to validate/persist it. (2) pass ONLY deck_id (no decklist_text) to READ an existing deck's current cards from manaramp as the starting point for editing -- nothing changes until a follow-up call also passes an updated decklist_text with the same deck_id. Either way, runs consistency checks (card count, singleton, color identity, Commander legality) and price total, and ALWAYS persists a result -- there is no pass/fail gate; consistency_issues lists anything wrong. game_changers_found/mass_land_denial_found/extra_turns_found/combos_found are raw facts, NOT a bracket verdict -- judge the actual Commander Bracket (1-5) yourself from those facts plus the official Bracket System's own criteria, and pass it as bracket_estimate (typically on a follow-up call, once you've seen this call's facts). tutors_found/land_ramp_found/extra_land_drops_found/token_generators_found/counterspells_found/recursion_found are the same kind of raw per-card fact, Forge-derived (github.com/Card-Forge/forge) rather than a bracket concern -- use them to judge whether the deck actually has real interaction/card advantage/ramp, not just what wincon_summary claims. deck_url (manaramp.com/decks/<slug>) is the deck's permanent link, immediately owned by the calling account -- present it directly to the user, along with the consistency/price/facts summary this tool returns; there's no separate report artifact to generate or reformat.",
  inputSchema,
  handler: async ({
    deck_id,
    decklist_text,
    deck_name,
    deck_type,
    bracket_estimate,
    bracket_level_requested,
    is_public,
    wincon_summary,
    general_strategy
  }, ctx) => {
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
    let resolvedDecklistText = decklist_text;
    if (!resolvedDecklistText && existingDeck) {
      resolvedDecklistText = (await queryDeckDetail(ctx.readDb, existingDeck)).decklist_text;
    }
    if (!resolvedDecklistText) {
      return { content: [{ type: "text", text: "Provide decklist_text, or deck_id alone to load an existing deck." }] };
    }
    const { commanderNames, deckEntries } = parseDecklistText(resolvedDecklistText);
    if (!commanderNames.length || !deckEntries.length) {
      return { content: [{ type: "text", text: "Couldn't parse a commander and deck from the decklist -- check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting." }] };
    }
    const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
    const allIdentifierNames = Array.from(/* @__PURE__ */ new Set([...commanderNames, ...uniqueDeckNames]));
    const cards = await queryCards(ctx.readDb, { names: allIdentifierNames });
    const facts = await gatherDeckFacts(ctx.readDb, commanderNames, uniqueDeckNames, cards);
    const consistency = validateDeck(cards, commanderNames, deckEntries);
    const priceByNameLower = new Map(cards.map((c) => [c.name.toLowerCase(), c.price_usd]));
    let priceTotal = 0;
    const cardsNotPriced = [];
    for (const name of commanderNames) {
      const p = priceByNameLower.get(name.toLowerCase());
      if (p == null) cardsNotPriced.push(name);
      else priceTotal += p;
    }
    for (const entry of deckEntries) {
      const p = priceByNameLower.get(entry.name.toLowerCase());
      if (p == null) {
        for (let i = 0; i < entry.qty; i++) cardsNotPriced.push(entry.name);
      } else priceTotal += p * entry.qty;
    }
    priceTotal = Math.round(priceTotal * 100) / 100;
    const commanderOracleIds = commanderNames.map((n) => consistency.card_details.get(n)?.oracle_id).filter((id) => Boolean(id));
    const nonCommanderEntries = deckEntries.filter((e) => !commanderNames.includes(e.name));
    const cardOracleIds = nonCommanderEntries.flatMap((e) => {
      const oracleId = consistency.card_details.get(e.name)?.oracle_id;
      return oracleId ? Array(e.qty).fill(oracleId) : [];
    });
    const totalCards = commanderNames.length + deckEntries.reduce((s, e) => s + e.qty, 0);
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
      source: "manage_deck"
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
  manageDeckTool
};
