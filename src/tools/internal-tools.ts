/**
 * tools/internal-tools.ts -- push_draft_result / push_game_log
 *
 * NOT primary/conversational tools -- these exist purely so the two local-stdio Arena tools
 * (arena_draft_assistance / arena_draft_game_advice), which have no direct Mongo connection of
 * their own (see tools/types.ts's McpContext header), can reach manaramp's database over HTTP via
 * tools/shared/remote-client.ts's callRemoteTool(name, args). Unlike query_cards (promoted to a
 * real conversational tool 2026-09-18, see tools/search-cards.ts), these two stay internal-only on
 * purpose -- there's no legitimate conversational reason for a calling model to push a draft/game
 * log directly; that's exclusively a side effect of running the local Arena tools themselves.
 *
 * Each export below is a bare zod-schema + handler shim around the real logic, which lives in
 * functions/push/*.ts -- no persistence logic of its own. Still registered in the remote `tools`
 * array (so manaramp's own /mcp route exposes them, since that's the only transport the Arena
 * tools' HTTP calls can reach), but never in localTools and never proxied -- see tools/index.ts.
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
  description: "Internal use only -- upserts a draft's picks/pack history for the local arena_draft_assistance tool. Not for conversational use.",
  inputSchema: pushDraftResultInputSchema,
  handler: async ({ draft_id, event_name, draft_format, picks, packs_seen }, ctx) => {
    const result = await pushDraftResult(ctx.writeDb, ctx.ownerUserId, {
      draft_id, event_name, draft_format, picks,
      packs_seen: packs_seen.map((p) => ({ pack_number: p.pack_number, pick_number: p.pick_number, grp_ids: p.grp_ids })),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
  description: "Internal use only -- pushes a finished match/draft timeline for the local arena_game_advice tool. Not for conversational use.",
  inputSchema: pushGameLogInputSchema,
  handler: async ({ deck_id, format, events, result }, ctx) => {
    const pushed = await pushGameLog(ctx.writeDb, ctx.ownerUserId, { deck_id, format, events, result });
    return { content: [{ type: "text" as const, text: JSON.stringify(pushed, null, 2) }] };
  },
};

export { pushDraftResultTool, pushGameLogTool };
