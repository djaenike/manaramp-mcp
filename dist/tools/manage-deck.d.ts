import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/manage-deck.ts -- manage_deck
 *
 * THE primary, only conversational deck tool (2026-09-17, sixth pass -- query_cards/
 * query_synergies/query_combos/query_decks/query_draft_results/push_game_log/push_draft_result all
 * stopped being separate registered tools this pass; see tools/index.ts's header). This tool
 * decides which functions/ it needs and which of their fields matter, and is the ONLY place a
 * calling model reaches deck data or persistence -- there's no more standalone card/synergy/combo
 * lookup tool to call first. Build decklist_text from your own MTG knowledge, then use THIS tool's
 * own returned facts (consistency_issues, not_found, price_usd, game_changers_found,
 * combos_found, ...) to refine it on a follow-up call with the same deck_id -- that feedback loop
 * replaces the old query_cards/query_synergies/query_combos pre-research step.
 *
 * Calls functions/query/cards.ts's queryCards ONCE for every commander/deck-entry name, then does
 * its own price-summing and passes the result straight into functions/reference/deck-validation.ts's
 * PURE validateDeck (no Mongo access of its own -- see that file's header) -- there's no separate
 * "pricing" or "consistency-lookup" module each running a second/third independent `cards` query.
 * functions/reference/bracket-facts.ts's gatherDeckFacts is the one remaining call that still needs
 * `db` directly (combo detection). Persistence itself is functions/push/deck.ts's pushDeck -- this
 * file only builds the fields to persist, it doesn't touch the `decks` collection directly.
 *
 * No auto-build-by-price, no bracket-tier decision (dropped in the round-2 consolidation -- see
 * CLAUDE.md): bracket_estimate is an INPUT field the calling model supplies after seeing this tool's
 * returned facts, same pattern wincon_summary/general_strategy always used.
 *
 * Reading an EXISTING deck: pass deck_id alone (no decklist_text) to load that deck's current cards
 * from Mongo as the starting point for an edit -- via functions/query/decks.ts's queryDeckDetail.
 *
 * Persistence + ownership: every call is authenticated (API keys are mandatory at account
 * creation), so ctx.ownerUserId is always a real users._id. Passing deck_id updates that exact deck
 * IN PLACE (after verifying it's actually owned by the caller); omitting it always inserts a fresh
 * deck. The tool always returns deck_id so a follow-up call can pass it back.
 */

declare const inputSchema: {
    deck_id: z.ZodOptional<z.ZodString>;
    decklist_text: z.ZodOptional<z.ZodString>;
    deck_name: z.ZodString;
    deck_type: z.ZodOptional<z.ZodString>;
    bracket_estimate: z.ZodOptional<z.ZodString>;
    bracket_level_requested: z.ZodOptional<z.ZodString>;
    is_public: z.ZodOptional<z.ZodBoolean>;
    wincon_summary: z.ZodString;
    general_strategy: z.ZodString;
};
declare const manageDeckTool: ToolDefinition<typeof inputSchema>;

export { manageDeckTool };
