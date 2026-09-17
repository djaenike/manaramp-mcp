import { queryCards } from "./cards.js";
function norm(name) {
  return name.trim().toLowerCase();
}
const FAST_COMBO_MAX_CMC = 6;
async function queryCombos(db, card_names, limit) {
  const nameSet = new Set(card_names.map(norm));
  const candidates = await db.collection("combos").find({ pieces_names: { $in: card_names } }).limit(limit ? limit * 20 : 500).toArray();
  const assembled = candidates.filter((v) => v.pieces_names.every((p) => nameSet.has(norm(p))));
  if (assembled.length === 0) return [];
  const allPieceNames = Array.from(new Set(assembled.flatMap((v) => v.pieces_names)));
  const cardDocs = await queryCards(db, { names: allPieceNames });
  const cmcByName = new Map(cardDocs.map((c) => [norm(c.name), c.cmc ?? 0]));
  const results = assembled.map((v) => {
    const totalCmc = v.pieces_names.reduce((sum, name) => sum + (cmcByName.get(norm(name)) ?? 0), 0);
    return {
      id: v._id,
      pieces: v.pieces_names,
      result: v.result,
      steps: v.steps,
      permalink: v.spellbook_url,
      total_cmc: totalCmc,
      speed: totalCmc <= FAST_COMBO_MAX_CMC ? "fast" : "slow"
    };
  });
  return limit ? results.slice(0, limit) : results;
}
export {
  FAST_COMBO_MAX_CMC,
  queryCombos
};
