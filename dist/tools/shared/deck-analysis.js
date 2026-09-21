import { queryCards } from "../../functions/query/cards.js";
import { validateDeck } from "../../functions/reference/deck-validation.js";
import { gatherDeckFacts } from "../../functions/reference/bracket-facts.js";
import { parseDecklistText } from "../../functions/parsing/decklist-parser.js";
async function analyzeDecklist(readDb, decklist_text, priceSource = "cardkingdom") {
  const { commanderNames, deckEntries } = parseDecklistText(decklist_text);
  if (!commanderNames.length || !deckEntries.length) {
    throw new Error("Couldn't parse a commander and deck from the decklist -- check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting.");
  }
  const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
  const allIdentifierNames = Array.from(/* @__PURE__ */ new Set([...commanderNames, ...uniqueDeckNames]));
  const cards = await queryCards(readDb, { names: allIdentifierNames }, priceSource);
  const facts = await gatherDeckFacts(readDb, commanderNames, uniqueDeckNames, cards);
  const consistency = validateDeck(cards, commanderNames, deckEntries);
  const priceByNameLower = new Map(cards.map((c) => [c.name.toLowerCase(), c.price_usd]));
  let priceTotal = 0;
  const cardsNotPriced = [];
  for (const name of commanderNames) {
    const p = priceByNameLower.get(name.toLowerCase());
    if (p == null) cardsNotPriced.push(name);
    else priceTotal += p;
  }
  for (const entry of deckEntries) {
    const p = priceByNameLower.get(entry.name.toLowerCase());
    if (p == null) {
      for (let i = 0; i < entry.qty; i++) cardsNotPriced.push(entry.name);
    } else priceTotal += p * entry.qty;
  }
  priceTotal = Math.round(priceTotal * 100) / 100;
  const totalCards = commanderNames.length + deckEntries.reduce((s, e) => s + e.qty, 0);
  return { commanderNames, deckEntries, consistency, facts, priceTotal, cardsNotPriced, totalCards };
}
function extractBracketNumber(s) {
  const m = String(s ?? "").match(/\d+/);
  return m ? m[0] : null;
}
export {
  analyzeDecklist,
  extractBracketNumber
};
