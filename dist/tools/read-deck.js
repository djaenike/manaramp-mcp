import { z } from "zod";
import { getDeckDoc, queryDeckList, queryDeckDetail } from "../functions/query/decks.js";
const inputSchema = {
  deck_id: z.string().optional().describe("Load this specific deck's full detail (real card names, decklist_text ready to paste into validate_and_submit, mana curve, price, etc). Omit both deck_id and slug to list every deck on the calling account instead (summary fields only)."),
  slug: z.string().optional().describe("Same as deck_id, but by the manaramp.com/decks/<slug> the user gave you instead of a deck_id.")
};
const readDeckTool = {
  name: "read_deck",
  description: "Read this account's decks: deck_id or slug for one deck's full detail (cards, decklist_text, curve, price, bracket, issues), or no args for the list. Changing a deck? edit_deck does it in one call.",
  inputSchema,
  handler: async ({ deck_id, slug }, ctx) => {
    if (!deck_id && !slug) {
      const decks = await queryDeckList(ctx.writeDb, ctx.ownerUserId);
      return { content: [{ type: "text", text: JSON.stringify({ decks }) }] };
    }
    const deck = await getDeckDoc(ctx.writeDb, { deck_id, slug });
    if (!deck) {
      return { content: [{ type: "text", text: `No deck found with ${deck_id ? `deck_id '${deck_id}'` : `slug '${slug}'`}.` }] };
    }
    if (deck.owner_user_id !== ctx.ownerUserId) {
      return { content: [{ type: "text", text: `That deck isn't owned by the calling account -- can't read it.` }] };
    }
    const detail = await queryDeckDetail(ctx.readDb, deck);
    const lean = (cards) => cards.map(({ image_url, oracle_id, ...rest }) => rest);
    const body = { ...detail, commander: lean(detail.commander), main_deck: lean(detail.main_deck) };
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  }
};
export {
  readDeckTool
};
