import { queryCards } from "./cards.js";
async function queryDraftResultList(writeDb, ownerUserId, limit) {
  const docs = await writeDb.collection("draft_results").find({ owner_user_id: ownerUserId }).sort({ updated_at: -1 }).limit(limit).project({
    event_name: 1,
    draft_format: 1,
    picks: 1,
    started_at: 1,
    updated_at: 1
  }).toArray();
  return docs.map((d) => ({
    draft_id: d._id,
    event_name: d.event_name,
    draft_format: d.draft_format,
    picks_made: d.picks.length,
    started_at: d.started_at,
    updated_at: d.updated_at
  }));
}
async function getDraftResultDoc(writeDb, draftId) {
  return writeDb.collection("draft_results").findOne({ _id: draftId });
}
async function queryDraftResultDetail(readDb, draft) {
  const allGrpIds = Array.from(/* @__PURE__ */ new Set([...draft.picks, ...draft.packs_seen.flatMap((p) => p.grp_ids)]));
  const cards = await queryCards(readDb, { arena_grp_ids: allGrpIds });
  const nameByGrpId = /* @__PURE__ */ new Map();
  for (const card of cards) {
    for (const id of card.arena_grp_ids) {
      if (allGrpIds.includes(id)) nameByGrpId.set(id, card.name);
    }
  }
  const resolveOne = (grpId) => ({ grp_id: grpId, name: nameByGrpId.get(grpId) ?? null });
  return {
    draft_id: draft._id,
    event_name: draft.event_name,
    draft_format: draft.draft_format,
    picks_made: draft.picks.map(resolveOne),
    packs_seen: draft.packs_seen.map((p) => ({
      pack_number: p.pack_number,
      pick_number: p.pick_number,
      cards: p.grp_ids.map(resolveOne)
    })),
    started_at: draft.started_at,
    updated_at: draft.updated_at
  };
}
export {
  getDraftResultDoc,
  queryDraftResultDetail,
  queryDraftResultList
};
