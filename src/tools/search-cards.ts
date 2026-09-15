/**
 * tools/search-cards.ts -- Tool 3: search_cards
 * Raw Scryfall search, exposed standalone specifically so Claude can call it repeatedly WHILE
 * reasoning about a decklist (before ever calling new_deck_creation/existing_deck_cleanup) --
 * e.g. "what are the best cheap removal spells in these colors" or "is there a better card-draw
 * enchantment I'm missing" -- rather than picking cards purely from training data. Each result
 * includes `category` (Creature/Instant/Sorcery/etc, derived from type_line) alongside the raw
 * type_line, so category doesn't need to be re-derived by hand while scanning candidates.
 *
 * Thin registration wrapper only -- searchCards itself (the actual logic) lives in
 * sub-tools/scryfall/cards.ts and is imported directly from there by tools/deck-building.ts too
 * (NOT from this file), so tools never import tools.
 */

import { z } from "zod";
import { searchCards } from "../sub-tools/scryfall/cards.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  query: z.string().describe("Scryfall search syntax, e.g. 'c:red t:creature cmc<=2'"),
  max_price_usd: z.number().optional().describe("Optional ceiling on Scryfall's bundled usd estimate, to pre-filter obviously-too-expensive candidates."),
};

const searchCardsTool: ToolDefinition<typeof inputSchema> = {
  name: "search_cards",
  description:
    "Search Magic cards via Scryfall's search syntax (e.g. 'c:red t:creature cmc<=2', 'o:\"draw a " +
    "card\"'). Returns up to 25 matches with name, mana_cost, type_line, category (Creature/Instant/" +
    "Sorcery/Enchantment/Artifact/Planeswalker/Land/Other -- derived from type_line), oracle_text, " +
    "Commander/Standard legality, and usd (Scryfall's bundled bulk-estimate price -- a fast sanity " +
    "check only, NOT this server's standardized real-dollar source; new_deck_creation/" +
    "existing_deck_cleanup use Card Kingdom pricing for the actual deck total). Use this while " +
    "building or editing a decklist to find real candidates for a role (removal, ramp, card draw, a " +
    "specific color/curve slot) instead of relying on training data alone -- then pass the assembled " +
    "decklist_text to new_deck_creation or existing_deck_cleanup for validation, pricing, bracket " +
    "rating, and the final HTML report.",
  inputSchema,
  handler: async ({ query, max_price_usd }) => {
    try {
      const cards = await searchCards(query, max_price_usd);
      return { content: [{ type: "text", text: JSON.stringify(cards, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `search_cards failed: ${e.message}` }] };
    }
  },
};

export { searchCardsTool };
