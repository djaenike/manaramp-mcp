async function pushGameLog(writeDb, ownerUserId, args) {
  const doc = {
    _id: crypto.randomUUID(),
    owner_user_id: ownerUserId,
    deck_id: args.deck_id ?? null,
    format: args.format ?? null,
    events: args.events,
    result: args.result ?? null,
    logged_at: /* @__PURE__ */ new Date()
  };
  await writeDb.collection("game_logs").insertOne(doc);
  return { game_log_id: doc._id };
}
export {
  pushGameLog
};
