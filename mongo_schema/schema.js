/**
 * mongo_schema/schema.js
 *
 * Design for the shared MongoDB card database discussed for this MCP: every player using it
 * contributes resolved card data, so the collective pool of card lookups needed against Scryfall/
 * EDHREC/17Lands/Forge/Card Kingdom shrinks over time instead of every install re-querying from
 * scratch forever. This file is NOT wired into index.js yet -- nothing here is live. It's the
 * schema to stand up first, before any read/write code gets written against it.
 *
 * These are MongoDB's own `$jsonSchema` validator objects -- usable directly, e.g.:
 *   db.createCollection("cards", { validator: { $jsonSchema: CARDS_SCHEMA } })
 *
 * ============================================================================================
 * ONE DOCUMENT PER CARD: permanent facts + price + format stats, all embedded together
 * ============================================================================================
 * Deliberately consolidated from an earlier 3-collection design (cards / card_market_data /
 * card_format_stats) into one `cards` collection. For a read-heavy lookup system like this one,
 * embedding what gets read together is the idiomatically correct MongoDB pattern -- Mongo has no
 * cheap joins, so "give me everything for this card" is one document fetch instead of a
 * multi-collection $lookup. Size is a non-issue either way: MongoDB's document limit is 16MB, and
 * a card with every field below plus a full format_stats history is a few KB at most.
 *
 * The real trade accepted by merging: MongoDB's TTL index (auto-DELETES a whole document once a
 * date field passes) only works at the whole-document level. It was the mechanism the old 3-
 * collection design used to make a stale price or win-rate simply DISAPPEAR rather than be served
 * as current. That's not available anymore once price/stats live inside the same document as
 * permanent facts -- deleting the document to expire a price would also delete the oracle text.
 * Staleness is therefore an APPLICATION-level check now: `isStale()` below, called against
 * `market_data.*.fetched_at` / `format_stats[].as_of` before trusting either. A present-but-stale
 * value must be treated exactly like an absent one (re-fetch), never served as current just
 * because the field happens to still be there. This is the one thing that's easy to get right by
 * construction (a TTL index) and easy to get wrong by omission (a forgotten staleness check) --
 * worth restating here, not just in the code that eventually calls isStale().
 *
 * ============================================================================================
 * KEYING: Scryfall's oracle_id, not card name, and NOT Arena's grpId
 * ============================================================================================
 * - Card NAME is not a safe key: reprints, promos, and Arena rebalances can share a name across
 *   meaningfully different objects, and 17Lands/Forge/Card Kingdom all key off name as typed on
 *   the card, which occasionally drifts from Scryfall's own naming (accents, punctuation).
 * - Arena's grpId is not a safe key either, for the opposite reason: the SAME real card can have
 *   MULTIPLE grpIds across different Arena printings, rebalance passes, or reprints in a later
 *   set. A grpId -> oracle_id mapping is 1:many in reverse (see `arena_grp_ids` below, an array).
 * - Scryfall's `oracle_id` (a UUID stable across every printing of a given card face) is the one
 *   identifier that means "this specific card, gameplay-wise" regardless of printing, so it's the
 *   primary key for the `cards` collection. Everything else (grpId, per-printing scryfall_id,
 *   card name) is an alternate lookup path INTO that same document, not a separate identity.
 *
 * ============================================================================================
 * QUERY PATTERNS THIS IS SHAPED AROUND (not per-card round trips)
 * ============================================================================================
 * - Deck building: "red creatures, cmc <= 3, Commander-legal" -- one filtered `cards.find(...)`,
 *   not N single-card lookups. Needs indexes on the fields actually filtered on (colors, cmc,
 *   category, legalities.*).
 * - "Best cards in this Limited environment": one query filtering/sorting on the embedded
 *   `format_stats` array (`format_stats.set_code`, `format_stats.format`, `format_stats.gih_wr`),
 *   no second collection involved.
 * - Drafting: "resolve this whole 15-card pack, plus this user's full pick history, in one round
 *   trip" -- `cards.find({ arena_grp_ids: { $in: [...] } })` (a multikey index on `arena_grp_ids`)
 *   PLUS one `draft_sessions` lookup by the user's active draft, not one query per card. See
 *   `draft_sessions` below -- it's what makes "everything plus current picks in one request"
 *   possible without a second collection round trip per pack.
 */

