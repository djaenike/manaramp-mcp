import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/edit-deck.ts -- edit_deck (2026-09-27)
 *
 * One-call iteration on a saved deck: remove/add cards by name, and/or `add_search` for the server to
 * pick replacements matching filters (within the deck's colors, legality and stored constraints). The
 * result is re-validated with the same analysis validate_and_submit uses, saved in place, logged as a
 * revision (last 20 kept on the deck), and only the CHANGE comes back -- no decklist retyping, no
 * read-then-rewrite loop. Constraint changes ("keep it under $100") update the deck's stored rules.
 *
 * `commander` swaps the commander in place: the old one leaves, cards outside the new color identity
 * are pulled (and listed), and add_search in the same call refills within the NEW colors. A full
 * rebuild around a new commander goes through deck_plan_guide -> fill_deck_plan instead.
 */

declare const inputSchema: {
    deck_id: z.ZodString;
    commander: z.ZodOptional<z.ZodString>;
    remove: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    add: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    add_search: z.ZodOptional<z.ZodArray<z.ZodObject<{
        roles_any: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        effect_in: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        effects_all: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        trigger_kind: z.ZodOptional<z.ZodEnum<["cast", "activate", "triggered", "static", "replacement"]>>;
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
        type_line_contains: z.ZodOptional<z.ZodString>;
        oracle_text_contains: z.ZodOptional<z.ZodString>;
        category: z.ZodOptional<z.ZodString>;
        cmc_min: z.ZodOptional<z.ZodNumber>;
        cmc_max: z.ZodOptional<z.ZodNumber>;
        max_price_usd: z.ZodOptional<z.ZodNumber>;
        count: z.ZodNumber;
        sort: z.ZodOptional<z.ZodEnum<["varied", "cmc", "price"]>>;
    }, "strip", z.ZodTypeAny, {
        count: number;
        sort?: "cmc" | "varied" | "price" | undefined;
        category?: string | undefined;
        max_price_usd?: number | undefined;
        trigger_event?: string | undefined;
        cost_contains?: {
            kind: string;
            arg?: string | undefined;
        } | undefined;
        cmc_max?: number | undefined;
        roles_any?: string[] | undefined;
        effect_in?: string[] | undefined;
        effects_all?: string[] | undefined;
        effect_param_contains?: {
            key: string;
            value_contains: string;
        } | undefined;
        trigger_watches?: {
            type?: string | undefined;
            modifier?: string | undefined;
        } | undefined;
        trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement" | undefined;
        type_line_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        cmc_min?: number | undefined;
    }, {
        count: number;
        sort?: "cmc" | "varied" | "price" | undefined;
        category?: string | undefined;
        max_price_usd?: number | undefined;
        trigger_event?: string | undefined;
        cost_contains?: {
            kind: string;
            arg?: string | undefined;
        } | undefined;
        cmc_max?: number | undefined;
        roles_any?: string[] | undefined;
        effect_in?: string[] | undefined;
        effects_all?: string[] | undefined;
        effect_param_contains?: {
            key: string;
            value_contains: string;
        } | undefined;
        trigger_watches?: {
            type?: string | undefined;
            modifier?: string | undefined;
        } | undefined;
        trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement" | undefined;
        type_line_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        cmc_min?: number | undefined;
    }>, "many">>;
    constraints: z.ZodOptional<z.ZodObject<{
        max_price_usd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        bracket: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        restrictions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        max_price_usd?: number | null | undefined;
        bracket?: number | null | undefined;
        restrictions?: string | null | undefined;
    }, {
        max_price_usd?: number | null | undefined;
        bracket?: number | null | undefined;
        restrictions?: string | null | undefined;
    }>>;
    request: z.ZodOptional<z.ZodString>;
    deck_name: z.ZodOptional<z.ZodString>;
    wincon_summary: z.ZodOptional<z.ZodString>;
    general_strategy: z.ZodOptional<z.ZodString>;
    bracket_estimate: z.ZodOptional<z.ZodString>;
};
declare const editDeckTool: ToolDefinition<typeof inputSchema>;

export { editDeckTool };
