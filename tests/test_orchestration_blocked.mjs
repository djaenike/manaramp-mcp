// Tests the ACTUAL runChecksAndDeliver exported from index.js -- not a re-implementation.
// A structurally broken decklist (way short of 100 cards here) no longer blocks delivery --
// there's no pass/fail gate any more. Instead it should still produce a full report, with the
// problem surfaced in actual_output.consistencyIssues and the html_report's issue banner, and
// the playtest server must still never be touched.
let playtestServerWasCalled = false;

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("json.edhrec.com")) return { ok: false, status: 404, statusText: "Not Found" };
  if (u.includes("api.scryfall.com/cards/collection")) {
    return {
      ok: true,
      json: async () => ({
        data: [
          { name: "Sol Ring", cmc: 1, type_line: "Artifact", color_identity: [], legalities: { commander: "legal" }, mana_cost: "{1}", oracle_text: "{T}: Add {C}{C}." },
          { name: "Atraxa, Grand Unifier", cmc: 7, type_line: "Legendary Creature", color_identity: ["W","U","B","G"], legalities: { commander: "legal" }, mana_cost: "{3}{G}{W}{U}{B}", oracle_text: "Flying, vigilance, deathtouch, lifelink, trample." },
        ],
        not_found: [],
      }),
    };
  }
  if (u.includes("api.cardkingdom.com")) {
    return { ok: true, json: async () => ({ data: [{ name: "Sol Ring", price_retail: "2.00", is_foil: false, qty_retail: 5 }] }) };
  }
  if (u.includes("backend.commanderspellbook.com")) return { ok: true, json: async () => ({ results: [] }) };
  if (u.includes("playtest-table.workers.dev")) {
    playtestServerWasCalled = true;
    return { ok: true, json: async () => ({ roomId: "SHOULD-NOT-HAPPEN" }) };
  }
  throw new Error("Unmocked fetch: " + u);
};

// Keep this test from writing into the real Downloads folder -- run-checks-and-deliver.ts reads
// this env var at module-load time (see REPORTS_DIR there).
process.env.SCRYFALL_MCP_REPORTS_DIR = `${process.cwd()}/tests/.tmp_reports_blocked`;

const { runChecksAndDeliver } = await import("../src/tools/shared/run-checks-and-deliver.js");
const { unlinkSync, rmdirSync } = await import("fs");

const brokenDecklistText = "Commander\n1 Atraxa, Grand Unifier\n\nDeck\n1 Sol Ring";
const result = await runChecksAndDeliver({
  decklist_text: brokenDecklistText,
  deck_name: "Test Broken Deck",
  wincon_summary: "n/a", general_strategy: "n/a",
});

console.log("blocked:", result.blocked);
console.log("consistency issues:", result.actual_output?.consistencyIssues);
console.log("playtest server was called:", playtestServerWasCalled);

if (result.report_path) {
  try { unlinkSync(result.report_path); } catch {} // don't leave test output files behind
}
try { rmdirSync(process.env.SCRYFALL_MCP_REPORTS_DIR); } catch {} // remove the scratch dir itself if now empty

// The static template always contains the literal string "issue-banner" (it's in the <style>
// block and the renderer's own JS, regardless of data) -- that alone wouldn't prove anything got
// injected. Check instead that the actual issue text made it into the embedded DECK_DATA JSON.
const issueTextEmbedded = result.html_report?.includes("Deck has 2 total cards");

const pass = result.blocked === false
  && result.actual_output?.consistencyIssues?.length > 0
  && issueTextEmbedded
  && !playtestServerWasCalled;

console.log(pass
  ? "\nPASS: a structurally broken deck still gets a full report with the issue banner, and never touches the playtest server."
  : "\nFAIL.");
