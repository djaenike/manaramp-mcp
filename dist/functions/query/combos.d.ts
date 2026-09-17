import { Db } from 'mongodb';

/**
 * functions/combos.ts -- the ONE place that queries manaramp's `combos` Mongo collection.
 * Consolidated 2026-09-17 (fifth pass) from sub-tools/spellbook/combos.ts -- "spellbook" as a
 * folder name was misleading the same way "scryfall" was for cards.ts. Its speed classification
 * step now calls functions/cards.ts's queryCards for cmc data instead of running its own separate
 * `cards` query -- one canonical place for that collection, not two.
 *
 * One query shape: given any list of card names -- 2-3 specific candidates ("do these combo
 * together?") or a full ~100-card decklist ("which combos exist in this deck?") -- queryCombos
 * returns every documented combo whose pieces are ALL present in that list. The full-decklist case
 * is a strict superset of the small-candidate case, so one function covers both.
 */

interface ComboResult {
    id: string;
    pieces: string[];
    result: string | null;
    steps: string[] | null;
    permalink: string | null;
    total_cmc: number;
    speed: "fast" | "slow";
}
declare const FAST_COMBO_MAX_CMC = 6;
/** Every documented combo whose pieces are ALL present in card_names -- see file header. */
declare function queryCombos(db: Db, card_names: string[], limit?: number): Promise<ComboResult[]>;

export { type ComboResult, FAST_COMBO_MAX_CMC, queryCombos };
