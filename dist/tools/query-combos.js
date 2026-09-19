import { z } from "zod";
import { queryCombos } from "../functions/query/combos.js";
const inputSchema = {
  card_names: z.array(z.string()).describe("Any list of card names -- 2-3 specific candidates ('do these combo together?') or a full ~100-card decklist ('which combos exist in this deck?'). Returns every documented combo whose pieces are ALL present in this list."),
  limit: z.number().optional().describe("Max combos to return (default: all found).")
};
const queryCombosTool = {
  name: "query_combos",
  description: "Look up documented infinite/powerful combos (Commander Spellbook data) among a set of card names -- use this while researching or assembling a decklist, before or instead of running the full optimize_deck analysis. Not gated on cards being in manaramp's own card database -- a combo can be found even if its pieces are unresolved locally (see unresolved_piece_names on each result: when non-empty, total_cmc is a floor, not a confirmed total, since that piece's real mana cost isn't known here yet).",
  inputSchema,
  handler: async ({ card_names, limit }, ctx) => {
    const combos = await queryCombos(ctx.readDb, card_names, limit);
    return { content: [{ type: "text", text: JSON.stringify({ combos }, null, 2) }] };
  }
};
export {
  queryCombosTool
};
