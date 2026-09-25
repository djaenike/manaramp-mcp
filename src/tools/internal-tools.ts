/**
 * tools/internal-tools.ts -- push_draft_result / push_game_log
 *
 * Originally exist so the two local-stdio Arena tools (arena_draft_assistance /
 * arena_draft_game_advice), which have no direct Mongo connection of their own (see
 * tools/types.ts's McpContext header), can reach manaramp's database over HTTP via
 * tools/shared/remote-client.ts's callRemoteTool(name, args) as a side effect of a live draft/game.
 *
 * UN-internal'd 2026-09-19 (same fix query_cards got 2026-09-18, see tools/search-cards.ts's own
 * header): these used to be marked "Internal use only -- Not for conversational use," on the theory
 * that a calling model would never have a legitimate reason to call them directly. Confirmed live
 * that framing actively backfires exactly the same way it did for query_cards -- a real user
 * couldn't get a PRIOR draft's result pushed at all (the picks/packs_seen data was still sitting in
 * that conversation's own context, resolvable via query_cards, but the model wouldn't call a tool
 * described as internal-only even when it was exactly the right one). Both take plain data
 * (draft_id/picks/packs_seen, or deck_id/events) as arguments, not a live log-reading session --
 * there's nothing about either that actually REQUIRES the local Arena tools to be the caller.
 *
 * Each export below is a bare zod-schema + handler shim around the real logic, which lives in
 * functions/push/*.ts -- no persistence logic of its own. Registered in the remote `tools` array
 * (manaramp's own /mcp route) AND in localTools now (via toRemoteProxy, same as every other
 * Mongo-backed tool -- see tools/index.ts), so a calling model can push a draft/game result
 * directly, not just have it happen invisibly as an Arena-tool side effect.
 */

import { z } from "zod";
import { pushDraftResult } from "../functions/push/draft-result.js";
import { pushGameLog } from "../functions/push/game-log.js";
import type { ToolDefinition } from "./types.js";

// --- push_draft_result -------------------------------------------------------------------------
const pushDraftResultInputSchema = {
  draft_id: z.string().describe("Arena's own draftId for this draft (stable across every call within the same draft)."),
  event_name: z.string().optional().describe("Arena's own event name, e.g. 'QuickDraft_HOB_...'."),
  draft_format: z.string().optional().describe("'premier' | 'quick', if known."),
  picks: z.array(z.number()).describe("Every card picked so far, in order -- grpIds."),
  packs_seen: z.array(z.object({
    pack_number: z.number(),
    pick_number: z.number(),
    grp_ids: z.array(z.number()),
  })).describe("Every pack shown so far, in order -- the full options history."),
};

const pushDraftResultTool: ToolDefinition<typeof pushDraftResultInputSchema> = {
  name: "push_draft_result",
  description:
    "Saves a draft's picks/pack history to the user's manaramp account -- upserts by draft_id, so " +
    "calling it again for the same draft just refreshes it, never duplicates. arena_draft_assistance " +
    "already calls this automatically during a LIVE draft; use this directly when a user wants a " +
    "past draft recorded and it wasn't pushed live (e.g. Player.log has since been overwritten by a " +
    "later Arena session, or the extension wasn't connected at the time) -- reconstruct picks/" +
    "packs_seen from whatever's available (this conversation's history, grpIds resolved via " +
    "query_cards from card names the user gives you, etc.) and call this once you have them.",
  inputSchema: pushDraftResultInputSchema,
  handler: async ({ draft_id, event_name, draft_format, picks, packs_seen }, ctx) => {
    const result = await pushDraftResult(ctx.writeDb, ctx.ownerUserId, {
      draft_id, event_name, draft_format, picks,
      packs_seen: packs_seen.map((p) => ({ pack_number: p.pack_number, pick_number: p.pick_number, grp_ids: p.grp_ids })),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
};

// --- push_game_log -------------------------------------------------------------------------------
const pushGameLogInputSchema = {
  deck_id: z.string().optional().describe("The manaramp deck this match was played with, if any (a deck_id manage_deck returned)."),
  format: z.string().optional().describe("e.g. 'BO1', 'BO3', or a draft event name -- whatever context is available."),
  events: z.array(z.record(z.string(), z.unknown())).describe("Ordered timeline entries, verbatim from buildMatchTimeline's output."),
  result: z.string().optional().describe("Pulled from the timeline's matchResult event, when present."),
};

const pushGameLogTool: ToolDefinition<typeof pushGameLogInputSchema> = {
  name: "push_game_log",
  description:
    "Saves a finished match's event timeline to the user's manaramp account. " +
    "arena_draft_game_advice already calls this automatically during a LIVE game; use this directly " +
    "when a user wants a past match recorded and it wasn't pushed live -- events is whatever ordered " +
    "timeline you can reconstruct (matching buildMatchTimeline's own event shape) from what's " +
    "actually available, e.g. this conversation's history.",
  inputSchema: pushGameLogInputSchema,
  handler: async ({ deck_id, format, events, result }, ctx) => {
    const pushed = await pushGameLog(ctx.writeDb, ctx.ownerUserId, { deck_id, format, events, result });
    return { content: [{ type: "text" as const, text: JSON.stringify(pushed) }] };
  },
};

export { pushDraftResultTool, pushGameLogTool };
