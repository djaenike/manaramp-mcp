import { searchCards, getCardByName, getRulings } from "./sub-tools/scryfall/cards.js";
import { getCommanderRecommendations, getCardSynergies, getAverageDecklist } from "./sub-tools/edhrec/recommendations.js";
import { getCardScript } from "./sub-tools/forge/card_script.js";
import { getCardKingdomPrice, computeDeckPriceTotal } from "./sub-tools/cardkingdom/pricing.js";
import { findCombos } from "./sub-tools/spellbook/combos.js";
import { computeBracketRating } from "./sub-tools/bracket/rating.js";
import { buildBudgetDeck } from "./sub-tools/deck-building/budget_builder.js";
import { computeDeckConsistency } from "./sub-tools/deck-building/consistency.js";
import { getMoxfieldDecklist } from "./sub-tools/deck-building/moxfield.js";
import { parsePlaytestDecklist } from "./sub-tools/playtest/state.js";
import { listGames, createTable } from "./sub-tools/playtest/lobby.js";
import { getState, loadDeck, doAction } from "./sub-tools/playtest/actions.js";
import { deliverFinishedDeck } from "./sub-tools/delivery/deliver_finished_deck.js";
import { LogReader } from "./sub-tools/arena-log/log_reader.js";
import { DraftScanner } from "./sub-tools/arena-log/draft_log_parser.js";
import { extractGreEvents, buildMatchTimeline, createMatchState } from "./sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline, resolveGrpIds } from "./sub-tools/arena-log/grpid_resolver.js";

const all = { searchCards, getCardByName, getRulings, getCommanderRecommendations, getCardSynergies,
  getAverageDecklist, getCardScript, getCardKingdomPrice, computeDeckPriceTotal, findCombos,
  computeBracketRating, buildBudgetDeck, computeDeckConsistency, getMoxfieldDecklist,
  parsePlaytestDecklist, listGames, createTable, getState, loadDeck, doAction, deliverFinishedDeck,
  LogReader, DraftScanner, extractGreEvents, buildMatchTimeline, createMatchState, enrichTimeline, resolveGrpIds };

let allGood = true;
for (const [name, val] of Object.entries(all)) {
  const ok = typeof val === "function";
  if (!ok) allGood = false;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${typeof val}`);
}
console.log(allGood ? "\nAll 27 imports resolved correctly via CJS/ESM interop." : "\nSOME IMPORTS FAILED.");
