/**
 * tools/query-synergies.ts -- query_synergies
 *
 * New standalone conversational tool (2026-09-18) -- the `commander_synergies` collection
 * (EDHREC-derived recommended-card data) existed with NO tool exposing it at all before this.
 * Thin wrapper -- functions/query/synergies.ts's querySynergies has the real logic.
 */

import { z } from "zod";
import { querySynergies } from "../functions/query/synergies.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  commander_name: z.string().describe("The exact commander's name, e.g. 'Atraxa, Grand Unifier'. This is commander-keyed only -- there's no per-arbitrary-card synergy lookup, that data doesn't exist in manaramp's schema."),
};

const querySynergiesTool: ToolDefinition<typeof inputSchema> = {
  name: "query_synergies",
  description:
    "Look up EDHREC-derived recommended cards for a specific commander (synergy % and inclusion % " +
    "per recommended card) -- use this while researching or assembling a decklist around a " +
    "commander, before or instead of running the full validate_and_submit analysis. Throws a clear error " +
    "if the commander hasn't been ingested yet or its recommendations haven't synced -- that's a " +
    "real 'not available yet' case, not a sign the commander name is wrong.",
  inputSchema,
  handler: async ({ commander_name }, ctx) => {
    try {
      const result = await querySynergies(ctx.readDb, commander_name);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }] };
    }
  },
};

export { querySynergiesTool };
