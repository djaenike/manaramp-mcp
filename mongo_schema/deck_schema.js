/**
 * mongo_schema/deck_schema.js
 *
 * ONE `decks` collection covering every deck type (Commander, Standard, Arena Draft, Arena
 * Standard, etc.) -- same consolidation call as schema.js's single `cards` collection, and for
 * the same reason: these are all fundamentally "a list of (card, quantity, zone)" plus some
 * metadata, and splitting by format would mean duplicating that shared shape N times for
 * differences that are actually pretty small. Not wired into index.js yet -- schema only.
 *
 * ============================================================================================
 * FORMAT + PLATFORM, not one format string per combination
 * ============================================================================================
 * "Commander," "Standard," "Arena Draft," "Arena Standard" aren't four unrelated shapes -- two
 * axes are doing the work: `format` (the deckbuilding ruleset: commander/standard/draft/...) and
 * `platform` (paper vs. arena, since the SAME format can be played in either). "Arena Standard" is
 * just `{ format: "standard", platform: "arena" }`; "Arena Draft" is `{ format: "draft", platform:
 * "arena" }`. This avoids a combinatorial enum (arena-standard, paper-standard, arena-draft, ...)
 * that grows every time a new platform or format shows up, and lets a query like "all my Standard
 * decks regardless of platform" stay a one-field filter instead of a $regex or an $in list.
 *
 * ============================================================================================
 * WHAT'S SHARED vs. WHAT'S FORMAT-SPECIFIC
 * ============================================================================================
 * Shared by every deck regardless of format: name, owner, a card list (`cards`, oracle_id-keyed --
 * the same identity schema.js's `cards` collection uses, so a deck's cards join straight into that
 * collection with no translation), a price, a mana curve.
 * Format-specific fields (`commander`, `bracket`) are simply null when they don't apply, rather
 * than living in a separate collection -- e.g. a Standard deck has `commander: null, bracket:
 * null`. The deckbuilding RULES themselves (100-card singleton for Commander vs. 60-card-minimum
 * 4-of-max for Standard vs. 40-card-minimum for Draft) are NOT encoded in this schema at all --
 * they're validated by application code per format (this server's existing
 * sub-tools/deck-building/consistency.js already does exactly this for Commander), the same way a
 * SQL table wouldn't encode "exactly 100 rows" as a column constraint either.
 *
 * ============================================================================================
 * PRICE IS TIME-VARYING HERE TOO
 * ============================================================================================
 * A deck's total price is derived from its cards' current prices, so it goes stale on the same
 * kind of schedule as a single card's market_data in schema.js -- just usually faster, since
 * someone actively looking at a deck cares more about "is this number right today" than a card
 * sitting unresolved in the general pool. Reuses schema.js's `isStale()` (no need for a second
 * implementation of the same check) with its own, shorter cutoff below.
 */

import { isStale } from "./schema.js";

/** Decks refresh their own total price on a shorter cycle than a single card's market_data (3
 *  days here vs. schema.js's 7) -- a deck is something someone's actively about to build/buy,
 *  where a stale total is a more immediate problem than one unresolved card sitting in the pool. */
const DECK_STALENESS_DAYS = { price: 3 };

