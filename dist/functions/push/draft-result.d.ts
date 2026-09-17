import { Db } from 'mongodb';

/**
 * functions/push/draft-result.ts -- the ONE place that writes to manaramp's `draft_results` Mongo
 * collection (reads live in functions/query/draft-results.ts). Upserts a finished-or-in-progress
 * Arena draft, keyed by Arena's own draftId, since there's no clean "draft finished" signal the
 * way game_logs has a matchResult event -- repeated calls just keep the same doc current instead
 * of inserting duplicates.
 *
 * Only ever reached from tools/internal-tools.ts's push_draft_result wrapper -- the local-stdio
 * arena_draft_assistance tool has no direct Mongo connection of its own (see tools/types.ts's
 * McpContext header), so that wrapper is the one thing it can reach over HTTP via
 * tools/shared/remote-client.ts. Nothing else calls this directly.
 */

interface PushDraftResultArgs {
    draft_id: string;
    event_name?: string | null;
    draft_format?: string | null;
    picks: number[];
    packs_seen: Array<{
        pack_number: number;
        pick_number: number;
        grp_ids: number[];
    }>;
}
interface PushDraftResultResult {
    draft_result_id: string;
    was_new: boolean;
}
declare function pushDraftResult(writeDb: Db, ownerUserId: string, args: PushDraftResultArgs): Promise<PushDraftResultResult>;

export { type PushDraftResultArgs, type PushDraftResultResult, pushDraftResult };
