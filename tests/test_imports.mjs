import { searchCards, getCardByName, getRulings } from "../sub-tools/scryfall/cards.js";
import { getCommanderRecommendations, getCardSynergies, getAverageDecklist } from "../sub-tools/edhrec/recommendations.js";
import { getCardScript } from "../sub-tools/forge/card_script.js";
import { getCardKingdomPrice, computeDeckPriceTotal } from "../sub-tools/cardkingdom/pricing.js";
import { findCombos } from "../sub-tools/spellbook/combos.js";
import { computeBracketRating } from "../sub-tools/bracket/rating.js";
import { buildDeckByPrice } from "../sub-tools/deck-building/price_constrained_builder.js";
import { computeDeckConsistency } from "../sub-tools/deck-building/consistency.js";
import { getMoxfieldDecklist } from "../sub-tools/deck-building/moxfield.js";
import { classifyCategory, isManaRock, isCardDraw, isRemoval } from "../sub-tools/scryfall/classify.js";
import { fetchImageAsDataUri, inlineCardImages } from "../sub-tools/scryfall/images.js";
import { buildActualOutput } from "../sub-tools/delivery/report_data.js";
import { renderDeckReportHtml } from "../sub-tools/delivery/html_renderer.js";
import { createPlaytestRoom } from "../sub-tools/delivery/create_playtest_room.js";
import { parsePlaytestDecklist } from "../sub-tools/playtest/state.js";
import { listGames, createTable } from "../sub-tools/playtest/lobby.js";
import { getState, loadDeck, doAction } from "../sub-tools/playtest/actions.js";
import { parseCardRatingsCsv, loadCardRatings } from "../sub-tools/arena-log/card_ratings.js";
import { LogReader } from "../sub-tools/arena-log/log_reader.js";
import { DraftScanner } from "../sub-tools/arena-log/draft_log_parser.js";
import { extractGreEvents, buildMatchTimeline, createMatchState } from "../sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline, resolveGrpIds } from "../sub-tools/arena-log/grpid_resolver.js";

process.argv[1] = "/nonexistent"; // ensures the import.meta.url guard skips server.connect()
const { runChecksAndDeliver } = await import("../index.js");

const all = { searchCards, getCardByName, getRulings, getCommanderRecommendations, getCardSynergies,
  getAverageDecklist, getCardScript, getCardKingdomPrice, computeDeckPriceTotal, findCombos,
  computeBracketRating, buildDeckByPrice, computeDeckConsistency, getMoxfieldDecklist,
  classifyCategory, isManaRock, isCardDraw, isRemoval, fetchImageAsDataUri, inlineCardImages,
  buildActualOutput, renderDeckReportHtml, createPlaytestRoom, parseCardRatingsCsv, loadCardRatings,
  parsePlaytestDecklist, listGames, createTable, getState, loadDeck, doAction, runChecksAndDeliver,
  LogReader, DraftScanner, extractGreEvents, buildMatchTimeline, createMatchState, enrichTimeline, resolveGrpIds };

let allGood = true;
for (const [name, val] of Object.entries(all)) {
  const ok = typeof val === "function";
  if (!ok) allGood = false;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${typeof val}`);
}
console.log(allGood
  ? `\nAll ${Object.keys(all).length} imports resolved correctly via CJS/ESM interop.`
  : "\nSOME IMPORTS FAILED.");
