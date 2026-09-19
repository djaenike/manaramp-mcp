import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/publish-deck.ts -- publish_deck
 *
 * The persist-and-publish half of the old manage_deck (split 2026-09-18, see optimize-deck.ts's
 * header for why). This is the ONLY tool that writes to the `decks` collection -- call optimize_deck
 * as many times as needed first to iterate on decklist_text, then call this ONCE with the final list
 * to actually save it and get a real manaramp.com/decks/<slug> link. Re-runs the exact same analysis
 * pipeline optimize_deck uses (tools/shared/deck-analysis.ts) rather than trusting a stale result
 * from an earlier optimize_deck call, since the decklist may have changed since then.
 *
 * Reading an EXISTING deck to edit: use read_deck to get its current decklist_text and deck_id
 * first, iterate via optimize_deck, then call this with that SAME deck_id to update it in place
 * instead of creating a duplicate.
 */

declare const inputSchema: {
    deck_id: z.ZodOptional<z.ZodString>;
    decklist_text: z.ZodString;
    deck_name: z.ZodString;
    deck_type: z.ZodOptional<z.ZodString>;
    bracket_estimate: z.ZodOptional<z.ZodString>;
    bracket_level_requested: z.ZodOptional<z.ZodString>;
    is_public: z.ZodOptional<z.ZodBoolean>;
    wincon_summary: z.ZodString;
    general_strategy: z.ZodString;
};
declare const publishDeckTool: ToolDefinition<typeof inputSchema>;

export { publishDeckTool };
