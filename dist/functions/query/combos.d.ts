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
 *
 * CORRECTION 2026-09-18 (round 1): total_cmc used to silently default an unresolved piece's cmc to
 * 0 -- confirmed live (a real Mikaeus, the Unhallowed + Triskelion combo, both pieces `not_found`
 * in a still-sparse local `cards` collection, reported `total_cmc: 0` instead of the real 8). Fixed
 * by reporting `unresolved_piece_names` alongside it instead of a confident-looking wrong number.
 *
 * CORRECTION 2026-09-18 (round 2, better fix): manaramp's own sync-pending-combos.ts now captures
 * Commander Spellbook's own `manaValueNeeded`/`manaNeeded` at ingest time -- the REAL mana cost to
 * ACTIVATE the combo assuming its pieces are already in place (not a sum of casting costs), always
 * present regardless of local card-DB completeness. `speed` now prefers that (`mana_value_needed`
 * on the stored doc) when present, falling back to the round-1 local-cmc-sum approach only for
 * combos that haven't been re-ingested since this change yet (sync-pending-combos.ts cycles through
 * every combo repeatedly, so this self-heals over time with no separate backfill needed). total_cmc
 * (sum of piece casting costs) is KEPT alongside mana_value_needed -- they answer genuinely
 * different questions (deck-building/curve cost to draw-and-cast every piece, vs. how much open
 * mana you need once they're down) and both are useful.
 */

interface ComboResult {
    id: string;
    pieces: string[];
    result: string | null;
    /** Ordered steps, split from Spellbook's own newline-separated description -- null only for a
     *  combo whose synced doc predates this field (re-ingested automatically over time). */
    steps: string[] | null;
    permalink: string | null;
    /** Sum of whatever pieces WERE resolved against manaramp's own `cards` collection -- a
     *  deck-building/curve number (cost to draw and cast every piece), NOT the combo's activation
     *  cost -- see mana_value_needed for that. See unresolved_piece_names below: NOT a confirmed
     *  total if that list is non-empty. */
    total_cmc: number;
    /** Piece names not found in manaramp's `cards` collection -- when non-empty, total_cmc is a
     *  floor, not a confirmed total. Empty means every piece resolved and the number is exact.
     *  Doesn't affect mana_value_needed/speed at all -- those come from Spellbook directly. */
    unresolved_piece_names: string[];
    /** Commander Spellbook's own activation cost (mana needed once every piece is already in
     *  place) -- null only for a combo whose synced doc predates this field. This is what `speed`
     *  is classified from when available. */
    mana_value_needed: number | null;
    /** Human-readable form of mana_value_needed, e.g. "{1}{U}{U}{B}". */
    mana_needed: string | null;
    /** Always "fast" or "slow" -- falls all the way back to the total_cmc-based classification if
     *  neither mana_value_needed nor a legacy stored speed is available, never null. */
    speed: "fast" | "slow";
}
declare const FAST_COMBO_MAX_CMC = 6;
/** Every documented combo whose pieces are ALL present in card_names -- see file header. */
declare function queryCombos(db: Db, card_names: string[], limit?: number): Promise<ComboResult[]>;

export { type ComboResult, FAST_COMBO_MAX_CMC, queryCombos };
