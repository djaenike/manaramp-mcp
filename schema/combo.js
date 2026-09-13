/**
 * schema/combo.js
 *
 * Commander Spellbook combos as their own collection -- not folded into card.js's `cards`. A
 * combo is a fact about a SET of cards, not one card in isolation, and one card can be part of
 * many unrelated combos that grow independently of the card itself. Design only -- not wired into
 * index.js yet.
 *
 * Keyed by Spellbook's own combo id (same reasoning card.js gives for oracle_id: this document IS
 * a cache of one upstream entity, so reuse its real identifier).
 *
 * `pieces` is oracle_id, taken directly from Spellbook's own `card.oracleId` -- verified live
 * (2026-09-13) that their API already returns a real Scryfall oracle_id per piece, no name
 * matching needed (unlike commander_synergy.js's average_decklist).
 *
 * No isStale() here: a documented combo's pieces/result don't change. The real risk is a brand
 * new combo we don't have yet, which is a full-resync concern, not a per-document one -- synced_at
 * is bookkeeping only.
 */

const COMBOS = {
  bsonType: "object",
  required: ["_id", "pieces_names", "pieces"],
  properties: {
    _id: { bsonType: "string", description: "Commander Spellbook's own combo id." },
    pieces_names: { bsonType: "array", items: { bsonType: "string" }, description: "Card names as Spellbook returns them -- display only." },
    pieces: { bsonType: "array", items: { bsonType: "string" }, description: "oracle_id per entry in pieces_names, same order. The field the index below targets." },
    color_identity: { bsonType: "array", items: { bsonType: "string" } },
    result: { bsonType: ["string", "null"], description: "Spellbook's prose description of what the combo does." },
    steps: { bsonType: ["array", "null"], items: { bsonType: "string" }, description: "Ordered steps, when Spellbook provides them structured." },
    speed: { bsonType: ["string", "null"], description: "Same classification bracket/rating.js's classifyComboSpeed computes." },
    spellbook_url: { bsonType: ["string", "null"] },
    synced_at: { bsonType: "date", description: "Last refresh from Spellbook -- bookkeeping, not an isStale() gate." },
  },
};

const COMBO_INDEXES = [
  { collection: "combos", keys: { pieces: 1 }, note: "Multikey -- every combo a given card is part of." },
  { collection: "combos", keys: { color_identity: 1 } },
];

export { COMBOS, COMBO_INDEXES };
