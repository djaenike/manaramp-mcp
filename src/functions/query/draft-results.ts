/**
 * functions/draft-results.ts -- the ONE place that queries manaramp's `draft_results` Mongo
 * collection for reads (writes go through push_draft_result -- see tools/push-draft-result.ts).
 * Moved 2026-09-17 (fifth pass) out of tools/query-draft-results.ts, which was doing this inline.
 * Resolves grpIds back to real card names via functions/cards.ts's queryCards (arena_grp_ids
 * filter) instead of a separate `cards` query.
 */

import type { Db } from "mongodb";
import { queryCards } from "./cards.js";

interface DraftResultDoc {
  _id: string;
  owner_user_id: string;
  event_name: string | null;
  draft_format: string | null;
  picks: number[];
  packs_seen: Array<{ pack_number: number; pick_number: number; grp_ids: number[] }>;
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
  packs_seen: Array<{ pack_number: number; pick_number: number; cards: ResolvedPick[] }>;
  started_at: Date;
  updated_at: Date;
}

/** List the given owner's recent drafts, summary fields only. */
async function queryDraftResultList(writeDb: Db, ownerUserId: string, limit: number): Promise<DraftResultSummary[]> {
  const docs = await writeDb
    .collection<DraftResultDoc>("draft_results")
    .find({ owner_user_id: ownerUserId })
    .sort({ updated_at: -1 })
    .limit(limit)
    .project<Pick<DraftResultDoc, "_id" | "event_name" | "draft_format" | "picks" | "started_at" | "updated_at">>({
      event_name: 1, draft_format: 1, picks: 1, started_at: 1, updated_at: 1,
    })
    .toArray();
  return docs.map((d) => ({
    draft_id: d._id,
    event_name: d.event_name,
    draft_format: d.draft_format,
    picks_made: d.picks.length,
    started_at: d.started_at,
    updated_at: d.updated_at,
  }));
}

/** Get the raw draft doc by id (for ownership checks). */
async function getDraftResultDoc(writeDb: Db, draftId: string): Promise<DraftResultDoc | null> {
  return writeDb.collection<DraftResultDoc>("draft_results").findOne({ _id: draftId });
}

/** One draft, fully resolved: every pick and every pack's options resolved to real card names via
 *  queryCards' arena_grp_ids filter, instead of a raw grpId array. */
async function queryDraftResultDetail(readDb: Db, draft: DraftResultDoc): Promise<DraftResultDetail> {
  const allGrpIds = Array.from(new Set([...draft.picks, ...draft.packs_seen.flatMap((p) => p.grp_ids)]));
  const cards = await queryCards(readDb, { arena_grp_ids: allGrpIds });

  const nameByGrpId = new Map<number, string>();
  for (const card of cards) {
    for (const id of card.arena_grp_ids) {
      if (allGrpIds.includes(id)) nameByGrpId.set(id, card.name);
    }
  }
  const resolveOne = (grpId: number): ResolvedPick => ({ grp_id: grpId, name: nameByGrpId.get(grpId) ?? null });

  return {
    draft_id: draft._id,
    event_name: draft.event_name,
    draft_format: draft.draft_format,
    picks_made: draft.picks.map(resolveOne),
    packs_seen: draft.packs_seen.map((p) => ({
      pack_number: p.pack_number,
      pick_number: p.pick_number,
      cards: p.grp_ids.map(resolveOne),
    })),
    started_at: draft.started_at,
    updated_at: draft.updated_at,
  };
}

export { queryDraftResultList, getDraftResultDoc, queryDraftResultDetail };
export type { DraftResultDoc, DraftResultSummary, DraftResultDetail, ResolvedPick };
