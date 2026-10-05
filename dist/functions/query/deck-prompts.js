const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function shortId(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}
async function getDeckPrompt(db, id, ownerUserId) {
  const doc = await db.collection("deck_prompts").findOne({ _id: id.replace(/^#/, "").trim().toLowerCase() });
  return doc && doc.owner_user_id === ownerUserId ? doc : null;
}
function constraintsOf(p) {
  return {
    colors: p.colors ?? [],
    max_price_usd: p.max_price_usd ?? null,
    bracket: p.bracket ?? null,
    theme: p.theme ?? null,
    restrictions: p.restrictions ?? null,
    build_style: p.build_style ?? "original",
    use_synergies: !!p.use_synergies,
    use_combos: !!p.use_combos,
    type_targets: p.type_targets ?? null,
    role_targets: p.role_targets ?? null
  };
}
async function createChatDeckPrompt(db, ownerUserId, input) {
  const col = db.collection("deck_prompts");
  let id = shortId();
  for (let i = 0; i < 5 && await col.findOne({ _id: id }, { projection: { _id: 1 } }); i++) id = shortId();
  const now = /* @__PURE__ */ new Date();
  await col.insertOne({
    _id: id,
    owner_user_id: ownerUserId,
    name: input.name,
    format: input.format,
    platform: null,
    commander: input.commander,
    ...input.constraints,
    prompt_text: "(created from chat by the AI assistant -- no website prompt)",
    status: "pending",
    deck_ids: [],
    source: "chat",
    created_at: now,
    updated_at: now
  });
  return id;
}
async function promptDeckId(db, prompt, ownerUserId) {
  if (!prompt?.deck_id) return null;
  const deck = await db.collection("decks").findOne({ _id: prompt.deck_id, owner_user_id: ownerUserId }, { projection: { _id: 1 } });
  return deck ? deck._id : null;
}
async function promptNotFoundMessage(db, id, ownerUserId, accountLabel) {
  const cleanId = id.replace(/^#/, "").trim().toLowerCase();
  const exists = await db.collection("deck_prompts").findOne({ _id: cleanId }, { projection: { owner_user_id: 1 } });
  if (exists && exists.owner_user_id !== ownerUserId) {
    const who = accountLabel ? ` (${accountLabel})` : "";
    return `Deck prompt '#${cleanId}' was made on a different Manaramp account than the one this assistant is connected to${who}. Do NOT build the deck and do not continue without the prompt -- that would put the deck on the wrong account. Tell the user briefly: this assistant is signed in to Manaramp as ${accountLabel ?? "a different account"}; either sign in to manaramp.com with that account and create the prompt again, or reconnect the assistant's Manaramp connector to the account that made the prompt.`;
  }
  return `No deck prompt '#${cleanId}' exists -- check the id with the user, or build from what they said in chat instead.`;
}
async function markPromptBuilt(db, id, deckId) {
  await db.collection("deck_prompts").updateOne({ _id: id }, { $set: { status: "built", updated_at: /* @__PURE__ */ new Date() }, $addToSet: { deck_ids: deckId } });
}
export {
  constraintsOf,
  createChatDeckPrompt,
  getDeckPrompt,
  markPromptBuilt,
  promptDeckId,
  promptNotFoundMessage
};
