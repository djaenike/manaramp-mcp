/**
 * functions/query/candidates.ts
 *
 * Light candidate lookup for fill_deck_plan / edit_deck (2026-09-27): the same filters as query_cards
 * (buildCardQuery), but returning only name/cmc/type/roles and ONE price per card, picked inside
 * Mongo -- a card's full printings + market_data (a basic land carries ~95KB) never reach the Worker
 * for cards that don't end up in the deck. Full card data is fetched afterwards for the picks only.
 *
 * Price = the most recent printing's price at the preferred source, falling back to the other --
 * good enough for ranking and budget math; the submitted deck is priced properly by
 * validate_and_submit's own analysis.
 */
import type { Db } from "mongodb";
import { buildCardQuery, type QueryCardsFilters } from "./cards.js";
import type { PriceSource } from "../../tools/types.js";
import { DEFAULT_PRICE_SOURCE, priceFallbackOrder } from "../reference/price-sources.js";

interface Candidate {
  _id: string;
  name: string;
  cmc: number | null;
  type_line: string;
  roles: string[];
  color_identity: string[];
  printings?: number;
  price_usd: number | null;
}

async function findCandidates(
  db: Db,
  filters: QueryCardsFilters,
  limit: number,
  priceSource: PriceSource = DEFAULT_PRICE_SOURCE,
  opts: { sample?: boolean; rankByPrintings?: boolean } = {}
): Promise<Candidate[]> {
  // Multi-argument $ifNull: the first store in fallback order that has a price for this printing.
  const order = priceFallbackOrder(priceSource);
  return db
    .collection("cards")
    .aggregate<Candidate>([
      { $match: buildCardQuery(filters) },
      // sample: a fresh random draw from ALL matches each call (commander suggestions reshuffle on
      // every request) instead of the first N in natural order.
      // rankByPrintings (2026-09-28): most-reprinted first -- a card printed in dozens of products
      // (Arcane Signet, Cultivate, Swords to Plowshares) is a staple; one-printing filler isn't. A
      // quality signal from Manaramp's own data, no EDHREC. Without it, $limit keeps whatever the
      // first matches in storage order happen to be.
      ...(opts.rankByPrintings && !opts.sample
        ? [{ $addFields: { _printings: { $size: { $ifNull: ["$scryfall_printings", []] } } } }, { $sort: { _printings: -1, _id: 1 } }]
        : []),
      opts.sample ? { $sample: { size: limit } } : { $limit: limit },
      {
        $project: {
          name: 1,
          cmc: 1,
          type_line: 1,
          roles: { $ifNull: ["$role_flags", []] },
          printings: { $size: { $ifNull: ["$scryfall_printings", []] } },
          color_identity: { $ifNull: ["$color_identity", []] },
          price_usd: {
            $let: {
              vars: {
                latest: { $first: { $sortArray: { input: { $ifNull: ["$scryfall_printings", []] }, sortBy: { released_at: -1 } } } },
              },
              in: {
                $let: {
                  vars: {
                    m: { $first: { $filter: { input: { $ifNull: ["$market_data", []] }, as: "m", cond: { $eq: ["$$m.scryfall_id", "$$latest.scryfall_id"] } } } },
                  },
                  in: { $ifNull: order.map((store) => `$$m.${store}.price_usd`) },
                },
              },
            },
          },
        },
      },
    ])
    .toArray();
}

/** Deterministic shuffle (mulberry32 over a string seed) -- 'varied' ordering that's stable for a
 *  given draft, so re-filling the same plan gives the same deck, but two plans don't. */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export { findCandidates, seededShuffle };
export type { Candidate };
