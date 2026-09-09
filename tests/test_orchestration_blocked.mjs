// Tests the ACTUAL runChecksAndDeliver exported from index.js -- not a re-implementation.
let playtestServerWasCalled = false;

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("json.edhrec.com")) return { ok: false, status: 404, statusText: "Not Found" };
  if (u.includes("api.scryfall.com/cards/collection")) {
    return {
      ok: true,
      json: async () => ({
        data: [
          { name: "Sol Ring", cmc: 1, type_line: "Artifact", color_identity: [], legalities: { commander: "legal" } },
          { name: "Atraxa, Grand Unifier", cmc: 7, type_line: "Legendary Creature", color_identity: ["W","U","B","G"], legalities: { commander: "legal" } },
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

// Mock the MCP SDK modules so importing index.js (which imports them) doesn't fail in this
// sandbox -- we only need runChecksAndDeliver, not an actual running server.
process.argv[1] = "/nonexistent"; // ensures the import.meta.url guard skips server.connect()

const { runChecksAndDeliver } = await import("../index.js");

const brokenDecklistText = "Commander\n1 Atraxa, Grand Unifier\n\nDeck\n1 Sol Ring";
const result = await runChecksAndDeliver({
  deck_name: "Test Broken Deck", decklist_text: brokenDecklistText,
  wincon_summary: "n/a", general_strategy: "n/a",
});

console.log("blocked:", result.blocked);
console.log("reason:", result.reason);
console.log("playtest server was called:", playtestServerWasCalled);
console.log(result.blocked === true && !playtestServerWasCalled
  ? "\nPASS: actual index.js runChecksAndDeliver correctly blocks + never touches playtest server."
  : "\nFAIL.");
