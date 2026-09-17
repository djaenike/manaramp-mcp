import { Db } from 'mongodb';

/**
 * functions/decks.ts -- the ONE place that queries manaramp's `decks` Mongo collection for reads.
 * Moved 2026-09-17 (fifth pass) out of tools/query-decks.ts, which was doing this inline -- tools/
 * files are registration wrappers only now (name/description/schema/handler), no query logic of
 * their own; see CLAUDE.md's tool-consolidation section. Resolves stored oracle_ids back to real
 * card data via functions/cards.ts's queryCards (oracle_ids filter) instead of a separate `cards`
 * query.
 *
 * `decks` lives under the write-capable credential by convention (see tools/types.ts's McpContext),
 * so this takes writeDb for the decks collection itself and readDb separately for resolving cards.
 */

interface DeckDoc {
    _id: string;
    owner_user_id: string;
    name: string;
    slug: string;
    format: string;
    platform: string | null;
    is_public: boolean;
    cards: string[];
    sideboard: string[] | null;
    size_summary: {
        main: number;
        sideboard: number;
        commander: number;
        total: number;
    } | null;
    commander: {
        oracle_ids: string[];
        color_identity: string[];
    } | null;
    bracket: {
        estimate: string | null;
        combos_found: Array<{
            pieces: string[];
            speed: string;
        }>;
    } | null;
    mana_curve: Record<string, number> | null;
    curve_out_probability: Record<string, number | string> | null;
    consistency_issues: string[];
    price_usd: number | null;
    price_fetched_at: Date | null;
    wincon_summary: string | null;
    general_strategy: string | null;
    source: string | null;
    origin_draft_result_id: string | null;
    created_at: Date;
    updated_at: Date;
}
interface DeckCard {
    oracle_id: string;
    name: string;
    quantity: number;
    category: string;
    mana_cost: string | null;
    type_line: string;
    image_url: string | null;
}
interface DeckSummary {
    name: string;
    slug: string;
    format: string;
    price_usd: number | null;
    bracket: DeckDoc["bracket"];
    consistency_issues: string[];
    updated_at: Date;
}
interface DeckDetail {
    deck_id: string;
    deck_url: string;
    name: string;
    format: string;
    commander: DeckCard[];
    main_deck: DeckCard[];
    decklist_text: string;
    bracket: DeckDoc["bracket"];
    mana_curve: Record<string, number> | null;
    consistency_issues: string[];
    price_usd: number | null;
    wincon_summary: string | null;
    general_strategy: string | null;
}
/** Get the raw deck doc (for ownership checks etc) -- no card resolution. Used by manage_deck to
 *  load an existing deck's oracle_ids before editing. */
declare function getDeckDoc(writeDb: Db, by: {
    deck_id?: string;
    slug?: string;
}): Promise<DeckDoc | null>;
/** List the given owner's decks, summary fields only -- no per-card resolution (that's wasteful
 *  for a whole list; call queryDeckDetail for one specific deck instead). */
declare function queryDeckList(writeDb: Db, ownerUserId: string): Promise<DeckSummary[]>;
/** One deck, fully resolved: real card names/mana costs/images per oracle_id (via queryCards),
 *  plus a ready-to-paste decklist_text for feeding back into manage_deck. */
declare function queryDeckDetail(readDb: Db, deck: DeckDoc): Promise<DeckDetail>;

export { type DeckCard, type DeckDetail, type DeckDoc, type DeckSummary, getDeckDoc, queryDeckDetail, queryDeckList };
