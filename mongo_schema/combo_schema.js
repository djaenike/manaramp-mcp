/**
 * mongo_schema/combo_schema.js
 *
 * Commander Spellbook combos as their own collection -- deliberately NOT folded into schema.js's
 * `cards` collection. A combo is a fact about a SET of cards, not about any one card in isolation
 * (Kiki-Jiki alone isn't a combo; Kiki-Jiki + a copy-and-untap creature is), and a single card can
 * be a piece of dozens of unrelated combos that Commander Spellbook's community-curated database
 * keeps growing independently of anything about the card itself. Embedding that on the card
 * document would mean an unbounded, constantly-resynced array riding along on every combo-heavy
 * card. Giving combos their own identity instead -- mirroring how Commander Spellbook itself models
 * them -- keeps that growth where it actually belongs. Design only, not wired into index.js yet.
 *
 * ============================================================================================
 * KEYING: Commander Spellbook's own combo id, not a synthetic one
 * ============================================================================================
 * Same reasoning schema.js gives for keying `cards` by Scryfall's oracle_id: this document IS a
 * cache of one specific upstream entity, so reuse its real identifier rather than inventing a
 * second one that then needs its own mapping back to the first.
 *
 * ============================================================================================
 * NO NAME-RESOLUTION NEEDED: Spellbook's raw API already returns real oracle_id
 * ============================================================================================
 * sub-tools/spellbook/combos.js's existing code only ever reads `u.card?.name` off each combo
 * piece -- it never needed more than that for the current tool. But checked live against the real
 * API (2026-09-13), each piece's `card` object already carries `oracleId` directly (confirmed:
 * Demonic Consultation's piece included `oracleId: "9a1412db-45ad-46ea-8f12-a85d203113d8"`,
 * Scryfall's own real oracle_id for that card, not a Spellbook-internal id). So `pieces` can be
 * populated straight from Spellbook's response at ingestion time -- no fuzzy name-matching against
 * `cards.name` required here, unlike commander_synergy_schema.js's average_decklist (see that
 * file's header for why EDHREC's case is genuinely different). `pieces_names` is kept alongside
 * purely for human-readable display/debugging, not as a resolution fallback.
 *
 * ============================================================================================
 * WHY NO isStale() HERE (unlike schema.js/deck_schema.js's time-varying fields)
 * ============================================================================================
 * Once documented, a combo's pieces/result are a fixed combinatorial fact that essentially never
 * changes -- the real risk isn't "this document went stale," it's "Spellbook added a brand new
 * combo we don't have at all yet." That's a coverage/completeness problem, solved by periodically
 * re-running a full sync sweep against Spellbook, not by an isStale() check against any one
 * document. `synced_at` is kept for bookkeeping (e.g. to prioritize a re-sync sweep), not as a
 * per-document trust gate the way `fetched_at`/`as_of` are elsewhere.
 */

const COMBOS_SCHEMA = {
  bsonType: "object",
  required: ["_id", "pieces_names", "pieces"],
  properties: {
    _id: {
      bsonType: "string",
      description: "Commander Spellbook's own combo id -- the stable identity for this documented combo.",
    },
    pieces_names: {
      bsonType: "array",
      items: { bsonType: "string" },
      description: "Card names exactly as Commander Spellbook returns them -- the source of truth for display, and for re-resolving oracle_id later if an earlier match attempt missed.",
    },
    pieces: {
      bsonType: "array",
      items: { bsonType: "string" },
      description: "oracle_id per entry in pieces_names, same order and length -- taken directly from Spellbook's own card.oracleId at ingestion (see file header), not resolved via name matching. This is the field the multikey index below actually targets.",
    },
    color_identity: {
      bsonType: "array",
      items: { bsonType: "string" },
      description: "Combined color identity across all pieces -- lets a deck-building query filter to combos that fit the deck's own color identity before checking piece-presence.",
    },
    result: {
      bsonType: ["string", "null"],
      description: "Spellbook's own prose description of what the combo does.",
    },
    steps: {
      bsonType: ["array", "null"],
      items: { bsonType: "string" },
      description: "Ordered steps, when Spellbook provides them structured -- null if only a prose result/description is available, not an error.",
    },
    speed: {
      bsonType: ["string", "null"],
      description: "Same classification sub-tools/bracket/rating.js's classifyComboSpeed already computes for a live check (e.g. an early/late/inconsistent-style bucket) -- cached here so re-checking this exact, already-documented combo doesn't mean recomputing it from scratch every time.",
    },
    spellbook_url: { bsonType: ["string", "null"] },
    synced_at: {
      bsonType: "date",
      description: "Last time this document was refreshed from Spellbook -- bookkeeping only, see file header for why this isn't an isStale() gate.",
    },
  },
};

const COMBO_INDEXES = [
  {
    collection: "combos",
    keys: { pieces: 1 },
    note: "Multikey -- \"every documented combo this card is a piece of\" is the query this collection exists to answer fast, given a card's oracle_id.",
  },
  {
    collection: "combos",
    keys: { color_identity: 1 },
    note: "Filtering the combo pool down to a deck's own color identity before checking piece-presence against the decklist.",
  },
];

export { COMBOS_SCHEMA, COMBO_INDEXES };
