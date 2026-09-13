/**
 * mongo_schema/commander_synergy_schema.js
 *
 * EDHREC's commander-relative data -- recommended cards, per-card synergy scores, and the average
 * decklist -- as its own collection, keyed by commander. Deliberately NOT folded into schema.js's
 * `cards` collection, for the mirror-image reason combo_schema.js's combos aren't: a synergy score
 * isn't a fact about a card, it's a fact about a (commander, card) PAIR, computed by EDHREC over
 * the corpus of decks built around that one specific commander. The same card's synergy differs
 * under a different commander (Rhystic Study means something different in a Sultai shell than
 * under a mono-blue one), so there is no single "this card's synergy" value to put on the card
 * document -- only either an arbitrary pick of one commander, or an unbounded per-commander map
 * riding along on every popular card. Design only, not wired into index.js yet.
 *
 * ============================================================================================
 * SCOPE: all three of recommendations.js's commander-keyed functions, not just "synergies"
 * ============================================================================================
 * Covers sub-tools/edhrec/recommendations.js's getCommanderRecommendations, getCardSynergies, AND
 * getAverageDecklist in one document per commander -- these come from two separate EDHREC page
 * fetches (the commander recommendations/synergy page, and the average-decks page), but both are
 * read together by the same deck-building flow for the same commander, so consolidating them
 * follows the same "embed what's read together" reasoning schema.js's own header lays out for why
 * `cards` merges permanent facts with market_data/format_stats instead of splitting into more
 * collections. Each piece keeps its OWN fetched_at, though -- see STALENESS below -- since they're
 * still two independent live fetches, not one.
 *
 * ============================================================================================
 * KEYING: EDHREC's own URL slug, not a synthetic id
 * ============================================================================================
 * sub-tools/edhrec/client.js's slugify() already turns a commander name into the exact identifier
 * this project resolves before ever fetching anything from EDHREC (e.g. "Korvold, Fae-Cursed King"
 * -> "korvold-fae-cursed-king") -- reusing it as `_id` avoids inventing a second key that would
 * just need to be mapped back to the first. Partner/background commanders share ONE slug per
 * EDHREC's own convention (a pairing has its own page), not one per individual commander.
 *
 * ============================================================================================
 * RESOLUTION: two genuinely different cases, checked live against the real API (2026-09-13)
 * ============================================================================================
 * `recommended_cards` (from the /commanders/:slug.json and /cards/:slug.json cardviews): EDHREC
 * DOES give a real Scryfall id per card here -- but it's the PRINTING id (Scryfall's per-printing
 * `id`), not `oracle_id`. Confirmed by cross-checking a live cardview's `id` for "Smaug, Wicked
 * Worm" (19cc91f0-e724-41ac-b6d8-9a293bd63b42) against Scryfall's own record for that card: it
 * matched Scryfall's `id` (the printing), not its `oracle_id` (20535126-f811-4386-bdce-d73f30691724)
 * -- a different UUID. So ingestion needs one deterministic Scryfall printing-id -> oracle_id
 * lookup per card (cheap and reliable, e.g. batched through the same /cards/collection endpoint
 * cards.js already uses, just with `{ id }` identifiers instead of `{ name }`), NOT fuzzy name
 * matching. `scryfall_printing_id` is kept alongside the resolved `oracle_id` so that lookup only
 * ever needs to happen once per printing.
 *
 * `average_decklist` (from the /average-decks/:slug.json endpoint) is the genuinely name-only case:
 * confirmed live, its `deck.cards` entries are bare `[name, quantity]` tuples with no id at all.
 * Real fuzzy resolution against `cards.name` is required here, and can fail (name drift, a card not
 * cached yet) -- `oracle_id` stays `null` in that case rather than dropping the entry, same "null
 * means not resolved yet, not a bad entry" rule used throughout this schema set.
 */

import { isStale } from "./schema.js";

/** EDHREC's underlying numbers drift as more decks get logged and the meta shifts -- 14 days is a
 *  starting point, not a measured constant like schema.js's STALENESS_DAYS. Revisit once real
 *  usage shows how fast a commander's profile actually goes noticeably stale. */
const COMMANDER_SYNERGY_STALENESS_DAYS = {
  recommendations: 14,
  average_decklist: 14,
};

const COMMANDER_SYNERGY_SCHEMA = {
  bsonType: "object",
  required: ["_id", "commander_names"],
  properties: {
    _id: {
      bsonType: "string",
      description: "EDHREC slug, e.g. 'korvold-fae-cursed-king'.",
    },
    commander_names: {
      bsonType: "array",
      items: { bsonType: "string" },
      description: "As EDHREC names them -- one entry normally, two for a partner/background pairing's shared page.",
    },
    commander_oracle_ids: {
      bsonType: "array",
      items: { bsonType: ["string", "null"] },
      description: "Resolved against cards.name, same order and length as commander_names, null where unresolved.",
    },

    recommended_cards: {
      bsonType: ["array", "null"],
      description: "getCommanderRecommendations'/getCardSynergies' output for this commander -- EDHREC's recommended pool with per-card synergy/inclusion numbers. Null means not yet fetched, not an empty pool.",
      items: {
        bsonType: "object",
        required: ["name", "scryfall_printing_id"],
        properties: {
          name: { bsonType: "string" },
          scryfall_printing_id: { bsonType: "string", description: "EDHREC's own `id` for this cardview -- verified to be Scryfall's per-printing id, not oracle_id (see file header). Always present." },
          oracle_id: { bsonType: ["string", "null"], description: "Resolved from scryfall_printing_id via one Scryfall lookup at ingestion -- null only if that printing id itself can't be found (e.g. since removed from Scryfall), not a name-matching failure." },
          synergy_pct: { bsonType: ["double", "null"], description: "EDHREC's synergy score for this card specifically under this commander -- not portable to any other commander." },
          inclusion_pct: { bsonType: ["double", "null"], description: "How often this card shows up across decks built around this commander -- a popularity signal, distinct from synergy_pct." },
        },
      },
    },
    recommendations_fetched_at: { bsonType: ["date", "null"] },

    average_decklist: {
      bsonType: ["array", "null"],
      description: "getAverageDecklist's output -- a separate EDHREC page fetch from recommended_cards above (see file header), null meaning not yet fetched.",
      items: {
        bsonType: "object",
        required: ["name", "qty"],
        properties: {
          name: { bsonType: "string" },
          oracle_id: { bsonType: ["string", "null"] },
          qty: { bsonType: "int" },
        },
      },
    },
    average_decklist_fetched_at: { bsonType: ["date", "null"] },
  },
};

const COMMANDER_SYNERGY_INDEXES = [
  {
    collection: "commander_synergies",
    keys: { commander_oracle_ids: 1 },
    note: "Multikey -- look up a commander's profile by either partner's oracle_id, not just by knowing the exact EDHREC slug ahead of time.",
  },
  {
    collection: "commander_synergies",
    keys: { "recommended_cards.oracle_id": 1 },
    note: "Multikey -- the reverse lookup, \"which commanders recommend this card,\" not just commander -> cards.",
  },
];

export {
  COMMANDER_SYNERGY_SCHEMA,
  COMMANDER_SYNERGY_STALENESS_DAYS,
  COMMANDER_SYNERGY_INDEXES,
  isStale,
};
