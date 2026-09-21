/**
 * functions/cards.ts -- the ONE place that queries manaramp's `cards` Mongo collection.
 *
 * Consolidated 2026-09-17 (fifth pass): this used to be split across sub-tools/scryfall/cards.ts
 * (search) and sub-tools/cardkingdom/pricing.ts (a SEPARATE cards.find() just for market_data),
 * with sub-tools/deck-building/consistency.ts and sub-tools/spellbook/combos.ts ALSO each running
 * their own independent cards.find() for card-detail/cmc lookups -- four different places
 * re-implementing the same underlying query. "scryfall"/"cardkingdom" as folder names were also
 * actively misleading: this queries the WHOLE ingested card document (Forge abilities, 17Lands
 * format_stats, Card Kingdom/ManaPool pricing, Scryfall's own fields), not just "Scryfall data."
 *
 * Every other function in this package that needs card data (deck-validation's consistency checks,
 * combos' cmc/speed classification, decks' oracle_id resolution, draft-results' grpId resolution)
 * calls queryCards below instead of touching `db.collection("cards")` itself -- this is the only
 * file that does.
 */

import type { Db } from "mongodb";

interface MongoCardDoc {
  _id: string;
  name: string;
  mana_cost: string | null;
  cmc: number | null;
  type_line: string;
  category: string;
  oracle_text: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  colors: string[];
  color_identity: string[];
  legalities: Record<string, string>;
  arena_grp_ids: number[];
  abilities: {
    is_mana_rock: boolean | null;
    is_card_draw: boolean | null;
    is_removal: boolean | null;
    is_mass_removal: boolean | null;
    is_token_generator: boolean | null;
    token_types: string[] | null;
    is_land_ramp: boolean | null;
    is_extra_land_drop: boolean | null;
    is_tutor: boolean | null;
    is_counterspell: boolean | null;
    is_recursion: boolean | null;
    is_game_changer: boolean | null;
    is_mass_land_denial: boolean | null;
    is_extra_turn: boolean | null;
  } | null;
  keywords: string[] | null;
  activated_abilities: Array<{ effect: string | null; cost_raw: string | null; requires_tap: boolean; requires_sacrifice: boolean; requires_mana_cost: boolean }> | null;
  triggered_abilities: Array<{ effect: string | null; trigger_mode: string | null; trigger_type: string | null; optional: boolean }> | null;
  static_abilities: Array<{ affected: string | null }> | null;
  scryfall_printings: Array<{ scryfall_id: string; set_code: string; collector_number: string; image_url: string | null }>;
  market_data: {
    cardkingdom: { price_usd: number | null; is_foil: boolean; fetched_at: Date } | null;
    manapool: { price_usd: number | null; is_foil: boolean; fetched_at: Date } | null;
  } | null;
  format_stats: FormatStatsEntry[];
}

interface FormatStatsEntry {
  set_code: string;
  format: string;
  color: string | null;
  rarity: string | null;
  avg_last_seen_at: number | null;
  seen_sample_size: number | null;
  avg_taken_at: number | null;
  taken_sample_size: number | null;
  games_played_win_rate: number | null;
  games_played_sample_size: number | null;
  opening_hand_win_rate: number | null;
  opening_hand_sample_size: number | null;
  games_drawn_win_rate: number | null;
  games_drawn_sample_size: number | null;
  games_in_hand_win_rate: number | null;
  games_in_hand_sample_size: number | null;
  games_not_seen_win_rate: number | null;
  games_not_seen_sample_size: number | null;
  improvement_in_hand: number | null;
  as_of: Date;
}

interface QueryCardsFilters {
  /** Exact (case-insensitive) name match against any of these -- batch lookup. Highest priority --
   *  takes precedence over every other filter below when present (this is "give me exactly these
   *  cards," not a search). */
  names?: string[];
  /** Oracle_id batch lookup (the `cards` collection's own _id) -- for resolving stored references
   *  like a deck's `cards`/`commander.oracle_ids` arrays back to real card data. Same priority as
   *  `names` (checked first, since callers with oracle_ids already know exactly which docs they
   *  want, same as a name lookup). */
  oracle_ids?: string[];
  /** Arena's numeric grpIds -- batch lookup for resolving a draft pack/pick history in one call.
   *  A card can have several (one per Arena printing). Same priority as `names`/`oracle_ids`. */
  arena_grp_ids?: number[];
  name_contains?: string;
  /** Cards whose color_identity is a SUBSET of this list -- the standard "legal to include under
   *  this commander" filter. Omit for no color-identity restriction. */
  color_identity_subset_of?: string[];
  /** Cards whose `colors` array includes ALL of these. Distinct from color_identity_subset_of. */
  colors_include?: string[];
  category?: string;
  cmc_min?: number;
  cmc_max?: number;
  oracle_text_contains?: string;
  legal_in?: string;
  max_price_usd?: number;
  is_mana_rock?: boolean;
  is_card_draw?: boolean;
  is_removal?: boolean;
  is_mass_removal?: boolean;
  is_token_generator?: boolean;
  /** Substring match against abilities.token_types -- these are Forge's own TokenScript$ identifiers
   *  (e.g. "c_a_treasure_sac"), not prettified names, so match loosely (e.g. "treasure"). */
  token_type_contains?: string;
  is_land_ramp?: boolean;
  is_extra_land_drop?: boolean;
  is_tutor?: boolean;
  is_counterspell?: boolean;
  is_recursion?: boolean;
  limit?: number;
}

