// Verifies the fix for arena_draft_assistance's real gap: pickedCards (grpIds Arena's own log
// already records as actually picked) must be resolved to real card data and returned, not just
// counted. Exercises the exact same building blocks index.js's handler uses -- DraftScanner +
// resolveGrpIds -- with fake log lines shaped like real Quick Draft pack/pick broadcasts, so this
// doesn't depend on a real running Arena client or Player.log.

const { DraftScanner } = await import("../sub-tools/arena-log/draft_log_parser.js");
const { resolveGrpIds } = await import("../sub-tools/arena-log/grpid_resolver.js");

function quickPackLine(packNumber, pickNumber, cardIds) {
  const payload = JSON.stringify({ DraftStatus: "PickNext", PackNumber: packNumber, PickNumber: pickNumber, DraftPack: cardIds });
  return `[UnityCrossThreadLogger]==> BotDraft_DraftPack ` + JSON.stringify({ CurrentModule: "Draft", Payload: payload });
}

// Real shape (verified against 17Lands' own official client and manasight-parser, see
// draft_log_parser.js's header comment and tests/test_draft_pick_parsing.mjs): `request` parses
// directly to { PickInfo: { CardIds: [...], ... } } -- no extra .Payload wrapper, and CardIds is
// a plural array, not a singular CardId.
function quickPickLine(packNumber, pickNumber, cardId) {
  const request = JSON.stringify({ PickInfo: { PackNumber: packNumber, PickNumber: pickNumber, CardIds: [cardId] } });
  return `[UnityCrossThreadLogger]==> BotDraftDraftPick ` + JSON.stringify({ id: "test-id", request });
}

const FAKE_CARD_DB = {
  70000: { name: "Fake Bomb Rare", type_line: "Creature", category: "Creature" },
  70001: { name: "Fake Common Removal", type_line: "Instant", category: "Instant" },
  70002: { name: "Fake Second Pick", type_line: "Sorcery", category: "Sorcery" },
};
async function fakeSearchCards(query) {
  const id = parseInt(query.split(":")[1], 10);
  return FAKE_CARD_DB[id] ? [FAKE_CARD_DB[id]] : [];
}

const scanner = new DraftScanner();

// Pack 1, pick 1: two cards offered, human picks 70000.
scanner.processLines([quickPackLine(0, 0, [70000, 70001])]);
scanner.processLines([quickPickLine(0, 0, 70000)]);

// Pack 1, pick 2: a new pack arrives.
scanner.processLines([quickPackLine(0, 1, [70002])]);

const state = scanner.getState();
console.log("currentPack (raw grpIds):", state.currentPack);
console.log("pickedCards (raw grpIds):", state.pickedCards);

// Mirrors index.js's arena_draft_assistance handler exactly: one combined resolveGrpIds call.
const currentPackIds = state.currentPack.map((id) => parseInt(id, 10));
const pickedCardIds = state.pickedCards.map((id) => parseInt(id, 10));
const { cards: resolved } = await resolveGrpIds([...currentPackIds, ...pickedCardIds], fakeSearchCards);
const resolveOne = (id) => {
  const card = resolved.get(parseInt(id, 10));
  return card ? card[0] ?? card : { grpId: id, card: null };
};
const enrichedPack = state.currentPack.map(resolveOne);
const picksMade = state.pickedCards.map(resolveOne);

console.log("picks_made (resolved):", JSON.stringify(picksMade));
console.log("current_pack (resolved):", JSON.stringify(enrichedPack));

const pass = state.pickedCards.length === 1
  && picksMade.length === 1 && picksMade[0]?.name === "Fake Bomb Rare"
  && enrichedPack.length === 1 && enrichedPack[0]?.name === "Fake Second Pick";

console.log(pass
  ? "\nPASS: picks_made returns real resolved card data (not just a count), matching what Arena's own log already recorded."
  : "\nFAIL.");

// --- Real-draft bug regression: a shared cache must stop re-resolving already-seen grpIds -----
// This is the actual root cause found from a live draft session (see grpid_resolver.js's header
// comment): without a cross-call cache, every call re-resolved the ENTIRE pick history from
// scratch, which is what made later-draft calls progressively slower and also tripped Scryfall's
// rate limit under the resulting load. Simulates two successive "next pack" calls sharing one
// cache, the way index.js's grpIdCardCache is shared across calls for one process's lifetime.
let searchCallCount = 0;
async function countingSearchCards(query) {
  searchCallCount++;
  return fakeSearchCards(query);
}

const sharedCache = new Map();
await resolveGrpIds([70000, 70001], countingSearchCards, { cache: sharedCache });
const callsAfterFirstResolve = searchCallCount;

// "Next call": re-resolve the SAME two grpIds plus one genuinely new one, sharing the cache.
await resolveGrpIds([70000, 70001, 70002], countingSearchCards, { cache: sharedCache });
const newCallsOnSecondResolve = searchCallCount - callsAfterFirstResolve;

console.log("search calls for first resolve (2 new ids):", callsAfterFirstResolve);
console.log("search calls for second resolve (2 cached + 1 new id):", newCallsOnSecondResolve);

const cachePass = callsAfterFirstResolve === 2 && newCallsOnSecondResolve === 1;
console.log(cachePass
  ? "PASS: a shared cache resolves only genuinely new grpIds on a later call, not the whole pick history again."
  : "FAIL: cache did not avoid re-resolving already-seen grpIds.");
