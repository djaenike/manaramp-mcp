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
/** A pack card: everything needed to judge the pick, nothing else. */
declare function packCardView(grpId: string, card: CardRecord | null, set: string | null, format: string | null): {
    grpId: string;
    card: null;
} | {
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
    card?: undefined;
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

export { gameCardView, packCardView, parseEventName, poolCardLine };
