import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/query-combos.ts -- query_combos
 *
 * New standalone conversational tool (2026-09-18) -- combo data used to only reach a calling model
 * as a side effect buried inside manage_deck's response, with no way to query it directly (e.g.
 * "do these 2 cards combo?", or checking synergy while assembling a decklist BEFORE running
 * optimize_deck). Thin wrapper -- functions/query/combos.ts's queryCombos has the real logic.
 */

declare const inputSchema: {
    card_names: z.ZodArray<z.ZodString, "many">;
    limit: z.ZodOptional<z.ZodNumber>;
};
declare const queryCombosTool: ToolDefinition<typeof inputSchema>;

export { queryCombosTool };
