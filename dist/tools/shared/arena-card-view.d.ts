/**
 * tools/shared/arena-card-view.ts
 *
 * Token-lean card shapes for the two Arena tools' responses (2026-09-25). Their grpId cache holds
 * the full query_cards record (effects tree, legalities, every 17Lands row), which is right for
 * the cache but measured at ~1,500 tokens per card when sent to the model as-is. A 13-card pack
 * cost ~21k tokens, and arena_draft_assistance also re-sent every card picked so far, so by pack 3
 * one pick call was ~80k tokens, piling up with each pick until the draft ran out of credits.
 *
 * Everything here reads BOTH record shapes: the full CardSummary field names (games_in_hand_win_rate
 * etc., what the cache holds) and query_cards' compact summary names (gih_wr etc.), so a cache file
 * written by either version works.
 */
type CardRecord = Record<string, any>;
/** "QuickDraft_HOB_20260915" -> { format: "QuickDraft", set: "HOB" }. */
declare function parseEventName(eventName: string | null): {
    format: string | null;
    set: string | null;
};
/** A pack card: everything needed to judge the pick, nothing else. `seen_late` (2026-09-26) flags a
 *  card still in the pack more than a pick past its ALSA -- the "this color may be open" signal the
 *  tool description tells the model to weigh for pivots, precomputed so it isn't left to mental
 *  arithmetic across 14 cards. */
declare function packCardView(grpId: string, card: CardRecord | null, set: string | null, format: string | null, pickNumber?: number): {
    grpId: string;
    card: null;
} | {
    seen_late: boolean | undefined;
    gih_wr?: number | null | undefined;
    alsa?: number | null | undefined;
    ata?: number | null | undefined;
    iih?: number | null | undefined;
    gih_n?: number | null | undefined;
    stats_format?: string;
    grpId: string;
    name: any;
    mana_cost: any;
    type_line: any;
    oracle_text: any;
    pt: string | undefined;
    rarity: string | undefined;
    colors: string;
    card?: undefined;
};
type PackCardView = ReturnType<typeof packCardView>;
/** Pack order for the response (2026-09-26): games-in-hand win rate first, highest to lowest --
 *  the primary pick-quality number. Cards with no GIH WR (17Lands withholds it below its sample
 *  threshold, common early in a set) follow, ordered by ALSA ascending (lower = usually taken
 *  earlier = stronger), then unresolved cards last. */
declare function sortPackForPicking(pack: PackCardView[]): PackCardView[];
/** The pool at a glance (2026-09-26) -- what the model weighs each pick against: color commitment,
 *  curve, creature count, and role coverage. Colors count cards (a gold card counts toward each of
 *  its colors), and each color also carries the average GIH WR of the pool's cards in it, so a
 *  pivot recommendation can compare "how deep and how good" rather than raw card counts alone. */
declare function poolSummary(cards: Array<CardRecord | null>, set: string | null, format: string | null): {
    colors: Record<string, {
        cards: number;
        avg_gih_wr: number | null;
    }>;
    leading_colors: string;
    curve: Record<string, number>;
    creatures: number;
    noncreatures: number;
    roles: Record<string, number>;
};
/** A card already in the pool: one short line -- its full text was already shown when it was in a
 *  pack, so re-sending it every pick is the growing cost this replaces. */
declare function poolCardLine(grpId: string, card: CardRecord | null, set: string | null, format: string | null): string;
/** Game-advice view: name/cost/type/text/PT only (no draft stats). */
declare function gameCardView(card: CardRecord | null): {
    name: any;
    mana_cost: any;
    type_line: any;
    oracle_text: any;
    pt: string | undefined;
} | null;

export { gameCardView, packCardView, parseEventName, poolCardLine, poolSummary, sortPackForPicking };
