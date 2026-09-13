/**
 * schema/decks.js
 *
 * One `decks` collection covering every format (Commander, Standard, Arena Draft, ...) -- same
 * "embed what's read together" call as schema/cards.js. Design only -- not wired into index.js
 * yet.
 *
 * `format` (commander/standard/draft/...) and `platform` (paper/arena) are separate fields, not a
 * combinatorial enum. Format-specific fields (commander, bracket) are null when they don't apply,
 * rather than a separate collection per format. Deckbuilding rules (100-card singleton, etc.) are
 * validated by application code, not encoded here.
 *
 * `cards` is oracle_id-keyed, same identity as cards.js's `cards` collection. price_usd is
 * time-varying -- check isStale() (schema/staleness.js) before trusting.
 *
 * Mirrored at manaramp/src/lib/server/schema/decks.ts -- keep both in sync.
 */

const DECKS = {
  bsonType: "object",
  required: ["_id", "owner_user_id", "name", "format", "cards"],
  properties: {
    _id: { bsonType: "string", description: "Generated UUID." },
    owner_user_id: { bsonType: "string", description: "Same user_id as draft_sessions.user_id." },
    name: { bsonType: "string" },

    format: { bsonType: "string", description: "'commander' | 'standard' | 'draft' | 'modern' | ... -- open-ended, not a hard enum." },
    platform: { bsonType: ["string", "null"], description: "'paper' | 'arena' | null." },

    cards: {
      bsonType: "array",
      items: {
        bsonType: "object",
        required: ["oracle_id", "quantity", "zone"],
        properties: {
          oracle_id: { bsonType: "string" },
          quantity: { bsonType: "int" },
          zone: { bsonType: "string", description: "'main' | 'sideboard' | 'commander' | 'maybeboard'." },
        },
      },
    },
    size_summary: {
      bsonType: ["object", "null"],
      description: "Denormalized counts, recomputed whenever cards changes -- not authoritative on its own.",
      properties: {
        main: { bsonType: "int" },
        sideboard: { bsonType: "int" },
        commander: { bsonType: "int" },
        total: { bsonType: "int" },
      },
    },

    commander: {
      bsonType: ["object", "null"],
      description: "Commander-only. oracle_ids is an array to cover partner/background commanders.",
      properties: {
        oracle_ids: { bsonType: "array", items: { bsonType: "string" } },
        color_identity: { bsonType: "array", items: { bsonType: "string" } },
      },
    },
    bracket: {
      bsonType: ["object", "null"],
      description: "Commander-only, same shape as bracket/rating.js's computeBracketRating output.",
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

    mana_curve: { bsonType: ["object", "null"], description: "CMC bucket -> count." },
    curve_out_probability: { bsonType: ["object", "null"], description: "turn_1..turn_6 probabilities." },
    consistency_issues: { bsonType: "array", items: { bsonType: "string" } },

    price_usd: { bsonType: ["double", "null"] },
    price_fetched_at: { bsonType: ["date", "null"], description: "isStale(price_fetched_at, DECK_STALENESS_DAYS.price) before trusting price_usd." },

    wincon_summary: { bsonType: ["string", "null"] },
    general_strategy: { bsonType: ["string", "null"] },

    source: { bsonType: ["string", "null"], description: "'new_deck_creation' | 'existing_deck_cleanup' | 'moxfield_import' | 'manual' | null." },
    moxfield_url: { bsonType: ["string", "null"] },
    origin_draft_session_id: { bsonType: ["string", "null"], description: "Links to draft_sessions._id if built from a completed draft." },

    created_at: { bsonType: "date" },
    updated_at: { bsonType: "date" },
  },
};

export { DECKS };
