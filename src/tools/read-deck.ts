/**
 * tools/read-deck.ts -- read_deck
 *
 * New (2026-09-18), split out alongside optimize_deck/publish_deck: the read-only counterpart --
 * list the calling account's decks, or load one specific deck's full detail (real card
 * names/mana costs/images resolved, plus a ready-to-paste decklist_text) as the starting point for
 * an edit. Previously this was folded into manage_deck (pass deck_id alone, no decklist_text) --
 * now a standalone tool so "show me my decks" / "let's edit X" doesn't require pretending to also
 * want to run the full analyze-or-publish pipeline. Wraps functions/query/decks.ts's
 * queryDeckList/queryDeckDetail -- no query logic of its own.
 */

import { z } from "zod";
import { getDeckDoc, queryDeckList, queryDeckDetail } from "../functions/query/decks.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  deck_id: z.string().optional().describe("Load this specific deck's full detail (real card names, decklist_text ready to paste into optimize_deck, mana curve, price, etc). Omit both deck_id and slug to list every deck on the calling account instead (summary fields only)."),
  slug: z.string().optional().describe("Same as deck_id, but by the manaramp.com/decks/<slug> the user gave you instead of a deck_id."),
};

const readDeckTool: ToolDefinition<typeof inputSchema> = {
  name: "read_deck",
  description:
    "Read the calling account's decks. Pass deck_id or slug to load ONE deck's full detail -- " +
    "real card names/mana costs/images, a ready-to-paste decklist_text (feed this straight into " +
    "optimize_deck to start editing), mana curve, price, bracket, and consistency_issues as of its " +
    "last publish_deck call. Omit both to list every deck on the account instead (name/slug/format/" +
    "price/bracket/consistency_issues summary only, no per-card detail -- call again with a specific " +
    "deck_id once you know which one). Read-only -- never persists anything; use optimize_deck then " +
    "publish_deck (with this deck's deck_id) to actually change it.",
  inputSchema,
  handler: async ({ deck_id, slug }, ctx) => {
    if (!deck_id && !slug) {
      const decks = await queryDeckList(ctx.writeDb, ctx.ownerUserId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ decks }, null, 2) }] };
    }

    const deck = await getDeckDoc(ctx.writeDb, { deck_id, slug });
    if (!deck) {
      return { content: [{ type: "text" as const, text: `No deck found with ${deck_id ? `deck_id '${deck_id}'` : `slug '${slug}'`}.` }] };
    }
    if (deck.owner_user_id !== ctx.ownerUserId) {
      return { content: [{ type: "text" as const, text: `That deck isn't owned by the calling account -- can't read it.` }] };
    }

    const detail = await queryDeckDetail(ctx.readDb, deck);
    return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] };
  },
};

export { readDeckTool };
