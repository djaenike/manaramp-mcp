const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
async function saveDraft(db, draft) {
  const id = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const now = /* @__PURE__ */ new Date();
  await db.collection("deck_drafts").insertOne({ _id: id, ...draft, created_at: now, expires_at: new Date(now.getTime() + DRAFT_TTL_MS) });
  return id;
}
async function getDraft(db, id, ownerUserId) {
  const doc = await db.collection("deck_drafts").findOne({ _id: id.trim() });
  if (!doc || doc.owner_user_id !== ownerUserId) return null;
  return doc.expires_at < /* @__PURE__ */ new Date() ? null : doc;
}
export {
  getDraft,
  saveDraft
};
