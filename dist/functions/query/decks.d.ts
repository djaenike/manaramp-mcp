import { DeckPromptConstraints } from './deck-prompts.js';
import { Db } from 'mongodb';

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
    /** AI-built decks (2026-09-27, manaramp's schema/deck_prompts.ts) -- absent on older decks. */
    prompt_id?: string | null;
    constraints?: DeckPromptConstraints | null;
    revisions?: Array<{
        at: Date;
        request: string | null;
        added: string[];
        removed: string[];
    }>;
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
/** Get the raw deck doc (for ownership checks etc) -- no card resolution. Used by optimize_deck/publish_deck to
 *  load an existing deck's oracle_ids before editing. */
declare function getDeckDoc(writeDb: Db, by: {
    deck_id?: string;
    slug?: string;
}): Promise<DeckDoc | null>;
/** List the given owner's decks, summary fields only -- no per-card resolution (that's wasteful
 *  for a whole list; call queryDeckDetail for one specific deck instead). */
declare function queryDeckList(writeDb: Db, ownerUserId: string): Promise<DeckSummary[]>;
/** One deck, fully resolved: real card names/mana costs/images per oracle_id (via queryCards),
 *  plus a ready-to-paste decklist_text for feeding back into optimize_deck/publish_deck. */
declare function queryDeckDetail(readDb: Db, deck: DeckDoc): Promise<DeckDetail>;

export { type DeckCard, type DeckDetail, type DeckDoc, type DeckSummary, getDeckDoc, queryDeckDetail, queryDeckList };
