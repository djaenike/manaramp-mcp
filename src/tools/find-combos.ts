/**
 * tools/find-combos.ts -- Tool 5: find_combos
 * Commander Spellbook's official combo database, queried with an implicit AND across every card
 * name passed in one call. Use this to verify two-or-more candidate cards actually form a real,
 * documented combo before building around them, or to check whether a commander/card already has
 * a known combo line worth including.
 *
 * Thin registration wrapper only -- findCombos itself lives in sub-tools/spellbook/combos.ts and
 * is imported directly from there by tools/deck-building.ts too (NOT from this file), so tools
 * never import tools.
 */

import { z } from "zod";
import { findCombos } from "../sub-tools/spellbook/combos.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  card_names: z.array(z.string()).describe("Two or more exact card names to check for a combo together."),
  limit: z.number().optional().describe("Max results to return (default 10)."),
};

const findCombosTool: ToolDefinition<typeof inputSchema> = {
  name: "find_combos",
  description:
    "Look up real, documented combos from Commander Spellbook given 2 or more card names (queried as " +
    "an AND -- every name must appear together in a result). Returns each combo's full card list, " +
    "prerequisites, steps, and produced result (e.g. 'infinite mana'), plus a permalink. Use this to " +
    "verify a candidate pairing is a genuine combo (not just commonly played together per " +
    "get_card_synergies) before building a deck around it, or to double-check a combo you're relying " +
    "on for wincon_summary before calling new_deck_creation/existing_deck_cleanup. If a pairing you " +
    "know has combos returns zero results, the exact query syntax is inferred from a syntax guide " +
    "(not confirmed against live docs) -- spot-check with a known combo like ['Dramatic Reversal', " +
    "'Isochron Scepter'] before concluding there's truly nothing there.",
  inputSchema,
  handler: async ({ card_names, limit }) => {
    try {
      const combos = await findCombos(card_names, limit);
      return { content: [{ type: "text", text: JSON.stringify(combos, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `find_combos failed: ${e.message}` }] };
    }
  },
};

export { findCombosTool };
