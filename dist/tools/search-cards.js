import { z } from "zod";
import { queryCards } from "../functions/query/cards.js";
const inputSchema = {
  names: z.array(z.string()).optional().describe("Exact (case-insensitive) name batch lookup. Takes precedence over every filter below."),
  oracle_ids: z.array(z.string()).optional().describe("Batch lookup by the `cards` collection's own _id. Same priority as names."),
  arena_grp_ids: z.array(z.number()).optional().describe("Arena's numeric grpIds -- batch lookup. Same priority as names/oracle_ids."),
  name_contains: z.string().optional().describe("Substring search against card names, case-insensitive."),
  color_identity_subset_of: z.array(z.string()).optional().describe("Cards whose color_identity is a SUBSET of this list -- the standard 'legal to include under this commander' filter, e.g. ['W','U','B'] for an Esper commander."),
  colors_include: z.array(z.string()).optional().describe("Cards whose `colors` array includes ALL of these."),
  category: z.string().optional().describe("e.g. 'Creature', 'Instant', 'Land', 'Artifact', 'Planeswalker', 'Other'."),
  cmc_min: z.number().optional(),
  cmc_max: z.number().optional(),
  oracle_text_contains: z.string().optional().describe("Substring search against oracle text, case-insensitive."),
  legal_in: z.string().optional().describe("A format key, e.g. 'commander', 'modern' -- only returns cards legal in that format."),
  max_price_usd: z.number().optional(),
  is_mana_rock: z.boolean().optional(),
  is_card_draw: z.boolean().optional(),
  is_removal: z.boolean().optional(),
  is_mass_removal: z.boolean().optional(),
  is_player_damage: z.boolean().optional().describe("A DealDamage effect aimed at player(s)/opponent(s) specifically -- distinct from is_removal, which counts any DealDamage effect regardless of target."),
  is_token_generator: z.boolean().optional(),
  token_type_contains: z.string().optional().describe("Substring match against abilities.token_types -- Forge's own raw identifiers (e.g. 'c_a_treasure_sac'), match loosely (e.g. 'treasure')."),
  is_land_ramp: z.boolean().optional(),
  is_extra_land_drop: z.boolean().optional(),
  is_tutor: z.boolean().optional(),
  is_counterspell: z.boolean().optional(),
  is_recursion: z.boolean().optional(),
  limit: z.number().optional().describe("Max results (default 25, capped at 100). Ignored for names/oracle_ids/arena_grp_ids batch lookups.")
};
const queryCardsTool = {
  name: "query_cards",
  description: "Look up real cards from manaramp's own database -- by exact name (batch), oracle_id, Arena grpId, or a filtered search (color identity, mana value, ability-tag booleans like is_removal/is_tutor/is_land_ramp/is_player_damage, price, format legality, oracle-text substring, etc). Prefer this over general knowledge when assembling or researching a decklist -- ground card choices in what's actually here rather than guessing, then feed the assembled decklist into optimize_deck. A `null` ability-tag field means this card hasn't been classified against that specific flag yet (Forge hasn't scripted it, or it's still mid-backfill) -- NOT a confirmed `false`; don't treat null the same as false when filtering or reasoning about a deck.",
  inputSchema,
  handler: async (args, ctx) => {
    const priceSource = await ctx.getPriceSourcePreference?.() ?? "cardkingdom";
    const cards = await queryCards(ctx.readDb, args, priceSource);
    return { content: [{ type: "text", text: JSON.stringify(cards, null, 2) }] };
  }
};
export {
  queryCardsTool
};
