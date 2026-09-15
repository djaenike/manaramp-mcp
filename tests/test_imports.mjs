import { searchCards, getCardByName, getRulings } from "../src/sub-tools/scryfall/cards.js";
import { getCommanderRecommendations, getCardSynergies, getAverageDecklist } from "../src/sub-tools/edhrec/recommendations.js";
import { getCardScript } from "../src/sub-tools/forge/card_script.js";
import { getCardKingdomPrice, computeDeckPriceTotal } from "../src/sub-tools/cardkingdom/pricing.js";
import { findCombos } from "../src/sub-tools/spellbook/combos.js";
import { computeBracketRating } from "../src/sub-tools/bracket/rating.js";
import { buildDeckByPrice } from "../src/sub-tools/deck-building/price_constrained_builder.js";
import { computeDeckConsistency } from "../src/sub-tools/deck-building/consistency.js";
import { getMoxfieldDecklist } from "../src/sub-tools/deck-building/moxfield.js";
import { classifyCategory, isManaRock, isCardDraw, isRemoval } from "../src/sub-tools/scryfall/classify.js";
import { fetchImageAsDataUri, inlineCardImages } from "../src/sub-tools/scryfall/images.js";
import { buildActualOutput } from "../src/sub-tools/delivery/report_data.js";
import { renderDeckReportHtml } from "../src/sub-tools/delivery/html_renderer.js";
import { createPlaytestRoom } from "../src/sub-tools/delivery/create_playtest_room.js";
import { parsePlaytestDecklist } from "../src/sub-tools/playtest/state.js";
import { listGames, createTable } from "../src/sub-tools/playtest/lobby.js";
import { getState, loadDeck, doAction } from "../src/sub-tools/playtest/actions.js";
import { parseCardRatingsCsv, loadCardRatings } from "../src/sub-tools/arena-log/card_ratings.js";
import { loadSettings, saveSettings } from "../src/sub-tools/arena-log/settings.js";
import { LogReader } from "../src/sub-tools/arena-log/log_reader.js";
import { DraftScanner } from "../src/sub-tools/arena-log/draft_log_parser.js";
import { extractGreEvents, buildMatchTimeline, createMatchState } from "../src/sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline, resolveGrpIds } from "../src/sub-tools/arena-log/grpid_resolver.js";

process.argv[1] = "/nonexistent"; // ensures the import.meta.url guard skips server.connect()
const { runChecksAndDeliver } = await import("../src/tools/shared/run-checks-and-deliver.js");
const { getOrCreateUserId, resolvePlayerLogPath } = await import("../src/tools/shared/arena-local-state.js");
const { tools } = await import("../src/tools/index.js");
const { } = await import("../src/local/index.js"); // proves the stdio bootstrap itself still imports cleanly

const all = { searchCards, getCardByName, getRulings, getCommanderRecommendations, getCardSynergies,
  getAverageDecklist, getCardScript, getCardKingdomPrice, computeDeckPriceTotal, findCombos,
  computeBracketRating, buildDeckByPrice, computeDeckConsistency, getMoxfieldDecklist,
  classifyCategory, isManaRock, isCardDraw, isRemoval, fetchImageAsDataUri, inlineCardImages,
  buildActualOutput, renderDeckReportHtml, createPlaytestRoom, parseCardRatingsCsv, loadCardRatings,
  loadSettings, saveSettings,
  parsePlaytestDecklist, listGames, createTable, getState, loadDeck, doAction, runChecksAndDeliver,
  getOrCreateUserId, resolvePlayerLogPath,
  LogReader, DraftScanner, extractGreEvents, buildMatchTimeline, createMatchState, enrichTimeline, resolveGrpIds };

let allGood = true;
for (const [name, val] of Object.entries(all)) {
  const ok = typeof val === "function";
  if (!ok) allGood = false;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${typeof val}`);
}

const toolsArrayOk = Array.isArray(tools) && tools.length === 8;
console.log(`${toolsArrayOk ? "OK  " : "FAIL"} tools/index.js exports an 8-element tools array: ${tools?.length}`);
if (!toolsArrayOk) allGood = false;

console.log(allGood
  ? `\nAll ${Object.keys(all).length} imports resolved correctly via CJS/ESM interop, plus the tools/ barrel and local/ bootstrap.`
  : "\nSOME IMPORTS FAILED.");
