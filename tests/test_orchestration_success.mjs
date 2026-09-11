// Verifies: a clean, valid decklist produces a full report (actual_output + html_report),
// WITHOUT touching the playtest server (disabled for now -- see runChecksAndDeliver's comment
// in index.js). The playtest-table.workers.dev branch below exists specifically to FAIL LOUDLY
// if that ever changes without this test being updated to match.

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("json.edhrec.com")) return { ok: false, status: 404, statusText: "Not Found" };
  if (u.includes("api.scryfall.com/cards/collection")) {
    // A full, minimal-but-legal 100-card deck: 1 commander + 99 library (40 basics, 59 spells).
    const cmdr = {
      name: "Atraxa, Grand Unifier", cmc: 7, type_line: "Legendary Creature",
      color_identity: ["W", "U", "B", "G"], legalities: { commander: "legal" },
      mana_cost: "{3}{G}{W}{U}{B}", oracle_text: "Flying, vigilance, deathtouch, lifelink, trample.",
      image_uris: { small: "https://example.com/atraxa.jpg" },
    };
    const cards = [cmdr];
    for (let i = 0; i < 99; i++) {
      const isLand = i < 40;
      cards.push({
        name: `Filler Card ${i}`, cmc: 2, type_line: isLand ? "Basic Land — Plains" : "Creature",
        color_identity: [], legalities: { commander: "legal" },
        mana_cost: isLand ? "" : "{1}{W}", oracle_text: isLand ? "" : "Draw a card when this enters.",
        image_uris: { small: `https://example.com/filler-${i}.jpg` },
      });
    }
    return { ok: true, json: async () => ({ data: cards, not_found: [] }) };
  }
  if (u.includes("api.cardkingdom.com")) {
    const data = [];
    for (let i = 0; i < 99; i++) data.push({ name: `Filler Card ${i}`, price_retail: "0.25", is_foil: false, qty_retail: 5 });
    return { ok: true, json: async () => ({ data }) };
  }
  if (u.includes("backend.commanderspellbook.com")) return { ok: true, json: async () => ({ results: [] }) };
  if (u.includes("playtest-table.workers.dev")) {
    throw new Error("REGRESSION: playtest server was called, but playtest table creation is supposed to be disabled right now.");
  }
  // NOTE: no example.com/image branch -- card images are deliberately NOT fetched/inlined by
  // default (see report_data.js's header comment), so no image fetch should happen at all here.
  throw new Error("Unmocked fetch: " + u);
};

process.argv[1] = "/nonexistent";
// Keep this test from writing into the real Downloads folder -- index.js reads this env var at
// module-load time (see REPORTS_DIR in index.js).
process.env.SCRYFALL_MCP_REPORTS_DIR = `${process.cwd()}/tests/.tmp_reports_success`;
const { runChecksAndDeliver } = await import("../index.js");
const { unlinkSync, rmdirSync } = await import("fs");

const deckLines = ["Commander", "1 Atraxa, Grand Unifier", "", "Deck"];
for (let i = 0; i < 99; i++) deckLines.push(`1 Filler Card ${i}`);

const result = await runChecksAndDeliver({
  decklist_text: deckLines.join("\n"),
  deck_name: "Test Success Deck",
  deck_design_preference: "Superfriends value pile",
  bracket_level_requested: "Bracket 2",
  wincon_summary: "Combat damage.",
  general_strategy: "Play cards, attack.",
});

console.log("blocked:", result.blocked);
console.log("consistency issues:", result.actual_output?.consistencyIssues);
console.log("bracketLevelMatchesRequest:", result.actual_output?.bracketLevelMatchesRequest);
console.log("fullDeckList length:", result.actual_output?.fullDeckList?.length);
console.log("html_report contains commander name:", result.html_report?.includes("Atraxa, Grand Unifier"));
console.log("manaCurve:", result.actual_output?.manaCurve);
console.log("curveOutProbability:", result.actual_output?.curveOutProbability);
console.log("html_report contains mana-curve markup:", result.html_report?.includes("mana-curve"));

const commanderEntry = result.actual_output?.fullDeckList?.find((c) => c.name === "Atraxa, Grand Unifier");
console.log("commander imageUrl is a plain https URL (not embedded):", commanderEntry?.imageUrl === "https://example.com/atraxa.jpg");
console.log("report_path:", result.report_path);
console.log("tool-response JSON size (bytes):", Buffer.byteLength(JSON.stringify(result)));

const pass = result.blocked === false
  && Array.isArray(result.actual_output?.consistencyIssues) && result.actual_output.consistencyIssues.length === 0
  && result.actual_output?.fullDeckList?.length === 100
  && typeof result.html_report === "string" && result.html_report.includes("Atraxa, Grand Unifier")
  // 59 nonland fillers, all cmc 2, 40 basics excluded from the curve entirely -- everything should land in bucket "2".
  && result.actual_output?.manaCurve?.["2"] === 59
  && typeof result.actual_output?.curveOutProbability?.turn_1 === "number"
  && result.html_report?.includes("mana-curve")
  // images must stay plain URLs, not embedded -- that's the actual fix for the "Tool result is too
  // large" regression (embedding blew a real deck's response past the ~1MB client-enforced cap).
  && commanderEntry?.imageUrl === "https://example.com/atraxa.jpg"
  && typeof result.report_path === "string"
  && Buffer.byteLength(JSON.stringify(result)) < 1_000_000;

if (result.report_path) {
  try { unlinkSync(result.report_path); } catch {} // don't leave test output files behind
}
try { rmdirSync(process.env.SCRYFALL_MCP_REPORTS_DIR); } catch {} // remove the scratch dir itself if now empty

console.log(pass
  ? "\nPASS: clean deck produces a full report with html_report + report_path, well under the MCP tool-result size cap, playtest server never touched."
  : "\nFAIL.");
