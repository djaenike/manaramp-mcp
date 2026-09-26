import { z } from "zod";
import { queryCards } from "../functions/query/cards.js";
function effectNames(effects) {
  const out = /* @__PURE__ */ new Set();
  const walk = (node, kind) => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, kind);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node;
    const trigger = obj.trigger;
    const k = trigger?.kind ?? kind;
    if (typeof obj.effect === "string") out.add(`${k}:${obj.effect}`);
    for (const [key, value] of Object.entries(obj)) {
      if (key === "params" || key === "conditions" || key === "formulas" || key === "tokens") continue;
      walk(value, k);
    }
  };
  walk(effects, "?");
  return [...out];
}
function toCompact(c) {
  const out = { name: c.name, oracle_id: c.oracle_id, type_line: c.type_line, color_identity: c.color_identity.join("") || "C" };
  if (c.mana_cost) out.mana_cost = c.mana_cost;
  if (c.cmc != null) out.cmc = c.cmc;
  if (c.oracle_text) out.oracle_text = c.oracle_text;
  if (c.power != null || c.toughness != null) out.pt = `${c.power ?? "?"}/${c.toughness ?? "?"}`;
  if (c.loyalty != null) out.loyalty = c.loyalty;
  if (c.keywords?.length) out.keywords = c.keywords;
  const names = effectNames(c.effects);
  if (names.length) out.effect_names = names;
  if (c.price_usd != null) out.price_usd = c.price_usd;
  if (c.format_stats?.length) {
    out.format_stats = c.format_stats.map((f) => ({
      set: f.set_code,
      format: f.format,
      gih_wr: f.games_in_hand_win_rate,
      alsa: f.avg_last_seen_at,
      ata: f.avg_taken_at,
      iih: f.improvement_in_hand,
      gih_n: f.games_in_hand_sample_size
    }));
  }
  return out;
}
const filterFields = {
  names: z.array(z.string()).optional().describe("Exact (case-insensitive) name batch lookup. Takes precedence over every filter below."),
  oracle_ids: z.array(z.string()).optional().describe("Batch lookup by the `cards` collection's own _id. Same priority as names."),
  arena_grp_ids: z.array(z.number()).optional().describe("Arena's numeric grpIds -- batch lookup. Same priority as names/oracle_ids."),
  name_contains: z.string().optional().describe("Substring search against card names, case-insensitive."),
  type_line_contains: z.string().optional().describe("Substring of the type line, case-insensitive -- e.g. 'Legendary Creature', 'Elf', 'Equipment'."),
  color_identity_subset_of: z.array(z.string()).optional().describe("Cards whose color_identity is a SUBSET of this list -- the standard 'legal to include under this commander' filter, e.g. ['W','U','B'] for an Esper commander."),
  colors_include: z.array(z.string()).optional().describe("Cards whose `colors` array includes ALL of these."),
  category: z.string().optional().describe("e.g. 'Creature', 'Instant', 'Land', 'Artifact', 'Planeswalker', 'Other'."),
  cmc_min: z.number().optional(),
  cmc_max: z.number().optional(),
  oracle_text_contains: z.string().optional().describe("Substring search against oracle text, case-insensitive."),
  legal_in: z.string().optional().describe("A format key, e.g. 'commander', 'modern' -- only returns cards legal in that format."),
  max_price_usd: z.number().optional(),
  effect_in: z.array(z.string()).optional().describe(
    `Ability search, rebuilt on each card's real Forge effect data (2026-09-22) -- matches any card with at least one effect step whose Forge ApiType effect name is in this list (OR-matched, so hedge with a few candidate names instead of guessing exactly one). Forge's real vocabulary is ~200 distinct names, mostly plain English verb-phrases: Draw, Discard, Mill, Scry, GainLife, LoseLife, DealDamage, Tap, Untap, Counter (counterspells), PutCounter/PutCounterAll, Token, Destroy/DestroyAll, Exile/ExileAll, Sacrifice/SacrificeAll, ChangeZone (tutors/recursion/discard-selection -- see effect_param_contains to narrow by Origin$/Destination$). Examples: removal = ["Destroy","DestroyAll","Exile","ExileAll"]; direct damage = ["DealDamage"]; sac outlets = ["Sacrifice","SacrificeAll"]. When unsure of the exact spelling, run a query WITHOUT this filter first and check a few results' effect_names values before narrowing.`
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
  effects_all: z.array(z.string()).optional().describe(
    'Card must have EVERY one of these Forge effect names somewhere in its abilities (AND) -- e.g. ["Draw", "Mana"] for cards that both draw and make mana. effect_in is any-of within one ability; use this when a single card must do several things. Combine freely with every other filter in the same search.'
  ),
  limit: z.number().optional().describe("Max results (default 25, capped at 100). Ignored for names/oracle_ids/arena_grp_ids batch lookups.")
};
const MAX_SEARCHES = 10;
const inputSchema = {
  ...filterFields,
  searches: z.array(z.object({ label: z.string().optional().describe("Name for this search's result list, e.g. 'ramp'."), ...filterFields })).max(MAX_SEARCHES).optional().describe(
    `Run up to ${MAX_SEARCHES} searches in ONE call (2026-09-26) -- e.g. ramp, card draw, removal and lands for a deck, each its own entry with its own filters (every filter above is valid inside each entry; filters within an entry are AND-ed). Strongly preferred over separate calls: each extra call re-sends the whole conversation. Response: { results: { <label>: [card names] }, cards: { <name>: card } } -- a card matching several searches is listed under each label but described once. Top-level filters are ignored when searches is given.`
  ),
  detail: z.enum(["summary", "full"]).optional().describe(
    "'summary' (default): name, mana cost, type, oracle text, P/T, color identity, price, effect_names (the Forge effect names effect_in matches, as 'kind:Effect'), and trimmed 17Lands format_stats. 'full': the complete record -- the raw Forge effects tree, every format's legality, printing/image, full 17Lands rows. Only ask for 'full' when you genuinely need those; it's roughly 5x larger per card."
  )
};
const queryCardsTool = {
  name: "query_cards",
  description: "Look up real cards from manaramp's own database -- by exact name (batch), oracle_id, Arena grpId, or a filtered search (color identity, mana value, ability search via effect_in/trigger_kind/effect_param_contains -- Forge's own real effect data, see effect_in's own description for the vocabulary and examples -- price, format legality, oracle-text substring, etc). Prefer this over general knowledge when assembling or researching a decklist -- ground card choices in what's actually here rather than guessing, then feed the assembled decklist into validate_and_submit. A result with no effect_names means this card genuinely has no scripted ability (a vanilla creature, a basic land) -- confirmed, not unclassified. Legality: filter with legal_in rather than reading it off results (the per-format map is only in detail: 'full'). When you need several kinds of cards (ramp, draw, removal, lands...), put them all in ONE call via `searches` rather than one call each.",
  inputSchema,
  handler: async (args, ctx) => {
    const priceSource = await ctx.getPriceSourcePreference?.() ?? "cardkingdom";
    const preferredPrinting = await ctx.getPreferredPrintingPreference?.() ?? "most_recent";
    const { detail, searches, ...filters } = args;
    const shape = (c) => detail === "full" ? c : toCompact(c);
    if (!searches?.length) {
      const cards2 = await queryCards(ctx.readDb, filters, priceSource, preferredPrinting);
      return { content: [{ type: "text", text: JSON.stringify(cards2.map(shape)) }] };
    }
    const lists = await Promise.all(
      searches.map(({ label: _label, ...f }) => queryCards(ctx.readDb, f, priceSource, preferredPrinting))
    );
    const results = {};
    const cards = {};
    searches.forEach((search, i) => {
      let label = search.label?.trim() || `search_${i + 1}`;
      while (label in results) label = `${label}_${i + 1}`;
      results[label] = lists[i].map((c) => c.name);
      for (const c of lists[i]) cards[c.name] ??= shape(c);
    });
    return { content: [{ type: "text", text: JSON.stringify({ results, cards }) }] };
  }
};
export {
  queryCardsTool
};
