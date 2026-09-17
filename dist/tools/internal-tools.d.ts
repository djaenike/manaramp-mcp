import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/internal-tools.ts -- query_cards / push_draft_result / push_game_log
 *
 * NOT primary/conversational tools -- these exist purely so the two local-stdio Arena tools
 * (arena_draft_assistance / arena_game_advice), which have no direct Mongo connection of their own
 * (see tools/types.ts's McpContext header), can reach manaramp's database over HTTP via
 * tools/shared/remote-client.ts's callRemoteTool(name, args) -- see that file's header and
 * tools/shared/arena-local-state.ts's resolveGrpIdsViaManaramp. manage_deck is the only real
 * conversational entry point to card/deck data now; there is no ad-hoc "look up a card" or "log a
 * match" tool for an LLM client to call on its own.
 *
 * Each export below is a bare zod-schema + handler shim around the real logic, which lives in
 * functions/query/cards.ts and functions/push/*.ts -- no query/persistence logic of its own. Still
 * registered in the remote `tools` array (so manaramp's own /mcp route exposes them, since that's
 * the only transport the Arena tools' HTTP calls can reach), but never in localTools and never
 * proxied -- see tools/index.ts.
 */

declare const queryCardsInputSchema: {
    names: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    oracle_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    arena_grp_ids: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    name_contains: z.ZodOptional<z.ZodString>;
    color_identity_subset_of: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    colors_include: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    category: z.ZodOptional<z.ZodString>;
    cmc_min: z.ZodOptional<z.ZodNumber>;
    cmc_max: z.ZodOptional<z.ZodNumber>;
    oracle_text_contains: z.ZodOptional<z.ZodString>;
    legal_in: z.ZodOptional<z.ZodString>;
    max_price_usd: z.ZodOptional<z.ZodNumber>;
    is_mana_rock: z.ZodOptional<z.ZodBoolean>;
    is_card_draw: z.ZodOptional<z.ZodBoolean>;
    is_removal: z.ZodOptional<z.ZodBoolean>;
    is_mass_removal: z.ZodOptional<z.ZodBoolean>;
    is_token_generator: z.ZodOptional<z.ZodBoolean>;
    token_type_contains: z.ZodOptional<z.ZodString>;
    is_land_ramp: z.ZodOptional<z.ZodBoolean>;
    is_extra_land_drop: z.ZodOptional<z.ZodBoolean>;
    is_tutor: z.ZodOptional<z.ZodBoolean>;
    is_counterspell: z.ZodOptional<z.ZodBoolean>;
    is_recursion: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
};
declare const queryCardsTool: ToolDefinition<typeof queryCardsInputSchema>;
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

export { pushDraftResultTool, pushGameLogTool, queryCardsTool };