// ------------------------------------------------------------------------------------------
// Collection: decks
// ------------------------------------------------------------------------------------------
const DECKS_SCHEMA = {
  bsonType: "object",
  required: ["_id", "owner_user_id", "name", "format", "cards"],
  properties: {
    _id: { bsonType: "string", description: "Generated UUID (randomUUID(), same mechanism as index.js's getOrCreateUserId) -- a deck has no natural external identifier the way a card has oracle_id or a draft has Arena's own draft_id." },
    owner_user_id: { bsonType: "string", description: "Same user_id as draft_sessions.user_id (schema.js) -- one anonymous per-install identity spans both collections." },
    name: { bsonType: "string", description: "deck_name, as already collected by new_deck_creation/existing_deck_cleanup today." },

    format: { bsonType: "string", description: "The deckbuilding ruleset: 'commander' | 'standard' | 'draft' | 'modern' | ... -- open-ended on purpose, not a hard enum, so a new format doesn't require a schema migration." },
    platform: { bsonType: ["string", "null"], description: "'paper' | 'arena' | null (unknown/not applicable). Combined with `format` above rather than folded into it -- see file header." },

    // --- The card list: shared shape across every format -------------------------------------
    cards: {
      bsonType: "array",
      description: "oracle_id-keyed, same identity as schema.js's `cards` collection -- joins directly, no name-matching needed the way the current name-keyed fullDeckList (delivery/deck_report_template.json) requires.",
      items: {
        bsonType: "object",
        required: ["oracle_id", "quantity", "zone"],
        properties: {
          oracle_id: { bsonType: "string" },
          quantity: { bsonType: "int" },
          zone: {
            bsonType: "string",
            description: "'main' | 'sideboard' | 'commander' | 'maybeboard'. Commander decks use 'main'+'commander'; constructed formats use 'main'+'sideboard'; a Draft pool's unused cards can sit in 'maybeboard' rather than needing a separate collection.",
          },
        },
      },
    },
    size_summary: {
      bsonType: ["object", "null"],
      description: "Denormalized counts (main/sideboard/commander/total) so a deck list view doesn't need to walk the whole `cards` array just to show '100 cards' -- recomputed whenever `cards` changes, not authoritative on its own.",
      properties: {
        main: { bsonType: "int" },
        sideboard: { bsonType: "int" },
        commander: { bsonType: "int" },
        total: { bsonType: "int" },
      },
    },

    // --- Format-specific: null when not applicable, not a separate collection ----------------
    commander: {
      bsonType: ["object", "null"],
      description: "Commander-only, null for every other format. oracle_ids is an array to cover partner/background commanders, not just one.",
      properties: {
        oracle_ids: { bsonType: "array", items: { bsonType: "string" } },
        color_identity: { bsonType: "array", items: { bsonType: "string" } },
      },
    },
    bracket: {
      bsonType: ["object", "null"],
      description: "Commander-only (the Bracket System doesn't apply outside Commander) -- same shape as bracket/rating.js's computeBracketRating output, null for every other format.",
      properties: {
        estimate: { bsonType: "string" },
        combos_found: {
          bsonType: "array",
          items: {
            bsonType: "object",
            properties: {
              pieces: { bsonType: "array", items: { bsonType: "string" } },
              speed: { bsonType: "string" },
            },
          },
        },
      },
    },

    // --- Analysis, format-agnostic (consistency.js already computes all of this today) -------
    mana_curve: { bsonType: ["object", "null"], description: "Same shape as report_data.js's manaCurve -- CMC bucket -> count." },
    curve_out_probability: { bsonType: ["object", "null"], description: "Same shape as consistency.js's curve_out_probability -- turn_1..turn_6 plus its own explanatory note." },
    consistency_issues: { bsonType: "array", items: { bsonType: "string" }, description: "Same strings analyze_deck_consistency already produces (wrong count, singleton violation, off-color card, not format-legal, etc.)." },

    // --- Price: time-varying, same isStale() treatment as schema.js's card-level market_data --
    price_usd: { bsonType: ["double", "null"] },
    price_fetched_at: { bsonType: ["date", "null"], description: "Check via isStale(price_fetched_at, DECK_STALENESS_DAYS.price) before trusting price_usd -- present doesn't mean current, same rule as schema.js's market_data." },

    wincon_summary: { bsonType: ["string", "null"] },
    general_strategy: { bsonType: ["string", "null"] },

    source: {
      bsonType: ["string", "null"],
      description: "How this deck entered the database -- 'new_deck_creation' | 'existing_deck_cleanup' | 'moxfield_import' | 'manual' | null. Purely provenance, doesn't affect validation.",
    },
    moxfield_url: { bsonType: ["string", "null"] },
    origin_draft_session_id: {
      bsonType: ["string", "null"],
      description: "Links back to draft_sessions._id (schema.js) for a deck built out of a completed Arena draft -- null for anything that didn't come from a draft.",
    },

    created_at: { bsonType: "date" },
    updated_at: { bsonType: "date" },
  },
};

// ------------------------------------------------------------------------------------------
// Indexes -- combine with schema.js's INDEXES at actual setup time; kept in this file rather
// than re-exported from schema.js so each schema file stays readable on its own.
// ------------------------------------------------------------------------------------------
const DECK_INDEXES = [
  { collection: "decks", keys: { owner_user_id: 1, updated_at: -1 }, note: "\"My decks, most recently updated first\" -- the primary listing view." },
  { collection: "decks", keys: { format: 1, platform: 1 }, note: "Browsing/filtering by format+platform (e.g. all Arena Standard decks) across all owners." },
  { collection: "decks", keys: { "cards.oracle_id": 1 }, note: "Multikey -- \"which of my decks run this card,\" without scanning every deck's full card array in application code." },
  { collection: "decks", keys: { origin_draft_session_id: 1 }, note: "Jump from a completed draft session straight to the deck built from it." },
];

export { DECKS_SCHEMA, DECK_STALENESS_DAYS, DECK_INDEXES, isStale };