// ------------------------------------------------------------------------------------------
// Collection: cards -- ONE document per oracle_id holding permanent facts (cache forever, same
// rule as this server's existing card_cache/grpid_cache.json) AND time-varying market_data /
// format_stats (cache until stale -- see isStale() below; never assume present means current).
// ------------------------------------------------------------------------------------------
const CARDS_SCHEMA = {
  bsonType: "object",
  required: ["_id", "name", "type_line"],
  properties: {
    _id: {
      bsonType: "string",
      description: "Scryfall oracle_id -- the stable, printing-independent identity for this card face.",
    },

    // --- Permanent facts: never expire, never re-fetched once known -------------------------
    name: { bsonType: "string" },
    mana_cost: { bsonType: ["string", "null"] },
    cmc: { bsonType: ["double", "int", "null"] },
    type_line: { bsonType: "string" },
    category: {
      bsonType: "string",
      description: "Creature/Instant/Sorcery/Enchantment/Artifact/Planeswalker/Land/Other -- same classifyCategory() this server already uses (sub-tools/scryfall/classify.js), so a shared DB and a local lookup never disagree on what a card 'is'.",
    },
    oracle_text: { bsonType: ["string", "null"] },
    power: { bsonType: ["string", "null"] },
    toughness: { bsonType: ["string", "null"] },
    loyalty: { bsonType: ["string", "null"] },
    colors: { bsonType: "array", items: { bsonType: "string" } },
    color_identity: { bsonType: "array", items: { bsonType: "string" } },
    legalities: {
      bsonType: "object",
      description: "Format -> legal/not_legal/banned/restricted, verbatim from Scryfall. Whole object kept (not just commander/standard) since which formats matter depends on the query, not on this schema.",
    },
    arena_grp_ids: {
      bsonType: "array",
      items: { bsonType: "int" },
      description: "EVERY Arena grpId that resolves to this oracle_id -- an array, not a single value, because one real card can have several (reprints, rebalances). This is the field arena_draft_assistance's pack resolution filters on.",
    },
    scryfall_printings: {
      bsonType: "array",
      description: "One entry per known printing -- where per-printing data (image, set, collector number) lives, since THAT varies even though oracle_id doesn't.",
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
      description: "Long-lived but NOT eternally fixed like oracle text -- Forge occasionally patches its own rules implementation. Keep fetched_at so a very old script can be opportunistically refreshed; don't treat it as immutable the way oracle_text is.",
      properties: {
        script: { bsonType: "string" },
        fetched_at: { bsonType: "date" },
      },
    },

    // --- Time-varying facts: present doesn't mean current -- check isStale() before trusting --
    market_data: {
      bsonType: ["object", "null"],
      description: "Keyed by source, e.g. market_data.cardkingdom. No TTL index here (see file header) -- staleness is an application-level isStale() check against fetched_at, using STALENESS_DAYS.market_data as the cutoff.",
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
      description: "One entry per (set_code, format) this card has real 17Lands data for -- there is no such thing as 'this card's win rate' without naming which environment it's from. Same staleness caveat as market_data: check as_of via isStale() before trusting an entry (STALENESS_DAYS.format_stats), don't assume present means current.",
      items: {
        bsonType: "object",
        required: ["set_code", "format", "as_of"],
        properties: {
          set_code: { bsonType: "string" },
          format: { bsonType: "string", description: "e.g. 'QuickDraft', 'PremierDraft', 'TradDraft' -- match 17Lands' own format naming so a CSV import needs no translation table." },
          color: { bsonType: ["string", "null"] },
          rarity: { bsonType: ["string", "null"] },
          // 17Lands' own column names, kept as-is rather than renamed -- see this server's
          // existing sub-tools/arena-log/card_ratings.js header comment for the full definitions
          // (ALSA, ATA, GIH WR, IIH, etc.) and their caveats (null means small sample, not a bad
          // card).
          alsa: { bsonType: ["double", "null"] },
          ata: { bsonType: ["double", "null"] },
          gp_wr: { bsonType: ["double", "null"] },
          oh_wr: { bsonType: ["double", "null"] },
          gd_wr: { bsonType: ["double", "null"] },
          gih_wr: { bsonType: ["double", "null"] },
          gns_wr: { bsonType: ["double", "null"] },
          iih: { bsonType: ["double", "null"] },
          as_of: { bsonType: "date", description: "When this snapshot was exported from 17Lands (matches the existing manual-CSV-export convention -- this server still never calls 17lands.com directly, per CLAUDE.md's usage-guidelines note)." },
        },
      },
    },

    updated_at: { bsonType: "date", description: "Last time ANY field on this document changed -- for debugging/audit. Not a staleness signal by itself; check the specific field's own fetched_at/as_of instead." },
  },
};

/**
 * How long each KIND of time-varying data stays trustworthy. Deliberately different per kind --
 * a Card Kingdom price and a 17Lands win-rate snapshot do not go stale at the same rate, so they
 * don't share one constant.
 */
const STALENESS_DAYS = {
  market_data: 7,   // prices move fast enough that a week-old one is a real risk to trust
  format_stats: 30, // 17Lands numbers settle down after a set's first couple weeks; a month is reasonable
};

