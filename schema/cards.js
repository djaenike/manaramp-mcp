/**
 * schema/cards.js
 *
 * Shared MongoDB card cache: every install contributes resolved card data, so lookups shrink over
 * time instead of re-querying Scryfall/EDHREC/17Lands/Forge/Card Kingdom from scratch every time.
 * Design only -- not wired into index.js yet.
 *
 * One document per Scryfall oracle_id (not name -- reprints/promos can share a name; not Arena's
 * grpId -- one card can have several). Permanent facts and time-varying data (market_data,
 * format_stats) live on the same document since Mongo has no cheap joins. No TTL index -- see
 * schema/staleness.js for why; check isStale() from there before trusting market_data/format_stats.
 *
 * Mirrored at manaramp/src/lib/server/schema/cards.ts -- keep both in sync (see that file's own
 * header) until this lives in one repo only.
 */

const CARDS = {
  bsonType: "object",
  required: ["_id", "name", "type_line"],
  properties: {
    _id: { bsonType: "string", description: "Scryfall oracle_id." },

    // Permanent facts -- never expire.
    name: { bsonType: "string" },
    mana_cost: { bsonType: ["string", "null"] },
    cmc: { bsonType: ["double", "int", "null"] },
    type_line: { bsonType: "string" },
    category: { bsonType: "string", description: "Matches classifyCategory() in sub-tools/scryfall/classify.js." },
    oracle_text: { bsonType: ["string", "null"] },
    power: { bsonType: ["string", "null"] },
    toughness: { bsonType: ["string", "null"] },
    loyalty: { bsonType: ["string", "null"] },
    colors: { bsonType: "array", items: { bsonType: "string" } },
    color_identity: { bsonType: "array", items: { bsonType: "string" } },
    legalities: { bsonType: "object", description: "Format -> legal/not_legal/banned/restricted, verbatim from Scryfall." },
    arena_grp_ids: { bsonType: "array", items: { bsonType: "int" }, description: "Every Arena grpId that resolves to this card." },
    scryfall_printings: {
      bsonType: "array",
      description: "Per-printing data -- image, set, collector number.",
      items: {
        bsonType: "object",
        properties: {
          scryfall_id: { bsonType: "string" },
          set_code: { bsonType: "string" },
          collector_number: { bsonType: "string" },
          image_url: { bsonType: ["string", "null"] },
        },
      },
    },
    forge_script: {
      bsonType: ["object", "null"],
      description: "Cached Forge rules script; fetched_at lets a stale one be refreshed (Forge patches occasionally).",
      properties: { script: { bsonType: "string" }, fetched_at: { bsonType: "date" } },
    },

    // Time-varying -- check isStale() (schema/staleness.js) before trusting.
    market_data: {
      bsonType: ["object", "null"],
      description: "Keyed by source. isStale(fetched_at, CARD_STALENESS_DAYS.market_data) before trusting.",
      properties: {
        cardkingdom: {
          bsonType: ["object", "null"],
          properties: {
            price_usd: { bsonType: ["double", "null"] },
            is_foil: { bsonType: "bool" },
            fetched_at: { bsonType: "date" },
          },
        },
      },
    },
    format_stats: {
      bsonType: "array",
      description: "One entry per (set_code, format) -- win rate only means something within one environment. isStale(as_of, CARD_STALENESS_DAYS.format_stats) before trusting. 17Lands metrics; null means too small a sample, not a bad card.",
      items: {
        bsonType: "object",
        required: ["set_code", "format", "as_of"],
        properties: {
          set_code: { bsonType: "string" },
          format: { bsonType: "string", description: "'QuickDraft' | 'PremierDraft' | 'TradDraft' -- matches 17Lands' own naming." },
          color: { bsonType: ["string", "null"] },
          rarity: { bsonType: ["string", "null"] },
          avg_last_seen_at: { bsonType: ["double", "null"], description: "Avg pick number last seen in a pack (17Lands ALSA)." },
          avg_taken_at: { bsonType: ["double", "null"], description: "Avg pick number taken (17Lands ATA)." },
          games_played_win_rate: { bsonType: ["double", "null"], description: "Win rate of decks running this card (17Lands GP WR)." },
          opening_hand_win_rate: { bsonType: ["double", "null"], description: "Win rate when in the opening hand (17Lands OH WR)." },
          games_drawn_win_rate: { bsonType: ["double", "null"], description: "Win rate when drawn, not opening hand (17Lands GD WR)." },
          games_in_hand_win_rate: { bsonType: ["double", "null"], description: "Win rate whenever in hand, opening or drawn (17Lands GIH WR)." },
          games_not_seen_win_rate: { bsonType: ["double", "null"], description: "Win rate in games this card was never seen (17Lands GNS WR)." },
          improvement_in_hand: { bsonType: ["double", "null"], description: "games_in_hand_win_rate minus games_not_seen_win_rate (17Lands IIH)." },
          as_of: { bsonType: "date", description: "Export date of the 17Lands snapshot this came from." },
        },
      },
    },

    updated_at: { bsonType: "date", description: "Last time any field changed -- debugging only, not a staleness signal." },
  },
};

export { CARDS };
