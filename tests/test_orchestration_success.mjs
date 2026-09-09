// Verifies: a clean, valid decklist passes consistency/bracket/price and returns
// final_delivery_text, WITHOUT touching the playtest server (disabled for now --
// see runChecksAndDeliver's comment in index.js). No WebSocket/playtest mocking
// needed since that code path isn't called; the playtest-table.workers.dev branch
// below exists specifically to FAIL LOUDLY if that ever changes without this test
// being updated to match.

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("json.edhrec.com")) return { ok: false, status: 404, statusText: "Not Found" };
  if (u.includes("api.scryfall.com/cards/collection")) {
    // A full, minimal-but-legal 100-card deck: 1 commander + 99 library (40 basics, 59 spells).
    const cmdr = { name: "Atraxa, Grand Unifier", cmc: 7, type_line: "Legendary Creature", color_identity: ["W","U","B","G"], legalities: { commander: "legal" } };
    const cards = [cmdr];
    for (let i = 0; i < 99; i++) {
      cards.push({ name: `Filler Card ${i}`, cmc: 2, type_line: i < 40 ? "Basic Land — Plains" : "Creature", color_identity: [], legalities: { commander: "legal" } });
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
  throw new Error("Unmocked fetch: " + u);
};

process.argv[1] = "/nonexistent";
const { runChecksAndDeliver } = await import("../index.js");

const deckLines = ["Commander", "1 Atraxa, Grand Unifier", "", "Deck"];
for (let i = 0; i < 99; i++) deckLines.push(`1 Filler Card ${i}`);

const result = await runChecksAndDeliver({
  decklist_text: deckLines.join("\n"),
  wincon_summary: "Combat damage.",
  general_strategy: "Play cards, attack.",
});

console.log("blocked:", result.blocked);
console.log("consistency issues:", result.consistency?.issues);
console.log("final_delivery_text present:", !!result.final_delivery_text);
console.log(result.blocked === false && !!result.final_delivery_text
  ? "\nPASS: clean deck delivers final_delivery_text, playtest server never touched."
  : "\nFAIL.");
