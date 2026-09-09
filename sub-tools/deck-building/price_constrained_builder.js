/**
 * sub-tools/deck-building/price_constrained_builder.js
 * (renamed from budget_builder.js -- this isn't a "cheap decks only" tool, it's a
 * general auto-builder that respects an optional price ceiling. Passing no
 * price_limit_usd at all builds the highest-synergy 99 cards with no price
 * filtering whatsoever -- a $50 constraint and "no constraint" are the same
 * code path, just a different (or infinite) ceiling.)
 *
 * Greedy knapsack: pulls the commander's full EDHREC card pool, prices each
 * candidate via Card Kingdom, sorts by synergy-per-dollar, fills 99 nonland
 * slots without exceeding price_limit_usd. NOT a true power-level classifier,
 * and NOT mana-curve-aware -- at a high/no price limit this will happily stack
 * up expensive high-synergy staples with no regard for curve smoothness. See
 * caveats in the returned `note` field.
 */

import { EDHREC_BASE, slugify } from "../edhrec/client.js";
import { HEADERS } from "../scryfall/client.js";
import { fetchPriceByNameMap } from "../cardkingdom/pricing.js";

async function buildDeckByPrice(commander_name, price_limit_usd, min_synergy_pct) {
  const slug = slugify(commander_name);

  const edhrecRes = await fetch(`${EDHREC_BASE}/commanders/${slug}.json`, { headers: HEADERS });
  if (edhrecRes.status === 404) {
    throw new Error(`No EDHREC page found for '${commander_name}'. Check spelling.`);
  }
  if (!edhrecRes.ok) {
    throw new Error(`EDHREC request failed: ${edhrecRes.status} ${edhrecRes.statusText}`);
  }
  const edhrecData = await edhrecRes.json();
  const cardlists = edhrecData?.container?.json_dict?.cardlists ?? [];
  if (cardlists.length === 0) {
    throw new Error(`No card pool data found for '${commander_name}' on EDHREC.`);
  }

  const candidates = new Map();
  for (const section of cardlists) {
    for (const card of section.cardviews ?? []) {
      const cardName = card.name;
      const synergy = typeof card.synergy === "number" ? card.synergy * 100 : (card.inclusion ?? 0);
      if (!cardName) continue;
      if (!candidates.has(cardName) || candidates.get(cardName).synergy < synergy) {
        candidates.set(cardName, { name: cardName, synergy, category: section.header });
      }
    }
  }

  let pool = Array.from(candidates.values());
  if (min_synergy_pct !== undefined) {
    pool = pool.filter((c) => c.synergy >= min_synergy_pct);
  }
  if (pool.length === 0) {
    throw new Error(`No candidates found after filtering. Try lowering min_synergy_pct.`);
  }

  const priceByName = await fetchPriceByNameMap();

  const priced = pool
    .map((c) => ({ ...c, price: priceByName.get(c.name) }))
    .filter((c) => c.price !== undefined && c.price > 0);
  if (priced.length === 0) {
    throw new Error(`None of the EDHREC candidates for '${commander_name}' were found in Card Kingdom's in-stock pricelist.`);
  }

  priced.sort((a, b) => (b.synergy / b.price) - (a.synergy / a.price));

  // No price_limit_usd -> Infinity -> the budget check below never trips -> every
  // candidate up to 99 cards is eligible purely on synergy/price ranking.
  const limit = price_limit_usd ?? Infinity;

  const deck = [];
  let runningTotal = 0;
  for (const card of priced) {
    if (deck.length >= 99) break;
    if (runningTotal + card.price > limit) continue;
    deck.push(card);
    runningTotal += card.price;
  }

  return {
    commander: commander_name,
    price_limit_usd: price_limit_usd ?? null,
    nonland_cards_selected: deck.length,
    total_spent_usd: Math.round(runningTotal * 100) / 100,
    budget_remaining_usd: price_limit_usd !== undefined ? Math.round((limit - runningTotal) * 100) / 100 : null,
    note: "Synergy-per-dollar greedy optimization from EDHREC data + Card Kingdom pricing. Does NOT verify combo lines, mana curve, color balance, or land count — sanity-check before playing. Basic lands and the commander itself are excluded from this count and any price limit. With no price_limit_usd, this selects purely by synergy ranking with no price ceiling at all.",
    deck: deck.map((c) => ({ name: c.name, category: c.category, synergy_pct: Math.round(c.synergy * 10) / 10, price_usd: c.price })),
  };
}

export { buildDeckByPrice };
