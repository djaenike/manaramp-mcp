/**
 * tools/shared/deck-analysis.ts
 *
 * Shared analysis pipeline for optimize_deck (analyze/propose, never persists) and publish_deck
 * (persists, so re-runs this same analysis first to get fresh facts rather than trusting whatever
 * optimize_deck last returned -- the decklist may have changed in between). Extracted so the two
 * tools can't drift apart on what "the facts" actually are -- this is now the ONE place that parses
 * a decklist, runs the single queryCards batch, and gathers consistency + bracket facts, same "one
 * canonical query per collection per call" rule as functions/query/cards.ts itself follows.
 *
 * This is a straight split of what manage-deck.ts used to do inline, up through -- but not
 * including -- persistence (that part is publish_deck's own job now, via functions/push/deck.ts).
 */

import type { Db } from "mongodb";
import { queryCards } from "../../functions/query/cards.js";
import { validateDeck, type DeckValidationResult } from "../../functions/reference/deck-validation.js";
import { gatherDeckFacts, type DeckFacts } from "../../functions/reference/bracket-facts.js";
import { parseDecklistText } from "../../functions/parsing/decklist-parser.js";

interface DeckAnalysis {
  commanderNames: string[];
  deckEntries: Array<{ qty: number; name: string }>;
  consistency: DeckValidationResult;
  facts: DeckFacts;
  priceTotal: number;
  cardsNotPriced: string[];
  totalCards: number;
}

/** Throws a plain Error with a user-facing message on a decklist that couldn't even be parsed --
 *  both callers turn that into their own tool-response shape rather than a thrown exception
 *  reaching the MCP transport. */
async function analyzeDecklist(readDb: Db, decklist_text: string): Promise<DeckAnalysis> {
  const { commanderNames, deckEntries } = parseDecklistText(decklist_text);
  if (!commanderNames.length || !deckEntries.length) {
    throw new Error("Couldn't parse a commander and deck from the decklist -- check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting.");
  }

  const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
  const allIdentifierNames = Array.from(new Set([...commanderNames, ...uniqueDeckNames]));

  // The ONE query against `cards` this whole analysis needs -- consistency checks, mana curve,
  // price, and gatherDeckFacts's tutor/ramp/token/counterspell/recursion facts all read from this
  // same result instead of each running their own lookup.
  const cards = await queryCards(readDb, { names: allIdentifierNames });
  const facts = await gatherDeckFacts(readDb, commanderNames, uniqueDeckNames, cards);
  const consistency = validateDeck(cards, commanderNames, deckEntries);

  const priceByNameLower = new Map(cards.map((c) => [c.name.toLowerCase(), c.price_usd]));
  let priceTotal = 0;
  const cardsNotPriced: string[] = [];
  for (const name of commanderNames) {
    const p = priceByNameLower.get(name.toLowerCase());
    if (p == null) cardsNotPriced.push(name); else priceTotal += p;
  }
  for (const entry of deckEntries) {
    const p = priceByNameLower.get(entry.name.toLowerCase());
    if (p == null) { for (let i = 0; i < entry.qty; i++) cardsNotPriced.push(entry.name); } else priceTotal += p * entry.qty;
  }
  priceTotal = Math.round(priceTotal * 100) / 100;

  const totalCards = commanderNames.length + deckEntries.reduce((s, e) => s + e.qty, 0);

  return { commanderNames, deckEntries, consistency, facts, priceTotal, cardsNotPriced, totalCards };
}

/** Shared by optimize_deck and publish_deck's own bracket_level_matches_request field. */
function extractBracketNumber(s: unknown): string | null {
  const m = String(s ?? "").match(/\d+/);
  return m ? m[0] : null;
}

export { analyzeDecklist, extractBracketNumber };
export type { DeckAnalysis };
