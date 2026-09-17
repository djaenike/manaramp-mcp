import { Db } from 'mongodb';

/**
 * functions/cards.ts -- the ONE place that queries manaramp's `cards` Mongo collection.
 *
 * Consolidated 2026-09-17 (fifth pass): this used to be split across sub-tools/scryfall/cards.ts
 * (search) and sub-tools/cardkingdom/pricing.ts (a SEPARATE cards.find() just for market_data),
 * with sub-tools/deck-building/consistency.ts and sub-tools/spellbook/combos.ts ALSO each running
 * their own independent cards.find() for card-detail/cmc lookups -- four different places
 * re-implementing the same underlying query. "scryfall"/"cardkingdom" as folder names were also
 * actively misleading: this queries the WHOLE ingested card document (Forge abilities, 17Lands
 * format_stats, Card Kingdom/ManaPool pricing, Scryfall's own fields), not just "Scryfall data."
 *
 * Every other function in this package that needs card data (deck-validation's consistency checks,
 * combos' cmc/speed classification, decks' oracle_id resolution, draft-results' grpId resolution)
 * calls queryCards below instead of touching `db.collection("cards")` itself -- this is the only
 * file that does.
 */

interface MongoCardDoc {
    _id: string;
    name: string;
    mana_cost: string | null;
    cmc: number | null;
    type_line: string;
    category: string;
    oracle_text: string | null;
    power: string | null;
    toughness: string | null;
    loyalty: string | null;
    colors: string[];
    color_identity: string[];
    legalities: Record<string, string>;
    arena_grp_ids: number[];
    abilities: {
        is_mana_rock: boolean | null;
        is_card_draw: boolean | null;
        is_removal: boolean | null;
        is_mass_removal: boolean | null;
        is_token_generator: boolean | null;
        token_types: string[] | null;
        is_land_ramp: boolean | null;
        is_extra_land_drop: boolean | null;
        is_tutor: boolean | null;
        is_counterspell: boolean | null;
        is_recursion: boolean | null;
        is_game_changer: boolean | null;
        is_mass_land_denial: boolean | null;
        is_extra_turn: boolean | null;
    } | null;
    keywords: string[] | null;
    activated_abilities: Array<{
        effect: string | null;
        cost_raw: string | null;
        requires_tap: boolean;
        requires_sacrifice: boolean;
        requires_mana_cost: boolean;
    }> | null;
    triggered_abilities: Array<{
        effect: string | null;
        trigger_mode: string | null;
    }> | null;
    static_abilities: Array<{
        affected: string | null;
    }> | null;
    scryfall_printings: Array<{
        scryfall_id: string;
        set_code: string;
        collector_number: string;
        image_url: string | null;
    }>;
    market_data: {
        cardkingdom: {
            price_usd: number | null;
            is_foil: boolean;
            fetched_at: Date;
        } | null;
        manapool: {
            price_usd: number | null;
            is_foil: boolean;
            fetched_at: Date;
        } | null;
    } | null;
    format_stats: FormatStatsEntry[];
}
interface FormatStatsEntry {
    set_code: string;
    format: string;
    color: string | null;
    rarity: string | null;
    avg_last_seen_at: number | null;
    seen_sample_size: number | null;
    avg_taken_at: number | null;
    taken_sample_size: number | null;
    games_played_win_rate: number | null;
    games_played_sample_size: number | null;
    opening_hand_win_rate: number | null;
    opening_hand_sample_size: number | null;
    games_drawn_win_rate: number | null;
    games_drawn_sample_size: number | null;
    games_in_hand_win_rate: number | null;
    games_in_hand_sample_size: number | null;
    games_not_seen_win_rate: number | null;
    games_not_seen_sample_size: number | null;
    improvement_in_hand: number | null;
    as_of: Date;
}
interface QueryCardsFilters {
    /** Exact (case-insensitive) name match against any of these -- batch lookup. Highest priority --
     *  takes precedence over every other filter below when present (this is "give me exactly these
     *  cards," not a search). */
    names?: string[];
    /** Oracle_id batch lookup (the `cards` collection's own _id) -- for resolving stored references
     *  like a deck's `cards`/`commander.oracle_ids` arrays back to real card data. Same priority as
     *  `names` (checked first, since callers with oracle_ids already know exactly which docs they
     *  want, same as a name lookup). */
    oracle_ids?: string[];
    /** Arena's numeric grpIds -- batch lookup for resolving a draft pack/pick history in one call.
     *  A card can have several (one per Arena printing). Same priority as `names`/`oracle_ids`. */
    arena_grp_ids?: number[];
    name_contains?: string;
    /** Cards whose color_identity is a SUBSET of this list -- the standard "legal to include under
     *  this commander" filter. Omit for no color-identity restriction. */
    color_identity_subset_of?: string[];
    /** Cards whose `colors` array includes ALL of these. Distinct from color_identity_subset_of. */
    colors_include?: string[];
    category?: string;
    cmc_min?: number;
    cmc_max?: number;
    oracle_text_contains?: string;
    legal_in?: string;
    max_price_usd?: number;
    is_mana_rock?: boolean;
    is_card_draw?: boolean;
    is_removal?: boolean;
    is_mass_removal?: boolean;
    is_token_generator?: boolean;
    /** Substring match against abilities.token_types -- these are Forge's own TokenScript$ identifiers
     *  (e.g. "c_a_treasure_sac"), not prettified names, so match loosely (e.g. "treasure"). */
    token_type_contains?: string;
    is_land_ramp?: boolean;
    is_extra_land_drop?: boolean;
    is_tutor?: boolean;
    is_counterspell?: boolean;
    is_recursion?: boolean;
    limit?: number;
}
interface CardSummary {
    oracle_id: string;
    name: string;
    mana_cost: string | null;
    cmc: number | null;
    type_line: string;
    category: string;
    oracle_text: string | null;
    power: string | null;
    toughness: string | null;
    loyalty: string | null;
    colors: string[];
    color_identity: string[];
    legalities: Record<string, string>;
    arena_grp_ids: number[];
    abilities: MongoCardDoc["abilities"];
    keywords: string[] | null;
    activated_abilities: MongoCardDoc["activated_abilities"];
    triggered_abilities: MongoCardDoc["triggered_abilities"];
    static_abilities: MongoCardDoc["static_abilities"];
    price_usd: number | null;
    image_url: string | null;
    format_stats: FormatStatsEntry[];
}
/** The one canonical query against manaramp's `cards` collection -- see file header. */
declare function queryCards(db: Db, filters: QueryCardsFilters): Promise<CardSummary[]>;

export { type CardSummary, type FormatStatsEntry, type QueryCardsFilters, queryCards };
