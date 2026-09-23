function pickDefaultPrinting(printings, pinnedScryfallId) {
  if (pinnedScryfallId) {
    const pinned = printings.find((p) => p.scryfall_id === pinnedScryfallId);
    if (pinned) return pinned;
  }
  if (printings.length === 0) return null;
  let best = printings[0];
  for (const p of printings) {
    if ((p.released_at ?? "") > (best.released_at ?? "")) best = p;
  }
  return best;
}
function resolvePriceForEntry(entry, priceSource) {
  if (!entry) return null;
  const preferred = priceSource === "manapool" ? entry.manapool : entry.cardkingdom;
  const other = priceSource === "manapool" ? entry.cardkingdom : entry.manapool;
  return preferred?.price_usd ?? other?.price_usd ?? null;
}
function pickCheapestPrinting(printings, marketData, priceSource, pinnedScryfallId) {
  if (pinnedScryfallId) {
    const pinned = printings.find((p) => p.scryfall_id === pinnedScryfallId);
    if (pinned) return pinned;
  }
  let best = null;
  let bestPrice = Infinity;
  for (const p of printings) {
    const entry = marketData.find((m) => m.scryfall_id === p.scryfall_id);
    const price = resolvePriceForEntry(entry, priceSource);
    if (price != null && price < bestPrice) {
      bestPrice = price;
      best = p;
    }
  }
  return best ?? pickDefaultPrinting(printings, pinnedScryfallId);
}
function pickPreferredPrinting(printings, marketData, priceSource, preferredPrinting, pinnedScryfallId) {
  return preferredPrinting === "cheapest" ? pickCheapestPrinting(printings, marketData, priceSource, pinnedScryfallId) : pickDefaultPrinting(printings, pinnedScryfallId);
}
function collectTokenScriptNames(effects) {
  const names = /* @__PURE__ */ new Set();
  const visitStep = (step) => {
    const tokenScript = step.params["TokenScript"];
    if (Array.isArray(tokenScript)) for (const clause of tokenScript) names.add(clause.type);
    for (const nested of step.nested_effects ?? []) visitEffect(nested);
    if (step.branch) {
      for (const s of step.branch.true_result) visitStep(s);
      for (const s of step.branch.false_result) visitStep(s);
    }
    for (const choiceSteps of Object.values(step.choices ?? {})) {
      for (const s of choiceSteps) visitStep(s);
    }
  };
  const visitEffect = (e) => {
    for (const step of e.result) visitStep(step);
    for (const nested of e.trigger.nested_effects ?? []) visitEffect(nested);
  };
  for (const e of effects) visitEffect(e);
  return names;
}
function enrichEffectsWithTokens(effects, tokensById) {
  const tokensFor = (step) => {
    const tokenScript = step.params["TokenScript"];
    if (!Array.isArray(tokenScript)) return void 0;
    const tokens = {};
    for (const clause of tokenScript) {
      const descriptor = tokensById.get(clause.type);
      if (descriptor) tokens[clause.type] = descriptor;
    }
    return Object.keys(tokens).length > 0 ? tokens : void 0;
  };
  const enrichEffect = (e) => ({
    trigger: { ...e.trigger, nested_effects: (e.trigger.nested_effects ?? []).map(enrichEffect) },
    result: e.result.map(enrichStep)
  });
  function enrichStep(step) {
    return {
      ...step,
      nested_effects: (step.nested_effects ?? []).map(enrichEffect),
      tokens: tokensFor(step),
      branch: step.branch ? { ...step.branch, true_result: step.branch.true_result.map(enrichStep), false_result: step.branch.false_result.map(enrichStep) } : null,
      choices: Object.fromEntries(Object.entries(step.choices ?? {}).map(([name, choiceSteps]) => [name, choiceSteps.map(enrichStep)]))
    };
  }
  return effects.map(enrichEffect);
}
function toSummary(doc, priceSource, tokensById, pinnedScryfallId, preferredPrinting = "most_recent") {
  const printings = doc.scryfall_printings ?? [];
  const marketData = doc.market_data ?? [];
  const printing = pickPreferredPrinting(printings, marketData, priceSource, preferredPrinting, pinnedScryfallId);
  const marketEntry = marketData.find((m) => m.scryfall_id === printing?.scryfall_id);
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
    keywords: doc.keywords ?? null,
    effects: enrichEffectsWithTokens(doc.effects ?? [], tokensById),
    printing: printing ? { scryfall_id: printing.scryfall_id, set_code: printing.set_code, collector_number: printing.collector_number } : null,
    price_usd: resolvePriceForEntry(marketEntry, priceSource),
    image_url: printing?.image_url ?? null,
    format_stats: doc.format_stats ?? []
  };
}
async function resolveTokenScripts(db, docs) {
  const names = /* @__PURE__ */ new Set();
  for (const doc of docs) for (const name of collectTokenScriptNames(doc.effects ?? [])) names.add(name);
  if (names.size === 0) return /* @__PURE__ */ new Map();
  const found = await db.collection("token_scripts").find(
    { _id: { $in: [...names] }, name: { $ne: "" } },
    { projection: { _id: 1, name: 1, types: 1, pt: 1, colors: 1, keywords: 1, effects: 1 } }
  ).toArray();
  return new Map(found.map(({ _id, ...descriptor }) => [_id, descriptor]));
}
async function finalize(db, docs, priceSource, pinned, preferredPrinting = "most_recent") {
  const tokensById = await resolveTokenScripts(db, docs);
  return docs.map((doc) => toSummary(doc, priceSource, tokensById, pinned(doc._id), preferredPrinting));
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const ZONE_CHANGE_KEY_MAP = { Origin: "from", Destination: "to", ChangeType: "what" };
function keyPaths(key) {
  const paths = [`params.${key}`, `conditions.${key}`];
  const zoneKey = ZONE_CHANGE_KEY_MAP[key];
  if (zoneKey) paths.push(`zone_change.${zoneKey}`);
  return paths;
}
async function queryCards(db, filters, priceSource = "cardkingdom", preferredPrinting = "most_recent") {
  const pinned = (id) => filters.printing_preferences?.[id];
  if (filters.names?.length) {
    const regexes = filters.names.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
    const docs2 = await db.collection("cards").find({ name: { $in: regexes } }).toArray();
    return finalize(db, docs2, priceSource, pinned, preferredPrinting);
  }
  if (filters.oracle_ids?.length) {
    const docs2 = await db.collection("cards").find({ _id: { $in: filters.oracle_ids } }).toArray();
    return finalize(db, docs2, priceSource, pinned, preferredPrinting);
  }
  if (filters.arena_grp_ids?.length) {
    const docs2 = await db.collection("cards").find({ arena_grp_ids: { $in: filters.arena_grp_ids } }).toArray();
    return finalize(db, docs2, priceSource, pinned, preferredPrinting);
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
    query.market_data = {
      $elemMatch: { $or: [{ "cardkingdom.price_usd": { $lte: filters.max_price_usd } }, { "manapool.price_usd": { $lte: filters.max_price_usd } }] }
    };
  }
  if (filters.effect_in?.length || filters.trigger_kind || filters.effect_param_contains) {
    const effectMatch = {};
    if (filters.trigger_kind) effectMatch["trigger.kind"] = filters.trigger_kind;
    const stepMatch = {};
    if (filters.effect_in?.length) stepMatch.effect = { $in: filters.effect_in };
    if (filters.effect_param_contains) {
      const { key, value_contains } = filters.effect_param_contains;
      const re = { $regex: value_contains, $options: "i" };
      stepMatch.$or = keyPaths(key).flatMap((p) => [{ [`${p}.type`]: re }, { [`${p}.modifiers`]: re }]);
    }
    if (Object.keys(stepMatch).length > 0) {
      effectMatch.result = { $elemMatch: stepMatch };
    }
    query.effects = { $elemMatch: effectMatch };
  }
  const docs = await db.collection("cards").find(query).limit(Math.min(filters.limit ?? 25, 100)).toArray();
  return finalize(db, docs, priceSource, pinned, preferredPrinting);
}
export {
  queryCards
};
