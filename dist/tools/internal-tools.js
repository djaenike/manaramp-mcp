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
  description: "Internal use only -- upserts a draft's picks/pack history for the local arena_draft_assistance tool. Not for conversational use.",
  inputSchema: pushDraftResultInputSchema,
  handler: async ({ draft_id, event_name, draft_format, picks, packs_seen }, ctx) => {
    const result = await pushDraftResult(ctx.writeDb, ctx.ownerUserId, {
      draft_id,
      event_name,
      draft_format,
      picks,
      packs_seen: packs_seen.map((p) => ({ pack_number: p.pack_number, pick_number: p.pick_number, grp_ids: p.grp_ids }))
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
  description: "Internal use only -- pushes a finished match/draft timeline for the local arena_game_advice tool. Not for conversational use.",
  inputSchema: pushGameLogInputSchema,
  handler: async ({ deck_id, format, events, result }, ctx) => {
    const pushed = await pushGameLog(ctx.writeDb, ctx.ownerUserId, { deck_id, format, events, result });
    return { content: [{ type: "text", text: JSON.stringify(pushed, null, 2) }] };
  }
};
export {
  pushDraftResultTool,
  pushGameLogTool
};
