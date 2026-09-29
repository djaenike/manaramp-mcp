import { z } from "zod";
import { COMMANDER_BRACKETS, COMMANDER_COMPOSITION_GUIDANCE } from "../functions/reference/format-guidelines-data.js";
const inputSchema = {
  format: z.string().describe("e.g. 'commander', 'standard', 'modern', 'pioneer'. Only 'commander' (case-insensitive) currently returns bracket criteria and composition guidance -- other formats get an empty/minimal response, since this tool set's deck-building logic is Commander-first today."),
  bracket_level: z.number().min(1).max(5).optional().describe("1-5, only meaningful for format:'commander'. Omit to get all 5 brackets' criteria at once -- useful for judging which bracket a deck actually belongs in, the same way you'd compare against several before picking one.")
};
const formatGuidelinesTool = {
  name: "format_guidelines",
  description: "Reference: a format's deck-building rules and, for Commander, the official Bracket 1-5 criteria. For building a deck use deck_plan_guide instead (it includes this).",
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
        })
      }]
    };
  }
};
export {
  formatGuidelinesTool
};
