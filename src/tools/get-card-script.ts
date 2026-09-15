/**
 * tools/get-card-script.ts -- Tool 6: get_card_script
 * Forge's structured rules-engine script for a card (cost/trigger/effect fields), read live from
 * Card-Forge/forge on GitHub. Use this to disambiguate ability types oracle text alone can leave
 * unclear -- e.g. whether an effect is a tap-cost ability, an attack trigger, or an ETB -- while
 * evaluating a candidate card's actual functional role in a deck.
 *
 * Thin registration wrapper only -- getCardScript itself lives in sub-tools/forge/card_script.ts
 * and is imported directly from there by tools/deck-building.ts too (NOT from this file), so tools
 * never import tools.
 */

import { z } from "zod";
import { getCardScript } from "../sub-tools/forge/card_script.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  card_name: z.string().describe("Exact card name, e.g. 'Dramatic Reversal'"),
};

const getCardScriptTool: ToolDefinition<typeof inputSchema> = {
  name: "get_card_script",
  description:
    "Pull a card's structured rules-engine script from Card-Forge/forge (GPL-3.0, community-" +
    "maintained, unofficial) -- useful to disambiguate ability types (tap-cost ability vs. attack " +
    "trigger vs. ETB, etc.) beyond what prose oracle text makes clear, while evaluating how a " +
    "candidate card actually functions during a build. The filename is guessed from the card name " +
    "(lowercase, underscores for spaces, punctuation stripped) and is NOT verified against split " +
    "cards, DFCs, or unusual punctuation -- on a 404, fall back to search_cards/oracle text for this " +
    "card instead of assuming the card doesn't exist.",
  inputSchema,
  handler: async ({ card_name }) => {
    try {
      const script = await getCardScript(card_name);
      return { content: [{ type: "text", text: JSON.stringify(script, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `get_card_script failed: ${e.message}` }] };
    }
  },
};

export { getCardScriptTool };
