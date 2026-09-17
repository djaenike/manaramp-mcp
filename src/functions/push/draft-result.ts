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

import type { Db } from "mongodb";
import type { DraftResultDoc } from "../query/draft-results.js";

interface PushDraftResultArgs {
  draft_id: string;
  event_name?: string | null;
  draft_format?: string | null;
  picks: number[];
  packs_seen: Array<{ pack_number: number; pick_number: number; grp_ids: number[] }>;
}

interface PushDraftResultResult {
  draft_result_id: string;
  was_new: boolean;
}

async function pushDraftResult(writeDb: Db, ownerUserId: string, args: PushDraftResultArgs): Promise<PushDraftResultResult> {
  const now = new Date();
  const collection = writeDb.collection<DraftResultDoc>("draft_results");
  const existing = await collection.findOne({ _id: args.draft_id });

  await collection.updateOne(
    { _id: args.draft_id },
    {
      $set: {
        owner_user_id: ownerUserId,
        event_name: args.event_name ?? null,
        draft_format: args.draft_format ?? null,
        picks: args.picks,
        packs_seen: args.packs_seen,
        updated_at: now,
      },
      $setOnInsert: { _id: args.draft_id, started_at: now },
    },
    { upsert: true }
  );

  return { draft_result_id: args.draft_id, was_new: !existing };
}

export { pushDraftResult };
export type { PushDraftResultArgs, PushDraftResultResult };
