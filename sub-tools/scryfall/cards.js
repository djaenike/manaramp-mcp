/**
 * sub-tools/scryfall/cards.js
 *
 * Same logic as index.js's search_cards / get_card_by_name / get_rulings tools,
 * refactored to return plain JS data instead of MCP-wrapped { content: [...] }
 * responses, so orchestrator tools can compose them directly. searchCards/
 * getCardByName both include a `category` field (Creature/Instant/Sorcery/etc,
 * via classify.js's classifyCategory) alongside the raw `type_line`, so Claude
 * doesn't have to parse the type line itself while picking cards during a build.
 */

import { SCRYFALL_BASE, HEADERS, scryfallFetch } from "./client.js";
import { classifyCategory } from "./classify.js";

/**
 * Search cards via Scryfall's search syntax.
 * NOTE ON PRICING: the returned 'usd' field is Scryfall's bundled market price
 * (TCGPlayer-sourced) — fast bulk estimate, NOT the standardized price source
 * for this server. Use cardkingdom/pricing.js for an exact, purchasable price.
 */
async function searchCards(query, max_price_usd) {
  const url = `${SCRYFALL_BASE}/cards/search?q=${encodeURIComponent(query)}`;
  const res = await scryfallFetch(url, { headers: HEADERS }, "search");

  if (!res.ok) {
    throw new Error(`Scryfall search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  let cards = data.data ?? [];

  if (max_price_usd !== undefined) {
    cards = cards.filter((c) => {
      const price = parseFloat(c.prices?.usd ?? "Infinity");
      return price <= max_price_usd;
    });
  }

  return cards.slice(0, 25).map((c) => ({
    name: c.name,
    mana_cost: c.mana_cost,
    type_line: c.type_line,
    category: classifyCategory(c.type_line),
    oracle_text: c.oracle_text,
    usd: c.prices?.usd ?? "N/A",
    legal_commander: c.legalities?.commander,
    legal_standard: c.legalities?.standard,
  }));
}

/** Get exact details for a single card by name (fuzzy matched by Scryfall). */
async function getCardByName(name) {
  const url = `${SCRYFALL_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`;
  const res = await scryfallFetch(url, { headers: HEADERS }, "named");

  if (!res.ok) {
    throw new Error(`Card not found: ${name} (${res.status})`);
  }

  const c = await res.json();
  return {
    name: c.name,
    mana_cost: c.mana_cost,
    type_line: c.type_line,
    category: classifyCategory(c.type_line),
    oracle_text: c.oracle_text,
    usd: c.prices?.usd ?? "N/A",
    legalities: c.legalities,
    set: c.set_name,
  };
}

/** Get official rulings for a card by exact name. */
async function getRulings(name) {
  const cardRes = await scryfallFetch(`${SCRYFALL_BASE}/cards/named?exact=${encodeURIComponent(name)}`, { headers: HEADERS }, "named");
  if (!cardRes.ok) {
    throw new Error(`Card not found: ${name}`);
  }
  const card = await cardRes.json();

  const rulingsRes = await scryfallFetch(card.rulings_uri, { headers: HEADERS }, "default");
  const rulingsData = await rulingsRes.json();
  return (rulingsData.data ?? []).map((r) => r.comment);
}

export { searchCards, getCardByName, getRulings };
