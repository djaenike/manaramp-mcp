import { queryCards } from "./cards.js";
async function getDeckDoc(writeDb, by) {
  return writeDb.collection("decks").findOne(by.deck_id ? { _id: by.deck_id } : { slug: by.slug });
}
async function queryDeckList(writeDb, ownerUserId) {
  return writeDb.collection("decks").find({ owner_user_id: ownerUserId }).sort({ updated_at: -1 }).project({ name: 1, slug: 1, format: 1, price_usd: 1, bracket: 1, consistency_issues: 1, updated_at: 1 }).toArray();
}
async function queryDeckDetail(readDb, deck) {
  const commanderOracleIds = deck.commander?.oracle_ids ?? [];
  const allOracleIds = Array.from(/* @__PURE__ */ new Set([...commanderOracleIds, ...deck.cards]));
  const cards = await queryCards(readDb, { oracle_ids: allOracleIds });
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  const qtyByOracleId = /* @__PURE__ */ new Map();
  for (const id of deck.cards) qtyByOracleId.set(id, (qtyByOracleId.get(id) ?? 0) + 1);
  const toCard = (id, quantity) => {
    const c = byId.get(id);
    return {
      oracle_id: id,
      name: c?.name ?? id,
      quantity,
      category: c?.category ?? "Other",
      mana_cost: c?.mana_cost ?? null,
      type_line: c?.type_line ?? "",
      image_url: c?.image_url ?? null
    };
  };
  const commanderCards = commanderOracleIds.map((id) => toCard(id, 1));
  const mainDeckCards = Array.from(qtyByOracleId.entries()).map(([id, qty]) => toCard(id, qty));
  const decklistTextLines = [
    "Commander",
    ...commanderCards.map((c) => `1 ${c.name}`),
    "",
    "Deck",
    ...mainDeckCards.map((c) => `${c.quantity} ${c.name}`)
  ];
  return {
    deck_id: deck._id,
    deck_url: `https://manaramp.com/decks/${deck.slug}`,
    name: deck.name,
    format: deck.format,
    commander: commanderCards,
    main_deck: mainDeckCards,
    decklist_text: decklistTextLines.join("\n"),
    bracket: deck.bracket,
    mana_curve: deck.mana_curve,
    consistency_issues: deck.consistency_issues,
    price_usd: deck.price_usd,
    wincon_summary: deck.wincon_summary,
    general_strategy: deck.general_strategy
  };
}
export {
  getDeckDoc,
  queryDeckDetail,
  queryDeckList
};
