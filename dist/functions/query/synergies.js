function slugify(name) {
  return name.toLowerCase().trim().replace(/['’,]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function querySynergies(db, commander_name) {
  const slug = slugify(commander_name);
  const doc = await db.collection("commander_synergies").findOne({ _id: slug });
  if (!doc) {
    throw new Error(`No commander_synergies entry for '${commander_name}' (slug '${slug}'). Check spelling, or this commander hasn't been ingested yet.`);
  }
  if (!doc.recommended_cards) {
    throw new Error(`'${commander_name}' is known but its recommendations haven't synced yet (recommended_cards is still null) -- try again once the daily ingest catches up.`);
  }
  return {
    commander: commander_name,
    recommended_cards: doc.recommended_cards.map((c) => ({ name: c.name, synergy_pct: c.synergy_pct, inclusion_pct: c.inclusion_pct }))
  };
}
export {
  querySynergies,
  slugify
};
