import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

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
