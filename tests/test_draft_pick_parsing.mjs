// Regression test for the draft-pick parsing fix. Fixture shapes below are modeled directly on
// two real, currently-maintained parsers read directly for this fix (not secondhand docs):
//   - 17Lands' own official client: rconroy293/mtga-log-client, mtga_follower.py
//   - manasight-parser: manasight/manasight-parser, src/parsers/draft/{human,bot}.rs (has its
//     own test fixtures against real log text, which these mirror)
// Covers: Quick Draft pick (both marker spellings, the sentinel-0 case, ignoring the bare `<==`
// response), and Premier/Traditional pick (both observed payload shapes), end-to-end through
// DraftScanner so `pickedCards` is verified, not just the standalone parse functions.

import { DraftScanner, parseQuickPick, parseHumanDraftPick } from "../sub-tools/arena-log/draft_log_parser.js";

function quickPickLine(marker, cardIds, packNumber, pickNumber) {
  const request = JSON.stringify({
    EventName: "QuickDraft_TEST_20260101",
    PickInfo: { EventName: "QuickDraft_TEST_20260101", CardIds: cardIds, PackNumber: packNumber, PickNumber: pickNumber },
  });
  return `[UnityCrossThreadLogger]==> ${marker} ` + JSON.stringify({ id: "abc-123", request });
}

function humanPickLineRequestShape(draftId, grpIds, pack, pick) {
  const request = JSON.stringify({ DraftId: draftId, GrpIds: grpIds, Pack: pack, Pick: pick });
  return "[UnityCrossThreadLogger]==> EventPlayerDraftMakePick " + JSON.stringify({ id: "def-456", request });
}

function humanPickLinePickInfoShape(cardId, packNumber, pickNumber) {
  return "[UnityCrossThreadLogger]==> EventPlayerDraftMakePick " +
    JSON.stringify({ id: "ghi-789", PickInfo: { CardId: cardId, PackNumber: packNumber, PickNumber: pickNumber } });
}

let allPass = true;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) allPass = false;
}

// --- Quick Draft: no-underscore marker, CardIds array ---
const qp1 = parseQuickPick(quickPickLine("BotDraftDraftPick", [98546], 0, 0));
check("Quick Draft pick (no-underscore marker) resolves cardId", qp1?.cardId === "98546");
check("Quick Draft pick numbers are +1'd (human-facing)", qp1?.packNumber === 1 && qp1?.pickNumber === 1);

// --- Quick Draft: underscore marker still matches ---
const qp2 = parseQuickPick(quickPickLine("BotDraft_DraftPick", [11111], 1, 3));
check("Quick Draft pick (underscore marker) also resolves", qp2?.cardId === "11111" && qp2?.packNumber === 2 && qp2?.pickNumber === 4);

// --- Quick Draft: CardIds[0] === 0 sentinel is not a real pick ---
const qp3 = parseQuickPick(quickPickLine("BotDraftDraftPick", [0], 0, 0));
check("Quick Draft sentinel CardIds:[0] is rejected, not treated as a pick", qp3 === null);

// --- Quick Draft: a bare <== response line must NOT be parsed as a pick ---
const qp4 = parseQuickPick('<== BotDraftDraftPick(e1f2a3b4-5678-90cd-ef12-34567890abcd)');
check("Bare <== response line is ignored (no ==> present)", qp4 === null);

// --- Human draft: request-wrapped GrpIds/Pack/Pick shape (17Lands' own confirmed shape) ---
const hp1 = parseHumanDraftPick(humanPickLineRequestShape("draft-abc", [22222], 1, 5));
check("Human draft pick (GrpIds/Pack/Pick request shape) resolves cardId", hp1?.cardId === "22222");
check("Human draft pick (GrpIds/Pack/Pick request shape) resolves pack/pick", hp1?.packNumber === 1 && hp1?.pickNumber === 5);

// --- Human draft: top-level PickInfo/CardId/PackNumber/PickNumber shape ---
const hp2 = parseHumanDraftPick(humanPickLinePickInfoShape(33333, 2, 9));
check("Human draft pick (PickInfo/CardId shape) resolves cardId", hp2?.cardId === "33333");
check("Human draft pick (PickInfo/CardId shape) resolves pack/pick", hp2?.packNumber === 2 && hp2?.pickNumber === 9);

// --- Human draft: bare <== response must NOT be parsed as a pick ---
const hp3 = parseHumanDraftPick('<== EventPlayerDraftMakePick(e1f2a3b4-5678-90cd-ef12-34567890abcd)');
check("Human draft bare <== response line is ignored", hp3 === null);

// --- End-to-end through DraftScanner: pickedCards actually gets populated ---
const scanner = new DraftScanner();
scanner.processLines([quickPickLine("BotDraftDraftPick", [98546], 0, 0)]);
const quickState = scanner.getState();
check("DraftScanner records a Quick Draft pick into pickedCards", quickState.pickedCards.length === 1 && quickState.pickedCards[0] === "98546");

scanner.reset();
scanner.processLines([humanPickLineRequestShape("draft-abc", [22222], 1, 5)]);
const humanState = scanner.getState();
check("DraftScanner records a human draft pick into pickedCards", humanState.pickedCards.length === 1 && humanState.pickedCards[0] === "22222");

console.log(allPass
  ? "\nPASS: draft pick parsing correctly handles both real event shapes for Quick Draft and Premier/Traditional Draft."
  : "\nFAIL.");
