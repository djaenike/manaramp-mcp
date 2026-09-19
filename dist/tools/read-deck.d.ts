import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/read-deck.ts -- read_deck
 *
 * New (2026-09-18), split out alongside optimize_deck/publish_deck: the read-only counterpart --
 * list the calling account's decks, or load one specific deck's full detail (real card
 * names/mana costs/images resolved, plus a ready-to-paste decklist_text) as the starting point for
 * an edit. Previously this was folded into manage_deck (pass deck_id alone, no decklist_text) --
 * now a standalone tool so "show me my decks" / "let's edit X" doesn't require pretending to also
 * want to run the full analyze-or-publish pipeline. Wraps functions/query/decks.ts's
 * queryDeckList/queryDeckDetail -- no query logic of its own.
 */

declare const inputSchema: {
    deck_id: z.ZodOptional<z.ZodString>;
    slug: z.ZodOptional<z.ZodString>;
};
declare const readDeckTool: ToolDefinition<typeof inputSchema>;

export { readDeckTool };
