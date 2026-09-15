/**
 * tools/get-card-synergies.ts -- Tool 4: get_card_synergies
 * EDHREC's per-card synergy page: what else gets played alongside a given card, plus any combos
 * EDHREC itself flags for it. Distinct from new_deck_creation's internal commander-recommendations
 * lookup (that's "what fits this commander"); this is "what pairs well with this specific card" --
 * use it while evaluating whether a candidate card actually has support in the deck, not just a
 * good card in isolation.
 *
 * Thin registration wrapper only -- getCardSynergies itself lives in
 * sub-tools/edhrec/recommendations.ts and is imported directly from there by tools/deck-building.ts
 * too (NOT from this file), so tools never import tools.
 */

import { z } from "zod";
import { getCardSynergies } from "../sub-tools/edhrec/recommendations.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  card_name: z.string().describe("Exact card name, e.g. 'Isochron Scepter'"),
};

const getCardSynergiesTool: ToolDefinition<typeof inputSchema> = {
  name: "get_card_synergies",
  description:
    "EDHREC's synergy data for a single card: other cards commonly played alongside it (by category, " +
    "with inclusion rates) and any known combos EDHREC flags for it. Card name must match EDHREC's " +
    "slug format closely (lowercase, punctuation stripped) -- no fuzzy matching, a misspelling 404s. " +
    "Use this while building/editing a decklist to check whether a candidate card has real support " +
    "(cards that pair with it) in the colors/theme you're building, not just that it's individually " +
    "strong. For confirmed, fully-documented combos (not just 'played together'), use find_combos.",
  inputSchema,
  handler: async ({ card_name }) => {
    try {
      const synergies = await getCardSynergies(card_name);
      return { content: [{ type: "text", text: JSON.stringify(synergies, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `get_card_synergies failed: ${e.message}` }] };
    }
  },
};

export { getCardSynergiesTool };
