function slugifyDeckName(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "deck";
}
async function pushDeck(writeDb, ownerUserId, fields, existingDeck, opts = {}) {
  const decksCollection = writeDb.collection("decks");
  const now = /* @__PURE__ */ new Date();
  if (existingDeck) {
    await decksCollection.updateOne({ _id: existingDeck._id }, { $set: { ...fields, updated_at: now } });
    return { deck_id: existingDeck._id, slug: existingDeck.slug, was_new: false };
  }
  const deckId = crypto.randomUUID();
  const baseSlug = slugifyDeckName(fields.name);
  const slugTaken = await decksCollection.findOne({ slug: baseSlug });
  const slug = slugTaken ? `${baseSlug}_${crypto.randomUUID().slice(0, 6)}` : baseSlug;
  await decksCollection.insertOne({
    _id: deckId,
    owner_user_id: ownerUserId,
    slug,
    platform: null,
    is_public: opts.is_public ?? false,
    origin_draft_result_id: null,
    created_at: now,
    updated_at: now,
    ...fields
  });
  return { deck_id: deckId, slug, was_new: true };
}
export {
  pushDeck
};
