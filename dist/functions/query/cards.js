import { DISPLAY_PRICE_SOURCES, DEFAULT_PRICE_SOURCE, priceFallbackOrder } from "../reference/price-sources.js";
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
  for (const store of priceFallbackOrder(priceSource)) {
    const price = entry[store]?.price_usd;
    if (price != null) return price;
  }
  return null;
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
    format_stats: doc.format_stats ?? [],
    roles: doc.role_flags ?? []
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
const TRIGGER_EVENTS = {
  etb: { "trigger.mode": "ChangesZone", "trigger.zone_change.to.type": "Battlefield" },
  dies: { "trigger.mode": "ChangesZone", "trigger.zone_change.from.type": "Battlefield", "trigger.zone_change.to.type": "Graveyard" },
  leaves_battlefield: { "trigger.mode": { $in: ["ChangesZone", "ChangesZoneAll"] }, "trigger.zone_change.from.type": "Battlefield" },
  put_into_graveyard: { "trigger.mode": "ChangesZone", "trigger.zone_change.to.type": "Graveyard" },
  attacks: { "trigger.mode": { $in: ["Attacks", "AttackersDeclared"] } },
  blocks: { "trigger.mode": { $in: ["Blocks", "AttackerBlocked", "BlockersDeclared"] } },
  cast_spell: { "trigger.mode": { $in: ["SpellCast", "SpellAbilityCast"] } },
  deals_damage: { "trigger.mode": { $in: ["DamageDone", "DamageDoneOnce", "DamageAll"] } },
  draws: { "trigger.mode": "Drawn" },
  discards: { "trigger.mode": "Discarded" },
  sacrificed: { "trigger.mode": "Sacrificed" },
  token_created: { "trigger.mode": "TokenCreated" },
  counter_added: { "trigger.mode": { $in: ["CounterAdded", "CounterAddedOnce"] } },
  life_gained: { "trigger.mode": "LifeGained" },
  life_lost: { "trigger.mode": "LifeLost" },
  upkeep: { "trigger.mode": "Phase", "trigger.conditions.Phase.type": { $regex: "Upkeep", $options: "i" } },
  end_step: { "trigger.mode": "Phase", "trigger.conditions.Phase.type": { $regex: "End", $options: "i" } },
  combat: { "trigger.mode": "Phase", "trigger.conditions.Phase.type": { $regex: "Combat", $options: "i" } }
};
const TRIGGER_EVENT_NAMES = Object.keys(TRIGGER_EVENTS);
function buildCardQuery(filters) {
  const query = {};
  if (filters.name_contains) {
    query.name = { $regex: filters.name_contains, $options: "i" };
  }
  if (filters.type_line_contains) {
    query.type_line = { $regex: escapeRegex(filters.type_line_contains), $options: "i" };
  }
  if (filters.color_identity_subset_of) {
    query.color_identity = { $not: { $elemMatch: { $nin: filters.color_identity_subset_of } } };
  }
  if (filters.color_identity_exact) {
    const exact = filters.color_identity_exact.map((c) => c.toUpperCase());
    query.color_identity = exact.length ? { $all: exact, $size: exact.length } : { $size: 0 };
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
      // Only the stores shown to users count toward a budget (2026-10-06) -- not Card Kingdom.
      $elemMatch: { $or: DISPLAY_PRICE_SOURCES.map((store) => ({ [`${store}.price_usd`]: { $lte: filters.max_price_usd } })) }
    };
  }
  if (filters.effect_in?.length || filters.trigger_kind || filters.effect_param_contains || filters.trigger_event || filters.trigger_watches || filters.cost_contains) {
    const effectMatch = {};
    if (filters.trigger_kind) effectMatch["trigger.kind"] = filters.trigger_kind;
    if (filters.trigger_event) {
      Object.assign(effectMatch, { "trigger.kind": "triggered" }, TRIGGER_EVENTS[filters.trigger_event] ?? { "trigger.mode": filters.trigger_event });
    }
    if (filters.trigger_watches?.type || filters.trigger_watches?.modifier) {
      const clause = {};
      if (filters.trigger_watches.type) clause.type = { $regex: `^${escapeRegex(filters.trigger_watches.type)}$`, $options: "i" };
      if (filters.trigger_watches.modifier) clause.modifiers = { $regex: `^${escapeRegex(filters.trigger_watches.modifier)}$`, $options: "i" };
      effectMatch["trigger.conditions.ValidCard"] = { $elemMatch: clause };
    }
    if (filters.cost_contains?.kind) {
      const part = { kind: { $regex: `^${escapeRegex(filters.cost_contains.kind)}$`, $options: "i" } };
      if (filters.cost_contains.arg) part.args = { $elemMatch: { $regex: escapeRegex(filters.cost_contains.arg), $options: "i" } };
      effectMatch["trigger.cost"] = { $elemMatch: part };
    }
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
  if (filters.effects_all?.length) {
    query["effects.result.effect"] = { $all: filters.effects_all };
  }
  if (filters.roles_any?.length) {
    query.role_flags = { $in: filters.roles_any };
  }
  if (filters.exclude_names?.length) query.name = { $nin: filters.exclude_names };
  if (filters.exclude_oracle_ids?.length) {
    query._id = { $nin: filters.exclude_oracle_ids };
  }
  if (filters.nor?.length) {
    query.$nor = filters.nor.map((f) => buildCardQuery({ ...f, nor: void 0, exclude_oracle_ids: void 0, exclude_names: void 0 }));
  }
  return query;
}
async function queryCards(db, filters, priceSource = DEFAULT_PRICE_SOURCE, preferredPrinting = "most_recent") {
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
  const query = buildCardQuery(filters);
  const docs = await db.collection("cards").find(query).limit(Math.min(filters.limit ?? 25, 100)).toArray();
  return finalize(db, docs, priceSource, pinned, preferredPrinting);
}
export {
  TRIGGER_EVENT_NAMES,
  buildCardQuery,
  queryCards
};
