/**
 * schema/staleness.js
 *
 * Shared staleness helper for every collection with time-varying fields (cards.market_data/
 * format_stats, decks.price, commander_synergies.recommended_cards/average_decklist). No TTL
 * index is used anywhere in this schema set -- deleting a whole document to expire one field
 * would also delete permanent facts living alongside it. isStale() is the app-level replacement:
 * call it against a field's own fetched_at/as_of before trusting it. Present-but-stale must be
 * treated like absent (re-fetch), never served as current.
 *
 * Mirrored at manaramp/src/lib/server/schema/staleness.ts -- keep both in sync.
 */

/** How long each kind of time-varying data stays trustworthy -- different per kind on purpose. */
const CARD_STALENESS_DAYS = {
  market_data: 7,   // prices move fast
  format_stats: 30, // 17Lands numbers settle after a set's first couple weeks
};

/** Shorter than CARD_STALENESS_DAYS.market_data -- someone looking at their own deck cares more
 *  about "is this right today" than a card sitting unresolved in the general pool. */
const DECK_STALENESS_DAYS = { price: 3 };

/** A starting guess, not a measured constant -- revisit once usage shows how fast a commander's
 *  profile actually goes stale. */
const COMMANDER_SYNERGY_STALENESS_DAYS = {
  recommendations: 14,
  average_decklist: 14,
};

function isStale(timestamp, maxAgeDays) {
  if (!timestamp) return true;
  const ageMs = Date.now() - new Date(timestamp).getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

export { CARD_STALENESS_DAYS, DECK_STALENESS_DAYS, COMMANDER_SYNERGY_STALENESS_DAYS, isStale };
