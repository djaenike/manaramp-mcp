import { z } from "zod";
import { pushDraftResult } from "../functions/push/draft-result.js";
import { pushGameLog } from "../functions/push/game-log.js";
const pushDraftResultInputSchema = {
  draft_id: z.string().describe("Arena's own draftId for this draft (stable across every call within the same draft)."),
  event_name: z.string().optional().describe("Arena's own event name, e.g. 'QuickDraft_HOB_...'."),
  draft_format: z.string().optional().describe("'premier' | 'quick', if known."),
  picks: z.array(z.number()).describe("Every card picked so far, in order -- grpIds."),
  packs_seen: z.array(z.object({
    pack_number: z.number(),
    pick_number: z.number(),
    grp_ids: z.array(z.number())
  })).describe("Every pack shown so far, in order -- the full options history.")
};
const pushDraftResultTool = {
  name: "push_draft_result",
  description: "Saves a draft's picks/pack history to the user's manaramp account -- upserts by draft_id, so calling it again for the same draft just refreshes it, never duplicates. arena_draft_assistance already calls this automatically during a LIVE draft; use this directly when a user wants a past draft recorded and it wasn't pushed live (e.g. Player.log has since been overwritten by a later Arena session, or the extension wasn't connected at the time) -- reconstruct picks/packs_seen from whatever's available (this conversation's history, grpIds resolved via query_cards from card names the user gives you, etc.) and call this once you have them.",
  inputSchema: pushDraftResultInputSchema,
  handler: async ({ draft_id, event_name, draft_format, picks, packs_seen }, ctx) => {
    const result = await pushDraftResult(ctx.writeDb, ctx.ownerUserId, {
      draft_id,
      event_name,
      draft_format,
      picks,
      packs_seen: packs_seen.map((p) => ({ pack_number: p.pack_number, pick_number: p.pick_number, grp_ids: p.grp_ids }))
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
};
const pushGameLogInputSchema = {
  deck_id: z.string().optional().describe("The manaramp deck this match was played with, if any (a deck_id manage_deck returned)."),
  format: z.string().optional().describe("e.g. 'BO1', 'BO3', or a draft event name -- whatever context is available."),
  events: z.array(z.record(z.string(), z.unknown())).describe("Ordered timeline entries, verbatim from buildMatchTimeline's output."),
  result: z.string().optional().describe("Pulled from the timeline's matchResult event, when present.")
};
const pushGameLogTool = {
  name: "push_game_log",
  description: "Saves a finished match's event timeline to the user's manaramp account. arena_draft_game_advice already calls this automatically during a LIVE game; use this directly when a user wants a past match recorded and it wasn't pushed live -- events is whatever ordered timeline you can reconstruct (matching buildMatchTimeline's own event shape) from what's actually available, e.g. this conversation's history.",
  inputSchema: pushGameLogInputSchema,
  handler: async ({ deck_id, format, events, result }, ctx) => {
    const pushed = await pushGameLog(ctx.writeDb, ctx.ownerUserId, { deck_id, format, events, result });
    return { content: [{ type: "text", text: JSON.stringify(pushed) }] };
  }
};
export {
  pushDraftResultTool,
  pushGameLogTool
};
