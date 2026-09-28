/**
 * functions/reference/deck-plan-guide-data.ts
 *
 * Static half of deck_plan_guide (2026-09-27) -- everything a model needs to write ONE precise
 * fill_deck_plan call: format rules, composition targets, what each role means and how to query it,
 * plain-English meanings for the common Forge effects/triggers/params, the returned-card schema, the
 * plan schema, and idea -> filter examples. The live half (effect names + card counts actually in the
 * database, and the user's stored deck_prompt) is merged in by tools/deck-plan-guide.ts.
 *
 * Kept compact on purpose: it's sent once per session, but every token here is read by the model.
 */
interface FormatRules {
    deck_size: string;
    copies: string;
    commander: string | null;
    sideboard: string;
    legality_key: string;
    validate_supported: boolean;
}
declare const FORMAT_RULES: Record<string, FormatRules>;
/** Community consensus, not official rules -- starting targets the plan's slot counts should hit. */
declare const COMPOSITION_TARGETS: {
    commander: {
        lands: string;
        ramp: string;
        card_draw: string;
        interaction: string;
        theme: string;
        curve: string;
    };
    sixty_card: {
        lands: string;
        copies: string;
        curve: string;
        interaction: string;
    };
};
/** Role -> what it means and the simplest precise filters for it. `roles_any` uses manaramp's
 *  precomputed role flags (same rules as the website's ability filters). */
declare const ROLES: {
    mana_rock: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    mana_dork: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    land_ramp: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    card_draw: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    removal: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    mass_removal: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    counterspell: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    tutor: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    recursion: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    token_generator: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    player_damage: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
    extra_land_drop: {
        meaning: string;
        filters: {
            roles_any: string[];
        };
    };
};
/** Plain meanings for the Forge effect names worth knowing by heart. The full list with card counts
 *  comes from the database (effect_vocabulary) -- anything not here is still a valid name. */
