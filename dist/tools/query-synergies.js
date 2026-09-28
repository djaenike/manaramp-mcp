import { z } from "zod";
import { querySynergies } from "../functions/query/synergies.js";
const inputSchema = {
  commander_name: z.string().describe("The exact commander's name, e.g. 'Atraxa, Grand Unifier'. This is commander-keyed only -- there's no per-arbitrary-card synergy lookup, that data doesn't exist in manaramp's schema.")
};
const querySynergiesTool = {
  name: "query_synergies",
  description: "Look up EDHREC-derived recommended cards for a specific commander (synergy % and inclusion % per recommended card). When building or editing a deck around a named commander, call this FIRST -- it's a real, curated shortlist, so query_cards searches can then fill specific gaps instead of sweeping broadly. Throws a clear error if the commander hasn't been ingested yet or its recommendations haven't synced -- that's a real 'not available yet' case, not a sign the commander name is wrong.",
  inputSchema,
  handler: async ({ commander_name }, ctx) => {
    try {
      const result = await querySynergies(ctx.readDb, commander_name);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
};
export {
  querySynergiesTool
};
