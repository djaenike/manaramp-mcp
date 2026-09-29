/**
 * tools/validate-and-submit.ts -- validate_and_submit
 *
 * Replaces optimize_deck + publish_deck (2026-09-22, retired -- see git history for their own
 * headers if the prior split is ever needed for reference). Real feedback on the old pair: deck
 * building leaned too combo-oriented -- combos_found got far more elaboration (permalink/steps/
 * speed) and far more directive prompting ("check combos_found before finalizing wincon_summary")
 * than any of the other *_found fact categories, with nothing giving the calling model an
 * equally-weighted sense of what a well-built deck's general shape looks like. Two changes fix that:
 *   1. format_guidelines is a NEW companion tool -- call it for target composition/bracket-rule
 *      context BEFORE/WHILE assembling a decklist with query_cards/query_combos/query_synergies.
 *      This tool only ever reports facts about a decklist you already have, same as before.
 *   2. Two new fact categories, card_draw_found/removal_found (functions/reference/bracket-facts.ts),
 *      sit alongside combos_found/tutors_found/land_ramp_found/etc with equal weight -- nothing in
 *      this tool's own code or description singles combos out anymore. bracket persistence (see
 *      `submit` below) no longer auto-triggers off combos_found alone either -- only an explicit
 *      bracket_estimate writes one, the same "you judge, this tool only supplies facts" rule
 *      bracket_estimate itself has always followed.
 *
 * The OLD optimize_deck/publish_deck split (analyze-repeatedly-without-saving vs. persist-once) is
 * preserved here as a single tool with a `submit` flag rather than two tools, specifically so it
 * can't regress into the even older manage_deck problem this package already fixed once (manage_deck
 * persisted on EVERY call, including mid-conversation iteration nobody had asked to save -- see
 * tools/index.ts's own header for that history). Default `submit: false`: call this as many times as
 * needed while assembling/tweaking a decklist, nothing is saved. Pass `submit: true` (plus
 * deck_name/wincon_summary/general_strategy) exactly once, when the list is actually final, to
 * persist it and get a real manaramp.com/decks/<slug> link -- the only path in this tool that writes
 * anywhere.
 */

import { z } from "zod";
import { analyzeDecklist, extractBracketNumber, toDecklistText } from "./shared/deck-analysis.js";
import { saveDecklist } from "./shared/save-deck.js";
import { getDraft } from "../functions/push/deck-drafts.js";
import type { DeckPromptConstraints } from "../functions/query/deck-prompts.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  draft_id: z.string().optional().describe("An unsaved fill_deck_plan draft to submit (with swaps)."),
  swaps: z
    .array(z.object({ out: z.string().optional(), in: z.string().optional() }))
    .optional()
    .describe("{ out, in } replaces (keeps the quantity), out alone removes, in alone adds 1."),
  decklist_text: z.string().optional().describe("Or a full decklist: 'Commander' section, blank line, 'Deck' section, '<qty> <name>' lines."),
  submit: z.boolean().optional().describe("true saves it (needs deck_name, wincon_summary, general_strategy); default false only checks."),
  deck_id: z.string().optional().describe("With submit: update this deck in place."),
  deck_name: z.string().optional(),
  deck_type: z.string().optional().describe("Format, default 'commander'."),
  bracket_estimate: z.string().optional().describe("Your bracket judgment -- saved as the deck's bracket."),
  bracket_level_requested: z.string().optional().describe("The bracket the user asked for, to check against bracket_estimate."),
  is_public: z.boolean().optional(),
  wincon_summary: z.string().optional(),
  general_strategy: z.string().optional(),
};

