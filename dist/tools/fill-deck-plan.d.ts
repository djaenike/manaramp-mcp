import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/fill-deck-plan.ts -- fill_deck_plan (2026-09-27, standard core + direct save 2026-09-28)
 *
 * The one "build the deck" call: deck_plan_guide -> the model writes the THEME slots only ->
 * fill_deck_plan builds the whole deck and saves it. Two round trips, and the model's output is a
 * few theme slots instead of a full 100-card plan.
 *
 *   1. Theme slots (the model's): filled top-down, earlier slots claim cards first.
 *   2. Standard core (server): counts what the theme picks already do, then fills each role to its
 *      target -- ramp, draw, removal, wipes, counters, protection, recursion... -- from the deck
 *      prompt's role_targets (the user's Create with AI sliders) or the defaults
 *      (functions/reference/deck-targets.ts).
 *   3. Type gaps: remaining nonland slots go to card types still under target (creatures, instants...),
 *      then to more theme cards.
 *   4. Lands: utility lands, then basics split by the deck's colors, to exactly the deck size.
 *   5. Saved directly (tools/shared/save-deck.ts, same path as validate_and_submit) and a compact
 *      summary returned -- no card text. Only when the list fails validation (or review: true) is it
 *      kept as a draft for validate_and_submit.
 *
 * Every slot gets the deck's colors, format legality, exclusions and budget cap automatically.
 */

declare const inputSchema: {
    prompt_id: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodString>;
    commander: z.ZodOptional<z.ZodString>;
    deck_id: z.ZodOptional<z.ZodString>;
    deck_name: z.ZodOptional<z.ZodString>;
    wincon_summary: z.ZodOptional<z.ZodString>;
    general_strategy: z.ZodOptional<z.ZodString>;
    bracket_estimate: z.ZodOptional<z.ZodString>;
    is_public: z.ZodOptional<z.ZodBoolean>;
    constraints: z.ZodOptional<z.ZodObject<{
        colors: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        max_price_usd: z.ZodOptional<z.ZodNumber>;
        bracket: z.ZodOptional<z.ZodNumber>;
        theme: z.ZodOptional<z.ZodString>;
        restrictions: z.ZodOptional<z.ZodString>;
        build_style: z.ZodOptional<z.ZodEnum<["original", "community"]>>;
        use_synergies: z.ZodOptional<z.ZodBoolean>;
        use_combos: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        theme?: string | undefined;
        colors?: string[] | undefined;
        max_price_usd?: number | undefined;
        bracket?: number | undefined;
        restrictions?: string | undefined;
        build_style?: "original" | "community" | undefined;
        use_synergies?: boolean | undefined;
        use_combos?: boolean | undefined;
    }, {
        theme?: string | undefined;
        colors?: string[] | undefined;
        max_price_usd?: number | undefined;
        bracket?: number | undefined;
        restrictions?: string | undefined;
        build_style?: "original" | "community" | undefined;
        use_synergies?: boolean | undefined;
        use_combos?: boolean | undefined;
    }>>;
    exclude: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">>;
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
        effect_in?: string[] | undefined;
        roles_any?: string[] | undefined;
        trigger_event?: string | undefined;
        cost_contains?: {
            kind: string;
            arg?: string | undefined;
        } | undefined;
        effects_all?: string[] | undefined;
        effect_param_contains?: {
            key: string;
            value_contains: string;
        } | undefined;
        trigger_watches?: {
            type?: string | undefined;
            modifier?: string | undefined;
        } | undefined;
        cmc_max?: number | undefined;
        copies?: number | undefined;
        trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement" | undefined;
        type_line_contains?: string | undefined;
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
    }, {
        label: string;
        count: number;
        sort?: "cmc" | "varied" | "price" | "synergy" | undefined;
        category?: string | undefined;
        max_price_usd?: number | undefined;
        effect_in?: string[] | undefined;
        roles_any?: string[] | undefined;
        trigger_event?: string | undefined;
        cost_contains?: {
            kind: string;
            arg?: string | undefined;
        } | undefined;
        effects_all?: string[] | undefined;
        effect_param_contains?: {
            key: string;
            value_contains: string;
        } | undefined;
        trigger_watches?: {
            type?: string | undefined;
            modifier?: string | undefined;
        } | undefined;
        cmc_max?: number | undefined;
        copies?: number | undefined;
        trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement" | undefined;
        type_line_contains?: string | undefined;
        name_contains?: string | undefined;
        oracle_text_contains?: string | undefined;
        colors_include?: string[] | undefined;
        cmc_min?: number | undefined;
    }>, "many">;
    auto_core: z.ZodOptional<z.ZodBoolean>;
    basic_lands: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    review: z.ZodOptional<z.ZodBoolean>;
};
declare const fillDeckPlanTool: ToolDefinition<typeof inputSchema>;

export { fillDeckPlanTool };