interface CardSummary {
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  cmc: number | null;
  type_line: string;
  category: string;
  oracle_text: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  colors: string[];
  color_identity: string[];
  legalities: Record<string, string>;
  arena_grp_ids: number[];
  abilities: MongoCardDoc["abilities"];
  keywords: string[] | null;
  activated_abilities: MongoCardDoc["activated_abilities"];
  triggered_abilities: MongoCardDoc["triggered_abilities"];
  static_abilities: MongoCardDoc["static_abilities"];
  price_usd: number | null;
  image_url: string | null;
  format_stats: FormatStatsEntry[];
}

function toSummary(doc: MongoCardDoc, priceSource: "cardkingdom" | "manapool" = "cardkingdom"): CardSummary {
  const printing = doc.scryfall_printings?.[0];
  const preferred = priceSource === "manapool" ? doc.market_data?.manapool : doc.market_data?.cardkingdom;
  const other = priceSource === "manapool" ? doc.market_data?.cardkingdom : doc.market_data?.manapool;
  return {
    oracle_id: doc._id,
    name: doc.name,
    mana_cost: doc.mana_cost,
    cmc: doc.cmc,
    type_line: doc.type_line,
    category: doc.category,
    oracle_text: doc.oracle_text,
    power: doc.power,
    toughness: doc.toughness,
    loyalty: doc.loyalty,
    colors: doc.colors,
    color_identity: doc.color_identity,
    legalities: doc.legalities,
    arena_grp_ids: doc.arena_grp_ids ?? [],
    abilities: doc.abilities,
    keywords: doc.keywords ?? null,
    activated_abilities: doc.activated_abilities ?? null,
    triggered_abilities: doc.triggered_abilities ?? null,
    static_abilities: doc.static_abilities ?? null,
    price_usd: preferred?.price_usd ?? other?.price_usd ?? null,
    image_url: printing?.image_url ?? null,
    format_stats: doc.format_stats ?? [],
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The one canonical query against manaramp's `cards` collection -- see file header. `priceSource`
 *  (2026-09-21, defaults to 'cardkingdom' for callers that don't pass one -- no behavior change for
 *  them) resolves each result's CardSummary.price_usd to the calling account's own preference; see
 *  tools/shared/deck-analysis.ts's analyzeDecklist for the main consumer (optimize_deck/
 *  publish_deck's deck-total pricing). */
async function queryCards(db: Db, filters: QueryCardsFilters, priceSource: "cardkingdom" | "manapool" = "cardkingdom"): Promise<CardSummary[]> {
  if (filters.names?.length) {
    const regexes = filters.names.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
    const docs = await db.collection<MongoCardDoc>("cards").find({ name: { $in: regexes } }).toArray();
    return docs.map((doc) => toSummary(doc, priceSource));
  }
  if (filters.oracle_ids?.length) {
    const docs = await db.collection<MongoCardDoc>("cards").find({ _id: { $in: filters.oracle_ids } }).toArray();
    return docs.map((doc) => toSummary(doc, priceSource));
  }
  if (filters.arena_grp_ids?.length) {
    const docs = await db.collection<MongoCardDoc>("cards").find({ arena_grp_ids: { $in: filters.arena_grp_ids } }).toArray();
    return docs.map((doc) => toSummary(doc, priceSource));
  }

  const query: Record<string, unknown> = {};

  if (filters.name_contains) {
    query.name = { $regex: filters.name_contains, $options: "i" };
  }
  if (filters.color_identity_subset_of) {
    query.color_identity = { $not: { $elemMatch: { $nin: filters.color_identity_subset_of } } };
  }
  if (filters.colors_include?.length) {
    query.colors = { $all: filters.colors_include };
  }
  if (filters.category) {
    query.category = filters.category;
  }
  if (filters.cmc_min !== undefined || filters.cmc_max !== undefined) {
    const cmcFilter: Record<string, number> = {};
    if (filters.cmc_min !== undefined) cmcFilter.$gte = filters.cmc_min;
    if (filters.cmc_max !== undefined) cmcFilter.$lte = filters.cmc_max;
    query.cmc = cmcFilter;
  }
  if (filters.oracle_text_contains) {
    query.oracle_text = { $regex: filters.oracle_text_contains, $options: "i" };
  }
  if (filters.legal_in) {
    query[`legalities.${filters.legal_in}`] = "legal";
  }
  if (filters.max_price_usd !== undefined) {
    query.$or = [
      { "market_data.cardkingdom.price_usd": { $lte: filters.max_price_usd } },
      { "market_data.manapool.price_usd": { $lte: filters.max_price_usd } },
    ];
  }
  if (filters.is_mana_rock) query["abilities.is_mana_rock"] = true;
  if (filters.is_card_draw) query["abilities.is_card_draw"] = true;
  if (filters.is_removal) query["abilities.is_removal"] = true;
  if (filters.is_mass_removal) query["abilities.is_mass_removal"] = true;
  if (filters.is_token_generator) query["abilities.is_token_generator"] = true;
  if (filters.token_type_contains) {
    query["abilities.token_types"] = { $regex: filters.token_type_contains, $options: "i" };
  }
  if (filters.is_land_ramp) query["abilities.is_land_ramp"] = true;
  if (filters.is_extra_land_drop) query["abilities.is_extra_land_drop"] = true;
  if (filters.is_tutor) query["abilities.is_tutor"] = true;
  if (filters.is_counterspell) query["abilities.is_counterspell"] = true;
  if (filters.is_recursion) query["abilities.is_recursion"] = true;

  const docs = await db
    .collection<MongoCardDoc>("cards")
    .find(query)
    .limit(Math.min(filters.limit ?? 25, 100))
    .toArray();

  return docs.map((doc) => toSummary(doc, priceSource));
}

export { queryCards };
export type { QueryCardsFilters, CardSummary, FormatStatsEntry };
