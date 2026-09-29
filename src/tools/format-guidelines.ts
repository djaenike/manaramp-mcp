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

import { z } from "zod";
import { COMMANDER_BRACKETS, COMMANDER_COMPOSITION_GUIDANCE } from "../functions/reference/format-guidelines-data.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  format: z.string().describe("e.g. 'commander', 'standard', 'modern', 'pioneer'. Only 'commander' (case-insensitive) currently returns bracket criteria and composition guidance -- other formats get an empty/minimal response, since this tool set's deck-building logic is Commander-first today."),
  bracket_level: z.number().min(1).max(5).optional().describe("1-5, only meaningful for format:'commander'. Omit to get all 5 brackets' criteria at once -- useful for judging which bracket a deck actually belongs in, the same way you'd compare against several before picking one."),
};

const formatGuidelinesTool: ToolDefinition<typeof inputSchema> = {
  name: "format_guidelines",
  description:
    "Reference: a format's deck-building rules and, for Commander, the official Bracket 1-5 criteria. For building " +
    "a deck use deck_plan_guide instead (it includes this).",
  inputSchema,
  handler: async ({ format, bracket_level }) => {
    const isCommander = format.trim().toLowerCase() === "commander";
    const brackets = isCommander
      ? (bracket_level ? COMMANDER_BRACKETS.filter((b) => b.level === bracket_level) : COMMANDER_BRACKETS)
      : [];

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          format,
          deck_size: isCommander
            ? { total: 100, note: "99 library cards + 1 commander (2 for a partner/background pair, still 100 total)." }
            : null,
          composition_guidance: isCommander ? COMMANDER_COMPOSITION_GUIDANCE : null,
          brackets: isCommander ? brackets : undefined,
          note: isCommander ? undefined : "No bracket/composition reference exists yet for this format -- this tool set's deck-building logic is Commander-first today.",
        }),
      }],
    };
  },
};

export { formatGuidelinesTool };
