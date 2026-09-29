import { z } from 'zod';

/**
 * tools/shared/filter-shape.ts -- the card-filter fields fill_deck_plan and edit_deck slots take
 * (2026-09-28). One copy with deliberately short descriptions: tool definitions are re-sent on every
 * model turn, and deck_plan_guide carries the full vocabulary.
 */

declare const filterShape: {
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
};

export { filterShape };
