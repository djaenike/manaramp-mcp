import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/format-guidelines.ts -- format_guidelines
 *
 * Added 2026-09-22 alongside validate_and_submit (see that tool's own header for the full context):
 * real user feedback was that deck building here leaned too combo-oriented -- validate_and_submit
 * (and its predecessors optimize_deck/publish_deck) gave combos_found far more elaboration
 * (permalink/steps/speed) than any other fact category, with no equally-weighted reference for what
 * a GOOD deck's general shape looks like. This tool is pure reference data -- no deck required, no
 * database query -- meant to be called BEFORE/WHILE assembling a decklist (alongside query_cards/
 * query_combos/query_synergies for actual card lookups), not after. It never judges a specific
 * decklist; validate_and_submit still does that, from real card facts.
 *
 * Same "give real facts, let the calling model judge/build" pattern the whole deck-building tool set
 * already follows (bracket_estimate has always been an INPUT the model fills in, never computed
 * here) -- composition_guidance is explicitly labeled non-official general guidance, not a rule this
 * tool enforces anywhere.
 */

declare const inputSchema: {
    format: z.ZodString;
    bracket_level: z.ZodOptional<z.ZodNumber>;
};
declare const formatGuidelinesTool: ToolDefinition<typeof inputSchema>;

export { formatGuidelinesTool };