declare const EFFECT_MEANINGS: Record<string, string>;
/** How to read trigger kinds and the `on` field on returned cards. */
declare const TRIGGERS: {
    kinds: {
        cast: string;
        activate: string;
        triggered: string;
        static: string;
        replacement: string;
    };
    on_values: string;
    trigger_event_filter: string;
    forge_modes: string;
};
/** The step params that make filters precise, and what they hold. */
declare const PARAM_KEYS: {
    ValidTgts: string;
    Defined: string;
    Origin: string;
    Destination: string;
    NumDmg: string;
    NumCards: string;
    Amount: string;
    TokenScript: string;
    ValidCards: string;
    Affected: string;
};
/** What each field on a card returned by fill_deck_plan / edit_deck means. */
declare const CARD_SCHEMA: {
    name: string;
    slot: string;
    mana_cost: string;
    cmc: string;
    type_line: string;
    color_identity: string;
    pt: string;
    oracle_text: string;
    keywords: string;
    abilities: string;
    makes_tokens: string;
    roles: string;
    price_usd: string;
    reading_synergy: string;
};
/** fill_deck_plan's input, for the model to fill in. */
declare const PLAN_SCHEMA: {
    prompt_id: string;
    commander: string;
    format: string;
    constraints: string;
    exclude: string;
    slots: string;
    basic_lands: string;
    alternates_per_slot: string;
    rules: string;
};
declare const PLAN_EXAMPLE: {
    commander: string;
    exclude: ({
        cost_contains: {
            kind: string;
            arg: string;
        };
        trigger_event?: undefined;
        trigger_watches?: undefined;
    } | {
        trigger_event: string;
        trigger_watches: {
            type: string;
        };
        cost_contains?: undefined;
    })[];
    slots: ({
        label: string;
        count: number;
        trigger_event: string;
        trigger_watches: {
            type: string;
            modifier: string;
        };
        effect_in: string[];
        roles_any?: undefined;
        cmc_max?: undefined;
        category?: undefined;
        sort?: undefined;
    } | {
        label: string;
        count: number;
        roles_any: string[];
        cmc_max: number;
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        category?: undefined;
        sort?: undefined;
    } | {
        label: string;
        count: number;
        effect_in: string[];
        trigger_event?: undefined;
        trigger_watches?: undefined;
        roles_any?: undefined;
        cmc_max?: undefined;
        category?: undefined;
        sort?: undefined;
    } | {
        label: string;
        count: number;
        roles_any: string[];
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        cmc_max?: undefined;
        category?: undefined;
        sort?: undefined;
    } | {
        label: string;
        count: number;
        category: string;
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        roles_any?: undefined;
        cmc_max?: undefined;
        sort?: undefined;
    } | {
        label: string;
        count: number;
        category: string;
        cmc_max: number;
        sort: string;
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        roles_any?: undefined;
    })[];
    basic_lands: {
        Mountain: number;
    };
    note: string;
};
declare const IDEA_EXAMPLES: ({
    idea: string;
    filters: {
        trigger_event: string;
        trigger_watches: {
            type: string;
            modifier: string;
        };
        effect_in: string[];
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        trigger_event: string;
        trigger_watches: {
            type: string;
            modifier: string;
        };
        effect_in?: undefined;
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        trigger_event: string;
        trigger_watches: {
            type: string;
            modifier?: undefined;
        };
        effect_in?: undefined;
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        roles_any: string[];
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        trigger_event: string;
        trigger_watches: {
            type: string;
            modifier?: undefined;
        };
        effect_in: string[];
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        effect_in: string[];
        effect_param_contains: {
            key: string;
            value_contains: string;
        };
        oracle_text_contains: string;
        trigger_event?: undefined;
        trigger_watches?: undefined;
        roles_any?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        effects_all: string[];
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        category: string;
        type_line_contains: string;
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        cost_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    filters: {
        cost_contains: {
            kind: string;
            arg: string;
        };
        trigger_event?: undefined;
        trigger_watches?: undefined;
        effect_in?: undefined;
        roles_any?: undefined;
        effect_param_contains?: undefined;
        oracle_text_contains?: undefined;
        effects_all?: undefined;
        category?: undefined;
        type_line_contains?: undefined;
    };
    exclude?: undefined;
} | {
    idea: string;
    exclude: string;
    filters?: undefined;
})[];
/** Archetypes as filter sets (2026-09-27): `include` = slot filters to BUILD it, `exclude` = the
 *  deck-wide `exclude` list to AVOID it. So "no aristocrats" is the same, complete exclusion every
 *  time instead of whatever filters get improvised. Incidental overlap is fine -- e.g. avoiding
 *  aristocrats doesn't ban every card that gains or drains a little life; only the engine pieces. */
declare const ARCHETYPES: {
    aristocrats: {
        means: string;
        include: ({
            cost_contains: {
                kind: string;
                arg: string;
            };
            trigger_event?: undefined;
            trigger_watches?: undefined;
        } | {
            trigger_event: string;
            trigger_watches: {
                type: string;
            };
            cost_contains?: undefined;
        })[];
        exclude: ({
            cost_contains: {
                kind: string;
                arg: string;
            };
            trigger_event?: undefined;
            trigger_watches?: undefined;
        } | {
            trigger_event: string;
            trigger_watches: {
                type: string;
            };
            cost_contains?: undefined;
        } | {
            trigger_event: string;
            cost_contains?: undefined;
            trigger_watches?: undefined;
        })[];
    };
    lifegain: {
        means: string;
        include: ({
            trigger_event: string;
            effect_in?: undefined;
            trigger_kind?: undefined;
        } | {
            effect_in: string[];
            trigger_kind: string;
            trigger_event?: undefined;
        })[];
        exclude: {
            trigger_event: string;
        }[];
    };
    tokens_go_wide: {
        means: string;
        include: ({
            roles_any: string[];
            effect_in?: undefined;
            trigger_event?: undefined;
            trigger_watches?: undefined;
        } | {
            effect_in: string[];
            roles_any?: undefined;
            trigger_event?: undefined;
            trigger_watches?: undefined;
        } | {
            trigger_event: string;
            trigger_watches: {
                type: string;
                modifier: string;
            };
            roles_any?: undefined;
            effect_in?: undefined;
        })[];
        exclude: {
            roles_any: string[];
        }[];
    };
    counters: {
        means: string;
        include: ({
            effect_in: string[];
            trigger_event?: undefined;
        } | {
            trigger_event: string;
            effect_in?: undefined;
        })[];
        exclude: ({
            effect_in: string[];
            trigger_event?: undefined;
        } | {
            trigger_event: string;
            effect_in?: undefined;
        })[];
    };
    spellslinger: {
        means: string;
        include: ({
            trigger_event: string;
            category?: undefined;
            cmc_max?: undefined;
        } | {
            category: string;
            cmc_max: number;
            trigger_event?: undefined;
        })[];
        exclude: {
            trigger_event: string;
        }[];
    };
    voltron: {
        means: string;
        include: {
            type_line_contains: string;
        }[];
        exclude: {
            type_line_contains: string;
        }[];
    };
    reanimator: {
        means: string;
        include: ({
            effect_in: string[];
            effect_param_contains: {
                key: string;
                value_contains: string;
            };
        } | {
            effect_in: string[];
            effect_param_contains?: undefined;
        })[];
        exclude: {
            effect_in: string[];
            effect_param_contains: {
                key: string;
                value_contains: string;
            };
        }[];
    };
    landfall: {
        means: string;
        include: ({
            trigger_event: string;
            trigger_watches: {
                type: string;
                modifier: string;
            };
            roles_any?: undefined;
        } | {
            roles_any: string[];
            trigger_event?: undefined;
            trigger_watches?: undefined;
        })[];
        exclude: {
            trigger_event: string;
            trigger_watches: {
                type: string;
            };
        }[];
    };
    stax: {
        means: string;
        include: {
            effect_in: string[];
        }[];
        exclude: ({
            effect_in: string[];
            roles_any?: undefined;
            oracle_text_contains?: undefined;
        } | {
            roles_any: string[];
            oracle_text_contains: string;
            effect_in?: undefined;
        })[];
    };
};
/** Vague budget words -> a number to plan with. Always tell the user the number you assumed. */
declare const BUDGET_WORDS: {
    "cheap / budget / broke": string;
    "mid / reasonable": string;
    "upgraded / nice": string;
    "no limit / money no object": string;
    unspecified: string;
};
declare const INSTRUCTIONS: string[];

export { ARCHETYPES, BUDGET_WORDS, CARD_SCHEMA, COMPOSITION_TARGETS, EFFECT_MEANINGS, FORMAT_RULES, IDEA_EXAMPLES, INSTRUCTIONS, PARAM_KEYS, PLAN_EXAMPLE, PLAN_SCHEMA, ROLES, TRIGGERS };
