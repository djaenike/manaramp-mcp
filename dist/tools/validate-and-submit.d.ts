import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

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

declare const inputSchema: {
    decklist_text: z.ZodString;
    submit: z.ZodOptional<z.ZodBoolean>;
    deck_id: z.ZodOptional<z.ZodString>;
    deck_name: z.ZodOptional<z.ZodString>;
    deck_type: z.ZodOptional<z.ZodString>;
    bracket_estimate: z.ZodOptional<z.ZodString>;
    bracket_level_requested: z.ZodOptional<z.ZodString>;
    is_public: z.ZodOptional<z.ZodBoolean>;
    wincon_summary: z.ZodOptional<z.ZodString>;
    general_strategy: z.ZodOptional<z.ZodString>;
};
declare const validateAndSubmitTool: ToolDefinition<typeof inputSchema>;

export { validateAndSubmitTool };
