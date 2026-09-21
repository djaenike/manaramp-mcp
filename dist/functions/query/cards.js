function toSummary(doc, priceSource = "cardkingdom") {
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
    format_stats: doc.format_stats ?? []
  };
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function queryCards(db, filters, priceSource = "cardkingdom") {
  if (filters.names?.length) {
    const regexes = filters.names.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
    const docs2 = await db.collection("cards").find({ name: { $in: regexes } }).toArray();
    return docs2.map((doc) => toSummary(doc, priceSource));
  }
  if (filters.oracle_ids?.length) {
    const docs2 = await db.collection("cards").find({ _id: { $in: filters.oracle_ids } }).toArray();
    return docs2.map((doc) => toSummary(doc, priceSource));
  }
  if (filters.arena_grp_ids?.length) {
    const docs2 = await db.collection("cards").find({ arena_grp_ids: { $in: filters.arena_grp_ids } }).toArray();
    return docs2.map((doc) => toSummary(doc, priceSource));
  }
  const query = {};
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
  if (filters.cmc_min !== void 0 || filters.cmc_max !== void 0) {
    const cmcFilter = {};
    if (filters.cmc_min !== void 0) cmcFilter.$gte = filters.cmc_min;
    if (filters.cmc_max !== void 0) cmcFilter.$lte = filters.cmc_max;
    query.cmc = cmcFilter;
  }
  if (filters.oracle_text_contains) {
    query.oracle_text = { $regex: filters.oracle_text_contains, $options: "i" };
  }
  if (filters.legal_in) {
    query[`legalities.${filters.legal_in}`] = "legal";
  }
  if (filters.max_price_usd !== void 0) {
    query.$or = [
      { "market_data.cardkingdom.price_usd": { $lte: filters.max_price_usd } },
      { "market_data.manapool.price_usd": { $lte: filters.max_price_usd } }
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
  const docs = await db.collection("cards").find(query).limit(Math.min(filters.limit ?? 25, 100)).toArray();
  return docs.map((doc) => toSummary(doc, priceSource));
}
export {
  queryCards
};
