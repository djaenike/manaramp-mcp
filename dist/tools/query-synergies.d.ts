import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/query-synergies.ts -- query_synergies
 *
 * New standalone conversational tool (2026-09-18) -- the `commander_synergies` collection
 * (EDHREC-derived recommended-card data) existed with NO tool exposing it at all before this.
 * Thin wrapper -- functions/query/synergies.ts's querySynergies has the real logic.
 */

declare const inputSchema: {
    commander_name: z.ZodString;
};
declare const querySynergiesTool: ToolDefinition<typeof inputSchema>;

export { querySynergiesTool };
