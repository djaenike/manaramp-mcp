import { Db } from 'mongodb';

/**
 * functions/draft-results.ts -- the ONE place that queries manaramp's `draft_results` Mongo
 * collection for reads (writes go through push_draft_result -- see tools/push-draft-result.ts).
 * Moved 2026-09-17 (fifth pass) out of tools/query-draft-results.ts, which was doing this inline.
 * Resolves grpIds back to real card names via functions/cards.ts's queryCards (arena_grp_ids
 * filter) instead of a separate `cards` query.
 */

interface DraftResultDoc {
    _id: string;
    owner_user_id: string;
    event_name: string | null;
    draft_format: string | null;
    picks: number[];
    packs_seen: Array<{
        pack_number: number;
        pick_number: number;
        grp_ids: number[];
    }>;
    started_at: Date;
    updated_at: Date;
}
interface DraftResultSummary {
    draft_id: string;
    event_name: string | null;
    draft_format: string | null;
    picks_made: number;
    started_at: Date;
    updated_at: Date;
}
interface ResolvedPick {
    grp_id: number;
    name: string | null;
}
interface DraftResultDetail {
    draft_id: string;
    event_name: string | null;
    draft_format: string | null;
    picks_made: ResolvedPick[];
    packs_seen: Array<{
        pack_number: number;
        pick_number: number;
        cards: ResolvedPick[];
    }>;
    started_at: Date;
    updated_at: Date;
}
/** List the given owner's recent drafts, summary fields only. */
declare function queryDraftResultList(writeDb: Db, ownerUserId: string, limit: number): Promise<DraftResultSummary[]>;
/** Get the raw draft doc by id (for ownership checks). */
declare function getDraftResultDoc(writeDb: Db, draftId: string): Promise<DraftResultDoc | null>;
/** One draft, fully resolved: every pick and every pack's options resolved to real card names via
 *  queryCards' arena_grp_ids filter, instead of a raw grpId array. */
declare function queryDraftResultDetail(readDb: Db, draft: DraftResultDoc): Promise<DraftResultDetail>;

export { type DraftResultDetail, type DraftResultDoc, type DraftResultSummary, type ResolvedPick, getDraftResultDoc, queryDraftResultDetail, queryDraftResultList };
