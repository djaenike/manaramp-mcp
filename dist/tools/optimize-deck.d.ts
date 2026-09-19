import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/optimize-deck.ts -- optimize_deck
 *
 * Split out of manage_deck (2026-09-18) into an analyze-and-propose half (this tool, NEVER
 * persists) and a persist-and-publish half (publish_deck) -- previously manage_deck wrote to the
 * `decks` collection on EVERY call, including mid-conversation iteration on a decklist nobody had
 * agreed to finalize yet. The intended loop now: call this repeatedly while assembling/tweaking a
 * decklist (real card data + consistency issues + mana curve + combos/synergy facts each time, zero
 * writes), decide what to change based on what it reports, and only call publish_deck once the
 * decklist is actually final. See tools/shared/deck-analysis.ts for the analysis pipeline itself --
 * shared verbatim with publish_deck so the two can't disagree on what "the facts" are.
 *
 * Look up real cards first via search_cards/query_combos/query_synergies rather than guessing from
 * general MTG knowledge -- this tool validates/analyzes whatever decklist_text you give it, it
 * doesn't invent or correct card names on its own beyond reporting not_found.
 */

declare const inputSchema: {
    decklist_text: z.ZodString;
    bracket_estimate: z.ZodOptional<z.ZodString>;
    bracket_level_requested: z.ZodOptional<z.ZodString>;
};
declare const optimizeDeckTool: ToolDefinition<typeof inputSchema>;

export { optimizeDeckTool };
