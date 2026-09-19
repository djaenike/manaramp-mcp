import { Db } from 'mongodb';
import { DeckDoc } from '../query/decks.js';

/**
 * functions/push/deck.ts -- the ONE place that writes to manaramp's `decks` Mongo collection.
 * Extracted out of tools/tools/shared/deck-analysis.ts (optimize_deck/publish_deck)'s own handler (2026-09-17, sixth pass, tools/functions
 * split) -- optimize_deck/publish_deck (the only caller) builds the full set of already-resolved fields to
 * persist (via functions/query/cards.ts + functions/reference/*), and this function just does the
 * insert-or-update-in-place + slug assignment. Reads (getDeckDoc/queryDeckList/queryDeckDetail)
 * live in functions/query/decks.ts -- this is the write counterpart, split out the same way
 * push_draft_result/push_game_log are split from their own query siblings.
 */

type DeckFields = Omit<DeckDoc, "_id" | "owner_user_id" | "slug" | "platform" | "is_public" | "origin_draft_result_id" | "created_at" | "updated_at">;
interface PushDeckResult {
    deck_id: string;
    slug: string;
    was_new: boolean;
}
/**
 * Insert a brand-new deck, or update an existing one (by _id) in place. `existingDeck` must
 * already be ownership-checked by the caller (see tools/shared/deck-analysis.ts (optimize_deck/publish_deck)) -- this function persists
 * unconditionally. On update, `existingDeck.slug` is always preserved (never re-derived from
 * `fields.name`) so an existing manaramp.com/decks/<slug> link never breaks.
 */
declare function pushDeck(writeDb: Db, ownerUserId: string, fields: DeckFields, existingDeck: DeckDoc | null, opts?: {
    is_public?: boolean;
}): Promise<PushDeckResult>;

export { type DeckFields, type PushDeckResult, pushDeck };
