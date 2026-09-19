import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/search-cards.ts -- query_cards
 *
 * Promoted from tools/internal-tools.ts (2026-09-18) into a real, conversational, model-facing
 * tool -- it used to be marked "internal use only" purely so the local Arena tools' own remote
 * calls (which reuse this exact name via callRemoteTool, see tools/shared/remote-client.ts) had
 * something to call, with an explicit description discouraging a calling model from reaching for it
 * directly. That framing actively backfired: a real testing session found a model respecting the
 * "internal only" wording and avoiding it even when it was exactly the right tool for looking up
 * real cards before assembling a decklist -- pushing it toward guessing from general MTG knowledge
 * instead of manaramp's own database, the opposite of what's wanted.
 *
 * Tool NAME stays exactly "query_cards" (unchanged) -- the local Arena tools' own
 * resolveGrpIdsViaManaramp call reaches this by that literal string over HTTP, and renaming it here
 * would silently break that internal contract. Only the description/framing changed; the schema and
 * handler are untouched (still a thin wrapper -- functions/query/cards.ts's queryCards has the real
 * logic).
 */

declare const inputSchema: {
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
    is_player_damage: z.ZodOptional<z.ZodBoolean>;
    is_token_generator: z.ZodOptional<z.ZodBoolean>;
    token_type_contains: z.ZodOptional<z.ZodString>;
    is_land_ramp: z.ZodOptional<z.ZodBoolean>;
    is_extra_land_drop: z.ZodOptional<z.ZodBoolean>;
    is_tutor: z.ZodOptional<z.ZodBoolean>;
    is_counterspell: z.ZodOptional<z.ZodBoolean>;
    is_recursion: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
};
declare const queryCardsTool: ToolDefinition<typeof inputSchema>;

export { queryCardsTool };
