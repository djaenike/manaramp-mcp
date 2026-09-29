import { z } from "zod";
import { analyzeDecklist, extractBracketNumber, toDecklistText } from "./shared/deck-analysis.js";
import { saveDecklist } from "./shared/save-deck.js";
import { getDraft } from "../functions/push/deck-drafts.js";
const inputSchema = {
  draft_id: z.string().optional().describe("An unsaved fill_deck_plan draft to submit (with swaps)."),
  swaps: z.array(z.object({ out: z.string().optional(), in: z.string().optional() })).optional().describe("{ out, in } replaces (keeps the quantity), out alone removes, in alone adds 1."),
  decklist_text: z.string().optional().describe("Or a full decklist: 'Commander' section, blank line, 'Deck' section, '<qty> <name>' lines."),
  submit: z.boolean().optional().describe("true saves it (needs deck_name, wincon_summary, general_strategy); default false only checks."),
  deck_id: z.string().optional().describe("With submit: update this deck in place."),
  deck_name: z.string().optional(),
  deck_type: z.string().optional().describe("Format, default 'commander'."),
  bracket_estimate: z.string().optional().describe("Your bracket judgment -- saved as the deck's bracket."),
  bracket_level_requested: z.string().optional().describe("The bracket the user asked for, to check against bracket_estimate."),
  is_public: z.boolean().optional(),
  wincon_summary: z.string().optional(),
  general_strategy: z.string().optional()
};
const validateAndSubmitTool = {
  name: "validate_and_submit",
  description: "Check a decklist (card count, singleton, color identity, legality, curve, price, per-card facts like combos/tutors/ramp/draw/removal) and, with submit:true, save it. fill_deck_plan already saves -- use this only for a fill that came back unsaved (pass its draft_id + swaps + submit:true) or a hand-written decklist_text. Facts are raw, not verdicts: judge the Commander bracket yourself and pass bracket_estimate. Updating a deck: pass its deck_id.",
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
    let analysis;
    let priceSource;
    let deckIdToReturn;
    let deckUrl;
    if (submit) {
      const result = await saveDecklist(ctx, {
        decklist_text,
        deck_name,
        format: deck_type ?? "commander",
        wincon_summary,
        general_strategy,
        bracket_estimate,
        is_public,
        deck_id,
        prompt_id: promptId,
        constraints: draftConstraints,
        source: draft_id ? "fill_deck_plan" : "validate_and_submit"
      });
      if (!result.saved) return { content: [{ type: "text", text: result.error ?? "Couldn't save the deck." }] };
      analysis = result.analysis;
      priceSource = result.priceSource;
      deckIdToReturn = result.deck_id;
      deckUrl = result.deck_url;
    } else {
      priceSource = await ctx.getPriceSourcePreference?.() ?? "cardkingdom";
      try {
        analysis = await analyzeDecklist(ctx.readDb, decklist_text, priceSource);
      } catch (e) {
        return { content: [{ type: "text", text: e.message }] };
      }
    }
    const { consistency, facts, priceTotal, cardsNotPriced, totalCards } = analysis;
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
