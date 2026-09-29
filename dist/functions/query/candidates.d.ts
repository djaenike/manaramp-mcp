import { Db } from 'mongodb';
import { QueryCardsFilters } from './cards.js';

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
declare function findCandidates(db: Db, filters: QueryCardsFilters, limit: number, priceSource?: "cardkingdom" | "manapool", opts?: {
    sample?: boolean;
    rankByPrintings?: boolean;
}): Promise<Candidate[]>;
/** Deterministic shuffle (mulberry32 over a string seed) -- 'varied' ordering that's stable for a
 *  given draft, so re-filling the same plan gives the same deck, but two plans don't. */
declare function seededShuffle<T>(items: T[], seed: string): T[];

export { type Candidate, findCandidates, seededShuffle };
