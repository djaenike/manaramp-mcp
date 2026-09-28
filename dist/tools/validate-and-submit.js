import { z } from "zod";
import { getDeckDoc } from "../functions/query/decks.js";
import { pushDeck } from "../functions/push/deck.js";
import { analyzeDecklist, extractBracketNumber, toDecklistText } from "./shared/deck-analysis.js";
import { getDraft } from "../functions/push/deck-drafts.js";
import { markPromptBuilt } from "../functions/query/deck-prompts.js";
const inputSchema = {
  draft_id: z.string().optional().describe("The draft_id fill_deck_plan returned -- submit that server-held list (plus `swaps`) instead of typing a decklist. Preferred whenever you have one."),
  swaps: z.array(z.object({ out: z.string().optional().describe("Card name to remove from the draft."), in: z.string().optional().describe("Card name to add (an alternate, or any real card).") })).optional().describe("Changes to the draft before validating: { out, in } replaces (the new card takes the old one's quantity), out alone removes, in alone adds 1."),
  decklist_text: z.string().optional().describe("A fully-assembled decklist ('Commander' section, blank line, 'Deck' section, one '<qty> <name>' per line). Look up real card names first via query_cards/query_combos/query_synergies rather than guessing; not_found in this tool's response flags anything unresolved so you can fix spelling or swap the card before calling again."),
  submit: z.boolean().optional().describe("Default false: validate/analyze only, nothing persisted -- call this as many times as needed while assembling or tweaking the decklist. true: persist this as the FINAL decklist (requires deck_name/wincon_summary/general_strategy) and return a real manaramp.com/decks/<slug> link -- call this once, not on every tweak."),
  deck_id: z.string().optional().describe("Only meaningful with submit:true. Pass the deck_id read_deck or a previous submit:true call returned to update that exact deck in place instead of creating a new one. Must belong to the calling account."),
  deck_name: z.string().optional().describe("Required when submit:true. The deck's name/theme, e.g. 'Edgar Markov Vampire Tribal'."),
  deck_type: z.string().optional().describe("Format, e.g. 'commander' (default), 'standard', 'modern'. Only used when submit:true."),
  bracket_estimate: z.string().optional().describe("If you've judged a Commander Bracket (1-5) for this list -- see format_guidelines for the real official criteria per bracket -- pass it here. This tool never computes one itself, only the raw facts needed to judge it. With submit:true, this is also what gets persisted as the deck's bracket rating (omit it and no bracket rating is saved, even if combos were found)."),
  bracket_level_requested: z.string().optional().describe("If the user asked for a specific Commander bracket (e.g. 'Bracket 3'), pass it here -- the response flags whether bracket_estimate actually matches it (only meaningful once bracket_estimate is also given)."),
  is_public: z.boolean().optional().describe("Only used when submit:true. Whether this deck should be visible to anyone with its manaramp.com/decks/<slug> link (default false, owner-only)."),
  wincon_summary: z.string().optional().describe("Required when submit:true. How this deck actually wins -- ground this in the real facts this tool returns (combos_found, card_draw_found, land_ramp_found, etc, whichever are actually relevant), not assumptions."),
  general_strategy: z.string().optional().describe("Required when submit:true. A short paragraph on how to actually pilot the deck turn to turn.")
};
const validateAndSubmitTool = {
  name: "validate_and_submit",
  description: "Check a decklist -- consistency (card count, singleton, color identity, Commander legality), mana curve, price and per-card facts -- and, with submit:true, save it. After fill_deck_plan, pass its draft_id plus any swaps (never retype the list) and submit:true in ONE call. Details: mana curve, curve-out probability, price, and real per-card facts (game_changers_found/mass_land_denial_found/extra_turns_found/combos_found/tutors_found/land_ramp_found/extra_land_drops_found/token_generators_found/counterspells_found/recursion_found/card_draw_found/removal_found) -- and, with submit:true, persist it. See format_guidelines for target composition/bracket-rule context to assemble AGAINST before calling this; this tool only ever reports facts about a decklist you already have. Every *_found list is a raw fact, not a verdict -- judge the actual Commander Bracket (1-5) yourself from those facts plus format_guidelines' real criteria, and pass it as bracket_estimate. combos_found's total_cmc/unresolved_piece_names: when unresolved_piece_names is non-empty, total_cmc is a floor (some pieces aren't in manaramp's card database yet). Editing an EXISTING deck? Call read_deck first for its current decklist_text, iterate here with submit:false, then submit:true once with the same deck_id.",
  inputSchema,
  handler: async ({ draft_id, swaps, decklist_text: decklistTextArg, submit, deck_id, deck_name: deckNameArg, deck_type: deckTypeArg, bracket_estimate, bracket_level_requested, is_public, wincon_summary, general_strategy }, ctx) => {
    let decklist_text = decklistTextArg;
    let deck_name = deckNameArg;
    let deck_type = deckTypeArg;
    let promptId = null;
    let draftConstraints = null;
    const swapNotes = [];
    if (draft_id) {
      const draft = await getDraft(ctx.writeDb, draft_id, ctx.ownerUserId);
      if (!draft) return { content: [{ type: "text", text: `No draft '${draft_id}' for this account (drafts expire after 7 days) -- run fill_deck_plan again.` }] };
      const entries = /* @__PURE__ */ new Map();
      for (const e of [...draft.slots.flatMap((sl) => sl.picks), ...draft.basics]) {
        const key = e.name.toLowerCase();
        entries.set(key, { name: e.name, qty: (entries.get(key)?.qty ?? 0) + e.qty });
      }
      for (const sw of swaps ?? []) {
        let qty = 1;
        if (sw.out) {
          const hit = entries.get(sw.out.toLowerCase());
          if (hit) {
            qty = hit.qty;
            entries.delete(sw.out.toLowerCase());
          } else swapNotes.push(`'${sw.out}' wasn't in the draft -- nothing removed`);
        }
        if (sw.in) {
          const key = sw.in.toLowerCase();
          entries.set(key, { name: entries.get(key)?.name ?? sw.in, qty: (entries.get(key)?.qty ?? 0) + qty });
        }
      }
      decklist_text = toDecklistText(draft.commander ? [draft.commander.name] : [], [...entries.values()]);
      deck_name ??= draft.deck_name ?? void 0;
      deck_type ??= draft.format;
      promptId = draft.prompt_id;
      draftConstraints = draft.constraints;
    }
    if (!decklist_text) {
      return { content: [{ type: "text", text: "Pass draft_id (from fill_deck_plan) or decklist_text." }] };
    }
    if (submit && (!deck_name || !wincon_summary || !general_strategy)) {
      return { content: [{ type: "text", text: "submit:true requires deck_name, wincon_summary, and general_strategy." }] };
    }
    let existingDeck = null;
    if (submit && deck_id) {
      existingDeck = await getDeckDoc(ctx.writeDb, { deck_id });
      if (!existingDeck) {
        return { content: [{ type: "text", text: `No deck found with deck_id '${deck_id}'.` }] };
      }
      if (existingDeck.owner_user_id !== ctx.ownerUserId) {
        return { content: [{ type: "text", text: `deck_id '${deck_id}' isn't owned by the calling account -- can't edit it.` }] };
      }
    }
    const priceSource = await ctx.getPriceSourcePreference?.() ?? "cardkingdom";
    let analysis;
    try {
      analysis = await analyzeDecklist(ctx.readDb, decklist_text, priceSource);
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
    const { commanderNames, deckEntries, consistency, facts, priceTotal, cardsNotPriced, totalCards } = analysis;
    let deckIdToReturn;
    let deckUrl;
    if (submit) {
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
        // Only ever written when the calling model actually judged a bracket -- no longer
        // auto-triggered by combos_found alone (that was itself part of the combo-heavy bias this
        // tool replaced optimize_deck/publish_deck to fix).
        bracket: bracket_estimate ? { estimate: bracket_estimate, combos_found: facts.combos_found.map((c) => ({ pieces: c.pieces, speed: c.speed })) } : null,
        mana_curve: consistency.mana_curve,
        curve_out_probability: consistency.curve_out_probability,
        consistency_issues: consistency.issues,
        price_usd: priceTotal,
        price_fetched_at: /* @__PURE__ */ new Date(),
        wincon_summary,
        general_strategy,
        source: draft_id ? "fill_deck_plan" : "validate_and_submit",
        ...promptId ? { prompt_id: promptId, constraints: draftConstraints } : {}
      };
      const pushed = await pushDeck(ctx.writeDb, ctx.ownerUserId, deckFields, existingDeck, { is_public });
      deckIdToReturn = pushed.deck_id;
      deckUrl = `https://manaramp.com/decks/${pushed.slug}`;
      if (promptId) await markPromptBuilt(ctx.writeDb, promptId, pushed.deck_id);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          deck_id: deckIdToReturn,
          deck_url: deckUrl,
          swap_notes: swapNotes.length ? swapNotes : void 0,
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
          card_draw_found: facts.card_draw_found,
          removal_found: facts.removal_found,
          bracket_estimate: bracket_estimate ?? null,
          bracket_level_matches_request: bracket_estimate && bracket_level_requested ? extractBracketNumber(bracket_level_requested) === extractBracketNumber(bracket_estimate) : null,
          price_usd: priceTotal,
          price_source: priceSource,
          cards_not_priced: cardsNotPriced.length ? cardsNotPriced : void 0,
          mana_curve: consistency.mana_curve,
          curve_out_probability: consistency.curve_out_probability,
          total_cards: totalCards
        })
      }]
    };
  }
};
export {
  validateAndSubmitTool
};
