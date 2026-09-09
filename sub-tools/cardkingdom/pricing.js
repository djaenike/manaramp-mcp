/**
 * sub-tools/cardkingdom/pricing.js
 * Card Kingdom has no official developer API, but publishes a public bulk
 * pricelist used by community tools. This is a single large file covering
 * all CK singles, fetched once per lookup and filtered in memory.
 */

import { HEADERS } from "../scryfall/client.js";

const CARDKINGDOM_PRICELIST_URL = "https://api.cardkingdom.com/api/v2/pricelist";

async function getCardKingdomPrice(name, include_foil) {
  const res = await fetch(CARDKINGDOM_PRICELIST_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Card Kingdom pricelist request failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  const products = body?.data ?? [];

  const nameLower = name.trim().toLowerCase();
  const matches = products.filter((p) => {
    if ((p.name ?? "").toLowerCase() !== nameLower) return false;
    const isFoil = p.is_foil === true || p.is_foil === "true";
    if (isFoil && !include_foil) return false;
    const qty = Number(p.qty_retail ?? 0);
    return qty > 0;
  });

  if (matches.length === 0) {
    throw new Error(
      `No in-stock Card Kingdom listing found for '${name}'` +
      `${include_foil ? "" : " (non-foil only — try include_foil: true)"}. ` +
      `Check spelling, or the card may be out of stock / not carried by CK.`
    );
  }

  matches.sort((a, b) => parseFloat(a.price_retail) - parseFloat(b.price_retail));
  const cheapest = matches[0];

  return {
    name: cheapest.name,
    edition: cheapest.edition,
    is_foil: cheapest.is_foil === true || cheapest.is_foil === "true",
    price_usd: parseFloat(cheapest.price_retail),
    qty_in_stock: Number(cheapest.qty_retail ?? 0),
    scryfall_id: cheapest.scryfall_id || null,
    source: "cardkingdom",
  };
}

/** Shared by get_deck_price_total and deliver_finished_deck (via delivery/deliver_finished_deck.js). */
async function computeDeckPriceTotal(cardNames, includeFoil) {
  const res = await fetch(CARDKINGDOM_PRICELIST_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Card Kingdom pricelist request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const products = body?.data ?? [];

  const priceByName = new Map();
  for (const p of products) {
    const isFoil = p.is_foil === true || p.is_foil === "true";
    if (isFoil && !includeFoil) continue;
    const qty = Number(p.qty_retail ?? 0);
    if (qty <= 0) continue;
    const price = parseFloat(p.price_retail);
    if (isNaN(price)) continue;
    const nameLower = (p.name ?? "").toLowerCase();
    const existing = priceByName.get(nameLower);
    if (!existing || price < existing) priceByName.set(nameLower, price);
  }

  const priced = [];
  const notFound = [];
  for (const name of cardNames) {
    const price = priceByName.get(name.trim().toLowerCase());
    if (price === undefined) {
      notFound.push(name);
    } else {
      priced.push({ name, price_usd: price });
    }
  }

  const total = Math.round(priced.reduce((sum, c) => sum + c.price_usd, 0) * 100) / 100;

  return {
    total_usd: total,
    cards_priced: priced.length,
    cards_not_found: notFound.length ? notFound : undefined,
    note: notFound.length
      ? `${notFound.length} card(s) not found in Card Kingdom's in-stock pricelist — total_usd is a FLOOR, the real total is at least this much.`
      : "Every card was found and priced — total_usd should be the full, accurate deck cost.",
    breakdown: priced.sort((a, b) => b.price_usd - a.price_usd),
  };
}

/** Full CK pricelist fetch + name->cheapest-price map, factored out for build_budget_deck's reuse. */
async function fetchPriceByNameMap() {
  const res = await fetch(CARDKINGDOM_PRICELIST_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Card Kingdom pricelist request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const products = body?.data ?? [];

  const priceByName = new Map();
  for (const p of products) {
    const isFoil = p.is_foil === true || p.is_foil === "true";
    const qty = Number(p.qty_retail ?? 0);
    if (isFoil || qty <= 0) continue;
    const price = parseFloat(p.price_retail);
    if (isNaN(price)) continue;
    const existing = priceByName.get(p.name);
    if (!existing || price < existing) priceByName.set(p.name, price);
  }
  return priceByName;
}

export { CARDKINGDOM_PRICELIST_URL, getCardKingdomPrice, computeDeckPriceTotal, fetchPriceByNameMap };
