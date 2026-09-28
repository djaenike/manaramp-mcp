import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/deck-plan-guide.ts -- deck_plan_guide (2026-09-27)
 *
 * Entry point for BOTH new decks and edits, called once per session before fill_deck_plan /
 * edit_deck. Returns, in one response, everything needed to act precisely:
 *   - the user's constraints: from a Manaramp deck prompt (prompt_id), an existing deck (deck_id), or
 *     what they said in chat (colors / max_price_usd) -- plus what's still `missing`;
 *   - the commander: analyzed (abilities + what it `rewards`) when known, or `commander_candidates`
 *     when none is set -- including when the model passes commander: null to change commanders.
 *     Candidates are a fresh random draw every call, so asking again gives new options;
 *   - format rules, composition targets, bracket criteria, archetype patterns, budget words;
 *   - the filter vocabulary: roles, real effect names (with card counts, from manaramp's ingest --
 *     never hand-written) and meanings, triggers, params, idea -> filter examples;
 *   - the returned-card schema, the plan schema with an example, and step-by-step instructions.
 *
 * Supersedes format_guidelines for building (that tool stays for bracket lookups).
 */

declare const inputSchema: {
    prompt_id: z.ZodOptional<z.ZodString>;
    deck_id: z.ZodOptional<z.ZodString>;
    commander: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    format: z.ZodOptional<z.ZodString>;
    colors: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    max_price_usd: z.ZodOptional<z.ZodNumber>;
    all_effects: z.ZodOptional<z.ZodBoolean>;
};
declare const deckPlanGuideTool: ToolDefinition<typeof inputSchema>;

export { deckPlanGuideTool };
