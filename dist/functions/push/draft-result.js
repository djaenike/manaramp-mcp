async function pushDraftResult(writeDb, ownerUserId, args) {
  const now = /* @__PURE__ */ new Date();
  const collection = writeDb.collection("draft_results");
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
        updated_at: now
      },
      $setOnInsert: { _id: args.draft_id, started_at: now }
    },
    { upsert: true }
  );
  return { draft_result_id: args.draft_id, was_new: !existing };
}
export {
  pushDraftResult
};
