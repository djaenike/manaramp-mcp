import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

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

declare const pushDraftResultInputSchema: {
    draft_id: z.ZodString;
    event_name: z.ZodOptional<z.ZodString>;
    draft_format: z.ZodOptional<z.ZodString>;
    picks: z.ZodArray<z.ZodNumber, "many">;
    packs_seen: z.ZodArray<z.ZodObject<{
        pack_number: z.ZodNumber;
        pick_number: z.ZodNumber;
        grp_ids: z.ZodArray<z.ZodNumber, "many">;
    }, "strip", z.ZodTypeAny, {
        pack_number: number;
        pick_number: number;
        grp_ids: number[];
    }, {
        pack_number: number;
        pick_number: number;
        grp_ids: number[];
    }>, "many">;
};
declare const pushDraftResultTool: ToolDefinition<typeof pushDraftResultInputSchema>;
declare const pushGameLogInputSchema: {
    deck_id: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodString>;
    events: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">;
    result: z.ZodOptional<z.ZodString>;
};
declare const pushGameLogTool: ToolDefinition<typeof pushGameLogInputSchema>;

export { pushDraftResultTool, pushGameLogTool };