const validateAndSubmitTool: ToolDefinition<typeof inputSchema> = {
  name: "validate_and_submit",
  description:
    "Check a decklist (card count, singleton, color identity, legality, curve, price, per-card facts like " +
    "combos/tutors/ramp/draw/removal) and, with submit:true, save it. fill_deck_plan already saves -- use this only for a " +
    "fill that came back unsaved (pass its draft_id + swaps + submit:true) or a hand-written decklist_text. Facts are raw, " +
    "not verdicts: judge the Commander bracket yourself and pass bracket_estimate. Updating a deck: pass its deck_id.",
  inputSchema,
  handler: async (
    { draft_id, swaps, decklist_text: decklistTextArg, submit, deck_id, deck_name: deckNameArg, deck_type: deckTypeArg, bracket_estimate, bracket_level_requested, is_public, wincon_summary, general_strategy },
    ctx
  ) => {
    // draft_id path (2026-09-27): the list comes from fill_deck_plan's stored draft plus swaps, so the
    // model never retypes ~100 lines. Same analysis as a pasted decklist from here on.
    let decklist_text = decklistTextArg;
    let deck_name = deckNameArg;
    let deck_type = deckTypeArg;
    let promptId: string | null = null;
    let draftConstraints: DeckPromptConstraints | null = null;
    const swapNotes: string[] = [];
    if (draft_id) {
      const draft = await getDraft(ctx.writeDb, draft_id, ctx.ownerUserId);
      if (!draft) return { content: [{ type: "text" as const, text: `No draft '${draft_id}' for this account (drafts expire after 7 days) -- run fill_deck_plan again.` }] };
      const entries = new Map<string, { name: string; qty: number }>();
      for (const e of [...draft.slots.flatMap((sl) => sl.picks), ...draft.basics]) {
        const key = e.name.toLowerCase();
        entries.set(key, { name: e.name, qty: (entries.get(key)?.qty ?? 0) + e.qty });
      }
      for (const sw of swaps ?? []) {
        let qty = 1;
        if (sw.out) {
          const hit = entries.get(sw.out.toLowerCase());
          if (hit) { qty = hit.qty; entries.delete(sw.out.toLowerCase()); } else swapNotes.push(`'${sw.out}' wasn't in the draft -- nothing removed`);
        }
        if (sw.in) {
          const key = sw.in.toLowerCase();
          entries.set(key, { name: entries.get(key)?.name ?? sw.in, qty: (entries.get(key)?.qty ?? 0) + qty });
        }
      }
      decklist_text = toDecklistText(draft.commander ? [draft.commander.name] : [], [...entries.values()]);
      deck_name ??= draft.deck_name ?? undefined;
      deck_type ??= draft.format;
      promptId = draft.prompt_id;
      draftConstraints = draft.constraints;
    }
    if (!decklist_text) {
      return { content: [{ type: "text" as const, text: "Pass draft_id (from fill_deck_plan) or decklist_text." }] };
    }

    if (submit && (!deck_name || !wincon_summary || !general_strategy)) {
      return { content: [{ type: "text" as const, text: "submit:true requires deck_name, wincon_summary, and general_strategy." }] };
    }

    // Saving goes through the shared path (tools/shared/save-deck.ts) -- the same one fill_deck_plan's
    // direct save uses, so both store a deck identically.
    let analysis;
    let priceSource: string;
    let deckIdToReturn: string | undefined;
    let deckUrl: string | undefined;
    if (submit) {
      const result = await saveDecklist(ctx, {
        decklist_text,
        deck_name: deck_name!,
        format: deck_type ?? "commander",
        wincon_summary: wincon_summary!,
        general_strategy: general_strategy!,
        bracket_estimate,
        is_public,
        deck_id,
        prompt_id: promptId,
        constraints: draftConstraints,
        source: draft_id ? "fill_deck_plan" : "validate_and_submit",
      });
      if (!result.saved) return { content: [{ type: "text" as const, text: result.error ?? "Couldn't save the deck." }] };
      analysis = result.analysis;
      priceSource = result.priceSource;
      deckIdToReturn = result.deck_id;
      deckUrl = result.deck_url;
    } else {
      // Falls back to 'cardkingdom' for a legacy account with no preference saved yet, AND for a
      // local-stdio call where ctx has no such getter at all -- see tools/types.ts's McpContext.
      priceSource = (await ctx.getPriceSourcePreference?.()) ?? "cardkingdom";
      try {
        analysis = await analyzeDecklist(ctx.readDb, decklist_text, priceSource as "cardkingdom" | "manapool");
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: e.message }] };
      }
    }
    const { consistency, facts, priceTotal, cardsNotPriced, totalCards } = analysis;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          deck_id: deckIdToReturn,
          deck_url: deckUrl,
          swap_notes: swapNotes.length ? swapNotes : undefined,
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
          bracket_level_matches_request: bracket_estimate && bracket_level_requested
            ? extractBracketNumber(bracket_level_requested) === extractBracketNumber(bracket_estimate)
            : null,
          price_usd: priceTotal,
          price_source: priceSource,
          cards_not_priced: cardsNotPriced.length ? cardsNotPriced : undefined,
          mana_curve: consistency.mana_curve,
          curve_out_probability: consistency.curve_out_probability,
          total_cards: totalCards,
        }),
      }],
    };
  },
};

export { validateAndSubmitTool };
