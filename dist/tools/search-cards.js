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
  effect_in: z.array(z.string()).optional().describe(
    `Ability search, rebuilt on each card's real Forge effect data (2026-09-22) -- matches any card with at least one effect step whose Forge ApiType effect name is in this list (OR-matched, so hedge with a few candidate names instead of guessing exactly one). Forge's real vocabulary is ~200 distinct names, mostly plain English verb-phrases: Draw, Discard, Mill, Scry, GainLife, LoseLife, DealDamage, Tap, Untap, Counter (counterspells), PutCounter/PutCounterAll, Token, Destroy/DestroyAll, Exile/ExileAll, Sacrifice/SacrificeAll, ChangeZone (tutors/recursion/discard-selection -- see effect_param_contains to narrow by Origin$/Destination$). Examples: removal = ["Destroy","DestroyAll","Exile","ExileAll"]; direct damage = ["DealDamage"]; sac outlets = ["Sacrifice","SacrificeAll"]. When unsure of the exact spelling, run a query WITHOUT this filter first and check a few results' effects[].result[].effect values before narrowing.`
  ),
  trigger_kind: z.enum(["cast", "activate", "triggered", "static", "replacement"]).optional().describe(
    "Narrows effect_in to steps belonging to an effect of this specific kind -- e.g. 'activate' for an ACTIVATED removal ability specifically, vs any removal regardless of how it fires. Or use alone (no effect_in) for 'any static ability, don't care what it does.' The kind and effect_in match MUST belong to the same ability on the card, not just both exist somewhere on it."
  ),
  effect_param_contains: z.object({
    key: z.string().describe("The raw Forge field name, e.g. 'Origin', 'Destination', 'ValidTgts', 'TokenScript'."),
    value_contains: z.string().describe("Case-insensitive substring to match against that field's value.")
  }).optional().describe(
    `Precision filter within the SAME step matched by effect_in (or any step, if effect_in is omitted) -- checked against that step's params and its own conditions. Tutors = effect_in: ["ChangeZone"], effect_param_contains: {key: "Origin", value_contains: "Library"}. Player-targeted damage = effect_in: ["DealDamage"], effect_param_contains: {key: "ValidTgts", value_contains: "Player"} (also try "Opponent", scripts vary). Only one key/value pair per call -- run two queries and intersect results if you need two conditions on the same step.`
  ),
  limit: z.number().optional().describe("Max results (default 25, capped at 100). Ignored for names/oracle_ids/arena_grp_ids batch lookups.")
};
const queryCardsTool = {
  name: "query_cards",
  description: "Look up real cards from manaramp's own database -- by exact name (batch), oracle_id, Arena grpId, or a filtered search (color identity, mana value, ability search via effect_in/trigger_kind/effect_param_contains -- Forge's own real effect data, see effect_in's own description for the vocabulary and examples -- price, format legality, oracle-text substring, etc). Prefer this over general knowledge when assembling or researching a decklist -- ground card choices in what's actually here rather than guessing, then feed the assembled decklist into optimize_deck. An empty `effects` array on a result means this card genuinely has no scripted ability (a vanilla creature, a basic land) -- confirmed, not unclassified.",
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
