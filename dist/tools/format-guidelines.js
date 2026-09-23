import { z } from "zod";
import { COMMANDER_BRACKETS, COMMANDER_COMPOSITION_GUIDANCE } from "../functions/reference/format-guidelines-data.js";
const inputSchema = {
  format: z.string().describe("e.g. 'commander', 'standard', 'modern', 'pioneer'. Only 'commander' (case-insensitive) currently returns bracket criteria and composition guidance -- other formats get an empty/minimal response, since this tool set's deck-building logic is Commander-first today."),
  bracket_level: z.number().min(1).max(5).optional().describe("1-5, only meaningful for format:'commander'. Omit to get all 5 brackets' criteria at once -- useful for judging which bracket a deck actually belongs in, the same way you'd compare against several before picking one.")
};
const formatGuidelinesTool = {
  name: "format_guidelines",
  description: "Reference-only deck-building targets and rules for a format -- for Commander: the REAL, official Commander Bracket System criteria (Game Changers/combo/mass-land-denial/extra-turn/tutor rules per bracket 1-5, verified against WotC's own current page) plus general composition guidance (land/ramp/card-draw/interaction count ranges for a 100-card deck -- clearly NOT an official rule, just widely-cited community consensus to reason with). Call this before or while assembling a decklist with query_cards/query_combos/query_synergies, as context for what a well-built deck at a given power level looks like -- it takes no decklist and judges nothing itself. validate_and_submit is still what checks/reports facts about an actual decklist (including its own card_draw_found/removal_found/land_ramp_found/combos_found/etc, which map directly onto this tool's composition_guidance categories) and persists it.",
  inputSchema,
  handler: async ({ format, bracket_level }) => {
    const isCommander = format.trim().toLowerCase() === "commander";
    const brackets = isCommander ? bracket_level ? COMMANDER_BRACKETS.filter((b) => b.level === bracket_level) : COMMANDER_BRACKETS : [];
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          format,
          deck_size: isCommander ? { total: 100, note: "99 library cards + 1 commander (2 for a partner/background pair, still 100 total)." } : null,
          composition_guidance: isCommander ? COMMANDER_COMPOSITION_GUIDANCE : null,
          brackets: isCommander ? brackets : void 0,
          note: isCommander ? void 0 : "No bracket/composition reference exists yet for this format -- this tool set's deck-building logic is Commander-first today."
        }, null, 2)
      }]
    };
  }
};
export {
  formatGuidelinesTool
};
