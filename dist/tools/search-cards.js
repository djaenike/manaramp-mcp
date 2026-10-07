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
function toBrief(c) {
  const out = { name: c.name, type_line: c.type_line, color_identity: c.color_identity.join("") || "C" };
  if (c.mana_cost) out.mana_cost = c.mana_cost;
  const names = effectNames(c.effects);
  if (names.length) out.effect_names = names;
  if (c.price_usd != null) out.price_usd = c.price_usd;
  return out;
}
function toCompact(c, includeDraftStats = false) {
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
  if (includeDraftStats && c.format_stats?.length) {
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
  names: z.array(z.string()).optional().describe("Exact-name batch lookup (overrides filters)."),
  oracle_ids: z.array(z.string()).optional().describe("Batch lookup by card id."),
  arena_grp_ids: z.array(z.number()).optional().describe("Batch lookup by Arena grpId."),
  name_contains: z.string().optional(),
  trigger_event: z.string().optional().describe("etb, dies, attacks, cast_spell, token_created, counter_added, life_gained, upkeep, end_step... (implies triggered)."),
  trigger_watches: z.object({ type: z.string().optional(), modifier: z.string().optional() }).optional().describe("e.g. { type: 'Creature', modifier: 'YouCtrl' } = whenever a creature you control..."),
  cost_contains: z.object({ kind: z.string(), arg: z.string().optional() }).optional().describe("e.g. { kind: 'Sac', arg: 'Creature' } = sac outlets."),
  roles_any: z.array(z.string()).optional().describe("Precomputed roles, any-of: mana_rock, mana_dork, land_ramp, card_draw, removal, mass_removal, counterspell, tutor, recursion, token_generator, player_damage, extra_land_drop, protection, buff."),
  type_line_contains: z.string().optional().describe("e.g. 'Legendary Creature', 'Elf', 'Equipment'."),
  color_identity_subset_of: z.array(z.string()).optional().describe("Within a commander's colors, e.g. ['W','U','B']."),
  colors_include: z.array(z.string()).optional(),
  category: z.string().optional().describe("Creature, Instant, Sorcery, Land, Artifact, Enchantment, Planeswalker."),
  cmc_min: z.number().optional(),
  cmc_max: z.number().optional(),
  oracle_text_contains: z.string().optional(),
  legal_in: z.string().optional().describe("Format key, e.g. 'commander'."),
  max_price_usd: z.number().optional(),
  // Short descriptions (2026-09-28): tool definitions ride along on every model turn, and
  // deck_plan_guide already carries the full vocabulary with meanings.
  effect_in: z.array(z.string()).optional().describe("Forge effect names, any-of within one ability (e.g. Draw, DealDamage, Token, ChangeZone, PutCounter, Destroy). Case-sensitive; deck_plan_guide lists them."),
  trigger_kind: z.enum(["cast", "activate", "triggered", "static", "replacement"]).optional().describe("How the matched ability fires (same ability as effect_in)."),
  effect_param_contains: z.object({ key: z.string().describe("Forge param, e.g. Origin, Destination, ValidTgts"), value_contains: z.string() }).optional().describe("Narrow the effect_in step, e.g. tutors = ChangeZone + { key: 'Origin', value_contains: 'Library' }."),
  effects_all: z.array(z.string()).optional().describe("Card has EVERY one of these effect names (AND)."),
  limit: z.number().optional().describe("Max results (default 25, capped at 100). Ignored for names/oracle_ids/arena_grp_ids batch lookups.")
};
const MAX_SEARCHES = 10;
const inputSchema = {
  ...filterFields,
  searches: z.array(z.object({ label: z.string().optional().describe("Name for this search's result list, e.g. 'ramp'."), ...filterFields })).max(MAX_SEARCHES).optional().describe(
    `Run up to ${MAX_SEARCHES} searches in ONE call (2026-09-26) -- e.g. ramp, card draw, removal and lands for a deck, each its own entry with its own filters (every filter above is valid inside each entry; filters within an entry are AND-ed). Strongly preferred over separate calls: each extra call re-sends the whole conversation. Response: { results: { <label>: [card names] }, cards: { <name>: card } } -- a card matching several searches is listed under each label but described once. Top-level filters are ignored when searches is given.`
  ),
  detail: z.enum(["brief", "summary", "full"]).optional().describe(
    "'brief': name, mana cost, type, color identity, effect_names, price -- no oracle text; use it for broad exploratory searches, then look up the shortlist by `names` at the default detail. 'summary' (default): adds oracle text, P/T, keywords. 'full': the complete record (raw Forge effects tree, every format's legality, printing/image, full 17Lands rows) -- roughly 5x larger per card, only when genuinely needed."
  ),
  include_draft_stats: z.boolean().optional().describe("Add trimmed 17Lands draft stats (format_stats: gih_wr, alsa, ata, iih) to 'summary' results. Off by default -- limited-format data, irrelevant to Commander deck building.")
};
const queryCardsTool = {
  name: "query_cards",
  description: "Look up real cards: exact names (batch), ids, or filtered searches (roles, Forge effects, triggers, costs, type, colors, mana value, price, legality, text). Building a whole deck? Use fill_deck_plan instead -- it searches, picks and saves in one call. Several kinds of cards at once: put them in ONE call via `searches`. Pass color_identity_subset_of = the commander's colors so off-color cards never come back.",
  inputSchema,
  handler: async (args, ctx) => {
    const priceSource = await ctx.getPriceSourcePreference?.() ?? "tcgplayer";
    const preferredPrinting = await ctx.getPreferredPrintingPreference?.() ?? "most_recent";
    const { detail, searches, include_draft_stats, ...filters } = args;
    const shape = (c) => detail === "full" ? c : detail === "brief" ? toBrief(c) : toCompact(c, include_draft_stats === true);
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
