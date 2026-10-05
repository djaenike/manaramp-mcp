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
    searches: z.ZodOptional<z.ZodArray<z.ZodObject<{
        names: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        oracle_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        arena_grp_ids: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        name_contains: z.ZodOptional<z.ZodString>;
        trigger_event: z.ZodOptional<z.ZodString>;
        trigger_watches: z.ZodOptional<z.ZodObject<{
            type: z.ZodOptional<z.ZodString>;
            modifier: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type?: string | undefined;
            modifier?: string | undefined;
        }, {
            type?: string | undefined;
            modifier?: string | undefined;
        }>>;
        cost_contains: z.ZodOptional<z.ZodObject<{
            kind: z.ZodString;
            arg: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            kind: string;
            arg?: string | undefined;
        }, {
            kind: string;
            arg?: string | undefined;
        }>>;
        roles_any: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        type_line_contains: z.ZodOptional<z.ZodString>;
        color_identity_subset_of: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        colors_include: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        category: z.ZodOptional<z.ZodString>;
        cmc_min: z.ZodOptional<z.ZodNumber>;
        cmc_max: z.ZodOptional<z.ZodNumber>;
        oracle_text_contains: z.ZodOptional<z.ZodString>;
        legal_in: z.ZodOptional<z.ZodString>;
        max_price_usd: z.ZodOptional<z.ZodNumber>;
        effect_in: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        trigger_kind: z.ZodOptional<z.ZodEnum<["cast", "activate", "triggered", "static", "replacement"]>>;
        effect_param_contains: z.ZodOptional<z.ZodObject<{
            key: z.ZodString;
            value_contains: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            key: string;
            value_contains: string;
        }, {
            key: string;
            value_contains: string;
        }>>;
        effects_all: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        limit: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        max_price_usd?: number | undefined;
        label?: string | undefined;
        roles_any?: string[] | undefined;
        effect_in?: string[] | undefined;
        effects_all?: string[] | undefined;
        trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement" | undefined;
        trigger_event?: string | undefined;
        trigger_watches?: {
            type?: string | undefined;
            modifier?: string | undefined;
        } | undefined;
        effect_param_contains?: {
            key: string;
            value_contains: string;
        } | undefined;
        cost_contains?: {
            kind: string;
            arg?: string | undefined;
        } | undefined;
        type_line_contains?: string | undefined;
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        category?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
        cmc_max?: number | undefined;
        names?: string[] | undefined;
        oracle_ids?: string[] | undefined;
        arena_grp_ids?: number[] | undefined;
        color_identity_subset_of?: string[] | undefined;
        legal_in?: string | undefined;
        limit?: number | undefined;
    }, {
        max_price_usd?: number | undefined;
        label?: string | undefined;
        roles_any?: string[] | undefined;
        effect_in?: string[] | undefined;
        effects_all?: string[] | undefined;
        trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement" | undefined;
        trigger_event?: string | undefined;
        trigger_watches?: {
            type?: string | undefined;
            modifier?: string | undefined;
        } | undefined;
        effect_param_contains?: {
            key: string;
            value_contains: string;
        } | undefined;
        cost_contains?: {
            kind: string;
            arg?: string | undefined;
        } | undefined;
        type_line_contains?: string | undefined;
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        category?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
        cmc_max?: number | undefined;
        names?: string[] | undefined;
        oracle_ids?: string[] | undefined;
        arena_grp_ids?: number[] | undefined;
        color_identity_subset_of?: string[] | undefined;
        legal_in?: string | undefined;
        limit?: number | undefined;
    }>, "many">>;
    detail: z.ZodOptional<z.ZodEnum<["brief", "summary", "full"]>>;
    include_draft_stats: z.ZodOptional<z.ZodBoolean>;
    names: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    oracle_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    arena_grp_ids: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    name_contains: z.ZodOptional<z.ZodString>;
    trigger_event: z.ZodOptional<z.ZodString>;
    trigger_watches: z.ZodOptional<z.ZodObject<{
        type: z.ZodOptional<z.ZodString>;
        modifier: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type?: string | undefined;
        modifier?: string | undefined;
    }, {
        type?: string | undefined;
        modifier?: string | undefined;
    }>>;
    cost_contains: z.ZodOptional<z.ZodObject<{
        kind: z.ZodString;
        arg: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: string;
        arg?: string | undefined;
    }, {
        kind: string;
        arg?: string | undefined;
    }>>;
    roles_any: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    type_line_contains: z.ZodOptional<z.ZodString>;
    color_identity_subset_of: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    colors_include: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    category: z.ZodOptional<z.ZodString>;
    cmc_min: z.ZodOptional<z.ZodNumber>;
    cmc_max: z.ZodOptional<z.ZodNumber>;
    oracle_text_contains: z.ZodOptional<z.ZodString>;
    legal_in: z.ZodOptional<z.ZodString>;
    max_price_usd: z.ZodOptional<z.ZodNumber>;
    effect_in: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    trigger_kind: z.ZodOptional<z.ZodEnum<["cast", "activate", "triggered", "static", "replacement"]>>;
    effect_param_contains: z.ZodOptional<z.ZodObject<{
        key: z.ZodString;
        value_contains: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        key: string;
        value_contains: string;
    }, {
        key: string;
        value_contains: string;
    }>>;
    effects_all: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    limit: z.ZodOptional<z.ZodNumber>;
};
declare const queryCardsTool: ToolDefinition<typeof inputSchema>;

export { queryCardsTool };