/**
 * Application-level replacement for what a TTL index would have enforced automatically if
 * market_data/format_stats still lived in their own separate collections (see file header for
 * why that's no longer possible once they're embedded alongside permanent facts). Call this
 * before trusting ANY value under `market_data` or a `format_stats` entry -- treat a
 * present-but-stale field exactly like an absent one (go re-fetch), never serve it as current.
 *
 * @param {Date|string|null|undefined} timestamp - the field's own fetched_at/as_of value
 * @param {number} maxAgeDays - STALENESS_DAYS.market_data or STALENESS_DAYS.format_stats
 * @returns {boolean} true if this value is missing or too old to trust
 */
function isStale(timestamp, maxAgeDays) {
  if (!timestamp) return true;
  const ageMs = Date.now() - new Date(timestamp).getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

// ------------------------------------------------------------------------------------------
// Collection: draft_sessions -- live per-user draft state, so a single query returns the current
// pack's cards AND this user's full pick history together, instead of one round trip per card
// plus a second collection just for "what have I picked." Kept SEPARATE from `cards` on purpose
// -- this is a different kind of entity entirely (per-user session state, not per-card reference
// data), not something that should get folded into the same consolidation as market_data/
// format_stats above.
//
// user_id: a random UUID, generated once and persisted in arena_settings.json (index.js's
// getOrCreateUserId(), built on the settings.js this server already had) -- decided over requiring
// real accounts, since the .mcpb format has no install-time hook to assign one anyway (checked the
// manifest spec directly; it's purely declarative, no lifecycle scripts). This means genuinely
// anonymous contributors: no way to tell "this data came from the same person as that data" beyond
// whatever UUID they happen to have generated, and no way to hold one bad-data contributor
// accountable without also blocking whatever anyone else did under a different random UUID.
// Accepted deliberately, not an oversight -- revisit if abuse ever becomes a real problem.
// ------------------------------------------------------------------------------------------
const DRAFT_SESSIONS_SCHEMA = {
  bsonType: "object",
  required: ["_id", "user_id", "set_code", "format", "started_at"],
  properties: {
    _id: { bsonType: "string", description: "Arena's own draft_id/DraftId from the log -- already a unique identifier for one draft, no need to invent another." },
    user_id: { bsonType: "string" },
    event_name: { bsonType: "string", description: "e.g. 'QuickDraft_LCI_20260911', straight from Arena's log." },
    set_code: { bsonType: "string" },
    format: { bsonType: "string" },
    started_at: { bsonType: "date" },
    updated_at: { bsonType: "date" },
    picks: {
      bsonType: "array",
      description: "Full pick history, in order -- this is what arena_draft_assistance's picks_made is built from today, just persisted centrally instead of only in one process's local grpid_cache.",
      items: {
        bsonType: "object",
        properties: {
          pack_number: { bsonType: "int" },
          pick_number: { bsonType: "int" },
          grp_id: { bsonType: "int" },
          oracle_id: { bsonType: ["string", "null"] },
          picked_at: { bsonType: "date" },
        },
      },
    },
    current_pack: {
      bsonType: ["object", "null"],
      properties: {
        pack_number: { bsonType: "int" },
        pick_number: { bsonType: "int" },
        grp_ids: { bsonType: "array", items: { bsonType: "int" } },
      },
    },
  },
};

// ------------------------------------------------------------------------------------------
// Indexes -- one place to see what each collection is actually optimized to be queried by.
// Not yet created anywhere; this is the list to run once the collections exist. No TTL indexes
// on `cards` anymore (see file header) -- staleness is enforced by isStale() in application code.
// ------------------------------------------------------------------------------------------
const INDEXES = [
  // Deck-building filters ("red creatures, cmc <= 3, Commander-legal") hit these fields directly.
  { collection: "cards", keys: { color_identity: 1, cmc: 1, category: 1 } },
  { collection: "cards", keys: { "legalities.commander": 1 } },
  // Multikey index -- resolving a whole draft pack in one query filters on this array field.
  { collection: "cards", keys: { arena_grp_ids: 1 } },
  { collection: "cards", keys: { name: 1 }, note: "Name lookups (Forge/17Lands/Card Kingdom all key by name). NOT unique -- different oracle_ids can share a printed name (reprints/promos), so this must stay a plain non-unique index." },
  // Multikey indexes on the embedded format_stats array -- "best cards in this format" and
  // "does this card have data for this environment" both filter on these without a second
  // collection now that format_stats lives on the card document itself.
  { collection: "cards", keys: { "format_stats.set_code": 1, "format_stats.format": 1 } },
  { collection: "cards", keys: { "format_stats.set_code": 1, "format_stats.format": 1, "format_stats.gih_wr": -1 }, note: "Supports 'best cards in this format' style queries, not just single-card lookups." },

  { collection: "draft_sessions", keys: { user_id: 1, started_at: -1 }, note: "Find a user's most recent (likely still-active) draft without scanning the whole collection." },
];

export { CARDS_SCHEMA, DRAFT_SESSIONS_SCHEMA, INDEXES, STALENESS_DAYS, isStale };
