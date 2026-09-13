/**
 * schema/indexes.js
 *
 * Every index across every collection in this schema set, in one place -- not yet created
 * anywhere (nothing is wired to a real database yet). Once real setup code exists:
 *
 *   for (const { collection, keys } of INDEXES) {
 *     await db.collection(collection).createIndex(keys);
 *   }
 *
 * Mirrored at manaramp/src/lib/server/schema/indexes.ts -- keep both in sync.
 */

const INDEXES = [
  // cards
  { collection: "cards", keys: { color_identity: 1, cmc: 1, category: 1 } },
  { collection: "cards", keys: { "legalities.commander": 1 } },
  { collection: "cards", keys: { arena_grp_ids: 1 }, note: "Multikey -- resolves a whole pack in one query." },
  { collection: "cards", keys: { name: 1 }, note: "Not unique -- different oracle_ids can share a printed name." },
  { collection: "cards", keys: { "format_stats.set_code": 1, "format_stats.format": 1 } },
  { collection: "cards", keys: { "format_stats.set_code": 1, "format_stats.format": 1, "format_stats.games_in_hand_win_rate": -1 }, note: "'Best cards in this format' queries." },

  // draft_sessions
  { collection: "draft_sessions", keys: { user_id: 1, started_at: -1 }, note: "A user's most recent draft." },

  // decks
  { collection: "decks", keys: { owner_user_id: 1, updated_at: -1 }, note: "My decks, most recent first." },
  { collection: "decks", keys: { format: 1, platform: 1 } },
  { collection: "decks", keys: { "cards.oracle_id": 1 }, note: "Multikey -- which decks run this card." },
  { collection: "decks", keys: { origin_draft_session_id: 1 } },

  // combos
  { collection: "combos", keys: { pieces: 1 }, note: "Multikey -- every combo a given card is part of." },
  { collection: "combos", keys: { color_identity: 1 } },

  // commander_synergies
  { collection: "commander_synergies", keys: { commander_oracle_ids: 1 }, note: "Look up by either partner's oracle_id." },
  { collection: "commander_synergies", keys: { "recommended_cards.oracle_id": 1 }, note: "Which commanders recommend this card." },
];

export { INDEXES };
