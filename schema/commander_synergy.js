/**
 * schema/commander_synergy.js
 *
 * EDHREC's commander-relative data -- recommended cards, synergy scores, average decklist -- as
 * its own collection, keyed by commander. Not folded into card.js's `cards`, mirroring combo.js: a
 * synergy score is a fact about a (commander, card) PAIR (Rhystic Study's synergy differs by
 * commander), not something one card document can hold. Design only -- not wired into index.js yet.
 *
 * Covers all three of recommendations.js's commander-keyed functions
 * (getCommanderRecommendations/getCardSynergies/getAverageDecklist) in one document per commander,
 * since they're read together -- but each keeps its own fetched_at, since they're two separate
 * EDHREC page fetches.
 *
 * Keyed by EDHREC's own slug (edhrec/client.js's slugify()) -- partner/background commanders
 * share one slug per EDHREC's own convention.
 *
 * Resolution, checked live (2026-09-13): `recommended_cards` gets a real Scryfall id from EDHREC,
 * but it's the per-PRINTING id, not oracle_id (confirmed by cross-checking against Scryfall
 * directly) -- needs one deterministic printing-id -> oracle_id lookup, not name matching.
 * `average_decklist` is genuinely name-only (bare [name, qty] tuples) -- real fuzzy resolution
 * against cards.name is needed there, and can fail; oracle_id stays null rather than dropping the
 * entry.
 */

import { isStale } from "./card.js";

/** Not a measured constant like card.js's STALENESS_DAYS -- a starting guess, revisit once usage
 *  shows how fast a commander's profile actually goes stale. */
const COMMANDER_SYNERGY_STALENESS_DAYS = {
  recommendations: 14,
  average_decklist: 14,
};

const COMMANDER_SYNERGIES = {
  bsonType: "object",
  required: ["_id", "commander_names"],
  properties: {
    _id: { bsonType: "string", description: "EDHREC slug, e.g. 'korvold-fae-cursed-king'." },
    commander_names: { bsonType: "array", items: { bsonType: "string" }, description: "One entry normally, two for a partner/background pairing." },
    commander_oracle_ids: { bsonType: "array", items: { bsonType: ["string", "null"] }, description: "Resolved against cards.name, same order as commander_names." },

    recommended_cards: {
      bsonType: ["array", "null"],
      description: "EDHREC's recommended pool for this commander. Null means not yet fetched.",
      items: {
        bsonType: "object",
        required: ["name", "scryfall_printing_id"],
        properties: {
          name: { bsonType: "string" },
          scryfall_printing_id: { bsonType: "string", description: "EDHREC's own id -- Scryfall's per-printing id, not oracle_id." },
          oracle_id: { bsonType: ["string", "null"], description: "Resolved from scryfall_printing_id via one Scryfall lookup." },
          synergy_pct: { bsonType: ["double", "null"], description: "Synergy under this commander specifically -- not portable to another." },
          inclusion_pct: { bsonType: ["double", "null"], description: "Popularity across this commander's decks." },
        },
      },
    },
    recommendations_fetched_at: { bsonType: ["date", "null"] },

    average_decklist: {
      bsonType: ["array", "null"],
      description: "A separate EDHREC fetch from recommended_cards. Null means not yet fetched.",
      items: {
        bsonType: "object",
        required: ["name", "qty"],
        properties: {
          name: { bsonType: "string" },
          oracle_id: { bsonType: ["string", "null"], description: "Resolved by name match against cards.name -- can fail; null means unresolved, not a bad entry." },
          qty: { bsonType: "int" },
        },
      },
    },
    average_decklist_fetched_at: { bsonType: ["date", "null"] },
  },
};

const COMMANDER_SYNERGY_INDEXES = [
  { collection: "commander_synergies", keys: { commander_oracle_ids: 1 }, note: "Look up by either partner's oracle_id." },
  { collection: "commander_synergies", keys: { "recommended_cards.oracle_id": 1 }, note: "Which commanders recommend this card." },
];

export {
  COMMANDER_SYNERGIES,
  COMMANDER_SYNERGY_STALENESS_DAYS,
  COMMANDER_SYNERGY_INDEXES,
  isStale,
};
