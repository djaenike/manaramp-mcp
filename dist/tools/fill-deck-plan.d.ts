import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/fill-deck-plan.ts -- fill_deck_plan (2026-09-27)
 *
 * The one "find the cards" call in the new deck flow: deck_plan_guide -> the model writes ONE plan
 * -> fill_deck_plan fills every slot -> the model reviews and calls validate_and_submit once with
 * { draft_id, swaps }. The model decides WHAT the deck needs (slots, counts, filters); the server does
 * retrieval: every slot's candidates in parallel with the deck's colors/legality/exclusions/budget cap
 * applied, dedupe top-down (earlier slots claim cards first), then full card detail for the picks
 * only. The filled list is stored as a draft so it's never retyped.
 *
 * Shortfalls are reported, never padded -- if only 9 cards match a 14-card slot, the model sees that
 * and fixes it from the alternates at submit.
 */

declare const inputSchema: {
    prompt_id: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodString>;
    commander: z.ZodOptional<z.ZodString>;
    deck_name: z.ZodOptional<z.ZodString>;
    constraints: z.ZodOptional<z.ZodObject<{
        colors: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        max_price_usd: z.ZodOptional<z.ZodNumber>;
        bracket: z.ZodOptional<z.ZodNumber>;
        restrictions: z.ZodOptional<z.ZodString>;
        build_style: z.ZodOptional<z.ZodEnum<["original", "community"]>>;
        use_synergies: z.ZodOptional<z.ZodBoolean>;
        use_combos: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        colors?: string[] | undefined;
        max_price_usd?: number | undefined;
        bracket?: number | undefined;
        restrictions?: string | undefined;
        build_style?: "original" | "community" | undefined;
        use_synergies?: boolean | undefined;
        use_combos?: boolean | undefined;
    }, {
        colors?: string[] | undefined;
        max_price_usd?: number | undefined;
        bracket?: number | undefined;
        restrictions?: string | undefined;
        build_style?: "original" | "community" | undefined;
        use_synergies?: boolean | undefined;
        use_combos?: boolean | undefined;
    }>>;
    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
        name_contains: z.ZodOptional<z.ZodString>;
        oracle_text_contains: z.ZodOptional<z.ZodString>;
        category: z.ZodOptional<z.ZodString>;
        colors_include: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        cmc_min: z.ZodOptional<z.ZodNumber>;
        cmc_max: z.ZodOptional<z.ZodNumber>;
        max_price_usd: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
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
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
    }, {
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
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
    }>, "many">>;
    slots: z.ZodArray<z.ZodObject<{
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
        name_contains: z.ZodOptional<z.ZodString>;
        oracle_text_contains: z.ZodOptional<z.ZodString>;
        category: z.ZodOptional<z.ZodString>;
        colors_include: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        cmc_min: z.ZodOptional<z.ZodNumber>;
        cmc_max: z.ZodOptional<z.ZodNumber>;
        max_price_usd: z.ZodOptional<z.ZodNumber>;
        label: z.ZodString;
        count: z.ZodNumber;
        copies: z.ZodOptional<z.ZodNumber>;
        sort: z.ZodOptional<z.ZodEnum<["varied", "cmc", "price", "synergy"]>>;
    }, "strip", z.ZodTypeAny, {
        label: string;
        count: number;
        sort?: "cmc" | "varied" | "price" | "synergy" | undefined;
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
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
        copies?: number | undefined;
    }, {
        label: string;
        count: number;
        sort?: "cmc" | "varied" | "price" | "synergy" | undefined;
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
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
        copies?: number | undefined;
    }>, "many">;
    basic_lands: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    alternates_per_slot: z.ZodOptional<z.ZodNumber>;
};
declare const fillDeckPlanTool: ToolDefinition<typeof inputSchema>;

export { fillDeckPlanTool };
